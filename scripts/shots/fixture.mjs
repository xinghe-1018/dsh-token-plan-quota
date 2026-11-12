/**
 * README 截图用的**合成** snapshot 构造器。
 *
 * 为什么存在：四张图要展示真实长相，但绝不能出现真实数字（余额、到期日、本机路径）。
 * 做法是在浏览器侧拦下 `/token-plan-quota/summary` 的响应换成这里造的数据，
 * 所以这里产出的形状必须**等于 `publicCard()` 之后的最终 payload**。
 *
 * 两条硬约束（都来自源码，违反就会拍出「不像真的」或自打嘴巴的图）：
 *  1. 键必须 ⊆ `lib/index.js` 里 `publicCard()` 的白名单 —— 运行时读出来比对，
 *     以后加字段会立刻报错，而不是悄悄拍出一张宿主永远不会发出的图。
 *  2. 百分比是**派生值**：`finalizeCard()`/`finalizeMeter()`（`lib/index.js:2004-2042`）
 *    从 `{remaining,total}` 算出 `usedPercent`/`remainingPercent`，且实测卡走
 *     `allowPercent=false` 一律不写。所以这里跑同一套取整公式，绝不手写百分比。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_JS = join(HERE, '..', '..', 'lib', 'index.js')

/**
 * 与宿主逐字对齐的取整：`lib/index.js:87-90` 是 `Math.round(value * 1e4) / 1e4`（**4 位**）。
 * 这里必须同公式同位数，否则"百分比与 remaining 自洽"的断言会拿自己的口径去验自己，
 * 拍出的图与宿主真实发不出的值差在小数位上。
 */
const round = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(value * 1e4) / 1e4
}

/**
 * 从 `lib/index.js` 里读出 `publicCard()` 的字段白名单。
 * @returns {string[]} 允许的键。
 */
export function publicCardKeys() {
  const text = readFileSync(INDEX_JS, 'utf8')
  const start = text.indexOf('function publicCard(')
  if (start < 0) throw new Error('lib/index.js 里找不到 publicCard()，白名单守卫失效')
  // 只取那个数组字面量本身：整段多切几百字符会把下一个函数的字符串也读成"合法键"，守卫就虚了。
  const open = text.indexOf('[', start)
  const close = text.indexOf(']', open)
  if (open < 0 || close < 0) throw new Error('publicCard() 的字段数组读不出来，白名单守卫失效')
  const block = text.slice(open, close)
  const keys = []
  for (const literal of block.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)) {
    if (!keys.includes(literal[1])) keys.push(literal[1])
  }
  // 白名单至少要有这几个核心键，读法失效时宁可报错也不要放过。
  for (const must of ['id', 'remaining', 'meters', 'bindProviders', 'estimated']) {
    if (!keys.includes(must)) throw new Error(`publicCard() 白名单读出异常：缺 ${must}`)
  }
  return keys
}

/**
 * 复刻 `finalizeMeter()`：只有官方卡派生百分比，实测卡连字段都不出现。
 * @param {object} meter 原始计量（`{key,label,labelEn,unit,total,remaining,resetAt}`）。
 * @param {boolean} allowPercent 该卡是否官方真值。
 */
function finalizeMeter(meter, allowPercent) {
  const out = { ...meter }
  if (typeof out.total === 'number' && out.total > 0 && typeof out.remaining === 'number') {
    const used = Math.max(0, out.total - out.remaining)
    out.used = round(used)
    if (allowPercent) {
      out.usedPercent = round(Math.min(9999, (used / out.total) * 100))
      out.remainingPercent = round(Math.max(0, Math.min(100, (1 - used / out.total) * 100)))
    }
  }
  return out
}

/** 复刻 `finalizeCard()` 的顶层派生（meters 之后再单条派生）。 */
function finalizeCard(card, allowPercent) {
  const out = { ...card }
  if (typeof out.total === 'number' && out.total > 0 && typeof out.remaining === 'number') {
    const used = Math.max(0, out.total - out.remaining)
    out.used = round(used)
    if (allowPercent) {
      out.usedPercent = round(Math.min(9999, (used / out.total) * 100))
      out.remainingPercent = round(Math.max(0, Math.min(100, (1 - used / out.total) * 100)))
    }
  }
  if (Array.isArray(out.meters)) out.meters = out.meters.map(meter => finalizeMeter(meter, allowPercent))
  return out
}

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * 「没有流量」的吞吐块。三连图要拍的是静态额度状态，面板那行 `— · 近 60 秒 0 · 近 5 分 0/0`
 * 必须和真实空载一致，不能让背景里飘着一串编造的高吞吐。
 */
function quietThroughput(now) {
  const zero = {
    tpm60: 0, out60: 0, calls60: 0, cacheRead60: 0,
    tokens300: 0, calls300: 0, activeMs300: 0, activeOut300: 0,
    genTps: 0, outTps60: 0, activeSeconds: 0,
  }
  return { ...zero, byProvider: [], lastAt: now - 40 * MINUTE, lastTps: 0, lastTpsAt: now - 40 * MINUTE }
}

/**
 * 一张官方钱卡：DeepSeek `/user/balance`（真值、无分母 ⇒ 无条）。
 */
function deepseekMoneyCard(lang, now) {
  return finalizeCard({
    id: 'deepseek-balance',
    label: lang === 'en' ? 'DeepSeek balance' : 'DeepSeek 余额',
    metric: 'money',
    unit: 'CNY',
    remaining: 1234.56,
    extra: { toppedUp: 2000.00, granted: 100.25 },
    veracity: 'verified',
    sourceNote: lang === 'en'
      ? 'DeepSeek official API (Bearer Key) · /user/balance'
      : 'DeepSeek 官方 API（Bearer Key）· /user/balance',
    bindProviders: ['deepseek-official'],
    updatedAt: now - 12_000,
  }, true)
}

