/**
 * 用量索引：把**本实例**的会话事件流折叠成「按本地日 × 供应商/模型」的 token 计数。
 *
 * 为什么单独一个模块：折叠与聚合是纯函数，能离线断言（假 persistence、固定 now），
 * 而宿主接线（定时器 / 路由 / 工具）只负责把结果搬到界面上。这里不 import 插件本体，
 * 避免 index.js ↔ usage-stats.js 循环依赖。
 *
 * 数据来源只有宿主 sessionPersistence 的**只读**事件流：
 * - 一条 assistant/message 且 data.usage 存在 = 一次调用（calls += 1）；
 * - 模型归属取最近一次 request/header 的 data.header.config.{provider,model}；
 * - 继承会话（isSeeded）的日志含父会话事件前缀，按 cut 截断，不重复计数；
 * - 索引只存计数与 id，**不存消息文本 / 请求头 / 路径**（隐私边界，见索引 schema 白名单）。
 *
 * 口径：不折算 Credits、不由 token 反推余量；这只是一份「本实例实测」的计数账。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import zlib from 'node:zlib'

/** 索引格式版本。schema 变了就 +1：旧文件会被当成坏索引备份重建，而不是带着旧语义混进来。 */
export const USAGE_INDEX_VERSION = 1
/** 回填/保留天数上界（也是天数选择控件的上界）。 */
export const MAX_BACKFILL_DAYS = 365
export const DAY_MS = 86_400_000
/** 兜底扫描单轮读取预算：正常只读「列表里没有」的少数会话，异常情况（列表全失败）也不把磁盘读穿。 */
export const FALLBACK_SCAN_BUDGET = 64 * 1024 * 1024

/** 索引允许出现的键（递归白名单）。出现别的键一律视为 schema 坏 → 备份重建，绝不把未知内容带进内存。 */
const TOP_KEYS = new Set(['version', 'updatedAt', 'sessions', 'days', 'stats'])
const SESSION_KEYS = new Set(['revision', 'lastSeq', 'cut'])
const DAY_KEYS = new Set(['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'models'])
const STATS_KEYS = new Set(['unknownModel', 'skippedOld'])
const COUNTER_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']
/** 没有 request/header 的调用记在这里（不静默丢，但也不猜是哪家模型）。 */
const UNKNOWN_MODEL_ID = 'unknown/unknown'

function pad2(value) {
  return String(value).padStart(2, '0')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 计数口径：只接受有限非负数；负数 / NaN / 字符串脏值一律归 0（和月账本 nonNegative 同源）。 */
function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 1..365，非法值回落 365（索引保留天数 = 天数选择上界）。 */
export function clampBackfillDays(value) {
  return clampInt(value, 1, MAX_BACKFILL_DAYS, MAX_BACKFILL_DAYS)
}

/** 单次查询的天数：1..365，缺失/非法回落 7（服务端夹紧）。 */
function clampRangeDays(value) {
  return clampInt(value, 1, MAX_BACKFILL_DAYS, 7)
}

function emptyCounters() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }
}

function emptyDayBucket() {
  return { ...emptyCounters(), models: {} }
}

function addCounters(target, source) {
  for (const key of COUNTER_KEYS) target[key] += nonNegative(source?.[key])
  return target
}

/** 计数 → 响应里的 totals（steps 直接等于 calls；tokens 是四类求和，不是估算）。 */
function totalsOf(counters) {
  const input = nonNegative(counters?.input)
  const output = nonNegative(counters?.output)
  const cacheRead = nonNegative(counters?.cacheRead)
  const cacheWrite = nonNegative(counters?.cacheWrite)
  const calls = nonNegative(counters?.calls)
  return { input, output, cacheRead, cacheWrite, calls, steps: calls, tokens: input + output + cacheRead + cacheWrite }
}

/** 本地日（YYYY-MM-DD）。刻意不用 toISOString：那是 UTC，跨时区会把一天算错。 */
export function dayKey(value) {
  const n = Number(value)
  const date = new Date(Number.isFinite(n) ? n : Date.now())
  if (Number.isNaN(date.getTime())) return dayKey(Date.now())
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

function dayKeyToDate(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key))
  if (match === null) return new Date()
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** 下一天（用本地日期组件推进，不受夏令时 23/25 小时日影响）。 */
function nextDayKey(key) {
  const date = dayKeyToDate(key)
  date.setDate(date.getDate() + 1)
  return dayKey(date.getTime())
}

/** 该日所在周的本地周一。 */
function weekStartKey(key) {
  const date = dayKeyToDate(key)
  const offset = (date.getDay() + 6) % 7   // 0=周一 … 6=周日
  date.setDate(date.getDate() - offset)
  return dayKey(date.getTime())
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 解析 YYYY-MM-DD 为本地零点；格式或真实日历日不合法时返回 null。
 * 必须回读年月日：Date 会把 2026-02-30 静默滚到 3 月 2 日，只查格式会让它混过去。
 */
function parseDayKey(key) {
  if (typeof key !== 'string' || !DAY_KEY_PATTERN.test(key)) return null
  const parts = key.split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return null
  return date
}

/**
 * 闭区间日历天数。用 UTC 日序号相减：本地毫秒差在夏令时切换那天是 23/25 小时，
 * 直接除 86400000 会算出 30.958 天这种脏值。
 */
function calendarDaySpan(fromKey, toKey) {
  const fromParts = fromKey.split('-').map(Number)
  const toParts = toKey.split('-').map(Number)
  const fromUtc = Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2])
  const toUtc = Date.UTC(toParts[0], toParts[1] - 1, toParts[2])
  return Math.round((toUtc - fromUtc) / DAY_MS) + 1
}

