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

export const name = 'token-plan-quota'

/** 硬依赖：没有 webServer（非 web profile）就没有意义，让 Cordis 等待比空转好。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/token-plan-quota'
const LEDGER_FILE = '$DSH_HOME/token-plan-quota.usage.json'

/** 默认配置；插件行 config 与 ~/.dsh/token-plan-quota.json 依次覆盖。 */
const DEFAULTS = {
  /** 数据源（按顺序显示）：DeepSeek 官方余额 + 千问 Token Plan 实测窗口；阿里云源需 AK/SK。 */
  sources: ['deepseek-balance', 'token-plan-window'],
  /** OpenAPI 接入点（阿里云费用中心用）。 */
  endpoint: 'business.aliyuncs.com',
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
}

/** 彻底重置（含“从未加载过账本”标记）——测试里模拟宿主重启后重新读盘。 */
function hardResetUsage() {
  resetInstanceState()
  usageLoaded = false
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
    label: 'Token Plan 实测',
    labelEn: 'Token Plan (measured)',
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
   * usage → per5Hour/per1Week 的已用比例与重置时刻；quota-config → 各窗口总额度。
   * 剩余 = weekly × (1 − per1WeekPercentage)——即订阅页「剩余量 65.1% / 总额度 10,000」同源。
   * Cookie 是强凭据：只从本地解析，绝不进任何路由响应；登录态过期需重贴。
   */
  /**
   * 千问 Token Plan 官方余量（控制台数据网关，Cookie 会话鉴权）。
   * 千问AI平台（platform-home.qianwenai.com）的接口契约按其前端包逆向核对：
   * 1. GET {infoUrl}（登录 Cookie）→ data.secToken（CSRF 令牌，全自动，无需手抄）；
   * 2. POST {url}?action=BroadScopeAspnGateway&product=sfm_bailian&api=<inner>，
   *    表单体 product/action/sec_token/region/params(JSON: Api+V+Data.cornerstoneParam)；
   *    usage → per1Week/per5Hour 已用比例与重置时刻；
   *    subscription → specCode（lite/standard/pro）；quota-config → 按档位的 weekly/five_hour 总额度。
   * 剩余 = quota[specCode].weekly × (1 − per1WeekPercentage)——订阅页「剩余量/总额度」同源。
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
    dashboardOrigin: 'https://platform-home.qianwenai.com',
    dashboardURL: 'https://platform-home.qianwenai.com/analytics/token-plan/individual',
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
    sourceNote: 'Moonshot 官方 API（Bearer Key）· GET /v1/users/me/balance —— 余额/现金/赠款真值；'
      + '大陆(.ai 之外)与国际两区 Key 不互通，区由 moonshotRegion 决定。',
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
  BailianNotAuthorised: '控制台网关要求登录会话：打开百炼订阅页 → F12 Network → 复制 api.json 请求的整行 Cookie → 存为 BAILIAN_CONSOLE_COOKIE。',
  'BailianGateway.Login.NotLogined': '这份 Cookie 未被配额域名认作已登录：多半抄错了请求。在 Network 筛选器输入 bailian-cs，复制 **bailian-cs.console.aliyun.com/data/api.json**（product=sfm_bailian）那条的 Cookie，且复制前在订阅页按 F5 刷新过；跨域请求的 Cookie 不通用。',
  PostonlyOrTokenError: '网关的 CSRF 校验没过：这个平台的 sec_token 不在 Cookie 里，要把请求「载荷」表单数据里的 sec_token 值单独抄下来，存成 BAILIAN_CONSOLE_SECTOKEN（页面刷新后它会变，过期就重抄）。',
  ConsoleApiError: '控制台网关业务失败：多半是 Cookie 过期或换号了，重新复制登录会话的 Cookie。',
  BadResponse: '上游返回非预期格式：登录态失效（控制台跳登录页）或接口改版，重新复制 Cookie 或开 debug 看原始响应。',
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
  merged.sources = normalizeSources(merged.sources, ctx, merged)
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
  for (const entry of entries) {
    const override = isPlainObject(entry) ? entry : {}
    const id = typeof entry === 'string' ? entry : String(override.id ?? override.action ?? override.url ?? 'source')
    const preset = PRESETS[id]
    if (preset === undefined && override.action === undefined && override.url === undefined && override.kind !== 'window') {
      ctx?.logger?.warn?.(new Error(`token-plan-quota: 未知数据源 "${id}"，已忽略（可用：${Object.keys(PRESETS).join(', ')}）`))
      continue
    }
    const source = { kind: 'single', ...(preset ?? {}), ...override, id }
    if (source.enabled === false) continue
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
  return out
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

async function throttle(minIntervalMs) {
  const wait = lastCallAt + minIntervalMs - Date.now()
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastCallAt = Date.now()
}

export class SourceError extends Error {
  constructor(code, message, source, raw) {
    super(`${source}: ${code} ${message}`)
    this.name = 'SourceError'
    this.code = code
    this.source = source
    this.raw = raw ?? null
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
  const text = await postForm(`https://${config.endpoint}/`, body, config.timeoutMs)
  return parseEnvelope(text, source.id, rpcEnvelopeOk)
}

/** `type:'http'` 源：直连给定 url（Bearer / Cookie / 自有 header）。 */
async function callHttp(config, source) {
  const url = String(source.url)
  if (!/^https?:\/\//.test(url)) throw new SourceError('BadUrl', '自定义 http 源的 url 必须以 http(s):// 开头', source.id)
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
    const detail = pickString(safeJson(text), ['error.message', 'message', 'msg', 'Message']) ?? ''
    throw new SourceError(String(response.status), `HTTP ${response.status}${detail === '' ? '' : ` · ${detail}`}`, source.id, text.slice(0, 600))
  }
  return parseEnvelope(text, source.id, httpEnvelopeOk)
}

/** 从 Cookie 串里取一个 cookie 值（sec_token、cna 等）。 */
function cookieValue(cookie, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(cookie ?? ''))
  return match === null ? undefined : match[1].trim()
}

