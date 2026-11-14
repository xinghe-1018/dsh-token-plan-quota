#!/usr/bin/env node
/**
 * 文档自检：README 里的**可核实声明**必须与代码一致。
 *
 * 动机很直接：插件目录站的评审会拿描述去核代码（"写 46 个工具就该有 46 个工具"），
 * 而本项目自己的 README 也反复声称"不估算/只报真值"。这类话一旦写成文字就该是**可执行的**，
 * 否则它就是又一处会腐烂的注释。
 *
 * 检查项：
 *   1. `DEFAULTS` 每个键都在中英两份 README 的配置表里出现；
 *   2. `PRESETS` 每个源名都在中英 README 里出现（新增一家忘了同步文档 = CI 红）；
 *   3. 预设与字体 CDN 的每个出站主机都在 `dshhub.permissions.network` 里；
 *   4. README 里的相对链接指向的文件真实存在；
 *   4b. README 的相对链接目标必须**随包发布**（包页只渲染包内文件：否则 GitHub 正常、npm 上 404）；
 *   5. README 声称的测试项数与实跑结果一致（数字不许漂）——host / client / guards **三个套件都核**；
 *   6. 正文里写死的计数（键数/源数/主机数）与代码一致；
 *   7. CHANGELOG 引用的 tag 必须存在（浅克隆/装出来的包看不见 tag 时**出声跳过**，不假红）；
 *   8. 两张键表逐行对得上代码（配置表 = DEFAULTS，条目键表 = 代码真读的 `source.*`）；
 *   9. 文本没有被错误码页读写过（BOM / U+FFFD / GBK 私用区残骸）；
 *  10. 十三张截图（中文 7 张 / 英文 6 张）+ 一张结构图真实存在且 README 已引用，合成数据仍符合产品口径。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __internals } from '../lib/index.js'
// 出站主机的推导与比对抽成单一实现（可被 test/guards.mjs 喂正反例），见该文件的头注释。
import { compareHosts, deriveHostsFromCode } from './outbound-hosts.mjs'
import { shouldSkipDir } from './walk-skip.mjs'
import { repoPathFromUrl } from './repo-path.mjs'
import { classifyTarget, extractImageTargets, extractLinkTargets, mentionsTarget } from './link-targets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(join(root, file), 'utf8')
const zh = read('README.md')
const en = read('README.en.md')
const pkg = JSON.parse(read('package.json'))
const problems = []
const notices = []

/* 1) 配置键 */
for (const key of Object.keys(__internals.DEFAULTS).sort()) {
  const token = '`' + key + '`'
  if (!zh.includes(token)) problems.push(`README.md 的配置表缺键 ${key}`)
  if (!en.includes(token)) problems.push(`README.en.md 的配置表缺键 ${key}`)
}

/* 2) 数据源名 */
for (const id of Object.keys(__internals.PRESETS).sort()) {
  const token = '`' + id + '`'
  if (!zh.includes(token)) problems.push(`README.md 没提到数据源 ${id}`)
  if (!en.includes(token)) problems.push(`README.en.md 没提到数据源 ${id}`)
}

/* 3) 出站主机：声明集合必须与实际出站集合**逐项相等**（宪法 V）。
 *
 *    旧实现有两个洞（2026-09 审查实测）：
 *      a. 只从预设的 url/infoUrl/regions 抠，而阿里云 BSS 的主机是 `DEFAULTS.endpoint` 的裸
 *         主机名（请求时才拼成 https）—— 抠不出来，等于"人工声明对了、门禁从没验过"；
 *      b. 字体 CDN 那行是扫 README 文本，而两份 README 里根本没有那个 URL → 恒不命中，
 *         **死代码**（门禁宣称管到了，实际没管）。
 *    现在改为：从代码推导（预设 + endpoint + client.js 的 FONT_CSS），并**双向**比对。 */
const declared = new Set((pkg.dshhub?.permissions?.network ?? []).map(entry => entry.replace(/\/+$/, '')))
const derived = deriveHostsFromCode({
  presets: __internals.PRESETS,
  defaults: __internals.DEFAULTS,
  clientSource: readFileSync(join(root, 'lib/client.js'), 'utf8'),
})
// 扫描面自检：推导不出足够主机就说明这条检查失效了（宁可红，也不假装通过）。
if (derived.size < 6) problems.push(`只从代码里推导出 ${derived.size} 个出站主机，这条检查的扫描面像失效了`)
if (declared.size === 0) problems.push('dshhub.permissions.network 是空的：所有出站主机都要声明')
const hostDiff = compareHosts(derived, declared)
for (const host of hostDiff.undeclared) problems.push(`出站主机 ${host} 未声明在 dshhub.permissions.network`)
for (const host of hostDiff.unused) {
  problems.push(`dshhub.permissions.network 声明的 ${host} 在代码里找不到出处（删源后遗留？声明必须与实际逐项相等）`)
}