/** 官方多窗口卡：千问 Token Plan 控制台（两条窗口都有读数）。 */
function consoleCard(lang, now) {
  const weekly = {
    key: 'weekly', label: '7 天窗口', labelEn: '7-day window', unit: 'Credits',
    total: 70000, remaining: 53600, resetAt: now + 5 * DAY + 3 * HOUR,
  }
  const fiveHour = {
    key: 'fiveHour', label: '5 小时窗口', labelEn: '5-hour window', unit: 'Credits',
    total: 1200, remaining: 900, resetAt: now + 2 * HOUR,
  }
  // 顶层 = 主计量 = 先 weekly 后 meters[0]（源码 :1660 的排序契约）。
  return finalizeCard({
    id: 'token-plan-console',
    label: lang === 'en' ? 'Qwen Token Plan' : '千问 Token Plan',
    metric: 'credits',
    unit: 'Credits',
    total: weekly.total,
    remaining: weekly.remaining,
    expiresAt: weekly.resetAt,
    resetAt: weekly.resetAt,
    items: [],
    meters: [weekly, fiveHour],
    extra: {
      usedPercent: 23,
      specCode: 'standard',
      planRemainingDays: 88,
      planEndsAt: now + 88 * DAY,
      addonTotal: 20000,
      fiveHourTotal: 1200,
      fiveHourUsedPercent: 25,
      fiveHourResetAt: fiveHour.resetAt,
    },
    veracity: 'verified',
    sourceNote: lang === 'en'
      ? 'Qwen console data gateway (Cookie session, sec_token auto-fetched) · tokenplan/personal/api/v2'
      : '千问AI平台控制台数据网关（Cookie 会话，sec_token 自动获取）· tokenplan/personal/api/v2',
    bindProviders: ['qwen-token-plan-cn'],
    updatedAt: now - 20_000,
  }, true)
}

/** 实测卡：没有官方分母 ⇒ 连 usedPercent/remainingPercent 都不该存在。 */
function measuredCard(lang, now, provider, calls, tokens) {
  return finalizeCard({
    id: `window:${provider}`,
    // 与宿主同形：`window:<provider>` 的标签就是供应商名，「实测」由 pill 标
    // （lib/index.js 的 shorthand 分支 + client.js:639/770）。
    label: provider,
    metric: 'tokens',
    unit: 'tok',
    estimated: true,
    veracity: 'local',
    tokens,
    calls,
    windowDays: 7,
    startedAt: now - 2 * DAY,
    resetAt: now + 5 * DAY,
    remainingDays: 5,
    items: [],
    detected: { by: 'fallback-window', fallback: true },
    bindProviders: [provider],
    sourceNote: lang === 'en'
      ? 'Local ledger: this DSH instance only, no official denominator'
      : '本实例实测账目：只覆盖经过本实例的调用，没有官方分母',
  }, false)
}

/**
 * 官方 Credits 额度卡（单窗口、无 meters）：Token Plan 那种「剩余 X / Y · 已用 Z% · 周期重置」。
 * 与 consoleCard 的区别是这里只有一个总窗口，所以面板里不会出现计量条列表。
 * 数字与真实账号无关：4,480 / 6,000 是随手取的合成值 —— 但**余量必须 ≥70%**：
 * 渐变条的配色是 `client.js:218-222` 写死的档位（≥70 绿 / 40–70 蓝 / <40 橙红），
 * 取 69% 会拍出一条蓝条子，看着就像插件坏了。
 */
function creditsPlanCard(lang, now) {
  return finalizeCard({
    id: 'token-plan-credits',
    label: lang === 'en' ? 'Token Plan' : 'Token Plan 余量',
    metric: 'credits',
    unit: 'Credits',
    total: 6000,
    remaining: 4480,
    expiresAt: now + 7 * DAY + 2 * HOUR,
    resetAt: now + 7 * DAY + 2 * HOUR,
    items: [],
    veracity: 'verified',
    sourceNote: lang === 'en'
      ? 'Qwen console data gateway (Cookie session, sec_token auto-fetched) · tokenplan/personal/api/v2'
      : '千问AI平台控制台数据网关（Cookie 会话，sec_token 自动获取）· tokenplan/personal/api/v2',
    bindProviders: ['qwen-token-plan-cn'],
    updatedAt: now - 20_000,
  }, true)
}

/**
 * 「这个供应商本实例还没调用过」的实测卡 —— 逐字照 `lib/index.js:357-380` 在
 * `startedAt === undefined` 分支产出的形状：tokens/calls/startedAt/resetAt/remainingDays
 * **全部缺席**（不是 0）。这决定了两件事：徽标走 `cardValueText()` 的 `noData` 分支
 * 显示「无官方额度数据」（`client.js:187`），面板只显示那句解释而不是「0 tok」。
 * 写成 tokens:0 会拍出一个宿主永远不会发出的样子。
 */
function noHistoryCard(lang, provider) {
  return finalizeCard({
    id: `window:${provider}`,
    // 与宿主同形：`window:<provider>` 的标签就是供应商名，「实测」由 pill 标
    // （lib/index.js 的 shorthand 分支 + client.js:639/770）。
    label: provider,
    metric: 'tokens',
    unit: 'tokens',
    estimated: true,
    windowDays: 7,
    items: [],
    veracity: 'local',
    detected: { by: 'fallback-window', fallback: true },
    bindProviders: [provider],
    sourceNote: lang === 'en'
      ? 'Local ledger: this DSH instance only, no official denominator'
      : '本实例实测账目：只覆盖经过本实例的调用，没有官方分母',
    emptyReason: '本实例还没有该供应商的调用记录（实测窗口从经过本实例的第一次调用起算）',
  }, false)
}