/**
 * 自定义起止日期（007 §1.1）：返回 { from, to, days } 或 { error }。
 * 校验顺序固定：格式 → 真实日历日 → from > to → from 在未来 → 夹 to → 跨度。
 * 「夹 to」不是报错：用户手选了明天不该看到 400，也不该看到一串未来空桶；
 * 但 range.to 必须回写真值，界面的标题以它为准。
 */
export function resolveCustomRange(opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const maxDays = clampBackfillDays(opts.maxDays)
  const from = typeof opts.from === 'string' ? opts.from.trim() : ''
  const to = typeof opts.to === 'string' ? opts.to.trim() : ''
  if (parseDayKey(from) === null || parseDayKey(to) === null) return { error: 'usage-bad-range' }
  if (from > to) return { error: 'usage-bad-range' }
  const today = dayKey(now)
  if (from > today) return { error: 'usage-bad-range' }
  const end = to > today ? today : to
  const days = calendarDaySpan(from, end)
  if (days > maxDays) return { error: 'usage-range-too-long', maxDays }
  return { from, to: end, days }
}

/**
 * 自然月（010 §1.1）：返回 { month, from, to, days } 或 { error: 'usage-bad-month' }。
 * 月固定从 1 号起；当月止于今天（不生成未来空桶），但 range.to 要回写真值，标题以它为准。
 * 这里刻意不套 usageBackfillDays：单月最多 31 天，天然在跨度上界内。
 */
export function resolveMonthRange(opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const month = typeof opts.month === 'string' ? opts.month.trim() : ''
  // 格式闸门写成函数内的字面量：guards 会从导出函数的源码里核对「月份两位、01..12」这条规则。
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: 'usage-bad-month' }
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  // 必须回读年月：Date 会把 0-99 年映射成 1900+，只查格式会让 0000-01 / 0099-01 混过去。
  const first = new Date(year, monthNumber - 1, 1)
  if (first.getFullYear() !== year || first.getMonth() !== monthNumber - 1) return { error: 'usage-bad-month' }
  const today = dayKey(now)
  if (month > today.slice(0, 7)) return { error: 'usage-bad-month' }
  const from = month + '-01'
  const last = new Date(year, monthNumber, 0)   // 下个月第 0 天 = 本月最后一天
  const monthEnd = dayKey(last.getTime())
  const to = monthEnd > today ? today : monthEnd
  return { month, from, to, days: calendarDaySpan(from, to) }
}

/** 空索引。stats 是 INTERFACE §2 明确决定的顶层白名单键（累计诊断计数）。 */
export function emptyUsageIndex() {
  return { version: USAGE_INDEX_VERSION, updatedAt: 0, sessions: {}, days: {}, stats: { unknownModel: 0, skippedOld: 0 } }
}

/** 内存里的索引补全（不写盘）：只为让聚合/折叠对残缺对象也安全。 */
function ensureIndex(index) {
  const target = isPlainObject(index) ? index : emptyUsageIndex()
  target.version = USAGE_INDEX_VERSION
  const updatedAt = Number(target.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt < 0) target.updatedAt = 0
  if (!isPlainObject(target.sessions)) target.sessions = {}
  if (!isPlainObject(target.days)) target.days = {}
  const stats = isPlainObject(target.stats) ? target.stats : {}
  target.stats = { unknownModel: nonNegative(stats.unknownModel), skippedOld: nonNegative(stats.skippedOld) }
  return target
}

/* ==================================================== schema 白名单 */

function assertCounters(value, where) {
  if (!isPlainObject(value)) throw new Error('用量索引 schema 坏：' + where + ' 不是对象')
  for (const key of Object.keys(value)) {
    if (!COUNTER_KEYS.includes(key)) throw new Error('用量索引 schema 坏：' + where + ' 出现白名单外的键 ' + key)
    if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error('用量索引 schema 坏：' + where + '.' + key + ' 不是有限非负数')
  }
}

/**
 * 递归白名单守卫：只允许 INTERFACE 里写明的键。
 * 它会**抛错**（而不是返回 false）—— 调用方拿它当「这份盘上文件还能不能信」的判据：
 * 抛了就备份重建，绝不把未知字段（消息文本 / 请求头 / Cookie）带进内存。
 */
