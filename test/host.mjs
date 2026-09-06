/**
 * dsh-token-plan-quota 宿主半边离线自测（不联网；回环 HTTP 例外）。
 * 运行：node test/host.mjs
 *
 * 口径：徽标数字要么官方真值、要么明确标注实测——官方源卡（DeepSeek /user/balance、
 * 阿里云 BssOpenApi）为真值；实测窗口卡只统计真实调用 token/次数（不折算 Credits）；
 * 重试观测来自 llm/retry 持久事件。
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { __internals, apply, observeStream, parsePolicyKey } from '../lib/index.js'

const {
  DEFAULTS, PRESETS,
  effectiveConfig, normalizeSources,
  percentEncode, signRpcParams, flattenParams, utcTimestamp,
  rpcEnvelopeOk, pickPath, pickFirst, pickString, toNumber, toEpochMs,
  buildListCard, buildSingleCard, buildDeepseekCard, buildWindowCard, buildConsoleCard, cookieValue, providerModelTotals, finalizeCard, finalizeMeter, mergePages,
  hintFor, formatAmount, formatMoneyText, summarizeText, publicCard,
  querySource, buildStatus, invalidateSources,
  recordUsage, buildInstanceCard, slidingWindow, throughputSnapshot, retrySnapshot, observeRetryEvent, observeAbandoned,
  usageLedger, recentCalls, resetInstanceState, state,
} = __internals

let passed = 0
let failed = 0
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
  }
}
function ok(label, condition) {
  if (condition) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}`)
  }
}
const ctxStub = { logger: { warn() {} }, get: () => undefined }

/* 全程把 DSH_HOME 指到测试目录：真实 ~/.dsh 里可能有 token-plan-quota.json /
 * .credentials.yaml，文件配置会盖掉各用例的行配置，测试必须与它们隔离。 */
const ORIG_DSH_HOME = process.env.DSH_HOME
process.env.DSH_HOME = 'C:\\test-dsh-home'

/* ============================================ 0. 路径展开与状态隔离 */

const withDsh = effectiveConfig({}, ctxStub)
check('expandPath("$DSH_HOME/x") 不会双层 .dsh', withDsh.fileConfig.path, 'C:\\test-dsh-home\\token-plan-quota.json')
process.env.DSH_HOME = ORIG_DSH_HOME
const withoutDsh = effectiveConfig({}, ctxStub)
check('未设 DSH_HOME 时默认走 ~/.dsh 下', withoutDsh.fileConfig.path, join(os.homedir(), '.dsh', 'token-plan-quota.json'))
process.env.DSH_HOME = 'C:\\test-dsh-home'
resetInstanceState()

/* ============================================ 1. 签名（对照官方 pop-core） */

function refEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}
function refSign(params, secret, method = 'POST') {
  const canonical = Object.keys(params).sort().map(key => `${refEncode(key)}=${refEncode(params[key])}`).join('&')
  const stringToSign = `${method}&${refEncode('/')}&${refEncode(canonical)}`
  return createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64')
}

check('percentEncode /', percentEncode('/'), '%2F')
check('percentEncode ~ 不转义', percentEncode('a~b'), 'a~b')
check('percentEncode 空格', percentEncode('a b'), 'a%20b')
check("percentEncode !'()* 转义", percentEncode("a!'()*b"), 'a%21%27%28%29%2Ab')
check('percentEncode : 转义', percentEncode('2026-08-14T02:03:04Z'), '2026-08-14T02%3A03%3A04Z')

const VECTORS = [
  [{ Action: 'QueryAccountBalance', Version: '2017-12-14', Format: 'JSON', AccessKeyId: 'testid', SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: '3', Timestamp: '2014-05-19T08:37:52Z' }, 'testsecret'],
  [{ Action: 'DescribeFrInstances', Version: '2023-09-30', AccessKeyId: "LTAI*abc(def)ghi!j'kl", SignatureNonce: 'uuid-ish_1-2.3~4', Timestamp: '2026-08-14T02:03:04Z', Status: 'valid', PageNum: 1, PageSize: 100 }, 'top secret+/=?&'],
  [{ Action: 'QueryResourcePackageInstances', Version: '2017-12-14', AccessKeyId: 'k', ExpiryTimeStart: '2026-01-01T00:00:00Z', IncludePartner: true, 'EcIdAccountIds.1': 'a', 'EcIdAccountIds.2': 'b' }, '&'],
]
VECTORS.forEach(([params, secret], index) => {
  check(`签名向量 #${index + 1} 与官方 SDK 一致`, signRpcParams(params, secret).signature, refSign(params, secret))
})
check('repeat-list 展平', flattenParams({ EcIdAccountIds: ['a', 'b'], Nested: { X: 1 }, Skip: null }), { 'EcIdAccountIds.1': 'a', 'EcIdAccountIds.2': 'b', 'Nested.X': 1 })
check('时间戳秒级 UTC', utcTimestamp(new Date('2026-08-14T02:03:04.567Z')), '2026-08-14T02:03:04Z')

/* ============================================ 2. 官方数据源预设 */

