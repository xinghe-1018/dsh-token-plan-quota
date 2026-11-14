/**
 * dsh-token-plan-quota — 宿主半边（无本地估算版）。
 *
 * 设计原则：徽标里的数字要么来自**官方接口**，要么明确标注「实测」
 * （只统计经过本实例的真实调用，不折算 Credits、不估算余量）。
 * 徽标跟随当前会话的模型供应商切换；明细面板始终可看全部数据源。
 * 界面还提供两类「真实观测」（不是估算）：本实例实测的 token 吞吐/调用量与
 * 429 限流后的自动重试观测——它们在明细面板里，不冒充官方额度。
 *
 * 各家官方额度接口的实测结论（2026-09，用真实 Key 验证）：
 * - DeepSeek：GET https://api.deepseek.com/user/balance + Bearer Key → 真值（默认源）。
 * - 阿里云费用中心：BssOpenApi + AK/SK 签名（可选源，需 AliyunBSSReadOnlyAccess）。
 * - 千问 Token Plan / MiniMax：**无官方 Key 化额度接口**（官方文档写明仅控制台可见，
 *   对常见路径实测全部 404/返回页面 HTML；条款还禁止套餐 Key 做工具外调用）。
 *   千问用内置的 `token-plan-window` 实测卡顶上：徽标显示 7 天窗口内经过本实例的
 *   真实消耗并标注「实测」；MiniMax 无源可接，要么看明细里的实测用量，
 *   要么把控制台接口按「自定义源」配置进来。
 *
 * 安全边界：
 * - 零第三方依赖；密钥只在本进程内解析，绝不落路由响应；
 * - 路由 /token-plan-quota/* 只回标量与打码后的凭据，仅同源可访问；
 * - 出站请求串行 + 最小间隔；每个数据源独立失败不影响其它源。
 */

import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectSources, hostOf, normalizeToken } from './detect.js'
import {
  DAY_MS,
  FALLBACK_SCAN_BUDGET,
  aggregateUsageRange,
  clampBackfillDays,
  dayKey,
  decodeSessionLog,
  emptyUsageIndex,
  fallbackCutOf,
  fallbackLogsOf,
  fallbackSignature,
  foldUsageEvents,
  loadUsageIndex,
  parseSessionEvents,
  resolveCustomRange,
  resolveMonthRange,
  saveUsageIndex,
  syncUsageIndex,
  trimUsageIndex,
} from './usage-stats.js'
import {
  OFFICIAL_CHUNK_DAYS,
  OFFICIAL_EARLIEST_MONTHS,
  OFFICIAL_STEP_SECONDS,
  buildOfficialUsage,
  foldOfficialSeries,
  mergeOfficialDays,
  officialChunkRequest,
  officialEarliestDayKey,
  officialErrorHint,
  parseOfficialEnvelope,
  sliceOfficialRange,
} from './official-usage.js'

export const name = 'token-plan-quota'

/** 硬依赖：没有 webServer（非 web profile）就没有意义，让 Cordis 等待比空转好。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/token-plan-quota'
const LEDGER_FILE = '$DSH_HOME/token-plan-quota.usage.json'

/** 默认配置；插件行 config 与 ~/.dsh/token-plan-quota.json 依次覆盖。 */
/**
 * 出站声明集合的**代码侧真值**：必须与 `package.json#dshhub.permissions.network` 逐项相等。
 *
 * 两份都在是有意的：这份是给**运行时**用的——请求发出之前要能拒绝未声明主机；package.json 那份
 * 是给宿主与审计看的对外声明。`check-docs` 第 3 项双向核这两份，`test/guards.mjs` 另有正反例。
 *
 * 为什么需要它：声明原先只是**文档承诺**。`endpoint`（用户可配）与自定义源的 `url` 能把请求——
 * 包括带 AK/SK 签名的那个——打到任意主机，而没有任何检查，"声明集合 == 实际出站集合"因此无法成立。
 */
export const DECLARED_HOSTS = [
  'https://api.deepseek.com',
  'https://api.moonshot.cn',
  'https://api.moonshot.ai',
  'https://openrouter.ai',
  'https://business.aliyuncs.com',
  'https://cs-data.qianwenai.com',
  'https://platform-home.qianwenai.com',
  'https://cdn.jsdelivr.net',
]

const DEFAULTS = {
  /** 数据源（按顺序显示）：autoDetect 关掉时的兜底；开着时只作为"用户额外要求的源"叠加在检测结果上。 */
  sources: ['deepseek-balance', 'token-plan-window'],
  /** 零配置：按宿主在用的供应商路由自动补齐额度源（认不准的不开源，用户写过的源永远赢）。 */
  autoDetect: true,
  /** OpenAPI 接入点（阿里云费用中心用）。 */
  endpoint: 'business.aliyuncs.com',
  /**
   * 允许出站打到**未在 `dshhub.permissions.network` 声明**的主机。默认 `false`：
   * 请求发出前会断言主机在声明集合里（宪法 V：两份集合逐项相等）。自定义源指向别处时
   * 必须显式打开——打开后快照里会留一条 notice，不静默降级。
   */
  allowUndeclaredHosts: false,
  regionId: null,
  accessKeyIdRef: 'ALIBABA_CLOUD_ACCESS_KEY_ID',
  accessKeySecretRef: 'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
  securityTokenRef: null,
  /** 远端源快照缓存分钟数；徽标点刷新可强制回源。 */
  refreshMinutes: 10,
  /** 浏览器轮询秒数（本实例实测与吞吐每次实时重算，轮询可以很勤；徽标速度靠它刷新）。 */
  pollSeconds: 10,
  /** 出站最小间隔（毫秒）。 */
  minIntervalMs: 1200,
  timeoutMs: 15000,
  /** 明细面板里显示「本实例实测用量」（token 吞吐 + 自动重试观测）。 */
  showInstanceWindow: true,
  /** 明细面板范围：current = 只列当前模型供应商的卡（+ 本实例实测）；all = 全部数据源。 */
  panelScope: 'current',
  /** true 时把上游响应字段骨架（值打码）回传，方便核对字段名。 */
  debug: false,
  /** 注册 token_plan_quota 模型工具。 */
  exposeTool: true,
  /** 外部 JSON 配置：宿主每次查询前重读，改完不用重启。 */
  configPath: '$DSH_HOME/token-plan-quota.json',
  /** 账本（本实例用量统计）落盘位置。 */
  usagePath: '$DSH_HOME/token-plan-quota.usage.json',
  /**
   * 006 用量统计：把会话事件流折叠成「按本地日 × 供应商/模型」的计数索引。
   * 关掉 = 不同步、不显示（入口保留，界面显式说明已关闭）。
   */
  usageStats: true,
  /** 用量索引落盘位置（只存计数与 id，不存消息文本）。 */
  usageIndexPath: '$DSH_HOME/token-plan-quota.usage-index.json',
  /** 索引保留天数，同时是天数选择的上界（1..365）。 */
  usageBackfillDays: 365,
  /** 009 兜底扫描：把宿主 list() 里没有、但磁盘上还在的会话日志也折进索引。 */
  usageScanFallback: true,
  /** 009 兜底扫描的会话根目录（两级：<项目>/<会话>/session[.vN].jsonl.zstd）。 */
  usageScanPath: '$DSH_HOME/sessions',
  /**
   * 008：调用官方「Token Plan 用量明细」（账号级 tokens，含别的设备/客户端）。
   * 关掉 = 不发那次出站、屏上只留本机实测（界面显式说明已关闭）。
   */
  officialUsage: true,
  /** 同一区间的官方结果缓存分钟数（官方按天聚合，没必要每次刷新都回源）。 */
  officialUsageMinutes: 5,
}

/* ==================================================== 通用小工具 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function nonNegative(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function round(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(value * 1e4) / 1e4
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** `~/.dsh` 目录（尊重 DSH_HOME）。 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * 展开路径前缀：`~/x` 落 OS 家目录，`$DSH_HOME/x` 落 harness 家目录。
 * 默认一律 `$DSH_HOME/…`，避免 DSH_HOME 指向 ~/.dsh 时拼出双层目录。
 */
function expandPath(raw) {
  const value = String(raw ?? '')
  if (value === '$DSH_HOME') return dshHome()
  if (value.startsWith('$DSH_HOME')) {
    const rest = value.slice('$DSH_HOME'.length).replace(/^[\/\\]/, '')
    return rest === '' ? dshHome() : join(dshHome(), rest)
  }
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/* ==================================================== 本实例实测账本
 *
 * 只记录**真实发生在本 DSH 实例的调用**（精确到 token/次），按自然月分桶。
 * 这不是任何供应商的官方额度——UI 中永远不与官方卡混排、不折算、不称「余量」。
 */

const usageLedger = { months: {}, windows: {} }
let usageLoaded = false
let usageDirty = false
let usageTimer = null
let activeUsageFile = null

function usageFileOf(config) {
  const file = expandPath(config?.usagePath ?? LEDGER_FILE)
  activeUsageFile = file
  return file
}

function monthKey(at) {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function loadUsage(config) {
  if (usageLoaded) return
  usageLoaded = true
  const text = readText(usageFileOf(config))
  if (text === undefined) return
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.months)) return
  for (const [key, models] of Object.entries(parsed.months)) {
    if (!isPlainObject(models)) continue
    const bucket = {}
    for (const [name_, entry] of Object.entries(models)) {
      if (!isPlainObject(entry)) continue
      bucket[name_] = {
        input: nonNegative(entry.input),
        cacheRead: nonNegative(entry.cacheRead),
        cacheWrite: nonNegative(entry.cacheWrite),
        output: nonNegative(entry.output),
        calls: nonNegative(entry.calls),
      }
    }
    usageLedger.months[key] = bucket
  }
  // 供应商 → 滚动窗口锚点（startedAt = 本窗口第一次调用；base = 开窗时累计快照）。
  if (isPlainObject(parsed.windows)) {
    for (const [provider, entry] of Object.entries(parsed.windows)) {
      if (!isPlainObject(entry)) continue
      const startedAt = Number(entry.startedAt)
      if (!Number.isFinite(startedAt) || startedAt <= 0) continue
      const lastAt = Number(entry.lastAt)
      const base = {}
      if (isPlainObject(entry.base)) {
        for (const [model, pair] of Object.entries(entry.base)) {
          if (Array.isArray(pair)) base[model] = [nonNegative(pair[0]), nonNegative(pair[1])]
        }
      }
      usageLedger.windows[provider] = { startedAt, lastAt: Number.isFinite(lastAt) ? lastAt : startedAt, base }
    }
  }
  // 恢复吞吐滑动窗口（重启前落盘的最近 5 分钟条目）。
  if (Array.isArray(parsed.recent)) {
    const now = Date.now()
    for (const entry of parsed.recent) {
      if (!isPlainObject(entry)) continue
      const at = Number(entry.at)
      if (!Number.isFinite(at) || now - at > RECENT_WINDOW_MS) continue
      recentCalls.push({
        at,
        tokens: nonNegative(entry.tokens),
        output: nonNegative(entry.output),
        cacheRead: nonNegative(entry.cacheRead),
        provider: String(entry.provider ?? '?'),
        model: String(entry.model ?? '?'),
        elapsedMs: nonNegative(entry.elapsedMs),
      })
    }
    recentCalls.sort((a, b) => a.at - b.at)
    while (recentCalls.length > 0 && now - recentCalls[0].at > RECENT_WINDOW_MS) recentCalls.shift()
  }
}

function pruneUsage() {
  const keys = Object.keys(usageLedger.months).sort()
  while (keys.length > 14) {
    const oldest = keys.shift()
    if (oldest !== undefined) delete usageLedger.months[oldest]
  }
}

function scheduleUsageWrite(ctx) {
  if (usageTimer !== null) return
  usageTimer = setTimeout(() => {
    usageTimer = null
    flushUsage(ctx)
  }, 2000)
  usageTimer.unref?.()
}

function flushUsage(ctx) {
  if (!usageDirty) return
  usageDirty = false
  pruneUsage()
  const file = activeUsageFile ?? usageFileOf(null)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    const now = Date.now()
    // 吞吐滑动窗口随账本落盘：宿主重启后最近 5 分钟的实测还能带回来。
    const persisted = { ...usageLedger, recent: recentCalls.filter(call => now - call.at <= RECENT_WINDOW_MS) }
    writeFileSync(file, JSON.stringify(persisted, null, 1), 'utf8')
  } catch (error) {
    ctx?.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
  }
}

function recordUsage(config, provider, model, usage, at = Date.now(), meta) {
  if (!isPlainObject(usage)) return
  const input = nonNegative(usage.inputTokens)
  const output = nonNegative(usage.outputTokens)
  const cacheRead = nonNegative(usage.cacheReadTokens)
  const cacheWrite = nonNegative(usage.cacheWriteTokens)
  const total = input + output + cacheRead + cacheWrite
  if (total === 0) return
  loadUsage(config)
  // 先滚窗口（base 取入账前的累计），再记这一笔——本笔就落进新窗口里。
  touchWindow(config, provider, at)
  const key = monthKey(at)
  const bucket = (usageLedger.months[key] ??= {})
  const entry = (bucket[`${provider} ${model}`] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 })
  entry.input += input
  entry.cacheRead += cacheRead
  entry.cacheWrite += cacheWrite
  entry.output += output
  entry.calls += 1
  usageDirty = true
  scheduleUsageWrite()
  // 滑动窗口（近 5 分钟）只记标量；月份账在 usageLedger。
  // elapsedMs = 本次流式调用从首分片到 usage 的活跃时长（观测自真实流，不是估算）。
  const startedAt = Number(meta?.startedAt)
  const endedAt = Number(meta?.endedAt ?? at)
  const elapsedMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt && endedAt - startedAt < RECENT_WINDOW_MS
    ? endedAt - startedAt
    : 0
  // 速度口径：output = 生成 tokens（解码速度分子）；tokens = 全量（吞吐口径，含缓存读）。
  recentCalls.push({ at, tokens: total, output, cacheRead, provider: String(provider || '?'), model: String(model || '?'), elapsedMs })
  while (recentCalls.length > 0 && at - recentCalls[0].at > RECENT_WINDOW_MS) recentCalls.shift()
  // 006 的降级数据源：宿主没有 sessionPersistence 时，本进程启动以来的调用只有这里记着。
  recordLiveUsage(config, provider, model, { input, output, cacheRead, cacheWrite }, at)
}

/** 某供应商在全部月份账里的逐模型累计（tokens, calls）——窗口卡用它算「窗口内」。 */
function providerModelTotals(provider) {
  const totals = new Map()
  const prefix = `${provider} `
  for (const models of Object.values(usageLedger.months)) {
    for (const [composite, entry] of Object.entries(models)) {
      if (!composite.startsWith(prefix)) continue
      const model = composite.slice(prefix.length)
      const agg = totals.get(model) ?? { tokens: 0, calls: 0 }
      agg.tokens += entry.input + entry.cacheRead + entry.cacheWrite + entry.output
      agg.calls += entry.calls
      totals.set(model, agg)
    }
  }
  return totals
}

/** 该供应商绑定的窗口天数（取第一个绑定的 window 源；没绑定默认 7 天）。 */
function windowSpanDays(config, provider) {
  for (const source of config?.sources ?? []) {
    if (source.kind === 'window' && Array.isArray(source.providers) && source.providers.includes(provider)) {
      const days = Number(source.windowDays)
      return Number.isFinite(days) && days >= 1 ? days : 7
    }
  }
  return 7
}

/**
 * 滚动窗口锚点：官方 Token Plan 的规则是「到期后第一次调用开启新窗口」。
 * 我们观测不到别的设备/控制台的消耗，所以窗口起点只以**经过本实例的第一次调用**为准。
 */
function touchWindow(config, provider, at) {
  const span = windowSpanDays(config, provider) * 86_400_000
  const current = usageLedger.windows[provider]
  if (current === undefined || at - current.startedAt >= span) {
    const base = {}
    for (const [model, agg] of providerModelTotals(provider)) base[model] = [agg.tokens, agg.calls]
    usageLedger.windows[provider] = { startedAt: at, lastAt: at, base }
  } else {
    current.lastAt = at
  }
  usageDirty = true
}

function resetCurrentMonthUsage(config, ctx) {
  loadUsage(config)
  delete usageLedger.months[monthKey(Date.now())]
  // 「清本周期账本」同时把窗口锚点清零：控制台做过额度重置后想重新起算，就点它。
  for (const key of Object.keys(usageLedger.windows)) delete usageLedger.windows[key]
  usageDirty = true
  flushUsage(ctx)
}

/** 窗口卡：某 window 源绑定供应商在当前窗口内的实测消耗（非官方余量）。 */
function buildWindowCard(source, config) {
  loadUsage(config)
  const now = Date.now()
  const days = Number.isFinite(Number(source.windowDays)) && Number(source.windowDays) >= 1 ? Number(source.windowDays) : 7
  const span = days * 86_400_000
  const providers = Array.isArray(source.providers) ? source.providers : []
  let tokens = 0
  let calls = 0
  let startedAt
  const items = []
  for (const provider of providers) {
    const win = usageLedger.windows[provider]
    if (win === undefined) continue
    if (startedAt === undefined || win.startedAt < startedAt) startedAt = win.startedAt
    for (const [model, agg] of providerModelTotals(provider)) {
      const base = win.base?.[model] ?? [0, 0]
      const used = Math.max(0, agg.tokens - base[0])
      const usedCalls = Math.max(0, agg.calls - base[1])
      if (used === 0 && usedCalls === 0) continue
      tokens += used
      calls += usedCalls
      items.push({ name: model, provider, tokens: round(used), calls: usedCalls })
    }
  }
  items.sort((a, b) => b.tokens - a.tokens)
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'count',
    unit: 'tokens',
    estimated: true,
    bindProviders: providers,
    windowDays: days,
    startedAt,
    resetAt: startedAt === undefined ? undefined : startedAt + span,
    tokens: startedAt === undefined ? undefined : round(tokens),
    calls: startedAt === undefined ? undefined : calls,
    items: items.slice(0, 25),
    veracity: source.veracity ?? 'local',
    sourceNote: source.sourceNote,
    ...(source.detected === undefined ? {} : { detected: source.detected }),
  }
  if (startedAt === undefined) {
    card.emptyReason = '本实例还没有该供应商的调用记录（实测窗口从经过本实例的第一次调用起算）'
  } else {
    card.remainingDays = Math.max(0, Math.ceil((card.resetAt - now) / 86_400_000))
  }
  return card
}

/** 本实例实测卡（非官方额度；徽标不显示，只进明细面板）。 */
function buildInstanceCard(config) {
  loadUsage(config)
  const now = Date.now()
  const key = monthKey(now)
  const cycle = usageLedger.months[key] ?? {}
  const items = []
  let tokens = 0
  let calls = 0
  for (const [composite, entry] of Object.entries(cycle)) {
    const spaceAt = composite.indexOf(' ')
    const provider = spaceAt > 0 ? composite.slice(0, spaceAt) : ''
    const model = spaceAt > 0 ? composite.slice(spaceAt + 1) : composite
    const total = entry.input + entry.cacheRead + entry.cacheWrite + entry.output
    tokens += total
    calls += entry.calls
    items.push({ name: model, provider, tokens: total, calls: entry.calls })
  }
  items.sort((a, b) => b.tokens - a.tokens)
  const card = {
    id: 'instance-usage',
    label: '本实例实测用量',
    labelEn: 'This instance (measured)',
    metric: 'count',
    unit: 'tokens',
    monthKey: key,
    calls,
    tokens,
    items: items.slice(0, 25),
    window: slidingWindow(now),
    veracity: 'local',
    sourceNote: '非官方额度：只统计经过本 DSH 实例的真实调用（精确到 token/次，不折算、不估算）。',
  }
  const retry = retrySnapshot()
  if (retry.length > 0) card.retry = retry
  return card
}

/** 清掉本实例账本与观测（仅供测试隔离）。 */
function resetInstanceState() {
  for (const key of Object.keys(usageLedger.months)) delete usageLedger.months[key]
  for (const key of Object.keys(usageLedger.windows)) delete usageLedger.windows[key]
  for (let i = recentCalls.length; i > 0; i -= 1) recentCalls.pop()
  usageLoaded = true
  usageDirty = false
  if (usageTimer !== null) { clearTimeout(usageTimer); usageTimer = null }
  // 006 用量索引的内存态一并清掉（盘上文件保留，下次同步重新读）。
  usageIndex = null
  usageSync = null
  usageSyncResult = null
  usageLastSyncAt = 0
  usageIndexDirty = false
  usageIndexFile = null
  if (usageIndexTimer !== null) { clearTimeout(usageIndexTimer); usageIndexTimer = null }
  for (const key of [...liveUsageDays.keys()]) liveUsageDays.delete(key)
}

/** 彻底重置（含“从未加载过账本”标记）——测试里模拟宿主重启后重新读盘。 */
function hardResetUsage() {
  resetInstanceState()
  usageLoaded = false
}

/* ==================================================== 用量索引（006）
 *
 * 把**会话事件流**折叠成「按本地日 × 供应商/模型」的计数账，供 /usage 路由与
 * token_plan_quota action=usage 读取。和上面的月账本的区别：
 * - 月账本来自 llm/stream 实时观测，只覆盖本进程启动以来；这里是**持久索引**，能跨重启回填。
 * - 索引只存计数与 id（schema 白名单在 usage-stats.js），不存消息文本 / 请求头 / 路径。
 * - 降级：宿主没有 sessionPersistence 时退回本进程实时日桶（liveUsageDays），并显式标 in-process，
 *   绝不把「统计不到」伪装成 0。
 */

/** 内存索引（null = 还没从盘上加载过）。 */
let usageIndex = null
/** 单飞：正在跑的那一轮同步（null = 空闲）。 */
let usageSync = null
/** 索引写盘防抖 timer（与月账本的 usageTimer 分开，两个文件互不覆盖）。 */
let usageIndexTimer = null
/** 索引是否有未落盘的改动。 */
let usageIndexDirty = false
/** 索引落盘位置（flush 时用；由 runUsageSync 设定）。 */
let usageIndexFile = null
/** 最近一轮同步完成时间（0 = 本进程还没同步过；refreshing 判据用它）。 */
let usageLastSyncAt = 0
/** 最近一轮同步结果（coverage 用它；只有计数，没有会话内容）。 */
let usageSyncResult = null
/** 降级数据源：本进程启动以来按本地日累计的计数（Map<YYYY-MM-DD, 日桶>）。 */
const liveUsageDays = new Map()

const USAGE_SYNC_INTERVAL_MS = 5 * 60_000
const USAGE_SYNC_FIRST_DELAY_MS = 20_000
const USAGE_LIVE_MAX_DAYS = 400
const USAGE_RANGE_PRESETS = { today: 1, '7d': 7, '30d': 30, '90d': 90 }

function usageIndexFileOf(config) {
  return expandPath(config?.usageIndexPath ?? DEFAULTS.usageIndexPath)
}

/**
 * 懒加载索引：重启后第一次打开用量屏时，内存里还没有这份索引，而首轮同步要等启动 20 秒后。
 * 这里同步读一次盘，让第一个请求就能看到历史；读失败由 loadUsageIndex 兜底成空索引（坏文件会备份），
 * 不把异常抛给路由。
 */
function ensureUsageIndexLoaded(config) {
  if (usageIndex !== null) return
  usageIndexFile = usageIndexFileOf(config)
  usageIndex = loadUsageIndex(usageIndexFile, { retentionDays: clampBackfillDays(config?.usageBackfillDays) })
}

/** 宿主 sessionPersistence 服务；没有就返回 undefined（降级，不是错误）。 */
function persistenceOf(ctx) {
  const service = typeof ctx?.get === 'function' ? ctx.get('sessionPersistence', false) : false
  return service === undefined || service === null || service === false ? undefined : service
}

/** 实时日桶入账（recordUsage 末尾调用）；字段形状与索引 days 相同，聚合直接共用一条路径。 */
function recordLiveUsage(config, provider, model, counters, at = Date.now()) {
  const key = dayKey(at)
  let day = liveUsageDays.get(key)
  if (day === undefined) {
    day = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, models: {} }
    liveUsageDays.set(key, day)
  }
  const modelId = String(provider || 'unknown') + '/' + String(model || 'unknown')
  const entry = (day.models[modelId] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const value = nonNegative(counters?.[field])
    if (value === 0) continue
    day[field] += value
    entry[field] += value
  }
  day.calls += 1
  entry.calls += 1
  // 修剪：只留 usageBackfillDays 内的日桶，且最多 400 个日键（长跑进程不能一直涨）。
  const floor = dayKey(at - clampBackfillDays(config?.usageBackfillDays) * DAY_MS)
  for (const dayKeyName of [...liveUsageDays.keys()]) if (dayKeyName < floor) liveUsageDays.delete(dayKeyName)
  while (liveUsageDays.size > USAGE_LIVE_MAX_DAYS) {
    const oldest = [...liveUsageDays.keys()].sort()[0]
    liveUsageDays.delete(oldest)
  }
}

