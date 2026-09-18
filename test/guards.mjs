/**
 * 门禁自身的行为矩阵（离线，不联网）。
 * 运行：node test/guards.mjs
 *
 * 为什么单独一个文件：`AGENTS.md` 与 `workflow/PLAN.md` 都要求"新增或修改机械检查必须做行为矩阵，
 * 并证明它能失败"。矩阵只写在规格文档里会随会话结束而失去约束力，所以这里让两条最容易出错的
 * 门禁各带一份**常驻**矩阵：
 *
 *  - `assertFixture()` 的痕迹守卫（`scripts/shots/fixture.mjs`）——它曾经因**时钟巧合**假红
 *    （见下面 CASE_CLOCK_COINCIDENCE 与 specs/003-guardrails-and-doc-hygiene/plan.md 前提 1）；
 *  - `findLineRefs()` 的行号引用检测（`scripts/check-refs.mjs`）——它靠正则，正则最容易
 *    在"该认的没认"与"不该认的认了"两端同时出错。
 *
 * 两类用例都必须在场：**应报**（不报 = 漏检 = 假安全感）与**应放行**（报了 = 假红 = 训练人忽略红灯）。
 */
import { assertFixture, makeSnapshot } from '../scripts/shots/fixture.mjs'
import { findLineRefs } from '../scripts/check-refs.mjs'

let passed = 0
let failed = 0
function ok(label, condition) {
  if (condition) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}`)
  }
}
function rejects(label, fn) {
  try {
    fn()
    failed += 1
    console.log(`FAIL ${label}\n  期望抛错，实际放行`)
  } catch {
    passed += 1
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

/** 固定基准时间：相对时间全靠它，断言就不会随"跑的那一刻"变。 */
const FIXED_NOW = 1_789_000_000_000
/**
 * 本轮实测到的冲突时刻：此刻 `updatedAt = now - 12000 = 1789716077943`，
 * 它的十进制写法里恰好含有禁用串 `7943`。旧实现把整段 JSON 当字符串找子串，于是**假红**。
 * 这个数字不是编的——它是穷举出来的第一个命中点（plan.md 前提 1）。
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
accepts('fixture 放行时钟巧合时刻（updatedAt 含 7943）',
  () => assertFixture(makeSnapshot({ now: CASE_CLOCK_COINCIDENCE, variant: 'panel', lang: 'zh' })))
// 前提自证：那个时刻的快照 JSON 里**确实**含禁用串。不然上一条会因为"这里根本不冲突"而空转。
ok('前提：时钟巧合时刻的快照 JSON 确实含 7943',
  JSON.stringify(makeSnapshot({ now: CASE_CLOCK_COINCIDENCE, variant: 'panel', lang: 'zh' })).includes('7943'))

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

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1