check('默认 sources 是 DeepSeek 官方 + Token Plan 实测窗口', DEFAULTS.sources, ['deepseek-balance', 'token-plan-window'])
check('预设齐全', Object.keys(PRESETS).sort().join(','), 'account-balance,deepseek-balance,fr-instances,resource-package,token-plan-console,token-plan-window')
check('未知源被丢弃', effectiveConfig({ sources: ['deepseek-balance', 'bogus'] }, ctxStub).sources.length, 1)
check('endpoint 去协议与尾斜杠', effectiveConfig({ endpoint: 'https://business.aliyuncs.com/' }, ctxStub).endpoint, 'business.aliyuncs.com')
check('refreshMinutes 分钟→毫秒', effectiveConfig({ refreshMinutes: 1 }, ctxStub).cacheMs, 60_000)
check('refreshMinutes 非法值回默认', effectiveConfig({ refreshMinutes: 0 }, ctxStub).cacheMs, 600_000)
check('showInstanceWindow 可关', effectiveConfig({ showInstanceWindow: false }, ctxStub).showInstanceWindow, false)
check('panelScope 默认 current（明细只列当前供应商）', effectiveConfig({}, ctxStub).panelScope, 'current')
check('panelScope 可设 all', effectiveConfig({ panelScope: 'all' }, ctxStub).panelScope, 'all')
check('panelScope 非法值回 current', effectiveConfig({ panelScope: 'whatever' }, ctxStub).panelScope, 'current')
const dsCfg = effectiveConfig({}, ctxStub)
check('配置里没有 plan.credits 之类的估算残留', 'plan' in dsCfg, false)
check('自定义 http 源识别为 http 型', normalizeSources([{ id: 'c', url: 'https://x/y' }], ctxStub)[0].type, 'http')

const dsPreset = normalizeSources(['deepseek-balance'], ctxStub)[0]
check('DeepSeek 预设：http + bearer', [dsPreset.type, dsPreset.bearerRef, dsPreset.url], ['http', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/user/balance'])
check('DeepSeek 预设打真值标签', [dsPreset.veracity, dsPreset.sourceNote.includes('/user/balance')], ['verified', true])

/* ============================================ 3. 本实例实测（无估算） */

resetInstanceState()
recordUsage(dsCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000 })
recordUsage(dsCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 500_000, outputTokens: 100_000 })
recordUsage(dsCfg, 'minimax-cn', 'MiniMax-M2.7', { inputTokens: 1000, cacheWriteTokens: 2000, outputTokens: 500 })
const inst = buildInstanceCard(dsCfg)
check('不折算：卡上没有任何 Credits 概念', [inst.remaining, inst.total, inst.usedPercent, 'usedPercent' in inst, 'estimated' in inst], [undefined, undefined, undefined, false, false])
check('实测 token 按自然月累计', inst.tokens, 2_303_500)
check('实测调用次数', inst.calls, 3)
check('实例卡标 local + 来源注释不含误导', [inst.veracity, inst.sourceNote.includes('非官方额度')], ['local', true])
check('逐模型明细', inst.items.map(item => item.name).sort(), ['MiniMax-M2.7', 'qwen3.8-flash'])
check('滑动窗口也动了', typeof inst.window.tpm60 === 'number', true)
check('月份键', /^\d{4}-\d{2}$/.test(inst.monthKey), true)

/* ============================================ 3b. 实测窗口（千问 Token Plan） */

resetInstanceState()
const winCfg = effectiveConfig({ sources: ['token-plan-window'] }, ctxStub)
const tpSource = winCfg.sources.find(source => source.kind === 'window')
check('窗口源是 local 型（不打网络）', tpSource.type, 'local')
check('窗口源绑定供应商', tpSource.providers, ['qwen-token-plan-cn'])
recordUsage(winCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 1000, outputTokens: 100 })
recordUsage(winCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 2000, outputTokens: 200 })
recordUsage(winCfg, 'deepseek', 'deepseek-chat', { inputTokens: 500, outputTokens: 50 })
let winCard = finalizeCard(buildWindowCard(tpSource, winCfg))
check('窗口卡标实测', [winCard.estimated, winCard.veracity, winCard.metric], [true, 'local', 'count'])
check('窗口 tokens = 开窗后累计', winCard.tokens, 3300)
check('窗口 calls', winCard.calls, 2)
check('绑定供应商透出到卡', winCard.bindProviders, ['qwen-token-plan-cn'])
check('窗口天数默认 7', winCard.windowDays, 7)
check('重置 = 起点 + 7 天', winCard.resetAt - winCard.startedAt, 7 * 86_400_000)
check('剩余天数在 1..7', winCard.remainingDays >= 1 && winCard.remainingDays <= 7, true)
check('窗口明细只含绑定供应商', winCard.items.map(item => item.name), ['qwen3.8-flash'])

// 滚窗：起点推到 8 天前 → 下一次调用开新窗，基线把旧消耗全部扣掉。
usageLedger.windows['qwen-token-plan-cn'].startedAt = Date.now() - 8 * 86_400_000
recordUsage(winCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 400, outputTokens: 60 })
winCard = finalizeCard(buildWindowCard(tpSource, winCfg))
check('过期后第一次调用开新窗', winCard.tokens, 460)
check('新窗 calls 重新起算', winCard.calls, 1)
check('providerModelTotals 跨月累计', providerModelTotals('qwen-token-plan-cn').get('qwen3.8-flash').tokens, 3760)

resetInstanceState()
const emptyWin = finalizeCard(buildWindowCard(tpSource, winCfg))
check('没有调用时窗口卡无数字但有原因', [emptyWin.tokens, emptyWin.calls, typeof emptyWin.emptyReason], [undefined, undefined, 'string'])

