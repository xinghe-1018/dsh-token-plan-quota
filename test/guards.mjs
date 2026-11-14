/**
 * 门禁自身的行为矩阵（离线，不联网）。
 * 运行：node test/guards.mjs
 *
 * 为什么单独一个文件：`workflow/PLAN.md`（产出方）与 `workflow/REVIEW-CHECKLIST.md`（校验方）
 * 都要求"新增或修改机械检查必须做行为矩阵，并证明它能失败"。矩阵只写在规格文档里会随会话结束
 * 失去约束力，所以这里让三处最容易出错的门禁各带一份**常驻**矩阵：
 *
 *  - `assertFixture()` 的痕迹守卫（`scripts/shots/fixture.mjs`）——它曾因**时钟巧合**假红；
 *  - `findLineRefs()` 的行号引用检测（`scripts/check-refs.mjs`）——靠正则，而正则最容易在
 *    "该认的没认"与"不该认的认了"两端同时出错；这里额外钉住它**不得退化成二次方**；
 *  - `classifyTarget()` / `extractLinkTargets()`（`scripts/link-targets.mjs`）——越界判定含
 *    平台语义（Windows 把 `\` 也当路径分隔符），且"要不要碰文件系统"必须**只由分类决定**。
 *
 * 两类用例都必须在场：**应报**（不报 = 漏检 = 假安全感）与**应放行**（报了 = 假红 = 训练人忽略红灯）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFixture, assertUsageFixture, makeSnapshot, makeUsageSnapshot } from '../scripts/shots/fixture.mjs'
import { findLineRefs } from '../scripts/check-refs.mjs'
import { classifyTarget, extractHtmlTargets, extractImageTargets, extractLinkTargets, mentionsTarget, normalizeTarget } from '../scripts/link-targets.mjs'
import { compareHosts, deriveHostsFromCode } from '../scripts/outbound-hosts.mjs'
import { repoPathFromUrl } from '../scripts/repo-path.mjs'
import { shouldSkipDir, skipDirNames } from '../scripts/walk-skip.mjs'
import { __internals } from '../lib/index.js'
import { assertUsageIndexShape, emptyUsageIndex, loadUsageIndex, saveUsageIndex } from '../lib/usage-stats.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
function ok(label, condition) {
  if (condition) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}`)
  }
}
function rejects(label, fn, expected) {
  try {
    fn()
    failed += 1
    console.log(`FAIL ${label}\n  期望抛错，实际放行`)
  } catch (error) {
    // 任何异常都算"正确拒绝"会把**夹具自己崩了**（TypeError / RangeError）也记成通过——
    // 那是假绿：守卫没生效，用例却绿了。给了 expected 就必须匹配消息；没给时至少驳回
    // 运行时错误这一类"不像守卫在拒绝"的异常。
    const name = String(error?.name ?? '')
    const message = `${name}: ${String(error?.message ?? error)}`
    if (expected !== undefined && !expected.test(String(error?.message ?? ''))) {
      failed += 1
      console.log(`FAIL ${label}\n  抛的错与预期不符（应匹配 ${expected}）：${message}`)
    } else if (expected === undefined && /^(TypeError|RangeError|ReferenceError|SyntaxError)$/.test(name)) {
      failed += 1
      console.log(`FAIL ${label}\n  抛的是 ${name}（不像守卫在拒绝，像夹具自己崩了）：${message}`)
    } else {
      passed += 1
    }
  }
}
function accepts(label, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}\n  期望放行，实际抛错：${error.message}`)
  }
}
const ms = (fn, input) => {
  const t = process.hrtime.bigint()
  fn(input)
  return Number(process.hrtime.bigint() - t) / 1e6
}

/** 固定基准时间：相对时间全靠它，断言就不会随"跑的那一刻"变。 */
const FIXED_NOW = 1_789_000_000_000
/**
 * 实测到的冲突时刻：此刻 `throughput.byProvider[1].lastAt = now - 26_000 = 1789716077943`，
 * 它的十进制写法里恰好含禁用串 `7943`。旧实现把整段 JSON 当字符串找子串，于是**假红**。
 *
 * 归因别写错（003 的 Lens 3 纠正过我一次）：**不是** `updatedAt`/`lastAttemptAt`
 * （`now - 12_000`），那两个在这个 now 上都不含 `7943`。下面有一条自证断言钉住这一点。
 */
const CASE_CLOCK_COINCIDENCE = 1_789_716_103_943
const VARIANTS = ['panel', 'float', 'cookieDrop', 'badgeSwitch', 'triptych']
const LANGS = ['zh', 'en']

/* ---------- 一、fixture 痕迹守卫 ---------- */

// 应放行 1：固定 now 下，全部变体 × 全部语言都必须过。
for (const variant of VARIANTS) {
  for (const lang of LANGS) {
    accepts(`fixture 放行 ${variant}/${lang}`, () => assertFixture(makeSnapshot({ now: FIXED_NOW, variant, lang }), { lang }))
  }
}

// 应放行 2：时钟巧合时刻——这是本文件存在的主要理由，回归它比回归什么都重要。
accepts('fixture 放行时钟巧合时刻（byProvider[1].lastAt 含 7943）',
  () => assertFixture(makeSnapshot({ now: CASE_CLOCK_COINCIDENCE, variant: 'panel', lang: 'zh' })))
// 前提自证：那个时刻的快照 JSON 里**确实**含禁用串，且来源就是那一个字段。
// （只断言"含 7943"会让归因错误被固化——Lens 3 的 M1 就是这么来的。）
{
  const snap = makeSnapshot({ now: CASE_CLOCK_COINCIDENCE, variant: 'panel', lang: 'zh' })
  ok('前提：时钟巧合时刻的快照确实含 7943', JSON.stringify(snap).includes('7943'))
  ok('前提：命中来源是 throughput.byProvider[1].lastAt（now - 26000）',
    String(snap.throughput.byProvider[1].lastAt) === String(CASE_CLOCK_COINCIDENCE - 26_000)
    && String(snap.throughput.byProvider[1].lastAt).includes('7943'))
  ok('前提：now - 12000（updatedAt / lastAttemptAt）在这个时刻并**不**含 7943',
    !String(CASE_CLOCK_COINCIDENCE - 12_000).includes('7943'))
}

// 应报：真实余额写进**卡里**（放在 whitelist 内的键上，以免被别的断言抢先拦下）。
rejects('fixture 拦卡内真实余额 remaining=7943', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.cards[0].remaining = 7943
  assertFixture(snap, { lang: 'zh' })
})
// 应报：真实痕迹出现在任意叶值上（位置无关，守卫是逐值比对）。
for (const trace of ['39.91 CNY', 'OMEN', 'C:\\Users', '.scratch', '2026-09-14']) {
  rejects(`fixture 拦真实痕迹 ${JSON.stringify(trace)}`, () => {
    const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
    snap.probe = trace
    assertFixture(snap, { lang: 'zh' })
  })
}
rejects('fixture 拦数值形态的真实余额 7943', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.probe = 7943
  assertFixture(snap, { lang: 'zh' })
})
// 应报：对象 **key** 里的痕迹。旧实现（整段 JSON 找子串）覆盖 key，逐叶扫描容易把它漏掉——
// 003 的 Lens 2 F7 指出的正是这个收窄。
rejects('fixture 拦对象 key 里的真实痕迹', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.OMEN = 1
  assertFixture(snap, { lang: 'zh' })
})

// 应报：`Date` / `BigInt` —— 逐叶扫描与 `JSON.stringify` **不同构**，这两类最容易溜掉（Lens 1）。
rejects('fixture 拦 Date 对象里的真实日期', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.probe = new Date('2026-09-14T00:00:00Z')
  assertFixture(snap, { lang: 'zh' })
})
rejects('fixture 拦 BigInt 里的真实值', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.probe = 7943n
  assertFixture(snap, { lang: 'zh' })
})
// 应报：≥1e12 但**超出时钟区间**且含禁用串——豁免必须有上界（Lens 1 的"声明比代码宽"）。
rejects('fixture 拦超出时钟区间的巨整数 17943999999999', () => {
  const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
  snap.probe = 17943999999999
  assertFixture(snap, { lang: 'zh' })
})
// 应放行：时钟量级的整数豁免（它们只是"现在几点"，不是痕迹）。
for (const clock of [CASE_CLOCK_COINCIDENCE - 12_000, 7_939_999_999_999]) {
  accepts(`fixture 放行时钟量级整数 ${clock}`, () => {
    const snap = makeSnapshot({ now: FIXED_NOW, variant: 'panel', lang: 'zh' })
    snap.probe = clock
    assertFixture(snap, { lang: 'zh' })
  })
}

/* ---------- 二、行号引用检测 ---------- */

const rejectsRef = (label, text) => ok(label, findLineRefs(text).length > 0)
const acceptsRef = (label, text) => ok(label, findLineRefs(text).length === 0)

// 应报：四种真实出现过的写法。
rejectsRef('行号 报 文件:行号（相对路径）', '见 lib/index.js:44')
rejectsRef('行号 报 文件:行号（Markdown）', 'README.md:239')
rejectsRef('行号 报 文件:行号（带范围）', 'lib/index.js:368-376')
rejectsRef('行号 报 反引号裸续写', '`lib/index.js:44` 与 `:1189`')

// 应放行：这些是最容易误报的形态。
acceptsRef('行号 放行 代码围栏内的引用（那是命令输出/复现记录）', '```\n见 scripts/check-docs.mjs:222\n```')
acceptsRef('行号 放行 不带行号的文件名', '见 lib/index.js 的 autoDetect')
acceptsRef('行号 放行 项目条目编号', 'README 的第 1–9 项会核')
acceptsRef('行号 放行 带端口的 URL', '面板在 http://127.0.0.1:3080 上')
acceptsRef('行号 放行 时间与比例', '9:00 开始，比例 1:2')
acceptsRef('行号 放行 纯锚点引用', '见 plan.md 的「## 2. 阶段②」一节')

// 应报：检测器自身不能静默失效——围栏剥掉之后，围栏之外的那条仍要认出来。
ok('行号 围栏外的引用不被围栏豁免连带吞掉',
  findLineRefs('```\nlegend\n```\n见 lib/index.js:44\n').length === 1)

// 围栏：`~~~` 也算围栏（合法 CommonMark），且**不受正文里游离三反引号的奇偶影响**（Lens 1 的 HIGH）。
acceptsRef('行号 放行 ~~~ 围栏内的引用', '~~~\n见 lib/index.js:44\n~~~\n')
{
  const text = '正文提到 ``` 一次（不构成围栏）。\n见 ROADMAP.md:12\n\n```text\n见 lib/index.js:44\n```\n'
  const hits = findLineRefs(text).map(h => h.match)
  ok('行号 围栏奇偶：散文里的引用照报', hits.includes('ROADMAP.md:12'))
  ok('行号 围栏奇偶：围栏内的示例照放行', !hits.includes('lib/index.js:44'))
}
// 认的形态：扩展名表要够宽，且 GitHub permalink 的 `#L` 行锚同样是会腐烂的引用。
rejectsRef('行号 报 扩展名表里的 .ts', '见 lib/index.ts:44')
rejectsRef('行号 报 GitHub permalink 的行锚', '见 lib/index.js#L44')
acceptsRef('行号 放行 裸 #L44（没有文件部分）', '见 #L44')
acceptsRef('行号 放行 无扩展名文件 LICENSE:5（不在范围内：加它会与 9:00 撞车）', 'LICENSE:5')

/* ---------- 三、链接目标的抽取与分类 ---------- */