/** 实时日桶 → 与索引同形的对象（聚合函数对两种来源只写一条路径）。 */
function liveUsageAsIndex() {
  const index = emptyUsageIndex()
  for (const [key, day] of liveUsageDays) index.days[key] = day
  return index
}

/** 索引写盘：2s 防抖 + 原子写；写失败只记诊断，内存里的计数照旧可读。 */
function scheduleUsageIndexWrite(ctx) {
  usageIndexDirty = true
  if (usageIndexTimer !== null) return
  usageIndexTimer = setTimeout(() => {
    usageIndexTimer = null
    flushUsageIndexWrite(ctx)
  }, 2000)
  usageIndexTimer.unref?.()
}

function flushUsageIndexWrite(ctx) {
  if (!usageIndexDirty || usageIndex === null || usageIndexFile === null) return
  usageIndexDirty = false
  try {
    saveUsageIndex(usageIndexFile, usageIndex)
  } catch (error) {
    ctx?.logger?.warn?.(new Error('token-plan-quota: 用量索引写盘失败，内存计数不受影响 —— ' + (error instanceof Error ? error.message : String(error))))
  }
}

/**
 * 一轮同步（单飞）：读盘 → 增量折叠 → 防抖落盘。永不 reject（调用方可能是定时器）。
 * 并发调用拿到同一个 promise，不会堆叠 IO。
 */
function runUsageSync(ctx, config) {
  if (usageSync !== null) return usageSync
  usageSync = (async () => {
    const startedAt = Date.now()
    try {
      const persistence = persistenceOf(ctx)
      const scanFallback = config?.usageScanFallback !== false
      const emptyScan = { scanned: 0, rescued: 0, scanFailed: 0, scanDeferred: 0 }
      // 没有 sessionPersistence 但兜底目录可扫时不能早退：磁盘上的会话日志仍能出数。
      if (persistence === undefined && !scanFallback) {
        usageSyncResult = { ok: false, skipped: 'no-session-persistence', sessions: 0, indexed: 0, failed: 0, unknownModel: 0, skippedOld: 0, ...emptyScan, durationMs: 0 }
        usageLastSyncAt = Date.now()
        return usageSyncResult
      }
      const retentionDays = clampBackfillDays(config?.usageBackfillDays)
      usageIndexFile = usageIndexFileOf(config)
      if (usageIndex === null) usageIndex = loadUsageIndex(usageIndexFile, { retentionDays })
      const result = await syncUsageIndex({
        persistence,
        index: usageIndex,
        config,
        sessionsDir: expandPath(config?.usageScanPath ?? DEFAULTS.usageScanPath),
        scanFallback,
      })
      trimUsageIndex(usageIndex, retentionDays)
      usageSyncResult = result
      usageLastSyncAt = Date.now()
      if (result.ok) scheduleUsageIndexWrite(ctx)
      return result
    } catch (error) {
      ctx?.logger?.warn?.(new Error('token-plan-quota: 用量索引同步失败，下一轮重试 —— ' + (error instanceof Error ? error.message : String(error))))
      usageSyncResult = { ok: false, skipped: 'sync-failed', sessions: 0, indexed: 0, failed: 0, unknownModel: 0, skippedOld: 0, scanned: 0, rescued: 0, scanFailed: 0, scanDeferred: 0, durationMs: Date.now() - startedAt }
      usageLastSyncAt = Date.now()
      return usageSyncResult
    } finally {
      usageSync = null
    }
  })()
  return usageSync
}

/** 服务端夹紧天数：days 优先，range 预设兜底，再默认 7；上界 usageBackfillDays。 */
function resolveUsageDays(config, query = {}) {
  const backfill = clampBackfillDays(config?.usageBackfillDays)
  let days
  const rawDays = query?.days
  if (rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== '') {
    const parsed = Number(rawDays)
    if (Number.isFinite(parsed)) days = Math.round(parsed)
  }
  if (days === undefined) {
    const range = typeof query?.range === 'string' ? query.range.trim() : ''
    days = USAGE_RANGE_PRESETS[range]
  }
  if (days === undefined) days = 7
  return Math.min(backfill, Math.max(1, days))
}

/**
 * 解析 from/to 自定义区间（007 §2）：两端都在才走自定义分支；只给一端按非法处理，
 * 不猜另一端（猜错会给出一个用户没要的区间，比 400 更难发现）。
 * 返回 null（走 006 的 range/days）/ { error }（400 语义）/ { from, to, days }。
 */
function resolveUsageCustom(config, query = {}) {
  const rawFrom = query?.from
  const rawTo = query?.to
  const hasFrom = rawFrom !== undefined && rawFrom !== null && String(rawFrom).trim() !== ''
  const hasTo = rawTo !== undefined && rawTo !== null && String(rawTo).trim() !== ''
  if (!hasFrom && !hasTo) return null
  if (hasFrom !== hasTo) return { error: 'usage-bad-range' }
  return resolveCustomRange({
    now: Date.now(),
    from: String(rawFrom),
    to: String(rawTo),
    maxDays: config?.usageBackfillDays,
  })
}

/**
 * 解析 month 自然月（010 §2.1）：返回 null（没给 month）/ { error }（400 语义）/ { month, from, to, days }。
 * month 与 from/to 同给按非法处理：两种口径同时出现时无从判断用户要哪个，猜一个比 400 更难发现。
 * days / range 与 month 同时出现则忽略（月区间是完整口径，不裁短）。
 */
function resolveUsageMonth(config, query = {}) {
  const rawMonth = query?.month
  const hasMonth = rawMonth !== undefined && rawMonth !== null && String(rawMonth).trim() !== ''
  if (!hasMonth) return null
  const rawFrom = query?.from
  const rawTo = query?.to
  const hasFrom = rawFrom !== undefined && rawFrom !== null && String(rawFrom).trim() !== ''
  const hasTo = rawTo !== undefined && rawTo !== null && String(rawTo).trim() !== ''
  if (hasFrom || hasTo) return { error: 'usage-bad-range' }
  return resolveMonthRange({ now: Date.now(), month: String(rawMonth) })
}

/**
 * 用量快照（GET /usage 的 200 原样 JSON，也是工具 action=usage 的数据源）。
 * 只有计数与标量：不含消息文本 / 请求头 / Cookie / 文件路径（诊断只进 logger）。
 */
function buildUsageSnapshot(config, ctx, query = {}) {
  const now = Date.now()
  const enabled = config?.usageStats !== false
  // 010：month 优先级高于 from/to（INTERFACE §1.2）；month 合法时 from/to 不再参与。
  const month = resolveUsageMonth(config, query)
  const custom = month !== null ? null : resolveUsageCustom(config, query)
  // 参数错误不是快照：路由据此回 400 固定码（007 §2 / 010 §2），工具据此回 ok=false。
  // 刻意不把错误包进 200 快照：客户端拿到 range.kind 才有意义，混着 error 会让两种状态同屏。
  const failure = month?.error !== undefined ? { error: month.error } : custom?.error !== undefined ? custom : null
  if (failure !== null) {
    const out = { error: failure.error }
    if (failure.maxDays !== undefined) out.maxDays = failure.maxDays
    return out
  }
  const days = month !== null ? month.days : custom !== null ? custom.days : resolveUsageDays(config, query)
  const persistence = persistenceOf(ctx)
  const liveOnly = persistence === undefined
  const liveHasData = liveUsageDays.size > 0
  // 重启后第一次打开用量屏：先同步读一次索引，别让首请求在首轮同步之前显示全 0。
  if (enabled && !liveOnly) ensureUsageIndexLoaded(config)
  // 关掉统计时 totals 必须是 0（不能把索引里的历史数当"仍然统计中"展示出去）。
  const base = !enabled ? emptyUsageIndex() : liveOnly ? liveUsageAsIndex() : (usageIndex ?? emptyUsageIndex())
  const aggregate = aggregateUsageRange(base, month !== null
    ? { now, month: month.month }
    : custom !== null ? { now, days, from: custom.from, to: custom.to } : { days, now })
  const indexKind = { kind: 'session-index', veracity: 'measured', label: '本实例实测（来自本地会话记录）' }
  const liveKind = { kind: 'in-process', veracity: 'measured', label: '本进程启动以来（实测）' }
  let source = liveOnly ? liveKind : indexKind
  let emptyReason
  let hint
  if (!enabled) {
    source = { kind: 'disabled', veracity: 'measured', label: '用量统计已关闭' }
    emptyReason = 'usage-stats-disabled'
    hint = '在插件配置里把 usageStats 设为 true'
  } else if (liveOnly && !liveHasData) {
    emptyReason = 'no-session-persistence'
    hint = '宿主未提供 sessionPersistence（只能统计本进程启动以来的调用，重启后归零）'
  } else if (aggregate.totals.calls === 0) {
    // 「本实例还没有任何会话记录」与「有会话但区间内没有调用」是两件事：前者同步结果
    // sessions===0（list 返回空数组），后者只是区间内没命中。别把前者也说成 no-usage-in-range。
    const noSessions = usageSyncResult?.ok === true && Number(usageSyncResult.sessions) === 0
    emptyReason = noSessions ? 'no-sessions' : 'no-usage-in-range'
    hint = noSessions ? '本实例还没有会话记录' : '先在本实例调用一次模型'
  }
  const result = usageSyncResult
  const coverage = {
    // 没跑过同步时别谎报 0 个会话：内存索引里已经有条目就按条目数报（首请求读盘后的场景）。
    sessions: Number.isFinite(result?.sessions) ? result.sessions : Object.keys(usageIndex?.sessions ?? {}).length,
    indexed: Number.isFinite(result?.indexed) ? result.indexed : (usageIndex !== null ? Object.keys(usageIndex.sessions).length : 0),
    failed: Number.isFinite(result?.failed) ? result.failed : 0,
    unknownModel: nonNegative(usageIndex?.stats?.unknownModel),
    skippedOld: nonNegative(usageIndex?.stats?.skippedOld),
    scanned: Number.isFinite(result?.scanned) ? result.scanned : 0,
    rescued: Number.isFinite(result?.rescued) ? result.rescued : 0,
    scanFailed: Number.isFinite(result?.scanFailed) ? result.scanFailed : 0,
    scanDeferred: Number.isFinite(result?.scanDeferred) ? result.scanDeferred : 0,
  }
  // refreshing 只表示「确实有一轮同步在飞」（INTERFACE §2）。不能把它等同于「距上次同步
  // 超过 60s」：同步 5 分钟一次，那样两次之间 4/5 的时间面板都在喊「正在同步…」，而且每个
  // 请求都会反向踢一轮同步 —— 真桌面实例上实测如此。
  const refreshing = usageSync !== null
  // 「该同步了」是另一个判据：只用来踢一轮异步同步，不阻塞这次响应（单飞保证不堆叠）。
  if (!refreshing && enabled && !liveOnly && now - usageLastSyncAt > 60_000) void runUsageSync(ctx, config)
  const payload = {
    generatedAt: now,
    enabled,
    range: aggregate.range,
    granularity: aggregate.granularity,
    totals: aggregate.totals,
    buckets: aggregate.buckets,
    models: aggregate.models,
    source,
    coverage,
    refreshing,
  }
  if (emptyReason !== undefined) payload.emptyReason = emptyReason
  if (hint !== undefined) payload.hint = hint
  return payload
}

/** month 区间的标题片段：2026-09 → 「2026 年 9 月（30 天）」。 */
function monthRangeLabel(range) {
  return Number(range.month.slice(0, 4)) + ' 年 ' + Number(range.month.slice(5)) + ' 月（' + range.days + ' 天）'
}

/** 工具文本：一句话说清口径（本实例实测，不是供应商余量）。 */
function summarizeUsageText(usage) {
  const head = usage.range.kind === 'month'
    ? monthRangeLabel(usage.range)
    : usage.range.kind === 'custom'
      ? usage.range.from + ' 至 ' + usage.range.to + '（' + usage.range.days + ' 天）'
      : usage.range.days === 1 ? '今天' : '近 ' + usage.range.days + ' 天'
  if (usage.emptyReason === 'usage-stats-disabled') return head + '用量统计已关闭（把插件配置的 usageStats 设为 true 后可查）'
  const scope = usage.source?.kind === 'in-process' ? '本进程启动以来（实测）' : '本实例实测'
  const totals = usage.totals
  const text = head + scope + '：input ' + totals.input + ' / output ' + totals.output + ' / cacheRead ' + totals.cacheRead
    + ' / cacheWrite ' + totals.cacheWrite + ' tokens，共 ' + totals.calls + ' 次调用（覆盖 ' + usage.coverage.sessions + ' 个会话）'
  if (usage.emptyReason !== undefined) return text + '——' + (usage.hint ?? '这个区间没有记录到调用')
  return text
}

/** 工具输出只保留 INTERFACE 列出的字段（不带 refreshing / generatedAt / hint 这类瞬态与提示）。 */
function usageForTool(usage) {
  const out = { range: usage.range, granularity: usage.granularity, totals: usage.totals, models: usage.models, coverage: usage.coverage, source: usage.source }
  if (usage.emptyReason !== undefined) out.emptyReason = usage.emptyReason
  return out
}

/* ==================================================== 官方账号侧用量（008） */

/**
 * 官方「Token Plan 用量明细」：账号级的 tokens（含别的设备 / 别的客户端走同一个 Key 的用量）。
 *
 * 为什么要有这一块：/usage 只折**本实例**的会话日志，用户拿官方页 20 亿对本地 12.5 亿时，
 * 只靠本机账永远说不清差额是谁的。官方 usage detail 的正规单位就是 tokens（不是控制台的计费点数），
 * 正好补这个洞；但它是**控制台网关**接口，形态与本插件已有的四张卡都不同：
 * - Api 不在 apiPrefix 下（要整条覆盖）；
 * - 单次区间 ≤ 30 天（网关实测；官方页面写 31 但会被拒）、最早只能查「当前月往前 5 个月的 1 号」⇒ 长区间切片 + 夹紧；
 * - 数据层要"向下找 originData 那层"，且可能有多种退化（只给下载链接）。
 *
 * 纪律：这里只缓存**计数与区间**（不存 Cookie / 不存原始响应），失败一律回固定错误码 +
 * 中文提示，绝不把上游 message 原文或凭据值带到路由响应里。
 */

/** 官方结果缓存：key = from + '|' + to。最多留 12 条（一份 365 天查询分 12 片/种区间也够用）。 */
const officialCache = new Map()
const OFFICIAL_CACHE_LIMIT = 12

function officialCacheMinutes(config) {
  const minutes = Number(config?.officialUsageMinutes)
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULTS.officialUsageMinutes
}

/** 控制台预设：用户没把这条源写进 sources 时也照样能取凭据（它就是一张卡的预设，不是"必须挂载"）。 */
function consoleSourceFor(config) {
  const sources = Array.isArray(config?.sources) ? config.sources : []
  const hit = sources.find(item => item?.builder === 'token-plan-console')
  return hit ?? { ...PRESETS['token-plan-console'] }
}

/**
 * 把 /usage 的查询参数翻成官方侧区间。
 *
 * 预设天数**复用 aggregateUsageRange 的日键算法**（拿空索引跑一遍只为借 range）：两边必须
 * 是同一天起、同一天止，否则「官方」与「本机」两格数字比的不是同一段时间。
 */
function resolveOfficialRange(config, query, now) {
  // 010：与本机 /usage 共用同一份 month 解析，两边区间才不会一宽一窄。
  const month = resolveUsageMonth(config, query)
  if (month?.error !== undefined) return { error: month.error, paramError: true }
  if (month !== null) return { kind: 'month', month: month.month, days: month.days, from: month.from, to: month.to }
  const custom = resolveUsageCustom(config, query)
  if (custom?.error !== undefined) {
    const failure = { error: custom.error, paramError: true }
    if (custom.maxDays !== undefined) failure.maxDays = custom.maxDays
    return failure
  }
  if (custom !== null) return { kind: 'custom', days: custom.days, from: custom.from, to: custom.to }
  const days = resolveUsageDays(config, query)
  const probe = aggregateUsageRange(emptyUsageIndex(), { now, days })
  return { kind: probe.range.kind, days: probe.range.days, from: probe.range.from, to: probe.range.to }
}

/** 网关异常 → 固定错误码。分类的判据只有「登录态」与「超时」两件可操作的事，其余归上游。 */
function officialFailureOf(error) {
  const code = error instanceof SourceError ? String(error.code ?? '') : ''
  const text = error instanceof Error ? error.message : String(error)
  let key = 'official-upstream'
  if (/notlogined|notauthorised|missingsectoken|login/i.test(code) || /NotLogined|NotAuthorised/i.test(text)) key = 'official-login-expired'
  else if (/timeout|aborted|abort/i.test(code + ' ' + text)) key = 'official-timeout'
  else if (code === 'BadResponse') key = 'official-bad-response'
  return { error: 'official-unavailable', code: key, hint: officialErrorHint(key) }
}

function rememberOfficial(cacheKey, payload) {
  officialCache.set(cacheKey, { at: payload.generatedAt, payload })
  while (officialCache.size > OFFICIAL_CACHE_LIMIT) {
    const oldest = officialCache.keys().next()
    if (oldest.done === true) break
    officialCache.delete(oldest.value)
  }
}

/**
 * GET /token-plan-quota/usage-official 的 200 原样 JSON。
 *
 * 参数语义与 /usage 完全一致（resolveUsageCustom / resolveUsageDays 同一份代码），
 * 只额外支持 fresh=1 强制回源。参数错误用 paramError 标记，由路由回 400（与 /usage 同码）。
 */
async function buildOfficialUsageSnapshot(config, ctx, query = {}, options = {}) {
  const now = Date.now()
  if (config?.officialUsage === false) {
    return { error: 'official-unavailable', code: 'official-disabled', hint: officialErrorHint('official-disabled') }
  }
  const range = resolveOfficialRange(config, query, now)
  if (range?.error !== undefined) return range

  const source = consoleSourceFor(config)
  if (typeof source.telemetryApi !== 'string' || source.telemetryApi === '') {
    // 自定义源顶掉了预设字段时会出现：这不是用户能修的配置，按响应结构不认识处理，别硬拼一个 Api。
    return { error: 'official-unavailable', code: 'official-bad-response', hint: officialErrorHint('official-bad-response') }
  }
  const earliest = officialEarliestDayKey({ now, monthsBack: source.telemetryEarliestMonths ?? OFFICIAL_EARLIEST_MONTHS })
  const sliced = sliceOfficialRange({
    from: range.from,
    to: range.to,
    chunkDays: source.telemetryChunkDays ?? OFFICIAL_CHUNK_DAYS,
    earliest,
  })
  if (sliced?.error !== undefined) {
    return { error: 'official-unavailable', code: 'official-bad-response', hint: officialErrorHint('official-bad-response') }
  }
  const cacheKey = sliced.from + '|' + sliced.to
  const hit = officialCache.get(cacheKey)
  const ttl = officialCacheMinutes(config) * 60_000
  if (options.fresh !== true && hit !== undefined && now - hit.at < ttl) {
    return {
      ...hit.payload,
      generatedAt: now,
      // kind / month 跟着**本次请求**走：同一段日期既可能来自预设、自定义区间，也可能来自自然月，
      // 缓存只按 from|to 命中，别把上一次的 kind 或 month 回给这次调用。
      range: {
        kind: range.kind,
        ...(range.month !== undefined ? { month: range.month } : {}),
        days: hit.payload.range.days,
        from: hit.payload.range.from,
        to: hit.payload.range.to,
      },
      coverage: { ...hit.payload.coverage, cached: true },
    }
  }

  const cookie = (await resolveSecret(source.cookieRef ?? 'BAILIAN_CONSOLE_COOKIE', config, ctx))?.value
  if (typeof cookie !== 'string' || cookie === '') {
    return { error: 'official-unavailable', code: 'official-no-credentials', hint: officialErrorHint('official-no-credentials') }
  }
  const explicit = typeof source.secTokenRef === 'string' && source.secTokenRef !== ''
    ? (await resolveSecret(source.secTokenRef, config, ctx))?.value
    : undefined
  let secProbe
  try {
    secProbe = await resolveConsoleSecToken(config, { ...source, _secToken: explicit }, cookie)
  } catch (error) {
    return officialFailureOf(error)
  }

  const merged = new Map()
  for (const chunk of sliced.chunks) {
    const request = officialChunkRequest(chunk, { stepSeconds: source.telemetryStepSeconds ?? OFFICIAL_STEP_SECONDS })
    if (request?.error !== undefined) {
      return { error: 'official-unavailable', code: 'official-bad-response', hint: officialErrorHint('official-bad-response') }
    }
    let gateway
    try {
      gateway = await callConsoleGateway(config, source, cookie, 'usage', secProbe.secToken, secProbe, {
        apiPath: source.telemetryApi,
        envelope: true,
        data: {
          reqDTO: {
            productMode: 'TokenPlanPersonal',
            startTime: request.startTime,
            endTime: request.endTime,
            step: request.step,
            metricFilters: [{ aggMethod: 'sum', metricName: 'model_usage' }],
          },
        },
      })
    } catch (error) {
      ctx?.logger?.warn?.(new Error('token-plan-quota: 官方用量明细请求失败 —— ' + (error instanceof Error ? error.message : String(error))))
      return officialFailureOf(error)
    }
    const parsed = parseOfficialEnvelope(gateway.envelope ?? gateway.data)
    if (parsed.downloadUrl !== undefined) {
      return { error: 'official-unavailable', code: 'official-download-url', hint: officialErrorHint('official-download-url') }
    }
    if (parsed.error !== undefined) {
      return { error: 'official-unavailable', code: 'official-bad-response', hint: officialErrorHint('official-bad-response') }
    }
    const folded = foldOfficialSeries(parsed.series, { dayStart: chunk.from, dayEnd: chunk.to })
    mergeOfficialDays(merged, folded.days)
  }

  const built = buildOfficialUsage({ from: sliced.from, to: sliced.to, days: merged })
  if (built?.error !== undefined) {
    return { error: 'official-unavailable', code: 'official-bad-response', hint: officialErrorHint('official-bad-response') }
  }
  const coverage = {
    api: source.telemetryApi,
    chunks: sliced.chunks.length,
    step: 'day',
    cached: false,
    totalDerived: built.totalDerived,
  }
  // 夹紧必须显式说出来：用户要 2026-01 起，官方最早只到 2026-06 —— 静默截断会让人以为一月真的没用量。
  if (sliced.clampedFrom !== undefined) coverage.clampedFrom = sliced.clampedFrom
  const payload = {
    generatedAt: now,
    range: {
      kind: range.kind,
      ...(range.month !== undefined ? { month: range.month } : {}),
      days: sliced.days,
      from: sliced.from,
      to: sliced.to,
    },
    granularity: 'day',
    totals: built.totals,
    buckets: built.buckets,
    source: { kind: 'official-console', veracity: 'verified', label: '官方账号侧（Token Plan 用量明细）' },
    coverage,
  }
  rememberOfficial(cacheKey, payload)
  return payload
}

/** 工具文本：一句话说清「这是账号级官方口径」与总量。 */
function summarizeOfficialText(official) {
  const head = official.range.kind === 'month'
    ? monthRangeLabel(official.range)
    : official.range.kind === 'custom'
      ? official.range.from + ' 至 ' + official.range.to + '（' + official.range.days + ' 天）'
      : official.range.days === 1 ? '今天' : '近 ' + official.range.days + ' 天'
  const totals = official.totals
  return head + '官方账号侧（Token Plan 用量明细）：共 ' + totals.tokens + ' tokens'
    + '（input ' + totals.input + ' / cacheRead ' + totals.cacheRead + ' / output ' + totals.output + '）'
    + '——账号级，含其他设备/客户端走同一个 Key 的用量'
}

/* ==================================================== 滑动 TPM + 重试观测 */

/** 近 5 分钟的逐次调用（滑动吞吐用；只存标量）。 */
const recentCalls = []
const RECENT_WINDOW_MS = 5 * 60_000

/** 限流与自动重试的观测态（本次进程启动以来）。 */
const retryWatch = {
  byProvider: new Map(),
}

function watchBucket(provider) {
  const key = String(provider || '?')
  let bucket = retryWatch.byProvider.get(key)
  if (bucket === undefined) {
    bucket = { provider: key, attempts: 0, lastAt: null, lastDelayMs: null, lastCode: null, lastRetry: null, abandoned: 0, lastAbandonAt: null, lastAbandonCode: null, policy: null, policyFixedMs: null, policyQuotaRetryable: null }
    retryWatch.byProvider.set(key, bucket)
  }
  return bucket
}

/**
 * 解析 llm-retry 记下的 policyKey（策略内容的 JSON 快照）：
 * normal → [mode, maxRetries, retryableCodes, initial, max, jitter]
 * always → [mode, initial, max, jitter]
 */