/* 4) 相对链接：README 里的相对链接必须指向**仓库内真的存在**的文件。
 *
 *    抽取与分类是**单一实现**（`./link-targets.mjs`），第 4 项、4b 与第 10 项共用。曾经两处各
 *    有一套正则，结果窄的那套对**引用式**与 **HTML** 两种写法完全隐形，而**代码围栏里的示例**
 *    又被它误报成声明（002 的 Lens 1/Lens 2 各自独立报过同一处）——同一语义两处实现必有一处先忘。
 *    现在连"要不要碰文件系统"也只由 `classifyTarget` 说了算：**只有 `relative` 才允许 existsSync**。 */

/* 抽取 + 分类**只做一次**，第 4、4b、10 项共用。过去三条检查各自跑一遍 extractLinkTargets /
 * extractImageTargets（每次都是全文 stripCode + 线性扫描），而 classifyTarget 的分支处理在两处
 * 各写一份——本文件头注释记的就是"两处各一套实现必有一处先忘"（§6 第 6 条）。 */
const README_FILES = [['README.md', zh], ['README.en.md', en]]
const linkFacts = new Map()
const imageFacts = new Map()
for (const [file, text] of README_FILES) {
  const uniq = new Map()
  for (const raw of extractLinkTargets(text)) {
    const { kind, target } = classifyTarget(raw)
    uniq.set(kind + String.fromCharCode(0) + target, { kind, target })
  }
  linkFacts.set(file, [...uniq.values()])
  const refs = extractImageTargets(text).map(raw => classifyTarget(raw))
  imageFacts.set(file, { count: refs.length, refs, relative: refs.filter(item => item.kind === 'relative').map(item => item.target) })
}
for (const [file, items] of linkFacts) {
  for (const { kind, target } of items) {
    if (kind === 'skip') continue
    // 指向仓库外 / 含反斜杠的一律报错。前者本来就没意义，顺带关掉"用存在性探测仓库外路径"那个面
    // （002 的 Lens 2 F5 记为既存问题；003 的 Lens 2 进一步指出旧判定漏了裸 `..` 与 `\` 形态）。
    if (kind === 'escape') problems.push(`${file} 的链接目标指向仓库外：${target}`)
    else if (kind === 'backslash') problems.push(`${file} 的链接目标含反斜杠，不是合法仓库路径：${target}`)
    else if (!existsSync(join(root, target))) problems.push(`${file} 的链接目标不存在：${target}`)
  }
}

/* 4b) 发布面链接：README 里的每个链接与图片目标都必须**随包发布**。npm 包页只渲染包内文件——
 *     一个"仓库内存在但不随包发布"的目标，在 GitHub 上正常、在包页上 404（图片则是裂图），
 *     本地完全看不出来；上面第 4 项只查"仓库内存在"，管不到这一层。
 *
 *     抽取与分类和第 4 项共用同一套实现（`extractLinkTargets` + `classifyTarget`）。当初两边
 *     各有一套正则，窄的那套只认内联 `](x)`，对带 title、引用式、HTML 三种写法完全隐形
 *     ——002 的 Lens 1 与 Lens 2 各自独立报了同一处。两处实现必然分叉，所以只留一处。
 *     发布面也不能只按 `files` 字面算：`npm pack` 无论 files 怎么写都会带上 package.json、
 *     README*、LICENSE* 与 main 指向的文件（审阅实测 package.json 在 tarball 里而不在 files）。 */
const fileList = pkg.files ?? null
if (fileList === null) {
  notices.push('README 发布面检查跳过：package.json 没有 files 字段，无法判断哪些文件随包发布')
} else if (fileList.some(f => f.startsWith('!') || /[*?[\]{}]/.test(f))) {
  notices.push('README 发布面检查可能不准：files 里含否定项或 glob，本检查只做字面/目录前缀比对')
}
const alwaysShipped = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'LICENCE', pkg.main, pkg.types]
  .filter(v => typeof v === 'string' && v !== '')