/**
 * 造一份完整 snapshot。
 * @param {object} options
 * @param {number} [options.now] 基准时间（相对时间全靠它，过几秒重拍不会「剩5d」变「剩4.9d」）。
 * @param {'panel'|'float'|'cookieDrop'|'badgeSwitch'|'triptych'} [options.variant]
 * @param {'zh'|'en'} [options.lang]
 * @returns {object} 与 `/token-plan-quota/summary` 等形的 payload。
 */
export function makeSnapshot(options = {}) {
  const now = options.now ?? Date.now()
  const variant = options.variant ?? 'panel'
  const lang = options.lang ?? 'zh'

  const cards = [deepseekMoneyCard(lang, now), consoleCard(lang, now)]
  if (variant === 'badgeSwitch') {
    // ① 的两家：DeepSeek 官方钱卡 + openai 实测卡（OpenAI 无官方额度接口，
    // 所以切过去必须看到「实测」，这正是在演示 README 的立场，不是凑数）。
    cards.push(measuredCard(lang, now, 'openai', 1286, 847_000))
  } else if (variant === 'cookieDrop') {
    // ④：控制台 Cookie 会话掉线 —— 官方卡变错误卡且**不带任何数字**，
    // 否则 dropShadowedMeasured() 会把兜底实测卡收掉、徽标变空白。
    // 注意是「替换」那张健康控制台卡：留着它会出现两张同 id 卡（React key 撞车，
    // 且画面自相矛盾——同一源既正常又掉线）。
    const dead = consoleCard(lang, now)
    dead.error = lang === 'en'
      ? 'Cookie session expired (HTTP 401) — re-login to the console, then refresh'
      : 'Cookie 会话已失效（HTTP 401）—— 重新登录控制台后再刷新'
    dead.errorCode = 'cookie-expired'
    dead.hint = lang === 'en' ? 'Sources that need a console cookie are read-only and never auto-relogin.' : '需要控制台 Cookie 的源一律只读，不会自动重新登录。'
    for (const key of ['total', 'remaining', 'used', 'usedPercent', 'remainingPercent', 'meters', 'expiresAt', 'resetAt']) delete dead[key]
    cards.splice(1, 1, dead)
    cards.push(measuredCard(lang, now, 'qwen-token-plan-cn', 4521, 1_234_500))
  } else {
    cards.push(measuredCard(lang, now, 'openai', 1286, 847_000))
  }

  /**
   * 「三种状态」三连图：面板只留当前供应商那一张卡（`panelScope:'current'`，
   * 判定在 `client.js:979`），所以这里整体换掉卡集 —— 官方钱卡 / 官方 Credits 卡 /
   * 零调用实测卡，分别对应「按钱计费的也能识别」「用过的模型会显示额度」
   * 「没用过的模型不显示额度」。吞吐同时清零：拍的是静态额度状态，
   * 背景里不该飘着一串编造的高吞吐。
   */
  const triptych = variant === 'triptych'
  if (triptych) {
    cards.length = 0
    cards.push(deepseekMoneyCard(lang, now), creditsPlanCard(lang, now))
    // 第三张（零调用实测卡）只进中文套：`emptyReason` 是 `lib/index.js:376` 写死的中文，
    // 宿主在英文界面下同样只会吐这一句。给英文套编一句英文文案，等于拍一张
    // 宿主永远发不出的图 —— 宁可少一张。i18n 缺口记在 ROADMAP。
    if (lang === 'zh') cards.push(noHistoryCard(lang, 'minimax-cn'))
  }

  return {
    generatedAt: now,
    refreshMinutes: 5,
    pollSeconds: 30,
    endpoint: 'https://api.deepseek.com',
    credentials: { configured: true, accessKeyId: 'DEEPSEEK_API_KEY', from: 'credentials', missing: null },
    config: {
      file: '~/.dsh/token-plan-quota.json',
      fileExists: true,
      fileError: null,
      debug: false,
      showInstanceWindow: true,
      panelScope: triptych ? 'current' : 'all',
      sources: cards.map(card => ({
        id: card.id, label: card.label, kind: 'single', type: 'http', action: null, version: null,
        params: {}, keywords: [], providers: card.bindProviders ?? [], region: null,
        detected: card.detected ?? null, windowDays: card.windowDays ?? null, sourceNote: card.sourceNote ?? null,
      })),
    },
    stats: { calls: 5807, errors: 0, lastAttemptAt: now - 12_000 },
    throughput: triptych ? quietThroughput(now) : {
      tpm60: 41_800, out60: 9_400, calls60: 14, cacheRead60: 21_600,
      tokens300: 196_500, calls300: 61, activeMs300: 41_200, activeOut300: 1_730,
      genTps: 42, outTps60: 156, activeSeconds: 41,
      byProvider: [
        { provider: 'deepseek-official', model: 'deepseek-v4-flash', genTps: 42, outTps60: 51, tpm60: 28_400, out60: 6_100, calls60: 9, tokens300: 121_000, calls300: 34, activeMs300: 28_900, activeOut300: 1_210, lastAt: now - 9_000, lastTps: 44, lastTpsAt: now - 9_000 },
        { provider: 'openai', model: 'gpt-5', genTps: 31, outTps60: 38, tpm60: 13_400, out60: 3_300, calls60: 5, tokens300: 75_500, calls300: 27, activeMs300: 12_300, activeOut300: 520, lastAt: now - 26_000, lastTps: 33, lastTpsAt: now - 26_000 },
      ],
    },
    detection: {
      enabled: true, reason: null,
      routes: ['deepseek-official → api.deepseek.com', 'openai → api.openai.com'],
      // 从卡集派生，别再手写一遍：换变体时这里最容易和 cards 对不上。
      added: cards.filter(card => !card.estimated).map(card => ({
        id: card.id,
        providers: card.bindProviders ?? [],
        by: card.id === 'deepseek-balance' ? 'baseURL' : 'routeId',
        region: null,
      })),
      skipped: [], uncovered: [],
    },
    notices: [],
    cards,
  }
}