export function assertUsageIndexShape(index) {
  if (!isPlainObject(index)) throw new Error('用量索引 schema 坏：不是对象')
  for (const key of Object.keys(index)) {
    if (!TOP_KEYS.has(key)) throw new Error('用量索引 schema 坏：顶层出现白名单外的键 ' + key)
  }
  if (index.version !== USAGE_INDEX_VERSION) throw new Error('用量索引 schema 坏：version 不是 ' + USAGE_INDEX_VERSION)
  if (!Number.isFinite(index.updatedAt) || index.updatedAt < 0) throw new Error('用量索引 schema 坏：updatedAt 不是有限非负数')
  if (!isPlainObject(index.sessions)) throw new Error('用量索引 schema 坏：sessions 不是对象')
  for (const [id, entry] of Object.entries(index.sessions)) {
    if (id === '') throw new Error('用量索引 schema 坏：sessions 里有空 id')
    if (!isPlainObject(entry)) throw new Error('用量索引 schema 坏：sessions[' + id + '] 不是对象')
    for (const key of Object.keys(entry)) {
      if (!SESSION_KEYS.has(key)) throw new Error('用量索引 schema 坏：sessions[' + id + '] 出现白名单外的键 ' + key)
    }
    if (typeof entry.revision !== 'string') throw new Error('用量索引 schema 坏：sessions[' + id + '].revision 不是字符串')
    for (const key of ['lastSeq', 'cut']) {
      if (!Number.isFinite(entry[key]) || entry[key] < 0) throw new Error('用量索引 schema 坏：sessions[' + id + '].' + key + ' 不是有限非负数')
    }
  }
  if (!isPlainObject(index.days)) throw new Error('用量索引 schema 坏：days 不是对象')
  for (const [key, day] of Object.entries(index.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('用量索引 schema 坏：日桶键不是 YYYY-MM-DD —— ' + key)
    if (!isPlainObject(day)) throw new Error('用量索引 schema 坏：days[' + key + '] 不是对象')
    for (const dayKeyName of Object.keys(day)) {
      if (!DAY_KEYS.has(dayKeyName)) throw new Error('用量索引 schema 坏：days[' + key + '] 出现白名单外的键 ' + dayKeyName)
    }
    assertCounters({ input: day.input ?? 0, output: day.output ?? 0, cacheRead: day.cacheRead ?? 0, cacheWrite: day.cacheWrite ?? 0, calls: day.calls ?? 0 }, 'days[' + key + ']')
    if (!isPlainObject(day.models)) throw new Error('用量索引 schema 坏：days[' + key + '].models 不是对象')
    for (const [modelId, entry] of Object.entries(day.models)) {
      if (modelId === '') throw new Error('用量索引 schema 坏：days[' + key + '].models 里有空 id')
      assertCounters(entry, 'days[' + key + '].models[' + modelId + ']')
    }
  }
  if (index.stats !== undefined) {
    if (!isPlainObject(index.stats)) throw new Error('用量索引 schema 坏：stats 不是对象')
    for (const key of Object.keys(index.stats)) {
      if (!STATS_KEYS.has(key)) throw new Error('用量索引 schema 坏：stats 出现白名单外的键 ' + key)
    }
    for (const key of STATS_KEYS) {
      if (index.stats[key] !== undefined && (!Number.isFinite(index.stats[key]) || index.stats[key] < 0)) {
        throw new Error('用量索引 schema 坏：stats.' + key + ' 不是有限非负数')
      }
    }
  }
  return index
}

/* ==================================================== 折叠 */

/**
 * 把 events 折叠进 index（就地修改），返回本批增量计数。
 *
 * @param index  索引对象（就地改）
 * @param events 事件数组 [{ seq?, type, time, data }]（seq 缺省时用 startSeq + i）
 * @param startSeq 第一条事件的 seq（含）
 * @param cut    继承前缀条数：seq < cut 的事件跳过（继承会话不重复计数）
 * @param opts   { retentionDays, now, modelDefaults? }
 * @returns { added, unknownModel, skippedOld }
 */
export function foldUsageEvents(index, events, startSeq, cut, opts = {}) {
  const target = ensureIndex(index)
  const list = Array.isArray(events) ? events : []
  const base = Number.isFinite(Number(startSeq)) ? Number(startSeq) : 0
  const cutAt = Number.isFinite(Number(cut)) ? Number(cut) : 0
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const retentionDays = clampBackfillDays(opts.retentionDays)
  // 保留期按「日桶」算：早于这一天的桶不再新增（加载时另有 trim 修剪旧桶）。
  const floorKey = dayKey(now - retentionDays * DAY_MS)
  const defaults = isPlainObject(opts.modelDefaults) ? opts.modelDefaults : {}
  let provider = typeof defaults.provider === 'string' ? defaults.provider : ''
  let model = typeof defaults.model === 'string' ? defaults.model : ''
  const added = emptyCounters()
  let unknownModel = 0
  let skippedOld = 0
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i]
    if (!isPlainObject(event)) continue
    const seq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : base + i
    if (seq < cutAt) continue
    if (event.type === 'request/header') {
      const config = event?.data?.header?.config
      if (isPlainObject(config)) {
        const nextProvider = typeof config.provider === 'string' ? config.provider.trim() : ''
        const nextModel = typeof config.model === 'string' ? config.model.trim() : ''
        if (nextProvider !== '' && nextModel !== '') {
          provider = nextProvider
          model = nextModel
        }
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (!isPlainObject(usage)) continue
    // 只认毫秒时间戳；坏时间用 now 归属并计一次（不静默丢），不当作「早于保留期」。
    const at = Number.isFinite(Number(event.time)) ? Number(event.time) : now
    const key = dayKey(at)
    if (key < floorKey) {
      skippedOld += 1
      continue
    }
    const input = nonNegative(usage.inputTokens)
    const output = nonNegative(usage.outputTokens)
    const cacheRead = nonNegative(usage.cacheReadTokens)
    const cacheWrite = nonNegative(usage.cacheWriteTokens)
    const day = (target.days[key] ??= emptyDayBucket())
    if (!isPlainObject(day.models)) day.models = {}
    addCounters(day, { input, output, cacheRead, cacheWrite, calls: 1 })
    const modelId = provider !== '' && model !== '' ? provider + '/' + model : UNKNOWN_MODEL_ID
    if (modelId === UNKNOWN_MODEL_ID) unknownModel += 1
    addCounters((day.models[modelId] ??= emptyCounters()), { input, output, cacheRead, cacheWrite, calls: 1 })
    addCounters(added, { input, output, cacheRead, cacheWrite, calls: 1 })
  }
  target.stats.unknownModel += unknownModel
  target.stats.skippedOld += skippedOld
  target.updatedAt = now
  return { added, unknownModel, skippedOld }
}

/* ==================================================== 聚合 */

function plainModels(models) {
  const out = {}
  for (const [id, counters] of Object.entries(models)) {
    out[id] = { input: nonNegative(counters.input), output: nonNegative(counters.output), cacheRead: nonNegative(counters.cacheRead), cacheWrite: nonNegative(counters.cacheWrite), calls: nonNegative(counters.calls) }
  }
  return out
}

/**
 * 唯一聚合入口：日/周桶 + 区间 tot with 三条恒等式（区间 = 桶和 = 模型和）。
 *
 * @param index 索引（或等价的 { days } 对象）
 * @param opts  { days, now, from, to, month }
 * @returns { range, granularity, totals, buckets, models }
 */
export function aggregateUsageRange(index, opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  // 010 自然月优先级最高（month > from/to > days）；month 非法时只忽略它，退回 006/007 旧分支，
  // 这样纯函数被误用时不会把一次查询变成 400，路由层已经先行报错。
  const rawMonth = typeof opts.month === 'string' ? opts.month.trim() : ''
  const monthRange = rawMonth === '' ? null : resolveMonthRange({ now, month: rawMonth })
  const month = monthRange !== null && monthRange.error === undefined ? monthRange : null
  // 007 自定义区间：from/to 都已由 resolveCustomRange 校验过。这里再挡一次形状与倒序，
  // 免得纯函数被误用时产出倒序桶或空桶集合；days 由闭区间现算，不信任调用方另传的值。
  const rawFrom = typeof opts.from === 'string' ? opts.from.trim() : ''
  const rawTo = typeof opts.to === 'string' ? opts.to.trim() : ''
  const custom = month === null && parseDayKey(rawFrom) !== null && parseDayKey(rawTo) !== null && rawFrom <= rawTo
    ? { from: rawFrom, to: rawTo, days: calendarDaySpan(rawFrom, rawTo) }
    : null
  const days = month !== null ? month.days : custom !== null ? custom.days : clampRangeDays(opts.days ?? 7)
  const to = month !== null ? month.to : custom !== null ? custom.to : dayKey(now)
  let from = month !== null ? month.from : custom?.from
  if (month === null && custom === null) {
    const startDate = dayKeyToDate(to)
    startDate.setDate(startDate.getDate() - (days - 1))
    from = dayKey(startDate.getTime())
  }
  // 单月最多 31 天，永远走日桶；显式判 month 是为了不依赖 62 天阈值这个巧合。
  const granularity = month !== null ? 'day' : days > 62 ? 'week' : 'day'
  const source = isPlainObject(index) && isPlainObject(index.days) ? index.days : {}
  const buckets = []
  const rangeCounters = emptyCounters()

  const addDay = (key, counters, models) => {
    const day = source[key]
    if (!isPlainObject(day)) return
    addCounters(counters, day)
    if (!isPlainObject(day.models)) return
    for (const [modelId, entry] of Object.entries(day.models)) {
      if (!isPlainObject(entry)) continue
      addCounters((models[modelId] ??= emptyCounters()), entry)
    }
  }

  let cursor = from
  if (granularity === 'day') {
    for (let i = 0; i < days && cursor <= to; i += 1) {
      const bucket = { from: cursor, to: cursor, label: cursor.slice(5), counters: emptyCounters(), models: {} }
      addDay(cursor, bucket.counters, bucket.models)
      buckets.push(bucket)
      cursor = nextDayKey(cursor)
    }
  } else {
    // 周桶以本地周一为界。006 的首桶可从周一（可能早于区间起点）算，但只累计区间内的日；
    // 007 自定义区间要求桶**恰好铺满** [from, to]：首桶从用户给的 from 起（不往前补到周一），
    // 否则图上会比用户要的多出一截；末桶同理止于 to。中间桶仍以本地周一为界。
    let guard = 0
    while (cursor <= to && guard < MAX_BACKFILL_DAYS + 7) {
      guard += 1
      const startKey = custom !== null ? cursor : weekStartKey(cursor)
      // 周桶收在本周周日：自定义首桶从 from 起（可能不是周一），若一律加 6 天会变成
      // 从周四到周三这种跨周窗口，后续桶也就不再以周一为界（007 §1.2 明写中间桶按本地周一）。
      const offset = (dayKeyToDate(startKey).getDay() + 6) % 7
      let endKey = startKey
      for (let i = 0; i < 6 - offset; i += 1) endKey = nextDayKey(endKey)
      if (endKey > to) endKey = to
      const bucket = { from: startKey, to: endKey, label: startKey.slice(5), counters: emptyCounters(), models: {} }
      let day = cursor
      while (day <= endKey) {
        addDay(day, bucket.counters, bucket.models)
        day = nextDayKey(day)
      }
      buckets.push(bucket)
      cursor = nextDayKey(endKey)
    }
  }

  const modelCounters = new Map()
  for (const bucket of buckets) {
    addCounters(rangeCounters, bucket.counters)
    for (const [modelId, entry] of Object.entries(bucket.models)) {
      addCounters(modelCounters.get(modelId) ?? modelCounters.set(modelId, emptyCounters()).get(modelId), entry)
    }
  }
  const models = [...modelCounters.entries()].map(([id, counters]) => {
    const slash = id.indexOf('/')
    return {
      id,
      provider: slash === -1 ? 'unknown' : id.slice(0, slash),
      model: slash === -1 ? id : id.slice(slash + 1),
      totals: totalsOf(counters),
    }
  }).sort((a, b) => (b.totals.tokens - a.totals.tokens) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    range: month !== null
      ? { kind: 'month', month: month.month, days, from, to }
      : custom !== null
        ? { kind: 'custom', days, from, to }
        : { kind: days === 1 ? 'today' : days + 'd', days, from, to },
    granularity,
    totals: totalsOf(rangeCounters),
    buckets: buckets.map(bucket => ({ from: bucket.from, to: bucket.to, label: bucket.label, totals: totalsOf(bucket.counters), models: plainModels(bucket.models) })),
    models,
  }
}

/* ==================================================== 读写 / 修剪 */

/** 坏索引不覆盖现场：复制成 <path>.bad-<ms> 留证，下一次保存再原子盖掉原文件。 */
function backupBadIndex(file) {
  try {
    writeFileSync(file + '.bad-' + Date.now(), readFileSync(file, 'utf8'), 'utf8')
  } catch {
    // 备份失败不改变结论（文件本来就读不了/写不了），调用方照样从空索引重建。
  }
}

/**
 * 读盘：不存在 → 空索引；JSON 坏 / schema 坏 → 备份为 <path>.bad-<ms> 后返回空索引。
 */
export function loadUsageIndex(filePath, opts = {}) {
  const file = String(filePath ?? '')
  if (file === '' || !existsSync(file)) return emptyUsageIndex()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return emptyUsageIndex()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
    assertUsageIndexShape(parsed)
  } catch {
    backupBadIndex(file)
    return emptyUsageIndex()
  }
  const index = ensureIndex(parsed)
  if (opts.retentionDays !== undefined) trimUsageIndex(index, opts.retentionDays, opts.now)
  return index
}