recordUsage(winCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 800, outputTokens: 200 })
const callsBefore = state.calls
const winSnap = await buildStatus(winCfg, ctxStub, { fresh: true })
check('窗口卡进快照（实例卡之后）', winSnap.cards.map(card => card.id), ['instance-usage', 'token-plan-window'])
check('窗口卡不进远端调用计数', state.calls - callsBefore, 0)
ok('窗口卡 sourceNote 说明实测口径', String(winSnap.cards[1].sourceNote).includes('实测'))
ok('publicCard 放行窗口新字段', ['estimated', 'bindProviders', 'resetAt', 'windowDays'].every(key => key in winSnap.cards[1]), true)
ok('摘要含窗口行', summarizeText(winSnap).includes('窗口内'))
check('快照回带 panelScope 供前端过滤', winSnap.config.panelScope, 'current')

// 清本周期账本要连窗口锚点一起清（控制台额度重置后重新起算）；DSH_HOME 指到测试目录避免写真账本。
resetInstanceState()
recordUsage(winCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 100, outputTokens: 10 })
const origHome = process.env.DSH_HOME
process.env.DSH_HOME = 'C:\\test-dsh-home'
__internals.resetCurrentMonthUsage(winCfg, ctxStub)
process.env.DSH_HOME = origHome
check('清本周期账本把窗口锚点也清零', Object.keys(usageLedger.windows).length, 0)
resetInstanceState()

/* ============================================ 4. 滑动窗口与重试观测 */

recentCalls.length = 0
resetInstanceState()
const now = Date.now()
recordUsage(dsCfg, 'p', 'm', { inputTokens: 1000, cacheReadTokens: 50_000, outputTokens: 500 })
recordUsage(dsCfg, 'p', 'm', { inputTokens: 200, cacheReadTokens: 30_000, outputTokens: 100 })
recentCalls[0].at = now - 5_000
recentCalls[1].at = now - 120_000
const window = slidingWindow(now)
check('近 60 秒吞吐含缓存读', window.tpm60, 51_500)
check('近 60 秒请求数', window.calls60, 1)
check('缓存读单列', window.cacheRead60, 50_000)
check('5 分钟窗口计入出窗那次', window.calls300, 2)

const DEFAULT_KEY = '["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]'
const NEW_KEY = '["normal",10,["EMPTY_RESPONSE","QUOTA","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],60000,60000,0]'
const alwaysKey = '["always",60000,60000,0]'
check('旧策略 QUOTA 不可重试（这就是以前一次就断的原因）', parsePolicyKey(DEFAULT_KEY).quotaRetryable, false)
check('新策略压平成固定 60 秒', parsePolicyKey(NEW_KEY).fixedDelayMs, 60000)
check('新策略 QUOTA 可重试', parsePolicyKey(NEW_KEY).quotaRetryable, true)
check('新策略上限 10 次', parsePolicyKey(NEW_KEY).maxRetries, 10)
check('always 策略也能解析', [parsePolicyKey(alwaysKey).mode, parsePolicyKey(alwaysKey).fixedDelayMs], ['always', 60000])
check('坏 policyKey 不炸', [parsePolicyKey('nonsense'), parsePolicyKey('[]'), parsePolicyKey('["bogus"]')], [null, null, null])

__internals.retryWatch.byProvider.clear()
observeRetryEvent({ provider: 'qwen-token-plan-cn', policyKey: NEW_KEY, retry: 1, maxRetries: 10, delayMs: 60000, failure: { code: 'QUOTA' }, time: Date.now() })
observeRetryEvent({ provider: 'qwen-token-plan-cn', policyKey: NEW_KEY, retry: 2, maxRetries: 10, delayMs: 60001.4, failure: { code: 'QUOTA' } })
const [row] = retrySnapshot()
check('重试次数累加', row.attempts, 2)
check('观测到固定间隔与 QUOTA 可重试', [row.fixedDelayMs, row.quotaRetryable], [60000, true])
observeAbandoned('qwen-token-plan-cn', 'QUOTA')
check('放弃单独计数', retrySnapshot()[0].abandoned, 1)

/* ============================================ 4b. 吞吐速度（实测流时长，不估算） */

recentCalls.length = 0
const tnow = Date.now()
// qwen：1000 tok（其中输出 200）活跃 10 秒 → 生成速度 200/10=20 tok/s；deepseek：输出 100 活跃 2 秒 → 50 tok/s。
recordUsage(dsCfg, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 800, outputTokens: 200 }, tnow - 30_000, { startedAt: tnow - 40_000, endedAt: tnow - 30_000 })
recordUsage(dsCfg, 'deepseek', 'deepseek-chat', { inputTokens: 100, outputTokens: 100 }, tnow - 5_000, { startedAt: tnow - 7_000, endedAt: tnow - 5_000 })
const tp = throughputSnapshot(tnow)
check('近 60 秒吞吐（全量口径）', [tp.tpm60, tp.calls60, tp.outTps60], [1200, 2, 5])
check('生成速度 = Σ输出 ÷ Σ活跃秒', [tp.genTps, tp.activeSeconds], [25, 12])
check('按供应商归因分行', tp.byProvider.map(row => row.provider).sort(), ['deepseek', 'qwen-token-plan-cn'])
const tpQ = tp.byProvider.find(row => row.provider === 'qwen-token-plan-cn')
check('供应商行带最近模型、单流生成速度与时刻', [tpQ.model, tpQ.lastTps, tpQ.calls300, tpQ.lastAt, tpQ.lastTpsAt], ['qwen3.8-flash', 20, 1, tnow - 30_000, tnow - 30_000])
check('qwen 近 60 秒只算自己', [tpQ.tpm60, tpQ.outTps60], [1000, 3.3333])
// 无 elapsed 数据（旧条目/非流式）不进活跃秒，但进完成吞吐；缓存读不吹速度。
recentCalls.push({ at: tnow - 1_000, tokens: 500, output: 0, cacheRead: 500, provider: 'minimax-cn', model: 'MiniMax-M2.5', elapsedMs: 0 })
const tp2 = throughputSnapshot(tnow)
check('零输出/零活跃秒不污染生成速度（genTps 仍是 300÷12）', [tp2.tokens300, tp2.genTps], [1700, 25])
ok('无 elapsed 供应商行 genTps 为 null', tp2.byProvider.find(row => row.provider === 'minimax-cn').genTps === null)