export function parsePolicyKey(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const mode = parsed[0]
  if (mode !== 'normal' && mode !== 'always') return null
  const codes = Array.isArray(parsed[2]) ? parsed[2] : []
  const maxRetries = mode === 'normal' ? parsed[1] : undefined
  const initial = mode === 'normal' ? parsed[3] : parsed[1]
  const max = mode === 'normal' ? parsed[4] : parsed[2]
  const jitter = mode === 'normal' ? parsed[5] : parsed[3]
  return {
    mode,
    maxRetries,
    retryableCodes: codes,
    initialDelayMs: initial,
    maxDelayMs: max,
    jitterRatio: jitter,
    fixedDelayMs: initial === max && jitter === 0 ? initial : undefined,
    quotaRetryable: codes.includes('QUOTA'),
  }
}

function observeRetryEvent(data) {
  const bucket = watchBucket(data?.provider)
  const policy = parsePolicyKey(data?.policyKey)
  bucket.attempts += 1
  bucket.lastAt = typeof data?.time === 'number' ? data.time : Date.now()
  bucket.lastDelayMs = typeof data?.delayMs === 'number' ? Math.round(data.delayMs) : null
  bucket.lastRetry = typeof data?.retry === 'number' ? data.retry : null
  bucket.maxRetries = typeof data?.maxRetries === 'number' ? data.maxRetries : bucket.maxRetries ?? null
  bucket.lastCode = data?.failure?.code ?? bucket.lastCode
  if (policy !== null) {
    bucket.policy = policy
    bucket.policyFixedMs = policy.fixedDelayMs
    bucket.policyQuotaRetryable = policy.quotaRetryable
  }
}

function observeAbandoned(provider, code) {
  const bucket = watchBucket(provider)
  bucket.abandoned += 1
  bucket.lastAbandonAt = Date.now()
  bucket.lastAbandonCode = code ?? null
}

/** 滑动 TPM：近 60 秒 / 近 5 分钟的 token 吞吐与请求数（实测）。 */
function slidingWindow(now = Date.now()) {
  let tpm60 = 0
  let calls60 = 0
  let tpm300 = 0
  let calls300 = 0
  let cache60 = 0
  for (const call of recentCalls) {
    const age = now - call.at
    if (age <= 60_000) {
      tpm60 += call.tokens
      cache60 += call.cacheRead
      calls60 += 1
    }
    if (age <= RECENT_WINDOW_MS) {
      tpm300 += call.tokens
      calls300 += 1
    }
  }
  return { tpm60: round(tpm60), calls60, cacheRead60: round(cache60), tpm300: round(tpm300), calls300, windowSeconds: 60, observedSeconds: Math.round(RECENT_WINDOW_MS / 1000) }
}

/**
 * 吞吐速度快照（全部来自实测，不估算）。两个口径分开，绝不混：
 * - 吞吐（量）：tpm60/tokens300 = 全部 tokens（含缓存读）——计费/搬运视角；
 * - 速度（生成）：lastTps/genTps/outTps60 = **输出 tokens** ÷ 流式活跃秒——
 *   用户可感知的解码速度；分子分母都只算有流时长观测的调用（防超短流外推、
 *   防缓存读把速度吹成几万 tok/s）。
 * byProvider 按供应商归因，供徽标跟随模型取行。
 */
function throughputSnapshot(now = Date.now()) {
  let tpm60 = 0
  let out60 = 0
  let calls60 = 0
  let cacheRead60 = 0
  let tokens300 = 0
  let calls300 = 0
  let activeMs300 = 0
  let activeOut300 = 0
  const rows = new Map()
  for (const call of recentCalls) {
    const age = now - call.at
    if (age > RECENT_WINDOW_MS) continue
    const provider = call.provider ?? '?'
    const row = rows.get(provider) ?? { provider, model: null, tpm60: 0, out60: 0, calls60: 0, tokens300: 0, calls300: 0, activeMs300: 0, activeOut300: 0, lastAt: null, lastTps: null, lastTpsAt: null }
    tokens300 += call.tokens
    calls300 += 1
    row.tokens300 += call.tokens
    row.calls300 += 1
    if (call.elapsedMs > 0 && call.output > 0) {
      activeMs300 += call.elapsedMs
      activeOut300 += call.output
      row.activeMs300 += call.elapsedMs
      row.activeOut300 += call.output
      row.lastTps = round(call.output / (call.elapsedMs / 1000))
      row.lastTpsAt = call.at
    }
    row.lastAt = call.at
    row.model = call.model ?? row.model
    if (age <= 60_000) {
      tpm60 += call.tokens
      out60 += call.output
      calls60 += 1
      cacheRead60 += call.cacheRead
      row.tpm60 += call.tokens
      row.out60 += call.output
      row.calls60 += 1
    }
    rows.set(provider, row)
  }
  const byProvider = [...rows.values()]
    .map(row => ({
      provider: row.provider,
      model: row.model,
      tpm60: round(row.tpm60),
      out60: round(row.out60),
      outTps60: round(row.out60 / 60),
      calls60: row.calls60,
      tokens300: round(row.tokens300),
      calls300: row.calls300,
      activeSeconds: round(row.activeMs300 / 1000),
      genTps: row.activeMs300 > 1000 ? round(row.activeOut300 / (row.activeMs300 / 1000)) : null,
      lastAt: row.lastAt,
      lastTps: row.lastTps,
      lastTpsAt: row.lastTpsAt,
    }))
    .sort((a, b) => b.tokens300 - a.tokens300)
  return {
    windowSeconds: 60,
    observedSeconds: Math.round(RECENT_WINDOW_MS / 1000),
    tpm60: round(tpm60),
    out60: round(out60),
    outTps60: round(out60 / 60),
    calls60,
    cacheRead60: round(cacheRead60),
    tokens300: round(tokens300),
    calls300,
    activeSeconds: round(activeMs300 / 1000),
    genTps: activeMs300 > 1000 ? round(activeOut300 / (activeMs300 / 1000)) : null,
    byProvider,
  }
}

function retrySnapshot() {
  const rows = []
  for (const bucket of retryWatch.byProvider.values()) {
    if (bucket.attempts === 0 && bucket.abandoned === 0) continue
    rows.push({
      provider: bucket.provider,
      attempts: bucket.attempts,
      lastAt: bucket.lastAt,
      lastDelayMs: bucket.lastDelayMs,
      lastRetry: bucket.lastRetry,
      maxRetries: bucket.maxRetries ?? undefined,
      lastCode: bucket.lastCode ?? undefined,
      abandoned: bucket.abandoned,
      lastAbandonAt: bucket.lastAbandonAt ?? undefined,
      lastAbandonCode: bucket.lastAbandonCode ?? undefined,
      fixedDelayMs: bucket.policyFixedMs ?? undefined,
      quotaRetryable: bucket.policyQuotaRetryable ?? undefined,
      mode: bucket.policy?.mode,
      retryableCodes: bucket.policy?.retryableCodes,
    })
  }
  return rows
}

/**
 * 包一层 llm/stream 的返回流：原样透传分片，遇 usage 分片回调一次，
 * 并带上本流的首分片/usage 时刻——用来算**真实生成速度**（tokens ÷ 活跃秒）。
 * 全插件唯一碰模型请求路径的地方，契约必须严格（分片顺序/数量/错误/提前关闭）。
 */
export function observeStream(iterable, onUsage) {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      let startedAt = null
      try {
        for (;;) {
          const step = await iterator.next()
          if (step.done === true) break
          const chunk = step.value
          const now = Date.now()
          if (startedAt === null) startedAt = now
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
            try {
              onUsage(chunk.usage, { startedAt, endedAt: now })
            } catch { /* 观测失败绝不影响模型流 */ }
          }
          yield chunk
        }
      } finally {
        // 消费者提前 break/return（turn 取消）时把关闭动作传下去。
        await iterator.return?.()
      }
    },
  }
}

/* ==================================================== 官方数据源 */

/** 百炼 / 阿里云费用中心系商品的过滤词。 */
const BAILIAN_KEYWORDS = ['token', 'sfm', 'bailian', '百炼', 'dashscope', '灵积', '大模型', 'model studio', 'modelstudio', 'qwen', '通义']

/**
 * 数据源预设。`kind:'single'` 抽标量成卡；`kind:'list'` 聚合实例数组；
 * 字段路径用候选列表逐个尝试（不同版本有 Data 信封差异）。
 */
// 声明必须早于 PRESETS：预设里引用它，放在后面会撞暂时性死区（本机实测 ReferenceError）。
/**
 * 千问控制台的登录票据名。**唯一来源**：预设与 NotLogined 诊断都引用它。
 * 曾经两处各写一遍字面量（兜底里又抄一次），预设改名而兜底忘改，诊断就会点一张不存在的票据
 * ——第四轮审查第 1 条。名字不是秘密（凭据纪律禁的是值），所以可以出现在文案里。
 */
const DEFAULT_LOGIN_TICKET_COOKIE = 'login_qianwenai_ticket'

const PRESETS = {
  'deepseek-balance': {
    label: 'DeepSeek 余额',
    labelEn: 'DeepSeek balance',
    kind: 'single',
    metric: 'money',
    url: 'https://api.deepseek.com/user/balance',
    method: 'GET',
    bearerRef: 'DEEPSEEK_API_KEY',
    builder: 'deepseek-balance',
    // 出厂适配器注册的路由 id 是 `deepseek-official`（packages/llm/llm-deepseek/src/index.ts）；
    // `deepseek` 留给用户自己起名或在 llm-pi-ai 里声明的同名路由。阶段②的自动绑定做完后，
    // 这类手填别名整体由 detect 结果取代。
    providers: ['deepseek', 'deepseek-official'],
    keywords: [],
  },

  /**
   * 千问 Token Plan 实测窗口（本地账本，不打网络）。
   * 官方没有 Key 化额度接口（2026-09 实测：token-plan 网关候选路径全部 404、
   * 响应无额度头；文档写明 Credits 用量仅控制台可见），所以这张卡只报
   * 「经过本实例的真实消耗」，永远标注实测、不冒充官方余量。
   */
  'token-plan-window': {
    // 「实测」由 pill 标（与 `window:<provider>` 简写同一口径），标签本身不再重复。
    label: 'Token Plan',
    labelEn: 'Token Plan',
    kind: 'window',
    metric: 'count',
    providers: ['qwen-token-plan-cn'],
    windowDays: 7,
    keywords: [],
  },

  /**
   * 千问 Token Plan 官方余量（控制台网关，Cookie 会话鉴权）。
   * 端点与请求骨架按 CodexBar（MIT）对百炼订阅页的实测契约：
   * POST {url}?action=BroadScopeAspnGateway&product=sfm_bailian&api=<inner>&_v=undefined，
   * 表单体 product/action/region/language/params(JSON: Api+V+Data.cornerstoneParam)[+sec_token]，
   * sec_token 直接从 Cookie 里抽。
   * usage → 当前账期的已用比例与重置时刻（per1Month / 旧套餐 per1Week / per5Hour）；
   * quota-config → 各账期总额度（monthly / 旧 weekly / five_hour）。
   * 剩余 = 账期额度 × (1 − 已用比例)——即订阅页「剩余量 65.1% / 总额度 10,000」同源。
   * Cookie 是强凭据：只从本地解析，绝不进任何路由响应；登录态过期需重贴。
   */
  /**
   * 千问 Token Plan 官方余量（控制台数据网关，Cookie 会话鉴权）。
   * 千问AI平台（platform-home.qianwenai.com）的接口契约按其前端包逆向核对：
   * 1. GET {infoUrl}（登录 Cookie）→ data.secToken（CSRF 令牌，全自动，无需手抄）；
   * 2. POST {url}?action=BroadScopeAspnGateway&product=sfm_bailian&api=<inner>，
   *    表单体 product/action/sec_token/region/params(JSON: Api+V+Data.cornerstoneParam)；
   *    usage → 当前账期的已用比例与重置时刻（2026-09 起按月：per1Month*；旧套餐仍回 per1Week*）；
   *    subscription → specCode（lite/standard/pro/essential）；
   *    quota-config → 按档位的 monthly/weekly 与 five_hour 总额度，另有 addon_quota.extrabundle。
   * 剩余 = quota[specCode].monthly × (1 − per1MonthPercentage)——订阅页「剩余量/总额度」同源；
   * 没回月度读数时退回 weekly 口径。**附加包 extrabundle 不并进分母**：官方没说明它与档位额度
   * 的关系，折进去就是估算（宪法原则 I）。
   * Cookie 是强凭据：只从本地解析，绝不进任何路由响应；登录态过期需重贴 Cookie。
   */
  'token-plan-console': {
    label: 'Token Plan 余量',
    labelEn: 'Token Plan quota',
    kind: 'single',
    metric: 'credits',
    builder: 'token-plan-console',
    url: 'https://cs-data.qianwenai.com/data/api.json',
    infoUrl: 'https://platform-home.qianwenai.com/tool/user/info.json',
    cookieRef: 'BAILIAN_CONSOLE_COOKIE',
    secTokenRef: 'BAILIAN_CONSOLE_SECTOKEN',
    gatewayAction: 'BroadScopeAspnGateway',
    gatewayProduct: 'sfm_bailian',
    apiPrefix: 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2',
    regionId: 'cn-beijing',
    consoleSite: 'QIANWENAI',
    loginTicketCookie: DEFAULT_LOGIN_TICKET_COOKIE,   // 这台控制台的登录票据名（NotLogined 诊断用；名字不是秘密，值才是）
    dashboardOrigin: 'https://platform-home.qianwenai.com',
    dashboardURL: 'https://platform-home.qianwenai.com/analytics/token-plan/individual',
    /**
     * 008：官方「Usage Details」的完整 Api 路径。它不在 apiPrefix 下，所以网关要能整条覆盖 Api。
     * 约束（前端 bundle 核出 + 网关实测）：单次区间 ≤ 30 天、最早只能查「当前月往前 5 个月的 1 号」、
     * 时间字段是毫秒且 endTime 取止日**次日**零点。
     */
    telemetryApi: 'zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss',
    telemetryStepSeconds: 86400,
    telemetryChunkDays: 30,
    telemetryEarliestMonths: 5,
    providers: ['qwen-token-plan-cn'],
    keywords: [],
  },

  /**
   * Moonshot / Kimi 开放平台余额——**新增一家的标准模板**（预设 + regions + SOURCE_META + errorHints + probe 核对）。
   *
   * 官方 Key 化端点，Bearer 即用；信封是 `{code, status, data}`（`code:0` 本就是 httpEnvelopeOk 的通过值）。
   * 三处坑写死在这里：
   * 1. **国际（.ai，USD）与大陆（.cn，CNY）两区的 Key 不互通**，所以 host 与币种都跟着 region 走，
   *    不做自动探测（探测＝多打一次网络，还可能吃一次鉴权失败计数）；搞错区有 401 的定向提示。
   * 2. 端点**不回币种字段**，所以 `unit` 由 region 静态给出，而不是从响应里 pick。
   * 3. 没有窗口概念，只有余额；`cash_balance` 可为负（欠款），照原样显示，不取绝对值。
   */
  'moonshot-balance': {
    label: 'Moonshot 余额',
    labelEn: 'Moonshot balance',
    kind: 'single',
    metric: 'money',
    method: 'GET',
    bearerRef: 'MOONSHOT_API_KEY',
    extract: {
      remaining: ['data.available_balance', 'available_balance'],
    },
    extra: {
      // 复用已有键名，前端的中文标签本来就对得上：cash_balance 是充值进来的钱（toppedUp/充值），
      // voucher_balance 是代金券/赠款（granted/赠款）。别开新键，否则又要给客户端加特例。
      toppedUp: ['data.cash_balance', 'cash_balance'],
      granted: ['data.voucher_balance', 'voucher_balance'],
    },
    region: 'china-mainland',
    regionConfigKey: 'moonshotRegion',
    regions: {
      'china-mainland': { url: 'https://api.moonshot.cn/v1/users/me/balance', unit: 'CNY' },
      international: { url: 'https://api.moonshot.ai/v1/users/me/balance', unit: 'USD' },
    },
    errorHints: {
      401: '鉴权失败：Key 无效/已删，或者**用错了区**——api.moonshot.cn（大陆，CNY）与 api.moonshot.ai（国际，USD）的 Key 不互通。改 `moonshotRegion` 再试（卡片上会带当前区）。',
      403: '被拒：这个端点要的是开放平台 API Key（sk-…），不是 kimi.com/code 的订阅 Key——那是另一套产品。',
    },
    providers: ['moonshot', 'moonshot-cn', 'moonshot-ai'],
    keywords: [],
  },

  /**
   * OpenRouter 余额——**第一个需要派生表达式（derive）的家**：
   * 官方 `/api/v1/credits` 只给「累计充值」和「累计花费」，余额是**两者之差**。
   * 信封两版都见过（`data.*` 与裸顶层字段），所以每个引用名给一组候选路径，不猜哪个对。
   * 单位固定 USD（这是 credits 记账币种，端点也不回币种字段）。
   * `/api/v1/key`（key 级 usage_limit 与日/周/月花费）是**另一个端点的第二次请求**，
   * 要的是"一源多请求"的形状，还没做——见 ROADMAP T1.4b，不在这里硬塞一个假 meter。
   */
  'openrouter-credits': {
    label: 'OpenRouter 余额',
    labelEn: 'OpenRouter credits',
    kind: 'single',
    metric: 'money',
    url: 'https://openrouter.ai/api/v1/credits',
    method: 'GET',
    bearerRef: 'OPENROUTER_API_KEY',
    unit: 'USD',
    fields: {
      totalCredits: ['data.total_credits', 'total_credits'],
      totalUsage: ['data.total_usage', 'total_usage'],
    },
    derive: { total: 'totalCredits', used: 'totalUsage', remaining: 'totalCredits - totalUsage' },
    errorHints: {
      401: '鉴权失败：这个端点要 OpenRouter 的 API Key（`sk-or-v1-…`），不是上游模型厂商的 Key。',
      402: '账户欠费：余额已经见底，去 openrouter.ai/credits 充值后再看这张卡。',
    },
    providers: ['openrouter'],
    keywords: [],
  },

  'account-balance': {
    label: '阿里云余额',
    labelEn: 'Aliyun balance',
    kind: 'single',
    metric: 'money',
    action: 'QueryAccountBalance',
    version: '2017-12-14',
    params: {},
    extract: {
      remaining: ['Data.AvailableAmount', 'AvailableAmount'],
      unit: ['Data.Currency', 'Currency'],
    },
    extra: {
      cash: ['Data.AvailableCashAmount', 'AvailableCashAmount'],
      credit: ['Data.CreditAmount', 'CreditAmount'],
      quotaLimit: ['Data.QuotaLimit', 'QuotaLimit'],
    },
    keywords: [],
  },

  'fr-instances': {
    label: '资源包余量',
    labelEn: 'Resource packs',
    kind: 'list',
    metric: 'credits',
    action: 'DescribeFrInstances',
    version: '2023-09-30',
    params: { Status: 'valid', PageNum: 1, PageSize: 100 },
    paginate: { mode: 'page', request: 'PageNum', pageSize: 'PageSize', total: ['TotalCount', 'Data.TotalCount'] },
    list: ['Data', 'Data.Instances.Instance', 'Data.Instances'],
    item: {
      name: ['CommodityName', 'TemplateName', 'ProductName', 'Remark', 'CommodityCode', 'InstanceId'],
      id: ['InstanceId'],
      remaining: ['CurrCapacityViewValue', 'CurrCapacityBaseValue', 'PeriodCapacityViewValue', 'RemainingAmount', 'RemainAmount'],
      total: ['InitCapacityViewValue', 'InitCapacityBaseValue', 'TotalAmount'],
      used: ['UsedAmount'],
      unit: ['CurrCapacityViewUnit', 'InitCapacityViewUnit', 'RemainingAmountUnit', 'PeriodCapacityViewUnit', 'Unit'],
      expiresAt: ['EndTime', 'ExpiryTime', 'ExpireTime'],
      startsAt: ['StartTime', 'EffectiveTime', 'PurchaseTime'],
      status: ['StatusCode', 'Status', 'StatusName'],
      cycleType: ['CycleTypeCode', 'CycleTypeName'],
      capacityType: ['CapacityTypeCode', 'CapacitiyTypeName'],
      haystack: ['ProductCode', 'ProductName', 'CommodityCode', 'CommodityName', 'TemplateCode', 'TemplateName', 'InstanceId', 'Remark', 'Region'],
    },
    keywords: BAILIAN_KEYWORDS,
  },

  'resource-package': {
    label: '资源包余量(旧)',
    labelEn: 'Resource packs (legacy)',
    kind: 'list',
    metric: 'credits',
    action: 'QueryResourcePackageInstances',
    version: '2017-12-14',
    params: { PageNum: 1, PageSize: 300 },
    paginate: { mode: 'page', request: 'PageNum', pageSize: 'PageSize', total: ['Data.TotalCount', 'Total'] },
    list: ['Data.Instances.Instance', 'Data.Instances', 'Instances.Instance'],
    item: {
      name: ['Remark', 'CommodityCode', 'PackageType', 'InstanceId'],
      id: ['InstanceId'],
      remaining: ['RemainingAmount'],
      total: ['TotalAmount'],
      unit: ['RemainingAmountUnit', 'TotalAmountUnit'],
      expiresAt: ['ExpiryTime'],
      startsAt: ['EffectiveTime'],
      status: ['Status'],
      haystack: ['CommodityCode', 'PackageType', 'Remark', 'InstanceId', 'Region'],
    },
    keywords: BAILIAN_KEYWORDS,
  },
}

/** 预设的来源标签（前端「官方接口」标注）。 */
const SOURCE_META = {
  'deepseek-balance': { veracity: 'verified', sourceNote: 'DeepSeek 官方 API（Bearer Key）· /user/balance' },
  'token-plan-window': {
    veracity: 'local',
    sourceNote: '本实例实测：千问 Token Plan 官方无 Key 化额度接口（Credits 余量仅控制台可见），'
      + '此卡只报经过本 DSH 的真实消耗，7 天窗口从本实例第一次调用起算；控制台额度重置后请点「清本周期账本」重新起算。',
  },
  'token-plan-console': {
    veracity: 'verified',
    sourceNote: '千问AI平台控制台数据网关（Cookie 会话，sec_token 自动获取）· tokenplan/personal/api/v2 —— '
      + '与订阅页「剩余量/总额度」同源；Cookie 过期会报错，需重新复制。',
  },
  'moonshot-balance': {
    veracity: 'verified',
    sourceNote: 'Moonshot 官方 API（Bearer Key）· GET /v1/users/me/balance —— 余额/充值/赠款真值；'
      + 'api.moonshot.cn（大陆，CNY）与 api.moonshot.ai（国际，USD）两区的 Key 不互通，区由 moonshotRegion 决定。',
  },
  'openrouter-credits': {
    veracity: 'verified',
    sourceNote: 'OpenRouter 官方 API（Bearer Key）· GET /api/v1/credits —— 余额＝累计充值 − 累计花费（差值派生，不是上游直接给的字段）。',
  },
  'account-balance': { veracity: 'verified', sourceNote: '阿里云费用中心官方 API（AK/SK 签名）· QueryAccountBalance' },
  'fr-instances': { veracity: 'verified', sourceNote: '阿里云费用中心官方 API（AK/SK 签名）· DescribeFrInstances' },
  'resource-package': { veracity: 'verified', sourceNote: '阿里云费用中心官方 API（AK/SK 签名）· QueryResourcePackageInstances' },
}