/**
 * 控制台数据网关（BroadScopeAspnGateway）：POST form，params 内嵌 JSON。
 * apiName: 'usage' | 'quota-config' | 'subscription'。返回网关 DataV2 内层 data。
 * 浏览器同款 UA：这个网关的人机校验会挑自定义 UA 的毛病（PostonlyOrTokenError）。
 */
async function callConsoleGateway(config, source, cookie, apiName, secToken) {
  const apiPath = `${source.apiPrefix}/${apiName}`
  const params = {
    Api: apiPath,
    V: '1.0',
    Data: {
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
  if (!response.ok) throw new SourceError(String(response.status), `HTTP ${response.status}`, source.id, text.slice(0, 600))
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SourceError('BadResponse', '控制台返回了非 JSON（登录态多半失效，需重新复制 Cookie）', source.id, text.slice(0, 300))
  }
  if (/NotAuthorised|NotLogined/i.test(JSON.stringify(payload).slice(0, 500))) {
    const gatewayError = pickString(payload, ['data.errorCode', 'errorCode']) ?? 'BailianGateway.Login.NotLogined'
    throw new SourceError(gatewayError, pickString(payload, ['data.errorMsg', 'errorMsg']) ?? '控制台网关未接受这份登录会话 Cookie', source.id, configlessTrim(payload))
  }
  const code = pickString(payload, ['code']) ?? ''
  if (code !== '' && code !== '200' && payload?.successResponse !== true) {
    throw new SourceError(code, pickString(payload, ['message', 'msg']) ?? '网关未返回成功状态', source.id, configlessTrim(payload))
  }
  const inner = pickPath(payload, 'data.DataV2.data')
  if (isPlainObject(inner) && inner.success === false) {
    throw new SourceError('ConsoleApiError', pickString(inner, ['message', 'errorMsg']) ?? '网关业务失败', source.id, configlessTrim(payload))
  }
  const data = isPlainObject(inner?.data) ? inner.data : inner
  if (!isPlainObject(data)) throw new SourceError('BadResponse', '响应里找不到 DataV2 数据体（接口可能改版）', source.id, configlessTrim(payload))
  return data
}

/**
 * sec_token 自动获取：GET 控制台 /tool/user/info.json（登录 Cookie 即可），取 data.secToken。
 * 手配的 secTokenRef / Cookie 里的 sec_token 只作兜底。
 */
async function fetchConsoleSecToken(config, source, cookie) {
  if (typeof source.infoUrl !== 'string' || source.infoUrl === '') return undefined
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
    if (!response.ok) return undefined
    const payload = JSON.parse(await response.text())
    const token = pickString(payload, ['data.secToken', 'secToken'])
    return typeof token === 'string' && token !== '' ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * usage + subscription + quota-config（按档位）→ 官方余量卡（剩余 = 窗口额度 × (1 − 已用比例)）。
 *
 * **一个窗口只有在该账号真的回了读数时才成为一条计量**。`quota-config` 里躺着的 `five_hour`
 * 只是档位配置，不代表这个套餐有 5 小时窗口——2026-09-06 实测个人版 standard 的
 * `usage` 只回 `per1WeekPercentage`/`per1WeekResetTime`，此时若拿配置去拼一行
 * 「5 小时窗口 额度上限 3,000」，那是把配置噪声当额度显示给用户。
 */
function buildConsoleCard(source, usage, quota, subscription) {
  const weekRatio = toNumber(usage.per1WeekPercentage)
  const fiveRatio = toNumber(usage.per5HourPercentage)
  const specCode = pickString(subscription ?? {}, ['specCode', 'SpecCode']) ?? ''
  const specQuota = isPlainObject(quota) && specCode !== '' && isPlainObject(quota[specCode]) ? quota[specCode] : quota
  const weeklyTotal = toNumber(specQuota?.weekly)
  const fiveTotal = toNumber(specQuota?.fiveHour ?? specQuota?.five_hour)
  const addon = isPlainObject(quota?.addon_quota) ? toNumber(quota.addon_quota.extrabundle) : undefined
  const meters = []
  if (weekRatio !== undefined || weeklyTotal !== undefined) {
    meters.push({
      key: 'weekly',
      label: '7 天窗口',
      labelEn: '7-day window',
      unit: 'Credits',
      total: weeklyTotal,
      remaining: weeklyTotal !== undefined && weekRatio !== undefined
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
  // 顶层字段＝主计量（徽标与模型工具摘要只认顶层）：有 7 天用 7 天，否则退到第一条。
  const primary = meters.find(meter => meter.key === 'weekly') ?? meters[0]
  const card = {
    id: source.id,
    label: source.label,
    labelEn: source.labelEn,
    metric: source.metric ?? 'credits',
    unit: 'Credits',
    total: primary?.total,
    remaining: primary?.remaining,
    expiresAt: primary?.resetAt,
    items: [],
    meters,
    extra: {
      usedPercent: weekRatio !== undefined ? round(Math.min(1, weekRatio) * 100) : undefined,
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
    },
  }
  if (meters.length === 0) {
    card.emptyReason = '网关 usage 里没有 per1Week/per5Hour 比例（开 debug 看 shape；换套餐后字段集会不同）'
  } else if (card.remaining === undefined && card.total === undefined) {
    card.emptyReason = '识别到窗口但没有对应的档位额度（开 debug 核对 quota-config 字段名）'
  }
  return card
}

async function postForm(url, body, timeoutMs) {
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
    throw new SourceError(String(response.status), '鉴权被拒（检查 Key 权限与所属账号）', url, text.slice(0, 600))
  }
  return text
}

function parseEnvelope(text, sourceId, envelopeOk) {
  if (text === '') return {}
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new SourceError('BadResponse', '上游返回了非 JSON（可能被网关拦截或登录态失效）', sourceId, text.slice(0, 600))
  }
  const failure = envelopeOk(payload)
  if (failure !== undefined) throw new SourceError(failure.code, failure.message, sourceId, configlessTrim(payload))
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

function configlessTrim(payload, depth = 0) {
  if (depth > 3) return '…'
  if (Array.isArray(payload)) return payload.slice(0, 2).map(item => configlessTrim(item, depth + 1))
  if (isPlainObject(payload)) {
    const out = {}
    for (const [key, value] of Object.entries(payload)) {
      if (/accesskeyid|signature|securitytoken|cookie|authorization|api[-_]?key/i.test(key)) continue
      out[key] = value !== null && typeof value === 'object' ? configlessTrim(value, depth + 1) : typeof value === 'string' && value.length > 60 ? `${value.slice(0, 60)}…` : value
    }
    return out
  }
  return payload
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
    card.meters = card.meters
      .filter(meter => isPlainObject(meter))
      .map(meter => finalizeMeter(meter, card.estimated !== true))
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
  if (isPlainObject(source.errorHints)) card.errorHints = source.errorHints
  if (source.type === 'rpc' && (typeof source.action !== 'string' || typeof source.version !== 'string')) {
    card.error = '数据源缺少 action/version'
    card.errorCode = 'BadSource'
    return finalizeCard(card)
  }
  if (source.type === 'http' && typeof source.bearerRef === 'string' && source.bearerRef !== '' && source._bearer === undefined) {
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
      const secToken = typeof source._secToken === 'string' && source._secToken !== ''
        ? source._secToken
        : (await fetchConsoleSecToken(config, source, source._cookie)) ?? cookieValue(source._cookie, 'sec_token')
      const usage = await callConsoleGateway(config, source, source._cookie, 'usage', secToken)
      let quota = null
      let subscription = null
      try {
        quota = await callConsoleGateway(config, source, source._cookie, 'quota-config', secToken)
        subscription = await callConsoleGateway(config, source, source._cookie, 'subscription', secToken)
      } catch { /* 拿不到档位额度时仍报已用比例 */ }
      Object.assign(card, buildConsoleCard(source, usage, quota, subscription))
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

async function computeStatus(config, ctx, fresh) {
  const cards = []
  const notices = []
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
        windowDays: source.windowDays ?? null,
        sourceNote: source.sourceNote ?? null,
      })),
    },
    stats: { calls: state.calls, errors: state.errors, lastAttemptAt: state.lastAttemptAt },
    throughput: throughputSnapshot(),
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
    'estimated', 'bindProviders', 'windowDays', 'startedAt', 'resetAt', 'remainingDays', 'region',
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
      lines.push(`${card.label}：无数据${card.emptyReason ? `（${card.emptyReason}）` : ''}`)
      continue
    }
    const head = card.metric === 'money'
      ? `${formatMoneyText(card.remaining)} ${card.unit || ''}${card.extra?.toppedUp !== undefined ? `（充值 ${formatMoneyText(card.extra.toppedUp)}，赠款 ${formatMoneyText(card.extra.granted)}）` : ''}${card.extra?.cash !== undefined ? `（现金 ${formatMoneyText(card.extra.cash)}，信控 ${formatMoneyText(card.extra.credit)}）` : ''}`
      : `剩余 ${formatAmount(card.remaining)} / ${formatAmount(card.total)} ${card.unit ?? ''}${typeof card.usedPercent === 'number' ? `，已用 ${card.usedPercent}%` : ''}`
    lines.push(`${card.label}：${head}`)
  }
  for (const card of snapshot.cards.filter(item => item.estimated === true && typeof item.tokens === 'number')) {
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

function buildQuotaTool(getConfig, ctx) {
  return {
    name: 'token_plan_quota',
    description: [
      '查询官方额度/余额（DeepSeek /user/balance、可选的阿里云 BssOpenApi），',
      '外加千问 Token Plan 的本实例实测 7 天窗口（非官方余量）。',
      'action=status 读缓存快照；action=refresh 强制回源（上游有 QPS 限制，别连续刷）；',
      'action=reset 清零本实例实测用量统计（含窗口锚点）。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'refresh', 'reset'], description: 'status 读缓存（默认），refresh 回源，reset 清本实例用量。' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }] },
    timeoutMs: 120_000,
    async execute(args) {
      const config = getConfig()
      if (args?.action === 'reset') resetCurrentMonthUsage(config, ctx)
      const snapshot = await buildStatus(config, ctx, { fresh: args?.action === 'refresh' || args?.action === 'reset' })
      return {
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
      }
    },
  }
}

/* ==================================================== apply */

export const __internals = {
  DEFAULTS,
  PRESETS,
  effectiveConfig,
  normalizeSources,
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
  }, 'token-plan-quota: usage flush')

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
            if (sub === 'probe') {
              const id = url.searchParams.get('source') ?? ''
              const source = config.sources.find(item => item.id === id)
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
                  const secToken = typeof source.secTokenRef === 'string' && source.secTokenRef !== ''
                    ? (await resolveSecret(source.secTokenRef, config, ctx))?.value
                    : undefined
                  const resolved = typeof secToken === 'string' && secToken !== ''
                    ? secToken
                    : (await fetchConsoleSecToken({ ...config, debug: true }, source, cookie)) ?? cookieValue(cookie, 'sec_token')
                  const usage = await callConsoleGateway({ ...config, debug: true }, source, cookie, 'usage', resolved)
                  json(res, 200, { source: source.id, api: 'usage', keys: Object.keys(usage), shape: configlessTrim(usage) })
                  return
                }
                const payload = source.type === 'http'
                  ? await callHttp({ ...config, debug: true }, source)
                  : await callRpc({ ...config, debug: true }, credentials, source)
                json(res, 200, { source: source.id, action: source.action ?? null, keys: Object.keys(payload), shape: configlessTrim(payload) })
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
            json(res, 404, { error: 'not-found', routes: ['summary', 'refresh', 'reset', 'probe'] })
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