const publishedFiles = [...(fileList ?? []).filter(f => !f.startsWith('!')), ...alwaysShipped]
const isPublished = target => publishedFiles.some(f => target === f || target.startsWith(f.replace(/\/$/, '') + '/'))
for (const [file, items] of (fileList === null ? [] : linkFacts)) {
  for (const { kind, target } of items) {
    if (kind !== 'relative') continue
    if (!isPublished(target)) {
      problems.push(`${file} 的链接目标不随包发布：${target}（改成绝对链接，或加进 package.json#files）`)
    }
  }
}

/* 5) 测试项数 */
// **三个套件都要核**。这里曾经只有 host / client，`test/guards.mjs` 不在列表里——
// 代价实测过：它的用例数在评审修复中从 32 涨到 80，而 README 里那句"32 项"因为没人守，
// 刚写完就漂了。凡是**写在 README 里、又能从实跑得到**的数字，就必须进这个列表。
const SUITES = ['host', 'client', 'guards']
const counts = {}
for (const suite of SUITES) {
  // 套件**失败时 execFileSync 直接抛**：旧写法让本脚本带着未捕获堆栈终止，于是下面「有 N 项失败」
  // 那条分支永远执行不到（死代码），而 6b / 6 / 10 项与汇总行全不跑；报错文案还把「文档门禁」和
  // 「测试失败」混成一坨（宪法 V：报错必须落在正确的契约上）。不带 maxBuffer 时，输出超 1MB
  // 还会以 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 再炸一次。
  let out = ''
  try {
    out = execFileSync(process.execPath, [join(root, 'test', `${suite}.mjs`)], { encoding: 'utf8', maxBuffer: 64 * 1048576 })
  } catch (error) {
    out = String(error.stdout ?? '')
    problems.push(`test/${suite}.mjs 实跑失败：${out === '' ? String(error.message).slice(0, 200) : '见该套件输出，退出码 ' + error.status}`)
  }
  const match = /(\d+) passed, (\d+) failed/.exec(out)
  if (match === null) problems.push(`test/${suite}.mjs 没给出可解析的结果行`)
  else if (match[2] !== '0') problems.push(`test/${suite}.mjs 有 ${match[2]} 项失败`)
  else counts[suite] = Number(match[1])
}
for (const suite of SUITES) {
  const claimed = [...zh.matchAll(new RegExp(`test/${suite}\\.mjs\\s+#?\\s*(\\d+) 项`, 'g'))].map(m => Number(m[1]))
    .concat([...en.matchAll(new RegExp(`test/${suite}\\.mjs\\s*\\n?\\s*#\\s*(\\d+) assertions`, 'g'))].map(m => Number(m[1])))
  for (const value of claimed) {
    if (counts[suite] !== undefined && value !== counts[suite]) {
      problems.push(`README 声称 test/${suite}.mjs 是 ${value} 项，实跑 ${counts[suite]} 项`)
    }
  }
  if (claimed.length === 0 && counts[suite] !== undefined) {
    problems.push(`README 里找不到 test/${suite}.mjs 的项数声明（应为 ${counts[suite]}）`)
  }
}

/* 6) 正文里写死的计数也是声明：新增一家忘了改这句，就该 CI 红。
 *    主机数说的是**已声明**的出站主机（审计看的就是这个数），不是从预设里推导出来的那批。
 *    键数与"配置表行数"分开声明（17 个 DEFAULTS 键 vs 表里 18 行），因为盲测时有读者把这两个数当成
 *    互相矛盾的证据——两个都检查，两个就都别再想漂。 */