/** 已核对过的错误码 → 可操作提示（未列出的码原样展示上游 Message）。 */
const ERROR_HINTS = {
  NotApplicable: '该接口不适用于当前调用方（例如子账号或国际站账号）；关掉这个数据源或换 endpoint。',
  NotAuthorized: '调用方无权限：给该 RAM 用户加 AliyunBSSReadOnlyAccess（费用中心只读）。',
  NoPermission: '调用方无权限：给该 RAM 用户加 AliyunBSSReadOnlyAccess。',
  AccountNoQueryPricePermission: '缺少折扣查询权限点 queryprice：让主账号在费用中心授权，或改用主账号 AK。',
  SubAccountNoQueryPricePermission: '子账号缺 bss:QueryPrice 权限：到 RAM 控制台补授权。',
  NoFundAccountPermission: '当前账号无权访问指定资金账户。',
  MissingParameter: '缺少必填参数（开 debug 看上游原始提示）。',
  InvalidParameter: '参数不合法（开 debug 看上游原始提示）。',
  InvalidOwner: '资源不属于当前调用方：AK 与实例不在同一账号下。',
  AuthSiteFail: '站点鉴权失败：中国站 AK 用了国际站 endpoint（或反之）。',
  InternalError: '上游内部错误，稍后重试。',
  UndefinedError: '上游未分类错误，稍后重试。',
  RequestTimeout: '上游超时，稍后重试。',
  InvalidAccessKeyId: 'AccessKeyId 不存在或已禁用。',
  SignatureDoesNotMatch: '签名不匹配：AccessKeySecret 多余空格，或 AK 已禁用。',
  IncompleteSignature: '签名参数不完整：请求被中间代理改写了。',
  Throttling: '触发上游流控：已自动串行退避，把 refreshMinutes 调大些。',
  InvalidApi: 'Action 与 Version 不匹配，或该接口对你的账号不可见。',
  NoCredentials: '未配置对应 API Key/凭据：往 ~/.dsh/.credentials.yaml 的 refs 加一行，或设同名环境变量。',
  BailianNotAuthorised: '控制台网关要求登录会话：打开千问AI平台订阅页（platform-home.qianwenai.com/analytics/token-plan/individual）→ F12 Network → 筛选 cs-data → 复制 data/api.json 那条请求的整行 Cookie → 存为 BAILIAN_CONSOLE_COOKIE。',
  // sec_token 与 Cookie 是两件事，提示不许混成一个：0.4.13 之前这条只断言"多半抄的是另一台主机"，
  // 而 2026-11-03 实机那份 Cookie 里 login_qianwenai_ticket 明明在场——真正缺的是 sec_token，
  // 照着提示重抄 Cookie 永远修不好。三类成因现在分开报（MissingSecToken / 缺票据 / 会话过期）。
  MissingSecToken: '网关要的 sec_token 没取到，这不是 Cookie 抄错：它来自控制台 user/info.json（用同一份登录 Cookie 打）。'
    + '先点面板「更新于」重试一次（info.json 偶发超时）；仍不行就打开订阅页 → F12 Network → 筛 user/info.json → 复制响应里的 secToken 值，'
    + '存成一行 BAILIAN_CONSOLE_SECTOKEN（页面刷新后它会变，过期就重抄）。',
  'BailianGateway.Login.NotLogined': '配额域名没认这份登录会话。哪一步错了看错误正文里那句诊断（它列出收到的 Cookie 名与插件打的主机）：'
    + '缺登录票据＝抄的是另一台主机或不带登录态的请求；票据在而 sec_token 没附上＝改报 MissingSecToken，不是 Cookie 的错；'
    + '票据与 sec_token 都在仍被拒＝会话已过期（Cookie 一般能用几周），重新登录订阅页后当场再抄一条。'
    + '要抄的是 **POST https://cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway** 那条请求的整行 Cookie 请求头（`Cookie:`）→ 存成 BAILIAN_CONSOLE_COOKIE：'
    + '打开千问AI平台订阅页 → 按 F5 → F12 Network（勾「保留日志」）→ 筛选框输入 cs-data 或 data/api.json。',
  PostonlyOrTokenError: '网关的 CSRF 校验没过：这个平台的 sec_token 不在 Cookie 里，要把请求「载荷」表单数据里的 sec_token 值单独抄下来，存成 BAILIAN_CONSOLE_SECTOKEN（页面刷新后它会变，过期就重抄）。',
  ConsoleApiError: '控制台网关业务失败：多半是 Cookie 过期或换号了，重新复制登录会话的 Cookie。',
  BadResponse: '上游返回非预期格式：登录态失效（控制台跳登录页）或接口改版，重新复制 Cookie 或开 debug 看原始响应。',
  BadUrl: '出站地址不合法：内置源报这条说明预设写错了；自定义源要写完整的 https:// 绝对地址（只有回环允许 http）。',
  HostNotDeclared: '该主机不在插件的出站声明里（package.json 的 dshhub.permissions.network 与 lib/index.js 的 DECLARED_HOSTS）：自定义源指向别处请显式打开 allowUndeclaredHosts；内置源报这条说明代码与声明不一致，两处要一起改。',
}

/** 全局出站节流。 */
let lastCallAt = 0
let lastProvider = 'unknown'

/* ==================================================== 配置合并 */

