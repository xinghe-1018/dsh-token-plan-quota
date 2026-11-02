/**
 * README 链接目标的**抽取与分类**——单一实现。
 *
 * 为什么单独一个模块（而不是留在 `scripts/check-docs.mjs` 里）：`check-docs.mjs` 是顶层执行的
 * 脚本，`import` 它就等于跑整套检查，所以它内部的函数没法被 `test/guards.mjs` 直接测。
 * 而这两件事恰恰**必须有常驻行为矩阵**——尤其越界判定含**平台语义**（Windows 把 `\` 也当路径
 * 分隔符），只有进了测试才守得住、才可能进 CI 的三平台矩阵。抽出来之后消费者是三个：
 * `check-docs.mjs`（第 4 项 / 第 4b 项 / 第 10 项）与 `test/guards.mjs`。
 *
 * 历史：这两件事曾经在 check-docs.mjs 里各有一套正则（第 4 项一套、4b 一套），窄的那套对
 * **引用式**与 **HTML** 两种写法完全隐形，又把**代码围栏里的示例**误报成声明（002 的 Lens 1/2
 * 各自独立报过同一处）。所以这里只留一处实现。
 *
 * 2026-11-02 第五轮审查（ROADMAP §6 第 1~4 条）在这里收的四个口：
 *  1. HTML 属性值**限行、限长、且必须真的在开标签里**——散文里一个未配对的引号原先会让匹配
 *     一路吞到下一个引号，交回一个跨多行的“目标”；而散文里写一句 `href="../../x"` 也会凭空
 *     给越界检查造出一个待检查目标。
 *  2. `extractLinkTargets` 与 `mentionsTarget` 共用一次剥壳：后者原本已经剥过又调前者，于是
 *     `stripCode` 在同一份文本上跑两遍，正确性悄悄依赖它幂等。注释也改成替换成**空格**而不是
 *     空串——空串会把注释两侧的文字拼成一行，凭空造出 `![x](a.png)` 这种不存在的引用。
 *  3. 远端形态比**解码后**的 path、owner/repo **忽略大小写**、并要求剩余段**整段**对上
 *     `[blob|raw|tree]/<ref>/<wanted>`：未解码时中文/带空格的文件名永远不相等（假红），
 *     而 `endsWith('/' + wanted)` 连 `/main/backup/docs/x.png` 都算（假绿）。
 *  4. `stripTarget` 的结果变量叫 `undecorated`（原先叫 `decorated`，语义正好相反）。
 */
import { posix } from 'node:path'
import { stripCode } from './markdown-strip.mjs'

/** 行内链接目标的扫描上限：Markdown 的行内目标不跨行，实际长度远小于此。 */
const TARGET_SCAN_CAP = 512

/**
 * 扫描行内链接 / 图片目标：找 `](`，**有界地**读到下一个 `)`。
 *
 * 为什么不匹配完整的 `\[label\]\(target\)`：
 *  - 为了线性，label 的字符类必须收窄成 `[^\[\]]*`，那会让**链接文字含方括号**的目标
 *    （`[see note [1]](docs/a.md)`）完全消失——评审 Lens 1 实测这是相对旧实现的**收窄**，
 *    而旧实现只是“见 ]( 就取”。
 *  - 只找 `](` 则 label 怎么嵌套都认得，且每个起点只扫到下一个 `)`（上限 512 字符，
 *    兜住“整份文档都没有 )”的退化输入）——整体线性。003 的 Lens 2 实测原实现在
 *    `![` × 40000（80 KB）上要 **10.9 秒**。
 *
 * 要求紧邻左侧有一个 `[`（同一行、界内）——否则散文里偶然出现的 `](` 会被当成链接。
 * 图片则要求那个 `[` 前面是 `!`。
 *
 * 已知取舍：目标本身含**未转义的裸 `(`** 时会从那里截断——这与旧实现一致（既存限制）。
 * @param {string} stripped 已剥围栏与行内代码的文本
 * @returns {{target: string, isImage: boolean}[]}
 */