const tally = { keys: Object.keys(__internals.DEFAULTS).length, sources: Object.keys(__internals.PRESETS).length, hosts: declared.size }
const zhProse = /DEFAULTS (\d+) 个键、配置表 (\d+) 行、(\d+) 个数据源、声明 (\d+) 个出站主机/.exec(zh)
if (zhProse === null) problems.push('README.md 里找不到「DEFAULTS N 个键、配置表 M 行、K 个数据源、声明 L 个出站主机」这句（措辞被改了？那就同步改这条检查）')
else {
  const [keys, rows, sources, hostCount] = [Number(zhProse[1]), Number(zhProse[2]), Number(zhProse[3]), Number(zhProse[4])]
  if (keys !== tally.keys) problems.push(`README.md 说 DEFAULTS ${keys} 个键，实际 ${tally.keys} 个`)
  if (rows !== tally.keys + 1) problems.push(`README.md 说配置表 ${rows} 行，应为 ${tally.keys + 1}（DEFAULTS 键 + moonshotRegion）`)
  if (sources !== tally.sources) problems.push(`README.md 说 ${sources} 个数据源，实际 ${tally.sources} 个`)
  if (hostCount !== tally.hosts) problems.push(`README.md 说声明 ${hostCount} 个出站主机，实际 ${tally.hosts} 个`)
}
// 冠词随行数变（18 行是 "an 18-row"，19 行是 "a 19-row"）：检查的是数字，不是冠词。
const enProse = /(\d+) DEFAULTS keys, an? (\d+)-row\s*\n?\s*config table, (\d+) sources,\s*\n?\s*(\d+) declared outbound hosts/.exec(en)
if (enProse === null) problems.push('README.en.md 里找不到 "N DEFAULTS keys, an M-row config table, K sources, L declared outbound hosts" 这句')
else {
  const [keys, rows, sources, hostCount] = [Number(enProse[1]), Number(enProse[2]), Number(enProse[3]), Number(enProse[4])]
  if (keys !== tally.keys) problems.push(`README.en.md says ${keys} DEFAULTS keys, actual ${tally.keys}`)
  if (rows !== tally.keys + 1) problems.push(`README.en.md says an ${rows}-row config table, expected ${tally.keys + 1}`)
  if (sources !== tally.sources) problems.push(`README.en.md says ${sources} sources, actual ${tally.sources}`)
  if (hostCount !== tally.hosts) problems.push(`README.en.md says ${hostCount} declared outbound hosts, actual ${tally.hosts}`)
}
/* 6b) 正文里成对写的"N/M tests"也是声明。这条原本没人管，英文 README 就一直漂着 324/102。, *    位置耦合是真实风险：m[1]/m[2] 的含义纯靠"正文里恰好按 host/client 的顺序写"，谁写成, *    client/guards 就会凭空造出两条假红。所以这里把**顺序写进注释**，并另加一条按套件名, *    锚定的 guards 核对（第五轮审查第 4 条：三个套件都声称要核，6b 却只覆盖两个）。 */
for (const [file, text] of [['README.md', zh], ['README.en.md', en]]) {
  for (const m of text.matchAll(/(\d+)\/(\d+)\s*(?:tests|项)/g)) {
    if (counts.host !== undefined && Number(m[1]) !== counts.host) problems.push(`${file} 正文写 ${m[1]}/${m[2]} tests，host 实跑 ${counts.host}`)
    if (counts.client !== undefined && Number(m[2]) !== counts.client) problems.push(`${file} 正文写 ${m[1]}/${m[2]} tests，client 实跑 ${counts.client}`)
  }
  // guards 的数字在两份 README 里都是单独写的（中文"guards 141 项"/英文"141 guards assertions"），
  // 位置耦合的那条正则覆盖不到它——按名字锚定单独核一遍。
  for (const m of text.matchAll(/guards\s+(\d+)\s*项/g)) {
    if (counts.guards !== undefined && Number(m[1]) !== counts.guards) problems.push(`${file} 正文写 guards ${m[1]} 项，实跑 ${counts.guards}`)
  }
  for (const m of text.matchAll(/(\d+) guards assertions/g)) {
    if (counts.guards !== undefined && Number(m[1]) !== counts.guards) problems.push(`${file} says ${m[1]} guards assertions, actual ${counts.guards}`)
  }
}

/* 7) CHANGELOG 里的版本链接不能指向不存在的 tag（留个死链就是又一处假声明） */
const changelog = read('CHANGELOG.md')
// 只看链接定义行（`[0.4.0]: https://…`），正文里提到 vX.Y.Z 的说明文字不算声明。
const referenced = [...new Set([...changelog.matchAll(/^\[[\d.]+\]:\s.*?(v\d+\.\d+\.\d+)(?:\.\.\.)?(v\d+\.\d+\.\d+)?/gm)]
  .flatMap(m => [m[1], m[2]].filter(Boolean)))]
/**
 * 仓库里看得见的 tag。**不打网络**：这是每次提交都要跑的检查，不能悄悄发出请求。
 * 返回 null 表示"这里看不见 tag 不等于 tag 不存在"（不是 git 仓库 / 浅克隆），
 * 那种情况下跳过这条，而不是把四个版本全判成死链——CI 上 `actions/checkout` 默认的
 * 单层克隆就会命中这一条，假红过一次。
 */