// 快照与摘要接线。
const tpSnap = await buildStatus(effectiveConfig({ sources: [] }, ctxStub), ctxStub, { fresh: true })
ok('快照带 throughput 块', tpSnap.throughput !== undefined && Array.isArray(tpSnap.throughput.byProvider))
ok('摘要含吞吐行', summarizeText(tpSnap).includes('吞吐观测'))
ok('摘要含按供应商行', summarizeText(tpSnap).includes('按供应商 qwen-token-plan-cn'))

// 吞吐窗口随账本落盘：模拟宿主重启（hardReset + 重新 loadUsage）后还能带回最近 5 分钟。
__internals.flushUsage(ctxStub)
const persisted = JSON.parse(readFileSync(join('C:\\test-dsh-home', 'token-plan-quota.usage.json'), 'utf8'))
ok('账本落盘 recent 窗口（带供应商与活跃秒）', Array.isArray(persisted.recent) && persisted.recent.length >= 3
  && persisted.recent.every(entry => typeof entry.provider === 'string' && typeof entry.elapsedMs === 'number'), true)
__internals.hardResetUsage()
check('重启后内存窗口清零', recentCalls.length, 0)
buildInstanceCard(winCfg) // 触发 loadUsage 从盘恢复
const tpRestored = throughputSnapshot(Date.now())
ok('重启后吞吐窗口从盘带回', tpRestored.calls300 >= 3 && tpRestored.tpm60 > 0 && tpRestored.genTps !== null, true)
resetInstanceState()

/* ============================================ 5. DeepSeek 真值卡 */

const DS_PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '45.29', granted_balance: '0.00', topped_up_balance: '45.29' },
    { currency: 'USD', total_balance: '2.50', granted_balance: '1.00', topped_up_balance: '1.50' },
  ],
}
const dsCard = finalizeCard(buildDeepseekCard(dsPreset, DS_PAYLOAD))
check('DeepSeek 余额取 CNY 主行', dsCard.remaining, 45.29)
check('DeepSeek 币种 CNY', dsCard.unit, 'CNY')
check('充值/赠款拆分', [dsCard.extra.toppedUp, dsCard.extra.granted], [45.29, 0])
check('其它币种进明细', dsCard.items.length, 1)
check('USD 行剩余', dsCard.items[0].remaining, 2.5)
check('余额卡没有 usedPercent', dsCard.usedPercent, undefined)

const emptyDs = buildDeepseekCard(dsPreset, { balance_infos: [] })
check('空 balance_infos 给原因', typeof emptyDs.emptyReason === 'string' && emptyDs.remaining === undefined, true)

/* ============================================ 5b. Token Plan 控制台余量（Cookie 会话） */

const consolePreset = normalizeSources(['token-plan-console'], ctxStub)[0]
check('控制台源：http + builder + cookieRef', [consolePreset.type, consolePreset.builder, consolePreset.cookieRef], ['http', 'token-plan-console', 'BAILIAN_CONSOLE_COOKIE'])
check('控制台源绑定千问供应商', consolePreset.providers, ['qwen-token-plan-cn'])
check('cookieValue 抽取 sec_token', cookieValue('a=1; sec_token=abc123; cna=xyz', 'sec_token'), 'abc123')
check('cookieValue 缺失返回 undefined', cookieValue('a=1', 'sec_token'), undefined)

// 卡片数学：按 subscription.specCode 取档位额度，剩余 = weekly × (1 − 已用比例)。
const weekReset = Date.now() + 5 * 86_400_000
const consoleCard = finalizeCard(buildConsoleCard(consolePreset, {
  per1WeekPercentage: 0.349, per1WeekResetTime: weekReset,
  per5HourPercentage: 0.0123, per5HourResetTime: Date.now() + 3_000_000,
}, {
  standard: { weekly: 10000, five_hour: 3000 },
  lite: { weekly: 2500, five_hour: 700 },
  addon_quota: { extrabundle: 20000 },
}, { specCode: 'standard', remainingDays: 85, endTime: 1796054400000 }))
check('剩余 = 10000×(1−0.349)', consoleCard.remaining, 6510)
check('总额度取 standard 档', consoleCard.total, 10000)
check('已用 34.9%（finalize 与网关比例一致）', consoleCard.usedPercent, 34.9)
check('重置时间取 per1WeekResetTime', consoleCard.expiresAt, weekReset)
check('5 小时窗口与档位/套餐信息进 extra', [consoleCard.extra.fiveHourTotal, consoleCard.extra.fiveHourUsedPercent, consoleCard.extra.specCode, consoleCard.extra.planRemainingDays, consoleCard.extra.addonTotal], [3000, 1.23, 'standard', 85, 20000])
check('控制台源打官方真值标签（SOURCE_META → source）', consolePreset.veracity, 'verified')