function scanInlineTargets(stripped) {
  const found = []
  for (let i = 0; i + 1 < stripped.length; i++) {
    if (stripped[i] !== ']' || stripped[i + 1] !== '(') continue
    // 向左**配对** label 的 `[`（同一行、上限 TARGET_SCAN_CAP，保证线性）：反向走时 `]` 加深、
    // `[` 抵消，depth 回到 0 的那个 `[` 才是这个 label 的开头。
    // 取“最近的一个 `[`”是错的——`![shot [1]](a.png)` 会配到内层 `[1]`，于是图片被判成普通链接。
    let open = -1
    let depth = 0
    for (let k = i - 1, steps = 0; k >= 0 && steps < TARGET_SCAN_CAP && stripped[k] !== '\n'; k -= 1, steps += 1) {
      if (stripped[k] === ']') depth += 1
      else if (stripped[k] === '[') {
        if (depth === 0) { open = k; break }
        depth -= 1
      }
    }
    if (open < 0) continue
    // 向右读目标：界内找到 `)` 才算闭合。
    let j = i + 2
    const limit = Math.min(stripped.length, j + TARGET_SCAN_CAP)
    while (j < limit && stripped[j] !== ')' && stripped[j] !== '\n') j += 1
    if (j >= limit || stripped[j] !== ')') continue
    found.push({ target: stripped.slice(i + 2, j), isImage: stripped[open - 1] === '!' })
  }
  return found
}

/**
 * 引用式定义：最多 3 个前导空格（CommonMark 的列表缩进形态），且**目的地必须与标记同一行**、
 * 行尾只允许空白或可选 title。旧写法两条都漏：`\s*` 跨行 → `[1]:` 这种空定义会把下一行第一个
 * 词吞成目标；没有行尾锚 → 正文里以方括号开头的句子（`[TODO]: finish this section`）造出一个
 * 假目标 `finish`，第 4 项于是报“链接目标不存在”。
 */
const REF_DEF_RE = /^ {0,3}\[[^\]]+\]:[ \t]*([^\s]+?)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm

/**
 * HTML 属性形态的正则。三个约束都是第五轮审查的产物（§6 第 1 条）：
 *  · **限行**（字符类里排除 `\r` `\n`）：散文里一个未配对的引号，原先会让匹配一路吞到下一个
 *    引号，交回一个跨多行的“目标”，随后被当成相对路径去 `existsSync`。行内扫描器
 *    （`scanInlineTargets`）刻意用换行终止并带 `TARGET_SCAN_CAP`，HTML 这边必须同一约束。
 *  · **限长**（`{0,512}`）：同一个退化输入的兜底——两个抽取器对同一类输入必须同样稳。
 *  · 属性名前面是行首 / 空白 / `<`：挡掉 `data-src=`、`xsrc=` 这类同名后缀
 *    （`\b` 在连字符后面也成立，所以 `\b` 那条写法会过度匹配）。
 */
const HTML_ATTR_RE = /(?:^|[\s<])(?:href|src)[ \t]*=[ \t]*(?:"([^"\r\n]{0,512})"|'([^'\r\n]{0,512})'|([^\s"'<>=\r\n]{1,512}))/gi

/** 只有这几个 host 的绝对链接才可能是“本仓库同一个文件”的远端写法。 */
const REMOTE_HOSTS = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com'])

/**
 * 匹配位置是否落在某个**开标签的属性串**里：同一行往左，最近的 `<` 必须晚于最近的 `>`。
 * 不做这一步，散文里的一句 `href="docs/a.md"` 也会被当成交付物。
 * @param {string} stripped 已剥代码的文本
 * @param {number} start 匹配起点
 * @param {number} end 匹配终点（含本次匹配——属性可能紧跟 `<a` 而前面没有空白）
 * @returns {boolean}
 */
function insideOpenTag(stripped, start, end) {
  const lineStart = stripped.lastIndexOf('\n', start) + 1
  const before = stripped.slice(lineStart, end)
  return before.lastIndexOf('<') > before.lastIndexOf('>')
}

