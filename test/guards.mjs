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
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertFixture, makeSnapshot } from '../scripts/shots/fixture.mjs'
import { findLineRefs } from '../scripts/check-refs.mjs'
import { classifyTarget, extractImageTargets, extractLinkTargets, normalizeTarget } from '../scripts/link-targets.mjs'
import { compareHosts, deriveHostsFromCode } from '../scripts/outbound-hosts.mjs'
import { __internals } from '../lib/index.js'

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
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1