/* ------------------------------------------- 006「用量统计」整页屏（/usage） */

/**
 * /token-plan-quota/usage 的响应 fixture（INTERFACE 见 specs/006-usage-stats/INTERFACE.md §2）。
 *
 * 为什么单独造：整页屏读的不是 summary，而是 GET /token-plan-quota/usage 的聚合结果。
 * 这里必须**复刻聚合口径**（lib/usage-stats.js 的 aggregateUsageRange），而不是随手糊几个数：
 * 屏上的总分、每根柱、模型行是同一个 totals 的三层视图，三层对不上就会拍出一张"宿主永远发不出"的图。
 *
 * 三条与宿主同源的规则：
 *  1. 桶 totals 有 7 个键（四类 + calls + steps + tokens），steps === calls；
 *  2. 桶内 models 是**原始计数 map**（5 个键，没有 steps/tokens），顶层 models[].totals 才是 7 键；
 *  3. 粒度 days > 62 → week，周桶以**本地周一**为界、不重叠不留缝。
 *
 * 语言：响应里只有 source.label 是宿主写死的中文（lib/index.js 的 buildUsageSnapshot），
 * 而客户端**根本不渲染它**；屏上其余文字全部来自客户端 COPY。所以英文套不需要另造一份，
 * 但 assertUsageSnapshot({lang:'en'}) 仍会检查所有**会被渲染**的字符串里没有中文。
 */

const USAGE_TOP_KEYS = [
  'generatedAt', 'enabled', 'range', 'granularity', 'totals',
  'buckets', 'models', 'source', 'coverage', 'refreshing', 'emptyReason', 'hint',
]
const USAGE_TOTAL_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'steps', 'tokens']
const USAGE_MODEL_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']
const USAGE_RANGE_KEYS = ['kind', 'days', 'from', 'to']

/** 宿主写死的三个 source.label（lib/index.js buildUsageSnapshot 的常量）。 */
const USAGE_SOURCE_LABELS = {
  index: '本实例实测（来自本地会话记录）',
  live: '本进程启动以来（实测）',
  disabled: '用量统计已关闭',
}

/** 与 lib/usage-stats.js 同值：超过 62 天按周聚合。 */
const USAGE_WEEK_THRESHOLD_DAYS = 62

const pad2 = value => String(value).padStart(2, '0')

/** 本地日期 → YYYY-MM-DD（与 lib/usage-stats.js 的 dayKey 同口径）。 */
function usageDayKey(date) {
  return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join('-')
}

function usageParseDay(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function usageAddDays(key, delta) {
  const date = usageParseDay(key)
  date.setDate(date.getDate() + delta)
  return usageDayKey(date)
}

/** 本地周一（(getDay()+6)%7，与 weekStartKey 同口径）。 */
function usageMondayOf(key) {
  const date = usageParseDay(key)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return usageDayKey(date)
}

function usageIsDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function clampUsageDays(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 7
  const rounded = Math.round(num)
  if (rounded < 1) return 1
  if (rounded > 365) return 365
  return rounded
}

/** totalsOf（lib/usage-stats.js 同公式）：tokens = 四类之和，steps = calls。 */
function usageTotals(counters) {
  return {
    input: counters.input,
    output: counters.output,
    cacheRead: counters.cacheRead,
    cacheWrite: counters.cacheWrite,
    calls: counters.calls,
    steps: counters.calls,
    tokens: counters.input + counters.output + counters.cacheRead + counters.cacheWrite,
  }
}

function usagePlainCounters(counters) {
  return {
    input: counters.input,
    output: counters.output,
    cacheRead: counters.cacheRead,
    cacheWrite: counters.cacheWrite,
    calls: counters.calls,
  }
}

function usageAddInto(target, source) {
  for (const key of USAGE_MODEL_KEYS) target[key] += source[key]
  return target
}

function usageEmptyCounters() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
}

/**
 * 模型配比：id 与宿主 fixture 的模型目录对得上（deepseek / qwen-token-plan-cn / openai），
 * 这样「用量统计」里的模型名与其它截图里的当前模型不会互相打脸。
 */