/**
 * HTML 属性形态的引用目标：`<a href="…">` 与 `<img src="…">`，三种引号形态
 * （双引号 / 单引号 / 裸值）、等号两侧空白、标签与属性名大小写都要认。
 *
 * 为什么单独抽出来：`href="…"` 那种只认双引号的写法是假红的来源（004 的 Lens 1 修了行内图片
 * 只认一种形态的问题，第五轮又发现 `<img src='x.png'>`、`<img src = "x.png">`、`<IMG SRC="x.png">`
 * 这三种同样算“没引用”）。同时 `src` 必须和 `href` 走同一个抽取器，否则
 * `<img src="../outside/x.png">` 对越界检查完全隐形——那是“单一实现”这条规矩又被破了一次。
 * @param {string} stripped 已剥围栏与行内代码的文本
 * @returns {string[]} 原样目标片段
 */
export function extractHtmlTargets(stripped) {
  const out = []
  for (const m of stripped.matchAll(HTML_ATTR_RE)) {
    const value = m[1] ?? m[2] ?? m[3]
    if (value === undefined || value === '') continue
    if (!insideOpenTag(stripped, m.index, m.index + m[0].length)) continue
    out.push(value)
  }
  return out
}

/**
 * 在**已剥代码**的文本上抽取所有形态的目标。两个入口共用它：`extractLinkTargets` 收原文
 * （自己剥一次），`mentionsTarget` 已经剥过还要再剔注释——原先它直接调 `extractLinkTargets`，
 * 于是同一份文本被 `stripCode` 跑两遍，正确性悄悄依赖它幂等（§6 第 2 条）。
 * @param {string} stripped 已剥代码的文本
 * @returns {string[]} 原样目标片段（可能有重复；调用方用 Set 去重）
 */
function extractTargetsFromStripped(stripped) {
  const targets = scanInlineTargets(stripped).map(item => item.target)
  for (const m of stripped.matchAll(REF_DEF_RE)) targets.push(m[1])
  for (const value of extractHtmlTargets(stripped)) targets.push(value)
  return targets
}

/**
 * 抽取一个 Markdown 文本里所有链接与图片目标（内联 / 徽标式 / 引用式 / HTML 四种写法）。
 * 返回**原样片段**（未归一化），归一化交给 `normalizeTarget`。
 * @param {string} text Markdown 原文
 * @returns {string[]} 原样目标片段
 */
export function extractLinkTargets(text) {
  return extractTargetsFromStripped(stripCode(text))
}

/**
 * 只要**图片**目标（第 10 项的截图契约用）。与 `extractLinkTargets` 共用同一次扫描，
 * 免得第 10 项自己再写一条正则（旧写法在连续 `![` 上同样二次方）。
 * @param {string} text Markdown 原文
 * @returns {string[]} 图片目标的原样片段
 */
export function extractImageTargets(text) {
  return scanInlineTargets(stripCode(text)).filter(item => item.isImage).map(item => item.target)
}

/**
 * 去掉 markdown 的 title 属性、尖括号包裹、片段与查询串，以及 `./` 前缀。
 * **不做** `posix.normalize` —— 因为 `posix.normalize('//host/x')` 会把开头的 `//` 收成 `/`，
 * 归一化之后就再也分不出“协议相对的对外链接”与“绝对路径”了（`classifyTarget` 必须在这之前判）。
 * @param {string} raw 原样目标片段
 * @returns {string} 去掉装饰后的目标
 */
function stripTarget(raw) {
  // markdown 的 title 有三种写法（双引号 / 单引号 / 括号）。原先只剥双引号那一种，于是
  // `[x](docs/a.md 't')` 留着尾巴 `docs/a.md 't'` 被当成相对路径去 `existsSync`，制造一记指向
  // 错契约的假红——而 HTML 那边是刻意支持三种引号的，两边口径必须一致（§6 之外的第五轮第 2 条）。
  let t = raw.trim().replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/, '')   // markdown 的 title 属性（三种写法）
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  return t.split('#')[0].split('?')[0].replace(/^\.\//, '') // 片段 / 查询串 / ./ 前缀
}