const kind = raw => classifyTarget(raw).kind
// 应放行：对外链接 / 协议相对 / 片段 —— 一律不探测文件系统。
ok('分类 跳过 对外 URL', kind('https://example.com/x') === 'skip')
ok('分类 跳过 协议相对（合法对外写法，不得假红）', kind('//example.com/x') === 'skip')
ok('分类 跳过 纯片段', kind('#section') === 'skip')
ok('分类 跳过 mailto', kind('mailto:a@b.c') === 'skip')
// 应报成 escape：任何会走到仓库之外的形态。
ok('分类 仓库外 上级目录', kind('../x') === 'escape')
ok('分类 仓库外 裸 `..`（旧实现漏判，Lens 2 F1）', kind('..') === 'escape')
ok('分类 仓库外 `a/../..` 归一后是 `..`', kind('a/../..') === 'escape')
ok('分类 仓库外 绝对路径', kind('/abs/path') === 'escape')
// 第五轮审查（link-targets）三条：盘符被当成协议→skip；单引号/括号 title 没剥→假红；
// 引用式定义没有行尾锚→正文里的 [TODO]: finish 造出假目标。
ok('分类 Windows 盘符绝对路径判越界（不被当成协议 skip）', kind('C:\\Users\\me\\x.md') === 'escape')
ok('分类斜杠形态的盘符同理', kind('D:/x/y.md') === 'escape')
ok('归一化剥掉单引号 title', normalizeTarget(`docs/a.md 't'`) === 'docs/a.md')
ok('归一化剥掉括号 title', normalizeTarget('docs/a.md (t)') === 'docs/a.md')
ok('引用式定义不把下一行的词当目标（空定义）', extractLinkTargets('[1]:\n下一行的词').length === 0)
ok('正文里以方括号开头的句子不造出假目标', extractLinkTargets('[TODO]: finish this section').length === 0)
ok('正常引用式定义仍然被抽出', extractLinkTargets('![x][r]\n[r]: docs/images/architecture.png').includes('docs/images/architecture.png'))
ok('分类 反斜杠 一律非法（平台无关，Lens 2 F1/F6）', kind('..\\..\\..\\Windows\\win.ini') === 'backslash')
// 应放行成 relative：仓库内相对路径。
ok('分类 仓库内 相对路径', kind('docs/x.md') === 'relative')
ok('分类 仓库内 `a/../b.md` 仍在仓库内', kind('a/../b.md') === 'relative')

// 不变式：**只有** relative 才允许调用方去 existsSync。所以只要判成 relative，
// 它的归一化结果就必须确实留在仓库内（不含 `..`、不以 `/` 开头、不含反斜杠）。
for (const raw of ['..', '../x', 'a/../..', '/x', '//h/x', '..\\..\\w', 'a\\b', './a', 'a/b', 'a/../../b', '%2e%2e/x', '', '#f', 'h://x', 'docs/../ROADMAP.md']) {
  const { kind: k, target } = classifyTarget(raw)
  if (k !== 'relative') continue
  ok(`不变式 relative 必须留在仓库内：${JSON.stringify(raw)} -> ${JSON.stringify(target)}`,
    !target.startsWith('/') && !target.includes('\\') && !normalizeTarget(target).split('/').includes('..'))
}

// 抽取：四种写法一个都不能漏，示例一个都不能误认。
ok('抽取 内联', extractLinkTargets('[x](a.md)').includes('a.md'))
ok('抽取 带 title（原样保留，交给 normalizeTarget 剥）', extractLinkTargets('[x](a.md "t")').includes('a.md "t"'))
ok('抽取 引用式', extractLinkTargets('[x][r]\n[r]: a.md').includes('a.md'))
ok('抽取 HTML', extractLinkTargets('<a href="a.md">x</a>').includes('a.md'))
ok('抽取 图片', extractLinkTargets('![x](a.png)').includes('a.png'))
ok('抽取 徽标式：取到外层 URL，且不把内层图片当目标丢掉',
  JSON.stringify(extractLinkTargets('[![alt](i.png)](url)')) === JSON.stringify(['i.png', 'url']))
ok('抽取 围栏内的示例不认', extractLinkTargets('```\n[x](a.md)\n```').length === 0)
ok('抽取 行内代码里的示例不认', extractLinkTargets('`[x](a.md)`').length === 0)
ok('图片只取图片', JSON.stringify(extractImageTargets('[x](a.md) ![y](b.png)')) === JSON.stringify(['b.png']))
// 链接文字含方括号：旧第 4 项认得，把 label 字符类收窄会把它弄丢（Lens 1 实测的**收窄**）。
ok('抽取 链接文字含方括号', extractLinkTargets('[see note [1]](docs/a.md)').includes('docs/a.md'))
ok('抽取 图片文字含方括号', extractImageTargets('![shot [1]](docs/a.png)').includes('docs/a.png'))
// 引用式定义允许最多 3 个前导空格（CommonMark 的列表缩进形态）。
ok('抽取 缩进的引用式定义', extractLinkTargets('  [r]: docs/a.md').includes('docs/a.md'))
// 散文里偶然出现的 `](` 不算链接（左侧同一行内没有 `[`）。
ok('抽取 散文中孤立 ]( 不算链接', extractLinkTargets('随手写 ](x) 这种').length === 0)

/* ---------- 四之二、mentionsTarget：判"是否真的引用了某个仓内目标" ---------- */

// 为什么要有这一组：第 10 项的结构图断言用它。初版断言只扫行内 markdown 图片，于是
// `<img src>`、引用式定义、绝对 GitHub 链接三种**无害写法**被判红（004 的 Lens 1 端到端实测：
// 临时副本 `exit 0→1`，而 main 上全绿）。假红比没有检查更坏——它训练人忽略红灯，
// 所以"应当放行"的这一半跟"应当报"的那一半一样重要。
const DIAGRAM = 'docs/images/architecture.png'
// owner/repo 只有一个来源：package.json#repository.url（同 repo-path.mjs 的立场——各处再写一份，
// 仓库改名后这两组用例测的是个已不存在的'本仓库'，而门禁不会提醒）。
const OWN = repoPathFromUrl(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).repository?.url)
if (typeof OWN !== 'string') { failed += 1; console.log(`FAIL 派生不出 owner/repo，远端形态的用例失去落点`) }
const mentionsDiagram = (text, own = OWN) => mentionsTarget(text, DIAGRAM, own ?? null)
ok('引用 内联图片', mentionsDiagram('![x](docs/images/architecture.png)'))
ok('引用 带 title', mentionsDiagram('![x](docs/images/architecture.png "t")'))
ok('引用 ./ 前缀', mentionsDiagram('![x](./docs/images/architecture.png)'))
ok('引用 尖括号包裹', mentionsDiagram('![x](<docs/images/architecture.png>)'))
ok('引用 引用式定义', mentionsDiagram('![x][r]\n[r]: docs/images/architecture.png'))
ok('引用 HTML img[src]（`extractLinkTargets` 现在同时收 href 与 src，两种口径共用一条实现）',
  mentionsDiagram('<img src="docs/images/architecture.png" alt="x">'))
ok('引用 HTML a[href]', mentionsDiagram('<a href="docs/images/architecture.png">x</a>'))
ok('引用 本仓库绝对 GitHub 链接（blob 形态）', mentionsDiagram('![x](https://github.com/' + OWN + '/blob/main/docs/images/architecture.png)'))
ok('引用 本仓库 raw 形态带 query 也算', mentionsDiagram('![x](https://github.com/' + OWN + '/raw/main/docs/images/architecture.png?raw=true)'))
ok('引用 围栏里的示例不算', mentionsDiagram('```\n![x](docs/images/architecture.png)\n```') === false)
ok('引用 HTML 注释里的不算（004 的 Lens 1 实测过这条绕过）',
  mentionsDiagram('<!-- ![x](docs/images/architecture.png) -->') === false)
ok('引用 别的文件名不算', mentionsDiagram('![x](docs/images/architecture-old.png)') === false)
ok('引用 正文提到路径但没有链接语法不算', mentionsDiagram('见 docs/images/architecture.png 这张图') === false)
ok('引用 远端同尾不同路径不算', mentionsDiagram('![x](https://example.com/docs/images/other.png)') === false)
// 本轮评审第 3/4/5 条补的用例：假绿比假红更坏，两种都要有反例钉住。
ok('引用 别家仓库的同尾路径不算（钉到本仓库 owner/repo，否则任意远端都能让断言变绿）',
  mentionsDiagram("![x](https://github.com/anyone/else/blob/main/docs/images/architecture.png)") === false)
ok('引用 不给 owner/repo 时远端形态一律不算（默认参数就是 null：不给就不认）',
  mentionsDiagram('![x](https://github.com/' + OWN + '/blob/main/docs/images/architecture.png)', null) === false)
// host 不同的另一条远端形态：raw.githubusercontent.com 走同一个 pathname 判定。
ok('引用 本仓库 raw host 形态也算',
  mentionsDiagram('![x](https://raw.githubusercontent.com/' + OWN + '/main/docs/images/architecture.png)'))
// 单引号、等号两侧空白、大写属性名都是合法 HTML：只认双引号小写就是第四种假红（004 的 Lens 1 只收了前三）。
const srcSingle = "<img src='docs/images/architecture.png' alt='x'>"
ok('引用 单引号 src 形态算（第四种无害写法，004 的 Lens 1 没收这条）', mentionsDiagram(srcSingle))
ok('引用 大写 SRC 属性名算', mentionsDiagram('<IMG SRC="docs/images/architecture.png">'))
ok('引用 等号两侧有空白的 src 算', mentionsDiagram('<img src  =  "docs/images/architecture.png">'))
ok('引用 裸值（不带引号）src 算——抽取器自称认三种引号形态，裸值这一种原本没人钉',
  mentionsDiagram('<img src=docs/images/architecture.png>'))
ok('src= 已进 extractLinkTargets（越界与存在性检查因此也看得见这种形态）',
  extractLinkTargets('<img src="docs/images/architecture.png">').includes('docs/images/architecture.png'))
const srcEscape = extractLinkTargets('<img src="../../outside/x.png">')
ok('src= 写成仓库外路径时，走完整链（抽取 → 分类）被抓',

  srcEscape.length > 0 && classifyTarget(srcEscape[0]).kind === 'escape')

// §6 第 1/2/3 条：HTML 属性有界、注释不拼接、远端形态钉到本仓库且整段对上。
ok('HTML 抽取不返回跨行目标（未配对引号不吞文档）', (() => {
  const s = '这里有一个未配对的引号 \" 后面是很多文字\n第二行也有引号 \" 结束\n<img src=\"docs/x.png\">'
  return extractHtmlTargets(s).every(v => !v.includes('\n'))
})())
ok('散文里的 href= 不算引用（必须在开标签的属性串里）', extractLinkTargets('文档里提到 href=\"../../outside/x.png\" 这种写法').length === 0)
ok('注释两侧不会被拼成不存在的引用（§6 第 2 条）', mentionsTarget('![x]<!-- 注释 -->(docs/images/architecture.png)', DIAGRAM, OWN) === false)
ok('远端更深一层的同尾路径不算（endsWith 太松）', mentionsDiagram('![x](https://github.com/' + OWN + '/blob/main/backup/docs/images/architecture.png)') === false)
ok('非 GitHub 的同尾路径不算（任意 CDN 都放行是假绿）', mentionsDiagram('![x](https://cdn.example.com/' + OWN + '/blob/main/docs/images/architecture.png)') === false)
ok('owner/repo 大小写不同仍算（GitHub 上大小写不敏感）',
  mentionsDiagram('![x](https://github.com/Xinghe-1018/Dsh-Token-Plan-Quota/blob/main/docs/images/architecture.png)'))
ok('远端链接的百分号编码要解码后再比（中文图名不许假红）',
  mentionsTarget('![x](https://github.com/' + OWN + '/blob/main/docs/%E6%9E%B6%E6%9E%84.png)', 'docs/架构.png', OWN))
// 过度匹配的反例：属性名前面必须是空白或 < 。`\b` 在连字符后也成立，所以旧写法会把
// `<img data-src="…">`（懒加载标记）当成 src：凭空造出一个待检查目标，
// 而一张根本不渲染的占位图就能把'两侧引同一张图'喂绿。
ok('引用 `data-src` 这类同名后缀属性不算', mentionsDiagram('<img data-src="docs/images/architecture.png">') === false)
ok('src 前面是字母也不算（xsrc= 形态）', extractLinkTargets('<img xsrc="docs/images/architecture.png">').length === 0)

/* ---------- 五、入口判定不得静默失效 ---------- */

