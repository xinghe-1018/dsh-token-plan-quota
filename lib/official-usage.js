/**
 * 官方账号侧用量（Token Plan 用量明细）：切片、响应解析、逐日折叠与补齐。
 *
 * 为什么单独一个模块：这一层的每件事都是纯函数（切片、信封解析、桶起点换算、0 桶补齐），
 * 能离线断言；宿主只负责「带 Cookie 发请求 + 缓存」。这里**不 import 任何东西**——不碰网络、
 * 不碰文件、不认识 cordis，和 detect.js 同一层纪律。
 *
 * 口径（与 README / docs/upstream-contracts.md 必须一致）：
 * - 官方 `Usage Details` 的默认单位就是 tokens，本模块只处理 token 计数，不碰 Credits；
 * - `total_tokens` 缺失时才用 `input_tokens + output_tokens` 兜底，并在 totalDerived 里标注；
 * - 官方 `input_tokens` **含缓存命中**（官方 cacheHitRate = cached / input），所以本机侧
 *   `input + cacheRead + output + cacheWrite` 与官方 `total_tokens` 都是「总量」，
 *   但两侧对缓存的拆法不同：只比总量，不做交叉折算、不派生百分比。
 *
 * 时间口径（从官方前端 bundle 核出来的，见 docs/upstream-contracts.md）：
 * - `point.timestamp` 是**桶的右端点**，桶起点 = timestamp − step×1000；
 * - 单次查询上限**实测是 30 天**（官方页面传 `maxDayRangeDays: 31`，但网关真的会拒 31 天整月：
 *   2026-11-13 实测 2026-10-01..10-31 回 `ConsoleApiError: time range cannot be longer than 30 days`）。
 *   endTime = 止日次日零点（闭区间语义）；
 * - 最早只能查「当前月往前 5 个月的 1 号」。
 */

/** 一天的毫秒数（本地日推进用日期组件，不用它做加减，避免夏令时 23/25 小时日）。 */
export const DAY_MS = 86_400_000
/**
 * 官方 usage detail 单次查询天数上限。
 *
 * 官方前端传的是 `maxDayRangeDays: 31`，但**网关按 30 天卡**：2026-11-13 实测
 * `from=2026-10-01&to=2026-10-31` 回 `ConsoleApiError: time range cannot be longer than 30 days`，
 * 改成 10-01..10-30 立刻成功。跟着实测走——否则每个 31 天的自然月都只能出一句"上游错误"。
 */
export const OFFICIAL_CHUNK_DAYS = 30
/** 官方最早可查窗口：当前月往前 5 个月的 1 号。 */
export const OFFICIAL_EARLIEST_MONTHS = 5
/** 官方默认步长（秒）。 */
export const OFFICIAL_STEP_SECONDS = 86400
/** 只用这些 usage_type（其余 label 直接忽略，不猜）。 */
const USAGE_TYPES = new Map([
  ['total_tokens', 'total'],
  ['input_tokens', 'input'],
  ['cached_tokens', 'cached'],
  ['output_tokens', 'output'],
])