function prune(value) {
  if (!isPlainObject(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined && item !== null) out[key] = item
  return out
}

let fileConfigCache = { path: null, mtimeMs: -1, value: {} }

function readFileConfig(path) {
  const file = expandPath(path)
  if (file === '' || !existsSync(file)) return { path: file, exists: false, value: {} }
  let mtimeMs = -1
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch { /* 拿不到 mtime 就每次重读 */ }
  if (fileConfigCache.path === file && fileConfigCache.mtimeMs === mtimeMs) return { path: file, exists: true, value: fileConfigCache.value }
  const text = readText(file)
  if (text === undefined) return { path: file, exists: true, value: {}, error: '读取失败（权限或被占用）' }
  let value
  try {
    const parsed = JSON.parse(text)
    value = isPlainObject(parsed) ? parsed : {}
  } catch (error) {
    return { path: file, exists: true, value: {}, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  fileConfigCache = { path: file, mtimeMs, value }
  return { path: file, exists: true, value }
}

function effectiveConfig(rowConfig, ctx) {
  const row = isPlainObject(rowConfig) ? prune(rowConfig) : {}
  const file = readFileConfig(row.configPath ?? DEFAULTS.configPath)
  const fileValues = prune(file.value)
  const merged = { ...DEFAULTS, ...row, ...fileValues }
  const minutes = Number(merged.refreshMinutes)
  merged.cacheMs = Math.max(15_000, (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULTS.refreshMinutes) * 60_000)
  merged.minIntervalMs = Math.max(0, Number(merged.minIntervalMs ?? DEFAULTS.minIntervalMs))
  merged.timeoutMs = Math.max(1000, Number(merged.timeoutMs ?? DEFAULTS.timeoutMs))
  merged.endpoint = String(merged.endpoint || DEFAULTS.endpoint).replace(/^https?:\/\//, '').replace(/\/+$/, '')
  merged.debug = merged.debug === true
  merged.showInstanceWindow = merged.showInstanceWindow !== false
  merged.panelScope = merged.panelScope === 'all' ? 'all' : 'current'
  merged.autoDetect = !(merged.autoDetect === false || merged.autoDetect === 'off')
  merged.usageStats = merged.usageStats !== false
  // 1..365：保留天数 = 天数选择上界；非法值按四舍五入后夹紧，不静默变成 Infinity。
  merged.usageBackfillDays = clampBackfillDays(merged.usageBackfillDays)
  merged.officialUsage = merged.officialUsage !== false
  // 0 = 不缓存（调试用）；非法/负数回落 5 分钟，不静默变成 Infinity。
  merged.officialUsageMinutes = Number.isFinite(Number(merged.officialUsageMinutes))
    ? Math.max(0, Number(merged.officialUsageMinutes))
    : DEFAULTS.officialUsageMinutes
  // 用户没写过 `sources` 时，autoDetect 开着就不用硬编码兜底清单——
  // 那两条默认源正是"配置与实际拓扑各写各的"的来源（检测会按在用路由自己补）。
  const userSetSources = row.sources !== undefined || fileValues.sources !== undefined
  const baseSources = merged.autoDetect && !userSetSources ? [] : merged.sources
  merged.sources = normalizeSources(baseSources, ctx, merged)
  merged.sourcesUserSet = userSetSources
  merged.fileConfig = { path: file.path, exists: file.exists, error: file.error ?? null }
  return merged
}

/**
 * sources → 可执行描述子：预设名字符串、`{ id, ...覆盖 }`，或完全自定义
 * （rpc：action/version/extract；http：url/headers/extract/item）。
 */
function normalizeSources(raw, ctx, config = {}) {
  const entries = Array.isArray(raw) ? raw : []
  const out = []
  const disabled = []
  for (const entry of entries) {
    const override = isPlainObject(entry) ? entry : {}
    const id = typeof entry === 'string' ? entry : String(override.id ?? override.action ?? override.url ?? 'source')
    const preset = PRESETS[id]
    // `window:<provider>` 是内置简写：给任意供应商挂一条本实例实测窗口，不用手抄整个对象形状。
    // 官方没有额度端点的家（普通 Key 的 OpenAI/Gemini、MiniMax…）全靠这条兜住，
    // 阶段②给"在用但没匹配到源"的路由自动挂实测源时，走的也是这条形状。
    const shorthandProvider = preset === undefined && typeof id === 'string' && id.startsWith('window:')
      ? id.slice('window:'.length).trim() : undefined
    if (preset === undefined && shorthandProvider === undefined && override.action === undefined && override.url === undefined && override.kind !== 'window') {
      ctx?.logger?.warn?.(new Error(`token-plan-quota: 未知数据源 "${id}"，已忽略（可用：${Object.keys(PRESETS).join(', ')}，或写成 window:<provider> 挂实测窗口）`))
      continue
    }
    const source = { kind: 'single', ...(preset ?? {}), ...override, id }
    if (shorthandProvider !== undefined && shorthandProvider !== '') {
      source.kind = 'window'
      if (!Array.isArray(override.providers)) source.providers = [shorthandProvider]
      // 标签只写供应商名：「实测」由徽标/卡头那颗 pill 负责（`client.js:639`、`:770`）。
      // 之前这里是 `${shorthandProvider} 实测`，于是徽标上连着出现两次"实测"
      // ——`minimax-cn 实测 1.3万 tok … [实测]`，白占 ~40px，正是把输入行挤折行的主因。
      if (override.label === undefined) source.label = shorthandProvider
      if (override.labelEn === undefined) source.labelEn = shorthandProvider
      source.sourceNote = source.sourceNote ?? `本实例实测：${shorthandProvider} 未接入可核实的官方额度源，`
        + '此卡只报经过本 DSH 实例的真实消耗（token/次数），不折算、不估算、不代表官方余量。'
    }
    if (typeof source.label !== 'string' || source.label.trim() === '') source.label = source.id
    if (source.enabled === false) {
      // 「这张卡我不看」是最常见的配置诉求。手写条目里的 `enabled: false` 必须连自动检测一起压住，
      // 否则用户明写了不要这家，检测又把它补回来——"你写过的永远赢"就成了空话。
      // 注意关的是**这条源**，不是这个供应商：同路由的实测兜底窗口不受牵连。
      disabled.push(source.id)
      continue
    }
    source.params = { ...(preset?.params ?? {}), ...(isPlainObject(override.params) ? override.params : {}) }
    source.item = { ...(preset?.item ?? {}), ...(isPlainObject(override.item) ? override.item : {}) }
    source.extract = { ...(preset?.extract ?? {}), ...(isPlainObject(override.extract) ? override.extract : {}) }
    source.fields = { ...(preset?.fields ?? {}), ...(isPlainObject(override.fields) ? override.fields : {}) }
    source.derive = { ...(preset?.derive ?? {}), ...(isPlainObject(override.derive) ? override.derive : {}) }
    source.extra = { ...(preset?.extra ?? {}), ...(isPlainObject(override.extra) ? override.extra : {}) }
    source.list = Array.isArray(source.list) && source.list.length > 0 ? source.list : preset?.list ?? []
    source.keywords = Array.isArray(source.keywords) ? source.keywords.map(keyword => String(keyword).toLowerCase()) : []
    source.providers = Array.isArray(source.providers) ? source.providers.map(String) : []
    // 区域（一家供应商多个 host/币种时用，如 Moonshot 的 .cn/.ai）：
    // 条目显式 region > 配置文件的全局键（regionConfigKey）> 预设默认 > regions 的第一个键。
    // 区域字段不覆盖用户自己写过的键，也不自动探测——探测要多打一次网络还可能算一次鉴权失败。
    if (isPlainObject(source.regions) && Object.keys(source.regions).length > 0) {
      const known = Object.keys(source.regions)
      const fromConfig = typeof source.regionConfigKey === 'string' ? config?.[source.regionConfigKey] : undefined
      const wanted = String(override.region ?? fromConfig ?? preset?.region ?? known[0])
      const chosen = known.includes(wanted) ? wanted : known[0]
      if (chosen !== wanted) {
        ctx?.logger?.warn?.(new Error(`token-plan-quota: 数据源 "${id}" 的区 "${wanted}" 不存在，已退回 "${chosen}"（可选：${known.join(', ')}）`))
      }
      for (const [key, value] of Object.entries(source.regions[chosen])) {
        if (key in override) continue
        source[key] = value
      }
      source.region = chosen
    }
    const windowDays = Number(source.windowDays)
    if (Number.isFinite(windowDays) && windowDays >= 1) source.windowDays = windowDays
    source.type = source.kind === 'window' ? 'local' : source.url !== undefined ? 'http' : 'rpc'
    const meta = SOURCE_META[id]
    if (meta !== undefined) {
      source.veracity = meta.veracity
      source.sourceNote = meta.sourceNote
    }
    out.push(source)
  }
  // 同名源会共用 TTL 缓存条目并互相覆盖，面板里也会叠成两张卡——早说一句比事后排查便宜。
  const seenIds = new Set()
  for (const source of out) {
    if (seenIds.has(source.id)) {
      ctx?.logger?.warn?.(new Error(`token-plan-quota: 数据源 id "${source.id}" 出现多次，请给第二个起别名`
        + `（例如 {"id":"${source.id}-intl", "region":"international"}），否则两张卡会共享缓存并叠在一起`))
    }
    seenIds.add(source.id)
  }
  // 关掉的源名要交给检测看得到（同一个 config 对象一路带到 applyAutoDetect）。
  if (isPlainObject(config) && disabled.length > 0) {
    const prior = Array.isArray(config.disabledSources) ? config.disabledSources : []
    config.disabledSources = [...new Set([...prior, ...disabled])]
  }
  return out
}

/* ==================================================== 零配置自动检测 */

/** 设置分节里挖一条路由的 profile（只要 baseURL / apiKeyEnv 两个字段）。 */
function readRouteProfile(settings, entry) {
  if (settings === undefined || typeof settings.get !== 'function' || typeof entry?.settingsNs !== 'string') return undefined
  let current
  try {
    current = settings.get(entry.settingsNs)
  } catch {
    return undefined
  }
  for (const segment of Array.isArray(entry.settingsPath) ? entry.settingsPath : []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  // settingsPath 指到 `providers` 根时（各家写法不一），再按路由名挖一层。
  if (isPlainObject(current) && current.baseURL === undefined && current.apiKeyEnv === undefined
    && isPlainObject(current[entry.provider])) {
    current = current[entry.provider]
  }
  if (!isPlainObject(current)) return undefined
  return {
    baseURL: typeof current.baseURL === 'string' ? current.baseURL : undefined,
    apiKeyEnv: typeof current.apiKeyEnv === 'string' ? current.apiKeyEnv : undefined,
  }
}

/**
 * 一个源在该路由上该试哪些凭据引用。顺序很重要：
 * **profile 点名的 `apiKeyEnv` 优先**（llm-pi-ai 按路由命名，如 `QWEN_TOKEN_PLAN_CN_API_KEY`），
 * 其次才是预设里的通用名（`MOONSHOT_API_KEY` 这种）。Cookie 型源不认路由 Key——
 * 拿套餐 Key 当 Cookie 去查余量，只会得到一张误导性的错误卡。
 */
function credentialRefsFor(preset, profile) {
  if (!isPlainObject(preset)) return []
  if (typeof preset.cookieRef === 'string' && preset.cookieRef !== '') return [preset.cookieRef]
  const refs = []
  if (typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv !== '') refs.push(profile.apiKeyEnv)
  if (typeof preset.bearerRef === 'string' && preset.bearerRef !== '' && !refs.includes(preset.bearerRef)) refs.push(preset.bearerRef)
  return refs
}

/**
 * 已提醒过的"绑定落空"组合。每次快照都会重跑检测，不去重就是刷屏。
 * 键里带上在用路由签名，所以路由真变了还能再提醒一次；只留上限，不无限长。
 */
const unboundWarned = new Set()

/**
 * 手写源写了 `providers`，却没有一个对得上在用路由 → 在 `panelScope:"current"`（默认）下
 * 这张卡查得到、但永远不露面。这正是本项目历史上"配置与实际拓扑各写各的"那类坑，
 * 所以只在**明显写错**时提醒；不写 `providers` 的源（阿里云那几条没有供应商归属）保持安静。
 */
function warnUnboundSources(config, routes, ctx) {
  const live = new Set(routes.map(route => normalizeToken(route.id)).filter(Boolean))
  if (live.size === 0) return
  for (const source of config.sources) {
    const bound = (Array.isArray(source.providers) ? source.providers : []).map(normalizeToken).filter(Boolean)
    if (bound.length === 0 || bound.some(name => live.has(name))) continue
    const key = `${source.id}|${bound.join(',')}|${[...live].sort().join(',')}`
    if (unboundWarned.has(key)) continue
    if (unboundWarned.size > 200) unboundWarned.clear()
    unboundWarned.add(key)
    ctx?.logger?.warn?.(new Error(`token-plan-quota: 数据源 "${source.id}" 的 providers [${bound.join(', ')}] 里没有任何一条是在用路由`
      + `（在用：${[...live].join(', ')}）；panelScope 为 current 时这张卡查得到也不会出现在面板里。`
      + `把 providers 改成路由 id，或把 panelScope 设为 "all"`))
  }
}

/**
 * 按宿主在用的供应商路由补齐数据源（零配置的主路径）。
 *
 * 异步是因为要真去解析凭据；识别本身在 `lib/detect.js` 的纯函数里做。
 * 三条不变量：
 * 1. **用户手写过的源永远赢**（它覆盖的路由，检测一概不再追加）；
 * 2. **认不准就不开源**，凭据解析不到也不开（不挂 NoCredentials 错误卡占地方）；
 * 3. 老宿主没有 `llm` / `settings` 服务时**静默退回**今天的配置行为，不抛。
 *
 * @returns 诊断块（进快照 `detection`，回答"为什么这家没显示"）。
 */
async function applyAutoDetect(config, ctx) {
  const empty = { enabled: false, reason: null, routes: [], added: [], skipped: [], uncovered: [] }
  if (config.autoDetect === false) return { ...empty, reason: 'autoDetect=false（按配置里的 sources 走）' }
  const llm = ctx?.get?.('llm')
  if (typeof llm?.listProviders !== 'function') {
    return { ...empty, reason: '宿主没有 llm 服务（老外壳），退回配置里的 sources' }
  }
  const settings = ctx?.get?.('settings')
  let routes = []
  try {
    routes = (llm.listProviders() ?? []).filter(route => typeof route?.id === 'string' && route.id !== '')
  } catch (error) {
    return { ...empty, reason: `listProviders 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const profiles = {}
  try {
    for (const entry of (typeof llm.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []) ?? []) {
      const profile = readRouteProfile(settings, entry)
      if (profile !== undefined) profiles[entry.provider] = profile
    }
  } catch { /* 拿不到 profile 就少一条 baseURL 线索，仍可靠路由 id / Key 前缀，或退回实测窗口 */ }
  const covered = config.sources.flatMap(source => (Array.isArray(source.providers) ? source.providers : []))
  warnUnboundSources(config, routes, ctx)
  const disabledPresets = Array.isArray(config.disabledSources) ? config.disabledSources : []
  const plan = detectSources({ routes, profiles, coveredRoutes: covered, disabledPresets })
  const resolved = new Map()
  const resolveRef = async ref => {
    if (ref === undefined || ref === '') return undefined
    if (resolved.has(ref)) return await resolved.get(ref)
    const job = resolveSecret(ref, config, ctx)
    resolved.set(ref, job)
    return await job
  }
  const planned = []
  const skipped = []
  for (const candidate of plan.sources) {
    const preset = candidate.preset === undefined ? undefined : PRESETS[candidate.preset]
    // 实测窗口不需要凭据（只统计经过本实例的调用）；`kind:'window'` 的预设同理——
    // 早期版本给它算 refs，算出空列表就被当成"没凭据"跳过了。
    if (candidate.window !== undefined || preset?.kind === 'window') {
      planned.push({ ...candidate, ref: null })
      continue
    }
    const usable = []
    let ref
    for (const route of candidate.providers) {
      const refs = credentialRefsFor(preset, profiles[route])
      let hit
      for (const name of refs) {
        const secret = await resolveRef(name)
        if (secret !== undefined) {
          hit = name
          break
        }
      }
      if (hit !== undefined) {
        usable.push(route)
        if (ref === undefined) ref = hit
      } else {
        skipped.push({ preset: candidate.id, route, reason: 'no-credential', by: candidate.detected.by, tried: refs })
      }
    }
    if (usable.length === 0) continue
    planned.push({ ...candidate, providers: usable, ref: ref ?? null })
  }
  // 兜底源**不在这里砍**。规划阶段还不知道官方卡有没有数：Cookie 过期时官方源照样"开着"，
  // 但返回的是错误卡——此时把实测窗关掉就等于让徽标变空白（2026-09-06 实机踩到）。
  // 只把 `fallback` 标记随卡下发，"有真值就收起兜底卡"交给看得见数据的那层（前端与工具摘要）。
  // **同一个源名只允许一张卡**（这条是规划期就能定的）：重复开出同名源会有两个后果——
  // 面板里并排两张几乎一样的卡（React key 也撞），而且它们共用 TTL 缓存条目互相覆盖，
  // 表现就是"两个余量窗口、数字还不一样"。
  const configured = new Set(config.sources.map(source => source.id))
  const added = []
  for (const candidate of planned) {
    if (configured.has(candidate.id)) {
      // 用户已经开了同名源：不改他写的 providers（那是他的意图），只让自己让路。
      skipped.push({ preset: candidate.id, route: candidate.providers.join(','), reason: 'id-taken-by-configured', by: candidate.detected.by, tried: [] })
      continue
    }
    const override = { id: candidate.id, providers: candidate.providers }
    if (candidate.region !== undefined) override.region = candidate.region
    if (candidate.window !== undefined) {
      override.kind = 'window'
    }
    // 路由点名的凭据引用与预设不同（例如 MOONSHOT_CN_API_KEY）时沿用它，不要求用户再配一遍。
    // **只对 Bearer 型源生效**：Cookie 型源（token-plan-console）解析到的引用名就是 Cookie 本身，
    // 写成 bearerRef 会让查询先撞上 Bearer 门，报出"未配置凭据 BAILIAN_CONSOLE_COOKIE"——
    // Cookie 明明在，用户却被告知去配 Key（2026-09-06 实机回归）。
    const preset = candidate.preset === undefined ? undefined : PRESETS[candidate.preset]
    const bearerSource = preset !== undefined && typeof preset.bearerRef === 'string' && preset.bearerRef !== ''
      && typeof preset.cookieRef !== 'string'
    if (bearerSource && candidate.ref !== null && candidate.ref !== preset.bearerRef) override.bearerRef = candidate.ref
    const [source] = normalizeSources([override], ctx, config)
    if (source === undefined) continue
    source.detected = { ...candidate.detected, credentialRef: candidate.ref, fallback: candidate.fallback === true }
    configured.add(source.id)
    added.push({ id: source.id, providers: source.providers, by: candidate.detected.by, region: source.region ?? null })
    config.sources.push(source)
  }
  return {
    enabled: true,
    reason: null,
    routes: routes.map(route => `${route.id}${profiles[route.id]?.baseURL === undefined ? '' : ` → ${hostOf(profiles[route.id].baseURL)}`}`),
    added,
    // 规则层的跳过（如 `disabled-by-config`）也要透出来，否则"这张卡为什么没有"只剩本地那几种原因。
    // 同 preset+route 的 `no-credential` 本地记录带着试过的引用名，比规则层的更可操作，留本地的。
    skipped: [
      ...(Array.isArray(plan.skipped) ? plan.skipped.filter(row => !skipped.some(local => local.preset === row.preset && local.route === row.route)) : []),
      ...skipped,
    ],
    uncovered: plan.uncovered,
  }
}

/* ==================================================== 凭据解析 */

async function resolveSecret(refName, config, ctx) {
  const literal = literalKeyFor(refName)
  if (literal !== undefined && typeof config[literal] === 'string' && config[literal].trim() !== '') {
    return { value: config[literal].trim(), source: 'config' }
  }
  const ref = typeof refName === 'string' ? refName.trim() : ''
  if (ref === '') return undefined

  const credentials = ctx?.get?.('credentials')
  if (typeof credentials?.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (typeof hit?.value === 'string' && hit.value !== '') return { value: hit.value, source: `credentials:${hit.source ?? ref}` }
    } catch { /* 服务缺席时继续兜底 */ }
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { value: fromEnv.trim(), source: `env:${ref}` }
  const fromFile = readCredentialsFile(ref)
  if (fromFile !== undefined) return { value: fromFile, source: '~/.dsh/.credentials.yaml' }
  const fromDotEnv = readDotEnv(ref)
  if (fromDotEnv !== undefined) return { value: fromDotEnv, source: '~/.dsh/.env' }
  return undefined
}

function literalKeyFor(refName) {
  if (typeof refName !== 'string' || !refName.endsWith('Ref')) return undefined
  const base = refName.slice(0, -3)
  return base === 'accessKeyId' || base === 'accessKeySecret' || base === 'securityToken' ? base : undefined
}

function readCredentialsFile(ref) {
  const text = readText(join(dshHome(), '.credentials.yaml'))
  if (text === undefined) return undefined
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inRefs = /^refs:\s*$/.test(line)
      continue
    }
    if (!inRefs) continue
    const match = /^\s{2,}(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*:\s*(.+?)\s*$/.exec(line)
    if (match !== null && match[2] === ref) return match[3].replace(/^["']|["']$/g, '')
  }
  return undefined
}

function readDotEnv(ref) {
  const text = readText(join(dshHome(), '.env'))
  if (text === undefined) return undefined
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match !== null && match[1] === ref) return match[2].trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

function maskSecret(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  if (text.length <= 8) return '****'
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

/**
 * 按值兜底脱敏：用于**按键名过滤不到**的原文片段——上游错误体可能把请求原样回显，
 * 而请求里带着 Cookie / sec_token / Bearer，键名是上游定的，猜不全。
 * 候选值来自本进程实际发出去的那几个，不是模式猜测；短于 8 位的值不参与（避免误伤普通文本）。
 */
function redactSecrets(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    out = out.split(secret).join('****')
  }
  return out
}

/* ==================================================== 签名与出站请求 */

/**
 * 阿里云 RPC percentEncode：encodeURIComponent 后把 `! ' ( ) *` 补转义，`~` 不转义。
 * 与官方 @alicloud/pop-core 的 encode() 逐字符一致（测试交叉验证）。
 */
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

export function signRpcParams(params, accessKeySecret, method = 'POST') {
  const canonical = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64')
  return { canonical, signature }
}

function flattenParams(params, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (Array.isArray(value)) {
      const asRecord = {}
      value.forEach((item, index) => {
        asRecord[String(index + 1)] = item
      })
      flattenParams(asRecord, name, out)
      continue
    }
    if (isPlainObject(value)) {
      flattenParams(value, name, out)
      continue
    }
    out[name] = value
  }
  return out
}

function utcTimestamp(date = new Date()) {
  return `${date.toISOString().slice(0, 19)}Z`
}

/**
 * 出站白名单断言：在**请求发出之前**核主机在声明集合里，否则拒发。
 *
 * 这是"声明集合约束真实出站"的落点。放行的两条路只有：主机在 `DECLARED_HOSTS` 里，或用户
 * 显式打开 `allowUndeclaredHosts`（自定义源的场景；打开后快照会留 notice）。
 * 非绝对 URL 一律 BadUrl——不猜、不补默认主机。
 */
function assertDeclaredHost(rawUrl, config, sourceId) {
  const text = String(rawUrl ?? '').trim()
  // 用 `URL` 解析，不自己切字符串：`origin` 已归一化（主机小写、剥掉 userinfo 与默认端口），
  // 所以 `https://api.deepseek.com:443/`、`https://API.deepSeek.com/` 都对我们声明里的那一条；
  // 拿未归一的子串去比会把它们误判成"未声明的另一台主机"（CodeRabbit 在 PR #3 上指出）。
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new SourceError('BadUrl', `出站地址不是绝对 URL：${text.slice(0, 120)}`, sourceId)
  }
  const origin = parsed.origin
  // 回环是本仓库**测试与本地探针**的明文例外（宪法 VI：测试只允许回环 HTTP）。它不是"出站主机"，
  // 声明集合也不可能覆盖它——所以先放行，再要求其余一律 https。
  if (/^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i.test(parsed.hostname)) return origin
  if (parsed.protocol !== 'https:') throw new SourceError('BadUrl', `出站地址必须是 https（只有回环允许 http）：${text.slice(0, 120)}`, sourceId)
  if (DECLARED_HOSTS.includes(origin)) return origin
  if (config?.allowUndeclaredHosts === true) return origin
  throw new SourceError('HostNotDeclared',
    `主机 ${origin} 不在插件的出站声明里（dshhub.permissions.network）。自定义源指向别处时请显式打开 allowUndeclaredHosts；`
    + '若是内置源报这条，说明代码与声明不一致，请一起改 lib/index.js 的 DECLARED_HOSTS 与 package.json', sourceId)
}

async function throttle(minIntervalMs) {
  const wait = lastCallAt + minIntervalMs - Date.now()
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastCallAt = Date.now()
}

export class SourceError extends Error {
  /**
   * @param secrets 该请求**实际带出去**的凭据值（Cookie / Bearer / 请求体 / AK-SK）。给了就把
   *   `message` 与 `raw` 一起按值脱敏——这是 CWE-209 的落点：上游错误体常把请求原样回显
   *   （"Invalid Authentication: Bearer sk-…"），而 message 与 raw 都会随卡片与 `/probe` 出网。
   *   **不传就不脱敏**：边界不是魔法，调用点必须把手头的凭据传进来（每条出站路径都传了）。
   */
  constructor(code, message, source, raw = null, secrets = []) {
    super(redactSecrets(`${source}: ${code} ${message}`, secrets))
    this.name = 'SourceError'
    this.code = code
    this.source = source
    this.raw = typeof raw === 'string' ? redactSecrets(raw, secrets) : (raw ?? null)
  }
}

async function callRpc(config, credentials, source) {
  if (credentials?.configured !== true) {
    throw new SourceError('NoCredentials', `未配置 AccessKey（${config.accessKeyIdRef} / ${config.accessKeySecretRef}）`, source.id)
  }
  const params = {
    Action: source.action,
    Version: source.version,
    Format: 'JSON',
    AccessKeyId: credentials.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: randomUUID(),
    Timestamp: utcTimestamp(),
    ...flattenParams(source.params ?? {}),
  }
  if (config.regionId) params.RegionId = config.regionId
  if (credentials.securityToken !== undefined) params.SecurityToken = credentials.securityToken

  const { signature } = signRpcParams(params, credentials.accessKeySecret)
  const form = { ...params, Signature: signature }
  const body = new URLSearchParams(Object.keys(form).map(key => [key, String(form[key])])).toString()
  await throttle(config.minIntervalMs)
  // 阿里云 BSS 的地址是 endpoint 拼出来的（不是预设里的字面 URL）：在这里也过一遍声明断言。
  const endpointUrl = `https://${config.endpoint}/`
  assertDeclaredHost(endpointUrl, config, source.id)
  // 单条凭据也要传：上游不一定把请求体原样回显，可能只回显一个 AccessKeyId
  // （CodeRabbit PR #3 指出"body 不等于凭据本身"）。
  const text = await postForm(endpointUrl, body, config.timeoutMs,
    [credentials?.accessKeyId, credentials?.accessKeySecret, credentials?.securityToken])
  return parseEnvelope(text, source.id, rpcEnvelopeOk,
    [credentials?.accessKeyId, credentials?.accessKeySecret, credentials?.securityToken].filter(value => typeof value === 'string' && value !== ''))
}

/** `type:'http'` 源：直连给定 url（Bearer / Cookie / 自有 header）。 */
async function callHttp(config, source) {
  const url = String(source.url)
  if (!/^https?:\/\//.test(url)) throw new SourceError('BadUrl', '自定义 http 源的 url 必须以 http(s):// 开头', source.id)
  // 声明集合要真的约束出站：未声明主机在这里就被拒（除非用户显式打开 allowUndeclaredHosts）。
  assertDeclaredHost(url, config, source.id)
  const headers = { accept: 'application/json', ...(isPlainObject(source.headers) ? source.headers : {}) }
  if (typeof source.cookieRef === 'string' && source.cookieRef !== '') {
    const cookie = process.env[source.cookieRef] ?? readDotEnv(source.cookieRef) ?? readCredentialsFile(source.cookieRef)
    if (typeof cookie === 'string' && cookie.trim() !== '') headers.cookie = cookie.trim()
  }
  if (typeof source._bearer === 'string' && source._bearer !== '' && headers.authorization === undefined) {
    headers.authorization = `Bearer ${source._bearer}`
  }
  const method = String(source.method ?? 'GET').toUpperCase()
  const init = { method, headers, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) }
  if (method !== 'GET' && method !== 'HEAD') {
    if (isPlainObject(source.jsonBody)) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(source.jsonBody)
    } else if (isPlainObject(source.formBody)) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded'
      init.body = new URLSearchParams(Object.keys(source.formBody).map(key => [key, String(source.formBody[key])])).toString()
    }
  }
  await throttle(config.minIntervalMs)
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new SourceError('Network', error instanceof Error ? error.message : String(error), source.id)
  }
  const text = await response.text()
  if (!response.ok) {
    // 上游 4xx 体里往往已经写了人话（Moonshot：{"error":{"message":"Invalid Authentication",
    // "type":"invalid_authentication_error"}}），只报 "HTTP 401" 等于把线索丢了。
    // 但这句话是**上游可控文本**，可能把请求原样回显（CWE-209）——连同 raw 一起按值脱敏。
    const secretCandidates = [headers.authorization, headers.cookie, init.body, source._bearer]
    const detail = pickString(safeJson(text), ['error.message', 'message', 'msg', 'Message']) ?? ''
    throw new SourceError(String(response.status), `HTTP ${response.status}${detail === '' ? '' : ` · ${detail}`}`, source.id, text.slice(0, 600), secretCandidates)
  }
  return parseEnvelope(text, source.id, httpEnvelopeOk, [headers.authorization, headers.cookie, init.body, source._bearer])
}

/**
 * Cookie 串里的**名字**清单（绝不含值）。
 *
 * 网关回 NotLogined 时，光说"没登录"帮不到人：真正要回答的是"你抄的这份是不是**同一台主机上带登录票据**那条请求"。
 * 名字不是秘密（本仓库的凭据纪律禁的是**值**），所以这里把收到的名字列出来当诊断——2026-10-06 实机就是靠它
 * 认出用户抄的是另一台主机的反爬 Cookie 集（`cna/cnaui/…` + `login_aliyunid_csrf`），没有千问控制台的登录票据。
 *
 * @param cookie - 待诊断的 Cookie 头原文。
 * @param limit - 最多列出几个名字。
 * @returns 名字数组与一句话描述。
 */
function cookieNames(cookie, limit = 10) {
  const names = String(cookie ?? '')
    .split(';')
    .map(part => part.split('=')[0].trim())
    .filter(name => name !== '')
  const shown = names.slice(0, limit).join(', ')
  return { names, text: names.length > limit ? `${shown} 等 ${names.length} 个` : `${shown}（${names.length} 个）` }
}

/** 从 Cookie 串里取一个 cookie 值（sec_token、cna 等）。 */
function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(cookie ?? ''))
  return match === null ? undefined : match[1].trim()
}

/**
 * JSON 响应的**键名骨架**——值一个都不出现。
 *
 * `MissingSecToken` 之后必然要问的是"那台 info 主机到底回了哪些字段"：光说 `no-token`，
 * 分不清是 token 改了名、挪了层，还是这个会话根本没发 token。沿用 `cookieNames` 的同一条
 * 纪律——**名字不是秘密，值才是**（本仓库的凭据纪律禁的是值）——并把面收窄：只下探一层、
 * 每层最多 `limit` 个名字、非标量只报类型。
 *
 * @param payload - 已解析的响应体。
 * @param limit - 每层最多列出几个键名。
 * @returns 形如 `code:string, data{userId, secToken}` 的一行描述。
 */
function jsonKeyShape(payload, limit = 12) {
  if (!isPlainObject(payload)) return Array.isArray(payload) ? `array(${payload.length})` : typeof payload
  const all = Object.keys(payload)
  const shown = all.slice(0, limit)
  const parts = shown.map(key => {
    const value = payload[key]
    if (isPlainObject(value)) {
      const inner = Object.keys(value).slice(0, limit)
      const more = Object.keys(value).length > inner.length ? ` 等 ${Object.keys(value).length} 个` : ''
      return inner.length === 0 ? `${key}{}` : `${key}{${inner.join(', ')}}${more}`
    }
    if (Array.isArray(value)) return `${key}:array(${value.length})`
    return `${key}:${value === null ? 'null' : typeof value}`
  })
  return `${parts.join(', ')}${all.length > shown.length ? ` 等 ${all.length} 个` : ''}`
}

/**
 * 控制台数据网关（BroadScopeAspnGateway）：POST form，params 内嵌 JSON。
 * apiName: 'usage' | 'quota-config' | 'subscription'。返回网关 DataV2 内层 data。
 * 浏览器同款 UA：这个网关的人机校验会挑自定义 UA 的毛病（PostonlyOrTokenError）。
 *
 * @param secProbe - 本次 sec_token 的来路（`resolveConsoleSecToken` 的返回）。**只用于诊断**：
 *   网关在"Cookie 抄错主机""会话过期""sec_token 没附上"三种成因下回的是同一个 NotLogined，
 *   不带这条上下文就分不开（2026-11-03 实机撞在第三种上）。
 */
async function callConsoleGateway(config, source, cookie, apiName, secToken, secProbe = {}, options = {}) {
  // 008：官方「用量明细」不在 apiPrefix 下，必须能整条覆盖 Api。只在 options 里给，不给就不变旧行为。
  const apiPath = typeof options.apiPath === 'string' && options.apiPath !== ''
    ? options.apiPath
    : `${source.apiPrefix}/${apiName}`
  assertDeclaredHost(source.url, config, source.id)
  const params = {
    Api: apiPath,
    V: '1.0',
    Data: {
      ...(isPlainObject(options.data) ? options.data : {}),
      cornerstoneParam: {
        feTraceId: randomUUID(),
        feURL: source.dashboardURL,
        protocol: 'V2',
        console: 'ONE_CONSOLE',
        productCode: 'p_efm',
        switchUserType: 3,
        domain: String(source.dashboardOrigin).replace(/^https?:\/\//, ''),
        consoleSite: source.consoleSite,
        userNickName: '',
        userPrincipalName: '',
        xsp_lang: 'zh-CN',
      },
    },
  }
  const anonymous = cookieValue(cookie, 'cna')
  if (typeof anonymous === 'string' && anonymous !== '') params.Data.cornerstoneParam['X-Anonymous-Id'] = anonymous
  const query = new URLSearchParams({
    action: String(source.gatewayAction),
    product: String(source.gatewayProduct),
    api: apiPath,
    _v: 'undefined',
  })
  const body = new URLSearchParams({
    product: String(source.gatewayProduct),
    action: String(source.gatewayAction),
    region: String(source.regionId ?? 'cn-beijing'),
    language: 'zh-CN',
    params: JSON.stringify(params),
    ...(typeof secToken === 'string' && secToken !== '' ? { sec_token: secToken } : {}),
  })
  await throttle(config.minIntervalMs)
  let response
  try {
    response = await fetch(`${source.url}?${query.toString()}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        cookie: String(cookie),
        origin: String(source.dashboardOrigin),
        referer: String(source.dashboardURL),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw new SourceError('Network', error instanceof Error ? error.message : String(error), source.id)
  }
  const text = await response.text()
  if (!response.ok) throw new SourceError(String(response.status), `HTTP ${response.status}`, source.id, text.slice(0, 600), [cookie, secToken])
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SourceError('BadResponse', '控制台返回了非 JSON（登录态多半失效，需重新复制 Cookie）', source.id, text.slice(0, 300), [cookie, secToken])
  }
  if (/NotAuthorised|NotLogined/i.test(JSON.stringify(payload).slice(0, 500))) {
    const gatewayError = pickString(payload, ['data.errorCode', 'errorCode']) ?? 'BailianGateway.Login.NotLogined'
    // 光说"没登录"没法行动：把**目标主机**与**收到的 Cookie 名**一起说出来（值绝不进提示），
    // 用户一眼就能判断自己抄的是不是同一台主机上带登录票据的那条请求。
    const names = cookieNames(cookie)
    // 地址在函数开头已被 assertDeclaredHost 验过（不可解析就抛 BadUrl），这里不再兜底。
    const host = new URL(source.url).host
    // 必须精确匹配这台控制台期望的那张票据：泛匹配 `/ticket/i` 会被另一台主机的
    // `login_aliyunid_ticket` 顶掉，而那正是本条诊断要认的那件错事（README 抄 Cookie 一步点名的
    // 常见错误就是抄了 aliyun 控制台那条请求）。票据名属于业务配置，归预设所有；文案用变量，
    // 不把这个通用助手和某一家控制台焊死。
    // 票据名只有一个来源：DEFAULT_TICKET_COOKIE 常量，预设显式引用它（改名时改一处）。
    // 用 ||而不是 ??：用户把该字段覆盖成空串时，?? 挡不住，文案会退化成「没有看到登录票据 ——」
    // 这种既悬空又没名字可操作的半句话。
    const ticketName = String(source.loginTicketCookie || DEFAULT_LOGIN_TICKET_COOKIE)
    const hasTicket = names.names.some(name => name.toLowerCase() === ticketName.toLowerCase())
    const attached = typeof secToken === 'string' && secToken !== ''
    // 第三种成因必须单独报，否则永远修不好：票据在场而 sec_token 没附上时，上游回的仍是 NotLogined，
    // 旧写法把它一律读成"Cookie 抄错了/过期了"，于是用户把 Cookie 重抄十遍也不动（2026-11-03 实机：
    // Cookie 名字里明明有 login_qianwenai_ticket，提示却在断言"多半抄的是另一台主机"）。
    // 只在上游这个码本身就是 NotLogined 时改判；NotAuthorised 之类继续按原码报，不吞线索。
    if (hasTicket && !attached && /notlogined/i.test(gatewayError)) {
      const why = typeof secProbe.why === 'string' && secProbe.why !== '' ? `（自动获取失败：${secProbe.why}）` : ''
      const where = typeof secProbe.infoHost === 'string' && secProbe.infoHost !== ''
        ? `取自 ${secProbe.infoHost} 的请求没拿到 token`
        : '这个源没配 infoUrl，也没配 BAILIAN_CONSOLE_SECTOKEN'
      // 有骨架就说骨架：判断"token 是改名了、挪层了，还是这个会话压根没发"靠的是字段名，
      // 而这一行文案会随卡片出网，所以只可能是名字与类型（见 jsonKeyShape）。
      const shape = typeof secProbe.infoKeys === 'string' && secProbe.infoKeys !== ''
        ? `；那份响应的字段名：${secProbe.infoKeys}`
        : ''
      throw new SourceError('MissingSecToken',
        `这次请求没能带上 sec_token${why}：${where}。Cookie 里的登录票据 ${ticketName} 是在的，问题不在 Cookie 抄错`
        + `（本插件打的是 ${host}）${shape}`,
        source.id, configlessTrim(payload, 0, [cookie, secToken]), [cookie, secToken])
    }
    // 精确匹配之后别把有用的线索一起丢掉：名字里确实躺着一张 *ticket* 类票据、只是不是
    // 本控制台那张，就把**看到的那张**点出来（§6 第 14 条）——用户据此知道该去换哪条请求，
    // 而不只是被告知缺票据。
    const lookalike = names.names.find(name => /ticket/i.test(name) && name.toLowerCase() !== ticketName.toLowerCase())
    const diagnosis = `本插件打的是 ${host}；这份 Cookie 里的名字：${names.text}`
      + (hasTicket
        // 票据在场、sec_token 也真带上了，网关还不认——那只剩会话过期这一条，别再提"另一台主机"。
        ? `；票据 ${ticketName} 在场、sec_token 也已附上，网关仍不认：这份会话多半已过期（Cookie 一般能用几周），重新登录订阅页后当场再抄一条`
        : lookalike === undefined
          ? `；没有看到登录票据 ${ticketName}——多半抄的是另一台主机或另一条不带你登录态的请求`
          : `；看到的是 ${lookalike}（多半是另一台主机的票据），本控制台要的是 ${ticketName}`)
    const reason = pickString(payload, ['data.errorMsg', 'errorMsg']) ?? '控制台网关未接受这份登录会话 Cookie'
    throw new SourceError(gatewayError, `${reason}（${diagnosis}）`, source.id, configlessTrim(payload, 0, [cookie, secToken]), [cookie, secToken])
  }
  const code = pickString(payload, ['code']) ?? ''
  if (code !== '' && code !== '200' && payload?.successResponse !== true) {
    throw new SourceError(code, pickString(payload, ['message', 'msg']) ?? '网关未返回成功状态', source.id, configlessTrim(payload, 0, [cookie, secToken]), [cookie, secToken])
  }
  const inner = pickPath(payload, 'data.DataV2.data')
  if (isPlainObject(inner) && inner.success === false) {
    throw new SourceError('ConsoleApiError', pickString(inner, ['message', 'errorMsg']) ?? '网关业务失败', source.id, configlessTrim(payload, 0, [cookie, secToken]), [cookie, secToken])
  }
  const data = isPlainObject(inner?.data) ? inner.data : inner
  // 008：telemetry 的数据层不一定在 DataV2.data 下（官方前端是"向下找 originData 那层"），
  // 所以要求整份信封时不做结构断言，把信封交给调用方自己的解析器。
  if (options.envelope === true) return { data: isPlainObject(data) ? data : {}, envelope: payload }
  if (!isPlainObject(data)) throw new SourceError('BadResponse', '响应里找不到 DataV2 数据体（接口可能改版）', source.id, configlessTrim(payload, 0, [cookie, secToken]), [cookie, secToken])
  return data
}

/**
 * sec_token 自动获取：GET 控制台 /tool/user/info.json（登录 Cookie 即可），取 data.secToken。
 * 手配的 secTokenRef / Cookie 里的 sec_token 只作兜底。
 *
 * **返回结果对象而不是裸 token**：失败原先一律吞成 undefined，于是"token 没取到"与"Cookie 过期"
 * 在网关侧长成同一个 NotLogined，没有任何线索能把两者分开（2026-11-03 实机）。现在把原因
 * （`http-<状态>` / `no-token` / `network:<错误名>` / `no-info-url`）一起带回去供分流用。
 * 值仍然只待在变量里，绝不进文案。
 */
async function fetchConsoleSecToken(config, source, cookie) {
  if (typeof source.infoUrl !== 'string' || source.infoUrl === '') return { token: undefined, why: 'no-info-url' }
  assertDeclaredHost(source.infoUrl, config, source.id)
  await throttle(config.minIntervalMs)
  try {
    const response = await fetch(source.infoUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie: String(cookie),
        origin: String(source.dashboardOrigin),
        referer: String(source.dashboardURL),
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) return { token: undefined, why: `http-${response.status}` }
    const payload = JSON.parse(await response.text())
    const token = pickString(payload, ['data.secToken', 'secToken'])
    return typeof token === 'string' && token !== ''
      ? { token, why: 'ok' }
      // 没有 token 时把**键名骨架**一起带回去：这是判断"改名/挪层/会话没发 token"的唯一线索，
      // 而值绝不参与（jsonKeyShape 只列名字与类型）。
      : { token: undefined, why: 'no-token', keys: jsonKeyShape(payload) }
  } catch (error) {
    return { token: undefined, why: `network:${error instanceof Error ? error.name : 'unknown'}` }
  }
}

/**
 * sec_token 的三条来路按优先级归一，并**保留没取到的原因**给 NotLogined 分流：
 * 显式引用（`BAILIAN_CONSOLE_SECTOKEN`）> info.json 自动取 > Cookie 里的 `sec_token`。
 *
 * @returns secToken（三条全空为 undefined）、via、why，以及自动取时那台 info 主机名。
 */
async function resolveConsoleSecToken(config, source, cookie) {
  const explicit = typeof source._secToken === 'string' && source._secToken !== '' ? source._secToken : undefined
  if (explicit !== undefined) return { secToken: explicit, via: 'ref' }
  const fetched = await fetchConsoleSecToken(config, source, cookie)
  if (typeof fetched.token === 'string') return { secToken: fetched.token, via: 'info' }
  const fromCookie = cookieValue(cookie, 'sec_token')
  if (typeof fromCookie === 'string' && fromCookie !== '') return { secToken: fromCookie, via: 'cookie' }
  let infoHost = ''
  if (typeof source.infoUrl === 'string' && source.infoUrl !== '') {
    try {
      infoHost = new URL(source.infoUrl).host
    } catch {
      // 不可解析的 infoUrl 早在 assertDeclaredHost 那步抛 BadUrl 了；这里只是兜底，不编主机名。
    }
  }
  return { secToken: undefined, via: 'none', why: fetched.why, infoHost, infoKeys: fetched.keys }
}

/**
 * usage + subscription + quota-config（按档位）→ 官方余量卡
 * （剩余 = 账期额度 × (1 − 已用比例)）。
 *
 * **一个窗口只有在该账号真的回了读数时才成为一条计量**。`quota-config` 里躺着的 `five_hour`
 * 只是档位配置，不代表这个套餐有 5 小时窗口——2026-09-06 实测个人版 standard 的
 * `usage` 只回 `per1WeekPercentage`/`per1WeekResetTime`，此时若拿配置去拼一行
 * 「5 小时窗口 额度上限 3,000」，那是把配置噪声当额度显示给用户。
 *
 * **2026-09-23 实测：控制台把账期改成按月**。同一个源的 `usage` 只剩
 * `per1MonthPercentage` / `per1MonthResetTime`，`quota-config` 的档位额度字段也跟着从
 * `weekly` 改名成 `monthly`（档位表：lite / standard / pro / essential 各回 `monthly` +
 * `five_hour`，另有 `addon_quota.extrabundle`）。只认 per1Week/per5Hour 的旧代码于是
 * 一条计量都拼不出来 → 卡片"无数据"（症状：徽标只剩实测卡，官方余量不见了）。
 * 因此月度与周度**两条都读**，谁回了读数谁当主计量；老套餐继续按 `weekly` 走。
 */
function buildConsoleCard(source, usage, quota, subscription) {
  const monthRatio = toNumber(usage.per1MonthPercentage)
  const weekRatio = toNumber(usage.per1WeekPercentage)
  const fiveRatio = toNumber(usage.per5HourPercentage)
  const specCode = pickString(subscription ?? {}, ['specCode', 'SpecCode']) ?? ''
  const specQuota = isPlainObject(quota) && specCode !== '' && isPlainObject(quota[specCode]) ? quota[specCode] : quota
  const monthlyTotal = toNumber(specQuota?.monthly)
  const weeklyTotal = toNumber(specQuota?.weekly)
  const fiveTotal = toNumber(specQuota?.fiveHour ?? specQuota?.five_hour)
  const addon = isPlainObject(quota?.addon_quota) ? toNumber(quota.addon_quota.extrabundle) : undefined
  const meters = []
  // 数组顺序即主次：`meters[0]` 与顶层 remaining/total 同源（前端只把 `meters.slice(1)`
  // 渲染成次级行）。所以"当前账期"必须排在最前，否则徽标报一个窗口、明细报另一个。
  // 一条计量**只在该窗口真回了读数时才存在**（与 fiveHour 同一条规矩）：
  // `quota-config` 里躺着的档位上限是配置、不是额度。2026-09-23 账期改名后存在这样的错位组合——
  // `quota-config` 已叫 `monthly`、而 `usage` 仍只回 `per1WeekPercentage`；旧写法会让配置上限
  // 自成一条计量，并凭"monthly 优先"当上主计量：官方周比例被静默顶掉，且因为 total 有值，
  // denominatorFailed 与 emptyReason 都不会给（三个诊断一起灭）。配置值改落 extra 诊断。
  if (monthRatio !== undefined) {
    meters.push({
      key: 'monthly',
      label: '本月窗口',
      labelEn: 'Monthly window',
      unit: 'Credits',
      total: monthlyTotal,
      remaining: monthlyTotal !== undefined
        ? round(Math.max(0, monthlyTotal * (1 - Math.min(1, monthRatio))))
        : undefined,
      resetAt: toEpochMs(usage.per1MonthResetTime),
    })
  }
  if (weekRatio !== undefined) {
    meters.push({
      key: 'weekly',
      label: '7 天窗口',
      labelEn: '7-day window',
      unit: 'Credits',
      total: weeklyTotal,
      remaining: weeklyTotal !== undefined
        ? round(Math.max(0, weeklyTotal * (1 - Math.min(1, weekRatio))))
        : undefined,
      resetAt: toEpochMs(usage.per1WeekResetTime),
    })
  }
  if (fiveRatio !== undefined) {
    meters.push({
      key: 'fiveHour',
      label: '5 小时窗口',
      labelEn: '5-hour window',
      unit: 'Credits',
      total: fiveTotal,
      remaining: fiveTotal !== undefined ? round(Math.max(0, fiveTotal * (1 - Math.min(1, fiveRatio)))) : undefined,
      resetAt: toEpochMs(usage.per5HourResetTime),
    })
  }
  // 顶层字段＝主计量（徽标与模型工具摘要只认顶层）：按月 > 按周 > 第一条。
  const primary = meters.find(meter => meter.key === 'monthly')
    ?? meters.find(meter => meter.key === 'weekly')
    ?? meters[0]
  const primaryRatio = primary?.key === 'monthly' ? monthRatio
    : (primary?.key === 'fiveHour' ? fiveRatio : weekRatio)
  // 上游**直接返回**的已用比例是官方真值，不因为"档位额度那一路超时/失败"就被丢掉
  // （宪法原则 I v2.0.0：禁的是**派生**百分比）。缺分母时只报比例：**不给 remainingPercent**
  // （条由前端按这个官方比例画，服务端不派生死数）、不报绝对剩余量（算不出来就是不报），
  // 并留下 denominatorFailed 诊断 —— 老写法是静默变成"无数据"，把人误导去核对字段名。
  const officialRatio = primaryRatio !== undefined ? round(Math.min(1, primaryRatio) * 100) : undefined
  const ratioOnly = officialRatio !== undefined && primary?.total === undefined
  if (ratioOnly && primary !== undefined) primary.usedPercent = officialRatio
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'credits',
    unit: 'Credits',
    total: primary?.total,
    remaining: primary?.remaining,
    usedPercent: ratioOnly ? officialRatio : undefined,
    expiresAt: primary?.resetAt,
    items: [],
    meters,
    extra: {
      usedPercent: officialRatio,
      denominatorFailed: ratioOnly ? true : undefined,
      specCode: specCode === '' ? undefined : specCode,
      planRemainingDays: toNumber(subscription?.remainingDays),
      planEndsAt: toEpochMs(subscription?.endTime),
      addonTotal: addon,
      // 老前端的文字尾巴兼容：只有真回了比例才报，纯配置值不进 extra。
      fiveHourTotal: fiveRatio !== undefined ? fiveTotal : undefined,
      fiveHourUsedPercent: fiveRatio !== undefined ? round(Math.min(1, fiveRatio) * 100) : undefined,
      fiveHourResetAt: fiveRatio !== undefined ? toEpochMs(usage.per5HourResetTime) : undefined,
      // 档位配了 5 小时额度但这个套餐没回读数——记下来供 debug/probe 看，绝不当额度显示。
      fiveHourConfiguredNoReading: fiveTotal !== undefined && fiveRatio === undefined ? true : undefined,
      // 同理：月度/周度档位上限到了、但对应窗口没回读数（账期字段错位的形态）。
      monthlyConfiguredNoReading: monthlyTotal !== undefined && monthRatio === undefined ? true : undefined,
      weeklyConfiguredNoReading: weeklyTotal !== undefined && weekRatio === undefined ? true : undefined,
    },
  }
  if (meters.length === 0) {
    card.emptyReason = '网关 usage 里没有 per1Month/per1Week/per5Hour 比例（开 debug 看 shape；换套餐或换账期后字段集会不同）'
  } else if (card.remaining === undefined && card.total === undefined && officialRatio === undefined) {
    card.emptyReason = '识别到窗口但既没读数也没有档位额度（开 debug 核对 quota-config 字段名）'
  }
  // 有比例没分母时**不给 emptyReason**：这张卡有可显示的官方真值（已用比例），
  // 空态是给"什么都没有"准备的，混用会让前端把它整张收起。
  return card
}

/* ============================================ Credits ↔ tokens 换算（014） */
/*
 * 只回答一个问题：**本账期**已经用掉的官方 Credits 对上了多少官方 tokens。
 * 两个因子都必须来自官方：Credits 已用量来自控制台卡，tokens 来自官方账号明细。
 * 因此这里严格限定在「账期起点 resetAt 前一天 → 今天」这一窗口——官方明细若被
 * 最早日期夹紧（coverage.clampedFrom），宁可报 official-clamped 也不拿半段去除，
 * 否则比值会被系统性放大。本机 tokens 只作参考展示，绝不参与比值。
 */

/** 有限数（数字或数字字符串）；null / 空串 / 布尔等“看起来能转数字”的脏值一律 undefined。 */
function finiteCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 时间戳入参：既接受毫秒数/数字字符串，也接受 Date（测试与调用方都常这么传）。 */
function timestampValueOf(value) {
  if (value instanceof Date) {
    const n = value.getTime()
    return Number.isFinite(n) ? n : undefined
  }
  return finiteCount(value)
}

/** 从某个时间点按本地日历加减天，返回 dayKey。 */
function shiftedDayKey(value, days) {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return dayKey(date.getTime())
}

/**
 * 账期重置日（resetAt 的前一天）回退一个自然月，返回 dayKey。
 * 用本地日期组件推进，并夹到目标月最后一天：1/31 回退到 12/31，
 * 3/31 回退到 2/28（闰年 2/29），不会溢出成 3/3。
 */
function monthBeforeDayKey(value) {
  const date = new Date(value)
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() - 1)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(day > lastDay ? lastDay : day)
  return dayKey(date.getTime())
}

/** 两个 dayKey 之间含两端的日历天数。用 UTC 组件做差，避开夏令时 23/25 小时日。 */
function inclusiveDaySpanOf(fromKey, toKey) {
  const from = String(fromKey).split('-').map(Number)
  const to = String(toKey).split('-').map(Number)
  const fromMs = Date.UTC(from[0], from[1] - 1, from[2])
  const toMs = Date.UTC(to[0], to[1] - 1, to[2])
  return (toMs - fromMs) / DAY_MS + 1
}

function creditsWindowLabelOf(key) {
  return key === 'monthly'
    ? { label: '本月账期', labelEn: 'Monthly cycle' }
    : { label: '7 天账期', labelEn: '7-day cycle' }
}

/**
 * 从公开控制台卡里解析出「一个可换算的 Credits 账期」。
 * 本函数是纯函数且**不做任何取整**——取整会改变 tokens/Credits 的比值，
 * 只允许在最终展示容量时取整（composeCreditsToken 的 capacityTokens）。
 * @returns {{ok:true,key:string,label:string,labelEn:string,from:string,to:string,resetAt:number,resetDay:string,cycleDays:number,elapsedDays:number,total:number,used:number,usedPercent:number}|{ok:false,reason:string}}
 */
function creditsCycleOf(card, now = Date.now()) {
  const meters = Array.isArray(card?.meters) ? card.meters : []
  const monthly = meters.find(item => item?.key === 'monthly')
  const weekly = meters.find(item => item?.key === 'weekly')
  const selected = monthly ?? weekly
  if (selected === undefined) {
    const onlyFiveHour = meters.length > 0 && meters.every(item => item?.key === 'fiveHour')
    return { ok: false, reason: onlyFiveHour ? 'five-hour-only' : 'no-credits-reading' }
  }

  const key = selected.key === 'monthly' ? 'monthly' : 'weekly'
  const total = finiteCount(selected.total)
  if (total === undefined || total <= 0) return { ok: false, reason: 'no-credits-total' }
  const resetRaw = selected.resetAt
  const resetAt = resetRaw instanceof Date ? resetRaw.getTime() : toEpochMs(resetRaw)
  if (resetAt === undefined || !Number.isFinite(resetAt)) return { ok: false, reason: 'no-reset-time' }
  const resetDay = shiftedDayKey(resetAt, -1)
  const from = key === 'monthly' ? monthBeforeDayKey(resetAt) : shiftedDayKey(resetAt, -7)
  const at = timestampValueOf(now) ?? Date.now()
  const to = dayKey(at)
  if (from > to) return { ok: false, reason: 'no-credits-reading' }

  // 已用额度：优先用官方读数；没有读数时用官方已用比例反推（契约 §2.1）。
  const meterUsed = finiteCount(selected.used)
  const meterPercent = finiteCount(selected.usedPercent)
  let used
  if (meterUsed !== undefined && meterUsed >= 0) {
    used = meterUsed
  } else if (meterPercent !== undefined && meterPercent >= 0) {
    used = total * meterPercent / 100
  } else {
    return { ok: false, reason: 'no-credits-reading' }
  }
  if (!Number.isFinite(used)) return { ok: false, reason: 'no-credits-reading' }
  const usedPercent = meterPercent !== undefined && meterPercent >= 0
    ? meterPercent
    : used / total * 100
  if (!Number.isFinite(usedPercent)) return { ok: false, reason: 'no-credits-reading' }

  const labels = creditsWindowLabelOf(key)
  return {
    ok: true,
    key,
    label: labels.label,
    labelEn: labels.labelEn,
    from,
    to,
    resetAt,
    resetDay,
    cycleDays: inclusiveDaySpanOf(from, resetDay),
    elapsedDays: inclusiveDaySpanOf(from, to),
    total,
    used,
    usedPercent,
  }
}

/** 官方 tokens / 已用 Credits；任一因子不可用就返回 null（绝不用本机数据补位）。 */
function creditsTokenRatioOf(tokens, used) {
  const t = finiteCount(tokens)
  const u = finiteCount(used)
  if (t === undefined || u === undefined || t <= 0 || u <= 0) return null
  return t / u
}

/**
 * 官方口径的三类 tokens 及其每 Credit 值（纯函数，不取整）。
 * 官方 input **包含** cacheRead，所以未命中输入要先相减再算；直接拿 input 当「未命中」会把
 * 缓存命中算两遍，三者相加也就不再等于官方 tokens。
 * 缺字段/非有限按 0；异常上游 cacheRead > input 时未命中输入夹到 0——这时三项之和会小于官方
 * 总量，是官方数据自身的问题，客户端不做校验。
 * used <= 0 返回 null：014 已经用 no-token-data 提前短路，这里只表达「不可除」。
 * @returns {{uncachedInput:{tokens:number,perCredit:number},cacheRead:{tokens:number,perCredit:number},output:{tokens:number,perCredit:number}}|null}
 */
function creditsClassRatios(officialTotals, used) {
  const u = finiteCount(used)
  if (u === undefined || u <= 0) return null
  const input = Math.max(0, finiteCount(officialTotals?.input) ?? 0)
  const cacheRead = Math.max(0, finiteCount(officialTotals?.cacheRead) ?? 0)
  const output = Math.max(0, finiteCount(officialTotals?.output) ?? 0)
  const uncachedInput = Math.max(0, input - cacheRead)
  return {
    uncachedInput: { tokens: uncachedInput, perCredit: uncachedInput / u },
    cacheRead: { tokens: cacheRead, perCredit: cacheRead / u },
    output: { tokens: output, perCredit: output / u },
  }
}

/**
 * 本机口径的按模型比值：分子是本机该模型 tokens，分母是**账号级**已用 Credits。
 * 官方不按模型拆 Credits，也没有公开每个模型的 Credits 单价，所以这不是「该模型实际花掉的
 * Credits」，而是贡献值；各行相加约等于本机总量，和官方账号总量有差额（其他设备/客户端）。
 * 保持 aggregateUsageRange.models 的顺序（已按 tokens 降序），只保留 tokens > 0 的模型。
 * used <= 0 或入参不是数组时返回空数组，绝不产出 Infinity/NaN。
 * @returns {Array<{id:string,provider:string,model:string,tokens:number,calls:number,tokensPerCredit:number}>}
 */
function creditsModelRatios(localModels, used) {
  const u = finiteCount(used)
  if (!Array.isArray(localModels) || u === undefined || u <= 0) return []
  const out = []
  for (const item of localModels) {
    const tokens = finiteCount(item?.totals?.tokens)
    if (tokens === undefined || tokens <= 0) continue
    out.push({
      id: typeof item?.id === 'string' ? item.id : '',
      provider: typeof item?.provider === 'string' ? item.provider : 'unknown',
      model: typeof item?.model === 'string' ? item.model : '',
      tokens,
      calls: Math.max(0, finiteCount(item?.totals?.calls) ?? 0),
      tokensPerCredit: tokens / u,
    })
  }
  return out
}

const CREDITS_UNAVAILABLE_HINTS = {
  'no-console-card': '未启用官方控制台数据源（token-plan-console），无法读取 Credits 与 tokens。',
  'no-credits-reading': '当前套餐没有可用的月度或周度 Credits 读数，无法确定账期已用额度。',
  'no-credits-total': '官方只返回了已用比例、没有额度总量，无法换算已用 Credits。',
  'no-reset-time': '官方没有返回账期重置时间，无法确定账期起点。',
  'five-hour-only': '当前只有 5 小时窗口读数，无法与按天统计的 tokens 对齐。',
  'official-unavailable': '官方账号侧 tokens 明细暂不可用，稍后再试。',
  'no-token-data': '官方账号侧 tokens 为 0 或无法与本账期 Credits 相除，暂不给比值。',
}

/**
 * 拼出路由响应（纯函数）。official 可以是 buildOfficialUsageSnapshot 的失败体；
 * localTotals 可以为 null（本机没有 token 计数时只展示官方比值，不补 0）。
 */
function composeCreditsToken({ card, official, localTotals, now } = {}) {
  const generatedAt = timestampValueOf(now) ?? Date.now()
  const unavailable = (reason, code, hint) => {
    const body = { generatedAt, available: false, reason }
    if (typeof code === 'string' && code !== '') body.code = code
    if (typeof hint === 'string' && hint !== '') body.hint = hint
    return body
  }

  if (!isPlainObject(card)) {
    return unavailable('no-console-card', 'no-console-card', CREDITS_UNAVAILABLE_HINTS['no-console-card'])
  }
  if (card.error !== undefined && card.error !== null && card.error !== '') {
    return unavailable('console-unavailable', card.errorCode, card.hint)
  }

  const cycle = creditsCycleOf(card, generatedAt)
  if (!cycle.ok) {
    return unavailable(cycle.reason, cycle.reason, CREDITS_UNAVAILABLE_HINTS[cycle.reason])
  }

  if (!isPlainObject(official) || official.error !== undefined) {
    const code = typeof official?.code === 'string' ? official.code : 'official-unavailable'
    const hint = typeof official?.hint === 'string' && official.hint !== ''
      ? official.hint
      : CREDITS_UNAVAILABLE_HINTS['official-unavailable']
    return unavailable('official-unavailable', code, hint)
  }

  const clampedFrom = official.coverage?.clampedFrom
  if (clampedFrom !== undefined && clampedFrom !== null && clampedFrom !== '') {
    return unavailable(
      'official-clamped',
      'official-clamped',
      '官方明细最早只到 ' + clampedFrom + '，盖不住本账期起点，不能拿部分区间相除。',
    )
  }

  const officialTokens = finiteCount(official.totals?.tokens)
  if (officialTokens === undefined || officialTokens <= 0) {
    return unavailable('no-token-data', 'no-token-data', CREDITS_UNAVAILABLE_HINTS['no-token-data'])
  }
  const ratio = creditsTokenRatioOf(officialTokens, cycle.used)
  if (ratio === null) {
    return unavailable('no-token-data', 'no-token-data', CREDITS_UNAVAILABLE_HINTS['no-token-data'])
  }

  const localTokens = finiteCount(localTotals?.totals?.tokens)
  const officialFrom = typeof official.range?.from === 'string' && official.range.from !== ''
    ? official.range.from
    : cycle.from
  const officialTo = typeof official.range?.to === 'string' && official.range.to !== ''
    ? official.range.to
    : cycle.to
  const officialDays = finiteCount(official.range?.days) ?? cycle.elapsedDays

  return {
    generatedAt,
    available: true,
    window: {
      key: cycle.key,
      label: cycle.label,
      labelEn: cycle.labelEn,
      from: cycle.from,
      to: cycle.to,
      resetAt: cycle.resetAt,
      resetDay: cycle.resetDay,
      cycleDays: cycle.cycleDays,
      elapsedDays: cycle.elapsedDays,
    },
    credits: {
      unit: 'Credits',
      total: cycle.total,
      used: cycle.used,
      usedPercent: cycle.usedPercent,
    },
    tokens: {
      official: officialTokens,
      local: localTokens !== undefined && localTokens >= 0 ? localTokens : null,
    },
    // classes 只取官方三类；models 的分子是本机 tokens、分母是账号级 Credits，
    // 所以用 modelsBasis:'local' 标明它是贡献口径，不是官方按模型拆出来的兑换率。
    ratio: {
      tokensPerCredit: ratio,
      capacityTokens: Math.round(ratio * cycle.total),
      classes: creditsClassRatios(official.totals, cycle.used),
      modelsBasis: 'local',
      models: creditsModelRatios(localTotals?.models, cycle.used),
    },
    scope: {
      officialFrom,
      officialTo,
      officialDays,
      cached: official.coverage?.cached === true,
      clampedFrom: null,
    },
    source: {
      kind: 'credits-token',
      veracity: 'measured',
      label: '官方 Credits × 官方 tokens（本账期实测）',
      labelEn: 'Official credits × official tokens (measured this cycle)',
    },
  }
}

/**
 * 014 路由的编排：先拿控制台卡并解析账期，再只按该账期请求官方 tokens。
 * 本机 totals/models 只作参考与模型行贡献值，失败完全忽略——它们不参与官方比值。
 */
async function buildCreditsTokenSnapshot(config, ctx, { fresh = false } = {}) {
  const now = Date.now()
  const snapshot = await buildStatus(config, ctx, { fresh })
  const cards = Array.isArray(snapshot?.cards) ? snapshot.cards : []
  const card = cards.find(item => item?.id === 'token-plan-console')
  const cycle = creditsCycleOf(card, now)
  // 卡缺失 / 卡本身报错 / 账期不可解析：都不该再打官方接口。
  if (!cycle.ok || !isPlainObject(card) || (card.error !== undefined && card.error !== null && card.error !== '')) {
    return composeCreditsToken({ card, official: null, localTotals: null, now })
  }
  const official = await buildOfficialUsageSnapshot(config, ctx, { from: cycle.from, to: cycle.to }, { fresh })
  let localTotals = null
  try {
    const local = buildUsageSnapshot(config, ctx, { from: cycle.from, to: cycle.to })
    if (local?.error === undefined) localTotals = local
  } catch {
    // 本机用量只是参考列；读不到就不显示，绝不影响官方比值。
  }
  return composeCreditsToken({ card, official, localTotals, now })
}

async function postForm(url, body, timeoutMs, secrets = []) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'dsh-token-plan-quota/0.1' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new SourceError('SDK.ServerUnreachable', error instanceof Error ? error.message : String(error), url)
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    throw new SourceError(String(response.status), '鉴权被拒（检查 Key 权限与所属账号）', url, text.slice(0, 600), [...secrets, body])
  }
  return text
}

function parseEnvelope(text, sourceId, envelopeOk, secrets = []) {
  if (text === '') return {}
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SourceError('BadResponse', '上游返回了非 JSON（可能被网关拦截或登录态失效）', sourceId, text.slice(0, 600), secrets)
  }
  const failure = envelopeOk(payload)
  if (failure !== undefined) throw new SourceError(failure.code, failure.message, sourceId, configlessTrim(payload, 0, secrets), secrets)
  return payload
}

function rpcEnvelopeOk(payload) {
  const success = pickFirst(payload, ['Success', 'success'])
  const code = pickString(payload, ['Code', 'code']) ?? 'Success'
  const okSet = ['success', '200', 'ok', 'true']
  if (success === false) return { code, message: pickString(payload, ['Message', 'message']) ?? '业务未成功' }
  if (okSet.includes(String(code).toLowerCase()) || success === true) return undefined
  return { code, message: pickString(payload, ['Message', 'message', 'StatusMessage']) ?? '上游未返回成功状态' }
}

function httpEnvelopeOk(payload) {
  const code = pickString(payload, ['code', 'Code', 'status', 'statusCode'])
  if (code === undefined) return undefined
  return ['200', '0', 'ok', 'success', 'true'].includes(String(code).toLowerCase())
    ? undefined
    : { code, message: pickString(payload, ['message', 'Message', 'msg']) ?? '上游未返回成功状态' }
}

function configlessTrim(payload, depth = 0, secrets = []) {
  if (depth > 3) return '…'
  if (Array.isArray(payload)) return payload.slice(0, 2).map(item => configlessTrim(item, depth + 1, secrets))
  if (isPlainObject(payload)) {
    const out = {}
    for (const [key, value] of Object.entries(payload)) {
      // 凭据键名黑名单：accessKeyId/Secret、签名、会话令牌（sec_token 与 secToken 两种写法）、
      // cookie、authorization、api key、password、bearer。**不含裸 `token`**——那会把
      // `total_tokens` 这类正常用量字段一并删掉，而那是本插件要显示的数据。
      if (/accesskeyid|accesskeysecret|signature|securitytoken|sec[-_]?token|secret|password|passwd|credential|bearer|cookie|authorization|api[-_]?key/i.test(key)) continue
      out[key] = value !== null && typeof value === 'object'
        ? configlessTrim(value, depth + 1, secrets)
        : typeof value === 'string'
          ? redactSecrets(value.length > 60 ? `${value.slice(0, 60)}…` : value, secrets)
          : value
    }
    return out
  }
  return typeof payload === 'string' ? redactSecrets(payload, secrets) : payload
}

/* ==================================================== 抽取工具 */

function pickPath(value, path) {
  let current = value
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

function pickFirst(payload, paths) {
  for (const path of paths ?? []) {
    const value = pickPath(payload, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function pickString(payload, paths) {
  const value = pickFirst(payload, paths)
  if (value !== null && typeof value === 'object') return undefined
  return value === undefined ? undefined : String(value).trim()
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[,\s]/g, '')
  if (cleaned === '') return undefined
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toEpochMs(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  if (/^\d{10,13}$/.test(text)) {
    const raw = Number(text)
    return text.length === 10 ? raw * 1000 : raw
  }
  const spaced = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (spaced !== null) {
    const [, y, mo, d, h, mi, s] = spaced
    const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}+08:00`)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly !== null) {
    const parsed = Date.parse(`${dateOnly[0]}T00:00:00+08:00`)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const direct = Date.parse(text)
  return Number.isFinite(direct) ? direct : undefined
}

/* ==================================================== 卡片构建 */

function buildListCard(source, payload) {
  const rawItems = pickFirst(payload, source.list)
  const items = Array.isArray(rawItems) ? rawItems : rawItems === undefined ? [] : [rawItems]
  const rows = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const remaining = toNumber(pickFirst(item, source.item.remaining))
    const total = toNumber(pickFirst(item, source.item.total))
    const explicitUsed = toNumber(pickFirst(item, source.item.used))
    const haystack = (source.item.haystack ?? [])
      .map(path => (pickString(item, [path]) ?? '').toLowerCase())
      .concat([String(source.id).toLowerCase()])
      .join(' ')
    rows.push({
      name: pickString(item, source.item.name) ?? pickString(item, source.item.id) ?? '(未命名)',
      id: pickString(item, source.item.id),
      remaining,
      total,
      used: explicitUsed ?? (total !== undefined && remaining !== undefined ? Math.max(0, total - remaining) : undefined),
      unit: pickString(item, source.item.unit) ?? '',
      status: pickString(item, source.item.status) ?? '',
      expiresAt: toEpochMs(pickFirst(item, source.item.expiresAt)),
      cycleType: pickString(item, source.item.cycleType),
      capacityType: pickString(item, source.item.capacityType),
      matched: source.keywords.length === 0 || source.keywords.some(keyword => haystack.includes(keyword)),
    })
  }
  const matched = rows.filter(row => row.matched)
  const buckets = new Map()
  for (const row of matched) {
    if (row.remaining === undefined && row.total === undefined) continue
    const key = row.unit || ''
    const bucket = buckets.get(key) ?? { unit: row.unit, remaining: 0, total: 0, hasRemaining: false, hasTotal: false }
    if (row.remaining !== undefined) {
      bucket.remaining += row.remaining
      bucket.hasRemaining = true
    }
    if (row.total !== undefined) {
      bucket.total += row.total
      bucket.hasTotal = true
    }
    buckets.set(key, bucket)
  }
  const groups = [...buckets.values()]
  const primary = groups[0]
  const expiries = matched.map(row => row.expiresAt).filter(value => value !== undefined && value > Date.now())
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'credits',
    unit: primary?.unit ?? '',
    remaining: primary?.hasRemaining === true ? round(primary.remaining) : undefined,
    total: primary?.hasTotal === true ? round(primary.total) : undefined,
    used: primary?.hasRemaining === true && primary?.hasTotal === true ? round(Math.max(0, primary.total - primary.remaining)) : undefined,
    itemCount: matched.length,
    hiddenCount: Math.max(0, rows.length - matched.length),
    expiresAt: expiries.length > 0 ? Math.min(...expiries) : undefined,
    items: matched.slice(0, 25).map(row => ({
      name: row.name,
      id: row.id,
      remaining: row.remaining,
      total: row.total,
      used: row.used,
      unit: row.unit,
      status: row.status,
      expiresAt: row.expiresAt,
      cycleType: row.cycleType,
      capacityType: row.capacityType,
    })),
    otherUnits: groups.slice(1).map(group => ({ unit: group.unit, remaining: group.hasRemaining ? round(group.remaining) : undefined, total: group.hasTotal ? round(group.total) : undefined })),
  }
  if (card.remaining === undefined && card.total === undefined) {
    card.emptyReason = rows.length === 0
      ? '上游返回 0 条实例（这个账号没有匹配的资源包/套餐）'
      : card.hiddenCount > 0
        ? `有 ${rows.length} 条实例但都被关键词过滤掉了（把 keywords 设为 [] 可全显示）`
        : `有 ${rows.length} 条实例但没有剩余量字段`
  }
  return card
}

/**
 * 派生表达式求值：一条算式最多一个 `+`/`-`，操作符两侧要么是 `fields` 里的引用名、要么是数字。
 * 故意不做表达式引擎——需要乘除/括号/条件的家，说明该写专用 builder 了，别把配置变成编程语言。
 * 任何一个操作数取不到 → 整条 undefined（宁可少一个数，不给猜出来的数）。
 * @param expr 形如 'totalCredits'、'totalCredits - totalUsage'、'100 - used'。
 * @param values 引用名 → 已抽取到的数字。
 */
function evalDerive(expr, values) {
  const tokens = String(expr ?? '').split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return undefined
  const operand = token => (/^-?\d+(?:\.\d+)?$/.test(token) ? Number(token) : values[token])
  const first = operand(tokens[0])
  if (typeof first !== 'number' || !Number.isFinite(first)) return undefined
  if (tokens.length === 1) return first
  if (tokens.length !== 3 || (tokens[1] !== '+' && tokens[1] !== '-')) return undefined
  const second = operand(tokens[2])
  if (typeof second !== 'number' || !Number.isFinite(second)) return undefined
  return round(tokens[1] === '+' ? first + second : first - second)
}

function buildSingleCard(source, payload) {
  const fieldValues = {}
  for (const [name, paths] of Object.entries(source.fields ?? {})) {
    const value = toNumber(pickFirst(payload, Array.isArray(paths) ? paths : [paths]))
    if (value !== undefined) fieldValues[name] = value
  }
  let remaining = toNumber(pickFirst(payload, source.extract?.remaining ?? []))
  let total = toNumber(pickFirst(payload, source.extract?.total ?? []))
  const extra = {}
  for (const [key, paths] of Object.entries(source.extra ?? {})) {
    const value = toNumber(pickFirst(payload, Array.isArray(paths) ? paths : [paths]))
    if (value !== undefined) extra[key] = value
  }
  let used
  if (isPlainObject(source.derive) && Object.keys(source.derive).length > 0) {
    // 派生字段能引用 extract 抽出来的 remaining/total，反过来 extract 也让位给 derive。
    const scope = { ...fieldValues }
    if (remaining !== undefined) scope.remaining = remaining
    if (total !== undefined) scope.total = total
    const derived = {}
    for (const [key, expr] of Object.entries(source.derive)) {
      const value = evalDerive(expr, scope)
      if (value !== undefined) derived[key] = value
    }
    if ('remaining' in derived) remaining = derived.remaining
    if ('total' in derived) total = derived.total
    if ('used' in derived) used = derived.used
  }
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'money',
    unit: pickString(payload, source.extract?.unit ?? []) ?? source.unit ?? (source.metric === 'money' ? 'CNY' : ''),
    remaining,
    total,
    used: used ?? (remaining !== undefined && total !== undefined ? round(Math.max(0, total - remaining)) : undefined),
    items: [],
    extra,
  }
  if (remaining === undefined && total === undefined) {
    card.emptyReason = isPlainObject(source.fields) && Object.keys(source.fields).length > 0
      ? `响应里没有识别到 ${Object.keys(source.fields).join('/')} 字段（开 debug 核对字段名）`
      : '响应里没有识别到金额字段（开 debug 核对字段名）'
  }
  if (source.region !== undefined) card.region = source.region
  return card
}