// 为什么要有这一组：`check-refs.mjs` 的 `main()` 靠"是不是入口"决定跑不跑。早先的实现直接比
// `resolve(process.argv[1])` 与 `import.meta.url` 的字符串，而 Node 的 ESM 加载器把入口解析成
// **realpath**——工作目录是 junction / symlink 时两者不等，`main()` 被静默跳过：**无输出、退出码 0**，
// 于是 `npm run check`、pre-commit、CI 全绿而门禁一次都没跑（评审 Lens 1 的 HIGH，用 junction 实测复现）。
// 现在改比 realpath。这里至少钉住"直接运行必须有输出"——那一类失败的表现就是**什么都没有**。
{
  let out = ''
  let status = 0
  try {
    out = execFileSync(process.execPath, ['scripts/check-refs.mjs'], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    // 门禁报红是合法结果，但**必须有输出**。注意它把违规写到 **stderr**（`console.error`），
    // 所以两边都要收——只收 stdout 会让这条用例在"门禁正在报红"时假失败。
    out = String(error.stdout ?? '') + String(error.stderr ?? '')
    status = error.status ?? 1
  }
  ok(`check-refs.mjs 直接运行会输出东西（status=${status}）`, out.includes('check-refs:'))
}

/* ---------- 四、不得退化成二次方 ---------- */

// 003 的 Lens 2 实测：修之前 `'a.' × 40000` 在 findLineRefs 上要 7.8 s、`'![' × 40000` 在
// extractLinkTargets 上要 10.9 s（Θ(n²)）。门禁挂在 pre-commit 上，所以"文档内容能拖死检查"
// 本身就是缺陷。这里用很松的 1000 ms 上限（修好后实测 ~0 ms，余量约三个数量级）钉住它，
// 避免 CI 负载波动造成假红。
for (const [label, unit] of [['点号串', 'a.'], ['连续 ![', '!['], ['连续 [', '[']]) {
  const input = unit.repeat(40_000)   // 约 80 KB
  const refsMs = ms(findLineRefs, input)
  const linksMs = ms(extractLinkTargets, input)
  ok(`线性 findLineRefs（${label} 80 KB）< 1000 ms，实测 ${refsMs.toFixed(1)} ms`, refsMs < 1000)
  ok(`线性 extractLinkTargets（${label} 80 KB）< 1000 ms，实测 ${linksMs.toFixed(1)} ms`, linksMs < 1000)
}

/* ---------- 六、出站主机的推导与双向比对（宪法 V） ---------- */

// 为什么要有这一组：原实现只从预设的 `url`/`infoUrl`/`regions` 抠主机，而且**只做单向**检查。
// 两个洞都实测到了：阿里云 BSS 的主机是 `DEFAULTS.endpoint` 的裸主机名（请求时才拼 https，
// 抠不出来）；字体 CDN 那行是扫 README 文本，而那份文本里根本没有该 URL —— 恒不命中，是死代码。
// 这里把"该推导出来的能推导出来"（含防假红：注释里的 URL 不算）与"两个方向都能报"一起钉住。
{
  const presets = {
    'normal-source': { url: 'https://api.example.com/v1/balance' },
    'region-source': { regions: { cn: { url: 'https://cn.example.cn/x' }, intl: { url: 'https://intl.example.ai/x' } } },
    'info-source': { infoUrl: 'https://info.example.com/tool/user/info.json' },
    'endpoint-source': { builder: 'rpc' },
  }
  const clientSource = [
    '// 注释里的示例 URL 不算出站：https://comment.example.com/never.css',
    'const FONT_CSS = [',
    '  "https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5/index.css",',
    '];',
  ].join('\n')
  const derived = deriveHostsFromCode({ presets, defaults: { endpoint: 'business.aliyuncs.com' }, clientSource })
  ok('主机推导：预设 url', derived.has('https://api.example.com'))
  ok('主机推导：多区 regions', derived.has('https://cn.example.cn') && derived.has('https://intl.example.ai'))
  ok('主机推导：infoUrl', derived.has('https://info.example.com'))
  ok('主机推导：裸主机 endpoint（旧实现抠不出来的那类）', derived.has('https://business.aliyuncs.com'))
  ok('主机推导：客户端 FONT_CSS 的 CDN 主机', derived.has('https://cdn.jsdelivr.net'))
  ok(`主机推导：注释里的 URL 不算出站（且总数正好 ${derived.size}=6）`,
    !derived.has('https://comment.example.com') && derived.size === 6)

  // 归一化（CR PR #3 的 #4/#8）：大小写、默认端口、userinfo 都指向同一条声明，
  // 拿原文比会把它们判成"未声明的另一台主机"——那是假红，比漏检更坏。
  const normalized = deriveHostsFromCode({
    presets: {
      upper: { url: 'https://API.Example.com/x' },
      ported: { url: 'https://api.example.com:443/y' },
      userinfo: { url: 'https://user:pw@api.example.com/z' },
    },
    clientSource: '',
  })
  ok(`主机推导：大小写/默认端口/userinfo 归纳到同一条 origin（得到 ${[...normalized].join(',')}）`,
    normalized.size === 1 && normalized.has('https://api.example.com'))

  // owner/repo 抽取（CR PR #3 的 #7）：点号要留着——`plugin.v2.git` 只该剥末尾的 `.git`。
  ok('repoPathFromUrl：https + .git', repoPathFromUrl('git+https://github.com/owner/plugin.v2.git') === 'owner/plugin.v2')
  ok('repoPathFromUrl：ssh 形态', repoPathFromUrl('git@github.com:owner/repo.git') === 'owner/repo')
  ok('repoPathFromUrl：无 .git 且带尾斜杠', repoPathFromUrl('https://github.com/owner/repo/') === 'owner/repo')
  ok('repoPathFromUrl：非 github 一律 undefined（不猜）', repoPathFromUrl('https://gitlab.com/owner/repo.git') === undefined)

  const full = compareHosts(derived, new Set([...derived]))
  ok('主机比对：一一对应时两边都空', full.undeclared.length === 0 && full.unused.length === 0)
  const missingDecl = compareHosts(derived, new Set([...derived].filter(host => host !== 'https://cdn.jsdelivr.net')))
  ok('主机比对：代码里有而未声明会被抓到',
    missingDecl.undeclared.includes('https://cdn.jsdelivr.net') && missingDecl.unused.length === 0)
  const staleDecl = compareHosts(derived, new Set([...derived, 'https://old.example.com']))
  ok('主机比对：声明里有而代码里没有也会被抓到（旧实现完全看不到这一半）',
    staleDecl.unused.includes('https://old.example.com') && staleDecl.undeclared.length === 0)

  // 真数据自检：当前仓库的声明必须与代码推导逐项相等（这条与 check-docs 第 3 项同源，
  // 但在这里失败时能立刻看出是"少了谁 / 多了谁"）。
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const realDeclared = new Set(pkg.dshhub.permissions.network.map(entry => entry.replace(/\/+$/, '')))
  const realDerived = deriveHostsFromCode({
    presets: __internals.PRESETS,
    defaults: __internals.DEFAULTS,
    clientSource: readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
  })
  const realDiff = compareHosts(realDerived, realDeclared)
  const realMessage = `主机真数据：声明 ${realDeclared.size} 个与代码推导逐项相等（少声明 ${realDiff.undeclared.join(',') || '无'}；多声明 ${realDiff.unused.join(',') || '无'}）`
  ok(realMessage, realDiff.undeclared.length === 0 && realDiff.unused.length === 0)
  // 代码侧真值与 package.json 的声明必须逐项相等：两份都在是有意的（运行时用前者在发请求前
  // 拒绝未声明主机，审计用后者），但两份就一定会漂，所以这里机械核一遍。
  const codeDeclared = new Set(__internals.DECLARED_HOSTS)
  const mismatched = [...realDeclared].filter(host => !codeDeclared.has(host)).concat([...codeDeclared].filter(host => !realDeclared.has(host)))
  ok(`DECLARED_HOSTS 与 package.json#permissions.network 逐项相等（不一致项：${mismatched.join(',') || '无'}）`,
    codeDeclared.size === realDeclared.size && mismatched.length === 0)
}

/* release 流水线的 push 形状：main 与 tag 必须同一次 push 落地。
 * 动机是 0.4.12 那次实发（ci#51 假红）——拆成两条推就等于给 CI 留一个看不到 tag 的窗口，
 * 而窗口只在发版当下存在，人工重跑永远是绿的，所以钉在源码形状上（与宪法 V「宣称与实际一致」同理）。 */
{
  const releaseSrc = readFileSync(join(ROOT, 'scripts', 'release.mjs'), 'utf8')
  ok('release 用一次 push 同时更新 main 与 tag，且带 --atomic（三条断言钉的分别是：合并形态、不再单独推 tag、失败提示不教两步 push）',
    releaseSrc.includes("git('push', '--atomic', 'origin', 'HEAD:main', `v${target}`)"))
  // 反向那半不能被正向覆盖掉：单独推 tag 这一行如果回来，ci#51 的窗口就回来了。
  ok('release 不再单独推 tag（两条 push 之间就是 CI 看不到 tag 的窗口）', !releaseSrc.includes("git('push', 'origin', `v${target}`)"))
  ok('release 不再单独推 main（两个 ref 必须同一事务）', !releaseSrc.includes("git('push', 'origin', 'HEAD:main')"))
  // 提示行才是人在压力下照抄的那一条：本轮修的就是它教了两步 push，而上面三条只看 git() 调用，
  // 提示被改回去时全绿（宪法 V：宣称与实际一致）。
  ok('release 的失败提示不再教两步 push（提示才是人在压力下照抄的那一条；正向只查 git() 调用时，提示被改回去仍全绿）',
    /console\.error\('（修好后重跑本脚本[^\n]*git push --atomic origin HEAD:main/.test(releaseSrc)
      && !/git push origin main && git push origin/.test(releaseSrc))
}

/* 门禁的扫描面只有一份跳过集合。0.4.12 对齐发布线时只改了 check-refs 那半，编码护栏仍带着
 * 自己的清单跑，于是同一句「扫描面不含 IDE 缓存」在两份代码里一半真一半假（Open Code Review
 * 第一条发现，实核：旧清单会枚举进 57 份 .qoder 生成文档）。与「换算只有一处」同理，钉在源码上。 */
{
  const docsSrc = readFileSync(join(ROOT, 'scripts', 'check-docs.mjs'), 'utf8')
  const refsSrc = readFileSync(join(ROOT, 'scripts', 'check-refs.mjs'), 'utf8')
  ok('check-docs 与 check-refs 都从 walk-skip.mjs 取跳过集合',
    /from '.\/walk-skip.mjs'/.test(docsSrc) && /from '.\/walk-skip.mjs'/.test(refsSrc))
  ok('两份门禁不再各自持有 SKIP_DIRS 字面量（各写一份必然漂）',
    !/const SKIP_DIRS = new Set\(/.test(docsSrc) && !/const SKIP_DIRS = new Set\(/.test(refsSrc))
  ok('跳过集合覆盖 IDE、草稿与可重生成缓存（.scratch 也在 .gitignore 里，草稿里的 file:line 不该把活文档门禁判红）',
    shouldSkipDir('.qoder') && shouldSkipDir('.dsh') && shouldSkipDir('.shots-work') && shouldSkipDir('.scratch') && shouldSkipDir('.git'))
  ok('导出的是判定函数而不是活的 Set（消费者 add/delete 会改掉另一道门禁的面）', Object.isFrozen(skipDirNames))
  // 第五轮 A3：.gitignore 里的目录条目与跳过集合必须同涨同落。否则「只改 .gitignore 的人」
  // 不会让任何东西变红，而下一份 IDE 缓存又会像 0.4.12 那样被读进门禁。
  const giDirs = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line.endsWith('/') && !line.startsWith('#'))
    .map(line => line.slice(0, -1))
  const notSkipped = giDirs.filter(name => !shouldSkipDir(name))
  ok('gitignore 里每个目录条目都在跳过集合内（不一致：' + (notSkipped.join(',') || '无') + '）', notSkipped.length === 0)
  const notIgnored = skipDirNames.filter(name => name !== '.git' && !giDirs.includes(name))
  ok('跳过集合不含 gitignore 之外的目录（那会跳掉已跟踪的活文档，比漏跳更坏；不一致：' + (notIgnored.join(',') || '无') + '）', notIgnored.length === 0)
}

/* 发布手册与发布脚本必须说同一件事。0.4.12 的 ci#51 之后脚本改成一次 --atomic push，
 * 但 RELEASE.md 的流水线图与「一句话版」还留着两步 push（甚至留着本机 npm publish）——
 * 人在压力下照抄的是文档，而上一轮的反向断言只扫 scripts/release.mjs，文档漂回去全绿
 * （第三/四两轮审查各报了一次，宪法 V：宣称的覆盖面 = 实际覆盖面）。 */
{
  const releaseDoc = readFileSync(join(ROOT, 'RELEASE.md'), 'utf8')
  ok('RELEASE.md 不再教两步 push（提交与 tag 必须同一次事务）',
    !/git push origin main && git push origin v/.test(releaseDoc) && !/git push origin main --follow-tags/.test(releaseDoc))
  ok('RELEASE.md 的推送写法与脚本一致（带 --atomic 且用 HEAD:main）', /git push --atomic origin HEAD:main v/.test(releaseDoc))
  ok('RELEASE.md 不再叫人在本机 npm publish（身份在 CI 那台机器上）', !/^npm login && npm publish/m.test(releaseDoc))
}

/* 006 用量统计：索引 schema 白名单 + 「不派生百分比 / 不折算 Credits」的静态矩阵。
 * 为什么钉在门禁而不是只在 host 测试：schema 是**落盘契约**，多一个键就可能把会话内容写进索引文件；
 * 百分比与 Credits 是宪法原则 I 的展示口径，改坏时功能测试往往全绿（页面里只是多印了个数字）。 */
{
  const usageSrc = readFileSync(join(ROOT, 'lib', 'usage-stats.js'), 'utf8')
  const indexSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

  // 被扫的段落必须真的存在：否则下面所有断言都在扫一段空字符串（门禁自身的假绿形态）。
  const usageStart = indexSrc.indexOf('/* ==================================================== 用量索引（006）')
  // 008 段插在 006 与 008 之间：先在自己的段界上收口，否则 008 的文案会带着 006 的禁词矩阵一起红/绿。
  const usageEnd = indexSrc.indexOf('/* ==================================================== 官方账号侧用量（008）')
  ok('用量统计段在 lib/index.js 里存在且可定位', usageStart > 0 && usageEnd > usageStart)
  const usageRegion = indexSrc.slice(usageStart, usageEnd)
  ok('用量统计段被完整扫到（字符数 > 4000）', usageRegion.length > 4000)

  // 1) schema 白名单：应放行的形态（空索引 / 完整索引）
  accepts('用量索引 schema：空索引放行', () => assertUsageIndexShape(emptyUsageIndex()))
  const filled = emptyUsageIndex()
  filled.updatedAt = FIXED_NOW
  filled.sessions['sess-1'] = { revision: 'dev:1:2:3:4', lastSeq: 41, cut: 0 }
  filled.days['2026-11-12'] = {
    input: 120, output: 30, cacheRead: 10, cacheWrite: 0, calls: 3,
    models: { 'qwen-token-plan-cn/qwen3.8-flash': { input: 120, output: 30, cacheRead: 10, cacheWrite: 0, calls: 3 } },
  }
  filled.stats.unknownModel = 1
  filled.stats.skippedOld = 2
  accepts('用量索引 schema：完整索引放行', () => assertUsageIndexShape(filled))

  // 2) 应报：每个可能夹带内容的层都钉一条（顶层 / 会话 / 日桶 / 模型 / 统计）
  const withTop = structuredClone(filled)
  withTop.notes = 'SECRET-TEXT'
  rejects('用量索引 schema：顶层多余键报错', () => assertUsageIndexShape(withTop), /白名单外的键 notes/)
  const withSession = structuredClone(filled)
  withSession.sessions['sess-1'].headers = { cookie: 'SECRET-TEXT' }
  rejects('用量索引 schema：会话里夹带请求头报错', () => assertUsageIndexShape(withSession), /白名单外的键 headers/)
  const withDay = structuredClone(filled)
  withDay.days['2026-11-12'].message = 'SECRET-TEXT'
  rejects('用量索引 schema：日桶里夹带消息文本报错', () => assertUsageIndexShape(withDay), /白名单外的键 message/)
  const withModel = structuredClone(filled)
  withModel.days['2026-11-12'].models['qwen-token-plan-cn/qwen3.8-flash'].text = 'SECRET-TEXT'
  rejects('用量索引 schema：模型计数器里夹带文本报错', () => assertUsageIndexShape(withModel), /白名单外的键 text/)
  const withStats = structuredClone(filled)
  withStats.stats.cookies = 'SECRET-TEXT'
  rejects('用量索引 schema：stats 里夹带 Cookie 报错', () => assertUsageIndexShape(withStats), /白名单外的键 cookies/)
  const wrongVersion = structuredClone(filled)
  wrongVersion.version = 2
  rejects('用量索引 schema：version 不是 1 报错（不猜未来 schema）', () => assertUsageIndexShape(wrongVersion), /version 不是 1/)
  rejects('用量索引 schema：不是对象报错', () => assertUsageIndexShape('SECRET-TEXT'), /不是对象/)
  const badCounter = structuredClone(filled)
  badCounter.days['2026-11-12'].input = Number.NaN
  rejects('用量索引 schema：计数不是有限非负数报错', () => assertUsageIndexShape(badCounter), /不是有限非负数/)
  const badRevision = structuredClone(filled)
  badRevision.sessions['sess-1'].revision = 42
  rejects('用量索引 schema：revision 不是字符串报错', () => assertUsageIndexShape(badRevision), /revision 不是字符串/)
  const emptyId = structuredClone(filled)
  emptyId.sessions[''] = { revision: 'x', lastSeq: 0, cut: 0 }
  rejects('用量索引 schema：空会话 id 报错', () => assertUsageIndexShape(emptyId), /空 id/)

  // 3) 写盘闸：坏索引不许落地（否则白名单只在读的时候生效，写的时候已经把脏数据带出去了）
  const sandbox = mkdtempSync(join(tmpdir(), 'quota-index-guard-'))
  try {
    const cleanPath = join(sandbox, 'clean.json')
    accepts('用量索引写盘：干净索引放行', () => saveUsageIndex(cleanPath, filled))
    ok('用量索引写盘：干净索引确实落盘', existsSync(cleanPath))
    const dirtyPath = join(sandbox, 'dirty.json')
    const dirty = structuredClone(filled)
    dirty.days['2026-11-12'].message = 'SECRET-TEXT'
    rejects('用量索引写盘：白名单外的索引拒绝写盘', () => saveUsageIndex(dirtyPath, dirty), /白名单外的键 message/)
    ok('用量索引写盘：被拒时不留下文件（也不留 .tmp）',
      !existsSync(dirtyPath) && readdirSync(sandbox).every(name => !name.includes('.tmp-')))

    // 4) 读盘闸：schema 污染的文件备份重建，内容不进内存
    const pollutedPath = join(sandbox, 'polluted.json')
    const polluted = structuredClone(filled)
    polluted.notes = 'SECRET-TEXT'
    writeFileSync(pollutedPath, JSON.stringify(polluted), 'utf8')
    const rebuilt = loadUsageIndex(pollutedPath)
    ok('用量索引读盘：schema 污染 → 备份重建为空索引', Object.keys(rebuilt.days).length === 0 && rebuilt.updatedAt === 0)
    ok('用量索引读盘：备份文件名带 .bad-', readdirSync(sandbox).some(name => name.startsWith('polluted.json.bad-')))
    ok('用量索引读盘：污染内容没进内存', !JSON.stringify(rebuilt).includes('SECRET-TEXT'))

    const brokenPath = join(sandbox, 'broken.json')
    writeFileSync(brokenPath, '{ not json', 'utf8')
    const broken = loadUsageIndex(brokenPath)
    ok('用量索引读盘：坏 JSON → 备份重建为空索引',
      Object.keys(broken.days).length === 0 && readdirSync(sandbox).some(name => name.startsWith('broken.json.bad-')))
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }

  // 5) 展示口径：不派生百分比、不折算 Credits（宪法原则 I）——只在代码里查，
  //    usage-stats.js 的取模运算不是百分比，判据是 % 后面必须紧跟数字。
  const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const codeOnly = stripComments(usageSrc)
  const percents = [...codeOnly.matchAll(/.{0,24}%.{0,24}/g)].map(match => match[0].trim())
  ok('用量索引模块：百分号只出现在取模里（不派生百分比；命中：' + (percents.join(' | ') || '无') + '）',
    percents.length > 0 && percents.every(snippet => /%\s*\d/.test(snippet)))
  ok('用量索引模块：不出现 Credits / credit 字样（注释除外）', !/credit/i.test(codeOnly))
  ok('用量统计段：不出现百分比与 Credits', !/[%]/.test(usageRegion) && !/credit/i.test(usageRegion) && !/percent/i.test(usageRegion))
  ok('用量统计段：不联网（无 fetch / http(s) URL）', !/fetch\(|https?:\/\//.test(usageRegion))
  ok('用量索引模块：不联网（无 fetch / http(s) URL）', !/fetch\(|https?:\/\//.test(codeOnly))
  ok('用量索引模块：不读凭据（无 credentials / apiKey / cookie）', !/credential|apiKey|api_key|cookie/i.test(codeOnly))

  // 6) 配置三键与接线形状（与 INTERFACE §2 同源；默认值漂了会静默改变保留天数与文件位置）
  ok('DEFAULTS：usageStats 默认 true', __internals.DEFAULTS.usageStats === true)
  ok('DEFAULTS：usageIndexPath 指向 $DSH_HOME 下的索引文件',
    __internals.DEFAULTS.usageIndexPath === '$DSH_HOME/token-plan-quota.usage-index.json')
  ok('DEFAULTS：usageBackfillDays 默认 365（= 保留天数 = 天数选择上界）', __internals.DEFAULTS.usageBackfillDays === 365)
  ok('用量统计段：快照构建在段内，路由分支在路由段（两处都在 index.js 里）',
    usageRegion.includes('buildUsageSnapshot') && indexSrc.includes("sub === 'usage'") && indexSrc.includes("'usage'"))
  ok('用量统计段：索引与聚合仍从 usage-stats.js 引入（不在 index.js 里另写一份）',
    indexSrc.includes("from './usage-stats.js'"))

  // refreshing 语义（INTERFACE §2）：只表示同步在飞；「距上次同步过久」是另一个判据。
  // 合并回 || 的话，两次同步之间的 4/5 时间面板都在喊「正在同步…」，且请求反向踢同步。
  ok('用量统计段：refreshing 只来自在飞同步（不再或上「距上次同步 > 60s」）',
    usageRegion.includes('const refreshing = usageSync !== null') && !usageRegion.includes('usageSync !== null ||'))
  ok('用量统计段：距上次同步过久只用来踢一轮同步',
    usageRegion.includes('now - usageLastSyncAt > 60_000'))
  // 500 兜底：usage 分支单独 try/catch 回固定串；其它 sub 仍保留 message（排查面）。
  ok('usage 路由：快照异常回固定串 usage-unavailable（不回宿主 error.message）',
    indexSrc.includes("{ error: 'usage-unavailable' }")
      && indexSrc.includes('token-plan-quota: 用量快照构建失败'))
  ok('usage 路由：其它 sub 的 500 兜底仍带 error.message（排查需要）',
    indexSrc.includes('{ error: error instanceof Error ? error.message : String(error) }'))

  // 7) 宿主 persistence 双形态 seam：探测顺序与兜底是「语义正确者优先」的实证结论，
  //    反了不会报错，只会让旧宿主上 revision 恒空（每轮全量重读）或继承前缀重复计数。
  //    这里钉的是**顺序**，因为行为测试只能证明当下这一版形状；顺序漂了要等旧宿主上才响。
  const listSnapshotsAt = usageSrc.indexOf('listSnapshots')
  const listAt = usageSrc.indexOf('persistence.list()')
  ok('usage seam：listSnapshots 优先于 list 探测（旧宿主 list 只给裸 header）',
    listSnapshotsAt >= 0 && listAt >= 0 && listSnapshotsAt < listAt)
  ok('usage seam：revision 经 revisionKey 归一成字符串（对象/数字也不会存空串）',
    usageSrc.includes('function revisionKey') && usageSrc.includes('revisionKey(snapshot?.revision)'))
  ok('usage seam：继承 cut 三级兜底（inheritedEventCount → meta.seedLength → header.seedLength）',
    usageSrc.includes('function inheritedEventCountFor') && usageSrc.includes('meta?.seedLength')
      && usageSrc.includes('header?.seedLength'))
  ok('usage seam：会话偏移过 validSessionOffset（number / safe integer / >=0，排除 -0）',
    usageSrc.includes('function validSessionOffset') && usageSrc.includes('Number.isSafeInteger(value)')
      && usageSrc.includes('Object.is(value, -0)'))
  ok('usage seam：无 open 时退 readFrom(id, fromSeq) 再退 read(id, fromSeq)（都带起点）',
    usageSrc.includes('persistence.readFrom(id, fromSeq)') && usageSrc.includes('persistence.read(id, fromSeq)'))
  ok('usage seam：坏快照计 failed 再 continue（不静默丢）', /failed \+= 1[\s\S]{0,200}?continue/.test(usageSrc))
  ok('也接线了 no-sessions 降级原因（本实例还没有会话记录）',
    usageRegion.includes("'no-sessions'") && usageRegion.includes('本实例还没有会话记录'))

  // 8) INTERFACE §4：静态矩阵也要覆盖**客户端**新代码。用量屏只呈现聚合数字，
  //    出现 % 或 Credits 折算就是宪法原则 I 的越界展示，而功能测试里往往只是多印一个字。
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const clientScreenStart = clientSrc.indexOf('function UsageScreen')
  ok('客户端用量屏在 lib/client.js 里存在且可定位', clientScreenStart > 0)
  const clientUsageRegion = clientScreenStart > 0 ? clientSrc.slice(clientScreenStart) : ''
  ok('客户端用量屏被完整扫到（字符数 > 10000）', clientUsageRegion.length > 10000)
  const clientCode = stripComments(clientUsageRegion)
  // 012 起屏上合法出现百分比（实测 token 的构成比与命中率），但那只能由白名单段的四个函数产出；
  // 渲染处手拼一个 "%" 就说明纪律又被绕开了，所以这里仍钉住「用量屏代码 0 个百分比字面量」。
  const clientPercents = [...clientCode.matchAll(/.{0,24}%.{0,24}/g)].map(match => match[0].trim())
  ok('客户端用量屏：不手拼百分比（百分比只由 012 白名单段函数产出；命中：'
    + (clientPercents.join(' | ') || '无') + '）', clientPercents.length === 0)
  const clientCreditLines = clientCode.split(/\r?\n/).map(line => line.trim()).filter(line => /credit/i.test(line))
  ok('客户端用量屏：Credits 只出现在「不折算 Credits」白名单行（命中：'
    + (clientCreditLines.join(' | ') || '无') + '）',
    clientCreditLines.length > 0 && clientCreditLines.every(line => line.includes('usageNoteNoCredits')))
  // 座位注册与关闭形状。selectPanel(null) 位于 UsageScreen 之前的关闭入口里，所以另切
  // openUsagePanel → usagePanelActive 一段（把两者都算进「客户端用量面」）。
  ok('客户端用量屏：main 座位按 key 注册到 PANEL_ID',
    /register\(\{\s*name:\s*"main",\s*key:\s*PANEL_ID/.test(clientUsageRegion))
  const entryStart = clientSrc.indexOf('function openUsagePanel')
  const entryEnd = clientSrc.indexOf('function usagePanelActive')
  ok('客户端用量屏：关闭走 layout.selectPanel(null)',
    entryStart > 0 && entryEnd > entryStart && clientSrc.slice(entryStart, entryEnd).includes('selectPanel(null)'))
}

/* 007 自定义起止日期：纯函数校验顺序 + fixture 的「桶贴区间」守卫 + 路由/工具/客户端钩子静态矩阵。
 * 为什么放门禁：这四项都是**跨文件契约**——宿主 400 码与客户端本地校验必须同序（否则客户端放行的
 * 请求会被宿主拒），fixture 的周桶边界必须与宿主一致（否则截图是「查询条件与数据对不上」的假图），
 * 任一处漂移时功能测试往往仍全绿。 */
{
  const usageSrc = readFileSync(join(ROOT, 'lib', 'usage-stats.js'), 'utf8')
  const indexSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  /* 固定 now 的本机日键：所有相对日期都从它推，断言不随真实日期漂移。 */
  const todayKey = __internals.dayKey(FIXED_NOW)
  const shift = (key, delta) => {
    const parts = key.split('-').map(Number)
    const stamp = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + delta * 86_400_000)
    return stamp.getUTCFullYear() + '-' + String(stamp.getUTCMonth() + 1).padStart(2, '0') + '-' + String(stamp.getUTCDate()).padStart(2, '0')
  }
  const custom = opts => __internals.resolveCustomRange({ now: FIXED_NOW, ...opts })

  // 1) 应放行：闭区间 30 天 / 单日 / 恰好等于上限 / 闰日
  {
    const month = custom({ from: shift(todayKey, -29), to: todayKey })
    ok('007 resolveCustomRange：闭区间 30 天', month.error === undefined && month.days === 30 && month.to === todayKey)
    const one = custom({ from: todayKey, to: todayKey })
    ok('007 resolveCustomRange：单日仍走自定义（days=1，与 006 的 today 区分）',
      one.error === undefined && one.days === 1 && one.from === todayKey && one.to === todayKey)
    const exact = custom({ from: shift(todayKey, -9), to: todayKey, maxDays: 10 })
    ok('007 resolveCustomRange：恰好等于上限放行（10 天 / maxDays=10）', exact.error === undefined && exact.days === 10)
    const leap = custom({ from: '2024-02-29', to: '2024-02-29' })
    ok('007 resolveCustomRange：闰日 2024-02-29 是真实日期', leap.error === undefined && leap.days === 1)
  }

  // 2) 应报：六类非法 + 单脚本就能看出的顺序（格式先于日历、日历先于顺序、顺序先于夹紧、夹紧先于跨度）
  {
    ok('007 resolveCustomRange：格式非法（2026-9-1）', custom({ from: '2026-9-1', to: '2026-09-30' }).error === 'usage-bad-range')
    ok('007 resolveCustomRange：非真实日历日（2026-02-30）', custom({ from: '2026-02-30', to: '2026-03-02' }).error === 'usage-bad-range')
    ok('007 resolveCustomRange：非闰年 2025-02-29 被拒', custom({ from: '2025-02-29', to: '2025-03-01' }).error === 'usage-bad-range')
    ok('007 resolveCustomRange：from 晚于 to', custom({ from: shift(todayKey, -1), to: shift(todayKey, -2) }).error === 'usage-bad-range')
    ok('007 resolveCustomRange：from 在未来', custom({ from: shift(todayKey, 1), to: shift(todayKey, 1) }).error === 'usage-bad-range')
    const tooLong = custom({ from: shift(todayKey, -365), to: todayKey })
    ok('007 resolveCustomRange：超上限回 usage-range-too-long 并带 maxDays',
      tooLong.error === 'usage-range-too-long' && tooLong.maxDays === 365)
    const customCap = custom({ from: shift(todayKey, -10), to: todayKey, maxDays: 10 })
    ok('007 resolveCustomRange：maxDays 取自调用方（配置漂了能测出来）',
      customCap.error === 'usage-range-too-long' && customCap.maxDays === 10)
  }

  // 3) to 在未来：夹到今天而不是报错（用户手选了明天不该看到 400，也不该出现一串未来空桶）
  {
    const clamped = custom({ from: shift(todayKey, -2), to: shift(todayKey, 5) })
    ok('007 resolveCustomRange：to 在未来被夹到今天，days 按夹紧后的真值算',
      clamped.error === undefined && clamped.to === todayKey && clamped.days === 3)
  }

  // 4) fixture 守卫：自定义区间的桶必须恰好铺满 [from, to]（首桶从 from 起、末桶到 to 止）
  {
    const weekFrom = shift(todayKey, -69)
    const weekSnap = makeUsageSnapshot({ now: FIXED_NOW, from: weekFrom, to: todayKey })
    accepts('007 fixture：自定义 70 天（周桶贴区间）放行',
      () => assertUsageFixture(weekSnap, { now: FIXED_NOW, from: weekFrom, to: todayKey, lang: 'zh' }))
    ok('007 fixture：70 天走周粒度，首桶从 from 起、末桶到 to 止',
      weekSnap.granularity === 'week' && weekSnap.range.kind === 'custom'
        && weekSnap.buckets[0].from === weekFrom
        && weekSnap.buckets[weekSnap.buckets.length - 1].to === todayKey)
    rejects('007 fixture：首桶不再覆盖区间起点被拦（图上会漏掉区间第一天）', () => {
      const dirty = structuredClone(weekSnap)
      /* 标签与 from 同步改，避免先被「label = MM-DD」拦下——要测的是首桶边界这条规则本身。 */
      dirty.buckets[0].from = shift(dirty.buckets[0].from, 1)
      dirty.buckets[0].label = dirty.buckets[0].from.slice(5)
      assertUsageFixture(dirty, { now: FIXED_NOW, from: weekFrom, to: todayKey, lang: 'zh' })
    }, /覆盖区间起点/)
    rejects('007 fixture：末桶没到 to 被拦（会少算区间末尾几天）', () => {
      const dirty = structuredClone(weekSnap)
      const last = dirty.buckets.length - 1
      dirty.buckets[last].to = shift(dirty.buckets[last].to, -1)
      assertUsageFixture(dirty, { now: FIXED_NOW, from: weekFrom, to: todayKey, lang: 'zh' })
    }, /覆盖区间终点/)
    rejects('007 fixture：kind 写成 30d 被拦（否则客户端标题会按天数模式渲染）', () => {
      const dirty = structuredClone(weekSnap)
      dirty.range.kind = '30d'
      assertUsageFixture(dirty, { now: FIXED_NOW, from: weekFrom, to: todayKey, lang: 'zh' })
    }, /range.kind 是 custom/)
  }

  // 5) 宿主接线：/usage 解析 from/to、400 固定码、工具 schema 与失败形状
  {
    ok('007 路由：/usage 把 from/to 交给 buildUsageSnapshot',
      indexSrc.includes("from: url.searchParams.get('from')") && indexSrc.includes("to: url.searchParams.get('to')"))
    ok('007 路由：参数错误回 400 固定码，超限才带 maxDays',
      /json\(res, 400, usage\.maxDays === undefined/.test(indexSrc)
        && indexSrc.includes("'usage-bad-range'") && indexSrc.includes("'usage-range-too-long'"))
    ok('007 工具 schema：from / to 两个参数都在 properties 里',
      /from: \{ type: 'string'/.test(indexSrc) && /(\n|\s)to: \{ type: 'string'/.test(indexSrc))
    ok('007 工具：action=usage 传 from/to，失败回 ok:false（不带宿主原文）',
      indexSrc.includes('from: args?.from, to: args?.to')
        && indexSrc.includes('ok: false, text, error: usage.error'))
    ok('007 纯函数：resolveCustomRange 从 usage-stats.js 导入并在 internals 里可测（不另写一份）',
      /import \{[^}]*resolveCustomRange[^}]*\} from '\.\/usage-stats\.js'/.test(indexSrc)
        && indexSrc.includes('  resolveCustomRange,'))
  }

  // 6) 客户端钩子与查询形状（截图脚本按 data-* 找元素；契约漂了脚本会抛错而不是拍假图）
  {
    for (const hook of ['"data-usage-preset": "custom"', '"data-usage-custom": "1"',
      '"data-usage-apply": "1"', '"data-usage-range-error": "1"',
      '"data-usage-from"', '"data-usage-to"']) {
      ok('007 客户端：钩子 ' + hook + ' 存在', clientSrc.includes(hook))
    }
    ok('007 客户端：自定义查询只发 ?from=&to=（不带 days / range）',
      clientSrc.includes('"?from=" + checked.from + "&to=" + checked.to')
        && clientSrc.includes('const path = USAGE + suffix;')
        && !clientSrc.includes('USAGE + "?range="'))
    ok('007 客户端：本地校验先于请求（非法输入零请求，两处独立校验）',
      // 008 把请求串统一收进 usageQueryPath：校验失败 → null → 调用方直接返回，一个字节都不发。
      /if \(checked\.ok !== true\) return null;/.test(clientSrc)
        && clientSrc.includes('if (suffix === null) return Promise.resolve();')
        && clientSrc.includes('if (suffix === null || key === null) return Promise.resolve();')
        && /if \(checked\.ok !== true\) \{/.test(clientSrc))
    ok('007 客户端：两条 400 映射成本地文案（不回显宿主原文）',
      clientSrc.includes('code === "usage-bad-range" || code === "usage-range-too-long"')
        && clientSrc.includes('usageRangeTooLong') && clientSrc.includes('failure.maxDays = Math.round(maxDays)'))
    ok('007 客户端：跨度上限写死 365，与宿主默认 usageBackfillDays 同值',
      clientSrc.includes('const USAGE_DAYS_MAX = 365;')
        && __internals.DEFAULTS.usageBackfillDays === 365)
    const i18nKeys = ['usageRangeCustom', 'usageRangeFrom', 'usageRangeTo', 'usageRangeApply', 'usageRangeBad',
      'usageRangeTooLong', 'usageRangeDayOne', 'usageRangeCustomTitle', 'usageRangeLocalOnly']
    for (const key of i18nKeys) {
      const hits = (clientSrc.match(new RegExp('\\b' + key + ':', 'g')) || []).length
      ok('007 i18n：' + key + ' 在 zh / en 两份 COPY 里都有（命中 ' + hits + '）', hits >= 2)
    }
    ok('007 客户端：脚注「仅统计本机」只在 session-index 数据源下出现',
      clientSrc.includes('sourceKind === "session-index"') && clientSrc.includes('copy.usageRangeLocalOnly'))
  }

  // 7) 展示口径：007 新增的代码同样不许派生百分比 / 折算 Credits
  {
    const strip007 = source => source.replace(/\/\*[\s\S]*?\*\//g, '')
    const rangeStart = usageSrc.indexOf('function resolveCustomRange')
    const rangeEnd = usageSrc.indexOf('function emptyUsageIndex')
    ok('007 纯函数段在 usage-stats.js 里存在且可定位', rangeStart > 0 && rangeEnd > rangeStart)
    const rangeRegion = rangeStart > 0 ? strip007(usageSrc.slice(rangeStart, rangeEnd)) : ''
    ok('007 纯函数段：不出现百分比与 Credits', rangeRegion !== '' && !/%/.test(rangeRegion) && !/credit/i.test(rangeRegion))
    ok('007 纯函数段：不联网、不读凭据', rangeRegion !== '' && !/fetch\(|https?:\/\//.test(rangeRegion) && !/credential|apiKey|cookie/i.test(rangeRegion))
  }

  /* 8) 008 官方用量明细：纯函数层必须保持"只算数"，宿主段必须"只经网关出网、不落盘"。
   * 这一格最容易悄悄坏的方式是把官方历史顺手写进索引文件（那就把账号级数据落到本机了），
   * 或者为了取数在段内直接 fetch（绕开声明主机闸门）。 */
  {
    const officialSrc = readFileSync(join(ROOT, 'lib', 'official-usage.js'), 'utf8')
    const strip8 = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const officialCode = strip8(officialSrc)
    ok('008 官方模块：纯函数层（没有 import / require）', !/^\s*import\s/m.test(officialCode) && !/require\(/.test(officialCode))
    ok('008 官方模块：不联网、不读文件', !/fetch\(|https?:\/\/|readFile|writeFile|renameSync|process\.env/.test(officialCode))
    // 错误提示段会点名 Cookie 的**环境变量名**（那是给用户的操作指引，值永远不进文案）：
    // 凭据扫描只扫它之前的部分，否则要么把整段吞掉、要么逼文案说一句用户看不懂的行话。
    const officialDataCode = officialCode.slice(0, officialCode.indexOf('export function officialErrorHint'))
    ok('008 官方模块：不读凭据（注释与提示文案除外）',
      officialDataCode !== '' && !/credential|apiKey|api_key|cookie|process\.env/i.test(officialDataCode))
    ok('008 官方模块：不出现百分比与 Credits 字样', !/%/.test(officialCode) && !/credit/i.test(officialCode))

    const officialStart = indexSrc.indexOf('/* ==================================================== 官方账号侧用量（008）')
    const officialEnd = indexSrc.indexOf('/* ==================================================== 滑动 TPM + 重试观测')
    ok('008 宿主段在 lib/index.js 里存在且可定位', officialStart > 0 && officialEnd > officialStart)
    const officialRegion = officialStart > 0 ? indexSrc.slice(officialStart, officialEnd) : ''
    ok('008 宿主段被完整扫到（字符数 > 2000）', officialRegion.length > 2000)
    ok('008 宿主段：不直接出网（只经 callConsoleGateway，声明主机闸门才拦得住）', !/fetch\(/.test(officialRegion))
    ok('008 宿主段：不出现百分比与 Credits 字样', !/%/.test(officialRegion) && !/credit/i.test(officialRegion))
    ok('008 宿主段：官方历史不落盘', !/writeFileSync|saveUsageIndex|appendFile/.test(officialRegion))

    const tp = __internals.PRESETS['token-plan-console']
    ok('008 预设：telemetry 用 platform-model 网关的用量明细接口',
      tp.telemetryApi === 'zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss')
    ok('008 预设：切片 30 天 / 最早 5 个月 / 日步长（与纯函数默认同源）',
      tp.telemetryChunkDays === 30 && tp.telemetryEarliestMonths === 5 && tp.telemetryStepSeconds === 86_400)
    ok('008 DEFAULTS：officialUsage 默认开、officialUsageMinutes 默认 5',
      __internals.DEFAULTS.officialUsage === true && __internals.DEFAULTS.officialUsageMinutes === 5)
    ok('008 出站主机没有被这份功能扩表（仍 8 条 https）',
      __internals.DECLARED_HOSTS.length === 8 && __internals.DECLARED_HOSTS.every(host => host.startsWith('https://')))
  }

  /* 9) 009 兜底目录扫描 + 重启即可见：兜底段只能"读日志、不联网、不落盘"，
   * 四个 coverage 键与两个配置键是**落盘契约**的一部分（键名漂了客户端就读不到，屏上少一行脚注却不会红）。 */
  {
    const strip9 = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const fallbackStart = usageSrc.indexOf('兜底目录扫描（009）')
    const fallbackEnd = usageSrc.indexOf('export async function syncUsageIndex')
    ok('009 兜底段在 lib/usage-stats.js 里存在且可定位', fallbackStart > 0 && fallbackEnd > fallbackStart)
    const fallbackCode = fallbackStart > 0 ? strip9(usageSrc.slice(fallbackStart, fallbackEnd)) : ''
    ok('009 兜底段被完整扫到（字符数 > 3000）', fallbackCode.length > 3000)
    ok('009 兜底段：不联网（没有 fetch / http 字面量）',
      fallbackCode !== '' && !fallbackCode.includes('fetch(') && !fallbackCode.includes('http'))
    ok('009 兜底段：不读凭据',
      fallbackCode !== '' && !/credential|apikey|cookie|process\.env/i.test(fallbackCode))
    ok('009 兜底段：不写盘（写索引只发生在 saveUsageIndex）',
      fallbackCode !== '' && !fallbackCode.includes('writeFileSync') && !fallbackCode.includes('renameSync')
      && !fallbackCode.includes('unlinkSync') && !fallbackCode.includes('mkdirSync'))
    ok('009 解码：按 zstd magic 切帧而不是整份解压',
      fallbackCode.includes('0x28, 0xb5, 0x2f, 0xfd') && fallbackCode.includes('zstdDecompressSync'))
    ok('009 日志签名只含大小与修改时间（路径不落索引）',
      fallbackCode.includes("'file:' + size") && !fallbackCode.includes('log.path'))
    ok('009 预算常量 = 64 MB', __internals.FALLBACK_SCAN_BUDGET === 64 * 1024 * 1024)
    ok('009 纯函数与懒加载都从 __internals 暴露',
      ['decodeSessionLog', 'parseSessionEvents', 'fallbackCutOf', 'fallbackLogsOf', 'fallbackSignature', 'ensureUsageIndexLoaded']
        .every(name => typeof __internals[name] === 'function'))
    ok('009 DEFAULTS：usageScanFallback 默认开、usageScanPath 指向会话根目录',
      __internals.DEFAULTS.usageScanFallback === true && __internals.DEFAULTS.usageScanPath === '$DSH_HOME/sessions')
    const snapStart = indexSrc.indexOf('function buildUsageSnapshot')
    const snapEnd = indexSrc.indexOf('function buildUsageSnapshot') + 4000
    const snapRegion = snapStart > 0 ? indexSrc.slice(snapStart, snapEnd) : ''
    ok('009 buildUsageSnapshot 先同步读盘（重启后首请求就有数）',
      snapRegion.includes('ensureUsageIndexLoaded(config)'))
    ok('009 coverage 追加 scanned / rescued / scanFailed / scanDeferred（缺省 0）',
      ['scanned', 'rescued', 'scanFailed', 'scanDeferred']
        .every(key => snapRegion.includes(key + ': Number.isFinite(result?.' + key + ')')))
    ok('009 出站主机没有被这份功能扩表（仍 8 条 https）',
      __internals.DECLARED_HOSTS.length === 8 && __internals.DECLARED_HOSTS.every(host => host.startsWith('https://')))

    const clientSrc9 = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
    ok('009 客户端：补扫行带 data-usage-rescued，且只在 rescued > 0 时渲染',
      clientSrc9.includes('data-usage-rescued') && clientSrc9.includes('if (rescued > 0)'))
    const rescuedLines = clientSrc9.split('\n').filter(line => line.includes('已按日志目录补扫')
      || line.includes('were recovered from the log directory'))
    ok('009 客户端：补扫脚注中英都在，且不含百分比与 Credits',
      rescuedLines.length === 2 && rescuedLines.every(line => !line.includes('%') && !/credit/i.test(line)))
  }
  /* 10) 010 按月查询：纯函数只算日期、路由两个固定码、工具与客户端钩子成对。
   * 月份是用户直接输入的字符串，最容易坏的三处：放过 2026-13 / 2026-00、把未来月当成今天、
   * 让 month 与 from/to 同时生效（两个真值源 → 屏上标题与柱子对不上，却不会红）。 */
  {
    ok('010 resolveMonthRange 从 usage-stats.js 暴露到 __internals（可直接测）',
      typeof __internals.resolveMonthRange === 'function')
    const monthFn = typeof __internals.resolveMonthRange === 'function'
      ? __internals.resolveMonthRange.toString() : ''
    ok('010 resolveMonthRange：只认 YYYY-MM（月份两位、01..12），先 trim',
      monthFn.includes('(0[1-9]|1[0-2])') && monthFn.includes('trim()'))
    ok('010 resolveMonthRange：未来月按月份前缀比较（不按毫秒），并回 usage-bad-month',
      monthFn.includes('slice(0, 7)') && monthFn.includes('usage-bad-month'))
    const monthStart = usageSrc.indexOf('function resolveMonthRange')
    const monthEnd = usageSrc.indexOf('export function aggregateUsageRange')
    ok('010 纯函数段在 lib/usage-stats.js 里存在且可定位', monthStart > 0 && monthEnd > monthStart)
    const monthRegion = monthStart > 0 ? usageSrc.slice(monthStart, monthEnd)
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '') : ''
    ok('010 纯函数段：不出现百分比与 Credits', monthRegion !== '' && !/%/.test(monthRegion) && !/credit/i.test(monthRegion))
    ok('010 纯函数段：不联网、不读凭据',
      monthRegion !== '' && !/fetch\(|https?:\/\//.test(monthRegion)
      && !/credential|apiKey|cookie|process\.env/i.test(monthRegion))
    ok('010 聚合：month 分支的 range.kind 是 month',
      usageSrc.includes("kind: 'month'") || usageSrc.includes('kind: "month"'))

    ok('010 宿主：month 走独立解析器，且与 from/to 互斥',
      indexSrc.includes('resolveUsageMonth') && indexSrc.includes("searchParams.get('month')")
      && indexSrc.includes("'usage-bad-range'") && indexSrc.includes("'usage-bad-month'"))
    ok('010 宿主：resolveMonthRange 从 usage-stats.js 导入（不另写一份）',
      /import \{[^}]*resolveMonthRange[^}]*\} from '\.\/usage-stats\.js'/.test(indexSrc)
      && indexSrc.includes('  resolveMonthRange,'))
    const officialStart = indexSrc.indexOf('function resolveOfficialRange')
    const officialEnd = indexSrc.indexOf('function buildOfficialUsageSnapshot')
    const officialRegion = officialStart > 0 && officialEnd > officialStart
      ? indexSrc.slice(officialStart, officialEnd) : ''
    ok('010 官方对照跟随同一月份（同一个解析器，不是第二套规则）',
      officialRegion !== '' && officialRegion.includes('resolveUsageMonth'))
    ok('010 工具 schema：month 参数在 properties 里并透传',
      /month: \{ type: 'string'/.test(indexSrc) && indexSrc.includes('month: args?.month'))

    for (const hook of ['"data-usage-preset": "month"', '"data-usage-month": "1"',
      '"data-usage-month-input"', '"data-usage-month-apply"', '"data-usage-month-error": "1"']) {
      ok('010 客户端：钩子 ' + hook + ' 存在', clientSrc.includes(hook))
    }
    ok('010 客户端：月份查询只发 ?month=YYYY-MM',
      clientSrc.includes('"?month=" +'))
    ok('010 客户端：usage-bad-month 映射成本地文案（不回显宿主原文）',
      clientSrc.includes('"usage-bad-month"') && clientSrc.includes('usageMonthBad'))
    for (const key of ['usageMonthPreset', 'usageMonthLabel', 'usageMonthApply', 'usageMonthBad', 'usageRangeMonthTitle']) {
      const hits = (clientSrc.match(new RegExp('\\b' + key + ':', 'g')) || []).length
      ok('010 i18n：' + key + ' 在 zh / en 两份 COPY 里都有（命中 ' + hits + '）', hits >= 2)
    }
    const monthCopy = clientSrc.split('\n').filter(line => /usageRangeMonthTitle|usageMonthPreset|usageMonthLabel/.test(line))
    ok('010 i18n：月份文案不含百分比与 Credits',
      monthCopy.length > 0 && monthCopy.every(line => !line.includes('%') && !/credit/i.test(line)))

    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const readmeEn = readFileSync(join(ROOT, 'README.en.md'), 'utf8')
    ok('010 文档：中英 README 都写了 month 路由与 usage-bad-month',
      readme.includes('usage?month=') && readme.includes('usage-bad-month')
      && readmeEn.includes('usage?month=') && readmeEn.includes('usage-bad-month'))
    ok('010 规格目录存在（spec/plan/tasks/INTERFACE）',
      ['spec.md', 'plan.md', 'tasks.md', 'INTERFACE.md']
        .every(name => existsSync(join(ROOT, 'specs', '010-month-range', name))))
    const shotsManifest = readFileSync(join(ROOT, 'scripts', 'check-docs.mjs'), 'utf8')
    ok('010 截图清单：中英 month 图都在',
      shotsManifest.includes('docs/images/usage-month-2d.png')
      && shotsManifest.includes('docs/images/en/usage-month-2d.png'))
    ok('010 出站主机没有被这份功能扩表（仍 8 条 https）',
      __internals.DECLARED_HOSTS.length === 8 && __internals.DECLARED_HOSTS.every(host => host.startsWith('https://')))
  }
}


/* 011 柱子悬停浮层：把「浮层内容 ≡ aria-label ≡ COPY」与「原生 <title> 不许回来」钉在源码形状上。
 * 为什么值得进静态矩阵：这三件事坏掉时功能测试常常全绿——浮层另拼一套文案，视觉对、读屏错；
 * 有人把 <title> 加回来，鼠标停 1 秒后系统提示框和浮层同时出现（只有真机才看得见）。
 * 顺带钉住「零新 i18n 键 / 零新配置键 / 零新出站主机」：011 是纯客户端展示层，越界就会破坏口径。 */
{
  const clientSrc011 = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const tipStart = clientSrc011.indexOf('function usageBucketRange')
  const chartStart = clientSrc011.indexOf('function UsageChart')
  const chartEnd = clientSrc011.indexOf('function usageSplitCell')
  ok('011 浮层纯函数段在 lib/client.js 里存在且可定位', tipStart > 0 && chartStart > tipStart)
  const tipRegion = tipStart > 0 ? clientSrc011.slice(tipStart, chartStart) : ''
  const chartRegion = chartStart > 0 && chartEnd > chartStart ? clientSrc011.slice(chartStart, chartEnd) : ''
  ok('011 浮层纯函数段被完整扫到（字符数 > 5000）', tipRegion.length > 5000)
  ok('011 图表段被完整扫到（字符数 > 10000）', chartRegion.length > 10000)

  // 1) 命中钩子：截图（⑭）与客户端测试都按这批属性找节点，漏一个就整条链断。
  for (const hook of ['"data-usage-bar": "1"', '"data-usage-bar-index"', '"data-usage-bar-from"',
    '"data-usage-bar-to"', '"data-usage-tip": "1"', '"data-usage-tip-index"',
    '"data-usage-tip-range": "1"', '"data-usage-tip-tokens": "1"', '"data-usage-tip-" + row.key',
    '"aria-hidden": "true"', 'tabIndex: 0', 'role: "img"']) {
    ok('011 客户端：命中钩子 ' + hook + ' 存在', clientSrc011.includes(hook))
  }

  // 2) 不许再渲染原生 <title>：它会和浮层同时弹（且样式不受控）。
  ok('011 客户端：不再渲染原生 <title>（否则系统提示框与浮层同时出现）',
    !/createElement\(\s*"title"/.test(clientSrc011))

  // 3) 同一份文本：浮层首行与 aria-label 都从 usageBucketRange 拼，别各写一套。
  ok('011 客户端：aria-label 走 usageBucketTitle（与浮层同源）',
    chartRegion.includes('usageBucketTitle(bucket, copy)'))
  ok('011 客户端：usageBucketTitle 与 usageTipContent 共用 usageBucketRange（不各拼一套日期）',
    tipRegion.split('usageBucketRange(bucket)').length - 1 >= 2)
  ok('011 客户端：周桶区间用 U+2013（en dash）且两端各一个空格',
    tipRegion.includes('" \u2013 "'))

  // 4) 展示口径（宪法原则 I）：浮层只报绝对 tokens，不派生百分比、不折算 Credits。
  //    判据与 006 段一致：% 后紧跟数字才算百分比（这里的 % 只该出现在取模里）。
  const stripComments011 = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const tipCode = stripComments011(tipRegion)
  const chartCode = stripComments011(chartRegion)
  ok('011 浮层段：不派生百分比、不出现 Credits、无硬编码中文（文案必须走 COPY）',
    !/%\s*\d/.test(tipCode) && !/credit/i.test(tipCode) && !/[\u3400-\u9fff]/u.test(tipCode))
  ok('011 图表段：不派生百分比、不出现 Credits、无硬编码中文',
    !/%\s*\d/.test(chartCode) && !/credit/i.test(chartCode) && !/[\u3400-\u9fff]/u.test(chartCode))

  // 5) 定位/夹紧的四个纯函数必须可由测试直接调（否则只能起真实布局，回归没人跑）。
  const clientInternals011 = clientSrc011.slice(clientSrc011.lastIndexOf('__internals = {'),
    clientSrc011.indexOf('exports.apply', clientSrc011.lastIndexOf('__internals = {')))
  ok('011 纯函数从客户端 __internals 暴露（区间/内容/夹紧/内联/指针/柱矩形）',
    ['usageBucketRange', 'usageTipContent', 'usageTipPlacement', 'usageTipInline', 'usagePointerPoint', 'usageBarRectOf']
      .every(name => new RegExp('\\b' + name + '\\b').test(clientInternals011)))

  // 6) CSS 形状：浮层不挡指针（否则 pointermove 会抖）、要浮在卡片之上、portal 时 pinned 到视口。
  ok('011 CSS：浮层 pointer-events:none + position:fixed + 高 z-index 三件都在',
    clientSrc011.includes('.tpq-usage-tip{position:fixed') && clientSrc011.includes('pointer-events:none')
      && clientSrc011.includes('z-index:9999'))

  // 7) i18n 键数：011 本身不加键（134）；012 后来补了 4 个比例相关键（← 138），这里跟着契约走。
  const zhBlock011 = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(clientSrc011)
  const enBlock011 = /\n      en: \{([\s\S]*?)\n      \},/.exec(clientSrc011)
  const keysOf011 = text => [...text.matchAll(/^ {8}([A-Za-z]\w*):/gm)].map(match => match[1])
  const zhKeys011 = keysOf011(zhBlock011?.[1] ?? '')
  const enKeys011 = keysOf011(enBlock011?.[1] ?? '')
  ok('011 i18n：COPY 键数仍是 zh / en 各 138（011 不加键；012 的 4 键另计）',
    zhKeys011.length === 138 && enKeys011.length === 138)

  // 8) 越界面：011 是纯客户端展示，宿主配置与出站主机都不许动。
  ok('011 配置键没有扩表（DEFAULTS 仍 25 个键）', Object.keys(__internals.DEFAULTS).length === 25)
  ok('011 出站主机没有被这份功能扩表（仍 8 条 https）',
    __internals.DECLARED_HOSTS.length === 8 && __internals.DECLARED_HOSTS.every(host => host.startsWith('https://')))

  // 9) 对外描述与截图清单：图没生成时 check-docs 会红，这里先钉住「名字没漂」。
  const readme011 = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const readmeEn011 = readFileSync(join(ROOT, 'README.en.md'), 'utf8')
  ok('011 文档：中文 README 写了悬停说明与截图',
    readme011.includes('悬停') && readme011.includes('docs/images/usage-tooltip-2d.png'))
  ok('011 文档：英文 README 写了 hover 说明与截图',
    /hover/i.test(readmeEn011) && readmeEn011.includes('docs/images/en/usage-tooltip-2d.png'))
  const shotsManifest011 = readFileSync(join(ROOT, 'scripts', 'check-docs.mjs'), 'utf8')
  ok('011 截图清单：中英 tooltip 图都在',
    shotsManifest011.includes('docs/images/usage-tooltip-2d.png')
      && shotsManifest011.includes('docs/images/en/usage-tooltip-2d.png'))
  ok('011 规格目录存在（spec/plan/tasks/INTERFACE）',
    ['spec.md', 'plan.md', 'tasks.md', 'INTERFACE.md']
      .every(name => existsSync(join(ROOT, 'specs', '011-bar-tooltip', name))))
  const changelog011 = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  ok('011 CHANGELOG：Unreleased 段记了悬停浮层（含 011 编号）',
    /## \[Unreleased\]/.test(changelog011) && changelog011.includes('悬停') && changelog011.includes('011'))
}


/* 012 分项中文化 / 占比 / 命中率 / 模型列表内滚动：把「唯一允许出现百分号的地方」
 * 与「中文标签不许漏、英文标签不许漏」钉在源码形状上。
 * 为什么值得进静态矩阵：功能测试断言的是此刻的 fixture 文本，而纪律问题是「换个地方又拼了个 %」——
 * 那类回归不会让任何一条功能断言变红。这里以白名单段标记切片：百分比字面量只许出现在段内，
 * 用量渲染代码（usageSplitCell 之后）剥掉注释后一个 % 都不许有。
 * 顺带钉住滚动容器四件（属性 + CSS）与文档/截图清单，避免「代码改了、图还是旧的」。 */
{
  const clientSrc012 = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const whitelistStart = clientSrc012.indexOf('/* 012 比例白名单段')
  const whitelistEnd = clientSrc012.indexOf('/* 012 比例白名单段结束 */')
  ok('012 比例白名单段在 lib/client.js 里存在且可定位',
    whitelistStart > 0 && whitelistEnd > whitelistStart)
  const whitelistRegion = whitelistStart > 0 && whitelistEnd > whitelistStart
    ? clientSrc012.slice(whitelistStart, whitelistEnd) : ''
  ok('012 比例白名单段被完整扫到（字符数 > 600）', whitelistRegion.length > 600)

  const stripComments012 = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/gm, '')
  // 用量渲染代码从 usageSplitCell 起（它之后的都是 JS，CSS 模板在这之前）；剥掉注释后不该再有 % 字符——
  // 百分比只能由白名单段的四个函数产出，渲染处手拼一个 "%" 就说明纪律又被绕开了。
  const renderStart012 = clientSrc012.indexOf('function usageSplitCell')
  const renderRegion012 = renderStart012 > 0 ? stripComments012(clientSrc012.slice(renderStart012)) : ''
  const renderPercents = [...renderRegion012.matchAll(/.{0,30}%.{0,30}/g)].map(match => match[0].trim())
  ok('012 用量渲染代码里没有百分比字面量（命中：' + (renderPercents.join(' | ') || '无') + '）',
    renderRegion012.length > 10000 && renderPercents.length === 0)
  ok('012 白名单段是唯一定义百分比字面量的地方（段内含 "%" 返回）',
    whitelistRegion.includes('"%"') && whitelistRegion.includes('"<0.1%"'))

  // 1) 四个纯函数必须可由测试直接调，且只在白名单段里定义。
  const internalsStart = clientSrc012.lastIndexOf('__internals = {')
  const clientInternals012 = clientSrc012.slice(internalsStart,
    clientSrc012.indexOf('exports.apply', internalsStart))
  ok('012 比例函数从客户端 __internals 暴露（百分比/占比/后缀/命中率）',
    ['usagePercentText', 'usageShareText', 'usagePercentSuffix', 'usageHitRateText']
      .every(name => new RegExp('\\b' + name + '\\b').test(clientInternals012)))
  ok('012 四个比例函数都定义在白名单段内（段外不再定义）',
    ['function usagePercentText', 'function usageShareText', 'function usagePercentSuffix', 'function usageHitRateText']
      .every(signature => whitelistRegion.includes(signature)))

  // 2) 中文标签必须真中文化，且英文界面不许出现中文标签。
  const zhBlock012 = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(clientSrc012)
  const enBlock012 = /\n      en: \{([\s\S]*?)\n      \},/.exec(clientSrc012)
  const keysOf012 = text => [...text.matchAll(/^ {8}([A-Za-z]\w*):/gm)].map(match => match[1])
  const zhKeys012 = keysOf012(zhBlock012?.[1] ?? '')
  const enKeys012 = keysOf012(enBlock012?.[1] ?? '')
  ok('012 i18n：COPY 是 zh / en 各 138 键（012 新增 4 键：占比模板/命中率模板/命中率标签/公式脚注）',
    zhKeys012.length === 138 && enKeys012.length === 138)
  ok('012 i18n：四类分项键在 zh / en 都存在',
    ['usageSplitInput', 'usageSplitOutput', 'usageSplitCacheRead', 'usageSplitCacheWrite']
      .every(key => zhKeys012.includes(key) && enKeys012.includes(key)))
  for (const [key, word] of [['usageSplitInput', '输入'], ['usageSplitOutput', '输出'],
    ['usageSplitCacheRead', '缓存命中'], ['usageSplitCacheWrite', '缓存写入']]) {
    const line = (zhBlock012?.[1] ?? '').split('\n').find(item => item.trim().startsWith(key + ':'))
    ok('012 i18n：zh ' + key + ' 写作「' + word + '」', Boolean(line) && line.includes(word))
  }
  const enSplitLines012 = (enBlock012?.[1] ?? '').split('\n')
    .filter(line => /usageSplit(Input|Output|CacheRead|CacheWrite):/.test(line)).join('\n')
  ok('012 i18n：en 侧四类标签不含中文', enSplitLines012.length > 0 && !/[\u3400-\u9fff]/u.test(enSplitLines012))

  // 3) 滚动容器：属性 + CSS 四件（内滚动、细条、可聚焦、thumb 用既有变量）。
  for (const hook of ['"data-usage-models-scroll": "1"', '"aria-label": copy.usageModelsTitle',
    'role: "group"']) {
    ok('012 客户端：模型列表钩子 ' + hook + ' 存在', clientSrc012.includes(hook))
  }
  ok('012 CSS：模型列表内滚动四件（max-height + overflow-y + thin + thumb）',
    clientSrc012.includes('max-height:252px') && clientSrc012.includes('overflow-y:auto')
      && clientSrc012.includes('scrollbar-width:thin') && clientSrc012.includes('::-webkit-scrollbar-thumb'))
  ok('012 CSS：滚动容器键盘可达（:focus-visible 描边）',
    /\.tpq-usage-models:focus-visible\{[^}]*outline/.test(clientSrc012))
  ok('012 CSS：占比子行不抢数值（tertiary + 等宽数字）',
    /\.tpq-usage-split-share\{[^}]*label-tertiary/.test(clientSrc012)
      && /\.tpq-usage-split-share\{[^}]*tabular-nums/.test(clientSrc012))

  // 4) 公式脚注与口径收窄：屏幕里必须同时给出两条公式，并声明「不是配额比例」。
  ok('012 客户端：公式脚注走 COPY.usageRatioNote（不硬编码长句）',
    (clientSrc012.match(/usageRatioNote/g) || []).length >= 3)
  ok('012 文案：中文脚注声明「不是配额比例」', (zhBlock012?.[1] ?? '').includes('不是配额比例'))
  ok('012 文案：英文脚注声明 composition, not quota', /not quota/i.test(enBlock012?.[1] ?? ''))

  // 5) 006 的口径收窄必须有书面依据，否则下一个人会把 012 的 % 当越界删掉。
  const spec006 = readFileSync(join(ROOT, 'specs', '006-usage-stats', 'spec.md'), 'utf8')
  ok('012 规格：006 spec 里留了「012 收窄」的指向',
    spec006.includes('012 收窄') && spec006.includes('specs/012-usage-composition/spec.md'))
  ok('012 规格目录存在（spec/plan/tasks/INTERFACE）',
    ['spec.md', 'plan.md', 'tasks.md', 'INTERFACE.md']
      .every(name => existsSync(join(ROOT, 'specs', '012-usage-composition', name))))

  // 6) 对外描述与截图清单：中文标签/公式/滚动条都写在介绍里，图没生成时 check-docs 会红。
  const readme012 = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const readmeEn012 = readFileSync(join(ROOT, 'README.en.md'), 'utf8')
  ok('012 文档：中文 README 写了中文标签、命中率公式与构成比口径',
    readme012.includes('缓存命中') && readme012.includes('缓存命中率') && readme012.includes('占比'))
  ok('012 文档：英文 README 写了 cache hit rate 与 composition 口径',
    /cache hit rate/i.test(readmeEn012) && /composition/i.test(readmeEn012))
  const shotsManifest012 = readFileSync(join(ROOT, 'scripts', 'check-docs.mjs'), 'utf8')
  ok('012 截图清单：中英构成图都在',
    shotsManifest012.includes('docs/images/usage-composition-2d.png')
      && shotsManifest012.includes('docs/images/en/usage-composition-2d.png'))
  const changelog012 = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  ok('012 CHANGELOG：Unreleased 段记了分项中文与占比/命中率（含 012 编号）',
    /## \[Unreleased\]/.test(changelog012) && changelog012.includes('012')
      && changelog012.includes('缓存命中'))

  // 7) 越界面：012 仍是纯客户端展示，配置键与出站主机都不许动。
  ok('012 配置键没有扩表（DEFAULTS 仍 25 个键）', Object.keys(__internals.DEFAULTS).length === 25)
  ok('012 出站主机没有被这份功能扩表（仍 8 条 https）',
    __internals.DECLARED_HOSTS.length === 8
      && __internals.DECLARED_HOSTS.every(host => host.startsWith('https://')))
}

/* 013（012 复核）：OpenCodeReview 结论里「功能测试看不见、只有源码形状能钉住」的那几处修复。
 * 为什么值得进静态矩阵：命中区几何、无障碍角色、0 值占比纪律都是「改回旧写法测试照样绿」的地方，
 * 而它们的坏法都只在真机 / 读屏里显形。这里按源码形状逐条钉住，并保留可失败性实证。 */
{
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  // 1) 0 值占比：守卫收进两个拼串函数（usagePercentText 自己仍要能返回 "0%"）。
  const shareFn = src.slice(src.indexOf('function usageShareText'), src.indexOf('function usagePercentSuffix'))
  const suffixFn = src.slice(src.indexOf('function usagePercentSuffix'), src.indexOf('function usageHitRateBase'))
  ok('013 占比与后缀都走 usageFiniteToken 再对 <= 0 短路（不再由调用点各判一遍）',
    shareFn.includes('usageFiniteToken(value)') && suffixFn.includes('usageFiniteToken(value)')
      && shareFn.includes('<= 0') && suffixFn.includes('<= 0'))
  ok('013 usagePercentText 仍能输出 "0%"（0 值纪律在调用方，不破坏纯函数语义）',
    src.includes('return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%"'))

  // 2) 命中率分母只有一份实现，总量卡与模型行都走它。
  const baseFn = src.slice(src.indexOf('function usageHitRateBase'), src.indexOf('function usageHitRateText'))
  ok('013 命中率分母抽成 usageHitRateBase（三项都走 usageFiniteToken 归一）',
    baseFn.includes('usageFiniteToken(source.input)') && baseFn.includes('usageFiniteToken(source.cacheRead)')
      && baseFn.includes('usageFiniteToken(source.cacheWrite)'))
  ok('013 归一化只有一份实现（usageFiniteToken），命中率分子也复用它',
    /function usageFiniteToken\(value\)[\s\S]{0,200}Number\.isFinite\(value\)/.test(src)
      && src.includes('const cacheRead = usageFiniteToken(source.cacheRead)'))
  const cardRegion = src.slice(src.indexOf('const hitRatePercent'), src.indexOf('const hitRatePercent') + 240)
  ok('013 总量卡命中率走 usagePercentText + usageHitRateBase（不再手写分母）',
    cardRegion.includes('usagePercentText(totals.cacheRead, usageHitRateBase(totals))'))
  ok('013 模型行命中率走 usageHitRateText（同一份分母）',
    src.includes('const hitRate = usageHitRateText(copy, totals)'))

  // 3) 无障碍：svg 不能用 role="img"（Children-Presentational 会把可聚焦柱子剪掉）。
  ok('013 图表 <svg> 用 role=group（aria-label 仍在）',
    /className: "tpq-usage-chart tpq-usage-svg",[\s\S]{0,400}role: "group"/.test(src))
  const tipNodeRegion = src.slice(src.indexOf('tipNode = React.createElement("div"'), src.indexOf('tipChildren);', src.indexOf('tipNode = React.createElement("div"')))
  ok('013 浮层 aria-hidden（柱子 aria-label 已含全部数字，读屏不再念两遍）',
    tipNodeRegion.includes('"aria-hidden": "true"'))
  ok('013 柱子与浮层都不再挂 aria-describedby（不重复描述同一个桶）',
    !src.includes('"aria-describedby":') && !src.includes('USAGE_TIP_ID'))
  ok('013 轴标与峰值标签都标 aria-hidden（role=group 下不再线性念一遍）',
    (src.match(/"aria-hidden": "true"/g) || []).length >= 4
      && src.includes('key: "tick-" + index,\n              className: "tpq-usage-tick",'))

  // 4) 3D 命中区必须往左上扩（正面 + 半柱宽 + 一个 ISO_DEPTH），且子节点都有 key。
  ok('013 3D 命中区向左半柱宽、向上一个 ISO_DEPTH',
    src.includes('x: threeD ? x - barWidth / 2 : x') && src.includes('y: threeD ? TOP_H - ISO_DEPTH : TOP_H'))
  ok('013 3D 命中区宽 1.5 柱宽、高补一个 ISO_DEPTH',
    src.includes('width: threeD ? barWidth * 1.5 : barWidth')
      && src.includes('height: threeD ? PLOT_H + ISO_DEPTH : PLOT_H'))
  ok('013 柱组两个子节点都有 key（缺 key = 每柱每次渲染一条 React warning）',
    src.includes('key: "hit"') && src.includes('key: "bar-" + index'))

  // 5) 健壮性：空快照不解引用、模型脏数据不炸、柱子子树缓存。
  ok('013 weekly 判定在 data 为空时也安全（三重防御）',
    src.includes('data !== null && data !== undefined && data.granularity === "week"'))
  ok('013 模型行的 id / totals 都先判类型（外部数据缺字段不许炸）',
    src.includes('typeof entry.id === "string"') && src.includes('typeof entry.totals === "object"'))
  ok('013 模型行 key 有 id 用 id、缺 id 才退序号（降序重排不整列重挂载）',
    src.includes('const rowKey = modelId !== "" ? "model-" + modelId : "model-#" + String(index)'))
  ok('013 缺 id 的行 title 一起省略（不挂空 title）',
    src.includes('title: modelId !== "" ? modelId : undefined'))
  ok('013 柱子树走 useMemo，且空区间的早退在 hook 之后（hook 数量恒定）',
    src.indexOf('React.useMemo(function buildBars()') > 0
      && src.indexOf('React.useMemo(function buildBars()') < src.indexOf('if (buckets.length === 0) return null'))

  // 6) 浮层 portal 到 body 后拿不到 .tpq 上的字体变量，规则里要自带一份。
  const tipRuleStart = src.indexOf('.tpq-usage-tip{')
  const tipRule = tipRuleStart < 0 ? '' : src.slice(tipRuleStart, src.indexOf('}', tipRuleStart) + 1)
  ok('013 浮层规则自带 --tpq-font（portal 离开 .tpq 后字体不回落）',
    tipRule.includes('--tpq-font:') && tipRule.includes('font-family:var(--tpq-font)'))

  // 7) 内联浮层的坐标补偿与新的纯函数也要能被测试直接打。
  ok('013 内联浮层补偿滚动与居中位移（usageTipInlineOffsetX 算位移、x 加上它）',
    src.includes('function usageTipInlineOffsetX')
      && src.includes('const offsetX = usageTipInlineOffsetX(scrollRef.current)')
      && src.includes('x: localCenter + offsetX'))
  const inlineFn = src.slice(src.indexOf('function usageTipInlineOffsetX'), src.indexOf('function usageBucketTitle'))
  ok('013 内联位移用两份 getBoundingClientRect 相减（SVG 根元素没有 offsetLeft）',
    inlineFn.includes('getBoundingClientRect') && !inlineFn.includes('offsetLeft'))
  const anchorFn = src.slice(src.indexOf('function usageTipAnchorOf'), src.indexOf('function usageTipInlineOffsetX'))
  ok('013 内联位移对「矩形对象缺失」也回 0（getBoundingClientRect 返回 null 时不能读 .left）',
    inlineFn.includes('const svgRect = svgElement.getBoundingClientRect()')
      && inlineFn.includes('const scrollRect = scrollElement.getBoundingClientRect()')
      && inlineFn.includes('typeof svgRect !== "object"')
      && inlineFn.includes('typeof scrollRect !== "object"'))
  ok('013 usageTipAnchorOf 只认 typeof number（Number(null)/Number("") 会被当成 0）',
    anchorFn.includes('typeof value !== "number"') && !anchorFn.includes('Number(value)'))
  ok('013 柱子子树的 memo 依赖里不含 tipIndex（浮层不进无障碍树，指针移动不重画柱子）',
    /\}, \[buckets, step, barWidth, peak, tallest, threeD, copy, chartKey, base, height, labelStep, width\]\);/.test(src))
  const internalsStart013 = src.lastIndexOf('__internals = {')
  const internals013 = src.slice(internalsStart013, src.indexOf('exports.apply', internalsStart013))
  ok('013 __internals 追加 usageHitRateBase 与两个浮层坐标纯函数',
    ['usageHitRateBase', 'usageTipAnchorOf', 'usageTipInlineOffsetX']
      .every(name => new RegExp('\\b' + name + '\\b').test(internals013)))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1