/* 多计量条：一张卡两个窗口，meters[0] 与顶层同源（前端按此只渲染 meters.slice(1)）。 */
check('meters 有两条（7 天 + 5 小时）', consoleCard.meters.map(m => m.key), ['weekly', 'fiveHour'])
check('meters[0] 与顶层 remaining/total 同源', [consoleCard.meters[0].remaining, consoleCard.meters[0].total], [consoleCard.remaining, consoleCard.total])
check('7 天窗口百分比在 meters[0]', [consoleCard.meters[0].usedPercent, consoleCard.meters[0].remainingPercent], [34.9, 65.1])
check('5 小时窗口数学：3000×(1−0.0123)', consoleCard.meters[1].remaining, 2963.1)
check('5 小时窗口百分比与重置时刻', [consoleCard.meters[1].usedPercent, consoleCard.meters[1].remainingPercent], [1.23, 98.77])
check('meters 各带单位', [...new Set(consoleCard.meters.map(m => m.unit))], ['Credits'])
// 只有 5 小时额度、没有周额度 → 只出一条计量，且顶层不因缺分母而报错。
const fiveOnly = finalizeCard(buildConsoleCard(consolePreset, { per5HourPercentage: 0.5, per5HourResetTime: weekReset }, { standard: { five_hour: 100 } }, { specCode: 'standard' }))
check('只有 5 小时窗口时只出一条计量', fiveOnly.meters.map(m => m.key), ['fiveHour'])
check('该计量自己算出百分比', [fiveOnly.meters[0].remaining, fiveOnly.meters[0].usedPercent], [50, 50])
// 「档位配了 5 小时上限，但这个套餐没回 5 小时读数」——真实账号形态（2026-09-06 实测
// usage.keys 只有 per1WeekResetTime/per1WeekPercentage，而 quota-config.standard.five_hour=3000）。
// 这条窗口必须**根本不存在**，不能渲染成一行「额度上限 3,000」的配置噪声。
const weekOnly = finalizeCard(buildConsoleCard(consolePreset, {
  per1WeekPercentage: 0.637959301, per1WeekResetTime: weekReset,
}, { standard: { weekly: 10000, five_hour: 3000 } }, { specCode: 'standard' }))
check('没有 5 小时读数 → 只有一条计量', weekOnly.meters.map(m => m.key), ['weekly'])
check('没有 5 小时读数 → extra 也不留 5 小时字段', [weekOnly.extra.fiveHourTotal, weekOnly.extra.fiveHourUsedPercent], [undefined, undefined])
check('档位配了却无读数，收成诊断字段', weekOnly.extra.fiveHourConfiguredNoReading, true)
check('顶层仍是 7 天窗口', [weekOnly.total, weekOnly.remaining], [10000, 3620.407])
// 反过来：只有 5 小时窗口的套餐，它升为主计量（徽标不能因为"没有 7 天"而空着）。
const fiveOnlyPrimary = finalizeCard(buildConsoleCard(consolePreset, {
  per5HourPercentage: 0.25, per5HourResetTime: weekReset,
}, { standard: { five_hour: 200 } }, { specCode: 'standard' }))
check('只有 5 小时窗口时它升为主计量', [fiveOnlyPrimary.meters.length, fiveOnlyPrimary.total, fiveOnlyPrimary.remaining], [1, 200, 150])
check('主计量决定顶层重置时刻', fiveOnlyPrimary.expiresAt, weekReset)
// 窗口一个都没有 → 明确空因，不出幽灵行。
const noWindows = finalizeCard(buildConsoleCard(consolePreset, {}, {}, {}))
check('没有任何窗口 → 无计量并给空因', [noWindows.meters.length, typeof noWindows.emptyReason], [0, 'string'])
// 「不估算」硬规则：实测卡（estimated）即使误带分母也不出百分比。
const measuredMeter = finalizeMeter({ key: 'w', total: 1000, remaining: 300 }, false)
check('实测计量剥掉百分比', [measuredMeter.usedPercent, measuredMeter.remainingPercent, measuredMeter.remaining], [undefined, undefined, 300])
check('真值计量保留百分比', finalizeMeter({ key: 'w', total: 1000, remaining: 300 }, true).usedPercent, 70)
check('没有分母就没有百分比（任何档位）', [finalizeMeter({ key: 'w', remaining: 42 }, true).usedPercent, finalizeMeter({ key: 'w', remaining: 42 }, false).usedPercent], [undefined, undefined])
check('publicCard 透传 meters', publicCard(consoleCard).meters.length, 2)

// 没配 Cookie → NoCredentials 卡（不联网）。
const noCookie = await querySource(consolePreset, effectiveConfig({ minIntervalMs: 0 }, ctxStub), { configured: false })
check('缺 Cookie → NoCredentials', noCookie.errorCode, 'NoCredentials')