/** DeepSeek /user/balance 专用卡片（多币种优先 CNY）。 */
function buildDeepseekCard(source, payload) {
  const rows = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const primary = rows.find(row => row?.currency === 'CNY') ?? rows[0] ?? {}
  const remaining = toNumber(primary.total_balance)
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: 'money',
    unit: typeof primary.currency === 'string' ? primary.currency : 'CNY',
    remaining,
    total: undefined,
    items: rows
      .filter(row => row !== primary)
      .map(row => ({ name: String(row.currency ?? '?'), remaining: toNumber(row.total_balance), total: undefined, unit: row.currency })),
    extra: {
      granted: toNumber(primary.granted_balance),
      toppedUp: toNumber(primary.topped_up_balance),
    },
  }
  if (remaining === undefined && rows.length === 0) {
    card.emptyReason = 'balance_infos 为空：Key 无效或账号没有可用余额'
  } else if (remaining === undefined) {
    card.emptyReason = '响应里没有识别到 total_balance 字段（开 debug 核对字段名）'
  }
  return card
}

function finalizeCard(card) {
  if (typeof card.total === 'number' && card.total > 0) {
    const used = card.used ?? (typeof card.remaining === 'number' ? Math.max(0, card.total - card.remaining) : undefined)
    if (used !== undefined) {
      card.used = round(used)
      card.usedPercent = round(Math.min(9999, (used / card.total) * 100))
      card.remainingPercent = round(Math.max(0, Math.min(100, (1 - used / card.total) * 100)))
    }
  }
  // 多计量条（一张卡多个窗口，如千问 5 小时/7 天、智谱 5h/周/日）：每条各自算百分比。
  if (Array.isArray(card.meters) && card.meters.length > 0) {
    // 「是不是实测卡」只有一个判据，且必须与客户端 lib/client.js 的 isMeasured 同口径
    // （estimated === true || veracity === 'local'）。本仓库无构建步骤、两半边共享不了这段代码，
    // 所以各自留一处：只认 estimated 会漏掉"只标了 veracity:'local' 的实测卡"，
    // 那种卡会在服务端派生出百分比——客户端拒绝画条、正文却照样印「已用 N%」，
    // 两半边对同一张卡的说法不一致，比多印一行更糟。两侧断言见 test/host.mjs 与 test/client.mjs。
    const allowPercent = card.estimated !== true && card.veracity !== 'local'
    card.meters = card.meters
      .filter(meter => isPlainObject(meter))
      .map(meter => finalizeMeter(meter, allowPercent))
  }
  if (typeof card.errorCode === 'string' && card.hint === undefined) card.hint = hintFor(card.errorCode, card.errorHints)
  return card
}