/** 原子写：同目录临时文件 + rename（崩在中间也不会留下半个 JSON）。失败抛出，调用方记诊断。 */
export function saveUsageIndex(filePath, index) {
  const file = String(filePath ?? '')
  if (file === '') throw new Error('用量索引路径为空')
  // 自己写出去的也必须过白名单：schema 守卫对读和写同一套，防止脏字段被写进磁盘。
  assertUsageIndexShape(index)
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, basename(file) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
  try {
    writeFileSync(tmp, JSON.stringify(index, null, 1), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件可能根本没建起来 */ }
    throw error
  }
  return file
}

/** 丢弃早于 now - retentionDays 的日桶；就地修改并返回 index。 */
export function trimUsageIndex(index, retentionDays, now = Date.now()) {
  const target = ensureIndex(index)
  const days = clampBackfillDays(retentionDays)
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const floorKey = dayKey(at - days * DAY_MS)
  for (const key of Object.keys(target.days)) if (key < floorKey) delete target.days[key]
  return target
}

/* ==================================================== 收集器 */

function snapshotId(snapshot) {
  if (typeof snapshot === 'string') return snapshot
  if (!isPlainObject(snapshot)) return ''
  const id = snapshot.id ?? snapshot.sessionId ?? snapshot.header?.id
  return typeof id === 'string' ? id : ''
}

