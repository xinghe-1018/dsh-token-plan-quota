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
 *    而旧实现只是"见 `](` 就取"。
 *  - 只找 `](` 则 label 怎么嵌套都认得，且每个起点只扫到下一个 `)`（上限 512 字符，
 *    兜住"整份文档都没有 `)`"的退化输入）——整体线性。003 的 Lens 2 实测原实现在
 *    `'![' × 40000`（80 KB）上要 **10.9 秒**。
 *
 * 要求紧邻左侧有一个 `[`（同一行、界内）——否则散文里偶然出现的 `](` 会被当成链接。
 * 图片则要求那个 `[` 前面是 `!`。
 *
 * 已知取舍：目标本身含**未转义的裸 `(`** 时会从那里截断——这与旧实现一致（既存限制）。
 *
 * @param {string} stripped 已剥围栏与行内代码的文本
 * @returns {{target: string, isImage: boolean}[]}
 */
function scanInlineTargets(stripped) {
  const found = []
  for (let i = 0; i + 1 < stripped.length; i++) {
    if (stripped[i] !== ']' || stripped[i + 1] !== '(') continue
    // 向左**配对** label 的 `[`（同一行、上限 TARGET_SCAN_CAP，保证线性）：反向走时 `]` 加深、
    // `[` 抵消，depth 回到 0 的那个 `[` 才是这个 label 的开头。
    // 取"最近的一个 `[`"是错的——`![shot [1]](a.png)` 会配到内层 `[1]`，于是图片被判成普通链接。
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
 * 抽取一个 Markdown 文本里所有链接与图片目标（内联 / 徽标式 / 引用式 / HTML 四种写法）。
 * 返回**原样片段**（未归一化），归一化交给 `normalizeTarget`。
 * @param {string} text Markdown 原文
 * @returns {string[]} 原样目标片段（可能有重复；调用方用 Set 去重）
 */
export function extractLinkTargets(text) {
  const stripped = stripCode(text)
  const targets = scanInlineTargets(stripped).map(item => item.target)
  // 引用式定义：允许最多 3 个前导空格（CommonMark 的列表缩进形态）。
  for (const m of stripped.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)) targets.push(m[1])
  for (const m of stripped.matchAll(/href="([^"]+)"/g)) targets.push(m[1])   // HTML
  return targets
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
 * 归一化之后就再也分不出"协议相对的对外链接"与"绝对路径"了（`classifyTarget` 必须在这之前判）。
 * @param {string} raw 原样目标片段
 * @returns {string} 去掉装饰后的目标
 */
function stripTarget(raw) {
  let t = raw.trim().replace(/\s+"[^"]*"$/, '')            // markdown 的 title 属性
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  return t.split('#')[0].split('?')[0].replace(/^\.\//, '') // 片段 / 查询串 / ./ 前缀
}

/**
 * 归一化：去装饰（见 `stripTarget`）后再把 `..` 解开。
 * @param {string} raw 原样目标片段
 * @returns {string} 归一化后的目标（可能为空串）
 */
export function normalizeTarget(raw) {
  const t = stripTarget(raw)
  return t === '' ? '' : posix.normalize(t)                // docs/../ROADMAP.md → ROADMAP.md
}

/**
 * 分类一个链接目标：调用方据此决定报什么、以及**要不要碰文件系统**。
 *
 * - `skip`      对外链接（带 scheme）/ 协议相对 `//host/path` / 纯片段 / 空 —— 一律不探测
 * - `escape`    会走到仓库之外（绝对路径 `/x`、任何深度越界的相对路径）
 * - `backslash` 含反斜杠 —— 一律报错（见下）
 * - `relative`  仓库内相对路径（**只有这一类才允许 `existsSync`**）
 *
 * 为什么 `escape` 判定要自己数目录深度、而不是 `target.startsWith('../')`：
 * `posix.normalize('..')` 返回 `'..'`（不以 `../` 开头），`'a/../..'` 也归一成 `'..'` ——
 * 旧实现把这两个都判成"仓库内相对路径"，于是 `existsSync(join(root,'..'))` 去探了**仓库之外**，
 * 而且它"存在就全绿"的差别本身就是"某个仓库外路径是否存在"的神谕。评审 Lens 2 实测确认。
 *
 * 为什么反斜杠一律报错、而不是按平台分别处理：`posix.normalize` 不认 `\`，而 Windows 的
 * `join()` 认——同一个输入在两个平台上语义不同，门禁就会给出不一致的结论。README 里的仓库路径
 * 本来也不该出现反斜杠，所以直接判为**非法**：平台无关、确定，且把那条越界面彻底关掉。
 *
 * 协议相对必须在**归一化之前**判：`posix.normalize('//host/x')` 收成 `/host/x` 之后，
 * 就无法与绝对路径区分了（003 的 Lens 2 F6 实测过这个假红）。
 *
 * @param {string} raw 原样目标片段
 * @returns {{kind: 'skip'|'escape'|'backslash'|'relative', target: string}}
 */
export function classifyTarget(raw) {
  const decorated = stripTarget(raw)
  if (decorated === '' || decorated.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(decorated)) {
    return { kind: 'skip', target: decorated }
  }
  if (decorated.startsWith('//')) return { kind: 'skip', target: decorated }
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