function visibleTags() {
  try {
    if (execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).trim() !== 'true') {
      return { tags: null, why: '不是 git 仓库（装出来的包）' }
    }
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true') {
      return { tags: null, why: '浅克隆，tag 不在本地' }
    }
    return { tags: execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean), why: null }
  } catch {
    return { tags: null, why: 'git 不可用' }
  }
}

const seen = visibleTags()
if (seen.tags === null) {
  notices.push(`CHANGELOG tag 检查跳过：${seen.why}`)
} else {
  const tags = seen.tags
  // 一个 tag 都看不见又不是浅克隆：要么仓库真没打过 tag（当初这条就是抓到四个死链），
  // 要么这个克隆没取 tag。两种情况的对策相反，所以一次把两条都摆出来，别让人去删好链接。
  const hint = tags.length === 0 ? '（仓库确实没打过 tag 就删掉链接；只是这个克隆没取 tag 的话先 `git fetch --tags`）' : ''
  for (const tag of referenced.sort()) {
    if (!tags.includes(tag)) problems.push(`CHANGELOG 引用了 ${tag}，但仓库没有这个 tag${hint}`)
  }
  // 「当前版本要有章节」这条原来被两个前置条件短路（tag 已在、链接已引用），
  // 而正常发布恰恰是**先有 tag**：缺章节照样绿灯，宣称的覆盖面≠实际覆盖面（审查第 2 条 high）。
  // 现在无条件要求，并补上反方向：CHANGELOG 里最新的已发布章节必须等于 package.json 的版本，
  // 且该版本必须有链接定义行（只有 `## [X]` 没有 `[X]:` 的半次发布也一并抓住）。
  if (pkg.version !== '0.0.0') {
    if (!changelog.includes(`## [${pkg.version}]`)) problems.push(`CHANGELOG 缺当前版本 ${pkg.version} 的章节`)
    if (!new RegExp(`^\\[${pkg.version.replace(/\\./g, '\\.')}\\]:`, 'm').test(changelog)) problems.push(`CHANGELOG 缺 [${pkg.version}] 的链接定义行（发布没走完或手改了一半）`)
    const published = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1])
    if (published.length > 0 && published[0] !== pkg.version) problems.push(`CHANGELOG 最新的已发布章节是 ${published[0]}，而 package.json 说 ${pkg.version}（两个来源必须同时改）`)
  }
}

/* 8) 两张键表是外人唯一能照着写配置的地方：文档说的键，代码必须真读。
 *    动机：盲测时有读者照着 README 写 `card.meters`，而那个键手写根本无效——
 *    "照文档写出来却静默失效"这类洞不该等下一次人工发现。 */