/**
 * revision 归一化成字符串再进索引。
 * 宿主 revision 可能是字符串，也可能是对象/数字（不同版本实现不同）；不归一会有两种坏法：
 * ① 一律存空串 → 增量跳过永不生效，每轮全量重读（首轮 20s，每 5 分钟一次更糟）；
 * ② 两条都存同一个 JSON 结果 → 跳过判断互相串味。schema 里该字段仍要求 string。
 */
function revisionKey(revision) {
  if (typeof revision === 'string') return revision
  try {
    const text = JSON.stringify(revision)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** 合法会话偏移：number、安全整数、>=0，且排除 -0（-0 参与比较会给出怪结果）。 */
function validSessionOffset(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : undefined
}

/**
 * 继承前缀条数（fork/继承会话的父事件前缀）：三级兜底，每级都过 validSessionOffset。
 * 顺序与新宿主一致：句柄/读片的 inheritedEventCount → 读片 meta.seedLength → 快照 header.seedLength → 0。
 * 少兜一级的后果不是「少统计」而是**翻倍**：拿不到 cut 就会把继承来的父事件重复折进用量。
 */
function inheritedEventCountFor(record, read) {
  const fromRead = validSessionOffset(read?.inheritedEventCount)
  if (fromRead !== undefined) return fromRead
  const fromMeta = validSessionOffset(read?.meta?.seedLength)
  if (fromMeta !== undefined) return fromMeta
  const fromHeader = validSessionOffset(record?.header?.seedLength)
  return fromHeader ?? 0
}

function normalizeEvents(envelope) {
  return Array.isArray(envelope?.events) ? envelope.events : []
}

/**
 * 读片统一成 { events, inheritedEventCount, meta, start }。
 * open 优先；没有 open 时退 readFrom(id, fromSeq)，再退 read(id, fromSeq) —— 都必须带起点，
 * 不带起点在旧宿主上会从头全读（配合 cut 不会重复计数，但白读整份日志）。
 */
async function readSessionSlice(persistence, id, fromSeq) {
  if (typeof persistence?.open === 'function') {
    const handle = await persistence.open(id, 'read')
    try {
      // 句柄已经报了 cut 就跳过前缀（省 IO）；报不出来就从 fromSeq 读，交给 fold 按最终 cut 过滤。
      const hint = validSessionOffset(handle?.inheritedEventCount) ?? 0
      const start = Math.max(hint, fromSeq)
      const read = await handle.read(start)
      const envelope = Array.isArray(read) ? { events: read } : (isPlainObject(read) ? read : {})
      return { events: normalizeEvents(envelope), inheritedEventCount: handle?.inheritedEventCount, meta: envelope.meta, start }
    } finally {
      try { await handle?.close?.() } catch { /* 关闭失败不影响已读到的计数 */ }
    }
  }
  const read = typeof persistence?.readFrom === 'function'
    ? await persistence.readFrom(id, fromSeq)
    : await persistence.read(id, fromSeq)
  const envelope = Array.isArray(read) ? { events: read } : (isPlainObject(read) ? read : {})
  return { events: normalizeEvents(envelope), inheritedEventCount: envelope.inheritedEventCount, meta: envelope.meta, start: fromSeq }
}

/* ==================================================== 兜底目录扫描（009） */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_LOG_PATTERN = /^session(?:\.v(\d+))?\.jsonl\.zstd$/

/**
 * 每次调用时现取 zstd 解压函数。
 * 不能具名 import：Node < 22.15 没有这个导出，具名绑定会在模块加载阶段直接抛错；
 * 也不能在模块顶层缓存引用 —— 测试要用「解压函数不可用」模拟旧 Node。
 */
function zstdDecompressOf() {
  const fn = zlib.zstdDecompressSync
  return typeof fn === 'function' ? fn : null
}

function nextMagicAt(buffer, from) {
  return buffer.indexOf(ZSTD_MAGIC, from)
}

/**
 * 解码一份会话日志（可能由多帧 zstd 拼接）。
 *
 * 会话日志是追加写出来的：每批事件压缩成一帧接在后面，所以整份 buffer 直接解压只能拿到第一帧。
 * 按 magic 逐帧切、逐帧解，再按字节拼接后统一转 utf8（逐帧转 utf8 会把跨帧的多字节字符切坏）。
 * 帧边界按 magic 找不保证可靠（压缩数据里也可能出现这四个字节），解不开就把帧尾延到下一个 magic
 * 重试，最多延 8 次；仍解不开就跳过该帧、继续后面的帧 —— 一份日志里坏一帧不该让整份作废。
 *
 * @param buffer {Buffer}
 * @returns {{ok:true,text:string,frames:number}|{ok:false,reason:string}}
 */
export function decodeSessionLog(buffer) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, reason: 'decode-failed' }
  const decompress = zstdDecompressOf()
  if (decompress === null) return { ok: false, reason: 'no-zstd' }
  if (buffer.length === 0) return { ok: false, reason: 'no-frames' }
  let start = nextMagicAt(buffer, 0)
  if (start < 0) return { ok: false, reason: 'no-frames' }
  const parts = []
  let frames = 0
  while (start >= 0 && start < buffer.length) {
    const nextStart = nextMagicAt(buffer, start + ZSTD_MAGIC.length)
    let end = nextStart < 0 ? buffer.length : nextStart
    let decoded = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        decoded = decompress(buffer.subarray(start, end))
        break
      } catch {
        decoded = null
      }
      if (end >= buffer.length) break
      const following = nextMagicAt(buffer, end)
      if (following < 0) break
      end = nextMagicAt(buffer, following + ZSTD_MAGIC.length)
      if (end < 0) end = buffer.length
    }
    if (decoded === null) {
      if (nextStart < 0) break
      start = nextStart
      continue
    }
    parts.push(decoded)
    frames += 1
    start = end
  }
  if (frames === 0) return { ok: false, reason: 'decode-failed' }
  return { ok: true, text: Buffer.concat(parts).toString('utf8'), frames }
}