const USAGE_MODEL_MIX = [
  { provider: 'deepseek', model: 'deepseek-v4-flash', weight: 0.58 },
  { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', weight: 0.27 },
  { provider: 'openai', model: 'gpt-5', weight: 0.15 },
]

/**
 * 某一天的计数。用「桶序号」而不是真实日期派生：同一组 --shots 反复跑会得到相同的柱形，
 * 不会因为换个星期几就变成另一张图。全部整数、四类之和就是当天 tokens。
 */
function usageDayCounters(index) {
  const tokens = 980_000 + ((index * 37) % 9) * 118_000 + ((index * 53) % 5) * 23_000
  const input = Math.round(tokens * 0.57)
  const output = Math.round(tokens * 0.13)
  const cacheRead = Math.round(tokens * 0.24)
  const cacheWrite = tokens - input - output - cacheRead
  const calls = 96 + ((index * 29) % 7) * 23
  return { input, output, cacheRead, cacheWrite, calls }
}

/** 把一天的四类计数按固定配比拆到各模型，取整后余数归最后一个（保证逐字段求和相等）。 */
function usageSplitByModel(counters) {
  const out = {}
  for (const one of USAGE_MODEL_MIX) out[one.provider + '/' + one.model] = usageEmptyCounters()
  for (const field of USAGE_MODEL_KEYS) {
    let assigned = 0
    USAGE_MODEL_MIX.forEach((one, index) => {
      const id = one.provider + '/' + one.model
      const value = index === USAGE_MODEL_MIX.length - 1
        ? counters[field] - assigned
        : Math.round(counters[field] * one.weight)
      out[id][field] = value
      assigned += value
    })
  }
  return out
}

/**
 * 造一份 /usage?days=N 的响应。
 * @param {{now?: number, days?: number}} [options]
 * @returns {object} 与 lib/index.js buildUsageSnapshot 同形的 payload。
 */
export function makeUsageSnapshot(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const days = clampUsageDays(options.days)
  const to = usageDayKey(new Date(now))
  const from = usageAddDays(to, -(days - 1))
  const granularity = days > USAGE_WEEK_THRESHOLD_DAYS ? 'week' : 'day'

  // 逐日计数只覆盖区间内（与 aggregateUsageRange 一致：周桶跨到 from 之前的周一，但不累计 from 之前的天）。
  const perDay = new Map()
  let index = 0
  for (let key = from; key <= to; key = usageAddDays(key, 1)) {
    perDay.set(key, usageDayCounters(index))
    index += 1
  }

  const specs = []
  if (granularity === 'day') {
    for (const key of perDay.keys()) specs.push({ from: key, to: key })
  } else {
    let cursor = from
    while (cursor <= to) {
      const startKey = usageMondayOf(cursor)
      const weekEnd = usageAddDays(startKey, 6)
      const endKey = weekEnd > to ? to : weekEnd
      specs.push({ from: startKey, to: endKey })
      cursor = usageAddDays(endKey, 1)
    }
  }

  const buckets = specs.map(spec => {
    const counters = usageEmptyCounters()
    const models = {}
    for (const [key, day] of perDay) {
      if (key < spec.from || key > spec.to) continue
      usageAddInto(counters, day)
      for (const [id, part] of Object.entries(usageSplitByModel(day))) {
        models[id] = usageAddInto(models[id] ?? usageEmptyCounters(), part)
      }
    }
    return {
      from: spec.from,
      to: spec.to,
      label: spec.from.slice(5),
      totals: usageTotals(counters),
      models: Object.fromEntries(Object.entries(models).map(([id, part]) => [id, usagePlainCounters(part)])),
    }
  })

  const rangeCounters = usageEmptyCounters()
  for (const day of perDay.values()) usageAddInto(rangeCounters, day)

  const modelAir = new Map()
  for (const bucket of buckets) {
    for (const [id, part] of Object.entries(bucket.models)) {
      modelAir.set(id, usageAddInto(modelAir.get(id) ?? usageEmptyCounters(), part))
    }
  }
  const models = [...modelAir.entries()]
    .map(([id, counters]) => {
      const slash = id.indexOf('/')
      return {
        id,
        provider: slash === -1 ? 'unknown' : id.slice(0, slash),
        model: slash === -1 ? id : id.slice(slash + 1),
        totals: usageTotals(counters),
      }
    })
    .sort((a, b) => (b.totals.tokens - a.totals.tokens) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    generatedAt: now,
    enabled: true,
    range: { kind: days === 1 ? 'today' : days + 'd', days, from, to },
    granularity,
    totals: usageTotals(rangeCounters),
    buckets,
    models,
    // 拍图时宿主一定走 session-index（fixture 模式没有持久化层也是同一条 kind 分支）；
    // 不能写 live/in-process：那样屏上会少掉「本实例实测」的来源语义。
    source: { kind: 'session-index', veracity: 'measured', label: USAGE_SOURCE_LABELS.index },
    // indexed === sessions > 0：否则客户端会判定"正在回填"，图上多一条进度条。
    coverage: { sessions: 34, indexed: 34, failed: 0, unknownModel: 1, skippedOld: 0 },
    refreshing: false,
  }
}

/**
 * /usage fixture 的自检：三层 totals 恒等、日期连续、周桶对齐周一、白名单、无百分比/Credits、
 * 无真实痕迹。任何一条不过就不该拍照。
 * @param {object} usage makeUsageSnapshot 的产物
 * @param {{lang?: 'zh'|'en', days?: number}} [options]
 * @returns {string[]} 通过的断言说明（抛错表示不通过）
 */
export function assertUsageFixture(usage, options = {}) {
  const checks = []
  const need = (label, cond) => {
    if (!cond) throw new Error('usage fixture 自检失败：' + label)
    checks.push(label)
  }
  const days = clampUsageDays(options.days)
  const allowed = new Set(USAGE_TOP_KEYS)
  for (const key of Object.keys(usage)) need('顶层键 ' + key + ' ⊆ /usage 白名单', allowed.has(key))

  need('generatedAt 是毫秒时间戳', isClockMillis(usage.generatedAt))
  need('enabled 为 true（否则屏上是关闭态）', usage.enabled === true)
  need('refreshing 为 false（否则屏上多一条回填进度条）', usage.refreshing === false)
  need('不带 emptyReason（否则屏上是空态而不是数字）', usage.emptyReason === undefined)
  need('不带 hint', usage.hint === undefined)
  need('coverage.indexed === coverage.sessions > 0（不回填）',
    usage.coverage.sessions > 0 && usage.coverage.indexed === usage.coverage.sessions)

  need('range 键集正确',
    JSON.stringify(Object.keys(usage.range).sort()) === JSON.stringify([...USAGE_RANGE_KEYS].sort()))
  need('range.days 与请求一致', usage.range.days === days)
  need('range.kind 与天数一致', usage.range.kind === (days === 1 ? 'today' : days + 'd'))
  need('range.from 是日期', usageIsDayKey(usage.range.from))
  need('range.to 是日期', usageIsDayKey(usage.range.to))
  need('range.from = to - (days-1)', usageAddDays(usage.range.to, -(days - 1)) === usage.range.from)
  const expectGranularity = days > USAGE_WEEK_THRESHOLD_DAYS ? 'week' : 'day'
  need('granularity 为 ' + expectGranularity, usage.granularity === expectGranularity)

  const expectTotalKeys = JSON.stringify([...USAGE_TOTAL_KEYS].sort())
  need('totals 键集 = 四类 + calls/steps/tokens', JSON.stringify(Object.keys(usage.totals).sort()) === expectTotalKeys)
  need('totals.tokens = 四类之和',
    usage.totals.tokens === usage.totals.input + usage.totals.output + usage.totals.cacheRead + usage.totals.cacheWrite)
  need('totals.steps === totals.calls', usage.totals.steps === usage.totals.calls)
  for (const key of USAGE_TOTAL_KEYS) {
    need('totals.' + key + ' 是非负整数', Number.isInteger(usage.totals[key]) && usage.totals[key] >= 0)
  }
  need('区间里有调用（否则屏上是空态）', usage.totals.calls > 0)

  need('buckets 非空', Array.isArray(usage.buckets) && usage.buckets.length > 0)
  if (expectGranularity === 'day') need('日桶数 = ' + days, usage.buckets.length === days)

  const bucketTotals = usageEmptyCounters()
  const modelTotals = new Map()
  for (let index = 0; index < usage.buckets.length; index += 1) {
    const bucket = usage.buckets[index]
    const label = '桶 ' + bucket.from
    need(label + ' 的键集正确',
      JSON.stringify(Object.keys(bucket).sort()) === JSON.stringify(['from', 'label', 'models', 'to', 'totals'].sort()))
    need(label + ' from/to 是日期', usageIsDayKey(bucket.from) && usageIsDayKey(bucket.to))
    need(label + ' 的 label = MM-DD', bucket.label === bucket.from.slice(5))
    need(label + ' 的键集 = 7 键', JSON.stringify(Object.keys(bucket.totals).sort()) === expectTotalKeys)
    need(label + ' tokens = 四类之和',
      bucket.totals.tokens === bucket.totals.input + bucket.totals.output + bucket.totals.cacheRead + bucket.totals.cacheWrite)
    need(label + ' steps === calls', bucket.totals.steps === bucket.totals.calls)

    if (expectGranularity === 'day') {
      need(label + ' 是单日桶', bucket.from === bucket.to)
      const expectFrom = index === 0 ? usage.range.from : usageAddDays(usage.buckets[index - 1].to, 1)
      need(label + ' 与前一桶日连续', bucket.from === expectFrom)
    } else {
      need(label + ' 起点是周一', usageParseDay(bucket.from).getDay() === 1)
      need(label + ' 终点不早于起点', bucket.to >= bucket.from)
      need(label + ' 终点不超过周日', usageAddDays(bucket.from, 6) >= bucket.to)
      if (index === 0) {
        need(label + ' 覆盖区间起点', bucket.from <= usage.range.from && bucket.to >= usage.range.from)
      } else {
        need(label + ' 与前一桶周连续', bucket.from === usageAddDays(usage.buckets[index - 1].to, 1))
      }
    }
    if (index === usage.buckets.length - 1) need(label + ' 覆盖区间终点', bucket.to === usage.range.to)

    need(label + ' 有模型明细', Object.keys(bucket.models).length > 0)
    const bucketModelTotals = usageEmptyCounters()
    for (const [id, part] of Object.entries(bucket.models)) {
      need(label + ' 的模型 id ' + id + ' 是 provider/model', id.includes('/'))
      need(label + '/' + id + ' 的键集 = 5 个原始计数',
        JSON.stringify(Object.keys(part).sort()) === JSON.stringify([...USAGE_MODEL_KEYS].sort()))
      for (const key of USAGE_MODEL_KEYS) {
        need(label + '/' + id + '.' + key + ' 是非负整数', Number.isInteger(part[key]) && part[key] >= 0)
      }
      usageAddInto(bucketModelTotals, part)
      if (!modelTotals.has(id)) modelTotals.set(id, usageEmptyCounters())
      usageAddInto(modelTotals.get(id), part)
    }
    for (const key of USAGE_MODEL_KEYS) {
      need(label + ' 的 models 之和 = 桶 totals.' + key, bucketModelTotals[key] === bucket.totals[key])
      bucketTotals[key] += bucket.totals[key]
    }
  }
  for (const key of USAGE_MODEL_KEYS) {
    need('桶 totals 之和 = 区间 totals.' + key, bucketTotals[key] === usage.totals[key])
  }

  need('models 至少三条', Array.isArray(usage.models) && usage.models.length >= 3)
  const topTotals = usageEmptyCounters()
  let previous = null
  for (const model of usage.models) {
    need('模型 ' + model.id + ' 的字段集正确',
      JSON.stringify(Object.keys(model).sort()) === JSON.stringify(['id', 'model', 'provider', 'totals']))
    need('模型 ' + model.id + ' 的 id = provider/model', model.id === model.provider + '/' + model.model)
    need('模型 ' + model.id + ' 的 totals 键集 = 7 键',
      JSON.stringify(Object.keys(model.totals).sort()) === expectTotalKeys)
    need('模型 ' + model.id + ' tokens = 四类之和',
      model.totals.tokens === model.totals.input + model.totals.output + model.totals.cacheRead + model.totals.cacheWrite)
    for (const key of USAGE_MODEL_KEYS) {
      need('模型 ' + model.id + ' 与桶明细之和一致（' + key + '）',
        model.totals[key] === (modelTotals.get(model.id) ?? {})[key])
      topTotals[key] += model.totals[key]
    }
    if (previous !== null) {
      need('模型按 tokens 降序（' + previous.id + ' ≥ ' + model.id + '）',
        previous.totals.tokens > model.totals.tokens
        || (previous.totals.tokens === model.totals.tokens && previous.id <= model.id))
    }
    previous = model
  }
  for (const key of USAGE_MODEL_KEYS) {
    need('模型 totals 之和 = 区间 totals.' + key, topTotals[key] === usage.totals[key])
  }

  need('source.kind 是 session-index', usage.source.kind === 'session-index')
  need('source.veracity 是 measured', usage.source.veracity === 'measured')
  need('source.label 是宿主三个常量之一', Object.values(USAGE_SOURCE_LABELS).includes(usage.source.label))

  // 屏上不许出现百分比 / Credits（INTERFACE §2 验收：文案里没有 %，脚注明说"不折算 Credits"）。
  const strings = collectLeaves(usage).filter(value => typeof value === 'string')
  need('没有百分比字符串', strings.every(value => !value.includes('%')))
  need('没有 Credits 字样的数据串', strings.every(value => !/credits/i.test(value)))
  // 日期串按口径豁免：区间的 from/to/label 是从"今天"倒推出来的，任何固定禁用日期
  // （2026-09-14 是用户实拍图里的真实到期日）在足够长的区间里都会作为普通日历标签出现。
  // 这个禁用串要防的是"某个固定字段把真实日期抄进图里"，不是滚动区间自己算出来的日期。
  // 真实痕迹仍逐条扫模型 id / provider / 文案等非日期字符串。
  const nonDateStrings = strings.filter(value => !/^\d{4}-\d{2}-\d{2}$/.test(value))
  for (const banned of BANNED_TRACES) {
    const hit = nonDateStrings.find(value => value.includes(banned))
    need('不含真实痕迹 ' + JSON.stringify(banned) + (hit === undefined ? '' : '（命中 ' + JSON.stringify(hit) + '）'),
      hit === undefined)
  }

  if (options.lang === 'en') {
    // 英文套：只查**会被屏上渲染**的字符串。source.label 是宿主写死的中文且客户端不渲染它，
    // 所以不在这里判 —— 为它编一句英文等于拍一张宿主不会发的图。
    const han = /\p{Script=Han}/u
    const rendered = [
      usage.range.from, usage.range.to,
      ...usage.buckets.map(bucket => bucket.label),
      ...usage.models.flatMap(model => [model.id, model.provider, model.model]),
    ]
    const hit = rendered.find(value => han.test(value))
    need('英文套里被渲染的字符串无中文' + (hit === undefined ? '' : '（命中 ' + JSON.stringify(hit) + '）'),
      hit === undefined)
  }
  return checks
}

/**
 * 用户实拍图里出现过的真实值 —— 那三张图是真实账号，任何"照着抄一组数"的改动都必须被拦住。
 * `assertFixture` 逐个叶值比对它。
 */
const BANNED_TRACES = ['OMEN', '39.91', '9063', '7943', '2026-09-14', 'C:\\', 'D:\\', '/Users/', '.scratch']

/**
 * 时钟量级的整数（毫秒时间戳）。快照里有 **10–16 个**字段由 `now` 派生（随变体而变），
 * 它们**不是**真实痕迹，只是"现在几点"。
 *
 * 豁免必须**两头都有界**，缺一不可：
 *  - **下界** `1e12`：真实痕迹（余额、Credits、token 数、计数）都远在其下；
 *  - **上界** `1e13`：毫秒时间戳落在 2001-09 ~ 2286-11 这个区间里。
 * 没有上界时，像 `17943999999999` 这种 ≥1e12 **且十进制含禁用串**的数字会被一起豁免——
 * 评审 Lens 1 报的就是这个"声明比代码宽"。
 */
const isClockMillis = value => Number.isInteger(value) && Math.abs(value) >= 1e12 && Math.abs(value) < 1e13

/**
 * 收集所有"该拿去比对的值"：叶标量 **加上对象 key**，并把 `Date` / `BigInt` 折成字符串。
 *
 * 为什么这么折：旧实现是 `JSON.stringify(整个对象).includes(banned)`，它与"走内存值"**不同构**——
 * 逐叶扫描会漏掉 key、漏掉 `Date`（没有自有可枚举属性）、并对 `BigInt` 静默放行
 * （旧实现反而因为 `JSON.stringify` 对 BigInt 抛错而"报红"）。评审 Lens 1 三条实测都指这里。
 * 结论：守卫面只许变宽或不变——key 一起收、`Date` 折 ISO 串、`BigInt` 折十进制串。
 */
function collectLeaves(node, out = []) {
  if (Array.isArray(node)) for (const item of node) collectLeaves(item, out)
  else if (node instanceof Date) out.push(node.toISOString())
  else if (typeof node === 'bigint') out.push(String(node))
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key)
      collectLeaves(value, out)
    }
  } else out.push(node)
  return out
}

