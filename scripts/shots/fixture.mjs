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

/** 闭区间 [from, to] 的天数（含首尾），与 lib/usage-stats.js 的 dayCount 同口径。 */
function usageCountDays(from, to) {
  const start = usageParseDay(from).getTime()
  const end = usageParseDay(to).getTime()
  // 用 round 而不是整除：夏令时地区会出现 23/25 小时的一天，宿主那边也只按本地日历日数。
  return Math.round((end - start) / 86_400_000) + 1
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

/** 月份字符串（YYYY-MM）的正则 —— 与 lib/usage-stats.js resolveMonthRange 同一判据（010 INTERFACE §1.1）。 */
const USAGE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** 010：range 多出一个 month 字段（INTERFACE §1.2 的整月分支形状）。 */
const USAGE_MONTH_RANGE_KEYS = ['kind', 'month', 'days', 'from', 'to']

/**
 * 010：把 `month` 解析成**夹紧后**的整月区间；不是合法月份返回 null（宿主会回 400 usage-bad-month）。
 *
 * 与 resolveMonthRange 同口径：trim → 格式 → 真实月份（回读年月，防 `0000-01` / `0099-01` 这类
 * `new Date` 把 0–99 当 19xx 的滚年）→ 月份晚于当前月拒绝 → `to` 夹到今天 → `days` 用闭区间天数。
 * 不套用 usageBackfillDays 上界：自然月最多 31 天，本就不受 365 天跨度限制影响。
 */
function usageMonthRange({ now, month }) {
  const text = typeof month === 'string' ? month.trim() : ''
  if (!USAGE_MONTH_PATTERN.test(text)) return null
  const year = Number(text.slice(0, 4))
  const monthIndex = Number(text.slice(5, 7)) - 1
  const probe = new Date(year, monthIndex, 1)
  if (probe.getFullYear() !== year || probe.getMonth() !== monthIndex) return null
  const today = usageDayKey(new Date(now))
  if (text > today.slice(0, 7)) return null
  const from = text + '-01'
  const monthEnd = usageDayKey(new Date(year, monthIndex + 1, 0))
  const to = monthEnd > today ? today : monthEnd
  return { month: text, from, to, days: usageCountDays(from, to) }
}

/**
 * 010：请求里的 month。与宿主 resolveUsageMonth 同判据：
 * 缺省 / **空串**（`?month=`）→ null（退回 days 分支）；只有空白的串**不是**空串，
 * 按§1.1 的 trim→格式 校验会失败，宿主回 400 usage-bad-month —— 这里也让它进校验流程。
 */
function usageMonthArg(options) {
  const raw = options.month
  if (raw === undefined || raw === null) return null
  const text = String(raw)
  if (text === '') return null
  return text.trim()
}

/**
 * 三种查询的统一解析（010 优先级：month > from/to > days，INTERFACE §1.2）。
 *
 * 宿主会把「month 与 from/to 混用」「from/to 只给一端」「month 非法」都收口成 400；
 * fixture 直接抛错 —— 拿别的分支糊过去，会拍出一张"查询条件与数据不一致"的图。
 *
 * @returns {{mode: 'month'|'custom'|'days', from: string, to: string, days: number, month?: string}}
 */
function usageQueryShape(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const month = usageMonthArg(options)
  const hasRange = usageIsDayKey(options.from) || usageIsDayKey(options.to)
  if (month !== null && hasRange) {
    throw new Error('usage fixture：month 与 from/to 混用，宿主会回 400 usage-bad-range，不造图')
  }
  if (month !== null) {
    const resolved = usageMonthRange({ now, month })
    if (resolved === null) {
      throw new Error('usage fixture：month=' + month + ' 不是合法月份或晚于当前月，宿主会回 400 usage-bad-month，不造图')
    }
    return { mode: 'month', from: resolved.from, to: resolved.to, days: resolved.days, month: resolved.month }
  }
  const today = usageDayKey(new Date(now))
  if (hasRange) {
    if (!(usageIsDayKey(options.from) && usageIsDayKey(options.to))) {
      throw new Error('usage fixture：请求只带了 from/to 之一，宿主会回 400，不造图')
    }
    const from = options.from
    const to = options.to > today ? today : options.to
    if (from > to) throw new Error('usage fixture：from 晚于 to（' + from + ' > ' + to + '），宿主会回 400')
    const days = usageCountDays(from, to)
    if (days > 365) throw new Error('usage fixture：区间 ' + days + ' 天超过 usageBackfillDays，宿主会回 400')
    return { mode: 'custom', from, to, days }
  }
  const days = clampUsageDays(options.days)
  const to = today
  return { mode: 'days', from: usageAddDays(to, -(days - 1)), to, days }
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
 *
 * 012「用量构成」起，模型行要显示四类拆分各占**该模型** tokens 的百分比与缓存命中率，
 * 所以每条模型不再只有一个总权重，而是逐字段给权重（usageSplitByModel 按字段拆）。
 * 首条模型的四个权重刻意取 400:200:50:0 的比例（分母是默认 7 天区间的四类总量），
 * 让它的行内占比恰好是 61.5% / 30.8% / 7.7% / 0，命中率 = 50 ÷ (400 + 50 + 0) = 11.1%，
 * 与 INTERFACE §4 的示例同形；占比与命中率的真值另见下面的 USAGE_COMPOSITION_* 常量与断言。
 * 8 条模型是为了撑出模型列表的内部滚动（FR-005，max-height 252px）；
 * 前 7 条按权重拆、最后一条吃余数，逐字段求和仍等于桶 totals。
 */
const USAGE_MODEL_MIX = [
  {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    weights: {
      // 目标总量 ÷ 默认 7 天区间的总量：input 1,200,000 / 5,493,090、output 600,000 / 1,252,810、
      // cacheRead 150,000 / 2,312,880、cacheWrite 0（该模型不写缓存）。
      input: 1_200_000 / 5_493_090,
      output: 600_000 / 1_252_810,
      cacheRead: 150_000 / 2_312_880,
      cacheWrite: 0,
      calls: 0.22,
    },
  },
  { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', weights: { input: 0.20, output: 0.10, cacheRead: 0.22, cacheWrite: 0.24, calls: 0.18 } },
  { provider: 'openai', model: 'gpt-5', weights: { input: 0.16, output: 0.09, cacheRead: 0.18, cacheWrite: 0.20, calls: 0.15 } },
  { provider: 'deepseek', model: 'deepseek-chat', weights: { input: 0.13, output: 0.08, cacheRead: 0.15, cacheWrite: 0.16, calls: 0.12 } },
  { provider: 'qwen-token-plan-cn', model: 'qwen3-coder-plus', weights: { input: 0.10, output: 0.07, cacheRead: 0.12, cacheWrite: 0.13, calls: 0.10 } },
  { provider: 'openai', model: 'gpt-5-mini', weights: { input: 0.08, output: 0.06, cacheRead: 0.09, cacheWrite: 0.10, calls: 0.08 } },
  { provider: 'deepseek', model: 'deepseek-reasoner', weights: { input: 0.06, output: 0.05, cacheRead: 0.07, cacheWrite: 0.08, calls: 0.07 } },
  { provider: 'qwen-token-plan-cn', model: 'qwen3-max', weights: { input: 0.05, output: 0.04, cacheRead: 0.05, cacheWrite: 0.05, calls: 0.05 } },
]

/** 012 ⑮ 的断言真值：模型条数、首条 id、首条行内四类占比与缓存命中率（SC-003 的验收值）。 */
export const USAGE_COMPOSITION_MODEL_COUNT = 8
export const USAGE_COMPOSITION_FIRST_MODEL_ID = 'deepseek/deepseek-v4-flash'
export const USAGE_COMPOSITION_FIRST_MODEL_SHARES = { input: 61.5, output: 30.8, cacheRead: 7.7, cacheWrite: 0 }
export const USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE = 11.1

/** 某个模型行内某一类的占比（百分比，一位小数；分母是该模型 tokens）。tokens 为 0 时 null。 */
export function usageModelSharePercent(value, tokens) {
  if (!(tokens > 0)) return null
  return Math.round(value / tokens * 1000) / 10
}

/**
 * 缓存命中率（百分比，一位小数）：cacheRead ÷ (input + cacheRead + cacheWrite)，与 INTERFACE §2 FR-002 同式。
 * 分母为 0 时返回 null（客户端渲染「—」）。
 */
export function usageCacheHitRatePercent(totals) {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite
  if (!(denominator > 0)) return null
  return Math.round(totals.cacheRead / denominator * 1000) / 10
}

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

/** 把一天的四类计数按各模型的**逐字段**权重拆开，取整后余数归最后一个（保证逐字段求和相等）。 */
function usageSplitByModel(counters) {
  const out = {}
  for (const one of USAGE_MODEL_MIX) out[one.provider + '/' + one.model] = usageEmptyCounters()
  for (const field of USAGE_MODEL_KEYS) {
    let assigned = 0
    USAGE_MODEL_MIX.forEach((one, index) => {
      const id = one.provider + '/' + one.model
      const value = index === USAGE_MODEL_MIX.length - 1
        ? counters[field] - assigned
        : Math.round(counters[field] * one.weights[field])
      out[id][field] = value
      assigned += value
    })
  }
  return out
}

/**
 * 造一份 /token-plan-quota/usage 的响应。
 *
 * 三种查询上线顺序：`days`（006）→ `from`+`to`（007）→ `month`（010）。
 * 010 的优先级是 month > from/to > days（INTERFACE §1.2），解析统一在 usageQueryShape 里，
 * 非法组合（month 与 from/to 混用、单端、非法月份）直接抛错而不是退化成别的分支。
 *
 * @param {{now?: number, days?: number, from?: string, to?: string, month?: string}} [options]
 * @returns {object} 与 lib/index.js buildUsageSnapshot 同形的 payload。
 */
export function makeUsageSnapshot(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const query = usageQueryShape({ ...options, now })
  const { mode, from, to, days } = query
  const custom = mode === 'custom'
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
    /*
     * 006 的周桶以本地周一为界，首桶可以跨到 from 之前的周一；
     * 007 自定义区间不同：**首桶从 from 开始**（不往前补到周一），末桶到 to 为止 —— 桶必须恰好铺满 [from, to]。
     */
    let cursor = from
    let first = true
    while (cursor <= to) {
      const startKey = custom && first ? from : usageMondayOf(cursor)
      const weekEnd = usageAddDays(usageMondayOf(startKey), 6)
      const endKey = weekEnd > to ? to : weekEnd
      specs.push({ from: startKey, to: endKey })
      cursor = usageAddDays(endKey, 1)
      first = false
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
    // 010：整月分支的 range 多一个 month（INTERFACE §1.2）；客户端标题以它为准渲染「2026 年 10 月 · 31 天」。
    range: mode === 'month'
      ? { kind: 'month', month: query.month, days, from, to }
      : custom ? { kind: 'custom', days, from, to } : { kind: days === 1 ? 'today' : days + 'd', days, from, to },
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
 * 011 截图 ⑭ 悬浮的那根柱：整月 `2026-10` 的 22 号（该月第 22 天，逐日 index = 21）。
 *
 * 为什么把日期与 tokens 钉成常量：截图脚本、DOM 断言、README 与 CHANGELOG 都要引用
 * 「这根柱到底是多少 tokens」，四处各算一遍迟早漂。fixture 的逐日公式是确定性的
 * （与真实日期无关，只看桶序号），所以真值可以而且应该写死；`usageTooltipBar()`
 * 在造数与自检时复核，公式一改就当场抛错，而不是拍完图才发现浮层里是另一串数字。
 *
 * 月份同样写死：⑭ 要证明的是"某一根柱的浮层等于该桶 totals"，不是"当前是哪个月"。
 * 跟着 `Date.now()` 走会让同一张 docs 图每个月换一个月份，字节不可复现。
 */
export const USAGE_TOOLTIP_BAR_MONTH = '2026-10'
export const USAGE_TOOLTIP_BAR_DATE = '2026-10-22'
export const USAGE_TOOLTIP_BAR_TOKENS = 1_403_000

/**
 * 从整月快照里取出 ⑭ 的锚柱，并核对 tokens 与常量一致。
 * @param {object} usage `makeUsageSnapshot({month: USAGE_TOOLTIP_BAR_MONTH})` 的产物
 * @returns {object} 该日桶
 */
export function usageTooltipBar(usage) {
  const bucket = (Array.isArray(usage?.buckets) ? usage.buckets : []).find(one => one.from === USAGE_TOOLTIP_BAR_DATE)
  if (bucket === undefined) {
    throw new Error('usage fixture：' + USAGE_TOOLTIP_BAR_MONTH + ' 里找不到 ' + USAGE_TOOLTIP_BAR_DATE + ' 的桶，⑭ 没有可悬浮的柱')
  }
  if (bucket.totals.tokens !== USAGE_TOOLTIP_BAR_TOKENS) {
    throw new Error('usage fixture：' + USAGE_TOOLTIP_BAR_DATE + ' 的 tokens 是 ' + bucket.totals.tokens
      + '，常量写的是 ' + USAGE_TOOLTIP_BAR_TOKENS + '（逐日公式变了？同步改常量、断言与文档）')
  }
  return bucket
}

/**
 * /usage fixture 的自检：三层 totals 恒等、日期连续、周桶对齐周一、白名单、无百分比/Credits、
 * 无真实痕迹。任何一条不过就不该拍照。
 *
 * 010 起还要验整月：range.kind = month 且带 month 字段、from 是 1 号、to 是夹到今天的月末、
 * 日桶恰好铺满该月（首桶 = 1 号，末桶 = to）。
 *
 * @param {object} usage makeUsageSnapshot 的产物
 * @param {{lang?: 'zh'|'en', now?: number, days?: number, from?: string, to?: string, month?: string}} [options]
 * @returns {string[]} 通过的断言说明（抛错表示不通过）
 */
export function assertUsageFixture(usage, options = {}) {
  const checks = []
  const need = (label, cond) => {
    if (!cond) throw new Error('usage fixture 自检失败：' + label)
    checks.push(label)
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const today = usageDayKey(new Date(now))
  // 与 makeUsageSnapshot 共用同一条解析（month > from/to > days）：断言自己再推一遍，迟早会漂。
  const query = usageQueryShape({ ...options, now })
  const { mode, days, from: expectFrom, to: expectTo } = query
  const custom = mode === 'custom'
  const isMonth = mode === 'month'
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
    JSON.stringify(Object.keys(usage.range).sort())
      === JSON.stringify([...(isMonth ? USAGE_MONTH_RANGE_KEYS : USAGE_RANGE_KEYS)].sort()))
  need('range.days 与请求一致', usage.range.days === days)
  need('range.from 是日期', usageIsDayKey(usage.range.from))
  need('range.to 是日期', usageIsDayKey(usage.range.to))
  if (custom) {
    // 007：kind=custom，且 from/to 是**夹紧后**的真值（to 晚于今天会被夹到今天）——客户端标题以它为准。
    need('range.kind 是 custom', usage.range.kind === 'custom')
    need('range.from = 请求的 from', usage.range.from === expectFrom)
    need('range.to = 请求的 to（夹到今天后）', usage.range.to === expectTo)
  } else if (isMonth) {
    // 010：整月分支。month 必须是请求的那个月，from 该月 1 号，to 是夹到今天后的月末（当月的未来日不出现）。
    need('range.kind 是 month', usage.range.kind === 'month')
    need('range.month = 请求的 month（' + query.month + '）', usage.range.month === query.month)
    need('range.month 与 range.from 同月', usage.range.from.slice(0, 7) === usage.range.month)
    need('range.from = 该月 1 号', usage.range.from === expectFrom && usage.range.from.endsWith('-01'))
    need('range.to = 夹到今天后的月末', usage.range.to === expectTo)
    need('range.days 与整月一致', usage.range.days === days)
    need('整月不走周粒度（自然月 <= 31 天）', days <= 31)
    if (query.month === USAGE_TOOLTIP_BAR_MONTH) {
      // 011 截图 ⑭ 的锚柱：浮层断言引用的就是这根柱。公式漂了要在造数时红，不是拍完图才发现。
      const anchor = usageTooltipBar(usage)
      need('⑭ 锚柱 ' + USAGE_TOOLTIP_BAR_DATE + ' 的 tokens = ' + USAGE_TOOLTIP_BAR_TOKENS + '（实际 ' + anchor.totals.tokens + '）',
        anchor.totals.tokens === USAGE_TOOLTIP_BAR_TOKENS)
    }
  } else {
    need('range.kind 与天数一致', usage.range.kind === (days === 1 ? 'today' : days + 'd'))
    need('range.from = to - (days-1)', usageAddDays(usage.range.to, -(days - 1)) === usage.range.from)
  }
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
      // 007 自定义区间的首桶从 from 开始（可能不是周一）；其余桶与 006 一样以周一为界。
      if (!(custom && index === 0)) need(label + ' 起点是周一', usageParseDay(bucket.from).getDay() === 1)
      need(label + ' 终点不早于起点', bucket.to >= bucket.from)
      need(label + ' 终点不超过周日', usageAddDays(usageMondayOf(bucket.from), 6) >= bucket.to)
      if (index === 0) {
        need(label + ' 覆盖区间起点', bucket.from <= usage.range.from && bucket.to >= usage.range.from)
        if (custom) need(label + ' 起点 = 区间起点', bucket.from === usage.range.from)
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

  // 012：模型行要显示行内四类占比与缓存命中率（INTERFACE §4）。条数与首条占比是 ⑮ 的
  // 断言真值，写死在这里；改 fixture 配比时先在造数阶段报错，而不是拍完图才发现行里是别的数。
  need('模型条数 = ' + USAGE_COMPOSITION_MODEL_COUNT + '（8 条才撑出列表内滚动，实际 ' + usage.models.length + '）',
    usage.models.length === USAGE_COMPOSITION_MODEL_COUNT)
  const firstModel = usage.models[0]
  need('首条模型是 ' + USAGE_COMPOSITION_FIRST_MODEL_ID + '（实际 ' + firstModel.id + '）',
    firstModel.id === USAGE_COMPOSITION_FIRST_MODEL_ID)
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const share = usageModelSharePercent(firstModel.totals[key], firstModel.totals.tokens)
    need('首条模型 ' + key + ' 占比 = ' + USAGE_COMPOSITION_FIRST_MODEL_SHARES[key] + '%（实际 ' + share + '%）',
      share === USAGE_COMPOSITION_FIRST_MODEL_SHARES[key])
  }
  const firstHitRate = usageCacheHitRatePercent(firstModel.totals)
  need('首条模型缓存命中率 = ' + USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE + '%（实际 ' + firstHitRate + '%）',
    firstHitRate === USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE)

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

/** 官方用量明细的 Api 名（presets["token-plan-console"].telemetryApi，见 INTERFACE §2.3）。 */
const OFFICIAL_USAGE_API = 'zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss'

/** 宿主 buildOfficialUsage 写死的来源标签（lib/index.js 同一串；客户端不渲染它，只用于语义）。 */
const OFFICIAL_USAGE_LABEL = '官方账号侧（Token Plan 用量明细）'

const USAGE_OFFICIAL_TOP_KEYS = ['generatedAt', 'range', 'granularity', 'totals', 'buckets', 'source', 'coverage']
const USAGE_OFFICIAL_TOTAL_KEYS = ['tokens', 'input', 'cacheRead', 'output']
const USAGE_OFFICIAL_BUCKET_KEYS = ['from', 'to', ...USAGE_OFFICIAL_TOTAL_KEYS]
const USAGE_OFFICIAL_SOURCE_KEYS = ['kind', 'veracity', 'label']
const USAGE_OFFICIAL_COVERAGE_KEYS = ['api', 'chunks', 'step', 'cached', 'totalDerived', 'clampedFrom']
/** 官方单次区间上限（presets.telemetryChunkDays = 30，INTERFACE §1.1；网关实测上限 30 天）。 */
const USAGE_OFFICIAL_CHUNK_DAYS = 30
/** 「官方 > 本机」的直观倍率：本机同一天 × 1.6。 */
const USAGE_OFFICIAL_VS_LOCAL = 1.6

/** 「当前月往前 5 个月的 1 号」本地日键（officialEarliestDayKey 同口径，INTERFACE §1.2）。 */
function usageOfficialEarliestKey(now) {
  const date = new Date(now)
  date.setDate(1)
  date.setMonth(date.getMonth() - 5)
  return usageDayKey(date)
}

/** 把一天的官方 tokens 拆成 input / cacheRead / output：60% / 25% / 15%，余数归 output（逐项求和严格相等）。 */
function usageOfficialSplit(tokens) {
  const input = Math.round(tokens * 0.6)
  const cacheRead = Math.round(tokens * 0.25)
  return { input, cacheRead, output: tokens - input - cacheRead }
}

/**
 * 造一份 `/token-plan-quota/usage-official` 的响应（008）。
 *
 * 形状严格照 `specs/008-official-token-usage/INTERFACE.md` §2.1：**只有** totals + buckets，
 * 没有 models / calls / steps / enabled / refreshing —— 那些是本机实测（session-index）那一路的字段，
 * 混进来就是宿主永远发不出的 payload。
 *
 * 与本机那一路的口径差别：
 *  - 桶**恒为日桶**（官方 series 本身就是按天回的），区间 > 62 天也不聚成周桶；
 *  - `tokens = input + cacheRead + output`（INTERFACE §2.1 的示例同此算术）；
 *  - 量级取本机同一天的 1.6 倍，让「官方 > 本机」一眼可读，同时逐项自洽（totals = Σbuckets）。
 *  - 不模拟宿主的夹紧：`from` 早于最早可查日、或 `to` 晚于今天时直接抛错 —— 截图只用今天为止、
 *    落在可查窗口内的区间；真被夹紧的响应带 `coverage.clampedFrom`，那是另一张图的事。
 *
 * @param {{now?: number, days?: number, from?: string, to?: string}} [options]
 * @returns {object} 与 INTERFACE §2.1 同形的 payload。
 */
export function makeUsageOfficialSnapshot(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const today = usageDayKey(new Date(now))
  const earliest = usageOfficialEarliestKey(now)
  // 010：与本机那一路共用三种查询的解析（month > from/to > days），两边区间必然一致。
  const query = usageQueryShape({ ...options, now })
  const { mode, from, to, days } = query
  if (mode === 'custom' && options.to > today) {
    throw new Error('makeUsageOfficialSnapshot：to（' + options.to + '）晚于今天（' + today
      + '），截图请用今天为止的区间（宿主会把 to 夹到今天，fixture 不模拟夹紧）')
  }
  const kind = mode === 'custom' ? 'custom' : mode === 'month' ? 'month' : (days === 1 ? 'today' : days + 'd')
  if (from < earliest) {
    throw new Error('makeUsageOfficialSnapshot：from（' + from + '）早于最早可查日 ' + earliest
      + '（当前月往前 5 个月的 1 号），宿主会夹紧并回 clampedFrom；fixture 不模拟夹紧')
  }
  if (days > 365) throw new Error('makeUsageOfficialSnapshot：区间 ' + days + ' 天超过 usageBacklogDays，宿主会回 400')

  const buckets = []
  const totals = { tokens: 0, input: 0, cacheRead: 0, output: 0 }
  let index = 0
  for (let key = from; key <= to; key = usageAddDays(key, 1)) {
    const local = usageDayCounters(index)
    const localTokens = local.input + local.output + local.cacheRead + local.cacheWrite
    const tokens = Math.round(localTokens * USAGE_OFFICIAL_VS_LOCAL)
    const bucket = { from: key, to: key, tokens, ...usageOfficialSplit(tokens) }
    buckets.push(bucket)
    for (const field of USAGE_OFFICIAL_TOTAL_KEYS) totals[field] += bucket[field]
    index += 1
  }

  return {
    generatedAt: now,
    // 010：官方侧 range 与本机那一路同源 —— month 分支多带一个 month 字段（host-core 的契约外加固：
    // month 与 from/to 的 from|to 可能完全同值，缓存按 from/to 命中时靠它区分两个月份查询）。
    range: mode === 'month' ? { kind, month: query.month, days, from, to } : { kind, days, from, to },
    granularity: 'day',
    totals,
    buckets,
    source: { kind: 'official-console', veracity: 'verified', label: OFFICIAL_USAGE_LABEL },
    // 没有 clampedFrom：本函数拒绝需要夹紧的区间，所以图上永远是「请求什么就查什么」。
    coverage: {
      api: OFFICIAL_USAGE_API,
      chunks: Math.ceil(days / USAGE_OFFICIAL_CHUNK_DAYS),
      step: 'day',
      cached: false,
      totalDerived: false,
    },
  }
}


/**
 * `/usage-official` fixture 的自检（008）：字段集严格等于 INTERFACE §2.1、桶逐日铺满区间、
 * totals = Σbuckets、range 回显请求、官方量级大于本机、无百分比 / Credits / 真实痕迹。
 * 任何一条不过就不该拍照。
 *
 * @param {object} official makeUsageOfficialSnapshot 的产物
 * @param {{lang?: 'zh'|'en', now?: number, days?: number, from?: string, to?: string, month?: string}} [options]
 * @returns {string[]} 通过的断言说明（抛错表示不通过）
 */
export function assertUsageOfficialFixture(official, options = {}) {
  const checks = []
  const need = (label, cond) => {
    if (!cond) throw new Error('official usage fixture 自检失败：' + label)
    checks.push(label)
  }
  const sameKeys = (value, keys) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const today = usageDayKey(new Date(now))
  const earliest = usageOfficialEarliestKey(now)
  // 010：与 makeUsageOfficialSnapshot 共用同一条解析（month > from/to > days）。
  const query = usageQueryShape({ ...options, now })
  const { mode } = query
  const expectFrom = query.from
  const expectTo = query.to
  const expectDays = query.days
  const expectKind = mode === 'custom' ? 'custom' : mode === 'month' ? 'month' : (expectDays === 1 ? 'today' : expectDays + 'd')
  need('请求区间不晚于今天（否则该用例根本不该拍照）', expectTo <= today)
  need('请求区间不早于最早可查日 ' + earliest + '（否则宿主会夹紧）', expectFrom >= earliest)

  // 1) 字段集：多一个（models/calls）或少一个都不是宿主会发的形状。
  need('顶层键集 = INTERFACE §2.1 的 7 个键', sameKeys(official, USAGE_OFFICIAL_TOP_KEYS))
  need('generatedAt 是毫秒时间戳', isClockMillis(official.generatedAt))

  // 2) range 回显请求（不夹紧：夹紧的响应一定带 coverage.clampedFrom，那是另一种图）。
  // 010：month 分支的 range 多带 month（宿主用它区分「同一 from/to 的两个月」）⇒ 五键。
  const isMonthQuery = mode === 'month'
  need('range 键集 = ' + (isMonthQuery ? 'kind/month/days/from/to' : 'kind/days/from/to'),
    sameKeys(official.range, isMonthQuery ? USAGE_MONTH_RANGE_KEYS : USAGE_RANGE_KEYS))
  need('range.kind 回显请求（' + expectKind + '）', official.range.kind === expectKind)
  if (isMonthQuery) need('range.month = 请求的 month（' + query.month + '）', official.range.month === query.month)
  need('range.days = ' + expectDays, official.range.days === expectDays)
  need('range.from 回显请求的 from', official.range.from === expectFrom)
  // 自定义区间不夹紧；010 的整月分支里「当月」的 to 是宿主夹到今天的真值（与 expectTo 一致）。
  need('range.to 回显请求的 to（自定义不夹紧；当月夹到今天）', official.range.to === expectTo)

  // 3) 官方这一路恒为日桶。
  need('granularity 恒为 day', official.granularity === 'day')

  // 4) totals：四类，tokens 是三项之和（INTERFACE §2.1 示例同此算术）。
  need('totals 键集 = tokens/input/cacheRead/output', sameKeys(official.totals, USAGE_OFFICIAL_TOTAL_KEYS))
  for (const field of USAGE_OFFICIAL_TOTAL_KEYS) {
    need('totals.' + field + ' 是非负整数', Number.isInteger(official.totals[field]) && official.totals[field] >= 0)
  }
  need('totals.tokens = input + cacheRead + output',
    official.totals.tokens === official.totals.input + official.totals.cacheRead + official.totals.output)
  need('区间里确实有量（否则屏上是空态）', official.totals.tokens > 0)

  // 5) 桶：逐日铺满 [from, to]，桶数 = 天数，缺日也是 0 桶（这里每天都造了量）。
  need('buckets 是数组', Array.isArray(official.buckets))
  need('桶数 = 区间天数（' + expectDays + '）', official.buckets.length === expectDays)
  const sum = { tokens: 0, input: 0, cacheRead: 0, output: 0 }
  for (let index = 0; index < official.buckets.length; index += 1) {
    const bucket = official.buckets[index]
    const label = '桶 ' + (bucket === undefined ? index : bucket.from)
    need(label + ' 的键集 = INTERFACE §2.1 的 6 个键', sameKeys(bucket, USAGE_OFFICIAL_BUCKET_KEYS))
    need(label + ' from/to 是日期', usageIsDayKey(bucket.from) && usageIsDayKey(bucket.to))
    need(label + ' 是单日桶（from === to）', bucket.from === bucket.to)
    const expectKey = index === 0 ? expectFrom : usageAddDays(official.buckets[index - 1].to, 1)
    need(label + ' 与前一桶日连续', bucket.from === expectKey)
    for (const field of USAGE_OFFICIAL_TOTAL_KEYS) {
      need(label + ' 的 ' + field + ' 是非负整数', Number.isInteger(bucket[field]) && bucket[field] >= 0)
      sum[field] += bucket[field]
    }
    need(label + ' tokens = input + cacheRead + output',
      bucket.tokens === bucket.input + bucket.cacheRead + bucket.output)
  }
  need('首桶 = 区间起点', official.buckets[0].from === expectFrom)
  need('末桶 = 区间终点', official.buckets[official.buckets.length - 1].to === expectTo)
  for (const field of USAGE_OFFICIAL_TOTAL_KEYS) {
    need('totals.' + field + ' = Σbuckets.' + field, official.totals[field] === sum[field])
  }

  // 6) 来源：官方账号侧、verified（客户端据此把这一块标成「官方」而不是「本机」）。
  need('source 键集 = kind/veracity/label', sameKeys(official.source, USAGE_OFFICIAL_SOURCE_KEYS))
  need('source.kind 是 official-console', official.source.kind === 'official-console')
  need('source.veracity 是 verified', official.source.veracity === 'verified')
  need('source.label 与宿主常量一致', official.source.label === OFFICIAL_USAGE_LABEL)

  // 7) coverage：Api 名、30 天切块数、日粒度、未走缓存、没兜底、没夹紧。
  for (const key of Object.keys(official.coverage)) {
    need('coverage 的键 ' + key + ' ⊆ INTERFACE §2.1 白名单', USAGE_OFFICIAL_COVERAGE_KEYS.includes(key))
  }
  need('coverage.api = ' + OFFICIAL_USAGE_API, official.coverage.api === OFFICIAL_USAGE_API)
  need('coverage.chunks = ceil(days / 30)', official.coverage.chunks === Math.ceil(expectDays / USAGE_OFFICIAL_CHUNK_DAYS))
  need('coverage.step 是 day', official.coverage.step === 'day')
  need('coverage.cached 为 false（截图不吃缓存）', official.coverage.cached === false)
  need('coverage.totalDerived 为 false（官方回了 total_tokens）', official.coverage.totalDerived === false)
  need('没有 clampedFrom（本函数拒绝需要夹紧的区间）', official.coverage.clampedFrom === undefined)

  // 8) 「官方 > 本机」必须一眼可读：同一请求下比本机实测大，且至少 1.5 倍。
  const local = makeUsageSnapshot(options)
  need('官方总量大于本机（' + official.totals.tokens + ' > ' + local.totals.tokens + '）',
    official.totals.tokens > local.totals.tokens)
  need('官方总量至少是本机的 1.5 倍', official.totals.tokens >= local.totals.tokens * 1.5)

  // 9) 屏上不许出现百分比 / Credits / 真实痕迹（日期串按口径豁免）。
  const strings = collectLeaves(official).filter(value => typeof value === 'string')
  need('没有百分比字符串', strings.every(value => !value.includes('%')))
  need('没有 Credits 字样的数据串', strings.every(value => !/credits/i.test(value)))
  const nonDateStrings = strings.filter(value => !/^\d{4}-\d{2}-\d{2}$/.test(value))
  for (const banned of BANNED_TRACES) {
    const hit = nonDateStrings.find(value => value.includes(banned))
    need('不含真实痕迹 ' + JSON.stringify(banned) + (hit === undefined ? '' : '（命中 ' + JSON.stringify(hit) + '）'),
      hit === undefined)
  }

  if (options.lang === 'en') {
    // 英文套：官方块屏上只剩数字；source.label 是宿主写死的中文且客户端不渲染它（与 006 同口径）。
    const han = /\p{Script=Han}/u
    const rendered = nonDateStrings.filter(value => value !== OFFICIAL_USAGE_LABEL)
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

/* ---------------------------------------------- 014 Credits ↔ tokens 换算块 */

/**
 * 014：`/token-plan-quota/usage-credits` 的**可用态** fixture（INTERFACE §1.1）。
 *
 * 为什么单独一份而不是复用 summary：这条路是本账期的混合口径——官方 Credits 计量 × 官方账号 tokens，
 * 形状（window/credits/tokens/ratio/scope/source）和 summary、usage、usage-official 三者都不同，
 * 混用一份 JSON 会让截图里「比值」和「明细」对不上，而图本身看不出来。
 *
 * 数值取 reviewer 实测的一组（80000 Credits / 已用 37196.8802 / 官方 2,122,918,870 tokens），
 * 但 **tokensPerCredit 与 capacityTokens 按 INTERFACE §2.2/§2.3 的公式现算**，不抄示例里的近似值：
 * 官方 57072.3 / 4565784000 是示例的手工截断，宿主真发的是 57072.49797793526 / 4565799838；
 * 截图断言只比对展示串（5.7万 / 57K、45.66亿 / 4.57B），两者一致。
 *
 * window 写死 2026-11-01 ~ 2026-11-14（reviewer 取数日）：这一块展示的是"本账期"，跟着 Date.now()
 * 走到下个月会让常量、断言、README 三处漂移；⑭ 的月份也是同样写死的理由。
 */
export const USAGE_CREDITS_TOTAL = 80_000
export const USAGE_CREDITS_USED = 37_196.8802
export const USAGE_CREDITS_USED_PERCENT = 46.4961
export const USAGE_CREDITS_OFFICIAL_TOKENS = 2_122_918_870
export const USAGE_CREDITS_LOCAL_TOKENS = 2_080_883_520
export const USAGE_CREDITS_WINDOW = Object.freeze({
  key: 'monthly',
  label: '本月账期',
  labelEn: 'Monthly cycle',
  from: '2026-11-01',
  to: '2026-11-14',
  resetAt: 1_796_054_400_000,
  resetDay: '2026-11-30',
  cycleDays: 30,
  elapsedDays: 14,
})
/** = 官方 tokens ÷ 已用 Credits（原始浮点，客户端负责取整展示）。 */
export const USAGE_CREDITS_TOKENS_PER_CREDIT = USAGE_CREDITS_OFFICIAL_TOKENS / USAGE_CREDITS_USED
/** = round(tokensPerCredit × total)：折算参考，非官方口径。 */
export const USAGE_CREDITS_CAPACITY_TOKENS = Math.round(USAGE_CREDITS_TOKENS_PER_CREDIT * USAGE_CREDITS_TOTAL)
export const USAGE_CREDITS_SOURCE_LABEL = '官方 Credits × 官方 tokens（本账期实测）'
export const USAGE_CREDITS_SOURCE_LABEL_EN = 'Official credits × official tokens (measured this cycle)'

/* 015: ratio gains classes / modelsBasis / models (INTERFACE §2).
 *
 * The three class token counts MUST add up exactly to official tokens: that identity is the only
 * self-check the screenshot can run that the breakdown was neither truncated nor double counted, so
 * the numbers are written once here and re-derived by assertUsageCreditsFixture. tokens are back-
 * solved from the per-Credit targets that reproduce INTERFACE §3.2 examples (zh 5.5万 / 1,977 / 274;
 * en 55K / 2.0K / 274), cacheRead takes the remainder; perCredit stays tokens ÷ used, never truncated.
 */
export const USAGE_CREDITS_CLASS_OUTPUT_TOKENS = 10_191_945
export const USAGE_CREDITS_CLASS_UNCACHED_TOKENS = 73_538_232
export const USAGE_CREDITS_CLASS_CACHE_READ_TOKENS =
  USAGE_CREDITS_OFFICIAL_TOKENS - USAGE_CREDITS_CLASS_OUTPUT_TOKENS - USAGE_CREDITS_CLASS_UNCACHED_TOKENS
export const USAGE_CREDITS_MODELS_BASIS = 'local'

/**
 * 017 §2/§3：宿主给 ratio 附的按日折算基准（basis）。
 *
 * day 与 window.to 同一天（截图拍的是"今天已按当日实测比值算过"），computedAt 写死成
 * 2026-11-14 20:05（Asia/Shanghai，= 12:05 UTC）——客户端按**读者本地时区**格式化成 HH:MM，
 * 所以这里也导出毫秒值，截图脚本用同一个 Date 现算期望串，机器时区变了断言与画面一起变。
 * cached:true 是稳态（当天第二次请求命中的样子）；policy 固定 daily。
 */
export const USAGE_CREDITS_DAILY_DAY = '2026-11-14'
export const USAGE_CREDITS_DAILY_COMPUTED_AT = Date.UTC(2026, 10, 14, 12, 5, 0)
export const USAGE_CREDITS_DAILY_CYCLE_KEY = 'monthly|2026-11-01|2026-11-30'
export const USAGE_CREDITS_BASIS_POLICY = 'daily'

/** perCredit = tokens ÷ used Credits (raw float; INTERFACE §2). */
const creditsPerCredit = tokens => tokens / USAGE_CREDITS_USED

/**
 * 017 §3: 每类除 perCredit 外还带 capacity = round(perCredit × credits.total)。
 * 它是"这类额度能换多少 tokens"的折算参考，宿主在按日快照可用时才发；断言复算同一条公式。
 */
const creditsClassCell = tokens => {
  const perCredit = creditsPerCredit(tokens)
  return Object.freeze({ tokens, perCredit, capacity: Math.round(perCredit * USAGE_CREDITS_TOTAL) })
}

export const USAGE_CREDITS_CLASSES = Object.freeze({
  cacheRead: creditsClassCell(USAGE_CREDITS_CLASS_CACHE_READ_TOKENS),
  uncachedInput: creditsClassCell(USAGE_CREDITS_CLASS_UNCACHED_TOKENS),
  output: creditsClassCell(USAGE_CREDITS_CLASS_OUTPUT_TOKENS),
})

/** 016 §2: model row classes key order (host creditsModelRatios emits the same four). */
export const USAGE_CREDITS_MODEL_CLASS_KEYS = Object.freeze(['input', 'cacheRead', 'output', 'cacheWrite'])

/**
 * Split one row's already-allocated token total into the four classes with the largest-remainder
 * method, using the raw per-model class mix as the shares. The sum is exactly `total` - that
 * identity is what host creditsModelRatios guarantees (`input + cacheRead + output + cacheWrite
 * === tokens`), so the fixture must satisfy it too instead of rounding each class independently.
 */
function splitModelClasses(rawClasses, total) {
  const rawSum = USAGE_CREDITS_MODEL_CLASS_KEYS.reduce((sum, key) => sum + rawClasses[key], 0)
  const out = { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 }
  if (!(rawSum > 0)) return out
  const exact = {}
  for (const key of USAGE_CREDITS_MODEL_CLASS_KEYS) exact[key] = (rawClasses[key] / rawSum) * total
  let used = 0
  for (const key of USAGE_CREDITS_MODEL_CLASS_KEYS) {
    out[key] = Math.floor(exact[key])
    used += out[key]
  }
  const byFraction = USAGE_CREDITS_MODEL_CLASS_KEYS
    .map((key, index) => ({ key, index, fraction: exact[key] - Math.floor(exact[key]) }))
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index))
  for (let at = 0; at < total - used; at += 1) out[byFraction[at % byFraction.length].key] += 1
  return out
}

/**
 * 015 §3.3 model rows (ratio.models): numerators come from the fixture own per-model data over
 * 2026-11-01 .. 11-14 (the elapsed part of the cycle), scaled proportionally to the local total
 * USAGE_CREDITS_LOCAL_TOKENS with the largest-remainder method (integer rows, exact sum).
 *
 * Why scale: the model block footnote says the rows add up to roughly the local total, while the
 * fixture per-day model tokens are only millions and the local total is 2.08 billion - copying them
 * raw would make the same block contradict itself. The shares come from the fixture own
 * USAGE_MODEL_MIX, not from an invented distribution; calls scale by the same factor.
 * tokensPerCredit = tokens ÷ used (same formula as classes; the host does not round).
 */
function buildUsageCreditsModels() {
  const usage = makeUsageSnapshot({
    now: Date.UTC(2026, 10, 14, 4, 0, 0),
    from: USAGE_CREDITS_WINDOW.from,
    to: USAGE_CREDITS_WINDOW.to,
  })
  const raw = usage.models.map(one => one.totals.tokens)
  const sum = raw.reduce((total, value) => total + value, 0)
  if (!(sum > 0)) throw new Error("no per-model data in the cycle window")
  const exact = raw.map(value => (value / sum) * USAGE_CREDITS_LOCAL_TOKENS)
  const tokens = exact.map(Math.floor)
  const remainder = USAGE_CREDITS_LOCAL_TOKENS - tokens.reduce((total, value) => total + value, 0)
  const byFraction = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  for (let at = 0; at < remainder; at += 1) tokens[byFraction[at % tokens.length].index] += 1
  const callsScale = USAGE_CREDITS_LOCAL_TOKENS / sum
  // 016 §2: classes come from the same raw per-model totals and the same allocation, so each row's
  // four class tokens add up to exactly its allocated `tokens` (never independently rounded).
  const rawClasses = usage.models.map(one => ({
    input: one.totals.input,
    cacheRead: one.totals.cacheRead,
    output: one.totals.output,
    cacheWrite: one.totals.cacheWrite,
  }))
  return usage.models
    .map((one, index) => {
      const classTokens = splitModelClasses(rawClasses[index], tokens[index])
      return {
        id: one.id,
        provider: one.provider,
        model: one.model,
        tokens: tokens[index],
        calls: Math.max(1, Math.round(one.totals.calls * callsScale)),
        tokensPerCredit: creditsPerCredit(tokens[index]),
        classes: {
          input: { tokens: classTokens.input, perCredit: creditsPerCredit(classTokens.input) },
          cacheRead: { tokens: classTokens.cacheRead, perCredit: creditsPerCredit(classTokens.cacheRead) },
          output: { tokens: classTokens.output, perCredit: creditsPerCredit(classTokens.output) },
          cacheWrite: { tokens: classTokens.cacheWrite, perCredit: creditsPerCredit(classTokens.cacheWrite) },
        },
      }
    })
    .sort((a, b) => (b.tokens - a.tokens) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const USAGE_CREDITS_MODELS = Object.freeze(buildUsageCreditsModels())

const USAGE_CREDITS_TOP_KEYS = ['generatedAt', 'available', 'window', 'credits', 'tokens', 'ratio', 'scope', 'source']
const USAGE_CREDITS_WINDOW_KEYS = ['key', 'label', 'labelEn', 'from', 'to', 'resetAt', 'resetDay', 'cycleDays', 'elapsedDays']
const USAGE_CREDITS_CREDITS_KEYS = ['unit', 'total', 'used', 'usedPercent']
const USAGE_CREDITS_TOKENS_KEYS = ['official', 'local']
const USAGE_CREDITS_RATIO_KEYS = ['tokensPerCredit', 'capacityTokens', 'classes', 'modelsBasis', 'models', 'basis']
const USAGE_CREDITS_BASIS_KEYS = ['day', 'computedAt', 'cycleKey', 'cached', 'policy']
const USAGE_CREDITS_SCOPE_KEYS = ['officialFrom', 'officialTo', 'officialDays', 'cached', 'clampedFrom']
const USAGE_CREDITS_SOURCE_KEYS = ['kind', 'veracity', 'label', 'labelEn']

/**
 * 造一份 `/token-plan-quota/usage-credits` 可用态响应。
 * @param {{now?: number}} [options]
 * @returns {object} 与 INTERFACE §1.1 同形的 payload。
 */
export function builtCredits(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  /* 017 §3：默认带 basis（截图拍的是"按日基准生效"的稳态）；传 {daily:false} 才造旧响应。 */
  const withDaily = options.daily !== false
  return {
    generatedAt: now,
    available: true,
    window: { ...USAGE_CREDITS_WINDOW },
    credits: {
      unit: 'Credits',
      total: USAGE_CREDITS_TOTAL,
      used: USAGE_CREDITS_USED,
      usedPercent: USAGE_CREDITS_USED_PERCENT,
    },
    tokens: { official: USAGE_CREDITS_OFFICIAL_TOKENS, local: USAGE_CREDITS_LOCAL_TOKENS },
    ratio: {
      tokensPerCredit: USAGE_CREDITS_TOKENS_PER_CREDIT,
      capacityTokens: USAGE_CREDITS_CAPACITY_TOKENS,
      classes: {
        cacheRead: { ...USAGE_CREDITS_CLASSES.cacheRead },
        uncachedInput: { ...USAGE_CREDITS_CLASSES.uncachedInput },
        output: { ...USAGE_CREDITS_CLASSES.output },
      },
      modelsBasis: USAGE_CREDITS_MODELS_BASIS,
      ...(withDaily ? {
        basis: {
          day: USAGE_CREDITS_DAILY_DAY,
          computedAt: USAGE_CREDITS_DAILY_COMPUTED_AT,
          cycleKey: USAGE_CREDITS_DAILY_CYCLE_KEY,
          cached: true,
          policy: USAGE_CREDITS_BASIS_POLICY,
        },
      } : {}),
      models: USAGE_CREDITS_MODELS.map(one => ({
        ...one,
        classes: {
          input: { ...one.classes.input },
          cacheRead: { ...one.classes.cacheRead },
          output: { ...one.classes.output },
          cacheWrite: { ...one.classes.cacheWrite },
        },
      })),
    },
    scope: {
      officialFrom: USAGE_CREDITS_WINDOW.from,
      officialTo: USAGE_CREDITS_WINDOW.to,
      officialDays: USAGE_CREDITS_WINDOW.elapsedDays,
      cached: false,
      clampedFrom: null,
    },
    source: {
      kind: 'credits-token',
      veracity: 'measured',
      label: USAGE_CREDITS_SOURCE_LABEL,
      labelEn: USAGE_CREDITS_SOURCE_LABEL_EN,
    },
  }
}

/**
 * `/usage-credits` fixture 的自检（014）：字段集严格等于 INTERFACE §1.1、窗口日期自洽、
 * 比值/容量按 §2.2/§2.3 公式现算、无货币符号 / 无「Credits 剩余」/ 无真实痕迹。
 * @param {object} credits builtCredits 的产物
 * @param {{now?: number}} [options]
 * @returns {string[]} 通过的断言说明（抛错表示不通过）
 */
export function assertUsageCreditsFixture(credits, options = {}) {
  const checks = []
  const need = (label, cond) => {
    if (!cond) throw new Error('credits usage fixture 自检失败：' + label)
    checks.push(label)
  }
  const sameKeys = (value, keys) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  const now = Number.isFinite(options.now) ? options.now : Date.now()

  need('顶层键集 = INTERFACE §1.1 的 8 个键', sameKeys(credits, USAGE_CREDITS_TOP_KEYS))
  need('generatedAt 是毫秒时间戳', isClockMillis(credits.generatedAt))
  need('available 为 true（否则拍的是不可用态）', credits.available === true)
  need('不带不可用态的 reason/code/hint', credits.reason === undefined && credits.code === undefined && credits.hint === undefined)

  const win = credits.window
  need('window 键集 = 9 个', sameKeys(win, USAGE_CREDITS_WINDOW_KEYS))
  need('window.key = monthly', win.key === 'monthly')
  need('window.from 是日期', usageIsDayKey(win.from))
  need('window.to 是日期', usageIsDayKey(win.to))
  need('window.resetDay 是日期', usageIsDayKey(win.resetDay))
  need('window.from < window.to', win.from < win.to)
  need('window.to ≤ resetDay', win.to <= win.resetDay)
  need('window.resetAt 是毫秒时间戳', isClockMillis(win.resetAt))
  need('resetDay = resetAt 前一天的 dayKey', usageAddDays(usageDayKey(new Date(win.resetAt)), -1) === win.resetDay)
  need('cycleDays = from..resetDay 天数', win.cycleDays === usageCountDays(win.from, win.resetDay))
  need('elapsedDays = from..to 天数', win.elapsedDays === usageCountDays(win.from, win.to))
  need('window.label / labelEn 非空', typeof win.label === 'string' && win.label.trim() !== '' && typeof win.labelEn === 'string' && win.labelEn.trim() !== '')

  const cr = credits.credits
  need('credits 键集 = unit/total/used/usedPercent', sameKeys(cr, USAGE_CREDITS_CREDITS_KEYS))
  need('credits.unit = Credits', cr.unit === 'Credits')
  need('credits.total 是正有限数', Number.isFinite(cr.total) && cr.total > 0)
  need('credits.used 是非负有限数且小于 total', Number.isFinite(cr.used) && cr.used >= 0 && cr.used < cr.total)
  need('credits.usedPercent = used/total×100（4 位取整）', cr.usedPercent === round((cr.used / cr.total) * 100))

  const tk = credits.tokens
  need('tokens 键集 = official/local', sameKeys(tk, USAGE_CREDITS_TOKENS_KEYS))
  need('tokens.official 是正有限数', Number.isFinite(tk.official) && tk.official > 0)
  need('tokens.local 是真值或 null（不参与比值）', tk.local === null || (Number.isFinite(tk.local) && tk.local >= 0))

  const ratio = credits.ratio
  need('ratio 键集 = tokensPerCredit/capacityTokens/classes/modelsBasis/models/basis', sameKeys(ratio, USAGE_CREDITS_RATIO_KEYS))
  need('tokensPerCredit = official ÷ used（原始浮点）', ratio.tokensPerCredit === USAGE_CREDITS_TOKENS_PER_CREDIT)
  need('tokensPerCredit 是正有限数', Number.isFinite(ratio.tokensPerCredit) && ratio.tokensPerCredit > 0)
  need('capacityTokens = round(tokensPerCredit × total)', ratio.capacityTokens === Math.round(ratio.tokensPerCredit * cr.total))
  need('capacityTokens 是正有限整数', Number.isInteger(ratio.capacityTokens) && ratio.capacityTokens > 0)

  const classes = ratio.classes
  need("classes 键集 = cacheRead/uncachedInput/output", sameKeys(classes, ["cacheRead", "uncachedInput", "output"]))
  for (const key of ["cacheRead", "uncachedInput", "output"]) {
    const cell = classes[key]
    need("classes." + key + " 键集 = tokens/perCredit/capacity（017 加 capacity）", sameKeys(cell, ["tokens", "perCredit", "capacity"]))
    need("classes." + key + ".tokens 是非负整数", Number.isInteger(cell.tokens) && cell.tokens >= 0)
    need("classes." + key + ".perCredit = tokens ÷ used（现算，不写截断值）", cell.perCredit === cell.tokens / cr.used)
    need("classes." + key + ".capacity = round(perCredit × credits.total)", cell.capacity === Math.round(cell.perCredit * cr.total))
    need("classes." + key + ".capacity 是正有限整数", Number.isInteger(cell.capacity) && cell.capacity > 0)
  }
  need("classes 三类 tokens 相加 = 官方 tokens（没有截断也没有算重）", classes.cacheRead.tokens + classes.uncachedInput.tokens + classes.output.tokens === tk.official)
  need("ratio.modelsBasis = local", ratio.modelsBasis === USAGE_CREDITS_MODELS_BASIS)

  /* 017 §3: basis 是"这份比值哪天、几点算的"，字段集与值都要与契约一致；缺 basis 属旧链路，
     截图场景 ⑰ 拍的是按日基准生效的稳态，所以这里要求它必须在。 */
  const basis = ratio.basis
  need("ratio.basis 存在（017 按日基准）", basis !== undefined && basis !== null)
  need("basis 键集 = day/computedAt/cycleKey/cached/policy", sameKeys(basis, USAGE_CREDITS_BASIS_KEYS))
  need("basis.day = 2026-11-14 且是日期", basis.day === USAGE_CREDITS_DAILY_DAY && usageIsDayKey(basis.day))
  need("basis.day = window.to（当天的快照）", basis.day === win.to)
  need("basis.computedAt 是毫秒时间戳", isClockMillis(basis.computedAt))
  need("basis.computedAt = fixture 写死的 12:05 UTC", basis.computedAt === USAGE_CREDITS_DAILY_COMPUTED_AT)
  need("basis.cycleKey = monthly|from|resetDay", basis.cycleKey === USAGE_CREDITS_DAILY_CYCLE_KEY)
  need("basis.cycleKey 与 window 自洽", basis.cycleKey === win.key + "|" + win.from + "|" + win.resetDay)
  need("basis.cached 是布尔（稳态 true）", typeof basis.cached === "boolean" && basis.cached === true)
  need("basis.policy = daily", basis.policy === USAGE_CREDITS_BASIS_POLICY)

  const modelRows = ratio.models
  need("ratio.models 是非空数组", Array.isArray(modelRows) && modelRows.length > 0)
  need("ratio.models 行数 = fixture 的按模型条数", modelRows.length === USAGE_CREDITS_MODELS.length)
  modelRows.forEach((row, index) => {
    need("models[" + index + "] 键集 = id/provider/model/tokens/calls/tokensPerCredit/classes", sameKeys(row, ["id", "provider", "model", "tokens", "calls", "tokensPerCredit", "classes"]))
    need("models[" + index + "].id = provider/model", row.id === row.provider + "/" + row.model)
    need("models[" + index + "].tokens 是正有限整数", Number.isInteger(row.tokens) && row.tokens > 0)
    need("models[" + index + "].calls 是非负整数", Number.isInteger(row.calls) && row.calls >= 0)
    need("models[" + index + "].tokensPerCredit = tokens ÷ used（现算）", row.tokensPerCredit === row.tokens / cr.used)
    // 016 §2: classes must be four keys, each an integer non-negative token count whose perCredit is
    // recomputed from the account-level denominator, and the four must add up to this row's tokens.
    need("models[" + index + "].classes 键集 = input/cacheRead/output/cacheWrite", sameKeys(row.classes, USAGE_CREDITS_MODEL_CLASS_KEYS))
    let classTotal = 0
    for (const classKey of USAGE_CREDITS_MODEL_CLASS_KEYS) {
      const cell = row.classes[classKey]
      need("models[" + index + "].classes." + classKey + " 键集 = tokens/perCredit", sameKeys(cell, ["tokens", "perCredit"]))
      need("models[" + index + "].classes." + classKey + ".tokens 是非负整数", Number.isInteger(cell.tokens) && cell.tokens >= 0)
      need("models[" + index + "].classes." + classKey + ".perCredit = tokens ÷ used（现算）", cell.perCredit === cell.tokens / cr.used)
      classTotal += cell.tokens
    }
    need("models[" + index + "] 四类 tokens 相加 = 行 tokens（宿主恒等）", classTotal === row.tokens)
    if (index > 0) need("models 按 tokens 降序（第 " + index + " 行）", modelRows[index - 1].tokens >= row.tokens)
  })
  need("models 各行 tokens 相加 = tokens.local", modelRows.reduce((total, row) => total + row.tokens, 0) === tk.local)
  need("models 与 fixture 常量逐行一致（展示串与断言同一个来源）", JSON.stringify(modelRows) === JSON.stringify(USAGE_CREDITS_MODELS))

  const scope = credits.scope
  need('scope 键集 = 5 个', sameKeys(scope, USAGE_CREDITS_SCOPE_KEYS))
  need('scope.officialFrom/To = window 区间', scope.officialFrom === win.from && scope.officialTo === win.to)
  need('scope.officialDays = window.elapsedDays', scope.officialDays === win.elapsedDays)
  need('scope.cached 为 false', scope.cached === false)
  need('scope.clampedFrom 为 null（未夹紧）', scope.clampedFrom === null)

  const source = credits.source
  need('source 键集 = 4 个', sameKeys(source, USAGE_CREDITS_SOURCE_KEYS))
  need('source.kind = credits-token', source.kind === 'credits-token')
  need('source.veracity = measured', source.veracity === 'measured')
  need('source.label / labelEn 非空', typeof source.label === 'string' && source.label.trim() !== ''
    && typeof source.labelEn === 'string' && source.labelEn.trim() !== '')

  // 所有数值必须有限；JSON 里不许出现 NaN / undefined / 货币符号 / 路径 / 凭据形态。
  const leaves = collectLeaves(credits)
  const flat = leaves.map(value => (typeof value === 'string' ? value : String(value))).join('\n')
  need('没有非有限数字', !leaves.some(value => typeof value === 'number' && !Number.isFinite(value)))
  need('没有 NaN/undefined 字样', flat.indexOf('NaN') < 0 && flat.indexOf('undefined') < 0)
  need('没有货币符号（¥ $ € £ / 元）', !/[¥$€£]|元/.test(flat))
  need('没有「Credits 剩余」', !/Credits\s*剩余/i.test(flat))
  need('没有本机盘符/绝对路径', !/[A-Za-z]:[\\/]/.test(flat))
  need('没有凭据形态', !/eyJ[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]+PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{8,}/.test(flat))
  need('英文 label 里没有中文', !/\p{Script=Han}/u.test(source.labelEn))
  return checks
}