/**
 * 把解码文本切成事件。坏行只计数不抛：日志尾部可能因进程被杀而截断。
 * @param text {string}
 */
export function parseSessionEvents(text) {
  const events = []
  let badLines = 0
  if (typeof text !== 'string' || text === '') return { events, badLines }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    if (!isPlainObject(parsed)) {
      badLines += 1
      continue
    }
    events.push(parsed)
  }
  return { events, badLines }
}

/**
 * 兜底日志里的继承前缀长度。
 * 只有 seed 会话（header.isSeeded === true）且带继承结束标记时才有前缀；
 * 标记取**最后一条**：分叉会话可能多次继承。
 * @param events {object[]}
 */
export function fallbackCutOf(events) {
  const list = Array.isArray(events) ? events : []
  const header = list[0]
  if (!isPlainObject(header) || header.type !== 'session' || header.isSeeded !== true) return 0
  let cut = 0
  for (let i = 0; i < list.length; i += 1) {
    const event = list[i]
    if (!isPlainObject(event) || event.type !== 'session/end-seed') continue
    if (!isPlainObject(event.data) || event.data.inherited !== true) continue
    const seq = Number(event.seq)
    cut = (Number.isFinite(seq) ? seq : i) + 1
  }
  return cut
}

/**
 * 枚举兜底目录下的会话日志：<sessionsDir>/<project>/<sessionDir>/session[.vN].jsonl.zstd。
 * 同一目录有多份版本时只取版本最高的一份，否则同一会话会被折两遍。
 * 目录名（session-<uuid> 或裸 <uuid>）就是宿主侧的会话 id，原样使用、不剥前缀。
 *
 * @param sessionsDir {string}
 * @returns {{logs:{id:string,path:string,bytes:number,mtimeMs:number}[],dirs:number}}
 */