/**
 * 归一化：去装饰（见 `stripTarget`）后再把 `..` 解开。
 * @param {string} raw 原样目标片段
 * @returns {string} 归一化后的目标（可能为空串）
 */
export function normalizeTarget(raw) {
  const undecorated = stripTarget(raw)
  return undecorated === '' ? '' : posix.normalize(undecorated)   // docs/../ROADMAP.md → ROADMAP.md
}

/**
 * 分类一个链接目标：调用方据此决定报什么、以及**要不要碰文件系统**。
 *
 * - `skip`      对外链接（带 scheme）/ 协议相对 `//host/path` / 纯片段 / 空 —— 一律不探测
 * - `escape`    会走到仓库之外（绝对路径 `/x`、Windows 盘符路径、任何深度越界的相对路径）
 * - `backslash` 含反斜杠 —— 一律报错（见下）
 * - `relative`  仓库内相对路径（**只有这一类才允许 `existsSync`**）
 *
 * 为什么 `escape` 判定要自己数目录深度、而不是 `target.startsWith('../')`：
 * `posix.normalize('..')` 返回 `'..'`（不以 `../` 开头），`'a/../..'` 也归一成 `'..'` ——
 * 旧实现把这两个都判成“仓库内相对路径”，于是 `existsSync(join(root,'..'))` 去探了**仓库之外**，
 * 而且它“存在就全绿”的差别本身就是“某个仓库外路径是否存在”的神谕。评审 Lens 2 实测确认。
 *
 * 为什么反斜杠一律报错、而不是按平台分别处理：`posix.normalize` 不认 `\`，而 Windows 的
 * `join()` 认——同一个输入在两个平台上语义不同，门禁就会给出不一致的结论。README 里的仓库路径
 * 本来也不该出现反斜杠，所以直接判为**非法**：平台无关、确定，且把那条越界面彻底关掉。
 *
 * 协议相对必须在**归一化之前**判：`posix.normalize('//host/x')` 收成 `/host/x` 之后，
 * 就无法与绝对路径区分了（003 的 Lens 2 F6 实测过这个假红）。
 *
 * 盘符同样先于 scheme 判定：`^[a-z][a-z0-9+.-]*:` 会把 `C:` 当成协议，于是 `C:/Windows/win.ini`
 * 与 `D:\x\y.md` 都被判成 skip、调用方 continue，Windows 绝对路径就从越界检查里隐形了
 * ——而本模块的立身之说正是“把那条越界面彻底关掉”，漏的恰好是本机平台（第五轮第 1 条 high）。
 * @param {string} raw 原样目标片段
 * @returns {{kind: 'skip'|'escape'|'backslash'|'relative', target: string}}
 */
export function classifyTarget(raw) {
  const undecorated = stripTarget(raw)
  if (/^[a-z]:([/\\]|$)/i.test(undecorated)) return { kind: 'escape', target: undecorated }
  if (undecorated === '' || undecorated.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(undecorated)) {
    return { kind: 'skip', target: undecorated }
  }
  if (undecorated.startsWith('//')) return { kind: 'skip', target: undecorated }
  const target = normalizeTarget(raw)
  if (target.startsWith('/')) return { kind: 'escape', target }     // 绝对路径
  if (target.includes('\\')) return { kind: 'backslash', target }
  let depth = 0
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      depth -= 1
      if (depth < 0) return { kind: 'escape', target }
    } else depth += 1
  }
  return { kind: 'relative', target }
}

/**
 * 绝对链接是否**真的指向本仓库的这个文件**（§6 第 3 条）。三条都要对，缺一就是假绿或假红：
 *  · host 必须是 GitHub 那几个，否则任意 CDN 上的同尾路径都算“引用了同一张图”；
 *  · path 要**解码后**比：仓库里的文件名一旦带非 ASCII 或空格，未解码的 pathname 与 `wanted`
 *    永远不相等，那是假红；owner/repo 在 GitHub 上大小写不敏感，手写 README 常写成
 *    `Owner/Repo`，精确前缀同样会假红；
 *  · 去掉 `/owner/repo/` 之后，剩余段必须**整段**等于 `[blob|raw|tree]/<ref>/<wanted>`
 *    （raw host 的形态是 `<ref>/<wanted>`）。原先 `pathname.endsWith('/' + wanted)` 连
 *    `/main/backup/docs/x.png` 都算，那是假绿。
 * @param {URL} url 已解析的绝对链接
 * @param {string} wanted 归一化后的仓库内相对路径
 * @param {string} ownRepoPath 本仓库的 owner/repo
 * @returns {boolean}
 */