// 回环全链路：info.json 自动取 sec_token → usage + quota-config + subscription 三次 POST。
import { createServer as createServerB } from 'node:http'
const seenB = []
const serverB = createServerB((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/tool/user/info.json') {
      seenB.push({ api: 'info', cookie: req.headers.cookie ?? null })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: '200', successResponse: true, data: { secToken: 'tok42' } }))
      return
    }
    const api = u.searchParams.get('api') ?? ''
    seenB.push({ api, cookie: req.headers.cookie ?? null, sec: /sec_token=tok42/.test(body), params: /tokenplan/.test(body) })
    const data = api.endsWith('/usage')
      ? { per1WeekPercentage: 0.5, per1WeekResetTime: weekReset, per5HourPercentage: 0.25, per5HourResetTime: 0 }
      : api.endsWith('/subscription')
        ? { specCode: 'standard', remainingDays: 85, endTime: 1796054400000, status: 'VALID' }
        : { standard: { weekly: 10000, five_hour: 3000 }, lite: { weekly: 2500, five_hour: 700 } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: '200', successResponse: true, data: { DataV2: { data: { success: true, data } } } }))
  })
})
await new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve))
try {
  const loopSource = { ...consolePreset, url: `http://127.0.0.1:${serverB.address().port}/data/api.json`, infoUrl: `http://127.0.0.1:${serverB.address().port}/tool/user/info.json`, _cookie: 'login_qianwenai_ticket=t' }
  const live = await querySource(loopSource, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
  check('回环：剩余 = 10000×(1−0.5) 且带真值标签', [live.remaining, live.total, live.error, live.veracity], [5000, 10000, null, 'verified'])
  check('回环：console 卡带 bindProviders（徽标跟随的关键）', live.bindProviders, ['qwen-token-plan-cn'])
  check('回环：档位与套餐信息在 extra', [live.extra.specCode, live.extra.planRemainingDays], ['standard', 85])
  check('回环：info + 三个 api 都打了', seenB.map(entry => (entry.api === 'info' ? 'info' : entry.api.split('/').pop())).sort(), ['info', 'quota-config', 'subscription', 'usage'])
  ok('回环：sec_token 自动取自 info.json 并带上', seenB.filter(entry => entry.api !== 'info').every(entry => entry.sec === true))
  ok('回环：Cookie 全程带上', seenB.every(entry => entry.cookie === 'login_qianwenai_ticket=t'))
} finally {
  await new Promise(resolve => serverB.close(resolve))
}

/* ============================================ 6. 阿里云源抽取（字段名按官方元数据示例构造） */

const frSample = {
  RequestId: 'r', CurrentPage: 1, PageSize: 100, TotalCount: 2,
  Data: [
    {
      InstanceId: 'sfm-tokenplan-1', ProductCode: 'sfm', ProductName: '大模型服务平台百炼',
      CommodityCode: 'sfm_tokenplanteams_dp_cn', CommodityName: 'Token Plan 团队版',
      StatusCode: 'valid', CapacityTypeCode: 'deadlineAcc', CapacitiyTypeName: '总量递减型',
      CycleTypeCode: 'month', InitCapacityViewValue: '25000.000000', CurrCapacityViewValue: '24000.000000',
      CurrCapacityViewUnit: 'Credits', StartTime: 1786000000000, EndTime: 1893456000000,
    },
    { InstanceId: 'ossbag-1', ProductCode: 'oss', CommodityName: '标准存储包', InitCapacityViewValue: '40', CurrCapacityViewValue: '12', CurrCapacityViewUnit: 'GB', EndTime: 1899999999000 },
  ],
}
const frSource = normalizeSources(['fr-instances'], ctxStub)[0]
const frCard = finalizeCard(buildListCard(frSource, frSample))
check('fr 关键词过滤命中百炼', frCard.itemCount, 1)
check('fr 剩余量取 CurrCapacityViewValue', frCard.remaining, 24000)
check('fr 到期时间取 EndTime', frCard.expiresAt, 1893456000000)

const legacySample = {
  RequestId: 'r2', Success: true, Code: 'Success',
  Data: { PageNum: '1', PageSize: '300', TotalCount: '2',
    Instances: { Instance: [
      { InstanceId: 'sfmbag-1', CommodityCode: 'sfm_tokenplanteams_dp_cn', Remark: '百炼 Token Plan', Status: 'Available', TotalAmount: '5000.000', RemainingAmount: '1250.000', RemainingAmountUnit: 'Credits', ExpiryTime: '2026-09-12T16:00:00Z' },
      { InstanceId: 'cu-bag', CommodityCode: 'pts', Remark: '性能测试资源包', TotalAmount: '1000', RemainingAmount: '900', RemainingAmountUnit: 'CU' },
    ] } },
}
const legacyCard = finalizeCard(buildListCard(normalizeSources(['resource-package'], ctxStub)[0], legacySample))
check('旧接口过滤无关包', legacyCard.itemCount, 1)
check('旧接口剩余量', legacyCard.remaining, 1250)

const balSource = normalizeSources(['account-balance'], ctxStub)[0]
const balPayload = { Code: '200', Success: true, Data: { AvailableAmount: '1234.56', AvailableCashAmount: '1000.00', CreditAmount: '234.56', QuotaLimit: '0.00', Currency: 'CNY' } }
const balanceCard = finalizeCard(buildSingleCard(balSource, balPayload))
check('余额卡可用额度', balanceCard.remaining, 1234.56)
check('余额卡现金构成', balanceCard.extra.cash, 1000)

/* ============================================ 7. 信封判定与错误提示 */

check('Success:true 判成功', rpcEnvelopeOk({ Success: true, Code: '200' }), undefined)
check('Code:Success 判成功', rpcEnvelopeOk({ Code: 'Success' }), undefined)
ok('业务失败判失败', typeof rpcEnvelopeOk({ Code: 'NotAuthorized', Message: 'nope' }) === 'object')
ok('NotAuthorized 提示指向只读授权', String(hintFor('NotAuthorized')).includes('AliyunBSSReadOnlyAccess'))
check('未知错误码不编造提示', hintFor('TotallyNewCode'), undefined)
ok('无凭据有提示', String(hintFor('NoCredentials')).includes('credentials'))

/* ============================================ 8. 工具函数 */

check('pickPath 数组下标', pickPath({ Data: { Instances: { Instance: [{ a: 1 }] } } }, 'Data.Instances.Instance.0.a'), 1)
check('pickFirst 跳过空串', pickFirst({ a: '', b: 'x' }, ['a', 'b']), 'x')
check('toNumber 千分位', toNumber('1,234.5'), 1234.5)
check('toEpochMs 秒字符串', toEpochMs('1710604800'), 1710604800000)
check('toEpochMs 仅日期按北京', toEpochMs('2026-08-20'), Date.parse('2026-08-20T00:00:00+08:00'))
check('mergePages 拼接同路径数组', mergePages([{ Data: { X: [1] } }, { Data: { X: [2] } }], { list: ['Data.X'] }), { Data: { X: [1, 2] } })
check('maskSecret 只留头尾', __internals.maskSecret('LTAI5tABCDEF01234'), 'LTAI****1234')

/* ============================================ 9. 路由守卫 */

const reqOf = (headers, host = '127.0.0.1:3080') => ({ headers: { host, ...headers } })
check('same-origin 放行', __internals.sameOriginOnly(reqOf({ 'sec-fetch-site': 'same-origin' })), true)
check('cross-site 拒绝', __internals.sameOriginOnly(reqOf({ 'sec-fetch-site': 'cross-site' })), false)
check('Origin 不同则拒', __internals.sameOriginOnly(reqOf({ origin: 'http://evil.example' })), false)
check('Origin 相同则放行', __internals.sameOriginOnly(reqOf({ origin: 'http://127.0.0.1:3080' })), true)

/* ============================================ 10. 快照分层与并发 */

invalidateSources()
const snapshot = await buildStatus(effectiveConfig({ sources: [], showInstanceWindow: true }, ctxStub), ctxStub, { fresh: true })
check('无远端源时不打网络', snapshot.stats.calls, 0)
check('快照含本实例实测卡', snapshot.cards.map(card => card.id), ['instance-usage'])
ok('快照给出无官方源提示', snapshot.notices.length > 0 && snapshot.notices[0].includes('官方'))
check('快照不含任何密钥字段', JSON.stringify(snapshot).includes('accessKeySecret'), false)
ok('publicCard 白名单生效', !JSON.stringify(publicCard({ id: 'x', secretLeak: 'nope' })).includes('nope'))

// 并发占位不会冻结：两次请求各得新快照且 inflight 释放。
invalidateSources()
const [c1, c2] = await Promise.all([buildStatus(effectiveConfig({ sources: [] }, ctxStub), ctxStub, { fresh: true }), buildStatus(effectiveConfig({ sources: [] }, ctxStub), ctxStub, { fresh: true })])
check('并发共享同一次计算', c1 === c2, true)
check('完成后释放占位', state.inflight, null)

// 远端 TTL：无凭据时 account-balance 出错误卡但只打一次。
invalidateSources()
const withRemote = effectiveConfig({ sources: ['account-balance'], refreshMinutes: 30 }, ctxStub)
const first = await buildStatus(withRemote, ctxStub, { fresh: true })
const second = await buildStatus(withRemote, ctxStub)
check('第二次读缓存不再调用远端', second.stats.calls - first.stats.calls, 0)
check('官方卡排在实例卡之后（顺序 = sources 顺序）', second.cards.map(card => card.id), ['instance-usage', 'account-balance'])
check('错误提示可操作', String(second.cards[1].hint).includes('credentials') || String(second.cards[1].error).includes('AccessKey'), true)

// 缺 Bearer 密钥 → 卡片 NoCredentials（不联网，读真实 .credentials.yaml 的兜底链）
invalidateSources()
const missCfg = effectiveConfig({ sources: [{ id: 'deepseek-balance', bearerRef: 'NOT_A_REAL_REF' }] }, ctxStub)
const missSnap = await buildStatus(missCfg, ctxStub, { fresh: true })
const missCard = missSnap.cards.find(card => card.id === 'deepseek-balance')
check('缺密钥 → NoCredentials 而不是静默', missCard.errorCode, 'NoCredentials')

/* ============================================ 11. 摘要与白名单 */

invalidateSources()
const fullCfg = effectiveConfig({ sources: ['deepseek-balance', 'account-balance'], refreshMinutes: 10 }, ctxStub)
const fullSnap = await buildStatus(fullCfg, ctxStub, { fresh: true })
const text = summarizeText(fullSnap)
ok('摘要只渲染官方卡为主干', text.includes('DeepSeek 余额'))
ok('摘要注明实例口径非官方', text.includes('非官方额度'))
ok('摘要含重试观测行', text.includes('自动重试观测'))
check('官方卡与实例卡都在快照里', fullSnap.cards.map(card => card.id), ['instance-usage', 'deepseek-balance', 'account-balance'])

/* ============================================ 12. llm/stream 包装契约 */

function makeStream(chunks, opts = {}) {
  const state_ = { returned: 0, nextCalls: 0 }
  const iterable = {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          state_.nextCalls += 1
          if (opts.throwOn === state_.nextCalls) throw new Error('upstream boom')
          if (index >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: chunks[index++] }
        },
        async return() {
          state_.returned += 1
          return { done: true, value: undefined }
        },
      }
    },
  }
  return { iterable, state: state_ }
}

const CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

{
  const seen = []
  const { iterable } = makeStream(CHUNKS)
  const out = []
  for await (const chunk of observeStream(iterable, usage => seen.push(usage))) out.push(chunk)
  check('分片逐条原样透传（数量与顺序不变）', out, CHUNKS)
  check('同一性保持', out[1] === CHUNKS[1], true)
  check('usage 回调收到原始 usage', seen, [{ inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 }])
}

{
  const metas = []
  const { iterable } = makeStream(CHUNKS)
  for await (const _chunk of observeStream(iterable, (usage, meta) => metas.push(meta))) { /* 消费 */ }
  check('usage 回调带流起止时间', metas.length, 1)
  ok('startedAt ≤ endedAt', metas[0].startedAt <= metas[0].endedAt)
}

{
  const { iterable, state: s } = makeStream(CHUNKS)
  const collected = []
  for await (const chunk of observeStream(iterable, () => collected.push(1))) {
    collected.push(chunk.type)
    if (chunk.type === 'text-delta') break
  }
  check('提前 break 时把 return 传回上游', s.returned, 1)
}

{
  const { iterable, state: s } = makeStream(CHUNKS, { throwOn: 3 })
  let thrown = null
  try {
    for await (const _chunk of observeStream(iterable, () => {})) { /* 消费 */ }
  } catch (error) {
    thrown = error.message
  }
  check('上游错误照常向外传播（不吞）', thrown, 'upstream boom')
  check('错误路径也释放上游', s.returned, 1)
}