export function fallbackLogsOf(sessionsDir) {
  const none = { logs: [], dirs: 0 }
  if (typeof sessionsDir !== 'string' || sessionsDir === '') return none
  let projects
  try {
    projects = readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return none
  }
  const logs = []
  let dirs = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(sessionsDir, project.name)
    let sessionDirs
    try {
      sessionDirs = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      dirs += 1
      const dirPath = join(projectPath, sessionDir.name)
      let names
      try {
        names = readdirSync(dirPath)
      } catch {
        continue
      }
      let best = null
      for (const name of names) {
        const match = SESSION_LOG_PATTERN.exec(name)
        if (match === null) continue
        const version = match[1] === undefined ? 0 : Number(match[1])
        if (!Number.isFinite(version)) continue
        if (best !== null && version <= best.version) continue
        best = { version, name }
      }
      if (best === null) continue
      const path = join(dirPath, best.name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      logs.push({ id: sessionDir.name, path, bytes: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return { logs, dirs }
}

/**
 * 兜底日志签名。只含字节数与修改时间，不带路径（索引会被落盘，路径属于宿主内部信息）。
 * @param log {{bytes:number,mtimeMs:number}}
 */
export function fallbackSignature(log) {
  const bytes = Number(log?.bytes)
  const mtime = Number(log?.mtimeMs)
  const size = Number.isFinite(bytes) && bytes >= 0 ? Math.trunc(bytes) : 0
  const at = Number.isFinite(mtime) ? Math.round(mtime) : 0
  return 'file:' + size + ':' + at
}

function maxEventSeq(events) {
  let max
  for (const event of events) {
    const seq = Number(event?.seq)
    if (!Number.isFinite(seq)) continue
    if (max === undefined || seq > max) max = seq
  }
  return max
}

/**
 * 从 sessionPersistence 回填/增量同步索引，并在末尾补一轮**兜底目录扫描**。
 *
 * persistence 的形状跨宿主版本有两种（usage seam 的实证）：
 * - 0.1.1-rc.2 ~ 0.1.2-rc.1：listSnapshots() 给 {header, revision}，list() 只给裸 header（两者同时在位）；
 * - 0.1.3-alpha.2 起：listSnapshots 移除，list() 升级为 {header, revision, sizeBytes}。
 * 故按「语义正确者优先」探测 listSnapshots，再退 list —— 先探测 list 会在旧宿主上拿到
 * 裸 header，revision 恒空、增量跳过永不生效。
 *
 * 兜底扫描解决的是「日志还在磁盘上、但 list() 已经不返回」的会话：它们可能是后端换代后
 * 索引不到的旧会话，也可能被宿主内部过滤掉。只补列表里没有的 id，列表里的会话即使读失败
 * 也不交给兜底（否则同一会话会被两套读法各折一次）。读取按轮预算截断、逐文件让出主线程，
 * 超预算的部分下一轮继续（scanDeferred）。
 *
 * @param deps { persistence, index, config, now?, onProgress?, sessionsDir?, scanFallback?, scanBudgetBytes? }
 * @returns { ok, skipped?, sessions, indexed, failed, unknownModel, skippedOld, durationMs, scanned, rescued, scanFailed, scanDeferred, scanSkipped? }
 */
export async function syncUsageIndex(deps = {}) {
  const startedAt = Date.now()
  const persistence = deps.persistence
  const index = ensureIndex(deps.index)
  const config = isPlainObject(deps.config) ? deps.config : {}
  const now = Number.isFinite(Number(deps.now)) ? Number(deps.now) : Date.now()
  const retentionDays = clampBackfillDays(config.usageBackfillDays)
  const empty = { sessions: 0, indexed: 0, failed: 0, unknownModel: 0, skippedOld: 0 }
  const scanDir = typeof deps.sessionsDir === 'string' ? deps.sessionsDir : ''
  const scanFallback = deps.scanFallback !== false && scanDir !== ''
  const requestedBudget = Number(deps.scanBudgetBytes)
  const scanBudget = Number.isFinite(requestedBudget) && requestedBudget >= 0 ? requestedBudget : FALLBACK_SCAN_BUDGET
  const listFn = typeof persistence?.listSnapshots === 'function'
    ? () => persistence.listSnapshots()
    : typeof persistence?.list === 'function' ? () => persistence.list() : null
  const canRead = typeof persistence?.open === 'function'
    || typeof persistence?.readFrom === 'function'
    || typeof persistence?.read === 'function'
  let listSkipped = listFn === null || !canRead ? 'no-session-persistence' : null
  let snapshots = []
  if (listSkipped === null) {
    try {
      snapshots = await listFn()
    } catch {
      listSkipped = 'list-failed'
    }
  }
  // 没有兜底可扫时才直接放弃；能扫目录就继续 —— 列表失败/缺席不该让磁盘上还在的会话漏掉。
  if (listSkipped !== null && !scanFallback) {
    return {
      ok: false,
      skipped: listSkipped,
      ...empty,
      durationMs: Date.now() - startedAt,
      scanned: 0,
      rescued: 0,
      scanFailed: 0,
      scanDeferred: 0,
    }
  }
  const list = listSkipped !== null
    ? []
    : Array.isArray(snapshots) ? snapshots : Array.isArray(snapshots?.sessions) ? snapshots.sessions : []
  let indexed = 0
  let failed = 0
  let unknownModel = 0
  let skippedOld = 0
  if (listSkipped === null) {
    for (let i = 0; i < list.length; i += 1) {
      // 每 10 份让出主线程：首轮回填可能几百份会话，不能把 webServer 卡住。
      if (i > 0 && i % 10 === 0) await new Promise(resolve => setImmediate(resolve))
      const snapshot = list[i]
      const id = snapshotId(snapshot)
      if (id === '') {
        // 快照缺 header（后端换代/损坏目录）：计一次失败，别静默丢 —— coverage.failed 要看得见。
        failed += 1
        continue
      }
      const revision = revisionKey(snapshot?.revision)
      const previous = isPlainObject(index.sessions[id]) ? index.sessions[id] : null
      // 唯一省 CPU 的点：revision 没变的会话直接跳过，不 open、不读日志。
      if (previous !== null && revision !== '' && previous.revision === revision) {
        indexed += 1
        continue
      }
      try {
        const fromSeq = previous !== null && Number.isFinite(previous.lastSeq) ? Math.max(0, previous.lastSeq + 1) : 0
        const slice = await readSessionSlice(persistence, id, fromSeq)
        const cut = inheritedEventCountFor(snapshot, slice)
        const folded = foldUsageEvents(index, slice.events, slice.start, cut, { retentionDays, now })
        unknownModel += folded.unknownModel
        skippedOld += folded.skippedOld
        // lastSeq 取「cut-1 与历史 lastSeq」的底，再被每个合法 seq 抬高（与 usage seam 的折叠同口径）。
        let lastSeq = Math.max(0, cut - 1, Number.isFinite(previous?.lastSeq) ? previous.lastSeq : 0)
        for (const event of slice.events) {
          const seq = Number(event?.seq)
          if (Number.isFinite(seq) && seq > lastSeq) lastSeq = seq
        }
        index.sessions[id] = { revision, lastSeq, cut }
        indexed += 1
      } catch {
        // 单会话读坏不中断整轮：不写 sessions[id]，下一轮重试；failed 让 coverage 里看得见。
        failed += 1
      }
      if (typeof deps.onProgress === 'function') {
        try { deps.onProgress({ done: i + 1, total: list.length }) } catch { /* 进度回调不该影响同步 */ }
      }
    }
  }
  let scanned = 0
  let rescued = 0
  let scanFailed = 0
  let scanDeferred = 0
  let scanSkipped
  let hidden = 0
  if (scanFallback) {
    const found = fallbackLogsOf(scanDir)
    scanned = found.logs.length
    if (found.dirs === 0) scanSkipped = 'no-dir'
    const listedIds = new Set()
    for (const snapshot of list) {
      const id = snapshotId(snapshot)
      if (id !== '') listedIds.add(id)
    }
    const candidates = found.logs.filter(log => !listedIds.has(log.id))
    hidden = candidates.length
    if (scanSkipped === undefined && hidden > 0 && zstdDecompressOf() === null) scanSkipped = 'no-zstd'
    if (scanSkipped !== 'no-zstd') {
      let consumed = 0
      for (let i = 0; i < candidates.length; i += 1) {
        if (i > 0) await new Promise(resolve => setImmediate(resolve))
        const log = candidates[i]
        const previous = isPlainObject(index.sessions[log.id]) ? index.sessions[log.id] : null
        const signature = fallbackSignature(log)
        // 签名没变 = 这份日志上次已经折过，不读盘；它仍算进 indexed（索引里有成功条目）。
        if (previous !== null && previous.revision === signature) {
          indexed += 1
          continue
        }
        if (consumed + log.bytes > scanBudget) {
          scanDeferred = candidates.length - i
          break
        }
        consumed += log.bytes
        let buffer
        try {
          buffer = readFileSync(log.path)
        } catch {
          scanFailed += 1
          continue
        }
        const decoded = decodeSessionLog(buffer)
        if (!decoded.ok) {
          scanFailed += 1
          continue
        }
        const parsed = parseSessionEvents(decoded.text)
        const lastSeq = maxEventSeq(parsed.events)
        if (previous !== null && Number.isFinite(previous.lastSeq)
          && (lastSeq === undefined ? previous.lastSeq > 0 : lastSeq < previous.lastSeq)) {
          // 文件变短：可能是被替换/截断，按不可信处理，不折也不改签名，下一轮再试。
          scanFailed += 1
          continue
        }
        const inheritedCut = fallbackCutOf(parsed.events)
        const baseLast = previous !== null && Number.isFinite(previous.lastSeq) ? previous.lastSeq : 0
        // 首次折入：从继承前缀之后开始（没有 previous 时没有「已折到哪」的上界，不能平白加 1，否则
        // 会漏掉 seq 0 的会话 header、把整段调用记成未知模型）。
        const cut = previous === null ? inheritedCut : Math.max(inheritedCut, baseLast + 1)
        const folded = foldUsageEvents(index, parsed.events, 0, cut, { retentionDays, now })
        unknownModel += folded.unknownModel
        skippedOld += folded.skippedOld
        let nextLastSeq = Math.max(0, cut - 1, baseLast)
        if (lastSeq !== undefined && lastSeq > nextLastSeq) nextLastSeq = lastSeq
        index.sessions[log.id] = { revision: signature, lastSeq: nextLastSeq, cut }
        indexed += 1
        rescued += 1
      }
    }
  }
  index.updatedAt = now
  const result = {
    ok: true,
    // 列表与会话目录的并集：兜底折进来的会话也要算进总数，否则 sessions 会比 indexed 小。
    sessions: list.length + hidden,
    indexed,
    failed,
    unknownModel,
    skippedOld,
    durationMs: Date.now() - startedAt,
    scanned,
    rescued,
    scanFailed,
    scanDeferred,
  }
  if (scanSkipped !== undefined) result.scanSkipped = scanSkipped
  return result
}