/**
 * 归一一条计量。约定：预设/构造器只填 `{remaining,total,resetAt,unit}`，
 * 百分比一律在这里派生——**没有官方分母就永不出百分比与余量条**（实测卡「不估算」的硬规则）。
 * @param meter 原始计量对象。
 * @param allowPercent 该卡是否官方真值（false＝实测卡，剥掉一切百分比）。
 */
function finalizeMeter(meter, allowPercent) {
  const out = { ...meter }
  if (typeof out.total === 'number' && out.total > 0) {
    const used = out.used ?? (typeof out.remaining === 'number' ? Math.max(0, out.total - out.remaining) : undefined)
    if (used !== undefined) {
      out.used = round(used)
      if (allowPercent) {
        out.usedPercent = round(Math.min(9999, (used / out.total) * 100))
        out.remainingPercent = round(Math.max(0, Math.min(100, (1 - used / out.total) * 100)))
      }
    }
  }
  return out
}

/**
 * 错误码 → 可操作提示。先看**这个源自己声明的 errorHints**（一家供应商的坑跟别家不同，
 * 例如 Moonshot 的 401 九成是区用错了，而 DeepSeek 的 401 是 Key 问题），再退回全局表。
 * @param code 错误码（业务码或 HTTP 状态字符串）。
 * @param hints 数据源自带的 `{ code: 提示 }`，可缺省。
 */
function hintFor(code, hints) {
  if (typeof code !== 'string' || code === '') return undefined
  const own = hints?.[code] ?? hints?.[Number(code)]
  if (typeof own === 'string') return own
  if (ERROR_HINTS[code] !== undefined) return ERROR_HINTS[code]
  return ERROR_HINTS[code.replace(/[.\s-]/g, '')]
}

/* ==================================================== 查询编排 */