function remotePointsAtWanted(url, wanted, ownRepoPath) {
  const host = url.hostname.toLowerCase()
  if (!REMOTE_HOSTS.has(host)) return false
  let decoded
  try { decoded = decodeURIComponent(url.pathname) } catch { return false }   // 非法百分号转义：不是引用
  const prefix = '/' + ownRepoPath + '/'
  if (!decoded.toLowerCase().startsWith(prefix.toLowerCase())) return false
  let rest = decoded.slice(prefix.length)
  const mode = /^(?:blob|raw|tree)\/[^/]+\//.exec(rest)
  if (mode !== null) rest = rest.slice(mode[0].length)
  // raw.githubusercontent.com 不带 blob/raw：形态是 /owner/repo/<ref>/<path>，剥掉第一段 ref
  else if (host === 'raw.githubusercontent.com') { const i = rest.indexOf('/'); rest = i < 0 ? '' : rest.slice(i + 1) }
  return rest.split('#')[0] === wanted
}

/**
 * 判断一份文本是否**真的引用了**某个仓库内目标（第 10 项的结构图断言用）。
 *
 * 为什么要单独一个函数、而且要覆盖四种写法：初版断言只扫行内 markdown 图片，于是
 * `<img src="…">`、引用式定义、绝对 GitHub 链接三种**无害写法**被判红
 * （004 的 Lens 1 端到端实测：临时副本 exit 0→1，且报错文案还说“没有引用”）。
 * 假红比没有检查更坏——它会训练人忽略红灯，所以这里按“引用”的语义收全。
 *
 * 三种被接受的形态：
 *  - 仓库内相对路径：归一化后**等于**目标（`./docs/…`、带 title、尖括号都归一到同一串）
 *  - 本仓库的绝对链接（见 `remotePointsAtWanted`）
 *  - HTML 的 `href=` 与 `src=` 两种属性（与链接检查共用同一个抽取器）
 *
 * 两种刻意**不算**引用的形态：
 *  - 代码围栏 / 行内代码里的示例（与第 4 项、第 4b 项同一口径：那是文档，不是声明）
 *  - HTML 注释里的引用（`<!-- … -->`）——它不渲染，等于没引用（004 的 Lens 1 实测过这条绕过）
 * @param {string} text Markdown 原文
 * @param {string} wanted 归一化后的仓库内相对路径，例如 `docs/images/architecture.png`
 * @param {string|null} ownRepoPath 本仓库的 `owner/repo`（绝对链接只认这一条前缀）；
 *   传 `null` 表示不认远端形态
 * @returns {boolean}
 */
export function mentionsTarget(text, wanted, ownRepoPath = null) {
  // 注释替换成**空格**而不是空串：空串会把注释两侧的文字拼成一行，凭空造出 `](` 配对
  // （`![x]<!-- c -->(a.png)` 会被拼成 `![x](a.png)`），那是根本不存在的引用（§6 第 2 条）。
  const stripped = stripCode(text).replace(/<!--[\s\S]*?-->/g, ' ')
  return extractTargetsFromStripped(stripped).some(raw => {
    const undecorated = stripTarget(raw)
    if (undecorated === '') return false
    if (/^[a-z][a-z0-9+.-]*:/i.test(undecorated) || undecorated.startsWith('//')) {
      if (ownRepoPath === null) return false
      try {
        const url = new URL(undecorated.startsWith('//') ? 'https:' + undecorated : undecorated)
        return remotePointsAtWanted(url, wanted, ownRepoPath)
      } catch { return false }
    }
    const { kind, target } = classifyTarget(raw)
    return kind === 'relative' && target === wanted
  })
}