function pad2(value) {
  return String(value).padStart(2, '0')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 本地日键（YYYY-MM-DD）。跨时区/夏令时都按**本机**日历走，与 /usage 的日桶同源。 */
export function officialDayKey(value) {
  const n = Number(value)
  const date = new Date(Number.isFinite(n) ? n : Date.now())
  if (Number.isNaN(date.getTime())) return officialDayKey(Date.now())
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** 严格校验日键并回本地零点毫秒；非法返回 null（不抛，调用方自己决定怎么报错）。 */
export function officialDayStart(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  // 反查日历日：2026-02-30 会被 Date 滚到 3 月，这里必须拒掉。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.getTime()
}

/** 下一天（日期组件推进）。 */
export function officialNextDay(key) {
  const start = officialDayStart(key)
  if (start === null) return key
  const date = new Date(start)
  date.setDate(date.getDate() + 1)
  return officialDayKey(date.getTime())
}

/** 闭区间天数（含首尾）。 */
export function officialCountDays(from, to) {
  const start = officialDayStart(from)
  const end = officialDayStart(to)
  if (start === null || end === null || end < start) return 0
  const cursor = new Date(start)
  let days = 0
  while (cursor.getTime() <= end && days <= 4000) {
    days += 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

/** 当前月往前 monthsBack 个月的 1 号（官方页面的最早可查日）。 */
export function officialEarliestDayKey(opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const monthsBack = Number.isFinite(Number(opts.monthsBack)) ? Math.max(0, Math.trunc(Number(opts.monthsBack))) : OFFICIAL_EARLIEST_MONTHS
  const date = new Date(now)
  return officialDayKey(new Date(date.getFullYear(), date.getMonth() - monthsBack, 1).getTime())
}

/**
 * 把闭区间切成官方能接受的片。
 *
 * 返回 `{ from, to, days, clampedFrom?, chunks }`；`from` 被夹紧时带 `clampedFrom`
 * （原请求值），`range.from` 一律以返回值为准（屏上显示的必须是真查过的区间）。
 * `from > to`（含夹紧后）→ `{ error: "official-empty-range" }`。
 */
export function sliceOfficialRange(opts = {}) {
  const fromStart = officialDayStart(opts.from)
  const toStart = officialDayStart(opts.to)
  if (fromStart === null || toStart === null) return { error: 'official-bad-range' }
  const chunkDays = Number.isFinite(Number(opts.chunkDays)) ? Math.max(1, Math.trunc(Number(opts.chunkDays))) : OFFICIAL_CHUNK_DAYS
  let from = opts.from
  let clampedFrom
  const earliestStart = officialDayStart(opts.earliest)
  if (earliestStart !== null && fromStart < earliestStart) {
    clampedFrom = from
    from = opts.earliest
  }
  const start = officialDayStart(from)
  if (start === null || start > toStart) return { error: 'official-empty-range' }
  const chunks = []
  let cursor = from
  while (officialDayStart(cursor) <= toStart) {
    let chunkEnd = cursor
    for (let i = 1; i < chunkDays; i += 1) {
      const next = officialNextDay(chunkEnd)
      if (officialDayStart(next) > toStart) break
      chunkEnd = next
    }
    chunks.push({ from: cursor, to: chunkEnd, days: officialCountDays(cursor, chunkEnd) })
    cursor = officialNextDay(chunkEnd)
  }
  const result = { from, to: opts.to, days: officialCountDays(from, opts.to), chunks }
  if (clampedFrom !== undefined) result.clampedFrom = clampedFrom
  return result
}

/**
 * 一片请求的参数（官方 `Data.reqDTO` 里那三个时间字段）。
 * startTime = 起日本地零点；endTime = 止日次日零点（官方判据是 `end - start <= maxDayRangeDays*86400000`）。
 */
export function officialChunkRequest(chunk, opts = {}) {
  const step = Number.isFinite(Number(opts.stepSeconds)) ? Math.max(1, Math.trunc(Number(opts.stepSeconds))) : OFFICIAL_STEP_SECONDS
  const start = officialDayStart(chunk?.from)
  const endStart = officialDayStart(chunk?.to)
  if (start === null || endStart === null) return { error: 'official-bad-range' }
  const endDate = new Date(endStart)
  endDate.setDate(endDate.getDate() + 1)
  return { startTime: start, endTime: endDate.getTime(), step }
}

/** 响应里可能是字符串化的 JSON（网关有些层会把 data 序列化一次）。 */
function readJsonMaybe(value, depth = 0) {
  if (depth > 2 || typeof value !== 'string') return value
  const text = value.trim()
  if (text === '' || (text[0] !== '{' && text[0] !== '[')) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

/**
 * 在响应信封里找数据层。
 *
 * 官方前端也是这么做的：向下找回 `originData`（数组）或 `dataDownloadUrl`（字符串）的那层。
 * 返回 `{ series }` / `{ downloadUrl }` / `{ error: "official-bad-response" }`。
 */
export function parseOfficialEnvelope(payload) {
  const root = readJsonMaybe(payload)
  if (Array.isArray(root)) {
    if (root.length > 0 && isPlainObject(root[0]) && Array.isArray(root[0]?.points)) return { series: root }
    return { error: 'official-bad-response' }
  }
  if (!isPlainObject(root)) return { error: 'official-bad-response' }
  let downloadUrl = ''
  const queue = [{ node: root, depth: 0 }]
  while (queue.length > 0) {
    const { node, depth } = queue.shift()
    const data = readJsonMaybe(isPlainObject(node) ? node.data : undefined)
    if (Array.isArray(data) && data.length > 0 && isPlainObject(data[0]) && Array.isArray(data[0]?.points)) {
      return { series: data }
    }
    if (Array.isArray(node?.originData)) return { series: node.originData }
    if (typeof node?.dataDownloadUrl === 'string' && node.dataDownloadUrl !== '' && downloadUrl === '') {
      downloadUrl = node.dataDownloadUrl
    }
    if (depth >= 6) continue
    for (const key of Object.keys(node)) {
      const child = readJsonMaybe(node[key])
      if (Array.isArray(child)) {
        for (const item of child) if (isPlainObject(item)) queue.push({ node: item, depth: depth + 1 })
      } else if (isPlainObject(child)) {
        queue.push({ node: child, depth: depth + 1 })
      }
    }
  }
  if (downloadUrl !== '') return { downloadUrl }
  return { error: 'official-bad-response' }
}

function emptyDayBucket() {
  return { total: 0, input: 0, cached: 0, output: 0, hasTotal: false }
}

/**
 * 把 series 折成「本地日 → 四项计数」。
 *
 * 只认 `aggMethod === "sum"`（缺省也认）且 `labels.usage_type` 在四类白名单里的序列；
 * step 单位是**秒**（官方如此），timestamp 若是秒级也会被归一成毫秒（有的网关注入会掉精度）。
 */
export function foldOfficialSeries(series, opts = {}) {
  const days = new Map()
  const fromStart = officialDayStart(opts.dayStart)
  const toStart = officialDayStart(opts.dayEnd)
  let sawTotal = false
  const list = Array.isArray(series) ? series : []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    if (item.aggMethod !== undefined && String(item.aggMethod) !== 'sum') continue
    const usageType = USAGE_TYPES.get(String(item?.labels?.usage_type ?? '').toLowerCase())
    if (usageType === undefined) continue
    const rawStep = Number(item.step)
    const stepSeconds = Number.isFinite(rawStep) && rawStep > 0 ? (rawStep > 86_400 ? Math.trunc(rawStep / 1000) : Math.trunc(rawStep)) : OFFICIAL_STEP_SECONDS
    const points = Array.isArray(item.points) ? item.points : []
    for (const point of points) {
      if (!isPlainObject(point)) continue
      let timestamp = Number(point.timestamp)
      if (!Number.isFinite(timestamp)) continue
      if (timestamp < 1e12) timestamp *= 1000
      const bucketStart = timestamp - stepSeconds * 1000
      if (fromStart !== null && bucketStart < fromStart) continue
      if (toStart !== null) {
        const dayEndLimit = new Date(toStart)
        dayEndLimit.setDate(dayEndLimit.getDate() + 1)
        if (bucketStart >= dayEndLimit.getTime()) continue
      }
      const key = officialDayKey(bucketStart)
      const bucket = days.get(key) ?? emptyDayBucket()
      const value = nonNegative(point.value)
      bucket[usageType] += value
      if (usageType === 'total') {
        bucket.hasTotal = true
        sawTotal = true
      }
      days.set(key, bucket)
    }
  }
  return { days, sawTotal }
}

/** 多片结果合并（原地累加，宿主逐片调用）。 */
export function mergeOfficialDays(target, source) {
  const sink = target instanceof Map ? target : new Map()
  if (!(source instanceof Map)) return sink
  for (const [key, bucket] of source) {
    const current = sink.get(key) ?? emptyDayBucket()
    current.total += nonNegative(bucket?.total)
    current.input += nonNegative(bucket?.input)
    current.cached += nonNegative(bucket?.cached)
    current.output += nonNegative(bucket?.output)
    current.hasTotal = current.hasTotal || bucket?.hasTotal === true
    sink.set(key, current)
  }
  return sink
}

/**
 * 铺满区间的输出：桶数 = 区间天数（缺日 0 桶）。
 *
 * `days` 是 foldOfficialSeries/mergeOfficialDays 出来的 Map；`totalDerived` 只在
 * 区间里**一个 total_tokens 读数都没有**时为 true（说明整段都是兜底值）。
 */
export function buildOfficialUsage(opts = {}) {
  const fromStart = officialDayStart(opts.from)
  const toStart = officialDayStart(opts.to)
  if (fromStart === null || toStart === null || toStart < fromStart) return { error: 'official-bad-range' }
  const source = opts.days instanceof Map ? opts.days : new Map()
  const buckets = []
  const totals = { tokens: 0, input: 0, cacheRead: 0, output: 0 }
  let sawTotal = false
  const cursor = new Date(fromStart)
  const endLimit = new Date(toStart)
  while (cursor.getTime() <= endLimit.getTime()) {
    const key = officialDayKey(cursor.getTime())
    const bucket = source.get(key) ?? emptyDayBucket()
    const tokens = bucket.hasTotal ? nonNegative(bucket.total) : nonNegative(bucket.input) + nonNegative(bucket.output)
    if (bucket.hasTotal) sawTotal = true
    const entry = {
      from: key,
      to: key,
      tokens,
      input: nonNegative(bucket.input),
      cacheRead: nonNegative(bucket.cached),
      output: nonNegative(bucket.output),
    }
    buckets.push(entry)
    totals.tokens += entry.tokens
    totals.input += entry.input
    totals.cacheRead += entry.cacheRead
    totals.output += entry.output
    cursor.setDate(cursor.getDate() + 1)
  }
  return {
    from: opts.from,
    to: opts.to,
    granularity: opts.granularity === 'week' ? 'week' : 'day',
    days: buckets.length,
    totals,
    buckets,
    totalDerived: sawTotal === false,
  }
}

/** 官方侧一次退化：把固定错误码翻成**可操作**的中文提示（不含 Cookie / 上游原文 / 内网地址）。 */
export function officialErrorHint(code) {
  switch (code) {
    case 'official-disabled':
      return '官方向量明细已在配置里关闭（officialUsage: false）。'
    case 'official-no-credentials':
      return '没有可用的控制台 Cookie：在设置里填 BAILIAN_CONSOLE_COOKIE（订阅页控制台会话）后重试。'
    case 'official-login-expired':
      return '控制台会话已过期：重新登录订阅页，再复制一条新的 BAILIAN_CONSOLE_COOKIE。'
    case 'official-download-url':
      return '官方这次把明细放到了对象存储下载链接；本插件不跟随未声明的出站主机，所以无法读取。'
    case 'official-timeout':
      return '官方用量明细接口超时，稍后重试。'
    case 'official-upstream':
      return '官方用量明细接口暂时不可用（上游错误），稍后重试。'
    case 'official-bad-response':
      return '官方返回的结构无法识别（可能改版了），请反馈这条现象。'
    default:
      return '官方用量明细暂不可用。'
  }
}