const libText = read('lib/index.js')
const codeSourceKeys = new Set([...libText.matchAll(/\bsource\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))

/** 取某小节里表格每行第一个单元格内的反引号标识符（行尾按 \n 归一：工作副本是 CRLF）。 */
function tableKeys(input, startMarker, endMarker) {
  const text = input.replace(/\r\n/g, '\n')
  const start = text.indexOf(startMarker)
  if (start < 0) return null
  const rest = text.slice(start + startMarker.length)
  const at = endMarker === undefined ? -1 : rest.indexOf(endMarker)
  const slice = at < 0 ? rest : rest.slice(0, at)
  const keys = []
  for (const line of slice.split(/\r?\n/)) {
    const cell = /^\|\s*([^|]+)\|/.exec(line)
    if (cell === null) continue
    // 允许点号：`card.meters` 这类"点出来的键"恰恰是最该被抓的（它就是当初误导读者的那个词）。
    for (const token of cell[1].matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) keys.push(token[1])
  }
  return keys
}

const documentedDefaults = new Set(Object.keys(__internals.DEFAULTS))
for (const [file, text, marker] of [['README.md', zh, '## 配置\n'], ['README.en.md', en, '## Configuration\n']]) {
  const configKeys = tableKeys(text, marker, '\n### ')
  if (configKeys === null) { problems.push(`${file} 找不到「${marker.trim()}」小节，配置表检查失去落点`); continue }
  const missing = [...documentedDefaults].filter(key => !configKeys.includes(key))
  if (missing.length > 0) problems.push(`${file} 的配置表缺键：${missing.join(', ')}`)
  for (const key of configKeys) {
    if (!documentedDefaults.has(key) && key !== 'moonshotRegion') {
      problems.push(`${file} 配置表里的 ${key} 既不是 DEFAULTS 键，也不在允许的单列例外里`)
    }
  }
  if (new Set(configKeys).size !== configKeys.length) problems.push(`${file} 配置表里同一个键出现了多次`)
  if (configKeys.length !== documentedDefaults.size + 1) {
    problems.push(`${file} 配置表列了 ${configKeys.length} 个键，应为 ${documentedDefaults.size} 个 DEFAULTS 键 + moonshotRegion`)
  }
}
for (const [file, text, marker, endMarker] of [
  ['README.md', zh, '#### 手写条目的全部可用键', '**表外的键'],
  ['README.en.md', en, '#### Every key a hand-written entry accepts', '**Keys outside this table'],
]) {
  const entryKeys = tableKeys(text, marker, endMarker)
  if (entryKeys === null) { problems.push(`${file} 找不到条目键表小节（${marker}），这条检查失去落点`); continue }
  if (entryKeys.length < 20) problems.push(`${file} 条目键表只解析出 ${entryKeys.length} 个键，不像一张完整的表`)
  for (const key of new Set(entryKeys)) {
    if (!codeSourceKeys.has(key)) problems.push(`${file} 条目键表里的 ${key} 代码从没读过（写成这样就是又一处死文档）`)
  }
}

/* 9) 编码护栏：Windows PowerShell 5.1 的 `Get-Content` 按 ANSI(GBK) 读 UTF-8，一次
 *    `Get-Content | Set-Content -Encoding utf8` 往返就把中文变成乱码 + BOM，而且**不可逆**
 *    （GBK 私用区字符没有反向映射）。本仓库真的踩过，所以这类损坏必须当场红灯。
 *    判断只看码位，不用字面量——不然这条检查自己就会成为又一处隐形损坏。 */
const TEXT_EXT = new Set(['.md', '.mjs', '.cjs', '.js', '.json', '.yml', '.yaml', '.sh', '.bash', '.ps1', '.psm1',
  '.txt', '.css', '.html', '.toml', '.cfg', '.ini'])
// 无扩展名但必须是文本的（含 .githooks/pre-commit —— 它依赖 shebang，BOM 会让 shebang 失效，
// 而不变量 VI 点名的正是这一条，旧实现却把它漏在扫描面外）。
const TEXT_NAMES = new Set(['LICENSE', 'pre-commit', 'post-commit', 'commit-msg', 'pre-push',
  '.gitattributes', '.gitignore', '.npmrc'])
// 跳过集合与 check-refs 共用一份（理由见 scripts/walk-skip.mjs 头注释）。
/** 递归枚举文本文件。不用 `{ recursive: true }`：它会跟随 symlink/junction 到仓库外（同 check-refs 的理由）。 */
function walkTextFiles(absDir, rel, out) {
  for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
    if (dirent.isSymbolicLink()) continue
    const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
    if (dirent.isDirectory()) {
      if (!shouldSkipDir(dirent.name)) walkTextFiles(join(absDir, dirent.name), childRel, out)
      continue
    }
    const dot = dirent.name.lastIndexOf('.')
    const ext = dot > 0 ? dirent.name.slice(dot).toLowerCase() : ''
    if (TEXT_EXT.has(ext) || TEXT_NAMES.has(dirent.name)) out.push(childRel)
  }
}
const textFiles = []
walkTextFiles(root, '', textFiles)
// 扫描面自检：目录改名/扩展名表写窄了会让这道护栏"零违规通过"——那是最坏的假绿。
if (textFiles.length < 40) problems.push(`编码护栏只扫到 ${textFiles.length} 个文本文件（预期 >= 40），扫描面像失效了`)
const isCjk = ch => { const cp = ch.codePointAt(0); return cp >= 0x4E00 && cp <= 0x9FFF }
const isPua = ch => { const cp = ch.codePointAt(0); return cp >= 0xE000 && cp <= 0xF8FF }
for (const rel of textFiles) {
  let raw
  try {
    raw = readFileSync(join(root, rel)).toString('utf8')
  } catch (error) {
    // 静默跳过 = 「这个文件没被检查过而门禁全绿」。下面的扫描面自检按**枚举数**统计，
    // 所以读失败不会被它抓住；Windows 上占用/权限/路径异常都很常见。
    problems.push(`编码护栏读不了 ${rel}（${error.code ?? error.message}）：它仍在扫描面内，不能当无事发生`)
    continue
  }
  if (raw.charCodeAt(0) === 0xFEFF) {
    problems.push(`${rel} 以 BOM 开头（多半是 PowerShell 5.1 的 Set-Content -Encoding utf8 写的；JSON 解析会直接炸）`)
  }
  let hasReplacement = false
  let hasCjkChar = false
  let hasPuaChar = false
  for (const ch of raw) {
    const cp = ch.codePointAt(0)
    if (cp === 0xFFFD) hasReplacement = true
    else if (isCjk(ch)) hasCjkChar = true
    else if (isPua(ch)) hasPuaChar = true
  }
  if (hasReplacement) problems.push(`${rel} 含 U+FFFD 替换符：这份文本已经被错误的码页读过一次了`)
  if (hasCjkChar && hasPuaChar) problems.push(`${rel} 同时含中日韩文字与私用区字符，是 GBK 误读 UTF-8 的典型残骸`)
}