{
  const { iterable } = makeStream([CHUNKS[2], { ...CHUNKS[2], usage: { inputTokens: 1, outputTokens: 1 } }, CHUNKS[3]])
  const seen = []
  const out = []
  for await (const chunk of observeStream(iterable, usage => {
    seen.push(usage)
    if (seen.length === 1) throw new Error('观测器炸了')
  })) out.push(chunk.type)
  check('观测器抛错不影响流', out, ['usage', 'usage', 'finish'])
  check('抛错后仍继续观测', seen.length, 2)
}

{
  // apply() 接线：真实流 + 事件观测 + 路由注册。
  const registered = []
  const handlers = []
  const ctxStub2 = {
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer') return { register: route => (registered.push(route), () => {}) }
      if (name === 'tools') return { register: () => () => {} }
      return undefined
    },
    effect(fn) {
      fn()
      return () => {}
    },
    on(type, listener) {
      handlers.push({ type, listener })
      return () => {}
    },
  }
  resetInstanceState()
  apply(ctxStub2, { sources: [] })
  const streamListener = handlers.find(entry => entry.type === 'llm/stream')
  const eventListener = handlers.find(entry => entry.type === 'session/event')
  ok('apply 注册了 llm/stream 观察者', streamListener !== undefined)
  ok('apply 注册了 session/event 观察者', eventListener !== undefined)
  const wrapped = streamListener.listener.call(ctxStub2, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }, () => makeStream(CHUNKS).iterable)
  const drained = []
  for await (const chunk of wrapped) drained.push(chunk.type)
  check('包起来的流仍可完整消费', drained, ['block-start', 'text-delta', 'usage', 'finish'])
  check('真实记账链路走通（滑动窗口看到本次调用）', slidingWindow().tpm60, 20)
  eventListener.listener({}, { type: 'llm/retry', time: Date.now(), data: { provider: 'qwen-token-plan-cn', policyKey: NEW_KEY, retry: 1, maxRetries: 10, delayMs: 60000, failure: { code: 'QUOTA' } } })
  const after = buildInstanceCard(effectiveConfig({}, ctxStub2))
  check('apply 观测到自动重试', after.retry[0].attempts >= 1, true)
  check('观测到固定 60 秒', after.retry[0].fixedDelayMs, 60000)
  check('路由注册在前缀 /token-plan-quota', registered[0].path, '/token-plan-quota')
  check('路由按 prefix 注册', registered[0].kind, 'prefix')
}

/* ============================================ 13. callHttp：Bearer 注入 + 信封（本地回环） */

import { createServer } from 'node:http'

const seen = []
const server = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '45.29', granted_balance: '0.00', topped_up_balance: '45.29' }] }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

try {
  const httpConfig = effectiveConfig({ timeoutMs: 5000, minIntervalMs: 0 }, ctxStub)
  const httpSource = { ...normalizeSources(['deepseek-balance'], ctxStub)[0], url: `http://127.0.0.1:${port}/user/balance`, _bearer: 'sk-test-secret' }
  const fullCard = await querySource(httpSource, httpConfig, { configured: false })
  check('Bearer 真的发出去了', seen[0].authorization, 'Bearer sk-test-secret')
  check('请求打到预设路径', seen[0].url, '/user/balance')
  check('全链路产出 DeepSeek 余额卡', fullCard.remaining, 45.29)
  check('真值标签随卡输出', fullCard.veracity, 'verified')
  // 出厂适配器注册的路由 id 是 deepseek-official；别名一起带上，徽标才不靠用户手填。
  check('DeepSeek 卡带两个路由别名', fullCard.bindProviders, ['deepseek', 'deepseek-official'])
  check('HTTP 源无 AK 也能跑', fullCard.error, null)
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log(`\n${passed} passed, ${failed} failed`)
// 不用 process.exit：全局 undici 的回环保活 socket 与 exit 撞车会触发 libuv 断言。
process.exitCode = failed === 0 ? 0 : 1