/**
 * 出图前的自检：任何一条不过就不该拍照——合成物料最怕的就是「看着像真的但其实宿主发不出」
 * 和「把真实数据带回来」。
 * @param {object} snapshot makeSnapshot 的产物
 * @param {{lang?: 'zh'|'en'}} [options] 传了 lang 才会跑对应语言的文案检查。
 * @returns {string[]} 全部通过的断言说明（抛错表示不通过）
 */
export function assertFixture(snapshot, options = {}) {
  const checks = []
  const need = (label, cond) => {
    if (!cond) throw new Error(`fixture 自检失败：${label}`)
    checks.push(label)
  }
  // 逐叶比对，而不是 `JSON.stringify(整个对象).includes(...)`：快照里有 10 个由 `now` 派生的
  // 13 位毫秒时间戳，整段字符串扫描会让 `throughput.byProvider[1].lastAt = now - 26000` 在
  // `now = 1789716103943` 时取到 1789716077943，巧合命中 4 位禁用串（`7943`）。
  // 实测（新旧守卫在同一 now 上配对，模拟 10000 轮 check-docs）：旧守卫整轮假红 1.54%
  // （95% CI 1.32–1.80%；两批合计 187/13000），新守卫 0/13000。CI 每个 PR 都跑这条检查——
  // 假红训练人忽略红灯，比漏检更坏，所以收窄到「值」这一层。
  // 证据与行为矩阵见 specs/003-guardrails-and-doc-hygiene/plan.md 前提 1 与测试计划 T1。
  const allLeaves = collectLeaves(snapshot)
  // 真实痕迹：本机账号、真实余额，以及用户实拍图里出现过的真实额度值 ——
  // 那三张图是真实账号，任何"照着抄一组数"的改动都必须被这里拦住。
  for (const banned of BANNED_TRACES) {
    const hit = allLeaves.find(value => (typeof value === 'string'
      ? value.includes(banned)
      : typeof value === 'number' && !isClockMillis(value) && String(value).includes(banned)))
    need(`不含真实痕迹 ${JSON.stringify(banned)}${hit === undefined ? '' : `（命中 ${JSON.stringify(hit)}）`}`,
      hit === undefined)
  }
  if (options.lang === 'en') {
    // 英文套的图里不能出现中文。宿主确实有几处写死的中文（`emptyReason` 就是），
    // 遇到这种只能把那张卡从英文套里排除，**不能**为了凑图编一句宿主不会发的文案。
    // 带 `xxxEn` 兄弟字段的（`label`/`sourceNote` 之类）按宿主的双语约定跳过 ——
    // 那是宿主自己就同时带着两种语言，客户端才挑一次。
    const han = /\p{Script=Han}/u
    for (const card of snapshot.cards) {
      for (const [key, value] of Object.entries(card)) {
        if (typeof value !== 'string' || !han.test(value)) continue
        if (card[`${key}En`] !== undefined) continue
        throw new Error(`英文套里出现了中文：卡 ${card.id} 的 ${key} = ${JSON.stringify(value.slice(0, 24))}`
          + '（这张卡不该进英文截图，而不是给它编一句英文）')
      }
    }
    checks.push('英文套所有卡字段无中文（宿主单语字段除外）')
  }
  const allowed = new Set(publicCardKeys())
  for (const card of snapshot.cards) {
    for (const key of Object.keys(card)) {
      need(`卡 ${card.id} 的键 ${key} ⊆ publicCard 白名单`, allowed.has(key))
    }
    if (card.estimated === true) {
      need(`实测卡 ${card.id} 不带 remainingPercent`, card.remainingPercent === undefined)
      need(`实测卡 ${card.id} 不带 usedPercent`, card.usedPercent === undefined)
      need(`实测卡 ${card.id} 不带 total（没有官方分母）`, card.total === undefined)
      // 「本实例还没调用过」的卡必须和 `lib/index.js:368-369` 的 undefined 分支同形：
      // 字段整个缺席，不是 0。写成 tokens:0 会拍出一个宿主永远发不出的样子
      // （徽标会变成「0 tok」而不是「无官方额度数据」，见 client.js:187）。
      if (card.emptyReason !== undefined) {
        for (const key of ['tokens', 'calls', 'startedAt', 'resetAt', 'remainingDays']) {
          need(`零记录实测卡 ${card.id} 不带 ${key}（宿主发的是字段缺席）`, card[key] === undefined)
        }
      }
    } else {
      need(`官方卡 ${card.id} 有 veracity`, typeof card.veracity === 'string')
      // 顶层百分比同样是 finalizeCard() 的派生值，必须与 remaining/total 复算一致：
      // 之前只查 meters[]，注入 cards[1].remainingPercent=99 当场漏过（守卫有洞）。
      if (typeof card.total === 'number' && card.total > 0 && typeof card.remaining === 'number') {
        const used = Math.max(0, card.total - card.remaining)
        const expectPct = round(Math.max(0, Math.min(100, (1 - used / card.total) * 100)))
        need(`顶层 ${card.id} remainingPercent 与 remaining/total 自洽`, card.remainingPercent === expectPct)
        const expectUsed = round(Math.min(9999, (used / card.total) * 100))
        need(`顶层 ${card.id} usedPercent 与 remaining/total 自洽`, card.usedPercent === expectUsed)
      } else {
        need(`${card.id} 没有分母就不该有百分比`, card.remainingPercent === undefined && card.usedPercent === undefined)
      }
    }
    for (const meter of card.meters ?? []) {
      if (typeof meter.total === 'number' && typeof meter.remaining === 'number') {
        const used = Math.max(0, meter.total - meter.remaining)
        const expect = round(Math.max(0, Math.min(100, (1 - used / meter.total) * 100)))
        need(`meter ${card.id}/${meter.key} 百分比与 remaining 自洽`, meter.remainingPercent === expect)
      }
    }
  }
  need('面板至少两张官方卡', snapshot.cards.filter(card => card.veracity === 'verified').length >= 2)
  return checks
}