const DIAGRAM = 'docs/images/architecture.png'   // 全仓库唯一的结构图（中英共用一张，产出方见 AGENTS.md）

/* 10) 截图物料：占位块必须已被真图取代，图必须真实存在且非零字节。
 *     截图是合成数据生成的（scripts/shots/），所以这里同时跑一次 fixture 自检——
 *     产品口径（实测卡不带百分比、百分比与 remaining/total 自洽、键 ⊆ publicCard 白名单、
 *     英文套不混中文）漂了就红，而不是悄悄拍出一张宿主永远发不出的图。
 *     架构图与截图套不同源（它由 diagrams/ 的源规格产出、两种语言共用一张），
 *     所以除了下面这条存在性清单，还有一条**点名**的双语引用断言。 */
{
  // 截图套（中英两套，出自 scripts/shots/make-shots.mjs）：只有这份进逐语言的引用集合，
  // 因为截图契约认的是 markdown 行内图片（生成器写出的就是这个形态）。
  const SCREENSHOTS = [
    'docs/images/badge-follows-model.gif',
    'docs/images/panel-official-plus-meters.png',
    'docs/images/floating-panel.png',
    'docs/images/cookie-fallback-measured.png',
    'docs/images/state-deepseek-balance.png',
    'docs/images/state-token-plan-credits.png',
    'docs/images/state-no-history.png',
    'docs/images/usage-2d.png',
  'docs/images/usage-range-2d.png',
  'docs/images/usage-month-2d.png',
  'docs/images/usage-official-2d.png',
    'docs/images/usage-3d.png',
    'docs/images/en/badge-follows-model.gif',
    'docs/images/en/panel-official-plus-meters.png',
    'docs/images/en/floating-panel.png',
    'docs/images/en/cookie-fallback-measured.png',
    'docs/images/en/state-deepseek-balance.png',
    'docs/images/en/state-token-plan-credits.png',
    'docs/images/en/usage-2d.png',
  'docs/images/en/usage-range-2d.png',
  'docs/images/en/usage-month-2d.png',
  'docs/images/en/usage-official-2d.png',
    'docs/images/en/usage-3d.png',
  ]
  // 结构图与截图套不同源（由 diagrams/ 的规格产出、中英共用一张），所以它只进**存在性**清单，
  // 不进截图契约：截图集合按 `extractImageTargets`（只认行内图片）核对，而结构图的引用
  // 口径是 `mentionsTarget`（行内 / `<img src>` / 引用式定义 / 本仓库绝对链接都算）。
  // 混进同一份清单会让两种口径互相打脸：谁把结构图改写成 `<img src>` 形态，报错来自截图契约、
  // 指向的还是错的契约——004 的 Lens 1 要消灭的正是这类假红（本轮评审第 2 条，已复现：
  // 对 `<img src="x.png">` 那种写法，`extractImageTargets` 返回空数组）。产出方规则见 AGENTS.md。
  const images = [...SCREENSHOTS, DIAGRAM]
  for (const rel of images) {
    const abs = join(root, rel)
    if (!existsSync(abs)) { problems.push(`${rel} 不存在：README 引了张没有的图`); continue }
    const bytes = statSync(abs).size
    if (bytes < 1024) problems.push(`${rel} 只有 ${bytes} 字节，多半是裁图裁空了`)
  }
  // 占位串留着就说明图没换干净（也防有人把图删了退回占位块还自称通过）。
  if (zh.includes('截图位')) problems.push('README.md 仍留着「截图位」占位块')
  if (en.includes('Screenshots (4 to add before release)')) problems.push('README.en.md 仍留着截图占位块')
  // 两份 README 都得真的引到图，缺一张就是图文不符。**按集合核对，不是"引够 N 张"**：
  // 旧实现只数条数，同一张图引 7 次即过，而"17 张图存在"由上面那份硬编码清单保证——两者从不交汇。
  // 英文套少 state-no-history 是**有意的**：「本实例还没调用过」那句 emptyReason 是写死的中文
  // （lib/index.js），所以它只出现在中文套。
  const requiredImageRefs = {
    'README.md': SCREENSHOTS.filter(rel => !rel.startsWith('docs/images/en/')),
    'README.en.md': SCREENSHOTS.filter(rel => rel.startsWith('docs/images/en/')),
  }
  for (const [name, facts] of imageFacts) {
    if (facts.count === 0) problems.push(`${name} 一张图都没引用`)
    const relativeTargets = new Set()
    for (const { kind, target } of facts.refs) {
      // 与第 4 项同一条规矩、同一份抽取结果（§6 第 6 条）：只有 `relative` 才碰文件系统。
      // 旧写法直接 `join(root, ref)` + existsSync，于是 `![x](../../../../Windows/win.ini)`
      // 也能拿来当"仓库外某个文件是否存在"的神谕（003 的 Lens 2 F2：那次宣称的收口没管到第 10 项）。
      if (kind === 'escape') problems.push(`${name} 引用的图片指向仓库外：${target}`)
      else if (kind === 'backslash') problems.push(`${name} 引用的图片含反斜杠：${target}`)
      else if (kind === 'relative') {
        relativeTargets.add(target)
        if (!existsSync(join(root, target))) problems.push(`${name} 引用的图片不存在：${target}`)
      }
    }
    for (const expected of requiredImageRefs[name]) {
      if (!relativeTargets.has(expected)) problems.push(`${name} 没有引用 ${expected}（截图契约按集合核对：每张图都要被引到）`)
    }
  }
/* 结构图必须**两侧都引到**。上面的集合核对里，架构图只落在中文套的集合里（它不带 en/ 前缀），
 * 英文套漏引是抓不到的——003 把这一类记为已知边界，004 用点名断言收口。
 * 判"引用"用 `mentionsTarget`：归一化相对路径、`<img src>`、引用式定义、绝对 GitHub 链接
 * 都算引用（初版只认行内图片，会把三种无害写法判红——004 的 Lens 1 实测），
 * 代码围栏里的示例与 HTML 注释里的引用不算。行为矩阵常驻 `test/guards.mjs`。 */
const ownRepoPath = repoPathFromUrl(pkg.repository?.url) ?? null
if (ownRepoPath === null) problems.push('package.json#repository.url 里取不到 owner/repo：结构图的绝对链接形态无法核对')
for (const [name, text] of [['README.md', zh], ['README.en.md', en]]) {
  // 第三参数把绝对链接钉到本仓库：任何 host 上串尾相同的图片都算"已引用"是假绿（本轮评审第 4 条）。
  if (!mentionsTarget(text, DIAGRAM, ownRepoPath)) problems.push(`${name} 没有引用 ${DIAGRAM}：结构图必须双语同源`)
}
  try {
    const { makeSnapshot, assertFixture, publicCardKeys } = await import('./shots/fixture.mjs')
    const whitelist = publicCardKeys()
    if (whitelist.length < 30) problems.push(`publicCard() 白名单只读出 ${whitelist.length} 个键，守卫可能失效`)
    for (const variant of ['panel', 'float', 'cookieDrop', 'badgeSwitch', 'triptych']) {
      for (const lang of ['zh', 'en']) assertFixture(makeSnapshot({ variant, lang }), { lang })
    }
  } catch (error) {
    problems.push(`截图合成数据自检失败：${error.message}`)
  }
}

if (problems.length > 0) {
  console.error('check-docs: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-docs: OK（配置键 ${tally.keys}、数据源 ${tally.sources}、出站主机 ${tally.hosts}、`
    + `host ${counts.host} 项 / client ${counts.client} 项 / guards ${counts.guards} 项，中英 README 与代码一致）`)
}
// 跳过的检查要出声，不然"绿"里混着"这条其实没跑"。
for (const notice of notices) console.log(`  note: ${notice}`)