/** 宽松 JSON：拿不到对象就返回 undefined（用于从 HTTP 错误体里再捞一层人话）。 */
function safeJson(text) {
  try {
    const parsed = JSON.parse(String(text))
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 查一个数据源 → 卡片（错误也成卡，带 hint；`errorHints` 只留在内部参与算提示，不外发）。 */
async function querySource(source, config, credentials) {
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'credits',
    updatedAt: Date.now(),
    error: null,
    errorCode: null,
    hint: null,
    // 供应商绑定随卡下发（成功/错误卡都带上），前端徽标与面板按它跟随当前模型。
    bindProviders: Array.isArray(source.providers) ? source.providers : [],
  }
  if (source.veracity !== undefined) card.veracity = source.veracity
  if (source.sourceNote !== undefined) card.sourceNote = source.sourceNote
  // 区域随卡下发（Moonshot 这类多区供应商：卡片要能说清现在打的是哪个 host）。
  // errorHints 只留在内部参与 hint 计算，publicCard 不透传，不会进任何响应。
  if (source.region !== undefined) card.region = source.region
  // 识别依据随卡下发：前端 tooltip 要能说"这张卡是按 api.moonshot.cn 自动认出来的"。
  if (source.detected !== undefined) card.detected = source.detected
  if (isPlainObject(source.errorHints)) card.errorHints = source.errorHints
  if (source.type === 'rpc' && (typeof source.action !== 'string' || typeof source.version !== 'string')) {
    card.error = '数据源缺少 action/version'
    card.errorCode = 'BadSource'
    return finalizeCard(card)
  }
  // Bearer 门：Cookie 型源（有 cookieRef）不适用——它的凭据走另一条解析链，
  // 在这儿拦只会把"去配 Key"的错误提示扣在明明配好了 Cookie 的用户头上。
  const cookieBased = typeof source.cookieRef === 'string' && source.cookieRef !== ''
  if (source.type === 'http' && !cookieBased && typeof source.bearerRef === 'string' && source.bearerRef !== '' && source._bearer === undefined) {
    card.error = `未配置凭据 ${source.bearerRef}（往 ~/.dsh/.credentials.yaml 的 refs 加一行，或设同名环境变量）`
    card.errorCode = 'NoCredentials'
    card.hint = hintFor(card.errorCode, source.errorHints)
    return finalizeCard(card)
  }
  if (source.builder === 'token-plan-console') {
    if (typeof source._cookie !== 'string' || source._cookie === '') {
      card.error = `未配置控制台 Cookie（${source.cookieRef ?? 'BAILIAN_CONSOLE_COOKIE'}）：打开订阅页 → F12 Network → 复制任一请求的 Cookie 头存进凭据`
      card.errorCode = 'NoCredentials'
      card.hint = hintFor(card.errorCode, source.errorHints)
      return finalizeCard(card)
    }
    try {
      const probe = await resolveConsoleSecToken(config, source, source._cookie)
      const secToken = probe.secToken
      const usage = await callConsoleGateway(config, source, source._cookie, 'usage', secToken, probe)
      let quota = null
      let subscription = null
      // 两次调用**各自**兜底：quota-config 实测 5 次里会超时 1 次（docs/upstream-contracts.md）——
      // 共用一个 try 会让它把 subscription 一起拖下水（specCode / 套餐到期日全丢），
      // 而且"超时"与"Cookie 失效 / 字段改名"会混成同一个 denominatorFailed，没人查得下去。
      let quotaError
      let subscriptionError
      try {
        quota = await callConsoleGateway(config, source, source._cookie, 'quota-config', secToken, probe)
      } catch (error) {
        quotaError = error instanceof SourceError ? error.code : (error instanceof Error ? error.message : String(error))
      }
      try {
        subscription = await callConsoleGateway(config, source, source._cookie, 'subscription', secToken, probe)
      } catch (error) {
        subscriptionError = error instanceof SourceError ? error.code : (error instanceof Error ? error.message : String(error))
      }
      Object.assign(card, buildConsoleCard(source, usage, quota, subscription))
      if (quotaError !== undefined || subscriptionError !== undefined) {
        card.extra = { ...(card.extra ?? {}), quotaError, subscriptionError }
      }
      if (config.debug) card.shape = configlessTrim({ usage, quota, subscription })
    } catch (error) {
      card.error = error instanceof Error ? error.message : String(error)
      card.errorCode = error instanceof SourceError ? error.code : 'Error'
      card.hint = hintFor(card.errorCode, source.errorHints)
      if (config.debug && error instanceof SourceError && typeof error.raw === 'string') card.raw = error.raw.slice(0, 2000)
    }
    return finalizeCard(card)
  }
  try {
    const pages = []
    if (source.paginate?.mode === 'token') {
      let token
      for (let page = 0; page < 10; page += 1) {
        const params = { ...source.params }
        if (token !== undefined) params[source.paginate.request] = token
        const payload = source.type === 'http' ? await callHttp(config, { ...source, params }) : await callRpc(config, credentials, { ...source, params })
        pages.push(payload)
        token = pickString(payload, source.paginate.response)
        if (token === undefined || token === '') break
      }
    } else {
      const pageSizeKey = source.paginate?.pageSize ?? 'PageSize'
      const pageSize = Number(source.params?.[pageSizeKey] ?? 0)
      const maxPages = source.paginate?.mode === 'page' && pageSize > 0 ? 10 : 1
      for (let page = 1; page <= maxPages; page += 1) {
        const params = { ...source.params }
        if (source.paginate?.mode === 'page') params[source.paginate.request] = page
        const payload = source.type === 'http' ? await callHttp(config, { ...source, params }) : await callRpc(config, credentials, { ...source, params })
        pages.push(payload)
        const total = toNumber(pickFirst(payload, source.paginate?.total ?? []))
        if (total === undefined || page * pageSize >= total) break
      }
    }
    const merged = mergePages(pages, source)
    const built = source.kind === 'list'
      ? buildListCard(source, merged)
      : source.builder === 'deepseek-balance'
        ? buildDeepseekCard(source, merged)
        : buildSingleCard(source, merged)
    Object.assign(card, built)
    if (config.debug) card.shape = configlessTrim(merged)
  } catch (error) {
    card.error = error instanceof Error ? error.message : String(error)
    card.errorCode = error instanceof SourceError ? error.code : 'Error'
    card.hint = hintFor(card.errorCode, source.errorHints)
    if (config.debug && error instanceof SourceError && typeof error.raw === 'string') card.raw = error.raw.slice(0, 2000)
  }
  return finalizeCard(card)
}

function mergePages(pages, source) {
  if (pages.length <= 1) return pages[0] ?? {}
  const merged = { ...pages[0] }
  for (const path of source.list) {
    const head = pickPath(merged, path)
    if (!Array.isArray(head)) continue
    for (const page of pages.slice(1)) {
      const more = pickPath(page, path)
      if (Array.isArray(more)) head.push(...more)
    }
  }
  return merged
}

async function resolveCredentials(config, ctx) {
  const idHit = await resolveSecret(config.accessKeyIdRef, config, ctx)
  const secretHit = await resolveSecret(config.accessKeySecretRef, config, ctx)
  const tokenHit = config.securityTokenRef === undefined || config.securityTokenRef === null
    ? undefined
    : await resolveSecret(config.securityTokenRef, config, ctx)
  if (idHit === undefined || secretHit === undefined) {
    const missing = [idHit === undefined ? config.accessKeyIdRef : null, secretHit === undefined ? config.accessKeySecretRef : null].filter(Boolean)
    return { configured: false, missing, reason: `缺少凭据 ${missing.join(' / ')}` }
  }
  return {
    configured: true,
    accessKeyId: idHit.value,
    accessKeySecret: secretHit.value,
    securityToken: tokenHit?.value,
    masked: maskSecret(idHit.value),
    from: { accessKeyId: idHit.source, accessKeySecret: secretHit.source },
  }
}

const state = { inflight: null, calls: 0, errors: 0, lastAttemptAt: null, sources: new Map(), lastSnapshot: null }

async function cachedSourceCard(source, config, credentials, fresh) {
  const hit = state.sources.get(source.id)
  if (!fresh && hit !== undefined && Date.now() - hit.at < config.cacheMs) return hit.card
  state.calls += 1
  const card = await querySource(source, config, credentials)
  if (card.error !== null) state.errors += 1
  state.sources.set(source.id, { at: Date.now(), card })
  return card
}

/**
 * 状态快照：官方数据源卡吃 TTL 缓存；本实例实测块每次实时重算。
 */
async function buildStatus(config, ctx, { fresh = false } = {}) {
  // 并发一律共享同一次计算（含 fresh）：这是有意的限流纪律，test/host.mjs 的
  // 「并发共享同一次计算」钉着它——代价是"轮询在飞时点刷新"会拿到那一轮的结果，
  // 要改这条得连同那个契约一起改，属产品决策，不在审查修复范围内。
  if (state.inflight !== null) return await state.inflight.promise
  const holder = { promise: null }
  state.inflight = holder
  try {
    holder.promise = computeStatus(config, ctx, fresh)
    return await holder.promise
  } finally {
    if (state.inflight === holder) state.inflight = null
  }
}

/**
 * probe 路由专用的源查找。
 *
 * 零配置安装的源（比如 token-plan-console）不在配置文件里，而是 `computeStatus` 跑
 * `applyAutoDetect` 时现挂到那份 config 上的；路由每次都从 `getConfig()` 拿一份新配置，
 * 所以直接查必然 `unknown-source` —— 2026-09-23 诊断"月度账期"时就是这样：唯一能看上游
 * 字段集的入口，对唯一需要它的源永远 404，把人逼去开 debug。
 * 查不到就补跑一次检测再查（只做本地解析与凭据探测，不打额度端点，同名去重、可重入）。
 */
export async function findProbeSource(config, ctx, id, detect = applyAutoDetect) {
  const sources = Array.isArray(config?.sources) ? config.sources : []
  const direct = sources.find(source => source.id === id)
  if (direct !== undefined) return direct
  await detect(config, ctx)
  return sources.find(source => source.id === id)
}

async function computeStatus(config, ctx, fresh) {
  const cards = []
  const notices = []
  // 零配置：先按宿主在用的供应商路由补齐数据源（只做本地解析与凭据探测，不打额度端点）。
  const detection = await applyAutoDetect(config, ctx)
  // 退回原因只在 debug 下说话：老宿主每次快照都冒一句"检测没跑起来"是噪声，
  // 而 detection.reason 本来就在快照里，要查随时查得到。
  if (config.debug && detection.enabled === false && detection.reason !== null && !detection.reason.startsWith('autoDetect=false')) {
    notices.push(`自动检测没跑起来：${detection.reason}`)
  }
  // 打开 allowUndeclaredHosts 就不再有"声明集合 == 实际出站集合"这条保证，必须出声（别静默降级）。
  if (config.allowUndeclaredHosts === true) {
    notices.push('allowUndeclaredHosts 已打开：出站主机不再受 dshhub.permissions.network 约束（自定义源场景）。')
  }
  let credentials = { configured: false, missing: null }
  if (config.showInstanceWindow) cards.push(finalizeCard(buildInstanceCard(config)))
  // 窗口卡纯本地账本，不打网络、不进 TTL 缓存。
  const windowSources = config.sources.filter(source => source.kind === 'window')
  for (const source of windowSources) cards.push(finalizeCard(buildWindowCard(source, config)))
  const remoteSources = config.sources.filter(source => source.kind !== 'window')
  if (remoteSources.length > 0) {
    credentials = await resolveCredentials(config, ctx)
    for (const source of remoteSources) {
      let perQuery = source
      if (source.builder === 'token-plan-console') {
        perQuery = {
          ...source,
          _cookie: (await resolveSecret(source.cookieRef ?? 'BAILIAN_CONSOLE_COOKIE', config, ctx))?.value,
          _secToken: typeof source.secTokenRef === 'string' && source.secTokenRef !== ''
            ? (await resolveSecret(source.secTokenRef, config, ctx))?.value
            : undefined,
        }
      } else if (source.type === 'http' && typeof source.bearerRef === 'string' && source.bearerRef !== '') {
        perQuery = { ...source, _bearer: (await resolveSecret(source.bearerRef, config, ctx))?.value }
      }
      cards.push(await cachedSourceCard(perQuery, config, credentials, fresh))
    }
  }
  const official = cards.filter(card => card.veracity === 'verified' && (card.remaining !== undefined || card.total !== undefined))
  if (official.length === 0) {
    notices.push('当前没有官方额度源返回数据：核对 .credentials.yaml 里的 Key 与 sources 配置（可用 /token-plan-quota/probe?source=<id> 看上游原始响应）。')
  }
  const snapshot = {
    generatedAt: Date.now(),
    refreshMinutes: Math.round(config.cacheMs / 60_000),
    pollSeconds: Math.max(5, Number(config.pollSeconds) || 30),
    endpoint: config.endpoint,
    credentials: credentials.configured === true
      ? { configured: true, accessKeyId: credentials.masked, from: credentials.from, missing: null }
      : { configured: false, accessKeyId: null, from: null, missing: credentials.missing ?? null },
    config: {
      file: config.fileConfig.path,
      fileExists: config.fileConfig.exists,
      fileError: config.fileConfig.error,
      debug: config.debug,
      showInstanceWindow: config.showInstanceWindow,
      panelScope: config.panelScope,
      // 徽标小窗据此决定是否显示「用量统计」按钮；路径与天数上界不进 summary。
      usageStats: config.usageStats !== false,
      sources: config.sources.map(source => ({
        id: source.id,
        label: source.label,
        kind: source.kind ?? 'single',
        type: source.type,
        action: source.action ?? null,
        version: source.version ?? null,
        params: source.params ?? {},
        keywords: source.keywords,
        providers: source.providers ?? [],
        region: source.region ?? null,
        detected: source.detected ?? null,
        windowDays: source.windowDays ?? null,
        sourceNote: source.sourceNote ?? null,
      })),
    },
    stats: { calls: state.calls, errors: state.errors, lastAttemptAt: state.lastAttemptAt },
    throughput: throughputSnapshot(),
    // 自动检测的诊断：一眼回答"这家为什么没显示"（在用路由 / 开了什么 / 为什么跳过 / 谁没被认出）。
    detection,
    notices,
    cards: cards.map(publicCard),
  }
  state.lastSnapshot = snapshot
  state.lastAttemptAt = snapshot.generatedAt
  return snapshot
}

function publicCard(card) {
  const out = {}
  for (const key of [
    'id', 'label', 'labelEn', 'metric', 'unit', 'monthKey',
    'remaining', 'total', 'used', 'usedPercent', 'remainingPercent', 'expiresAt', 'updatedAt',
    'meters',
    'itemCount', 'hiddenCount', 'items', 'otherUnits', 'extra', 'calls', 'tokens',
    'window', 'retry', 'veracity', 'sourceNote', 'error', 'errorCode', 'hint', 'emptyReason', 'shape', 'raw',
    'estimated', 'bindProviders', 'windowDays', 'startedAt', 'resetAt', 'remainingDays', 'region', 'detected',
  ]) {
    if (card[key] !== undefined) out[key] = card[key]
  }
  return out
}

function summarizeText(snapshot) {
  const lines = [`查询时间 ${new Date(snapshot.generatedAt).toLocaleString('zh-CN')}（缓存 ${snapshot.refreshMinutes} 分钟）`]
  for (const notice of snapshot.notices) lines.push(`提示：${notice}`)
  for (const card of snapshot.cards) {
    if (card.veracity !== 'verified') continue
    if (typeof card.error === 'string' && card.error !== '') {
      lines.push(`${card.label}：${card.error}${card.hint ? ` — 提示：${card.hint}` : ''}`)
      continue
    }
    if (card.remaining === undefined && card.total === undefined) {
      // 有官方比例、没取到档位额度：报比例，不编绝对余量（原则 I v2.0.0）。
      if (typeof card.usedPercent === 'number') {
        lines.push(`${card.label}：本周期已用 ${card.usedPercent}%（上游直接返回的比例；档位额度这一路未取到，故不报绝对剩余量）`)
        continue
      }
      lines.push(`${card.label}：无数据${card.emptyReason ? `（${card.emptyReason}）` : ''}`)
      continue
    }
    const head = card.metric === 'money'
      ? `${formatMoneyText(card.remaining)} ${card.unit || ''}${card.extra?.toppedUp !== undefined ? `（充值 ${formatMoneyText(card.extra.toppedUp)}，赠款 ${formatMoneyText(card.extra.granted)}）` : ''}${card.extra?.cash !== undefined ? `（现金 ${formatMoneyText(card.extra.cash)}，信控 ${formatMoneyText(card.extra.credit)}）` : ''}`
      : `剩余 ${formatAmount(card.remaining)} / ${formatAmount(card.total)} ${card.unit ?? ''}${typeof card.usedPercent === 'number' ? `，已用 ${card.usedPercent}%` : ''}`
    lines.push(`${card.label}：${head}`)
  }
  const officialNumbered = new Set()
  for (const card of snapshot.cards) {
    if (card.veracity !== 'verified' || card.error) continue
    // 判据保持"官方卡有绝对数字才算有数"：退化态（只有比例）下实测账本那行仍然照报，
    // 与前端 dropShadowedMeasured 的既有行为一致——两半边不一致比多印一行更糟。
    if (typeof card.remaining !== 'number' && typeof card.total !== 'number') continue
    for (const provider of card.bindProviders ?? []) officialNumbered.add(provider)
  }
  for (const card of snapshot.cards.filter(item => item.estimated === true && typeof item.tokens === 'number')) {
    // 与前端同一规则：官方真值有数时，自动检测挂的实测兜底行不再重复报（用户手写的照旧）。
    if (card.detected?.fallback === true && (card.bindProviders ?? []).some(provider => officialNumbered.has(provider))) continue
    lines.push(`${card.label}（本实例实测，非官方余量）：${card.windowDays ?? 7} 天窗口内 ${formatAmount(card.tokens)} tokens / ${card.calls} 次${typeof card.remainingDays === 'number' ? `，距重置约 ${card.remainingDays} 天` : ''}`)
  }
  const instance = snapshot.cards.find(card => card.id === 'instance-usage')
  if (instance !== undefined) {
    const window = instance.window
    lines.push(`本实例实测（非官方额度）：本月 ${formatAmount(instance.tokens)} tokens / ${instance.calls} 次；近 60 秒 ${formatAmount(window.tpm60)} tokens / ${window.calls60} 次（缓存读 ${formatAmount(window.cacheRead60)}）`)
    for (const row of instance.retry ?? []) {
      const fixed = row.fixedDelayMs !== undefined ? `固定 ${Math.round(row.fixedDelayMs / 1000)} 秒` : `退避 ${row.mode}`
      lines.push(`自动重试观测 ${row.provider}：${row.attempts} 次（最近 delay=${row.lastDelayMs}ms），QUOTA 可重试=${row.quotaRetryable ? '是' : '否'}，间隔=${fixed}${row.abandoned > 0 ? `，放弃 ${row.abandoned} 次` : ''}`)
    }
  }
  const tp = snapshot.throughput
  if (tp !== undefined && tp.calls300 > 0) {
    lines.push(`吞吐观测：近 60 秒 ${formatAmount(tp.tpm60)} tokens（含缓存读）；生成速度（输出 tokens）近 60 秒 ${formatAmount(tp.outTps60)} tok/s，近 5 分钟 ${tp.genTps !== null && tp.genTps !== undefined ? `${formatAmount(tp.genTps)} tok/s` : '?'}（活跃 ${tp.activeSeconds} 秒，${tp.calls300} 次调用）`)
    for (const row of tp.byProvider.slice(0, 4)) {
      lines.push(`按供应商 ${row.provider}${row.model ? `（最近 ${row.model}）` : ''}：${row.genTps !== null && row.genTps !== undefined ? `${formatAmount(row.genTps)} tok/s` : '无活跃秒数据'}，近 5 分钟 ${formatAmount(row.tokens300)} tokens / ${row.calls300} 次`)
    }
  }
  return lines.join('\n')
}

function formatMoneyText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(2)} 万`
  return abs >= 100 ? String(Math.round(value)) : String(Math.round(value * 100) / 100)
}

/* ==================================================== HTTP 路由 */

function sameOriginOnly(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/* ==================================================== 模型工具 */

/**
 * 工具返回值会由宿主按「无损 JSON」深走一遍再冻结：显式的 `undefined` 属性、
 * 稀疏数组、循环引用，以及 NaN / ±Infinity / -0 都会让**整条结果**被拒收
 * （判定见 @deepseek-ai/dsh-util-values 的 walkJsonValue，越界即报
 * "value is not lossless JSON"）。本卡片的字段天生大量缺席（`estimated`
 * 只在为真时才该存在），所以跨界前先整形：丢字段，而不是丢整条结果。
 */
function toToolJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    const list = []
    for (const item of value) list.push(toToolJson(item, seen) ?? null)
    seen.delete(value)
    return list
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const kept = toToolJson(item, seen)
    if (kept !== undefined) out[key] = kept
  }
  seen.delete(value)
  return out
}

/** 工具侧参数错误文本：只给用户能修的固定短句，不回显宿主原文。 */
function usageParamErrorText(failure, args) {
  if (failure.error === 'usage-range-too-long') return '查询跨度最多 ' + failure.maxDays + ' 天'
  if (failure.error === 'usage-bad-month') return '月份不合法：用 YYYY-MM，且不能晚于当前月'
  const hasMonth = args?.month !== undefined && args.month !== null && String(args.month).trim() !== ''
  const hasFrom = args?.from !== undefined && args.from !== null && String(args.from).trim() !== ''
  const hasTo = args?.to !== undefined && args.to !== null && String(args.to).trim() !== ''
  if (hasMonth && (hasFrom || hasTo)) return 'month 不能与 from/to 同时使用'
  return '起止日期不合法：用 YYYY-MM-DD，且起点不晚于终点、不晚于今天'
}

function buildQuotaTool(getConfig, ctx) {
  return {
    name: 'token_plan_quota',
    description: [
      '查询官方额度/余额（DeepSeek /user/balance、可选的阿里云 BssOpenApi），',
      '外加千问 Token Plan 的本实例实测 7 天窗口（非官方余量）。',
      'action=status 读缓存快照；action=refresh 强制回源（上游有 QPS 限制，别连续刷）；',
      'action=reset 清零本实例实测用量统计（含窗口锚点）；',
      'action=usage 读本实例按本地日聚合的 token 用量（离线，不联网）；',
      'action=usage-official 读官方账号级 tokens（Token Plan 用量明细，联网，含其他设备）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'refresh', 'reset', 'usage', 'usage-official'], description: 'status 读缓存（默认），refresh 回源，reset 清本实例用量，usage 读本实例用量统计（1..365 天），usage-official 读官方账号级 tokens。' },
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'action=usage / usage-official 时看近几天（默认 7；today=1）。' },
        from: { type: 'string', description: 'action=usage / usage-official 时按起止日期查询（YYYY-MM-DD，含两端）；与 to 同时出现时忽略 days。' },
        to: { type: 'string', description: 'action=usage / usage-official 的结束日期（YYYY-MM-DD，含当天；晚于今天会夹到今天）。' },
        month: { type: 'string', description: 'action=usage / usage-official 时按自然月查询（YYYY-MM，含 1 号至月末；当前月截止到今天）；与 from/to 不能同时出现。' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }] },
    timeoutMs: 120_000,
    async execute(args) {
      const config = getConfig()
      if (args?.action === 'usage') {
        const usage = toToolJson(buildUsageSnapshot(config, ctx, { days: args?.days, from: args?.from, to: args?.to, month: args?.month }))
        if (usage?.error !== undefined) {
          const text = usageParamErrorText(usage, args)
          const failure = { ok: false, text, error: usage.error }
          if (usage.maxDays !== undefined) failure.maxDays = usage.maxDays
          return toToolJson(failure)
        }
        return toToolJson({ ok: true, text: summarizeUsageText(usage), usage: usageForTool(usage) })
      }
      if (args?.action === 'usage-official') {
        const official = await buildOfficialUsageSnapshot(config, ctx, { days: args?.days, from: args?.from, to: args?.to, month: args?.month })
        if (official?.paramError === true) {
          const text = usageParamErrorText(official, args)
          const failure = { ok: false, text, error: official.error }
          if (official.maxDays !== undefined) failure.maxDays = official.maxDays
          return toToolJson(failure)
        }
        if (official?.error !== undefined) {
          return toToolJson({ ok: false, text: official.hint ?? '官方用量明细暂不可用', error: official.error, code: official.code })
        }
        const trimmed = { range: official.range, totals: official.totals, coverage: official.coverage, source: official.source }
        return toToolJson({ ok: true, text: summarizeOfficialText(official), official: trimmed })
      }
      if (args?.action === 'reset') resetCurrentMonthUsage(config, ctx)
      const snapshot = await buildStatus(config, ctx, { fresh: args?.action === 'refresh' || args?.action === 'reset' })
      return toToolJson({
        ok: true,
        text: summarizeText(snapshot),
        cards: snapshot.cards
          .filter(card => card.veracity === 'verified' || card.estimated === true)
          .map(card => ({
            id: card.id,
            label: card.label,
            estimated: card.estimated === true || undefined,
            remaining: card.remaining,
            total: card.total,
            usedPercent: card.usedPercent,
            expiresAt: card.expiresAt,
            tokens: card.tokens,
            calls: card.calls,
            resetAt: card.resetAt,
            error: card.error,
          })),
      })
    },
  }
}

/* ==================================================== apply */

export const __internals = {
  DEFAULTS,
  toToolJson,
  buildQuotaTool,
  PRESETS,
  effectiveConfig,
  normalizeSources,
  applyAutoDetect,
  findProbeSource,
  warnUnboundSources,
  unboundWarned,
  readRouteProfile,
  credentialRefsFor,
  percentEncode,
  signRpcParams,
  flattenParams,
  utcTimestamp,
  parseEnvelope,
  rpcEnvelopeOk,
  httpEnvelopeOk,
  pickPath,
  pickFirst,
  pickString,
  toNumber,
  toEpochMs,
  buildListCard,
  buildSingleCard,
  evalDerive,
  buildDeepseekCard,
  buildWindowCard,
  buildConsoleCard,
  cookieValue,
  providerModelTotals,
  touchWindow,
  windowSpanDays,
  finalizeCard,
  finalizeMeter,
  mergePages,
  hintFor,
  formatAmount,
  formatMoneyText,
  summarizeText,
  publicCard,
  querySource,
  buildStatus,
  invalidateSources,
  resolveSecret,
  maskSecret,
  redactSecrets,
  cookieNames,
  jsonKeyShape,
  configlessTrim,
  SourceError,
  DECLARED_HOSTS,
  assertDeclaredHost,
  sameOriginOnly,
  parsePolicyKey,
  slidingWindow,
  throughputSnapshot,
  retrySnapshot,
  observeRetryEvent,
  observeAbandoned,
  observeStream,
  recordUsage,
  buildInstanceCard,
  usageLedger,
  recentCalls,
  retryWatch,
  resetInstanceState,
  hardResetUsage,
  flushUsage,
  resetCurrentMonthUsage,
  emptyUsageIndex,
  dayKey,
  foldUsageEvents,
  aggregateUsageRange,
  resolveCustomRange,
  resolveMonthRange,
  loadUsageIndex,
  saveUsageIndex,
  trimUsageIndex,
  syncUsageIndex,
  decodeSessionLog,
  parseSessionEvents,
  fallbackCutOf,
  fallbackLogsOf,
  fallbackSignature,
  ensureUsageIndexLoaded,
  FALLBACK_SCAN_BUDGET,
  buildUsageSnapshot,
  buildOfficialUsageSnapshot,
  buildCreditsTokenSnapshot,
  creditsCycleOf,
  creditsTokenRatioOf,
  creditsClassRatios,
  creditsModelRatios,
  composeCreditsToken,
  resolveOfficialRange,
  officialFailureOf,
  officialCache,
  summarizeOfficialText,
  sliceOfficialRange,
  parseOfficialEnvelope,
  foldOfficialSeries,
  buildOfficialUsage,
  mergeOfficialDays,
  officialChunkRequest,
  officialEarliestDayKey,
  officialErrorHint,
  runUsageSync,
  liveUsageDays,
  get usageIndex() { return usageIndex },
  get usageSyncResult() { return usageSyncResult },
  state,
}

function invalidateSources() {
  state.sources.clear()
}

/**
 * 宿主插件体。
 * @param ctx - Cordis 上下文（webServer 硬依赖，tools / credentials 可选）。
 * @param rowConfig - 插件行 config。
 */
export function apply(ctx, rowConfig) {
  let currentRow = rowConfig
  const getConfig = () => effectiveConfig(currentRow, ctx)

  ctx.effect(() => {
    currentRow = rowConfig
    invalidateSources()
    return () => {}
  }, 'token-plan-quota: config')

  // 观测 llm/stream：只记账（本实例实测 tokens），绝不折算、不估算任何余额。
  ctx.on('llm/stream', function (options, next) {
    const stream = next()
    const config = getConfig()
    const provider = String(options?.provider ?? '?')
    const model = String(options?.model ?? '?')
    lastProvider = provider
    return observeStream(stream, (usage, meta) => {
      try {
        recordUsage(config, provider, model, usage, Date.now(), meta)
      } catch (error) {
        ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })

  // 观测自动重试与最终放弃（llm/retry / turn/end 持久事件）。
  ctx.on('session/event', (_session, event) => {
    try {
      if (event?.type === 'llm/retry') {
        observeRetryEvent({ ...event.data, time: event.time ?? event.time0 })
      } else if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
        const error = event.data.reason.error
        const code = typeof error?.code === 'string' ? error.code : undefined
        if (code === 'QUOTA' || code === 'RATE_LIMIT') observeAbandoned(lastProvider, code)
      }
    } catch (error) {
      ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
    }
  })

  ctx.effect(() => () => {
    flushUsage(ctx)
    flushUsageIndexWrite(ctx)
  }, 'token-plan-quota: usage flush')

  // 006 用量索引：首轮 20s 后回填（避开宿主启动高峰），之后每 5 分钟增量同步。
  // usageStats=false 时什么都不启动；dispose 时两个 timer 都清掉。
  ctx.effect(() => {
    if (getConfig().usageStats === false) return () => {}
    const first = setTimeout(() => { void runUsageSync(ctx, getConfig()) }, USAGE_SYNC_FIRST_DELAY_MS)
    const interval = setInterval(() => { void runUsageSync(ctx, getConfig()) }, USAGE_SYNC_INTERVAL_MS)
    first.unref?.()
    interval.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, 'token-plan-quota: usage sync timers')

  // 只读路由。
  ctx.effect(() => {
    const server = ctx.get('webServer')
    if (server === undefined) return () => {}
    try {
      return server.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        async handler(req, res) {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
          if (req.method !== 'GET' && !(req.method === 'POST' && (sub === 'refresh' || sub === 'summary' || sub === 'reset'))) {
            json(res, 405, { error: 'method-not-allowed' })
            return
          }
          if (!sameOriginOnly(req)) {
            json(res, 403, { error: 'cross-origin-denied' })
            return
          }
          const config = getConfig()
          try {
            if (sub === '' || sub === 'summary') {
              json(res, 200, await buildStatus(config, ctx, { fresh: url.searchParams.get('fresh') === '1' || req.method === 'POST' }))
              return
            }
            if (sub === 'refresh') {
              json(res, 200, await buildStatus(config, ctx, { fresh: true }))
              return
            }
            if (sub === 'reset') {
              resetCurrentMonthUsage(config, ctx)
              json(res, 200, await buildStatus(config, ctx, { fresh: true }))
              return
            }
            if (sub === 'usage') {
              // 只读：GET /token-plan-quota/usage?days=7 或 ?range=7d|30d|90d|today。
              // 快照本身是纯计算，但异常时也不能把宿主 error.message 回给浏览器：客户端会
              // 原样显示在面板里，而 message 可能带索引文件路径或底层细节（INTERFACE §2）。
              try {
                const usage = buildUsageSnapshot(config, ctx, {
                  range: url.searchParams.get('range') ?? undefined,
                  days: url.searchParams.get('days') ?? undefined,
                  from: url.searchParams.get('from') ?? undefined,
                  to: url.searchParams.get('to') ?? undefined,
                  month: url.searchParams.get('month') ?? undefined,
                })
                if (usage?.error !== undefined) {
                  // 007 §2：参数错误回 400 固定码；maxDays 只在跨度超限时带上（客户端据此本地化）。
                  json(res, 400, usage.maxDays === undefined
                    ? { error: usage.error }
                    : { error: usage.error, maxDays: usage.maxDays })
                  return
                }
                json(res, 200, usage)
              } catch (error) {
                ctx.logger?.warn?.(new Error('token-plan-quota: 用量快照构建失败 —— ' + (error instanceof Error ? error.message : String(error))))
                json(res, 500, { error: 'usage-unavailable' })
              }
              return
            }
            if (sub === 'usage-official') {
              // 008：官方账号侧 tokens（账号级，含别的设备）。只读 GET；参数错误与 /usage 同码同形。
              // 仅当"官方这次挂了"才回 200 + 固定 code：那一格挂掉不该把本机用量一起变成错误页。
              try {
                const official = await buildOfficialUsageSnapshot(config, ctx, {
                  range: url.searchParams.get('range') ?? undefined,
                  days: url.searchParams.get('days') ?? undefined,
                  from: url.searchParams.get('from') ?? undefined,
                  to: url.searchParams.get('to') ?? undefined,
                  month: url.searchParams.get('month') ?? undefined,
                }, { fresh: url.searchParams.get('fresh') === '1' })
                if (official?.paramError === true) {
                  json(res, 400, official.maxDays === undefined
                    ? { error: official.error }
                    : { error: official.error, maxDays: official.maxDays })
                  return
                }
                json(res, 200, official)
              } catch (error) {
                ctx.logger?.warn?.(new Error('token-plan-quota: 官方用量明细构建失败 —— ' + (error instanceof Error ? error.message : String(error))))
                json(res, 500, { error: 'official-unavailable' })
              }
              return
            }
            if (sub === 'usage-credits') {
              // 014：Credits ↔ tokens 换算。只读；官方失败一律回 200 + available:false，
              // 让客户端能按 reason 分状态展示，而不是把整块变成错误页（INTERFACE §1）。
              try {
                const credits = await buildCreditsTokenSnapshot(config, ctx, { fresh: url.searchParams.get('fresh') === '1' })
                json(res, 200, credits)
              } catch (error) {
                ctx.logger?.warn?.(new Error('token-plan-quota: Credits 换算构建失败 —— ' + (error instanceof Error ? error.message : String(error))))
                json(res, 500, { error: 'credits-unavailable' })
              }
              return
            }
            if (sub === 'probe') {
              const id = url.searchParams.get('source') ?? ''
              const source = await findProbeSource(config, ctx, id)
              if (source === undefined) {
                json(res, 404, { error: 'unknown-source', known: config.sources.map(item => item.id) })
                return
              }
              const credentials = await resolveCredentials(config, ctx)
              try {
                if (source.builder === 'token-plan-console') {
                  const cookie = (await resolveSecret(source.cookieRef ?? 'BAILIAN_CONSOLE_COOKIE', config, ctx))?.value
                  if (typeof cookie !== 'string' || cookie === '') {
                    json(res, 200, { source: source.id, api: 'usage', error: 'NoCredentials', hint: hintFor('NoCredentials') })
                    return
                  }
                  const explicit = typeof source.secTokenRef === 'string' && source.secTokenRef !== ''
                    ? (await resolveSecret(source.secTokenRef, config, ctx))?.value
                    : undefined
                  const secProbe = await resolveConsoleSecToken({ ...config, debug: true }, { ...source, _secToken: explicit }, cookie)
                  const usage = await callConsoleGateway({ ...config, debug: true }, source, cookie, 'usage', secProbe.secToken, secProbe)
                  // 结构化 raw 也要带凭据进脱敏：键名黑名单挡得住"键名叫 sec_token"的形态，
                  // 挡不住"值里回显了凭据、键名却是上游自取的"（CodeRabbit PR #3 指出）。
                  json(res, 200, { source: source.id, api: 'usage', keys: Object.keys(usage), shape: configlessTrim(usage, 0, [cookie, resolved]) })
                  return
                }
                // Bearer 型源（DeepSeek / Moonshot / OpenRouter）在 probe 下也要注入密钥：
                // `_bearer` 原先只在 computeStatus 里挂，probe 带着空鉴权打过去，对每一家都回 401 ——
                // 而 probe 正是"看上游原始字段集"的唯一入口，这会把人引去怀疑自己的 Key。
                if (source.type === 'http' && typeof source.bearerRef === 'string' && source.bearerRef !== '') {
                  const bearer = (await resolveSecret(source.bearerRef, config, ctx))?.value
                  if (typeof bearer !== 'string' || bearer === '') {
                    json(res, 200, { source: source.id, api: 'probe', error: 'NoCredentials', hint: hintFor('NoCredentials'), ref: source.bearerRef })
                    return
                  }
                  const payload = await callHttp({ ...config, debug: true }, { ...source, _bearer: bearer })
                  json(res, 200, { source: source.id, action: source.action ?? null, keys: Object.keys(payload), shape: configlessTrim(payload, 0, [bearer]) })
                  return
                }
                const payload = source.type === 'http'
                  ? await callHttp({ ...config, debug: true }, source)
                  : await callRpc({ ...config, debug: true }, credentials, source)
                json(res, 200, { source: source.id, action: source.action ?? null, keys: Object.keys(payload), shape: configlessTrim(payload, 0, [credentials?.accessKeyId, credentials?.accessKeySecret, credentials?.securityToken]) })
              } catch (error) {
                json(res, 200, {
                  source: source.id,
                  action: source.action ?? null,
                  error: error instanceof Error ? error.message : String(error),
                  code: error instanceof SourceError ? error.code : null,
                  raw: error instanceof SourceError ? error.raw : null,
                })
              }
              return
            }
            json(res, 404, { error: 'not-found', routes: ['summary', 'refresh', 'reset', 'probe', 'usage', 'usage-official', 'usage-credits'] })
          } catch (error) {
            ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)))
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
    } catch (error) {
      ctx.logger?.warn?.(new Error(`token-plan-quota: 路由注册失败，已跳过 —— ${error instanceof Error ? error.message : String(error)}`))
      return () => {}
    }
  }, 'token-plan-quota: routes')

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (tools === undefined || getConfig().exposeTool === false) return () => {}
    return tools.register(buildQuotaTool(getConfig, ctx))
  }, 'token-plan-quota: tool')
}
