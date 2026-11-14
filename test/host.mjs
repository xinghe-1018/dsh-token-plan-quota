/**
 * dsh-token-plan-quota 宿主半边离线自测（不联网；回环 HTTP 例外）。
 * 运行：node test/host.mjs
 *
 * 口径：徽标数字要么官方真值、要么明确标注实测——官方源卡（DeepSeek /user/balance、
 * 阿里云 BssOpenApi）为真值；实测窗口卡只统计真实调用 token/次数（不折算 Credits）；
 * 重试观测来自 llm/retry 持久事件。
 */
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import zlib from 'node:zlib'
import { __internals, apply, observeStream, parsePolicyKey } from '../lib/index.js'
import { assertUsageIndexShape } from '../lib/usage-stats.js'

// 离线不变量（宪法 VI）：本套件不得联网。DSH_HOME 指向 tmpdir 只挡住了 .credentials.yaml 与 .env，
// **进程环境层没挡**——shell（尤其 CI 注入了 secret）只要有 DEEPSEEK_API_KEY /
// ALIBABA_CLOUD_ACCESS_KEY_ID(+SECRET) / MOONSHOT_API_KEY / OPENROUTER_API_KEY /
// BAILIAN_CONSOLE_COOKIE，buildStatus 就会真的去打 api.deepseek.com、business.aliyuncs.com 等：
// 同一套件在干净机器上"离线绿"、在有变量的机器上联网，连"未配置凭据"那几条断言都会因此变红。
// 这里把凭据类环境变量一律清掉，把"无凭据"变成确定前提。
for (const name of Object.keys(process.env)) {
  if (/(_API_KEY|_ACCESS_KEY_ID|_ACCESS_KEY_SECRET|ACCESS_KEY|_SECRET|_TOKEN|COOKIE)$/i.test(name)) delete process.env[name]
}

const {
  DEFAULTS, PRESETS,
  effectiveConfig, normalizeSources, findProbeSource,
  percentEncode, signRpcParams, flattenParams, utcTimestamp,
  rpcEnvelopeOk, httpEnvelopeOk, parseEnvelope, pickPath, pickFirst, pickString, toNumber, toEpochMs,
  buildListCard, buildSingleCard, evalDerive, buildDeepseekCard, buildWindowCard, buildConsoleCard, cookieValue, providerModelTotals, finalizeCard, finalizeMeter, mergePages,
  hintFor, formatAmount, formatMoneyText, summarizeText, publicCard, cookieNames, jsonKeyShape,
  querySource, buildStatus, invalidateSources,
  recordUsage, buildInstanceCard, slidingWindow, throughputSnapshot, retrySnapshot, observeRetryEvent, observeAbandoned,
  usageLedger, recentCalls, resetInstanceState, state,
  toToolJson, buildQuotaTool,
  emptyUsageIndex, dayKey, foldUsageEvents, aggregateUsageRange, resolveCustomRange, resolveMonthRange,
  loadUsageIndex, saveUsageIndex, trimUsageIndex, syncUsageIndex,
  decodeSessionLog, parseSessionEvents, fallbackCutOf, fallbackLogsOf, fallbackSignature,
  ensureUsageIndexLoaded, FALLBACK_SCAN_BUDGET,
  buildUsageSnapshot, runUsageSync,
  buildOfficialUsageSnapshot, buildCreditsTokenSnapshot, creditsCycleOf, creditsTokenRatioOf,
  creditsClassRatios, creditsModelRatios, composeCreditsToken,
  resolveOfficialRange, officialFailureOf, officialCache, summarizeOfficialText,
  sliceOfficialRange, parseOfficialEnvelope, foldOfficialSeries, buildOfficialUsage, mergeOfficialDays,
  officialChunkRequest, officialEarliestDayKey, officialErrorHint, DECLARED_HOSTS,
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

/* ============================================ 0b. 工具返回值必须过宿主的无损 JSON 关
 *
 * 宿主在把工具结果交给模型之前会深走一遍「无损 JSON」，**显式的 undefined 属性、
 * 稀疏数组、NaN / ±Infinity / -0 会让整条结果被拒收**（报
 * `tool "token_plan_quota" returned invalid output: value is not lossless JSON`，
 * 判定在 @deepseek-ai/dsh-util-values 的 walkJsonValue）。本卡片的字段大量是
 * 「有才填」，所以 execute 出口必须先过 toToolJson。2026-09-09 在 dsh 0.1.2-rc.1
 * 上就是这个原因整条被拒：`.cards.0.remaining` 是 undefined。
 */
ok('toToolJson 丢掉显式 undefined 属性',
  JSON.stringify(toToolJson({ a: 1, b: undefined, c: { d: undefined, e: 2 } })) === '{"a":1,"c":{"e":2}}')
ok('toToolJson 把 NaN / Infinity 收成 null、-0 收成 0',
  JSON.stringify(toToolJson({ n: NaN, i: Infinity, z: -0 })) === '{"n":null,"i":null,"z":0}')
ok('toToolJson 把数组里的洞补成 null（宿主按稠密数组校验）',
  JSON.stringify(toToolJson([1, undefined, 3])) === '[1,null,3]')
ok('toToolJson 打断循环引用，而不是让整条结果被拒',
  (() => {
    const a = { x: 1 }
    a.self = a
    const r = toToolJson(a)
    return r.x === 1 && r.self === null
  })())
ok('toToolJson 输出可以原样 JSON 往返',
  (() => {
    const r = toToolJson({ cards: [{ id: 'x', remaining: undefined, total: 0 }], t: '文本' })
    return JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r)
  })())
const toolForShape = buildQuotaTool(() => ({ ...DEFAULTS }), {
  logger: { warn() {} }, get: () => undefined, on: () => {}, effect: () => {},
})
ok('token_plan_quota 的 execute 出口套了 toToolJson',
  /return toToolJson\(/.test(String(toolForShape.execute)))

/* 全程把 DSH_HOME 指到一个**每进程唯一的临时目录**：真实 ~/.dsh 里可能有
 * token-plan-quota.json / .credentials.yaml，文件配置会盖掉各用例的行配置，
 * 测试必须与它们隔离。写死 Windows 路径（曾经的 C:\test-dsh-home）会让
 * Linux/macOS 的贡献者直接跑不起来，也进不了 CI。 */
/**
 * 恢复（或删掉）DSH_HOME。Node 里 `process.env.X = undefined` 会写成字符串 "undefined"，
 * 于是"未设 DSH_HOME"这条用例在 CI（没有预设这个变量）上把默认路径算成 `undefined/...`——
 * 本机跑得越好，CI 越红，因为只有本机恰好设了 DSH_HOME。2026-09-07 六个 job 一起红就是它。
 */
function setDshHome(value) {
  if (value === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = value
}

const ORIG_DSH_HOME = process.env.DSH_HOME
const TEST_HOME = join(os.tmpdir(), `dsh-quota-test-${process.pid}`)
mkdirSync(TEST_HOME, { recursive: true })
process.env.DSH_HOME = TEST_HOME

/* ============================================ 0. 路径展开与状态隔离 */

const withDsh = effectiveConfig({}, ctxStub)
check('expandPath("$DSH_HOME/x") 不会双层 .dsh', withDsh.fileConfig.path, join(TEST_HOME, 'token-plan-quota.json'))
// 显式删掉再测默认落点：这条用例不能依赖"开发者环境里恰好没设 DSH_HOME"。
setDshHome(undefined)
const withoutDsh = effectiveConfig({}, ctxStub)
check('未设 DSH_HOME 时默认走 ~/.dsh 下', withoutDsh.fileConfig.path, join(os.homedir(), '.dsh', 'token-plan-quota.json'))
process.env.DSH_HOME = TEST_HOME
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
check('预设齐全（新增一家要同步 README 的源表）', Object.keys(PRESETS).sort().join(','), 'account-balance,deepseek-balance,fr-instances,moonshot-balance,openrouter-credits,resource-package,token-plan-console,token-plan-window')
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
process.env.DSH_HOME = TEST_HOME
__internals.resetCurrentMonthUsage(winCfg, ctxStub)
setDshHome(origHome)
check('清本周期账本把窗口锚点也清零', Object.keys(usageLedger.windows).length, 0)
resetInstanceState()

/* ============================================ 3c. window:<provider> 简写（C 档兜底写法） */

resetInstanceState()
const shorthandCfg = effectiveConfig({ sources: ['window:minimax-cn'] }, ctxStub)
const miniSource = shorthandCfg.sources[0]
check('简写自动展开成窗口源', [miniSource.kind, miniSource.type, miniSource.providers], ['window', 'local', ['minimax-cn']])
ok('标签点名是哪个供应商', String(miniSource.label).includes('minimax-cn'))
// 「实测」由徽标/卡头那颗 pill 标（client.js:639、:770），标签再写一遍就是同一枚控件里
// 出现两次"实测"，还白占约 40px——那正是把宿主输入行挤折行的主因。别加回来。
check('标签只写供应商名，不重复「实测」', [miniSource.label, miniSource.labelEn], ['minimax-cn', 'minimax-cn'])
ok('口径说明写"未接入可核实的官方额度源"，不写"官方没有接口"这种证明不了的话',
  String(miniSource.sourceNote).includes('未接入可核实的官方额度源') && !String(miniSource.sourceNote).includes('没有可核实的官方额度接口'))
recordUsage(shorthandCfg, 'minimax-cn', 'MiniMax-M2.5', { inputTokens: 900, outputTokens: 100 })
const miniCard = finalizeCard(buildWindowCard(miniSource, shorthandCfg))
check('实测窗口对任意 provider 同构（token/次数）', [miniCard.tokens, miniCard.calls, miniCard.bindProviders], [1000, 1, ['minimax-cn']])
check('C 档口径：没分母就没百分比与剩余', [miniCard.total, miniCard.remaining, miniCard.usedPercent, miniCard.remainingPercent], [undefined, undefined, undefined, undefined])
check('简写卡仍标 local/实测', [miniCard.veracity, miniCard.estimated], ['local', true])
const multiSource = normalizeSources([{ id: 'window:minimax', providers: ['minimax-cn', 'minimax'], windowDays: 30 }], ctxStub)[0]
check('条目显式 providers 优先于简写名', multiSource.providers, ['minimax-cn', 'minimax'])
check('windowDays 可覆盖（对齐别家自己的窗口规则）', multiSource.windowDays, 30)
const badWarns = []
check('未知源照样丢弃', normalizeSources(['windowx:nope'], { logger: { warn: e => badWarns.push(String(e.message)) }, get: () => undefined }).length, 0)
ok('未知源的提示里要告诉用户这条兜底写法', String(badWarns[0]).includes('window:<provider>'))
// README「手写条目的全部可用键」这张表里的每一行都要能被这几条钉住：文档说"回落 id"、"不写 url 就走 RPC"，
// 代码改了没同步就该红，而不是让下一个人照文档写出一个静默失效的条目。
check('手写条目不写 label → 标题回落 id', normalizeSources([{ id: 'my-src', url: 'https://example.com/b' }], ctxStub)[0].label, 'my-src')
check('label 是空白串也按没写处理', normalizeSources([{ id: 'my-src', url: 'https://example.com/b', label: '   ' }], ctxStub)[0].label, 'my-src')
check('写了 label 就用作者的', normalizeSources([{ id: 'my-src', url: 'https://example.com/b', label: '我的余额' }], ctxStub)[0].label, '我的余额')
check('不写 url 也不是内置源名 → 按 RPC 处理', normalizeSources([{ id: 'rpc-src', action: 'QueryFoo', version: '2024-01-01' }], ctxStub)[0].type, 'rpc')
check('写了 url → 按 HTTP 处理', normalizeSources([{ id: 'http-src', url: 'https://example.com/balance' }], ctxStub)[0].type, 'http')
check('kind 不写默认 single', normalizeSources([{ id: 'plain', url: 'https://example.com/b' }], ctxStub)[0].kind, 'single')
check('enabled:false 停掉这一条', normalizeSources([{ id: 'off-src', url: 'https://example.com/b', enabled: false }], ctxStub).length, 0)
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
const persisted = JSON.parse(readFileSync(join(TEST_HOME, 'token-plan-quota.usage.json'), 'utf8'))
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
  per1WeekPercentage: 0.625, per1WeekResetTime: weekReset,
}, { standard: { weekly: 4000, five_hour: 800 } }, { specCode: 'standard' }))
check('没有 5 小时读数 → 只有一条计量', weekOnly.meters.map(m => m.key), ['weekly'])
check('没有 5 小时读数 → extra 也不留 5 小时字段', [weekOnly.extra.fiveHourTotal, weekOnly.extra.fiveHourUsedPercent], [undefined, undefined])
check('档位配了却无读数，收成诊断字段', weekOnly.extra.fiveHourConfiguredNoReading, true)
check('顶层仍是 7 天窗口', [weekOnly.total, weekOnly.remaining], [4000, 1500])
// 反过来：只有 5 小时窗口的套餐，它升为主计量（徽标不能因为"没有 7 天"而空着）。
const fiveOnlyPrimary = finalizeCard(buildConsoleCard(consolePreset, {
  per5HourPercentage: 0.25, per5HourResetTime: weekReset,
}, { standard: { five_hour: 200 } }, { specCode: 'standard' }))
check('只有 5 小时窗口时它升为主计量', [fiveOnlyPrimary.meters.length, fiveOnlyPrimary.total, fiveOnlyPrimary.remaining], [1, 200, 150])
check('主计量决定顶层重置时刻', fiveOnlyPrimary.expiresAt, weekReset)

/* 2026-09-23 实测：控制台把 Token Plan 的账期改成**按月** —— 同一个源的 usage 只剩
 * per1MonthPercentage / per1MonthResetTime，quota-config 的档位额度字段也从 weekly 改名
 * monthly（这条卡于是整张没有数字，徽标只剩实测卡 —— 用户报"看不到余量"的真因）。 */
const monthReset = Date.parse('2026-09-30T00:00:00Z')
const monthOnly = finalizeCard(buildConsoleCard(consolePreset, {
  per1MonthPercentage: 0.010915532622222222, per1MonthResetTime: monthReset,
}, {
  standard: { monthly: 45000, five_hour: 3000 },
  pro: { monthly: 180000, five_hour: 12000 },
  addon_quota: { extrabundle: 20000 },
}, { specCode: 'standard', remainingDays: 68, endTime: 1796054400000 }))
check('只有月度读数 → 出一条月度计量', monthOnly.meters.map(m => m.key), ['monthly'])
check('分母取 quota[specCode].monthly（这个形态里没有 weekly 键）', monthOnly.total, 45000)
check('剩余 = 45000×(1−1.0915533%)', Math.round(monthOnly.remaining), 44509)
check('顶层重置时刻取 per1MonthResetTime', monthOnly.expiresAt, monthReset)
check('已用比例直接来自官方比例（不估算）', Math.round(monthOnly.usedPercent * 100) / 100, 1.09)
check('meters[0] 与顶层同源（前端只渲染 meters.slice(1)）',
  [monthOnly.meters[0].remaining, monthOnly.meters[0].total], [monthOnly.remaining, monthOnly.total])
check('月度形态下，档位里的 five_hour 仍只是配置噪声', monthOnly.extra.fiveHourConfiguredNoReading, true)
check('附加包只报数，不并进分母（宪法原则 I：不折算）', monthOnly.extra.addonTotal, 20000)
// 两种账期同时回读数：账期更长的那个才是"这个套餐的额度"，必须排在主计量位。
const monthAndWeek = finalizeCard(buildConsoleCard(consolePreset, {
  per1MonthPercentage: 0.5, per1MonthResetTime: monthReset,
  per1WeekPercentage: 0.25, per1WeekResetTime: weekReset,
}, { standard: { monthly: 1000, weekly: 4000 } }, { specCode: 'standard' }))
check('月度与周度都在时，月度排在前', monthAndWeek.meters.map(m => m.key), ['monthly', 'weekly'])
check('顶层跟月度而不是周度', [monthAndWeek.total, monthAndWeek.remaining, monthAndWeek.expiresAt], [1000, 500, monthReset])
// 有读数、但档位额度那一路没取到（实测：quota-config 单次超时，5 次里 1 次，那次全程 19.8s）。
// 宪法 v2.0.0 之后的口径：**上游直接返回的官方比例照报**，只是不画余量条、不编绝对剩余量，
// 并且必须留诊断。老写法是整张卡退回"无数据"——把一个可追溯到字段名的真值丢掉，还把人误导去核对字段名。
const quotaFailed = finalizeCard(buildConsoleCard(consolePreset,
  { per1MonthPercentage: 0.033, per1MonthResetTime: monthReset }, null, { specCode: 'standard' }))
check('quota 那一路没回 → 官方比例仍进顶层 usedPercent',
  [quotaFailed.usedPercent, quotaFailed.total, quotaFailed.remaining], [3.3, undefined, undefined])
check('比例所在计量自己也带百分比（面板那行有得显示）',
  [quotaFailed.meters[0].key, quotaFailed.meters[0].usedPercent], ['monthly', 3.3])
check('缺分母时不给 remainingPercent（条由前端按官方比例画，服务端不派生死数）', quotaFailed.meters[0].remainingPercent, undefined)
check('缺分母不再算空卡：不给 emptyReason', quotaFailed.emptyReason, undefined)
check('但也不能静默：留 denominatorFailed 诊断', quotaFailed.extra.denominatorFailed, true)
const monthNoTotal = finalizeCard(buildConsoleCard(consolePreset, { per1MonthPercentage: 0.3 }, {}, {}))
check('档位字段名不认识走同一条路（比例保留 + 诊断）',
  [monthNoTotal.usedPercent, monthNoTotal.total, monthNoTotal.extra.denominatorFailed], [30, undefined, true])
// summarizeText 只报官方真值卡（veracity 是 querySource 那层给的，这里手工补上）。
const ratioSummary = summarizeText({
  generatedAt: Date.now(), refreshMinutes: 10, notices: [],
  cards: [{ ...quotaFailed, veracity: 'verified', bindProviders: ['qwen-token-plan-cn'] }],
})
ok('模型工具摘要也报比例，不再说"无数据"',
  ratioSummary.includes('已用 3.3%') && !ratioSummary.includes('无数据'), ratioSummary)
check('publicCard 透传 usedPercent 与诊断字段',
  [publicCard(quotaFailed).usedPercent, publicCard(quotaFailed).extra.denominatorFailed], [3.3, true])
// 窗口一个都没有 → 明确空因，不出幽灵行。
const noWindows = finalizeCard(buildConsoleCard(consolePreset, {}, {}, {}))
check('没有任何窗口 → 无计量并给空因', [noWindows.meters.length, typeof noWindows.emptyReason], [0, 'string'])
// 「不估算」硬规则：实测卡（estimated）即使误带分母也不出百分比。
const measuredMeter = finalizeMeter({ key: 'w', total: 1000, remaining: 300 }, false)
check('实测计量剥掉百分比', [measuredMeter.usedPercent, measuredMeter.remainingPercent, measuredMeter.remaining], [undefined, undefined, 300])
check('真值计量保留百分比', finalizeMeter({ key: 'w', total: 1000, remaining: 300 }, true).usedPercent, 70)
check('没有分母就没有百分比（任何档位）', [finalizeMeter({ key: 'w', remaining: 42 }, true).usedPercent, finalizeMeter({ key: 'w', remaining: 42 }, false).usedPercent], [undefined, undefined])
// 「实测」的判据两半边必须一致：客户端认 `estimated === true || veracity === 'local'`
// （lib/client.js 的 isMeasured），宿主此前只认 estimated —— 只标了 veracity 的实测卡会漏网，
// 服务端派生出百分比、客户端拒绝画条，同一张卡两个说法。
const localMeterCard = finalizeCard({ veracity: 'local', meters: [{ key: 'w', total: 1000, remaining: 300 }] })
check('veracity:local 的卡，计量一律剥掉百分比（与客户端同口径）',
  [localMeterCard.meters[0].usedPercent, localMeterCard.meters[0].remainingPercent, localMeterCard.meters[0].remaining], [undefined, undefined, 300])
check('veracity:verified 的卡照常派生百分比', finalizeCard({ veracity: 'verified', meters: [{ key: 'w', total: 1000, remaining: 300 }] }).meters[0].usedPercent, 70)
// 凭据两层兜底：按键名过滤 + 按值脱敏。上游错误体若把请求原样回显，键名是上游定的，猜不全。
const trimmedShape = __internals.configlessTrim(
  { sec_token: 'SECRETVALUE1', secToken: 'SECRETVALUE1', AccessKeySecret: 'x', password: 'y', bearer: 'z', total_tokens: 5, note: 'echo SECRETVALUE1 end' },
  0, ['SECRETVALUE1'])
check('configlessTrim 删掉凭据键，保留正常用量字段',
  [trimmedShape.sec_token, trimmedShape.secToken, trimmedShape.AccessKeySecret, trimmedShape.password, trimmedShape.bearer, trimmedShape.total_tokens],
  [undefined, undefined, undefined, undefined, undefined, 5])
check('configlessTrim 按值兜底：普通字段里回显的凭据值也脱敏', trimmedShape.note, 'echo **** end')
check('redactSecrets 只脱敏够长的值（短值不误伤普通文本）',
  [__internals.redactSecrets('a=token123456789', ['token123456789']), __internals.redactSecrets('ab', ['ab'])], ['a=****', 'ab'])
// 出站声明要真的约束出站（宪法 V）：原先"声明集合 == 实际出站集合"只是文档承诺——
// `endpoint`（用户可配）与自定义源的 url 能把请求（含 AK/SK 签名）打到任意主机而没有任何检查。
check('声明内的主机放行', __internals.assertDeclaredHost('https://api.deepseek.com/user/balance', {}, 'x'), 'https://api.deepseek.com')
let hostRejectCode = 'no-throw'
try { __internals.assertDeclaredHost('https://evil.example.com/x', {}, 'x') } catch (error) { hostRejectCode = error.code }
check('未声明主机被拒（HostNotDeclared）', hostRejectCode, 'HostNotDeclared')
check('显式打开 allowUndeclaredHosts 才放行',
  __internals.assertDeclaredHost('https://evil.example.com/x', { allowUndeclaredHosts: true }, 'x'), 'https://evil.example.com')
let hostBadUrlCode = 'no-throw'
try { __internals.assertDeclaredHost('not-a-url', {}, 'x') } catch (error) { hostBadUrlCode = error.code }
check('非绝对 URL 判 BadUrl（不猜默认主机）', hostBadUrlCode, 'BadUrl')
let hostHttpCode = 'no-throw'
try { __internals.assertDeclaredHost('http://api.deepseek.com/x', {}, 'x') } catch (error) { hostHttpCode = error.code }
check('非回环的 http 一律 BadUrl（凭据不走明文）', hostHttpCode, 'BadUrl')
check('回环是测试的明文例外（宪法 VI），不受声明集合约束',
  __internals.assertDeclaredHost('http://127.0.0.1:9/balance', {}, 'x'), 'http://127.0.0.1:9')
// 比对走归一化后的 origin：大写主机名与显式默认端口仍指向已声明的那台主机
// （拿原文比会误报"未声明"——CodeRabbit 在 PR #3 上指出）。
check('主机比对：大写与 :443 仍算已声明',
  [__internals.assertDeclaredHost('https://API.DeepSeek.com:443/user/balance', {}, 'x'),
    __internals.assertDeclaredHost('https://openrouter.ai:443/api/v1/credits', {}, 'x')],
  ['https://api.deepseek.com', 'https://openrouter.ai'])
// 端到端：未声明的自定义源要在断言处就变成错误卡，而不是真去请求它。
const undeclaredCard = await querySource({ id: 'custom-undeclared', label: '自定义', type: 'http', url: 'https://evil.example.com/balance' },
  effectiveConfig({ sources: [], showInstanceWindow: false }, ctxStub), { configured: false })
check('未声明的自定义源变成 HostNotDeclared 错误卡',
  [undeclaredCard.errorCode, typeof undeclaredCard.hint], ['HostNotDeclared', 'string'])
check('publicCard 透传 meters', publicCard(consoleCard).meters.length, 2)
// 字段错位回归（2026-09-23 账期改名后的真实风险）：`quota-config` 已按月、`usage` 仍只回周比例。
// 配置上限不得自成一条计量、不得凭"monthly 优先"当上主计量；官方周比例必须照常进顶层，
// 配置值只留诊断——旧写法在这里会同时丢掉比例和三个诊断。
const mismatched = finalizeCard(buildConsoleCard(consolePreset,
  { per1WeekPercentage: 0.25, per1WeekResetTime: weekReset }, { standard: { monthly: 45000 } }, { specCode: 'standard' }))
check('字段错位：配置上限不成为计量', mismatched.meters.map(m => m.key), ['weekly'])
check('字段错位：官方周比例照旧进顶层，且不给假的总量',
  [mismatched.usedPercent, mismatched.total, mismatched.remaining], [25, undefined, undefined])
check('字段错位：配置上限只留诊断', mismatched.extra.monthlyConfiguredNoReading, true)

/* Cookie 诊断只列**名字**：名字不是秘密，值是。 */
{
  const diag = cookieNames('cna=AAA; cnaui=BBB; login_qianwenai_ticket=SECRET_CANARY')
  ok('cookieNames 列出全部名字', diag.text.includes('cna') && diag.text.includes('login_qianwenai_ticket'))
  ok('cookieNames 不把值带出来', !diag.text.includes('AAA') && !diag.text.includes('SECRET_CANARY'), diag.text)
  check('名字个数写进描述', cookieNames('a=1; b=2').text.endsWith('（2 个）'), true)
}

/* 响应骨架同一条纪律：MissingSecToken 要报"回了哪些字段"，靠的是名字，值绝不出现。 */
{
  check('骨架列名字与类型', jsonKeyShape({ code: 'CANARY_V', data: { secToken: 'CANARY_T' } }), 'code:string, data{secToken}')
  check('数组只报长度不报元素', jsonKeyShape({ list: [1, 2] }), 'list:array(2)')
  check('只下探一层（再深的层不展开）', jsonKeyShape({ data: { inner: { deep: 1 } } }), 'data{inner}')
  check('空对象写明是空', jsonKeyShape({ data: {} }), 'data{}')
  check('null 有单独形态，不与 string 混成一片', jsonKeyShape({ a: null, b: 1 }), 'a:null, b:number')
  ok('超过上限时点名总数', jsonKeyShape({ a: 1, b: 2, c: 3 }, 2).endsWith(' 等 3 个'), jsonKeyShape({ a: 1, b: 2, c: 3 }, 2))
  ok('骨架里没有任何值', !jsonKeyShape({ token: 'SECRET_CANARY', nested: { secret: 'CANARY_2' } }).includes('CANARY'))
  check('非对象响应退回类型（不抛）', jsonKeyShape('boom'), 'string')
}

// 没配 Cookie → NoCredentials 卡（不联网）。
const noCookie = await querySource(consolePreset, effectiveConfig({ minIntervalMs: 0 }, ctxStub), { configured: false })
check('缺 Cookie → NoCredentials', noCookie.errorCode, 'NoCredentials')

/* probe 的源查找（同一次改动里修的盲点）：零配置安装里，源是 computeStatus 跑
 * applyAutoDetect 时才挂到 config 上的，而路由每次从 getConfig() 拿新配置 —— 之前直接查
 * 必然 unknown-source，于是"能看上游字段集"的唯一入口，对唯一需要它的源永远 404。 */
{
  let detectRuns = 0
  const cfg = { sources: [] }
  const fakeDetect = async (target) => {
    detectRuns += 1
    target.sources.push({ id: 'token-plan-console', builder: 'token-plan-console' })
  }
  const found = await findProbeSource(cfg, {}, 'token-plan-console', fakeDetect)
  check('配置里没有的源 → 补跑一次检测再查', [detectRuns, found?.builder], [1, 'token-plan-console'])
  const again = await findProbeSource(cfg, {}, 'token-plan-console', fakeDetect)
  check('第二次直接命中，不再重复跑检测', [detectRuns, again?.id], [1, 'token-plan-console'])
  const direct = await findProbeSource({ sources: [{ id: 'deepseek-balance' }] }, {}, 'deepseek-balance',
    async () => { throw new Error('配置里已有的源不该触发检测') })
  check('文件里写明的源仍走直查', direct?.id, 'deepseek-balance')
  check('补跑检测后仍查不到 → undefined（路由照旧回 404）',
    await findProbeSource({ sources: [] }, {}, 'nope', async () => {}), undefined)
}

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

/* 网关回 NotLogined 时，提示要把"打的是哪台主机 + 收到的 Cookie 名"说出来。
 * 2026-10-06 实机：用户抄来的是另一台主机的反爬 Cookie 集（cna/cnaui/… + login_aliyunid_csrf），
 * 提示只写"没登录"时无从下手；名字列出来一眼就能看出抄错了。值绝不允许出现在提示里。 */
{
  const serverC = createServerB((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { errorCode: 'BailianGateway.Login.NotLogined', errorMsg: 'not logged in' } }))
  })
  await new Promise(resolve => serverC.listen(0, '127.0.0.1', resolve))
  try {
    const wrongSite = {
      ...consolePreset,
      url: `http://127.0.0.1:${serverC.address().port}/data/api.json`,
      infoUrl: `http://127.0.0.1:${serverC.address().port}/tool/user/info.json`,
      _cookie: 'cna=AAA; cnaui=BBB; login_aliyunid_csrf=SECRET_CANARY',
    }
    const rejected = await querySource(wrongSite, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
    ok('被拒时提示列出收到的 Cookie 名', String(rejected.error).includes('cna') && String(rejected.error).includes('cnaui'), rejected.error)
    ok('被拒时提示点出缺的是登录票据（login_qianwenai_ticket）', String(rejected.error).includes('login_qianwenai_ticket'), rejected.error)
    ok('被拒时提示写清插件打的是哪台主机', String(rejected.error).includes(String(serverC.address().port)), rejected.error)
    ok('Cookie 的值绝不进提示', !String(rejected.error).includes('SECRET_CANARY') && !String(rejected.error).includes('AAA'), rejected.error)

    /* 回归（第二轮 Open Code Review 第 1 条）：泛匹配 `/ticket/i` 会被**另一台主机的票据**顶掉。
     * 用户抄 aliyun 控制台那条请求时，Cookie 里本来就有 login_aliyunid_ticket，旧写法据此判定
     * "有票据"、把最关键的那半句吞掉——而那恰恰是本条诊断要认的错事。
     * 反向也要钉：票据真在场时不许再报缺（否则就是又一处假红）。 */
    const otherTicketSite = { ...wrongSite, _cookie: 'cna=AAA; login_aliyunid_ticket=SECRET_CANARY_B; login_aliyunid_csrf=BBB' }
    const rejectedOther = await querySource(otherTicketSite, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
    // 提示不但要说缺，还要把`看到的那张同类票据`点出来（§6 第 14 条）：那正是另一台主机的指纹，
    // 用户据此知道该去复制哪条请求，而不是只被告知'缺票据'。
    ok('另一台主机的 login_aliyunid_ticket 不能顶掉提示，且要被点名',
      String(rejectedOther.error).includes('看到的是 login_aliyunid_ticket')
      && String(rejectedOther.error).includes('本控制台要的是 login_qianwenai_ticket'), rejectedOther.error)
    ok('另一种形态的票据名：值仍绝不进提示', !String(rejectedOther.error).includes('SECRET_CANARY_B'), rejectedOther.error)
    const rightTicketSite = { ...wrongSite, _cookie: 'cna=AAA; login_qianwenai_ticket=SECRET_CANARY_C' }
    const rejectedRight = await querySource(rightTicketSite, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
    ok('票据在场时不再报缺票据（只报主机与名字，不制造假红）',
      !String(rejectedRight.error).includes('没有看到登录票据'), rejectedRight.error)
    ok('票据在场时仍然点出打的是哪台主机', String(rejectedRight.error).includes(String(serverC.address().port)), rejectedRight.error)
    // 第四轮审查第 3 条：预设里新增的 loginTicketCookie 其实没被钉住——lib 里留着同名兜底，
    // 把预设字段拼错甚至整行删掉，上面几条仍全绿。用「换一个名字」的源证明文案跟着预设走：
    const renamed = { ...wrongSite, loginTicketCookie: 'canary_ticket', _cookie: 'cna=AAA; login_qianwenai_ticket=SECRET_CANARY_D' }
    const rejectedRenamed = await querySource(renamed, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
    ok('缺票据提示用的是预设给出的票据名（字段真的驱动文案，而不是兜底字面量）',
      String(rejectedRenamed.error).includes('canary_ticket') && !String(rejectedRenamed.error).includes('没有看到登录票据 login_qianwenai_ticket'), rejectedRenamed.error)
    // 空串覆盖必须退回具名默认值，否则文案退化成「没有看到登录票据 ——」这种悬空半句。
    const emptied = { ...wrongSite, loginTicketCookie: '', _cookie: 'cna=AAA' }
    const rejectedEmpty = await querySource(emptied, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
    ok('loginTicketCookie 被覆盖成空串时退回具名默认（不产生悬空文案）',
      String(rejectedEmpty.error).includes('没有看到登录票据 login_qianwenai_ticket'), rejectedEmpty.error)
  } finally {
    await new Promise(resolve => serverC.close(resolve))
  }
}

/* 回归（2026-11-03 实机）：Cookie 里 `login_qianwenai_ticket` 明明在场，缺的其实是 sec_token，
 * 而 NotLogined 的提示只断言"多半抄的是另一台主机"——照着提示把 Cookie 重抄几遍也不会好。
 * 三条成因现在分得开：token 取到仍被拒＝会话过期；token 取不到＝MissingSecToken（带失败原因）；
 * 缺票据＝照旧报缺票据，不许反过来把 Cookie 的问题伪装成 token 的问题。 */
{
  const gatewayOf = infoMode => createServerB((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/tool/user/info.json') {
      if (infoMode === 'busy') { res.writeHead(503); res.end('busy'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(infoMode === 'token'
        ? { code: '200', successResponse: true, data: { secToken: 'SECTOKEN_CANARY' } }
        // info.json 活着但没有 token：这正是"取不到"的常见形态（会话半失效）。
        // 值全用 canary，好让"骨架只列名字不列值"这条断言真的可证伪。
        : { code: 'INFO_CODE_CANARY', successResponse: true, data: { errorCode: 'INFO_TENANT_CANARY' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { errorCode: 'BailianGateway.Login.NotLogined', errorMsg: 'not logged in' } }))
  })
  const serve = async (infoMode, cookie) => {
    const server = gatewayOf(infoMode)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = server.address().port
      const source = {
        ...consolePreset,
        url: `http://127.0.0.1:${port}/data/api.json`,
        infoUrl: `http://127.0.0.1:${port}/tool/user/info.json`,
        _cookie: cookie,
      }
      const card = await querySource(source, effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), { configured: false })
      return { card, port }
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  }
  const withTicket = 'cna=AAA; login_qianwenai_ticket=TICKET_CANARY'
  const expired = await serve('token', withTicket)
  check('票据与 sec_token 都在仍被拒 → 仍按 NotLogined 报', expired.card.errorCode, 'BailianGateway.Login.NotLogined')
  ok('这一支说清是会话过期，不再断言抄错主机',
    String(expired.card.error).includes('会话多半已过期') && !String(expired.card.error).includes('另一台主机'), expired.card.error)
  const noToken = await serve('no-token', withTicket)
  check('票据在场但 sec_token 取不到 → MissingSecToken', noToken.card.errorCode, 'MissingSecToken')
  ok('MissingSecToken 带上失败原因（info.json 有响应但没 token）', String(noToken.card.error).includes('no-token'), noToken.card.error)
  // 骨架是这一步唯一的下一步线索：分不清"token 改名 / 挪层 / 会话没发 token"时，用户只能瞎重抄 Cookie。
  ok('MissingSecToken 报出 info.json 的键名骨架',
    String(noToken.card.error).includes('data{errorCode}') && String(noToken.card.error).includes('code:string'), noToken.card.error)
  ok('MissingSecToken 不再把责任推给 Cookie', !String(noToken.card.error).includes('另一台主机'), noToken.card.error)
  const busy = await serve('busy', withTicket)
  ok('info.json 非 2xx 时把状态码写进原因（重试即可，不是重抄 Cookie）', String(busy.card.error).includes('http-503'), busy.card.error)
  const noTicket = await serve('no-token', 'cna=AAA; isg=BBB')
  check('缺票据仍按 NotLogined 报（不把 Cookie 的问题伪装成 token 的问题）', noTicket.card.errorCode, 'BailianGateway.Login.NotLogined')
  ok('缺票据那半句照旧说出来', String(noTicket.card.error).includes('没有看到登录票据 login_qianwenai_ticket'), noTicket.card.error)
  for (const one of [expired, noToken, busy, noTicket]) {
    ok('凭据值一律不进文案',
      !String(one.card.error).includes('TICKET_CANARY') && !String(one.card.error).includes('SECTOKEN_CANARY')
      && !String(one.card.error).includes('AAA')
      && !String(one.card.error).includes('INFO_CODE_CANARY') && !String(one.card.error).includes('INFO_TENANT_CANARY'), one.card.error)
  }
  const secHint = String(hintFor('MissingSecToken'))
  ok('MissingSecToken 的提示给出可操作兜底（info.json 与 SECTOKEN 引用名）',
    secHint.includes('user/info.json') && secHint.includes('BAILIAN_CONSOLE_SECTOKEN'), secHint)
  // 提示本身也不许再单断言"另一台主机"：它现在把三条成因并列，具体哪条由错误正文里的诊断决定。
  const cookieHint = String(hintFor('BailianGateway.Login.NotLogined'))
  ok('NotLogined 提示并列三种成因而非只怪抄错主机',
    cookieHint.includes('MissingSecToken') && cookieHint.includes('会话已过期'), cookieHint)
}

/* ============================================ 5c. Moonshot（多区 + 静态币种 + 源级 hint）——新增一家的模板 */

const moonshotDefault = normalizeSources(['moonshot-balance'], ctxStub)[0]
check('默认区＝大陆', moonshotDefault.region, 'china-mainland')
check('区决定 host', moonshotDefault.url, 'https://api.moonshot.cn/v1/users/me/balance')
check('区决定币种（这个端点不回 currency 字段，不能从响应里 pick）', moonshotDefault.unit, 'CNY')
check('Moonshot 打真值标签', moonshotDefault.veracity, 'verified')
check('绑定常见路由名（②做完后由自动识别取代）', moonshotDefault.providers, ['moonshot', 'moonshot-cn', 'moonshot-ai'])

const moonshotIntl = normalizeSources(['moonshot-balance'], ctxStub, { moonshotRegion: 'international' })[0]
check('全局配置键切区', [moonshotIntl.region, moonshotIntl.url, moonshotIntl.unit], ['international', 'https://api.moonshot.ai/v1/users/me/balance', 'USD'])
check('条目显式 region 优先于全局键', normalizeSources([{ id: 'moonshot-balance', region: 'china-mainland' }], ctxStub, { moonshotRegion: 'international' })[0].region, 'china-mainland')
check('用户自己写过的 url 不被区覆盖', normalizeSources([{ id: 'moonshot-balance', url: 'https://proxy.local/me/balance' }], ctxStub)[0].url, 'https://proxy.local/me/balance')
const regionWarns = []
check('认不出的区退回默认值而不是静默', normalizeSources(['moonshot-balance'], { logger: { warn: e => regionWarns.push(String(e.message)) }, get: () => undefined }, { moonshotRegion: 'eu-west' })[0].region, 'china-mainland')
ok('认不出的区必须 warn 并列出可选值', regionWarns.length === 1 && regionWarns[0].includes('eu-west') && regionWarns[0].includes('international'))

const moonshotPayload = { code: 0, status: true, data: { available_balance: 12.34, cash_balance: 10.34, voucher_balance: 2 } }
check('Moonshot 信封：code:0 即成功', httpEnvelopeOk(moonshotPayload), undefined)
const moonshotCard = finalizeCard(buildSingleCard(moonshotIntl, moonshotPayload))
check('available_balance → 余额', moonshotCard.remaining, 12.34)
check('cash/voucher 复用充值/赠款两键（前端标签本来就对得上，不新开特例）', [moonshotCard.extra.toppedUp, moonshotCard.extra.granted], [10.34, 2])
check('币种跟区，卡片自己带', moonshotCard.unit, 'USD')
check('region 随卡下发（要能说清现在打的哪个区）', publicCard(moonshotCard).region, 'international')
check('余额类卡不出百分比（没有分母）', [moonshotCard.usedPercent, moonshotCard.remainingPercent], [undefined, undefined])
const moonshotZero = finalizeCard(buildSingleCard(moonshotIntl, { code: 0, status: true, data: { available_balance: 0, cash_balance: -3.5, voucher_balance: 0 } }))
check('0 余额是真值，不是"没数据"', [moonshotZero.remaining, moonshotZero.emptyReason], [0, undefined])
check('欠款原样带出（不取绝对值粉饰）', moonshotZero.extra.toppedUp, -3.5)
check('401 走源级提示，指向"切区"这个真原因', hintFor('401', moonshotIntl.errorHints).includes('moonshotRegion'), true)
ok('源级提示不污染别家（DeepSeek 拿不到 Moonshot 的切区文案）', !String(hintFor('401', PRESETS['deepseek-balance'].errorHints) ?? '').includes('moonshotRegion'))
check('errorHints 只参与算 hint，不进任何响应', 'errorHints' in publicCard({ id: 'x', errorHints: { 401: 'secret-shape' } }), false)
// 非 0 信封不能静默成"无数据"：parseEnvelope 要抛成带码的 SourceError，卡片才有 401/切区提示。
let envelopeThrew = null
try { parseEnvelope(JSON.stringify({ code: -1, status: false, message: 'invalid_api_key' }), 'moonshot-balance', httpEnvelopeOk) } catch (error) { envelopeThrew = error }
check('非 0 信封抛错：码是原码，人话里带上源与上游 message', [envelopeThrew?.code, envelopeThrew?.message], ['-1', 'moonshot-balance: -1 invalid_api_key'])

/* ============================================ 5d. derive 派生表达式（OpenRouter：余额＝充值 − 花费） */

const dvals = { totalCredits: 10, totalUsage: 3.25, zero: 0 }
check('裸引用名', evalDerive('totalCredits', dvals), 10)
check('一次减法', evalDerive('totalCredits - totalUsage', dvals), 6.75)
check('一次加法', evalDerive('totalUsage + totalCredits', dvals), 13.25)
check('数字字面量参与', evalDerive('100 - totalCredits', dvals), 90)
check('引用 0 是真值不是缺失', evalDerive('totalCredits - zero', dvals), 10)
check('引用不到就是 undefined（宁缺勿猜）', evalDerive('totalCredits - nope', dvals), undefined)
check('不做乘除', evalDerive('totalCredits * 2', dvals), undefined)
check('不做三项连算', evalDerive('a - b - c', dvals), undefined)
check('不做括号/表达式引擎', evalDerive('(totalCredits - totalUsage) * 2', dvals), undefined)
check('空算式', evalDerive('', dvals), undefined)

const openrouter = normalizeSources(['openrouter-credits'], ctxStub)[0]
check('OpenRouter 打真值标签', openrouter.veracity, 'verified')
check('端点与凭据引用', [openrouter.url, openrouter.bearerRef, openrouter.unit], ['https://openrouter.ai/api/v1/credits', 'OPENROUTER_API_KEY', 'USD'])
check('差值算式随预设下发', openrouter.derive.remaining, 'totalCredits - totalUsage')
// 官方文档里这个端点的字段既见过裸顶层也见过 data 信封，两版都要能抽（不猜哪版对）。
const orDataEnvelope = finalizeCard(buildSingleCard(openrouter, { data: { total_credits: 10, total_usage: 3.25 } }))
check('data 信封：余额＝10 − 3.25', [orDataEnvelope.remaining, orDataEnvelope.total, orDataEnvelope.used], [6.75, 10, 3.25])
check('差值也参与百分比', [orDataEnvelope.usedPercent, orDataEnvelope.remainingPercent], [32.5, 67.5])
const orFlatEnvelope = finalizeCard(buildSingleCard(openrouter, { total_credits: 10, total_usage: 3.25 }))
check('裸顶层信封同解', [orFlatEnvelope.remaining, orFlatEnvelope.total], [orDataEnvelope.remaining, orDataEnvelope.total])
const orZeroUsage = finalizeCard(buildSingleCard(openrouter, { data: { total_credits: 25, total_usage: 0 } }))
check('没花过钱：0 不是缺数据', [orZeroUsage.remaining, orZeroUsage.used, orZeroUsage.usedPercent], [25, 0, 0])
const orDebt = finalizeCard(buildSingleCard(openrouter, { data: { total_credits: 5, total_usage: 7.5 } }))
check('花超了原样报负余额（不夹到 0 粉饰）', orDebt.remaining, -2.5)
check('负余额时已用比例封顶 100%、剩余 0%', [orDebt.usedPercent, orDebt.remainingPercent], [150, 0])
const orEmpty = finalizeCard(buildSingleCard(openrouter, { data: { foo: 1 } }))
check('抽不到字段时空因要点名引用名', orEmpty.emptyReason.includes('totalCredits'), true)
check('抽不到就是没有，不派生出 0', [orEmpty.remaining, orEmpty.total, orEmpty.used], [undefined, undefined, undefined])
check('OpenRouter 401 提示说清要的是它自己的 Key', hintFor('401', openrouter.errorHints).includes('sk-or-v1'), true)

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
// 提示里点名的域名必须是插件**真的会打**的那台主机。2026-10-06 的实机截图就是反例：
// 提示让人在 Network 里筛 bailian-cs，而预设打的是 cs-data.qianwenai.com —— 筛出来一条都没有，
// 用户永远抄不对 Cookie（提示指向错域名 = 这条错误永远修不好）。
{
  const cookieHint = String(hintFor('BailianGateway.Login.NotLogined'))
  const consoleHost = new URL(PRESETS['token-plan-console'].url).host
  ok('Cookie 失效提示指向预设实际调用的主机', cookieHint.includes(consoleHost), cookieHint)
  ok('Cookie 失效提示不再指向插件从不调用的控制台域名', !cookieHint.includes('console.aliyun.com'), cookieHint)
}

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

/* ====== 13b. 上游把请求原样回显时，凭据不得随 message / raw 出网（CWE-209） ====== */

// 为什么要有这一组：`raw` 早先按值脱敏了，但 `SourceError` 的 **message** 没有——而 message 同样
// 会随卡片（`card.error`）与 `/probe`（`error: error.message`）出网。真实的注入拦截/WAF 就爱把
// 收到的 `Authorization` 原样写进错误体，报错信息里于是躺着真 Key。
const echoed = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Invalid Authentication: ${req.headers.authorization ?? ''}`, type: 'invalid_authentication_error' } }))
  })
})
await new Promise(resolve => echoed.listen(0, '127.0.0.1', resolve))
const echoPort = echoed.address().port
try {
  const echoConfig = effectiveConfig({ timeoutMs: 5000, minIntervalMs: 0, debug: true }, ctxStub)
  const echoSource = { ...normalizeSources(['deepseek-balance'], ctxStub)[0], url: `http://127.0.0.1:${echoPort}/user/balance`, _bearer: 'sk-echo-secret-1234567890' }
  const echoCard = await querySource(echoSource, echoConfig, { configured: false })
  ok('上游回显请求：卡片 error 里不出现凭据值',
    echoCard.error !== null && !String(echoCard.error).includes('sk-echo-secret-1234567890'), String(echoCard.error))
  ok('上游回显请求：raw 里也不出现凭据值（debug 打开时才带 raw，正好在这里核）',
    echoCard.raw !== undefined && !String(echoCard.raw).includes('sk-echo-secret-1234567890'), String(echoCard.raw))
  // 对照两条：边界不是魔法——不传 secrets 就不脱敏，所以调用点必须把手头的凭据传进来。
  const noCtx = new __internals.SourceError('X', 'leak sk-echo-secret-1234567890', 's', 'raw sk-echo-secret-1234567890')
  ok('SourceError 不传 secrets 时不脱敏（把这条契约钉住）', String(noCtx.message).includes('sk-echo-secret-1234567890'))
  const withCtx = new __internals.SourceError('X', 'leak sk-echo-secret-1234567890', 's', 'raw sk-echo-secret-1234567890', ['sk-echo-secret-1234567890'])
  ok('SourceError 传了 secrets 则 message 与 raw 一起脱敏',
    !String(withCtx.message).includes('sk-echo-secret-1234567890') && !String(withCtx.raw).includes('sk-echo-secret-1234567890'),
    String(withCtx.message))
} finally {
  await new Promise(resolve => echoed.close(resolve))
}

/* ============================================ 14. HTTP 4xx 的人话 + 源级提示（Moonshot 形态） */

const seenM = []
const serverM = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    seenM.push({ url: req.url, authorization: req.headers.authorization ?? null })
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, status: true, data: { available_balance: 8.5, cash_balance: 8.5, voucher_balance: 0 } }))
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } }))
  })
})
await new Promise(resolve => serverM.listen(0, '127.0.0.1', resolve))
const portM = serverM.address().port
try {
  const httpConfig = effectiveConfig({ timeoutMs: 5000, minIntervalMs: 0 }, ctxStub)
  const moonshotLive = normalizeSources(['moonshot-balance'], ctxStub, { moonshotRegion: 'international' })[0]
  const okCard = await querySource({ ...moonshotLive, url: `http://127.0.0.1:${portM}/ok`, _bearer: 'sk-m' }, httpConfig, { configured: false })
  check('Moonshot 全链路产出余额卡', [okCard.remaining, okCard.unit, okCard.region], [8.5, 'USD', 'international'])
  check('Bearer 真的发出去了', seenM[0].authorization, 'Bearer sk-m')
  const denied = await querySource({ ...moonshotLive, url: `http://127.0.0.1:${portM}/denied`, _bearer: 'sk-m' }, httpConfig, { configured: false })
  check('4xx 卡片捞上游人话，不只报状态码', denied.error, 'moonshot-balance: 401 HTTP 401 · Invalid Authentication')
  check('错误码原样保留', denied.errorCode, '401')
  ok('提示指向"切区"这个真原因（源级 errorHints）', String(denied.hint).includes('moonshotRegion'))
  check('错误卡也带区（否则用户不知道刚才打的是哪个 host）', denied.region, 'international')
  check('errorHints 只参与算提示，不进响应', 'errorHints' in publicCard(denied), false)
} finally {
  await new Promise(resolve => serverM.close(resolve))
}

/* ============================================ 15. 自动检测（纯函数层，不需要任何真 Key） */

const { detectSources, PLATFORM_RULES, hostOf } = await import('../lib/detect.js')

check('hostOf 取裸 host', hostOf('https://api.moonshot.cn/v1/users/me/balance'), 'api.moonshot.cn')
check('hostOf 去端口与凭据', hostOf('https://u:p@Gateway.Example.com:8443/v1'), 'gateway.example.com')
check('hostOf 空值不抛', [hostOf(''), hostOf(undefined), hostOf(null)], ['', '', ''])

const one = result => result.sources[0]
const qwen = detectSources({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen Token Plan' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } },
})
check('千问网关认出两路源（官方余量 + 实测兜底）', qwen.sources.map(s => s.id).sort(), ['token-plan-console', 'token-plan-window'])
check('按 baseURL 命中（最可信的一条）', one(qwen).detected, { by: 'baseURL', rule: 'qwen-token-plan', host: 'token-plan.cn-beijing.maas.aliyuncs.com' })
check('绑到实际路由而不是手填别名', qwen.sources.every(s => s.providers.join() === 'qwen-token-plan-cn'), true)

// DeepSeek：出厂路由 id 是 deepseek-official，而旧配置手填的是 'deepseek' —— 漂移的活例。
const ds = detectSources({ routes: [{ id: 'deepseek-official', name: 'DeepSeek' }], profiles: {} })
check('出厂路由 id 也能靠关键词认出', ds.sources.map(s => s.id), ['deepseek-balance'])
check('命中依据记为 routeId（可解释性）', one(ds).detected.by, 'routeId')

const moonCn = detectSources({ routes: [{ id: 'moon', name: 'Moon' }], profiles: { moon: { baseURL: 'https://api.moonshot.cn/v1' } } })
check('host 直接决定区（省一次配置）', one(moonCn).region, 'china-mainland')
const moonAi = detectSources({ routes: [{ id: 'moon', name: 'Moon' }], profiles: { moon: { baseURL: 'https://api.moonshot.ai/v1' } } })
check('国际 host 给国际区', one(moonAi).region, 'international')

const orPrefix = detectSources({ routes: [{ id: 'relay', name: 'Relay' }], profiles: { relay: { keyValue: 'sk-or-v1-abcdef' } } })
check('拿不到 baseURL 时靠 Key 前缀兜', [one(orPrefix).id, one(orPrefix).detected.by], ['openrouter-credits', 'keyPrefix'])
// 优先级：id 说自己是 deepseek、host 说自己是 openrouter → 信 host（路由打到哪才算数）。
const conflict = detectSources({
  routes: [{ id: 'deepseek-looking-glass', name: 'deepseek' }],
  profiles: { 'deepseek-looking-glass': { baseURL: 'https://openrouter.ai/api/v1' } },
})
check('baseURL 压过 id 关键词', [one(conflict).id, one(conflict).detected.by], ['openrouter-credits', 'baseURL'])

check('凭据缺失 → 这个源整个不开（不挂错误卡占位）', detectSources({
  routes: [{ id: 'deepseek-official' }], profiles: {}, hasCredential: () => false,
}).sources.length, 0)
const partly = detectSources({
  routes: [{ id: 'ds-a' }, { id: 'ds-b' }],
  profiles: { 'ds-a': { baseURL: 'https://api.deepseek.com' }, 'ds-b': { baseURL: 'https://api.deepseek.com' } },
  hasCredential: (preset, route) => route !== 'ds-b',
})
check('同一家多条路由：只挂有凭据的那些', one(partly).providers, ['ds-a'])
ok('没凭据的那条进 skipped 并写明原因', partly.skipped.some(s => s.route === 'ds-b' && s.reason === 'no-credential'))

check('用户已覆盖的路由，检测一概不追加', detectSources({
  routes: [{ id: 'qwen-token-plan-cn' }], profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x' } },
  coveredRoutes: ['qwen-token-plan-cn'],
}).sources.length, 0)

const unknown = detectSources({ routes: [{ id: 'sglang-prod', name: 'SGLang' }], profiles: {} })
check('认不出的路由挂实测窗口（徽标不空）', unknown.sources.map(s => s.id), ['window:sglang-prod'])
check('窗口源标 fallback 依据，与规则命中区分开', one(unknown).detected, { by: 'fallback-window', rule: null, host: null })
check('窗口源绑的就是那条路由', one(unknown).providers, ['sglang-prod'])
ok('uncovered 列表把没认出的都交出来', unknown.uncovered.join() === 'sglang-prod')

// 反例：认错的数比没有数恶劣。这几条必须"不开"。
check('kimi 订阅路由不许冒充 Kimi 开放平台（端点不同）', detectSources({ routes: [{ id: 'kimi', name: 'Kimi' }], profiles: {} }).sources.map(s => s.id), ['window:kimi'])
check('hostOf 不裁域名（反代站保留完整 host）', hostOf('https://api.moonshot.cn.evil.test/v1'), 'api.moonshot.cn.evil.test')
check('后缀不许反向瞎撞：认不出就走实测窗口', detectSources({
  routes: [{ id: 'x' }], profiles: { x: { baseURL: 'https://api.moonshot.cn.evil.test/v1' } },
}).sources[0].id, 'window:x')
check('自建网关路径里带官方域名不算命中', detectSources({
  routes: [{ id: 'gw' }], profiles: { gw: { baseURL: 'https://gw.internal/proxy/api.moonshot.cn/v1' } },
}).sources[0].id, 'window:gw')
check('规则表里每个 preset 名都真实存在于 PRESETS', PLATFORM_RULES.every(rule => rule.presets.every(preset => PRESETS[preset] !== undefined)), true)
check('空输入不炸', detectSources({ routes: [], profiles: {} }), { sources: [], skipped: [], uncovered: [] })

// 名字像不是一回事：本地代理路由只是名字里带了别家牌子，有 baseURL 就只信 baseURL。
const proxied = detectSources({
  routes: [{ id: 'deepseek-modlens', name: 'DeepSeek via Modlens' }],
  profiles: { 'deepseek-modlens': { baseURL: 'http://127.0.0.1:8787/v1' } },
})
check('有 baseURL 时不许按路由名冒充别家（这就是"两个余量窗口"的根因）', proxied.sources.map(s => s.id), ['window:deepseek-modlens'])
check('被代理的路由落进 uncovered，可诊断', proxied.uncovered, ['deepseek-modlens'])
check('代理过的 Token Plan 路由也不顶官方卡', detectSources({
  routes: [{ id: 'modlens-qwen-token-plan-cn' }],
  profiles: { 'modlens-qwen-token-plan-cn': { baseURL: 'http://127.0.0.1:8787/v1' } },
}).sources[0].id, 'window:modlens-qwen-token-plan-cn')
// 完全拿不到 baseURL 时（出厂适配器不写 settings 分节）才降级信路由名——deepseek-official 就是这种。
check('拿不到 baseURL 才降级用路由名', detectSources({ routes: [{ id: 'deepseek-official' }], profiles: {} }).sources[0].detected.by, 'routeId')

/* ============================================ 16. 自动检测接线（假宿主：llm + settings + credentials） */

const { applyAutoDetect, readRouteProfile, credentialRefsFor } = __internals

/** 造一个有 llm/settings/credentials 三个服务的宿主替身。 */
function fakeHost({ routes, profiles = {}, refs = {} }) {
  const section = { providers: profiles }
  return {
    logger: { warn() {}, info() {}, error() {} },
    get: name => {
      if (name === 'llm') {
        return {
          listProviders: () => routes,
          listConfigurableProviders: () => routes.map(route => ({
            provider: route.id, displayName: route.name ?? route.id,
            settingsNs: 'llm-pi-ai', settingsPath: ['providers', route.id], declared: true,
          })),
        }
      }
      if (name === 'settings') return { get: () => section }
      if (name === 'credentials') return { resolve: async ref => (refs[ref] === undefined ? undefined : { value: refs[ref], source: 'stub' }) }
      return undefined
    },
  }
}

check('settingsPath 挖到 profile 的 baseURL/apiKeyEnv', readRouteProfile({ get: () => ({ providers: { a: { baseURL: 'https://x/v1', apiKeyEnv: 'A_KEY' } } }) }, { provider: 'a', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'a'] }), { baseURL: 'https://x/v1', apiKeyEnv: 'A_KEY' })
check('settingsPath 只指到 providers 根时也按路由名再挖一层', readRouteProfile({ get: () => ({ providers: { a: { baseURL: 'https://y/v1' } } }) }, { provider: 'a', settingsNs: 'llm-pi-ai', settingsPath: ['providers'] }).baseURL, 'https://y/v1')
check('没注册 settings 服务时不抛（老宿主）', readRouteProfile(undefined, { provider: 'a', settingsNs: 'llm-pi-ai', settingsPath: [] }), undefined)
check('Cookie 型源不认路由 Key（拿套餐 Key 当 Cookie 只会得到误导的错误卡）', credentialRefsFor(PRESETS['token-plan-console'], { apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' }), ['BAILIAN_CONSOLE_COOKIE'])
check('Bearer 型源优先用路由点名的引用名', credentialRefsFor(PRESETS['moonshot-balance'], { apiKeyEnv: 'MOONSHOT_CN_API_KEY' }), ['MOONSHOT_CN_API_KEY', 'MOONSHOT_API_KEY'])

const hostCfg = () => effectiveConfig({ sources: [], minIntervalMs: 0 }, ctxStub)

// C 档：有路由、没规则命中 → 自动挂实测窗口（这就是本机 minimax-cn 的处境）。
const gapCfg = hostCfg()
const gapInfo = await applyAutoDetect(gapCfg, fakeHost({ routes: [{ id: 'minimax-cn', name: 'MiniMax' }], profiles: { 'minimax-cn': { baseURL: 'https://api.minimaxi.cn/v1', apiKeyEnv: 'MINIMAX_CN_API_KEY' } }, refs: { MINIMAX_CN_API_KEY: 'k' } }))
check('认不出的在用路由自动挂实测窗口', gapCfg.sources.map(source => `${source.id}:${(source.providers ?? []).join(',')}`), ['window:minimax-cn:minimax-cn'])
check('诊断块交代依据与 uncovered', [gapInfo.added[0].by, gapInfo.uncovered], ['fallback-window', ['minimax-cn']])
check('窗口源不需要凭据也能开（本地账本）', gapInfo.skipped.length, 0)
const twice = await applyAutoDetect(gapCfg, fakeHost({ routes: [{ id: 'minimax-cn' }] }))
check('重复跑不叠加同源（幂等）', gapCfg.sources.length, 1)
check('第二次跑视为已被用户源覆盖，不再追加', twice.added.length, 0)

// A 档：host 命中规则 + 路由点名的凭据在 → 开官方源，区也带上。
const moonCfg = hostCfg()
await applyAutoDetect(moonCfg, fakeHost({
  routes: [{ id: 'kimi-open-cn', name: 'Kimi Open' }],
  profiles: { 'kimi-open-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_CN_API_KEY' } },
  refs: { MOONSHOT_CN_API_KEY: 'sk-cn' },
}))
check('按 host 开出 Moonshot 源', moonCfg.sources.map(source => source.id), ['moonshot-balance'])
check('区由 host 决定', moonCfg.sources[0].region, 'china-mainland')
check('凭据引用沿用 profile 点名的那个', moonCfg.sources[0].bearerRef, 'MOONSHOT_CN_API_KEY')
check('识别依据留在源上（卡片可解释）', moonCfg.sources[0].detected.by, 'baseURL')

// 凭据解析不到 → 这个源整个不开，只在诊断里留痕。
const noKeyCfg = hostCfg()
const noKeyInfo = await applyAutoDetect(noKeyCfg, fakeHost({
  routes: [{ id: 'ds', name: 'DeepSeek' }],
  profiles: { ds: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  refs: {},
}))
check('没凭据 → 不开源（不挂错误卡占地方）', noKeyCfg.sources.length, 0)
check('跳过原因与试过的引用名都记着', [noKeyInfo.skipped[0].reason, noKeyInfo.skipped[0].tried], ['no-credential', ['DEEPSEEK_API_KEY']])

// 用户写过的源：检测不越权。
const userCfg = effectiveConfig({ sources: [{ id: 'token-plan-window', providers: ['qwen-token-plan-cn'] }], minIntervalMs: 0 }, ctxStub)
await applyAutoDetect(userCfg, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x', BAILIAN_CONSOLE_COOKIE: 'c' },
}))
check('用户已覆盖的路由，检测一个源都不加', userCfg.sources.length, 1)
check('原本的用户源保持不动', [userCfg.sources[0].id, userCfg.sources[0].detected], ['token-plan-window', undefined])

/* 「这张卡我不看」——外人最常有的配置诉求，必须有正面答案，且不能靠关整个检测。 */
const kimiHost = () => fakeHost({
  routes: [{ id: 'kimi-open-cn', name: 'Kimi Open' }],
  profiles: { 'kimi-open-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_CN_API_KEY' } },
  refs: { MOONSHOT_CN_API_KEY: 'sk-cn' },
})
const noMoonCfg = effectiveConfig({ sources: [{ id: 'moonshot-balance', enabled: false }], minIntervalMs: 0 }, ctxStub)
const noMoonInfo = await applyAutoDetect(noMoonCfg, kimiHost())
check('enabled:false 的条目不进源列表', noMoonCfg.sources.length, 0)
check('关掉的源名交给检测（disabledSources）', noMoonCfg.disabledSources, ['moonshot-balance'])
check('检测不再把被关的源补回来', noMoonInfo.added.length, 0)
check('为什么没开在诊断里说清', noMoonInfo.skipped[0].reason, 'disabled-by-config')
const onCfg = hostCfg()
await applyAutoDetect(onCfg, kimiHost())
check('对照组：同样的宿主没写这条就照常开出源', onCfg.sources.map(source => source.id), ['moonshot-balance'])

// 文档写死的不对称：关掉"已认出"厂家的唯一源 = 这家没卡；实测兜底只挂在认不出的路由上。
const twoVendorHost = () => fakeHost({
  routes: [{ id: 'ds', name: 'DeepSeek' }, { id: 'minimax-cn', name: 'MiniMax' }],
  profiles: {
    ds: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
    'minimax-cn': { baseURL: 'https://api.minimaxi.cn/v1', apiKeyEnv: 'MINIMAX_CN_API_KEY' },
  },
  refs: { DEEPSEEK_API_KEY: 'sk-d', MINIMAX_CN_API_KEY: 'sk-m' },
})
const mixedOff = effectiveConfig({ sources: [{ id: 'deepseek-balance', enabled: false }], minIntervalMs: 0 }, ctxStub)
await applyAutoDetect(mixedOff, twoVendorHost())
check('关掉已认出厂家的唯一源，不补实测窗口', mixedOff.sources.map(source => source.id), ['window:minimax-cn'])
check('排除项是叠加层：不会把别家自动卡清掉', mixedOff.sources.length, 1)
const mixedOn = hostCfg()
await applyAutoDetect(mixedOn, twoVendorHost())
check('对照组：不写排除项时两家都有卡', mixedOn.sources.map(source => source.id).sort(), ['deepseek-balance', 'window:minimax-cn'])

const qwenHost = () => fakeHost({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x', BAILIAN_CONSOLE_COOKIE: 'c' },
})
const qwenOff = effectiveConfig({ sources: [{ id: 'token-plan-console', enabled: false }], minIntervalMs: 0 }, ctxStub)
await applyAutoDetect(qwenOff, qwenHost())
check('关一条源不牵连同路由的实测窗口（关源 ≠ 关供应商）', qwenOff.sources.map(source => source.id), ['token-plan-window'])
const qwenOn = hostCfg()
await applyAutoDetect(qwenOn, qwenHost())
check('对照组：没关时官方源与兜底按规则各归其位', qwenOn.sources.map(source => source.id).includes('token-plan-console'), true)

const autoWinCfg = effectiveConfig({ sources: [{ id: 'window:minimax-cn', enabled: false }], minIntervalMs: 0 }, ctxStub)
const autoWinInfo = await applyAutoDetect(autoWinCfg, fakeHost({ routes: [{ id: 'minimax-cn', name: 'MiniMax' }], profiles: { 'minimax-cn': { baseURL: 'https://api.minimaxi.cn/v1' } }, refs: {} }))
check('自动挂的实测窗口可按 window:<路由> 点名关掉', autoWinCfg.sources.length, 0)
check('关掉兜底也在诊断里留痕', autoWinInfo.skipped[0].reason, 'disabled-by-config')
const autoWinOn = hostCfg()
await applyAutoDetect(autoWinOn, fakeHost({ routes: [{ id: 'minimax-cn', name: 'MiniMax' }], profiles: { 'minimax-cn': { baseURL: 'https://api.minimaxi.cn/v1' } }, refs: {} }))
check('对照组：不写这条时兜底窗口照常挂上', autoWinOn.sources.map(source => source.id), ['window:minimax-cn'])

/* 绑定漂移：手写源写了 providers 却没有一条对得上在用路由 → panelScope:current 下
   卡查得到但永远不露面（本项目犯过的老错，这次要在日志里说出来，而不是让用户排查半天）。 */
const { warnUnboundSources, unboundWarned } = __internals
const bindWarns = []
const bindCtx = { logger: { warn: e => bindWarns.push(String(e.message)) }, get: () => undefined }
const kimiOnly = [{ id: 'kimi-open-cn' }]
unboundWarned.clear()
warnUnboundSources({ sources: normalizeSources(['moonshot-balance'], bindCtx) }, kimiOnly, bindCtx)
check('providers 落空的手写源会提醒（预设名不等于路由 id）', bindWarns.length, 1)
ok('提醒里给出两条出路', bindWarns[0].includes('panelScope') && bindWarns[0].includes('路由 id'))
warnUnboundSources({ sources: normalizeSources(['moonshot-balance'], bindCtx) }, kimiOnly, bindCtx)
check('同一组合只提醒一次（每次快照都跑，不能刷屏）', bindWarns.length, 1)
warnUnboundSources({ sources: normalizeSources(['moonshot-balance'], bindCtx) }, [{ id: 'moonshot-cn' }], bindCtx)
check('路由对上了就不提醒', bindWarns.length, 1)
warnUnboundSources({ sources: normalizeSources([{ id: 'my-src', url: 'https://x/y', providers: ['Kimi.Open/CN'] }], bindCtx) }, kimiOnly, bindCtx)
check('按同一套归一化比较（大小写与 ._/ 一视同仁）', bindWarns.length, 1)
warnUnboundSources({ sources: normalizeSources(['account-balance'], bindCtx) }, kimiOnly, bindCtx)
check('没写 providers 的源（阿里云那几条）保持安静', bindWarns.length, 1)
unboundWarned.clear()

// 回归锁：Cookie 型源绝不能被写成 bearerRef，否则查询先撞 Bearer 门，报
// "未配置凭据 BAILIAN_CONSOLE_COOKIE（…设同名环境变量）"——Cookie 明明在，却被叫去配 Key。
const cookieCfg = hostCfg()
await applyAutoDetect(cookieCfg, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { BAILIAN_CONSOLE_COOKIE: 'cookie', QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x' },
}))
const openedConsole = cookieCfg.sources.find(source => source.id === 'token-plan-console')
check('检测开的 Cookie 源不带 bearerRef', openedConsole.bearerRef, undefined)
check('Cookie 源仍走 cookieRef', openedConsole.cookieRef, 'BAILIAN_CONSOLE_COOKIE')
const noCookieCard = await querySource({ ...openedConsole, _cookie: undefined }, effectiveConfig({ minIntervalMs: 0 }, ctxStub), { configured: false })
ok('Cookie 缺失的提示说的是 Cookie，不是"设同名环境变量"那套 Key 文案',
  String(noCookieCard.error).includes('Cookie') && !String(noCookieCard.error).includes('设同名环境变量'))
const stray = await querySource({ id: 'x-console', type: 'http', builder: 'token-plan-console', cookieRef: 'BAILIAN_CONSOLE_COOKIE', bearerRef: 'BAILIAN_CONSOLE_COOKIE', label: 'x', providers: [] }, effectiveConfig({ minIntervalMs: 0 }, ctxStub), { configured: false })
ok('就算 bearerRef 被误写，Cookie 型源也不该撞 Bearer 门', !String(stray.error).startsWith('未配置凭据'))
// Bearer 型源不受影响：Moonshot 仍沿用路由点名的引用名。
const moonCfg2 = hostCfg()
await applyAutoDetect(moonCfg2, fakeHost({
  routes: [{ id: 'kimi-cn' }],
  profiles: { 'kimi-cn': { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_CN_API_KEY' } },
  refs: { MOONSHOT_CN_API_KEY: 'sk-cn' },
}))
check('Bearer 型源照旧沿用路由点名的引用名', moonCfg2.sources[0].bearerRef, 'MOONSHOT_CN_API_KEY')

// 千问这种"一家两路源"：两路都开，实测路带 fallback 标记——**收不收由看得见数据的那层决定**。
const qwenCfg = hostCfg()
const qwenInfo = await applyAutoDetect(qwenCfg, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { BAILIAN_CONSOLE_COOKIE: 'cookie', QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x' },
}))
check('两路源都开（不在规划期砍兜底）', qwenCfg.sources.map(source => source.id).sort(), ['token-plan-console', 'token-plan-window'])
check('实测窗带 fallback 标记，官方源不带', qwenCfg.sources.map(source => `${source.id}=${source.detected?.fallback === true ? 'fallback' : 'primary'}`).sort(), ['token-plan-console=primary', 'token-plan-window=fallback'])
check('不再有"规划期就断定官方有数"的跳过', qwenInfo.skipped.length, 0)
// 同一规则在工具摘要里也要成立：模型读到的文本不能和面板看到的两样。
const qwenOfficialCard = { id: 'token-plan-console', label: 'Token Plan 余量', veracity: 'verified', metric: 'credits', unit: 'Credits', remaining: 1500, total: 4000, usedPercent: 62.5, bindProviders: ['qwen-token-plan-cn'] }
const qwenMeasuredCard = { id: 'token-plan-window', label: 'Token Plan 实测', estimated: true, veracity: 'local', metric: 'count', tokens: 1234567, calls: 42, windowDays: 7, bindProviders: ['qwen-token-plan-cn'], detected: { fallback: true } }
check('官方有数 → 摘要不重复报实测行', summarizeText({ generatedAt: Date.now(), refreshMinutes: 10, notices: [], cards: [qwenOfficialCard, qwenMeasuredCard] }).includes('本实例实测，非官方余量'), false)
check('官方变错误卡（Cookie 过期）→ 实测行必须回来', summarizeText({
  generatedAt: Date.now(), refreshMinutes: 10, notices: [],
  cards: [{ ...qwenOfficialCard, remaining: undefined, total: undefined, usedPercent: undefined, error: '未配置凭据', errorCode: 'NoCredentials' }, qwenMeasuredCard],
}).includes('本实例实测，非官方余量'), true)
check('用户手写的实测源（没有 fallback 标记）永远照报', summarizeText({
  generatedAt: Date.now(), refreshMinutes: 10, notices: [],
  cards: [qwenOfficialCard, { ...qwenMeasuredCard, detected: undefined }],
}).includes('本实例实测，非官方余量'), true)
check('规则表把实测窗标成兜底', detectSources({
  routes: [{ id: 'qwen-token-plan-cn' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x' } },
}).sources.map(s => `${s.id}:${s.fallback === true ? 'fallback' : 'primary'}`).sort(), ['token-plan-console:primary', 'token-plan-window:fallback'])
// Cookie 掉了：官方余量不开，实测窗口还在（徽标不至于空）。
const qwenNoCookie = hostCfg()
await applyAutoDetect(qwenNoCookie, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn', name: 'Qwen' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x' },
}))
check('Cookie 没配 → 只留实测窗卡', qwenNoCookie.sources.map(source => source.id), ['token-plan-window'])

// autoDetect=false 与老宿主退回。
const offCfg = effectiveConfig({ sources: ['deepseek-balance'], autoDetect: false }, ctxStub)
const offInfo = await applyAutoDetect(offCfg, fakeHost({ routes: [{ id: 'minimax-cn' }], profiles: {} }))
check('autoDetect=false 一切照旧', [offCfg.sources.length, offInfo.enabled, offInfo.reason.startsWith('autoDetect=false')], [1, false, true])
const legacyCfg = hostCfg()
const legacyInfo = await applyAutoDetect(legacyCfg, ctxStub)
check('老宿主（没有 llm 服务）静默退回，不抛', [legacyInfo.enabled, legacyCfg.sources.length], [false, 0])
ok('退回原因写清是宿主缺服务', String(legacyInfo.reason).includes('llm'))

// 实测窗卡不需要凭据（它是本地账本），也不该被算成"缺凭据所以不开"。
const winNoCred = hostCfg()
const winNoCredInfo = await applyAutoDetect(winNoCred, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn' }],
  profiles: { 'qwen-token-plan-cn': { baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/x', apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x' },
}))
check('Cookie 没配时实测窗仍开（它就是凭据缺席的兜底）', winNoCred.sources.map(source => source.id), ['token-plan-window'])
check('实测源不需要凭据，credentialRef 就是 null', winNoCred.sources[0].detected.credentialRef, null)
ok('不把"这个源本来就不看凭据"误记成 no-credential',
  !winNoCredInfo.skipped.some(row => row.preset === 'token-plan-window' && row.reason === 'no-credential'))
ok('官方余量那路才是真缺凭据，跳过原因写清楚',
  winNoCredInfo.skipped.some(row => row.preset === 'token-plan-console' && row.reason === 'no-credential'))

// 同名源只能有一张：另一条路由也命中同一预设时，让它让路而不是再开一张卡。
const dupCfg = effectiveConfig({ sources: [{ id: 'token-plan-console', providers: ['qwen-token-plan-cn'] }], minIntervalMs: 0 }, ctxStub)
const dupInfo = await applyAutoDetect(dupCfg, fakeHost({
  routes: [{ id: 'qwen-token-plan-cn' }, { id: 'qwen-second', name: 'qwen-token-plan-cn-2' }],
  profiles: { 'qwen-second': { apiKeyEnv: 'QWEN_TOKEN_PLAN_CN_API_KEY' } },
  refs: { QWEN_TOKEN_PLAN_CN_API_KEY: 'sk-sp-x', BAILIAN_CONSOLE_COOKIE: 'cookie' },
}))
check('检测不许开出第二个同名源（面板两张卡 + 缓存互覆盖就是这么来的）', dupCfg.sources.filter(source => source.id === 'token-plan-console').length, 1)
ok('让路的原因记进 skipped', dupInfo.skipped.some(s => s.reason === 'id-taken-by-configured'))
check('用户写的 providers 一个字都不动', dupCfg.sources[0].providers, ['qwen-token-plan-cn'])

// 用户自己在 JSON 里写重名，也要当场说一句（否则症状要等到面板上叠卡才发现）。
const dupWarns = []
normalizeSources(['deepseek-balance', 'deepseek-balance'], { logger: { warn: e => dupWarns.push(String(e.message)) }, get: () => undefined })
ok('重复 id 有 warn 且给出解法（起别名）', dupWarns.length === 1 && dupWarns[0].includes('deepseek-balance-intl'))

// 全链路：快照里能看见检测的痕迹（卡片带 detected，config.sources 带 detected）。
const e2eHost = fakeHost({
  routes: [{ id: 'minimax-cn', name: 'MiniMax' }],
  profiles: { 'minimax-cn': { baseURL: 'https://api.minimaxi.cn/v1', apiKeyEnv: 'MINIMAX_CN_API_KEY' } },
  refs: { MINIMAX_CN_API_KEY: 'k' },
})
const e2eSnap = await buildStatus(effectiveConfig({ sources: [], showInstanceWindow: false }, e2eHost), e2eHost, { fresh: true })
check('快照带自动检测出的卡', e2eSnap.cards.map(card => card.id), ['window:minimax-cn'])
check('卡片带识别依据', e2eSnap.cards[0].detected.by, 'fallback-window')
check('快照的 detection 块可诊断', [e2eSnap.detection.enabled, e2eSnap.detection.uncovered], [true, ['minimax-cn']])
check('config 回显也带 detected（排查时能对上）', e2eSnap.config.sources[0].detected.by, 'fallback-window')
check('detection 里没有密钥字段', JSON.stringify(e2eSnap.detection).includes('sk-'), false)
resetInstanceState()

/* --- CHANGELOG 抽取器（publish.yml 建 GitHub Release 用它拿正文） -------------- */
// 这里只测纯函数（不 spawn node）：抽错节 = 发出去的公告正文挂到别的版本下面，
// 是最难事后发现的一种漂。所有断言都对着真实 CHANGELOG 跑，不造假数据。
// 用 fileURLToPath 而不是 import.meta.dirname —— 后者要 Node 20.11+，本仓 engines 写的是 >=20。
const { extract } = await import('../scripts/extract-changelog-section.mjs')
const changelogText = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const sec45 = extract(changelogText, '0.4.5')
ok('抽取器拿到 0.4.5 这一节（非空）', typeof sec45 === 'string' && sec45.length > 200)
ok('0.4.5 那节不带下一条的 ## 头', !sec45.includes('\n## ['))
ok('0.4.5 那节不带 [Unreleased]（那是发布前的暂存区）', !sec45.includes('[Unreleased]'))
ok('短版本号 0.4 不误命中 0.4.5（会退回 null）', extract(changelogText, '0.4') === null)
ok('不存在的版本返回 null 而不是抛', extract(changelogText, '9.9.9') === null)
ok('非 X.Y.Z 直接判 null（防被拼进正则当元字符）', extract(changelogText, 'unreleased') === null)
ok('--heading 时首行就是节标题', extract(changelogText, '0.4.5', { heading: true }).startsWith('## [0.4.5] -'))
// 别把 extract 的 CLI 分支跑起来 —— import 时如果 argv[1] 判定错，stdout 会被抢着打印、
// 甚至抢跑 process.exit。原写法是 `ok(..., true)`（恒真，回归时照样绿），这里改成真起一个
// 子进程 import 它：抢跑就打印不出空 stdout 或退出码不为 0，这条会红。
const cliProbe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(new URL('../scripts/extract-changelog-section.mjs', import.meta.url).href)})`], { encoding: 'utf8' })
ok('CLI 守卫：被 import 时既不打印也不抢跑 exit',
  cliProbe.status === 0 && cliProbe.stdout.trim() === '',
  `status=${cliProbe.status} stdout=${JSON.stringify(cliProbe.stdout)} stderr=${JSON.stringify(cliProbe.stderr)}`)

/* --- 发布流水线的关键契约（三处文件之间的耦合，漂了就发不出去） ------------- */
// release.yml：浏览器一键发版；publish.yml：tag push 触发 npm 发布 + 建 GitHub Release。
// 这三步互相有硬约束 —— 版本一致、CHANGELOG 有该节、tag 存在 —— 任一条漂了都会在 CI
// 才炸；在这里先红，比在 Actions 里对着 5 分钟前的 log 找原因便宜得多。
const releaseYml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const publishYml = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
const releaseMjs = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
ok('release.yml 有 workflow_dispatch，且只开 patch/minor/major 三个选项',
  /on:\s*\n\s*workflow_dispatch/.test(releaseYml) && /options:\s*\n\s*-\s*patch\s*\n\s*-\s*minor\s*\n\s*-\s*major/.test(releaseYml))
ok('release.yml 声明 contents: write（要往 origin 推 commit + tag）',
  /permissions:\s*\n\s*contents:\s*write/.test(releaseYml))
ok('release.yml 不复制发布逻辑，直接调 scripts/release.mjs',
  /node scripts\/release\.mjs\s+--\$\{\{\s*inputs\.bump\s*\}\}/.test(releaseYml))
ok('release.yml 用 fetch-depth: 0（check-docs 要能看见所有 tag）',
  /fetch-depth:\s*0/.test(releaseYml))
ok('release.mjs 在 CI 上补 git 身份（runner 上没配 user.email，`git tag -a` 会挂）',
  /IS_CI[\s\S]*?git\('config',\s*'user\.name'/.test(releaseMjs))
ok('release.mjs 用 HEAD:main 推，与 tag 同一次 push，且带 --atomic（detached HEAD 下 `git push origin main` 会把旧 tip 又推一遍；分两条推给 main 的 CI 留下看不到 tag 的窗口；多 refspec 默认不原子。参数顺序也是被钉的形状之一）',
  /git\('push',\s*'--atomic',\s*'origin',\s*'HEAD:main',\s*`v\$\{target\}`\)/.test(releaseMjs))
ok('release.mjs 不把 tag 单独拆成第二条 push（那两条之间的窗口就是 ci#51 的根因；guards 里另有反向断言）',
  !/git\('push',\s*'origin',\s*`v\$\{target\}`\s*\)/.test(releaseMjs))
ok('publish.yml 建 GitHub Release：抽取 + softprops + 只在 tag push 时跑',
  /name:\s*build release notes/.test(publishYml)
    && /uses:\s*softprops\/action-gh-release@v2/.test(publishYml)
    && /if:\s*github\.event_name\s*==\s*'push'/.test(publishYml))
ok('publish.yml 的 contents 权限升到 write（GitHub Release 要写权限，npm 端不受影响）',
  /permissions:[\s\S]*?contents:\s*write[\s\S]*?id-token:\s*write/.test(publishYml))
ok('GitHub Release 步骤排在 verify it landed 之后（没进 registry 就不该发公告）',
  publishYml.indexOf('name: verify it landed') < publishYml.indexOf('name: create GitHub Release'))
// setup-node 的 registry-url 会往 ~/.npmrc 写 `_authToken=${NODE_AUTH_TOKEN}`，
// 而 npm 不会展开 `${...}`，OIDC 路径就被这把假钥匙挡在门外（症状是"Access token
// expired"式的 401/404，超误导）。这条闸门是踩坑之后加上的，别再被"看着更规范"
// 的一句话改回去。
ok('publish.yml 的 setup-node 不带 registry-url（OIDC 会假 401，见注释）',
  !/registry-url\s*:/.test(publishYml))
ok('publish.yml 走 NPM_TOKEN 那条路时自己写 ~/.npmrc（补偿 registry-url 的缺失）',
  /registry\.npmjs\.org\/:_authToken/.test(publishYml))
ok('release.yml 的 setup-node 也不带 registry-url（同一条坑）',
  !/registry-url\s*:/.test(releaseYml))
// 幂等：npm 一旦收下版本号就不能覆盖，publish 报 "cannot publish over" 时应该继续走 verify，
// 别再让整条 run 挂在那里（真踩过：34199864723 上传成功但 verify 误红，重跑又被"不能覆盖"卡住，
// GitHub Release 两次都建不出来）。
ok('publish 步骤把"version 已在 registry"当成功继续（幂等）',
  /cannot publish over the previously published versions/.test(publishYml))
// verify 不能靠 `npm view` —— 它会先读 runner 上的 ~/.npm/_cacache，收到旧快照就假阳红；
// 直接 curl registry HTTP + `Cache-Control: no-cache` 才是真相。
ok('verify it landed 走 curl + registry HTTP，不用 npm view',
  /registry\.npmjs\.org\/dsh-token-plan-quota/.test(publishYml)
    && !/npm view "dsh-token-plan-quota@\$ver"/.test(publishYml))
/* ============================================ 14. 006 用量统计：索引折叠 / 聚合 / 路由 / 降级
 *
 * 全部离线：假 persistence 直接给事件数组，不碰真实 ~/.dsh 会话；DSH_HOME 已指向 tmp。
 * 固定 now = 本地 2026-11-12 12:00（周四），周桶边界才可复现。
 */
const USAGE_NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const USAGE_DAY = '2026-11-12'
const USAGE_DAY_MS = 86_400_000

function headerEvent(seq, at, provider = 'qwen-token-plan-cn', model = 'qwen3.8-flash') {
  return { seq, type: 'request/header', time: at, data: { header: { config: { provider, model } } } }
}
function usageEvent(seq, at, usage) {
  const event = { seq, type: 'assistant/message', time: at, data: {} }
  if (usage !== undefined) event.data.usage = usage
  return event
}
function zeroTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, steps: 0, tokens: 0 }
}
function assertTotalsIdentity(label, aggregate) {
  const byBucket = zeroTotals()
  for (const bucket of aggregate.buckets) for (const key of Object.keys(byBucket)) byBucket[key] += bucket.totals[key]
  check(label + '：区间 totals == 桶之和', aggregate.totals, byBucket)
  const byModel = zeroTotals()
  for (const item of aggregate.models) for (const key of Object.keys(byModel)) byModel[key] += item.totals[key]
  check(label + '：区间 totals == 模型之和', aggregate.totals, byModel)
}
function nextLocalDayKey(key) {
  const parts = key.split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2])
  date.setDate(date.getDate() + 1)
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
/** 假 persistence：list 给快照，open 给句柄（read 按 seq>=offset 过滤，和宿主实现一致）。 */
function makeFakePersistence(definition = {}) {
  const sessions = Object.keys(definition).map(id => {
    const source = definition[id]
    return { id, revision: source.revision ?? 'rev-1', inheritedEventCount: source.inheritedEventCount ?? 0, events: source.events ?? [] }
  })
  const opens = []
  const reads = []
  // 调用计数：refreshing 语义要能验证「请求踢了一轮同步」，而这只能由 list 被再次调用证明。
  const counters = { list: 0 }
  return {
    sessions,
    opens,
    reads,
    counters,
    async list() {
      counters.list += 1
      return sessions.map(session => ({ id: session.id, revision: session.revision, sizeBytes: 0, header: { id: session.id } }))
    },
    async open(id) {
      const session = sessions.find(item => item.id === id)
      if (session === undefined) throw new Error('unknown session: ' + id)
      opens.push({ id })
      return {
        inheritedEventCount: session.inheritedEventCount,
        async read(offset = 0) {
          reads.push({ id, offset })
          return { eventState: 'ok', events: session.events.filter(event => event.seq >= offset) }
        },
        async close() {},
      }
    },
  }
}
function makeRouteCtx(persistence) {
  const registered = []
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'webServer') return { register: route => (registered.push(route), () => {}) }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'sessionPersistence') return persistence
      return undefined
    },
    effect(fn) { fn(); return () => {} },
    on() { return () => {} },
  }
  return { ctx, registered }
}
async function callUsageRoute(route, url, method = 'GET') {
  const res = { status: 0, headers: null, raw: '' }
  await route.handler({ method, url, headers: { host: '127.0.0.1:63108' } }, {
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(body) { res.raw = String(body) },
  })
  res.json = res.raw === '' ? undefined : JSON.parse(res.raw)
  return res
}
function recursiveKeys(value, out = []) {
  if (value === null || typeof value !== 'object') return out
  for (const [key, item] of Object.entries(value)) { out.push(key); recursiveKeys(item, out) }
  return out
}

// ① fold：三恒等式 / 缺 usage 不计数 / 隐私字段不进索引
{
  const index = emptyUsageIndex()
  const events = [
    headerEvent(1, USAGE_NOW),
    usageEvent(2, USAGE_NOW + 1000, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }),
    usageEvent(3, USAGE_NOW + 2000, { inputTokens: 50, outputTokens: 10 }),
    usageEvent(4, USAGE_NOW + 3000),                       // 没有 usage：不是一次调用
    { seq: 5, type: 'user/message', time: USAGE_NOW + 4000, data: { message: { text: 'SECRET-TEXT' } } },
    usageEvent(6, USAGE_NOW + 5000, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 }),
  ]
  const folded = foldUsageEvents(index, events, 1, 0, { retentionDays: 365, now: USAGE_NOW })
  check('fold 增量：四类 token 与调用数', folded.added, { input: 151, output: 31, cacheRead: 6, cacheWrite: 1, calls: 3 })
  check('fold：缺 usage 的 assistant/message 不计数', index.days[USAGE_DAY].calls, 3)
  check('fold：有 request/header 时未知模型计数为 0', folded.unknownModel, 0)
  ok('fold：索引里没有消息文本', !JSON.stringify(index).includes('SECRET-TEXT'))
  ok('fold：索引里没有百分号（不派生比例）', !JSON.stringify(index).includes('%'))
  const aggregate = aggregateUsageRange(index, { days: 1, now: USAGE_NOW })
  check('fold：区间 totals 与当日桶一致', aggregate.totals, { input: 151, output: 31, cacheRead: 6, cacheWrite: 1, calls: 3, steps: 3, tokens: 189 })
  assertTotalsIdentity('fold day', aggregate)
  check('fold：模型归属来自 request/header', aggregate.models.map(item => [item.id, item.totals.calls]), [['qwen-token-plan-cn/qwen3.8-flash', 3]])

  // 未知模型：没有 request/header 也记账，只是记到 unknown/unknown（不静默丢）
  const unknownIndex = emptyUsageIndex()
  const unknownFolded = foldUsageEvents(unknownIndex, [usageEvent(1, USAGE_NOW, { inputTokens: 3, outputTokens: 0 })], 1, 0, { retentionDays: 365, now: USAGE_NOW })
  check('fold：无 request/header 记 unknown 不丢', [unknownFolded.unknownModel, unknownIndex.days[USAGE_DAY].models['unknown/unknown'].calls], [1, 1])
  check('fold：索引顶层 stats 累计 unknown', unknownIndex.stats.unknownModel, 1)

  // 保留期外的调用：计 skippedOld，不进桶
  const oldFolded = foldUsageEvents(emptyUsageIndex(), [usageEvent(1, USAGE_NOW - 400 * USAGE_DAY_MS, { inputTokens: 1, outputTokens: 0 })], 1, 0, { retentionDays: 365, now: USAGE_NOW })
  check('fold：保留期外的调用计 skippedOld 且不入桶', [oldFolded.added.calls, oldFolded.skippedOld], [0, 1])

  // 落盘往返 + 修剪
  index.days['2024-01-01'] = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, models: {} }
  trimUsageIndex(index, 30, USAGE_NOW)
  ok('trim：早于保留期的日桶被丢弃', index.days['2024-01-01'] === undefined)
  const roundtripPath = join(TEST_HOME, 'usage-index-roundtrip.json')
  saveUsageIndex(roundtripPath, index)
  const reloaded = loadUsageIndex(roundtripPath)
  check('索引落盘 / 重读往返', reloaded.days, index.days)
  const rawIndexFile = readFileSync(roundtripPath, 'utf8')
  ok('索引文件不含消息文本', !rawIndexFile.includes('SECRET-TEXT'))
  ok('索引文件不含百分号', !rawIndexFile.includes('%'))
}

// ② 继承前缀：seq < cut 的事件跳过（继承会话不重复计数）
{
  const inheritedIndex = emptyUsageIndex()
  // seq 从 0 起：cut=3 表示 0/1/2 都是父会话前缀
  const inherited = [
    usageEvent(0, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
    usageEvent(1, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
    usageEvent(2, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
  ]
  const skipped = foldUsageEvents(inheritedIndex, inherited, 0, 3, { retentionDays: 365, now: USAGE_NOW })
  check('继承前缀：seq<cut 全部跳过', skipped.added.calls, 0)
  check('继承前缀：没有产生日桶', Object.keys(inheritedIndex.days).length, 0)
  const kept = foldUsageEvents(inheritedIndex, [usageEvent(2, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }), usageEvent(3, USAGE_NOW, { inputTokens: 7, outputTokens: 1 })], 2, 3, { retentionDays: 365, now: USAGE_NOW })
  check('继承前缀：只有 seq>=cut 的新事件计入', kept.added.calls, 1)
}

// ③④ 增量同步：幂等（revision 未变不 open）+ revision 变了只读新片
{
  resetInstanceState()
  const persistence = makeFakePersistence({
    'sess-a': {
      revision: 'rev-1',
      events: [
        headerEvent(1, USAGE_NOW),
        usageEvent(2, USAGE_NOW + 1000, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        usageEvent(3, USAGE_NOW + 2000, { inputTokens: 20, outputTokens: 3 }),
      ],
    },
  })
  const index = emptyUsageIndex()
  const config = effectiveConfig({}, ctxStub)
  const first = await syncUsageIndex({ persistence, index, config, now: USAGE_NOW })
  check('sync 首轮：会话数 / 索引数 / 失败数', [first.sessions, first.indexed, first.failed, first.ok], [1, 1, 0, true])
  check('sync 首轮：两次调用入账', index.days[USAGE_DAY].calls, 2)
  check('sync 首轮：读起点是 cut（0）', persistence.reads[0].offset, 0)
  const second = await syncUsageIndex({ persistence, index, config, now: USAGE_NOW })
  check('sync 幂等：revision 未变不重复计数', index.days[USAGE_DAY].calls, 2)
  check('sync 幂等：revision 未变不 open', persistence.opens.length, 1)
  check('sync 幂等：索引数仍算 1', [second.indexed, second.failed], [1, 0])

  persistence.sessions[0].revision = 'rev-2'
  persistence.sessions[0].events.push(usageEvent(4, USAGE_NOW + 3000, { inputTokens: 5, outputTokens: 1 }))
  await syncUsageIndex({ persistence, index, config, now: USAGE_NOW })
  check('revision 变了才重新 open', persistence.opens.length, 2)
  check('只读新片：offset = lastSeq + 1', persistence.reads[persistence.reads.length - 1].offset, 4)
  check('只读新片：总数 2 + 1（不是 2 + 2）', index.days[USAGE_DAY].calls, 3)

  // 继承会话：cut 之前是父会话前缀，不计数
  const inheritedPersistence = makeFakePersistence({
    'sess-b': {
      revision: 'rev-9',
      inheritedEventCount: 2,
      events: [
        usageEvent(0, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
        usageEvent(1, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
        usageEvent(2, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
      ],
    },
  })
  const inheritedIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: inheritedPersistence, index: inheritedIndex, config, now: USAGE_NOW })
  check('继承会话：读起点就是 cut', inheritedPersistence.reads[0].offset, 2)
  check('继承会话：前缀不计数', inheritedIndex.days[USAGE_DAY].calls, 1)
}

// ⑤ 日聚合：桶数 / 补 0 / 三条恒等式
{
  const index = emptyUsageIndex()
  index.days['2026-11-06'] = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1, models: { 'a/m1': { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } } }
  index.days['2026-11-08'] = {
    input: 20, output: 2, cacheRead: 5, cacheWrite: 0, calls: 2,
    models: { 'a/m1': { input: 20, output: 2, cacheRead: 5, cacheWrite: 0, calls: 2 } },
  }
  index.days[USAGE_DAY] = {
    input: 10, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1,
    models: { 'b/m2': { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }, 'c/m3': { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 } },
  }
  const aggregate = aggregateUsageRange(index, { days: 7, now: USAGE_NOW })
  check('日聚合：7 个日桶', aggregate.buckets.length, 7)
  check('日聚合：granularity=day', aggregate.granularity, 'day')
  check('日聚合：区间含首尾', [aggregate.range.from, aggregate.range.to], ['2026-11-06', '2026-11-12'])
  check('日聚合：缺数据的天补 0', aggregate.buckets.find(bucket => bucket.from === '2026-11-07').totals, zeroTotals())
  check('日聚合：buckets 升序', aggregate.buckets.map(bucket => bucket.from), ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'])
  check('日聚合：区间 totals', aggregate.totals, { input: 40, output: 3, cacheRead: 5, cacheWrite: 0, calls: 4, steps: 4, tokens: 48 })
  assertTotalsIdentity('日聚合', aggregate)
  check('模型排序：tokens 降序、同值按 id 升序', aggregate.models.map(item => item.id), ['a/m1', 'b/m2', 'c/m3'])
  check('模型条目带 provider / model', [aggregate.models[0].provider, aggregate.models[0].model], ['a', 'm1'])
  check('日桶 label 是 MM-DD', aggregate.buckets[0].label, '11-06')
}

// ⑥ 周桶边界（固定 now=2026-11-12 周四）
{
  const index = emptyUsageIndex()
  const at63 = aggregateUsageRange(index, { days: 63, now: USAGE_NOW })
  check('周桶：days=63 → 10 个桶', at63.buckets.length, 10)
  check('周桶：days=63 → granularity=week', at63.granularity, 'week')
  check('周桶：首桶从周一 2026-09-07 起', [at63.buckets[0].from, at63.buckets[0].to], ['2026-09-07', '2026-09-13'])
  check('周桶：末桶 2026-11-09 ~ 区间末日', [at63.buckets[9].from, at63.buckets[9].to], ['2026-11-09', '2026-11-12'])
  check('周桶：区间起点 = to - 62 天', at63.range.from, '2026-09-11')
  ok('周桶：桶间不重叠不留缝', at63.buckets.every((bucket, i) => i === 0 || nextLocalDayKey(at63.buckets[i - 1].to) === bucket.from))
  ok('周桶：每个起始日都是周一', at63.buckets.every(bucket => new Date(bucket.from + 'T00:00:00').getDay() === 1))

  const at365 = aggregateUsageRange(index, { days: 365, now: USAGE_NOW })
  check('周桶：days=365 → 53 个桶', at365.buckets.length, 53)
  check('周桶：days=365 首桶从周一 2025-11-10 起', at365.buckets[0].from, '2025-11-10')
  check('周桶：days=365 末桶到 2026-11-12', at365.buckets[at365.buckets.length - 1].to, USAGE_DAY)

  const at62 = aggregateUsageRange(index, { days: 62, now: USAGE_NOW })
  check('边界：days=62 仍是日桶', [at62.granularity, at62.buckets.length], ['day', 62])
  check('边界：days=1 → today', [aggregateUsageRange(index, { days: 1, now: USAGE_NOW }).range.kind, aggregateUsageRange(index, { days: 1, now: USAGE_NOW }).range.days], ['today', 1])
}

// ⑦ 路由形状：字段白名单 / 非 GET 405 / 无 % 无消息文本 / query 夹紧
{
  resetInstanceState()
  const persistence = makeFakePersistence({
    'sess-route': {
      revision: 'r1',
      events: [
        headerEvent(1, USAGE_NOW - 1000),
        usageEvent(2, USAGE_NOW - 500, { inputTokens: 40, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 }),
        usageEvent(3, USAGE_NOW, { inputTokens: 60, outputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 1 }),
      ],
    },
  })
  const row = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-index-route.json') }
  const { ctx, registered } = makeRouteCtx(persistence)
  resetInstanceState()
  apply(ctx, row)
  const route = registered.find(item => item.path === '/token-plan-quota')
  ok('usage 路由随 prefix 路由一起注册', route !== undefined)
  await runUsageSync(ctx, effectiveConfig(row, ctx))
  const got = await callUsageRoute(route, '/token-plan-quota/usage?days=7')
  check('usage 路由：200', got.status, 200)
  check('usage 路由：字段白名单', Object.keys(got.json).sort(),
    ['buckets', 'coverage', 'enabled', 'generatedAt', 'granularity', 'models', 'range', 'refreshing', 'source', 'totals'])
  check('usage 路由：totals', got.json.totals, { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, calls: 2, steps: 2, tokens: 126 })
  check('usage 路由：source 标注本实例实测', [got.json.source.kind, got.json.source.veracity], ['session-index', 'measured'])
  check('usage 路由：coverage.sessions', got.json.coverage.sessions, 1)
  check('usage 路由：7 个日桶', got.json.buckets.length, 7)
  check('usage 路由：refreshing 是布尔', typeof got.json.refreshing, 'boolean')
  ok('usage 路由：响应没有百分号', !got.raw.includes('%'))
  ok('usage 路由：响应没有消息文本 / 表头字段', !recursiveKeys(got.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
  ok('usage 路由：响应没有落盘路径', !got.raw.includes('usage-index-route'))
  check('usage 路由：缓存头 no-store', got.headers['cache-control'], 'no-store')

  const post = await callUsageRoute(route, '/token-plan-quota/usage', 'POST')
  check('usage 路由：POST → 405', post.status, 405)
  const badDays = await callUsageRoute(route, '/token-plan-quota/usage?days=abc')
  check('days 非法 → 默认 7', badDays.json.range.days, 7)
  const zeroDays = await callUsageRoute(route, '/token-plan-quota/usage?days=0')
  check('days=0 → 夹到 1（today）', [zeroDays.json.range.days, zeroDays.json.range.kind], [1, 'today'])
  const preset = await callUsageRoute(route, '/token-plan-quota/usage?range=30d')
  check('range 预设 30d', preset.json.range.days, 30)
  const clamped = await callUsageRoute(route, '/token-plan-quota/usage?days=10000')
  check('days 超上界 → 夹到 usageBackfillDays(365)', clamped.json.range.days, 365)
  const notFound = await callUsageRoute(route, '/token-plan-quota/nope')
  check('404 路由清单含 usage', notFound.status === 404 && notFound.json.routes.includes('usage'), true)

  const summary = await callUsageRoute(route, '/token-plan-quota/summary')
  check('summary：config.usageStats 是布尔', typeof summary.json.config.usageStats, 'boolean')
  ok('summary：不暴露 usageIndexPath / usageBackfillDays', !recursiveKeys(summary.json).some(key => key === 'usageIndexPath' || key === 'usageBackfillDays'))

  // refreshing 语义（INTERFACE §2）：只表示「同步确实在飞」。宿主每 5 分钟同步一次，
  // 若把「距上次同步 > 60s」也算成 refreshing，两次同步之间的 4/5 时间面板都显示
  // 「正在同步…」，而且每个请求都会反向踢一轮同步（真桌面实例上实测到的说谎）。
  const syncConfig = effectiveConfig(row, ctx)
  const realDateNow = Date.now
  try {
    Date.now = () => realDateNow() + 10 * 60_000
    const before = persistence.counters.list
    const stale = buildUsageSnapshot(syncConfig, ctx, { days: 7 })
    check('refreshing：距上次同步 10 分钟且无在飞同步 → false', stale.refreshing, false)
    await new Promise(resolve => setImmediate(resolve))
    ok('距上次同步过久：请求仍然踢了一轮同步（persistence.list 被再次调用）', persistence.counters.list > before)
  } finally {
    Date.now = realDateNow
  }
  const syncInFlight = runUsageSync(ctx, syncConfig)
  check('refreshing：同步在飞 → true', buildUsageSnapshot(syncConfig, ctx, { days: 7 }).refreshing, true)
  await syncInFlight
  check('refreshing：同步结束 → false', buildUsageSnapshot(syncConfig, ctx, { days: 7 }).refreshing, false)

  // 500 兜底不吐宿主异常原文：客户端会把 payload.error 原样显示在面板里（复审 H2）。
  const warns = []
  const realGet = ctx.get
  try {
    ctx.get = function (name, fallback) {
      if (name === 'sessionPersistence') throw new TypeError('ENOENT: open C:/Users/OMEN/.dsh/sessions/dead.jsonl')
      return realGet.call(this, name, fallback)
    }
    ctx.logger.warn = value => warns.push(String(value?.message ?? value))
    const broken = await callUsageRoute(route, '/token-plan-quota/usage?days=7')
    check('usage 路由：快照抛错 → 500', broken.status, 500)
    check('usage 路由：异常响应只有固定串', broken.json, { error: 'usage-unavailable' })
    ok('usage 路由：异常原文与路径不回给浏览器', !broken.raw.includes('ENOENT') && !broken.raw.includes('.dsh'))
    ok('usage 路由：异常只进 logger.warn 留诊断', warns.length === 1 && warns[0].includes('ENOENT'))
  } finally {
    ctx.get = realGet
  }
}

// ⑧ 降级：无 persistence / 关闭统计 / 坏 JSON 与 schema 污染
{
  resetInstanceState()
  const degradeConfig = effectiveConfig({ usageIndexPath: join(TEST_HOME, 'usage-index-degrade.json') }, ctxStub)
  const degraded = buildUsageSnapshot(degradeConfig, ctxStub, { days: 7 })
  check('无 persistence：降级 source', [degraded.source.kind, degraded.source.label], ['in-process', '本进程启动以来（实测）'])
  check('无 persistence：emptyReason', degraded.emptyReason, 'no-session-persistence')
  ok('无 persistence：hint 指名 sessionPersistence', typeof degraded.hint === 'string' && degraded.hint.includes('sessionPersistence'))
  ok('无 persistence：不谎报 0（hint 说明重启归零）', degraded.hint.includes('重启'))

  const disabled = buildUsageSnapshot(effectiveConfig({ usageStats: false }, ctxStub), ctxStub, { days: 7 })
  check('关闭统计：enabled=false', disabled.enabled, false)
  check('关闭统计：emptyReason', disabled.emptyReason, 'usage-stats-disabled')
  check('关闭统计：totals 全 0', disabled.totals, zeroTotals())
  check('关闭统计：桶仍按区间补齐', disabled.buckets.length, 7)
  ok('关闭统计：hint 指向 usageStats', disabled.hint.includes('usageStats'))
  check('关闭统计：source 说明已关闭', disabled.source.label, '用量统计已关闭')

  // 坏 JSON → 备份 + 重建
  resetInstanceState()
  const brokenPath = join(TEST_HOME, 'usage-index-broken.json')
  writeFileSync(brokenPath, '{ this is not json', 'utf8')
  const brokenCtx = makeRouteCtx(makeFakePersistence({}))
  const brokenRow = { sources: [], usageIndexPath: brokenPath }
  resetInstanceState()
  apply(brokenCtx.ctx, brokenRow)
  await runUsageSync(brokenCtx.ctx, effectiveConfig(brokenRow, brokenCtx.ctx))
  ok('坏 JSON：留 .bad-* 备份', readdirSync(TEST_HOME).some(name => name.startsWith('usage-index-broken.json.bad-')))
  check('坏 JSON：重建为空索引', Object.keys(__internals.usageIndex.days).length, 0)

  // schema 污染（白名单外的键）同样按坏索引处理，且内容不进内存
  resetInstanceState()
  const pollutedPath = join(TEST_HOME, 'usage-index-polluted.json')
  const polluted = emptyUsageIndex()
  polluted.days[USAGE_DAY] = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, models: {}, message: 'SECRET-TEXT' }
  polluted.notes = 'SECRET-TEXT'
  writeFileSync(pollutedPath, JSON.stringify(polluted), 'utf8')
  const pollutedCtx = makeRouteCtx(makeFakePersistence({}))
  const pollutedRow = { sources: [], usageIndexPath: pollutedPath }
  resetInstanceState()
  apply(pollutedCtx.ctx, pollutedRow)
  await runUsageSync(pollutedCtx.ctx, effectiveConfig(pollutedRow, pollutedCtx.ctx))
  ok('schema 污染：备份后重建', readdirSync(TEST_HOME).some(name => name.startsWith('usage-index-polluted.json.bad-')))
  check('schema 污染：SECRET-TEXT 没进内存', JSON.stringify(__internals.usageIndex).includes('SECRET-TEXT'), false)
}

// ⑨⑩ live fallback（无 persistence 时 recordUsage 后的实时日桶）+ 工具 usage
{
  resetInstanceState()
  const liveConfig = effectiveConfig({ usageIndexPath: join(TEST_HOME, 'usage-index-live.json') }, ctxStub)
  recordUsage(liveConfig, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 30, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 }, Date.now())
  const snapshot = buildUsageSnapshot(liveConfig, ctxStub, { days: 7 })
  check('live fallback：totals>0', [snapshot.totals.input, snapshot.totals.output, snapshot.totals.calls], [30, 7, 1])
  check('live fallback：source=in-process', snapshot.source.kind, 'in-process')
  ok('live fallback：不再报 emptyReason', snapshot.emptyReason === undefined)
  ok('live fallback：没有百分号', !JSON.stringify(snapshot).includes('%'))

  const tool = buildQuotaTool(() => liveConfig, ctxStub)
  check('工具 action 枚举含 usage 与 usage-official', tool.parameters.properties.action.enum, ['status', 'refresh', 'reset', 'usage', 'usage-official'])
  check('工具 days 参数 1..365', [tool.parameters.properties.days.type, tool.parameters.properties.days.minimum, tool.parameters.properties.days.maximum], ['integer', 1, 365])
  const out = await tool.execute({ action: 'usage', days: 7 })
  check('工具 usage：ok=true', out.ok, true)
  check('工具 usage：range.days', out.usage.range.days, 7)
  check('工具 usage：totals', [out.usage.totals.input, out.usage.totals.calls], [30, 1])
  check('工具 usage：source 是降级口径', out.usage.source.kind, 'in-process')
  ok('工具 usage：文本是实测口径', out.text.includes('input 30') && out.text.includes('次调用'))
  ok('工具 usage：输出无消息文本', !JSON.stringify(out).includes('SECRET-TEXT'))
  const defaulted = await tool.execute({ action: 'usage' })
  check('工具 usage：缺省 7 天', defaulted.usage.range.days, 7)

  // 有 persistence 时只认索引，实时桶不能重复计
  resetInstanceState()
  recordUsage(liveConfig, 'qwen-token-plan-cn', 'qwen3.8-flash', { inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, Date.now())
  const persistedRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-index-live2.json') }
  const persistence = makeFakePersistence({
    'sess-live': { revision: 'r1', events: [headerEvent(1, Date.now()), usageEvent(2, Date.now(), { inputTokens: 10, outputTokens: 1 })] },
  })
  const persistedCtx = makeRouteCtx(persistence)
  resetInstanceState()
  apply(persistedCtx.ctx, persistedRow)
  const persistedConfig = effectiveConfig(persistedRow, persistedCtx.ctx)
  await runUsageSync(persistedCtx.ctx, persistedConfig)
  const indexed = buildUsageSnapshot(persistedConfig, persistedCtx.ctx, { days: 7 })
  check('有 persistence 时只认索引（实时桶不重复计）', [indexed.totals.input, indexed.totals.calls], [10, 1])
  check('有 persistence 时 source=session-index', indexed.source.kind, 'session-index')

  // 实时桶按 usageBackfillDays 修剪；配置夹紧
  resetInstanceState()
  const shortConfig = effectiveConfig({ usageBackfillDays: 1 }, ctxStub)
  recordUsage(shortConfig, 'p', 'm', { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, Date.now() - 30 * USAGE_DAY_MS)
  recordUsage(shortConfig, 'p', 'm', { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, Date.now())
  check('实时桶按 usageBackfillDays 修剪', __internals.liveUsageDays.size, 1)
  check('usageBackfillDays 夹紧：9999 → 365', effectiveConfig({ usageBackfillDays: 9999 }, ctxStub).usageBackfillDays, 365)
  check('usageBackfillDays 夹紧：0 → 1', effectiveConfig({ usageBackfillDays: 0 }, ctxStub).usageBackfillDays, 1)
  check('usageBackfillDays 夹紧：非数字 → 365', effectiveConfig({ usageBackfillDays: 'abc' }, ctxStub).usageBackfillDays, 365)
  check('usageStats 默认开', effectiveConfig({}, ctxStub).usageStats, true)
  check('usageStats 可关', effectiveConfig({ usageStats: false }, ctxStub).usageStats, false)
}

// ⑪ 宿主兼容性 seam：双形态 list / revision 归一 / 继承 cut 三级兜底 / 坏快照计失败 / readFrom 兜底 / no-sessions
// 依据是宿主真实消费方（dsh-service 的 usage seam）：旧宿主（0.1.x）上这些形状与语义都不同，
// 不按「语义正确者优先」探测就会静默出错——数字翻倍或每轮全量重读，而不会报错。
{
  // a) 0.1.1-rc.2 ~ 0.1.2-rc.1：listSnapshots() 给 {header, revision}，list() 只给裸 header，两方法同时在位。
  //    先探测 list() 会拿到裸 header → revision 恒空。必须优先 listSnapshots。
  resetInstanceState()
  const dualEvents = [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 10, outputTokens: 1 })]
  let listCalls = 0
  let listSnapshotsCalls = 0
  const dual = {
    async list() {
      listCalls += 1
      return [{ id: 'dual-sess' }]
    },
    async listSnapshots() {
      listSnapshotsCalls += 1
      return [{ header: { id: 'dual-sess' }, revision: 'rev-dual' }]
    },
    async open() {
      return { inheritedEventCount: 0, async read() { return { events: dualEvents } }, async close() {} }
    },
  }
  const dualIndex = emptyUsageIndex()
  const dualResult = await syncUsageIndex({ persistence: dual, index: dualIndex, config: effectiveConfig({}, ctxStub), now: USAGE_NOW })
  check('双形态 persistence：优先 listSnapshots（list 一次都不该调）', [listSnapshotsCalls, listCalls], [1, 0])
  check('双形态 persistence：入账', dualIndex.days[USAGE_DAY].calls, 1)
  check('双形态 persistence：revision 存下来', dualIndex.sessions['dual-sess'].revision, 'rev-dual')
  check('双形态 persistence：ok / sessions', [dualResult.ok, dualResult.sessions], [true, 1])

  // b) revision 可能是对象/数字：归一成字符串再进索引，否则跳过判断永不生效（每轮全量重读）。
  const revEvents = [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 5, outputTokens: 1 })]
  const objectOpens = []
  const objectRevision = {
    async list() { return [{ header: { id: 'obj-sess' }, revision: { rev: 3 } }] },
    async open(id) { objectOpens.push(id); return { async read() { return { events: revEvents } }, async close() {} } },
  }
  const objIndex = emptyUsageIndex()
  const objConfig = effectiveConfig({}, ctxStub)
  await syncUsageIndex({ persistence: objectRevision, index: objIndex, config: objConfig, now: USAGE_NOW })
  check('revision 归一：对象 revision 存成字符串', objIndex.sessions['obj-sess'].revision, JSON.stringify({ rev: 3 }))
  await syncUsageIndex({ persistence: objectRevision, index: objIndex, config: objConfig, now: USAGE_NOW })
  check('revision 归一：第二轮按字符串比较即跳过（只 open 一次）', objectOpens.length, 1)
  check('revision 归一：重复同步不重复计数', objIndex.days[USAGE_DAY].calls, 1)

  const numberOpens = []
  const numberRevision = {
    async list() { return [{ header: { id: 'num-sess' }, revision: 7 }] },
    async open(id) { numberOpens.push(id); return { async read() { return { events: revEvents } }, async close() {} } },
  }
  const numIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: numberRevision, index: numIndex, config: objConfig, now: USAGE_NOW })
  check('revision 归一：数字 revision 存成字符串', numIndex.sessions['num-sess'].revision, '7')
  await syncUsageIndex({ persistence: numberRevision, index: numIndex, config: objConfig, now: USAGE_NOW })
  check('revision 归一：数字 revision 同样能跳过', numberOpens.length, 1)

  // c) 继承前缀 cut 三级兜底：句柄 → 读片 meta.seedLength → 快照 header.seedLength → 0。
  //    拿不到 cut 的后果是父会话前缀被重复折入（数字翻倍），不是少统计。
  const prefixEvents = [
    usageEvent(0, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
    usageEvent(1, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
    usageEvent(2, USAGE_NOW, { inputTokens: 7, outputTokens: 1 }),
  ]
  const metaPersistence = {
    async list() { return [{ header: { id: 'meta-sess' }, revision: 'r' }] },
    async open() {
      return { async read() { return { meta: { seedLength: 2 }, events: prefixEvents } }, async close() {} }
    },
  }
  const metaIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: metaPersistence, index: metaIndex, config: objConfig, now: USAGE_NOW })
  check('继承 cut 兜底：读片 meta.seedLength 生效（前缀不计数）', metaIndex.days[USAGE_DAY].calls, 1)
  check('继承 cut 兜底：索引记下 cut=2', metaIndex.sessions['meta-sess'].cut, 2)

  const headerOnlyPersistence = {
    async list() { return [{ header: { id: 'hdr-sess', seedLength: 2 }, revision: 'r' }] },
    async open() {
      return { async read() { return prefixEvents }, async close() {} }
    },
  }
  const headerIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: headerOnlyPersistence, index: headerIndex, config: objConfig, now: USAGE_NOW })
  check('继承 cut 兜底：快照 header.seedLength 生效（裸数组读片也能读）', headerIndex.days[USAGE_DAY].calls, 1)
  check('继承 cut 兜底：索引记下 cut=2', headerIndex.sessions['hdr-sess'].cut, 2)

  const invalidSeedPersistence = {
    async list() { return [{ header: { id: 'bad-seed' }, revision: 'r' }] },
    async open() { return { async read() { return { events: prefixEvents, meta: { seedLength: '2' } } }, async close() {} } },
  }
  const invalidSeedIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: invalidSeedPersistence, index: invalidSeedIndex, config: objConfig, now: USAGE_NOW })
  check('继承 cut 兜底：非法 seedLength 归 0（不猜）', [invalidSeedIndex.sessions['bad-seed'].cut, invalidSeedIndex.days[USAGE_DAY].calls], [0, 3])

  // d) 快照缺 header / 缺 id：计一次失败并继续，不静默丢（coverage.failed 要看得见）。
  const mixed = {
    async list() { return [{ header: { id: 'good-sess' }, revision: 'r' }, {}, { header: {} }] },
    async open() { return { async read() { return { events: [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 3, outputTokens: 0 })] } }, async close() {} } },
  }
  const mixedIndex = emptyUsageIndex()
  const mixedResult = await syncUsageIndex({ persistence: mixed, index: mixedIndex, config: objConfig, now: USAGE_NOW })
  check('坏快照：sessions 计全部 3 条', mixedResult.sessions, 3)
  check('坏快照：计失败而不是静默丢', [mixedResult.indexed, mixedResult.failed], [1, 2])
  check('坏快照：健康会话照常入账', mixedIndex.days[USAGE_DAY].calls, 1)

  // e) 旧宿主没有 open：readFrom(id, fromSeq) 必须带起点（不传起点会从头全读）。
  const readFromCalls = []
  const readFromPersistence = {
    async list() { return [{ header: { id: 'rf-sess' }, revision: 'r' }] },
    async readFrom(id, fromSeq) {
      readFromCalls.push({ id, fromSeq })
      return { events: [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 4, outputTokens: 1 })] }
    },
  }
  const rfIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: readFromPersistence, index: rfIndex, config: objConfig, now: USAGE_NOW })
  check('readFrom 兜底：起点参数是 0', readFromCalls[0], { id: 'rf-sess', fromSeq: 0 })
  check('readFrom 兜底：入账', rfIndex.days[USAGE_DAY].calls, 1)

  const readCalls = []
  const readOnlyPersistence = {
    async list() { return [{ header: { id: 'ro-sess' }, revision: 'r' }] },
    async read(id, fromSeq) {
      readCalls.push({ id, fromSeq })
      return { events: [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 6, outputTokens: 2 })] }
    },
  }
  const roIndex = emptyUsageIndex()
  await syncUsageIndex({ persistence: readOnlyPersistence, index: roIndex, config: objConfig, now: USAGE_NOW })
  check('read 兜底：也带起点参数', readCalls[0], { id: 'ro-sess', fromSeq: 0 })
  check('read 兜底：入账', roIndex.days[USAGE_DAY].calls, 1)

  // f) 本实例一个会话都没有：no-sessions（不是 no-usage-in-range —— 后者会让人以为"用过但没记录"）。
  resetInstanceState()
  const emptyCtx = makeRouteCtx({ async list() { return [] }, async open() { throw new Error('unreachable') } })
  const emptyRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-index-empty.json') }
  resetInstanceState()
  apply(emptyCtx.ctx, emptyRow)
  const emptyConfig = effectiveConfig(emptyRow, emptyCtx.ctx)
  await runUsageSync(emptyCtx.ctx, emptyConfig)
  const noSessions = buildUsageSnapshot(emptyConfig, emptyCtx.ctx, { days: 7 })
  check('no-sessions：emptyReason', noSessions.emptyReason, 'no-sessions')
  ok('no-sessions：hint 说明还没有会话记录', typeof noSessions.hint === 'string' && noSessions.hint.includes('会话记录'))
  check('no-sessions：source 仍是 session-index（不是降级）', noSessions.source.kind, 'session-index')
}

// ⑫ 007 自定义起止日期：纯函数校验 / 自定义日桶与周桶铺满 / 路由与工具接线
{
  // a) resolveCustomRange：合法区间、夹紧、以及非法输入（007 §1.1）
  check('007 resolve：单日', resolveCustomRange({ now: USAGE_NOW, from: '2026-11-12', to: '2026-11-12' }),
    { from: '2026-11-12', to: '2026-11-12', days: 1 })
  check('007 resolve：整月含首尾', resolveCustomRange({ now: USAGE_NOW, from: '2026-10-01', to: '2026-10-31' }).days, 31)
  check('007 resolve：跨年按日历天', resolveCustomRange({ now: USAGE_NOW, from: '2025-12-01', to: '2026-01-15' }).days, 46)
  check('007 resolve：to 晚于今天 → 夹到今天', resolveCustomRange({ now: USAGE_NOW, from: '2026-11-01', to: '2026-12-31' }),
    { from: '2026-11-01', to: '2026-11-12', days: 12 })
  check('007 resolve：from 在未来 → bad', resolveCustomRange({ now: USAGE_NOW, from: '2026-11-13', to: '2026-11-13' }),
    { error: 'usage-bad-range' })
  check('007 resolve：from > to → bad', resolveCustomRange({ now: USAGE_NOW, from: '2026-11-12', to: '2026-11-10' }),
    { error: 'usage-bad-range' })
  check('007 resolve：2026-02-30 不是真实日历日 → bad', resolveCustomRange({ now: USAGE_NOW, from: '2026-02-30', to: '2026-03-02' }),
    { error: 'usage-bad-range' })
  check('007 resolve：13 月 → bad', resolveCustomRange({ now: USAGE_NOW, from: '2026-13-01', to: '2026-13-02' }),
    { error: 'usage-bad-range' })
  check('007 resolve：未零填充的月份 → bad', resolveCustomRange({ now: USAGE_NOW, from: '2026-9-1', to: '2026-9-2' }),
    { error: 'usage-bad-range' })
  check('007 resolve：跨度超 usageBackfillDays → 带 maxDays', resolveCustomRange({ now: USAGE_NOW, from: '2025-01-01', to: '2026-11-12' }),
    { error: 'usage-range-too-long', maxDays: 365 })
  check('007 resolve：恰好 365 天放行', resolveCustomRange({ now: USAGE_NOW, from: '2025-11-13', to: '2026-11-12' }).days, 365)
  check('007 resolve：maxDays 可配', resolveCustomRange({ now: USAGE_NOW, from: '2026-11-01', to: '2026-11-12', maxDays: 10 }),
    { error: 'usage-range-too-long', maxDays: 10 })
  check('007 resolve：闰日 2024-02-29 合法', resolveCustomRange({ now: USAGE_NOW, from: '2024-02-29', to: '2024-02-29' }).days, 1)
  check('007 resolve：2025-02-29 非法', resolveCustomRange({ now: USAGE_NOW, from: '2025-02-29', to: '2025-03-01' }),
    { error: 'usage-bad-range' })

  // b) 自定义日桶：缺记录的日子出 0 桶、桶从区间起点连续铺到终点
  const rangeIndex = emptyUsageIndex()
  rangeIndex.days['2026-09-01'] = {
    input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1,
    models: { 'p/m1': { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } },
  }
  rangeIndex.days['2026-09-03'] = {
    input: 20, output: 2, cacheRead: 5, cacheWrite: 0, calls: 2,
    models: {
      'p/m1': { input: 12, output: 1, cacheRead: 5, cacheWrite: 0, calls: 1 },
      'p/m2': { input: 8, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 },
    },
  }
  const dayRange = aggregateUsageRange(rangeIndex, { now: USAGE_NOW, from: '2026-09-01', to: '2026-09-05' })
  check('007 日桶：range 标 custom 且 days 由区间现算（忽略传入 days）',
    aggregateUsageRange(rangeIndex, { now: USAGE_NOW, days: 7, from: '2026-09-01', to: '2026-09-05' }).range,
    { kind: 'custom', days: 5, from: '2026-09-01', to: '2026-09-05' })
  check('007 日桶：granularity=day', dayRange.granularity, 'day')
  check('007 日桶：每桶一天、首桶从区间起点起、末桶止于区间终点', dayRange.buckets.map(bucket => bucket.from + '~' + bucket.to), [
    '2026-09-01~2026-09-01', '2026-09-02~2026-09-02', '2026-09-03~2026-09-03',
    '2026-09-04~2026-09-04', '2026-09-05~2026-09-05',
  ])
  check('007 日桶：label 是 MM-DD', dayRange.buckets.map(bucket => bucket.label), ['09-01', '09-02', '09-03', '09-04', '09-05'])
  check('007 日桶：无记录日补 0 桶', dayRange.buckets.map(bucket => bucket.totals.calls), [1, 0, 2, 0, 0])
  check('007 日桶：区间 totals', dayRange.totals, { input: 30, output: 3, cacheRead: 5, cacheWrite: 0, calls: 3, steps: 3, tokens: 38 })
  assertTotalsIdentity('007 日桶', dayRange)
  check('007 日桶：模型归属与调用数', dayRange.models.map(item => [item.id, item.totals.calls]), [['p/m1', 2], ['p/m2', 1]])

  // c) 自定义周桶：>62 天切周；首桶从 from 起到本周日、其余从周一起，连续无空隙
  const weekRange = aggregateUsageRange(rangeIndex, { now: USAGE_NOW, from: '2026-09-03', to: '2026-11-12' })
  check('007 周桶：days>62 用周粒度', [weekRange.range.kind, weekRange.range.days, weekRange.granularity], ['custom', 71, 'week'])
  check('007 周桶：11 个桶', weekRange.buckets.length, 11)
  check('007 周桶：首桶从区间起点起、止于本周日',
    [weekRange.buckets[0].from, weekRange.buckets[0].to], ['2026-09-03', '2026-09-06'])
  check('007 周桶：末桶止于区间终点',
    [weekRange.buckets[10].from, weekRange.buckets[10].to], ['2026-11-09', '2026-11-12'])
  ok('007 周桶：桶之间连续无空隙',
    weekRange.buckets.every((bucket, index) => index === 0 || nextLocalDayKey(weekRange.buckets[index - 1].to) === bucket.from))
  const isLocalMonday = key => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))).getDay() === 1
  ok('007 周桶：除首桶外都从本地周一起', weekRange.buckets.slice(1).every(bucket => isLocalMonday(bucket.from)))
  check('007 周桶：首桶累计区间内的日桶', weekRange.buckets[0].totals.calls, 2)
  check('007 周桶：区间外（09-01）不计入', weekRange.totals,
    { input: 20, output: 2, cacheRead: 5, cacheWrite: 0, calls: 2, steps: 2, tokens: 27 })
  assertTotalsIdentity('007 周桶', weekRange)
  const weekFrom63 = aggregateUsageRange(rangeIndex, { now: USAGE_NOW, from: '2026-09-11', to: '2026-11-12' })
  check('007 周桶：63 天 → 周粒度 10 桶', [weekFrom63.granularity, weekFrom63.buckets.length], ['week', 10])
  const dayFrom62 = aggregateUsageRange(rangeIndex, { now: USAGE_NOW, from: '2026-09-12', to: '2026-11-12' })
  check('007 日桶：62 天 → 日粒度 62 桶', [dayFrom62.granularity, dayFrom62.buckets.length], ['day', 62])

  // d) 路由与工具：from/to 优先、400 固定码、夹紧回真值、与 ?days=30 逐桶一致（SC-001/002/003）
  resetInstanceState()
  const rangePersistence = makeFakePersistence({
    'sess-range': {
      revision: 'r-range',
      events: [
        headerEvent(1, new Date(2026, 9, 14, 12, 0, 0).getTime()),
        usageEvent(2, new Date(2026, 9, 14, 12, 0, 1).getTime(), { inputTokens: 5, outputTokens: 0 }),
        headerEvent(3, new Date(2026, 10, 10, 12, 0, 0).getTime()),
        usageEvent(4, new Date(2026, 10, 10, 12, 0, 1).getTime(), { inputTokens: 10, outputTokens: 0 }),
        usageEvent(5, new Date(2026, 10, 12, 12, 0, 0).getTime(), { inputTokens: 20, outputTokens: 0 }),
      ],
    },
  })
  const rangeRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-index-custom-range.json') }
  const rangeRouteCtx = makeRouteCtx(rangePersistence)
  resetInstanceState()
  apply(rangeRouteCtx.ctx, rangeRow)
  const rangeRoute = rangeRouteCtx.registered.find(item => item.path === '/token-plan-quota')
  // 固定 now：路由里的今天就是 USAGE_DAY，夹紧断言才可复现（否则真跑当天一变就红）。
  const realDateNow = Date.now
  try {
    Date.now = () => USAGE_NOW
    await runUsageSync(rangeRouteCtx.ctx, effectiveConfig(rangeRow, rangeRouteCtx.ctx))
    const thirty = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?days=30')
    const custom = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-10-14&to=2026-11-12')
    check('007 路由：自定义区间 200', custom.status, 200)
    check('007 路由：range 标 custom', custom.json.range,
      { kind: 'custom', days: 30, from: '2026-10-14', to: '2026-11-12' })
    check('007 路由：与 ?days=30 同区间逐桶相等（SC-001）', custom.json.buckets, thirty.json.buckets)
    check('007 路由：与 ?days=30 同区间 totals 相等', custom.json.totals, thirty.json.totals)
    check('007 路由：30 个日桶与区间 totals', [custom.json.buckets.length, custom.json.totals],
      [30, { input: 35, output: 0, cacheRead: 0, cacheWrite: 0, calls: 3, steps: 3, tokens: 35 }])
    check('007 路由：无记录日补 0 桶', custom.json.buckets.filter(bucket => bucket.totals.calls === 0).length, 27)
    const priority = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?range=today&days=7&from=2026-10-14&to=2026-11-12')
    check('007 路由：from/to 优先于 range/days', [priority.json.range.kind, priority.json.range.days], ['custom', 30])
    const clampedCustom = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-11-01&to=2026-12-31')
    check('007 路由：to 夹到今天并回写真值', clampedCustom.json.range,
      { kind: 'custom', days: 12, from: '2026-11-01', to: '2026-11-12' })
    check('007 路由：夹紧后 12 个桶', clampedCustom.json.buckets.length, 12)
    const oneDay = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-11-12&to=2026-11-12')
    check('007 路由：单日区间仍是 custom 而非 today',
      [oneDay.json.range, oneDay.json.buckets.length, oneDay.json.granularity],
      [{ kind: 'custom', days: 1, from: '2026-11-12', to: '2026-11-12' }, 1, 'day'])
    const onlyFrom = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-10-14')
    check('007 路由：只有 from → 400 usage-bad-range', [onlyFrom.status, onlyFrom.json], [400, { error: 'usage-bad-range' }])
    const onlyTo = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?to=2026-11-12')
    check('007 路由：只有 to → 400 usage-bad-range', [onlyTo.status, onlyTo.json], [400, { error: 'usage-bad-range' }])
    const halfEmpty = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=&to=2026-11-12')
    check('007 路由：一端空一端有 → 400', [halfEmpty.status, halfEmpty.json], [400, { error: 'usage-bad-range' }])
    const fakeDay = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-02-30&to=2026-03-02')
    check('007 路由：2026-02-30 → 400', [fakeDay.status, fakeDay.json], [400, { error: 'usage-bad-range' }])
    const reversed = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-11-12&to=2026-11-10')
    check('007 路由：from > to → 400', [reversed.status, reversed.json], [400, { error: 'usage-bad-range' }])
    const futureFrom = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-11-13&to=2026-11-13')
    check('007 路由：from 在未来 → 400', [futureFrom.status, futureFrom.json], [400, { error: 'usage-bad-range' }])
    const tooLong = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2025-01-01&to=2026-11-12')
    check('007 路由：跨度超限 → 400 且带 maxDays', [tooLong.status, tooLong.json],
      [400, { error: 'usage-range-too-long', maxDays: 365 }])
    const emptyPair = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=&to=')
    check('007 路由：两端都空 → 回到 006 分支',
      [emptyPair.status, emptyPair.json.range.kind, emptyPair.json.range.days], [200, '7d', 7])
    const postCustom = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-10-14&to=2026-11-12', 'POST')
    check('007 路由：POST → 405', postCustom.status, 405)
    const zeroRange = await callUsageRoute(rangeRoute, '/token-plan-quota/usage?from=2026-10-01&to=2026-10-05')
    check('007 路由：0 记录区间仍是 5 个 0 桶',
      [zeroRange.status, zeroRange.json.buckets.length, zeroRange.json.totals.calls], [200, 5, 0])
    check('007 路由：0 记录的 emptyReason', zeroRange.json.emptyReason, 'no-usage-in-range')
    ok('007 路由：响应没有百分号', !custom.raw.includes('%'))
    ok('007 路由：响应没有消息文本 / 表头字段',
      !recursiveKeys(custom.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
    ok('007 路由：400 响应同样只有固定码', !recursiveKeys(tooLong.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))

    const rangeTool = buildQuotaTool(() => effectiveConfig(rangeRow, rangeRouteCtx.ctx), rangeRouteCtx.ctx)
    const toolUsage = await rangeTool.execute({ action: 'usage', from: '2026-10-14', to: '2026-11-12' })
    check('007 工具：action=usage 传 from/to', [toolUsage.ok, toolUsage.usage.range],
      [true, { kind: 'custom', days: 30, from: '2026-10-14', to: '2026-11-12' }])
    ok('007 工具：文本含起止日期', toolUsage.text.includes('2026-10-14') && toolUsage.text.includes('2026-11-12'))
    const toolBad = await rangeTool.execute({ action: 'usage', from: '2026-10-14' })
    check('007 工具：只有一端 → ok=false + 固定码', [toolBad.ok, toolBad.error], [false, 'usage-bad-range'])
    ok('007 工具：错误文本不回显宿主原文', typeof toolBad.text === 'string' && toolBad.text.length > 0)
    const toolLong = await rangeTool.execute({ action: 'usage', from: '2025-01-01', to: '2026-11-12' })
    check('007 工具：超限 → ok=false + maxDays', [toolLong.ok, toolLong.error, toolLong.maxDays],
      [false, 'usage-range-too-long', 365])
    ok('007 工具：超限文本带天数上界', toolLong.text.includes('365'))
  } finally {
    Date.now = realDateNow
  }
}

/* ============================================ 009 兜底会话扫描 + 重启即可见
 *
 * 两件事各自对应一条真实故障：
 * - 本机 217 个会话目录里有 2 个不在 persistence.list() 里（314 calls / 56.7M tokens 从没进过索引）；
 * - 重启后首轮同步要等 20 秒，这之前打开用量屏全是 0。
 * 全部用 tmp 目录里现造的日志 fixture，不读真实 ~/.dsh/sessions。
 */
{
  const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
  const originalDecompress = zlib.zstdDecompressSync
  const fixtureRoot = join(TEST_HOME, 'usage-fallback-fixture')
  const syncRoot = join(TEST_HOME, 'usage-fallback-sync')
  const versionRoot = join(TEST_HOME, 'usage-fallback-version')
  const seededRoot = join(TEST_HOME, 'usage-fallback-seeded')
  const budgetRoot = join(TEST_HOME, 'usage-fallback-budget')
  const routeRoot = join(TEST_HOME, 'usage-fallback-route')
  for (const root of [fixtureRoot, syncRoot, versionRoot, seededRoot, budgetRoot, routeRoot]) rmSync(root, { recursive: true, force: true })

  // Node < 22.15 没有 zstdCompressSync。§1.4 只数目录、文件名与字节数，不解析内容，所以无 zstd 时
  // 退化成同名文件的明文即可；真正的解码/折叠断言都在 HAS_ZSTD 分支里，跑不到这条路径。
  const frameOf = text => (HAS_ZSTD ? zlib.zstdCompressSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8'))
  const linesOf = events => events.map(event => JSON.stringify(event)).join('\n') + '\n'
  function writeLog(root, project, id, events, fileName = 'session.v4.jsonl.zstd') {
    const dir = join(root, project, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, fileName), frameOf(linesOf(events)))
  }
  const aggregateOf = (index, days = 7) => aggregateUsageRange(index, { days, now: USAGE_NOW })

  // ---- DEFAULTS / 导出形状
  check('009 DEFAULTS：兜底扫描默认开', DEFAULTS.usageScanFallback, true)
  check('009 DEFAULTS：扫描目录默认 $DSH_HOME/sessions', DEFAULTS.usageScanPath, '$DSH_HOME/sessions')
  check('009 兜底预算：64 MiB', FALLBACK_SCAN_BUDGET, 64 * 1024 * 1024)
  ok('009 __internals 追加七项导出',
    [decodeSessionLog, parseSessionEvents, fallbackCutOf, fallbackLogsOf, fallbackSignature, ensureUsageIndexLoaded, FALLBACK_SCAN_BUDGET]
      .every(value => value !== undefined))
  ok('009 decode/parse/cut/logs/signature 都是函数',
    [decodeSessionLog, parseSessionEvents, fallbackCutOf, fallbackLogsOf, fallbackSignature, ensureUsageIndexLoaded]
      .every(value => typeof value === 'function'))

  // ---- §1.1 decodeSessionLog
  if (HAS_ZSTD) {
    const textA = '{"n":1}\n'
    const textB = '{"n":2}\n'
    const textC = '{"n":3}\n'
    const single = decodeSessionLog(frameOf(textA))
    check('009 decode：单帧文本与帧数', [single.ok, single.frames, single.text], [true, 1, textA])

    const multi = decodeSessionLog(Buffer.concat([textA, textB, textC].map(frameOf)))
    check('009 decode：多帧按序拼接（多帧 zstd 不能只解第一帧）',
      [multi.ok, multi.frames, multi.text], [true, 3, textA + textB + textC])

    // 坏帧要选真的会抛的：Node 24 的 zstdDecompressSync 对 magic + 任意短尾巴（含全 ff / 全 00）
    // 都可能安静地解成空 Buffer，只有帧头声明的窗口大到荒谬时才会抛（"Frame requires too much memory"）。
    const badFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0x00, 0x88, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    const badTail = decodeSessionLog(Buffer.concat([frameOf(textA), badFrame]))
    check('009 decode：坏尾帧只保留前面能解的部分', [badTail.ok, badTail.frames, badTail.text], [true, 1, textA])

    const badMiddle = decodeSessionLog(Buffer.concat([frameOf(textA), badFrame, frameOf(textB)]))
    check('009 decode：中间坏帧跳过后继续解后面的帧',
      [badMiddle.ok, badMiddle.frames, badMiddle.text], [true, 2, textA + textB])
  } else {
    ok('009 decode：本机 Node 无 zstd（多帧用例跳过，只验证降级）', true)
  }
  // 这三条都要求 zstd 可用：decodeSessionLog 先认能力再认帧头，Node 20 上任何 buffer 都只能是 no-zstd。
  if (HAS_ZSTD) {
    check('009 decode：空 buffer → no-frames', decodeSessionLog(Buffer.alloc(0)), { ok: false, reason: 'no-frames' })
    check('009 decode：没有 zstd magic → no-frames', decodeSessionLog(Buffer.from('plain text, no frame', 'utf8')), { ok: false, reason: 'no-frames' })
    // Node 24 把「只有 magic」当空帧解出来（text 为空、frames=1）；这里钉住实际行为，
    // 免得以后换 Node 悄悄变了没人发现。真实日志至少有一条 header，不受影响。
    check('009 decode：只有 magic 没有帧体 → 空文本单帧（Node 24 行为）',
      decodeSessionLog(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), { ok: true, text: '', frames: 1 })
  } else {
    ok('009 decode：本机 Node 无 zstd（no-frames 用例跳过）', true)
  }
  check('009 decode：非 Buffer → decode-failed', decodeSessionLog('not a buffer'), { ok: false, reason: 'decode-failed' })

  // ---- §1.2 parseSessionEvents
  const parsed = parseSessionEvents('\n{"seq":1}\n   \nnot-json\n[1,2]\n{"seq":2}\n')
  check('009 parse：坏行计数、空行跳过、非对象不算事件',
    [parsed.events.length, parsed.badLines, parsed.events.map(event => event.seq)], [2, 2, [1, 2]])
  check('009 parse：空文本 → 0 事件 0 坏行', parseSessionEvents(''), { events: [], badLines: 0 })

  // ---- §1.3 fallbackCutOf
  check('009 cut：非 seeded 恒 0',
    fallbackCutOf([{ type: 'session', isSeeded: false }, { type: 'session/end-seed', seq: 5, data: { inherited: true } }]), 0)
  check('009 cut：seeded 但没有 inherited 标记 → 0',
    fallbackCutOf([{ type: 'session', isSeeded: true }, { type: 'session/end-seed', seq: 5, data: {} }]), 0)
  check('009 cut：取最后一条 inherited 标记的 seq + 1',
    fallbackCutOf([
      { type: 'session', isSeeded: true },
      { type: 'other' },
      { type: 'session/end-seed', seq: 3, data: { inherited: true } },
      { type: 'session/end-seed', seq: 7, data: { inherited: true } },
      { type: 'session/end-seed', seq: 9, data: { inherited: false } },
    ]), 8)
  check('009 cut：标记缺 seq 时用下标 + 1',
    fallbackCutOf([{ type: 'session', isSeeded: true }, { type: 'session/end-seed', data: { inherited: true } }]), 2)
  check('009 cut：空数组 / 字符串 → 0', [fallbackCutOf([]), fallbackCutOf('x')], [0, 0])

  // ---- §1.4 fallbackLogsOf
  writeLog(fixtureRoot, 'project-a', 'session-alpha', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 1, outputTokens: 0 })], 'session.v3.jsonl.zstd')
  writeLog(fixtureRoot, 'project-a', 'session-alpha', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 2, outputTokens: 0 })], 'session.v4.jsonl.zstd')
  writeLog(fixtureRoot, 'project-a', 'plain-uuid', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 3, outputTokens: 0 })], 'session.jsonl.zstd')
  mkdirSync(join(fixtureRoot, 'project-a', 'empty-session'), { recursive: true })
  writeLog(fixtureRoot, 'project-b', 'session-beta', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 4, outputTokens: 0 })], 'session.v2.jsonl.zstd')
  writeFileSync(join(fixtureRoot, 'README.txt'), 'not a log')
  writeFileSync(join(fixtureRoot, 'project-b', 'session-beta', 'notes.txt'), 'not a log either')

  const found = fallbackLogsOf(fixtureRoot)
  check('009 logs：dirs 含无日志的会话目录', found.dirs, 4)
  check('009 logs：每个会话目录只留一份（版本最高的那份）', found.logs.length, 3)
  const foundById = Object.fromEntries(found.logs.map(log => [log.id, log]))
  check('009 logs：目录名就是会话 id，不剥 session- 前缀', Object.keys(foundById).sort(), ['plain-uuid', 'session-alpha', 'session-beta'])
  ok('009 logs：v4 与 v3 同目录时选 v4', foundById['session-alpha'].path.endsWith('session.v4.jsonl.zstd'))
  ok('009 logs：无版本文件名同样认', foundById['plain-uuid'].path.endsWith('session.jsonl.zstd'))
  ok('009 logs：日志记录带 bytes / mtimeMs', foundById['plain-uuid'].bytes > 0 && foundById['plain-uuid'].mtimeMs > 0)
  check('009 logs：根不存在 → 空结果，不抛',
    fallbackLogsOf(join(fixtureRoot, 'no-such-root')), { logs: [], dirs: 0 })
  check('009 logs：空路径 → 空结果，不抛', fallbackLogsOf(''), { logs: [], dirs: 0 })

  // ---- §1.5 fallbackSignature
  check('009 signature：file:<bytes>:<取整 mtime>', fallbackSignature({ bytes: 12.9, mtimeMs: 1000.6 }), 'file:12:1001')
  check('009 signature：坏值归零（仍是字符串）', fallbackSignature({}), 'file:0:0')
  ok('009 signature：写进 revision 后 schema 仍是字符串', typeof fallbackSignature({ bytes: 1, mtimeMs: 1 }) === 'string')

  // ---- §1.6 syncUsageIndex 兜底
  if (HAS_ZSTD) {
    const listedEvents = [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW + 1000, { inputTokens: 5, outputTokens: 1 })]
    const hiddenEvents = [
      headerEvent(1, USAGE_NOW),
      usageEvent(2, USAGE_NOW + 1000, { inputTokens: 100, outputTokens: 10 }),
      usageEvent(3, USAGE_NOW + 2000, { inputTokens: 50, outputTokens: 5 }),
    ]
    writeLog(syncRoot, 'p', 'listed', listedEvents)
    writeLog(syncRoot, 'p', 'session-hidden', hiddenEvents)
    const syncConfig = effectiveConfig({ usageBackfillDays: 365, sources: [] }, ctxStub)
    const persistence = makeFakePersistence({ listed: { revision: 'rev-listed', events: listedEvents } })

    const firstIndex = emptyUsageIndex()
    const first = await syncUsageIndex({ persistence, index: firstIndex, config: syncConfig, sessionsDir: syncRoot, now: USAGE_NOW })
    check('009 sync：兜底补齐 list 隐藏的会话（scanned/rescued/会话数）',
      [first.ok, first.scanned, first.rescued, first.sessions, first.scanFailed, first.scanDeferred], [true, 2, 1, 2, 0, 0])
    check('009 sync：兜底会话的索引条目（cut / lastSeq / 字符串 revision）',
      [firstIndex.sessions['session-hidden'].cut, firstIndex.sessions['session-hidden'].lastSeq,
        typeof firstIndex.sessions['session-hidden'].revision], [0, 3, 'string'])
    const firstTotals = aggregateOf(firstIndex).totals
    check('009 sync：兜底会话计入总桶（不重复计 listed）',
      [firstTotals.calls, firstTotals.input, firstTotals.output], [3, 155, 16])

    const second = await syncUsageIndex({ persistence, index: firstIndex, config: syncConfig, sessionsDir: syncRoot, now: USAGE_NOW })
    check('009 sync：签名未变时二次同步不重读、数字不变（幂等）',
      [second.rescued, second.scanned, second.scanDeferred, aggregateOf(firstIndex).totals.calls], [0, 2, 0, 3])
    check('009 sync：签名未变的兜底会话仍算 indexed', second.indexed, 2)

    hiddenEvents.push(usageEvent(4, USAGE_NOW + 3000, { inputTokens: 7, outputTokens: 1 }))
    writeLog(syncRoot, 'p', 'session-hidden', hiddenEvents)
    const third = await syncUsageIndex({ persistence, index: firstIndex, config: syncConfig, sessionsDir: syncRoot, now: USAGE_NOW })
    check('009 sync：日志追加只折新增的尾巴',
      [third.rescued, firstIndex.sessions['session-hidden'].cut, firstIndex.sessions['session-hidden'].lastSeq,
        aggregateOf(firstIndex).totals.calls, aggregateOf(firstIndex).totals.input], [1, 4, 4, 4, 162])

    const revisionBeforeShorten = firstIndex.sessions['session-hidden'].revision
    writeLog(syncRoot, 'p', 'session-hidden', [headerEvent(1, USAGE_NOW)])
    const fourth = await syncUsageIndex({ persistence, index: firstIndex, config: syncConfig, sessionsDir: syncRoot, now: USAGE_NOW })
    check('009 sync：文件变短不折、记 scanFailed',
      [fourth.ok, fourth.rescued, fourth.scanFailed, aggregateOf(firstIndex).totals.calls], [true, 0, 1, 4])
    check('009 sync：文件变短时索引 revision 不被改写', firstIndex.sessions['session-hidden'].revision, revisionBeforeShorten)

    // 同目录 v4 + v3：只折最高版本，否则同一会话双计。
    writeLog(versionRoot, 'p', 'session-versioned', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 2, outputTokens: 0 })], 'session.v4.jsonl.zstd')
    writeLog(versionRoot, 'p', 'session-versioned', [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW, { inputTokens: 9, outputTokens: 0 })], 'session.v3.jsonl.zstd')
    const versionIndex = emptyUsageIndex()
    const versionSync = await syncUsageIndex({ index: versionIndex, config: syncConfig, sessionsDir: versionRoot, now: USAGE_NOW })
    check('009 sync：v4 + v3 只折一次', [versionSync.scanned, versionSync.rescued, versionSync.sessions, versionIndex.days[USAGE_DAY].calls], [1, 1, 1, 1])
    check('009 sync：折的是 v4 的数字', versionIndex.days[USAGE_DAY].input, 2)

    // fork 继承前缀：end-seed 之前的调用属于父会话，不能再计一次。
    const seededEvents = [
      { seq: 0, type: 'session', time: USAGE_NOW, data: { isSeeded: true }, isSeeded: true },
      usageEvent(1, USAGE_NOW, { inputTokens: 1000, outputTokens: 1000 }),
      usageEvent(2, USAGE_NOW, { inputTokens: 1000, outputTokens: 1000 }),
      { seq: 3, type: 'session/end-seed', time: USAGE_NOW, data: { inherited: true } },
      headerEvent(4, USAGE_NOW),
      usageEvent(5, USAGE_NOW, { inputTokens: 9, outputTokens: 1 }),
    ]
    writeLog(seededRoot, 'p', 'session-seeded', seededEvents)
    const seededIndex = emptyUsageIndex()
    const seededSync = await syncUsageIndex({ index: seededIndex, config: syncConfig, sessionsDir: seededRoot, now: USAGE_NOW })
    check('009 sync：fork 会话 cut 从继承标记之后开始',
      [seededSync.rescued, seededIndex.sessions['session-seeded'].cut, seededIndex.sessions['session-seeded'].lastSeq], [1, 4, 5])
    check('009 sync：继承前缀的 2 次调用不计入',
      [seededIndex.days[USAGE_DAY].calls, seededIndex.days[USAGE_DAY].input, seededIndex.stats.unknownModel], [1, 9, 0])

    // 预算：本轮读了多少字节封顶，超出的记 scanDeferred 交给下一轮。
    writeLog(budgetRoot, 'p', 'session-b1', hiddenEvents)
    writeLog(budgetRoot, 'p', 'session-b2', hiddenEvents)
    const zeroBudgetIndex = emptyUsageIndex()
    const zeroBudget = await syncUsageIndex({ index: zeroBudgetIndex, config: syncConfig, sessionsDir: budgetRoot, scanBudgetBytes: 0, now: USAGE_NOW })
    check('009 sync：预算 0 → 全部 deferred、不读不折',
      [zeroBudget.scanned, zeroBudget.rescued, zeroBudget.scanDeferred, zeroBudget.indexed, aggregateOf(zeroBudgetIndex).totals.calls], [2, 0, 2, 0, 0])
    const budgetLogs = fallbackLogsOf(budgetRoot).logs
    const partialIndex = emptyUsageIndex()
    const partial = await syncUsageIndex({ index: partialIndex, config: syncConfig, sessionsDir: budgetRoot, scanBudgetBytes: budgetLogs[0].bytes, now: USAGE_NOW })
    check('009 sync：只够一份的预算 → 折 1 份、剩 1 份 deferred',
      [partial.rescued, partial.scanDeferred, partial.sessions], [1, 1, 2])
    const fullIndex = emptyUsageIndex()
    const full = await syncUsageIndex({ index: fullIndex, config: syncConfig, sessionsDir: budgetRoot, now: USAGE_NOW })
    check('009 sync：后续轮次把 deferred 的补完', [full.rescued, full.scanDeferred, aggregateOf(fullIndex).totals.calls], [2, 0, 6])

    // 列表里的会话读失败：算 failed，但**不**交给兜底（否则同一会话会被两套读法各折一次）。
    const readFailPersistence = {
      async list() { return [{ id: 'listed', revision: 'rev-read-fail', header: { id: 'listed' } }] },
      async open() { throw new Error('open boom') },
    }
    const readFailIndex = emptyUsageIndex()
    const readFail = await syncUsageIndex({ persistence: readFailPersistence, index: readFailIndex, config: syncConfig, sessionsDir: syncRoot, now: USAGE_NOW })
    check('009 sync：list 里的会话读失败 → failed，不交给兜底重读',
      [readFail.failed, readFail.rescued, readFail.sessions, 'listed' in readFailIndex.sessions,
        // session-hidden 此时已被上面「文件变短」用例改成只剩 header，所以兜底折进来 0 次调用；
        // 若 listed 被兜底重读，这里会出现 1，正好证明「列表里的会话不交给兜底」。
        aggregateOf(readFailIndex).totals.calls], [1, 1, 2, false, 0])

    const oneBudgetIndex = emptyUsageIndex()
    const oneBudget = await syncUsageIndex({ index: oneBudgetIndex, config: syncConfig, sessionsDir: budgetRoot, scanBudgetBytes: 1, now: USAGE_NOW })
    check('009 sync：预算 1 字节 → 两份都 deferred',
      [oneBudget.rescued, oneBudget.scanDeferred, oneBudget.scanFailed], [0, 2, 0])

    // persistence 列表失败：日志还在磁盘上，不能整轮放弃。
    const failingPersistence = {
      async list() { throw new Error('list boom') },
      async open() { throw new Error('open boom') },
    }
    const failedIndex = emptyUsageIndex()
    const failedList = await syncUsageIndex({ persistence: failingPersistence, index: failedIndex, config: syncConfig, sessionsDir: budgetRoot, now: USAGE_NOW })
    check('009 sync：list 抛错仍全目录兜底（不再早退）',
      [failedList.ok, 'skipped' in failedList, failedList.sessions, failedList.rescued], [true, false, 2, 2])

    // 完全没有 persistence 也能靠目录出数。
    const noPersistenceIndex = emptyUsageIndex()
    const noPersistence = await syncUsageIndex({ index: noPersistenceIndex, config: syncConfig, sessionsDir: budgetRoot, now: USAGE_NOW })
    check('009 sync：无 persistence 时目录兜底仍然 ok',
      [noPersistence.ok, noPersistence.sessions, noPersistence.rescued], [true, 2, 2])

    const offIndex = emptyUsageIndex()
    const off = await syncUsageIndex({ index: offIndex, config: syncConfig, sessionsDir: budgetRoot, scanFallback: false, now: USAGE_NOW })
    check('009 sync：scanFallback=false 且无 persistence 时保持原早退语义',
      [off.ok, off.skipped, off.scanned, off.rescued], [false, 'no-session-persistence', 0, 0])

    const offListedIndex = emptyUsageIndex()
    const offListed = await syncUsageIndex({ persistence, index: offListedIndex, config: syncConfig, sessionsDir: syncRoot, scanFallback: false, now: USAGE_NOW })
    check('009 sync：scanFallback=false 时只走 persistence',
      [offListed.ok, offListed.scanned, offListed.rescued, offListed.sessions], [true, 0, 0, 1])

    const noDirIndex = emptyUsageIndex()
    const noDir = await syncUsageIndex({ persistence: makeFakePersistence({}), index: noDirIndex, config: syncConfig, sessionsDir: join(TEST_HOME, 'no-such-sessions'), now: USAGE_NOW })
    check('009 sync：目录不存在 → scanSkipped=no-dir、不报错',
      [noDir.ok, noDir.scanned, noDir.rescued, noDir.scanSkipped], [true, 0, 0, 'no-dir'])

    // Node 没有 zstd 时整段兜底降级，不抛也不误记 scanFailed。
    zlib.zstdDecompressSync = undefined
    try {
      const noZstdIndex = emptyUsageIndex()
      const noZstd = await syncUsageIndex({ index: noZstdIndex, config: syncConfig, sessionsDir: budgetRoot, now: USAGE_NOW })
      check('009 sync：zstd 不可用 → scanSkipped=no-zstd，不抛',
        [noZstd.ok, noZstd.scanned, noZstd.rescued, noZstd.scanSkipped, noZstd.scanFailed], [true, 2, 0, 'no-zstd', 0])
      // 带 magic 的 buffer 才能走到能力判定：先认帧头、再认 zstd 可用性。
      check('009 decode：zstd 不可用时返回 no-zstd',
        decodeSessionLog(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])), { ok: false, reason: 'no-zstd' })
    } finally {
      zlib.zstdDecompressSync = originalDecompress
    }
  } else {
    ok('009 sync：本机 Node 无 zstd（目录扫描用例跳过）', true)
  }

  // ---- §2.1 懒加载：预置索引 + 内存为空 + 空 persistence，首请求就必须出数
  const lazyHome = join(TEST_HOME, 'usage-lazy-home')
  mkdirSync(lazyHome, { recursive: true })
  const lazyIndexPath = join(lazyHome, 'prebuilt-index.json')
  const lazyAt = 30_000
  const lazyDay = dayKey(lazyAt)
  const prebuilt = emptyUsageIndex()
  prebuilt.days[lazyDay] = {
    input: 11, output: 2, cacheRead: 0, cacheWrite: 0, calls: 1,
    models: { 'qwen-token-plan-cn/qwen3.8-flash': { input: 11, output: 2, cacheRead: 0, cacheWrite: 0, calls: 1 } },
  }
  prebuilt.sessions['session-prebuilt'] = { revision: 'file:1:1', lastSeq: 2, cut: 0 }
  saveUsageIndex(lazyIndexPath, prebuilt)
  resetInstanceState()
  __internals.hardResetUsage()
  const lazyCtx = makeRouteCtx(makeFakePersistence({})).ctx
  const lazyConfig = effectiveConfig({ usageIndexPath: lazyIndexPath, usageScanPath: join(lazyHome, 'no-scan'), sources: [] }, lazyCtx)
  const realDateNowLazy = Date.now
  try {
    // now=30s：离上次同步 30s，小于 60s，不会反向踢异步同步；索引里的日键就在 1970-01-01。
    Date.now = () => lazyAt
    const lazySnap = buildUsageSnapshot(lazyConfig, lazyCtx, { days: 1 })
    check('009 懒加载：首请求直接读到盘上的历史（totals）',
      [lazySnap.totals.calls, lazySnap.totals.input, lazySnap.totals.output, lazySnap.totals.tokens], [1, 11, 2, 13])
    check('009 懒加载：数据源仍是 session-index（不是 in-process）', lazySnap.source.kind, 'session-index')
    check('009 懒加载：coverage 从已加载索引回填会话数',
      [lazySnap.coverage.sessions, lazySnap.coverage.indexed], [1, 1])
    check('009 coverage：新四键缺省 0、旧五键在前',
      Object.keys(lazySnap.coverage), ['sessions', 'indexed', 'failed', 'unknownModel', 'skippedOld', 'scanned', 'rescued', 'scanFailed', 'scanDeferred'])
    check('009 coverage：首请求的兜底计数为 0',
      [lazySnap.coverage.scanned, lazySnap.coverage.rescued, lazySnap.coverage.scanFailed, lazySnap.coverage.scanDeferred], [0, 0, 0, 0])
    ok('009 coverage：不出现 scanSkipped 键', !('scanSkipped' in lazySnap.coverage))
    ok('009 懒加载：快照里没有索引文件路径', !JSON.stringify(lazySnap).includes(lazyIndexPath))
    const loaded = __internals.usageIndex
    ensureUsageIndexLoaded(lazyConfig)
    ok('009 ensureUsageIndexLoaded：已加载时幂等（不重读、同对象）', __internals.usageIndex === loaded)
  } finally {
    Date.now = realDateNowLazy
  }
  resetInstanceState()

  // ---- §2.2 路由 / 工具：兜底后的 coverage 与隐私边界
  if (HAS_ZSTD) {
    writeLog(routeRoot, 'p', 'session-route', [
      headerEvent(1, USAGE_NOW),
      usageEvent(2, USAGE_NOW, { inputTokens: 120, outputTokens: 30 }),
      usageEvent(3, USAGE_NOW + 1000, { inputTokens: 30, outputTokens: 5 }),
    ])
    const routeRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-fallback-route-index.json'), usageScanPath: routeRoot }
    resetInstanceState()
    __internals.hardResetUsage()
    const routeCtx = makeRouteCtx(makeFakePersistence({}))
    resetInstanceState()
    apply(routeCtx.ctx, routeRow)
    const routeConfig = effectiveConfig(routeRow, routeCtx.ctx)
    const routeSync = await runUsageSync(routeCtx.ctx, routeConfig)
    check('009 runUsageSync：无 persistence 列表时靠兜底出数',
      [routeSync.ok, routeSync.sessions, routeSync.indexed, routeSync.rescued, routeSync.scanned], [true, 1, 1, 1, 1])
    const route = routeCtx.registered.find(item => item.path === '/token-plan-quota')
    ok('009 路由：已注册 /token-plan-quota', route !== undefined)
    const realDateNowRoute = Date.now
    try {
      Date.now = () => USAGE_NOW
      const response = await callUsageRoute(route, '/token-plan-quota/usage?days=7')
      check('009 路由：GET usage 200 且 totals 来自兜底日志',
        [response.status, response.json.totals.calls, response.json.totals.input, response.json.totals.output], [200, 2, 150, 35])
      check('009 路由：coverage 暴露 rescued / scanned',
        [response.json.coverage.sessions, response.json.coverage.indexed, response.json.coverage.rescued, response.json.coverage.scanned], [1, 1, 1, 1])
      ok('009 路由：响应没有百分号', !response.raw.includes('%'))
      ok('009 路由：响应没有兜底目录路径或索引路径',
        !response.raw.includes(routeRoot) && !response.raw.includes(routeRow.usageIndexPath))
      ok('009 路由：响应没有消息文本 / 表头字段',
        !recursiveKeys(response.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
      const postResponse = await callUsageRoute(route, '/token-plan-quota/usage?days=7', 'POST')
      check('009 路由：非 GET 仍是 405', postResponse.status, 405)

      const tool = buildQuotaTool(() => effectiveConfig(routeRow, routeCtx.ctx), routeCtx.ctx)
      const toolUsage = await tool.execute({ action: 'usage', days: 7 })
      check('009 工具：action=usage 能看到兜底 coverage',
        [toolUsage.ok, toolUsage.usage.totals.calls, toolUsage.usage.coverage.rescued, toolUsage.usage.coverage.scanned], [true, 2, 1, 1])
      ok('009 工具：文本不回显日志路径', !toolUsage.text.includes(routeRoot))
    } finally {
      Date.now = realDateNowRoute
    }
    resetInstanceState()

  } else {
    ok('009 路由：本机 Node 无 zstd（兜底出数用例跳过）', true)
  }
  // usageScanFallback=false：即使目录里有日志，也不许把兜底会话算进来。
  const offRouteRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-fallback-off-index.json'), usageScanPath: routeRoot, usageScanFallback: false }
  resetInstanceState()
  __internals.hardResetUsage()
  const offRouteCtx = makeRouteCtx(makeFakePersistence({}))
  resetInstanceState()
  apply(offRouteCtx.ctx, offRouteRow)
  const offRouteConfig = effectiveConfig(offRouteRow, offRouteCtx.ctx)
  const offRouteSync = await runUsageSync(offRouteCtx.ctx, offRouteConfig)
  check('009 降级开关：usageScanFallback=false 时 rescued 恒 0',
    [offRouteSync.ok, offRouteSync.rescued, offRouteSync.scanned], [true, 0, 0])
  const offRouteSnap = buildUsageSnapshot(offRouteConfig, offRouteCtx.ctx, { days: 7 })
  check('009 降级开关：快照 coverage 也不报兜底数',
    [offRouteSnap.coverage.rescued, offRouteSnap.coverage.scanned, offRouteSnap.totals.calls], [0, 0, 0])
  resetInstanceState()

  // runUsageSync 本身：无 persistence 但兜底可用时不能早退（006 的旧分支会直接 skipped）。
  if (HAS_ZSTD) {
    const noPersistenceCtx = { logger: { warn() {} }, get: () => undefined }
    const noPersistenceConfig = effectiveConfig({ sources: [], usageIndexPath: join(TEST_HOME, 'usage-nop-index.json'), usageScanPath: routeRoot }, noPersistenceCtx)
    resetInstanceState()
    __internals.hardResetUsage()
    const noPersistenceSync = await runUsageSync(noPersistenceCtx, noPersistenceConfig)
    check('009 runUsageSync：无 persistence 时走目录兜底而不是 skipped',
      [noPersistenceSync.ok, noPersistenceSync.sessions, noPersistenceSync.rescued], [true, 1, 1])
    resetInstanceState()
  } else {
    ok('009 runUsageSync：本机 Node 无 zstd（无持久化兜底用例跳过）', true)
  }
}

/* ============================================ 008 官方账号侧用量明细（Token Plan Usage Details）
 *
 * 为什么必须逐条钉死而不是只测"能跑通"：这一格显示的是**账号级**数字，用户拿它和本机账对账
 * （官方 20 亿 vs 本机 12.5 亿）。它错了不会崩，只会安静地把差额算错，所以每一条退化路径
 * ——缺日、无 total_tokens、缓存、夹紧、下载链接、登录失效——都要有断言。
 * 全程只进回环服务器：不给真实控制台打一个请求。
 */
{
  const pureChunk = officialChunkRequest({ from: '2026-10-01', to: '2026-10-03' })
  check('008 切片请求：止日次日零点 + 日步长', [pureChunk.step, pureChunk.endTime - pureChunk.startTime], [86_400, 3 * 86_400_000])
  const threeChunks = sliceOfficialRange({ from: '2026-09-01', to: '2026-11-13' })
  check('008 切片：74 天 → 30/30/14 三片（网关实测上界 30 天）', threeChunks.chunks.map(c => c.days), [30, 30, 14])
  const clamped = sliceOfficialRange({ from: '2026-01-01', to: '2026-10-02', earliest: '2026-06-01' })
  // clampedFrom 是**被夹掉的那个起点**（不是夹紧后的值）：UI 要靠它解释"你要的更早，官方只给到这里"。
  check('008 切片：早于官方最早日 → 夹紧，并回报被夹掉的原始起点',
    [clamped.from, clamped.clampedFrom, clamped.days], ['2026-06-01', '2026-01-01', 124])
  check('008 切片：起点晚于终点 → 空区间固定码', sliceOfficialRange({ from: '2026-10-03', to: '2026-10-01' }).error, 'official-empty-range')
  check('008 切片：官方最早日 = 当前月往前 5 个月的 1 号',
    officialEarliestDayKey({ now: Date.parse('2026-11-13T04:00:00Z'), monthsBack: 5 }), '2026-06-01')

  const nested = parseOfficialEnvelope({ code: '200', data: { DataV2: { data: { extra: { originData: [{ metricName: 'model_usage' }] } } } } })
  check('008 解析：向下找 originData 那层', nested.series?.length, 1)
  check('008 解析：data 是 JSON 字符串时也要认',
    parseOfficialEnvelope({ data: JSON.stringify({ data: { originData: [1] } }) }).series?.length, 1)
  check('008 解析：只给下载链接时单独回报（不跟随外部主机）',
    parseOfficialEnvelope({ data: { dataDownloadUrl: 'https://oss.example/x.json' } }).downloadUrl, 'https://oss.example/x.json')
  check('008 解析：认不出结构 → 固定码', parseOfficialEnvelope({ nope: 1 }).error, 'official-bad-response')

  const folded = foldOfficialSeries([
    { labels: { usage_type: 'total_tokens' }, points: [{ timestamp: Date.parse('2026-10-02T00:00:00Z'), value: 100 }] },
    { labels: { usage_type: 'input_tokens' }, points: [{ timestamp: Date.parse('2026-10-02T00:00:00Z'), value: 70 }] },
    // 官方枚举外的东西不能被当成某个已知类型累加进去（伪装成 total 会让数字翻倍）。
    { labels: { usage_type: 'mystery_tokens' }, points: [{ timestamp: Date.parse('2026-10-02T00:00:00Z'), value: 9_999 }] },
  ], { dayStart: '2026-10-01', dayEnd: '2026-10-02' })
  check('008 折叠：timestamp 是桶右端点（减一个 step 才是当天）', folded.days.get('2026-10-01')?.input, 70)
  check('008 折叠：枚举外类型被忽略（只认四类白名单）', folded.days.get('2026-10-01')?.total, 100)
  const builtDerived = buildOfficialUsage({ from: '2026-10-01', to: '2026-10-02', days: folded.days })
  check('008 汇总：缺日补 0 桶、桶尾 = 日键', builtDerived.buckets.map(b => b.to), ['2026-10-01', '2026-10-02'])
  check('008 汇总：有 total 时不派生', [builtDerived.totals.tokens, builtDerived.totalDerived], [100, false])
  const derivedOnly = buildOfficialUsage({ from: '2026-10-01', to: '2026-10-01', days: new Map([['2026-10-01', { total: 0, input: 70, cached: 0, output: 30, hasTotal: false }]]) })
  check('008 汇总：没有 total_tokens 时 tokens = input + output 并标记派生', [derivedOnly.totals.tokens, derivedOnly.totalDerived], [100, true])
  for (const code of ['official-disabled', 'official-no-credentials', 'official-login-expired', 'official-download-url', 'official-timeout', 'official-upstream', 'official-bad-response']) {
    const hint = String(officialErrorHint(code))
    ok('008 错误提示可操作且不带百分比：' + code, hint.length > 4 && !hint.includes('%'), hint)
  }
  ok('008 声明主机集合没有被 telemetry 改动',
    DECLARED_HOSTS.length === 8 && DECLARED_HOSTS.every(host => host.startsWith('https://'))
    && !DECLARED_HOSTS.some(host => /telemetry|oss\./i.test(host)), DECLARED_HOSTS.join(','))

  // ---- 回环全链路 ----
  const seen = []
  let mode = 'ok'
  const seriesOf = (reqDTO) => {
    const start = Number(reqDTO.startTime)
    const step = Number(reqDTO.step) * 1000
    const first = start + step
    const out = []
    const push = (type, value) => out.push({
      aggMethod: 'sum',
      metricName: 'model_usage',
      step: Number(reqDTO.step),
      labels: { usage_type: type },
      points: [{ timestamp: first, value }],
    })
    // 只给第一天数据：这样"缺日补 0"与"逐日桶"能在同一份响应里一起验。
    if (mode === 'no-total') {
      push('input_tokens', 70)
      push('output_tokens', 30)
    } else {
      push('total_tokens', 100)
      push('input_tokens', 70)
      push('cached_tokens', 50)
      push('output_tokens', 30)
    }
    return out
  }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      if (u.pathname === '/tool/user/info.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: '200', successResponse: true, data: { secToken: 'SECTOKEN_CANARY' } }))
        return
      }
      let params = {}
      try { params = JSON.parse(new URLSearchParams(body).get('params') ?? '{}') } catch { params = {} }
      const reqDTO = params?.Data?.reqDTO ?? {}
      seen.push({ api: params.Api, reqDTO, cookie: req.headers.cookie ?? null })
      if (mode === 'http-500') { res.writeHead(500); res.end('boom'); return }
      if (mode === 'login') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { errorCode: 'BailianGateway.Login.NotLogined', errorMsg: 'not logged in' } }))
        return
      }
      if (mode === 'download') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: '200', successResponse: true, data: { dataDownloadUrl: 'https://oss.example/x.json' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: '200', successResponse: true, data: { originData: seriesOf(reqDTO) } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const realCookie = process.env.BAILIAN_CONSOLE_COOKIE
  process.env.BAILIAN_CONSOLE_COOKIE = 'cna=AAA; login_qianwenai_ticket=TICKET_CANARY'
  try {
    const loopSource = {
      ...PRESETS['token-plan-console'],
      url: 'http://127.0.0.1:' + server.address().port + '/data/api.json',
      infoUrl: 'http://127.0.0.1:' + server.address().port + '/tool/user/info.json',
    }
    const loopConfig = { ...effectiveConfig({ minIntervalMs: 0, timeoutMs: 5000 }, ctxStub), sources: [loopSource] }
    const ask = (query, config = loopConfig) => buildOfficialUsageSnapshot(config, ctxStub, query)

    officialCache.clear()
    seen.length = 0
    const three = await ask({ from: '2026-10-01', to: '2026-10-03' })
    check('008 回环：range / granularity / 日桶数', [three.range, three.granularity, three.buckets.length],
      [{ kind: 'custom', days: 3, from: '2026-10-01', to: '2026-10-03' }, 'day', 3])
    check('008 回环：四个口径分别累加', three.totals, { tokens: 100, input: 70, cacheRead: 50, output: 30 })
    check('008 回环：无点日补 0（不是漏桶）', three.buckets.map(b => b.tokens), [100, 0, 0])
    check('008 回环：coverage 交代接口与切片', [three.coverage.api, three.coverage.chunks, three.coverage.step, three.coverage.cached, three.coverage.totalDerived],
      [PRESETS['token-plan-console'].telemetryApi, 1, 'day', false, false])
    check('008 回环：source 标官方账号侧', [three.source.kind, three.source.veracity], ['official-console', 'verified'])
    ok('008 回环：官方数字是 tokens 口径，不出现计费点数/百分比',
      !JSON.stringify(three).includes('Credits') && !JSON.stringify(three).includes('%'))
    check('008 回环：Api 整条覆盖到 telemetry（不在 apiPrefix 下）', seen[0]?.api, PRESETS['token-plan-console'].telemetryApi)
    check('008 回环：reqDTO 按官方契约（productMode/step/metricFilters）',
      [seen[0]?.reqDTO.productMode, seen[0]?.reqDTO.step, seen[0]?.reqDTO.metricFilters?.[0]?.metricName],
      ['TokenPlanPersonal', 86_400, 'model_usage'])
    ok('008 回环：Cookie 与 sec_token 都带上', seen[0]?.cookie?.includes('TICKET_CANARY') === true)

    const again = await ask({ from: '2026-10-01', to: '2026-10-03' })
    check('008 缓存：同区间第二次不打网络', [again.coverage.cached, seen.length], [true, 1])
    const refreshed = await buildOfficialUsageSnapshot(loopConfig, ctxStub, { from: '2026-10-01', to: '2026-10-03' }, { fresh: true })
    check('008 缓存：fresh 强制回源', [refreshed.coverage.cached, seen.length], [false, 2])

    // 缓存按 from|to 命中，但 kind 属于**请求**：同一段日期先按自定义查、再按预设查，
    // 第二次命中的 range.kind 必须是 '3d' 而不是上次的 'custom'（否则屏上标题会写成自定义区间）。
    officialCache.clear()
    const todayKey = dayKey(Date.now())
    const minusTwo = dayKey(Date.now() - 2 * 86_400_000)
    await ask({ from: minusTwo, to: todayKey })
    const byPreset = await ask({ days: 3 })
    check('008 缓存：命中缓存时 range.kind 跟本次请求走', [byPreset.coverage.cached, byPreset.range.kind, byPreset.range.from, byPreset.range.to],
      [true, '3d', minusTwo, todayKey])

    mode = 'no-total'
    const derived = await ask({ from: '2026-10-05', to: '2026-10-05' })
    check('008 回环：没有 total_tokens 时派生并标记', [derived.totals.tokens, derived.coverage.totalDerived], [100, true])
    mode = 'ok'

    const earliestNow = officialEarliestDayKey({ now: Date.now(), monthsBack: 5 })
    const clampedAsk = await ask({ from: '2026-01-01', to: '2026-10-02' })
    check('008 回环：早于官方最早日被夹紧，并把被夹掉的起点报出来',
      [clampedAsk.coverage.clampedFrom, clampedAsk.range.from], ['2026-01-01', earliestNow])
    ok('008 回环：夹紧后的 from 早于请求的 from', clampedAsk.range.from > '2026-01-01')
    check('008 回环：夹紧后按 30 天分片（124 天 → 5 片）', clampedAsk.coverage.chunks, 5)

    const before = seen.length
    const badRange = await ask({ from: '2026-10-01' })
    check('008 参数：只给一端 → paramError + 固定码', [badRange.paramError, badRange.error], [true, 'usage-bad-range'])
    const tooLong = await ask({ from: '2025-01-01', to: '2026-11-12' })
    check('008 参数：超跨度 → paramError + maxDays', [tooLong.paramError, tooLong.error, tooLong.maxDays], [true, 'usage-range-too-long', 365])
    check('008 参数：两次非法请求都没有出网', seen.length, before)

    officialCache.clear()
    const off = await ask({ from: '2026-10-01', to: '2026-10-02' }, { ...loopConfig, officialUsage: false })
    check('008 开关：officialUsage=false → 固定码且不打网络', [off.code, seen.length], ['official-disabled', before])

    delete process.env.BAILIAN_CONSOLE_COOKIE
    const noCred = await ask({ from: '2026-10-06', to: '2026-10-06' })
    check('008 凭据：没有 Cookie → 固定码（不是空数字）', noCred.code, 'official-no-credentials')
    process.env.BAILIAN_CONSOLE_COOKIE = 'cna=AAA; login_qianwenai_ticket=TICKET_CANARY'

    mode = 'http-500'
    const up = await ask({ from: '2026-10-07', to: '2026-10-07' })
    check('008 上游：500 → official-unavailable / official-upstream', [up.error, up.code], ['official-unavailable', 'official-upstream'])
    mode = 'login'
    const login = await ask({ from: '2026-10-08', to: '2026-10-08' })
    check('008 上游：登录失效 → 单独的错误码', [login.error, login.code], ['official-unavailable', 'official-login-expired'])
    ok('008 上游：登录失效的提示可操作（有下一步，而不是只有错误码）', String(login.hint).length > 4, login.hint)
    ok('008 上游：任何错误体都不带凭据值', !JSON.stringify(login).includes('TICKET_CANARY') && !JSON.stringify(up).includes('TICKET_CANARY'))
    ok('008 上游：任何错误体都不带上游原文', !JSON.stringify(up).includes('boom'))
    mode = 'download'
    const download = await ask({ from: '2026-10-09', to: '2026-10-09' })
    check('008 上游：只给下载链接 → 明确的固定码（不跟外部主机）', [download.error, download.code], ['official-unavailable', 'official-download-url'])
    mode = 'ok'

    // 工具入口：模型侧也要能拿到同一份数字（且不把 365 个桶塞进工具输出）。
    const tool = buildQuotaTool(() => loopConfig, ctxStub)
    officialCache.clear()
    const toolOk = await tool.execute({ action: 'usage-official', from: '2026-10-01', to: '2026-10-03' })
    check('008 工具：usage-official 回 ok + 总量', [toolOk.ok, toolOk.official?.totals?.tokens], [true, 100])
    check('008 工具：不把逐日桶塞进工具输出', 'buckets' in (toolOk.official ?? {}), false)
    ok('008 工具：文本点明账号级口径', String(toolOk.text).includes('账号级'), toolOk.text)
    const toolBad = await tool.execute({ action: 'usage-official', from: '2026-10-01' })
    check('008 工具：参数非法 → ok=false + 固定码', [toolBad.ok, toolBad.error], [false, 'usage-bad-range'])
    const toolClip = await tool.execute({ action: 'usage-official', days: 7 })
    check('008 工具：按 days 查询也走同一条链路', [toolClip.ok, toolClip.official?.range?.kind], [true, '7d'])
  } finally {
    if (realCookie === undefined) delete process.env.BAILIAN_CONSOLE_COOKIE
    else process.env.BAILIAN_CONSOLE_COOKIE = realCookie
    await new Promise(resolve => server.close(resolve))
    officialCache.clear()
  }
}

// ⑬ 010 自然月：纯函数校验 / month 聚合与等价 from-to 同源 / 路由与工具接线
{
  // a) resolveMonthRange：合法月、夹紧、闰月、以及非法输入（010 §1.1）
  const SEPT = { month: '2026-09', from: '2026-09-01', to: '2026-09-30', days: 30 }
  const SEPT_RANGE = { kind: 'month', month: '2026-09', days: 30, from: '2026-09-01', to: '2026-09-30' }
  check('010 resolve：9 月整月', resolveMonthRange({ now: USAGE_NOW, month: '2026-09' }), SEPT)
  check('010 resolve：当前月夹到今天', resolveMonthRange({ now: USAGE_NOW, month: '2026-11' }),
    { month: '2026-11', from: '2026-11-01', to: '2026-11-12', days: 12 })
  check('010 resolve：闰年 2 月 29 天', resolveMonthRange({ now: USAGE_NOW, month: '2024-02' }),
    { month: '2024-02', from: '2024-02-01', to: '2024-02-29', days: 29 })
  // 2028 相对 2026-11 是未来月，用 2029 的视角单独验证闰年 2 月（规则本身与现在是几号无关）。
  const LATER_NOW = new Date(2029, 0, 15, 12, 0, 0).getTime()
  check('010 resolve：2028-02 闰月 29 天', resolveMonthRange({ now: LATER_NOW, month: '2028-02' }),
    { month: '2028-02', from: '2028-02-01', to: '2028-02-29', days: 29 })
  check('010 resolve：平年 2 月 28 天', resolveMonthRange({ now: USAGE_NOW, month: '2026-02' }),
    { month: '2026-02', from: '2026-02-01', to: '2026-02-28', days: 28 })
  check('010 resolve：12 月 31 天且不跨年', resolveMonthRange({ now: USAGE_NOW, month: '2025-12' }),
    { month: '2025-12', from: '2025-12-01', to: '2025-12-31', days: 31 })
  check('010 resolve：首尾空格被 trim', resolveMonthRange({ now: USAGE_NOW, month: '  2026-09  ' }), SEPT)
  // 单月最多 31 天，不套 usageBackfillDays：maxDays 再小也不该把整月裁短。
  check('010 resolve：不套后台天数上界', resolveMonthRange({ now: USAGE_NOW, month: '2026-09', maxDays: 5 }).days, 30)
  const badMonths = ['2026-13', '2026-00', '2026-1', '2026-9', 'abc', '', '2026-9 ', '0000-01', '0099-01', '2026-12', '2027-01']
  check('010 resolve：非法/未来月矩阵 → usage-bad-month',
    badMonths.map(month => resolveMonthRange({ now: USAGE_NOW, month })),
    badMonths.map(() => ({ error: 'usage-bad-month' })))
  check('010 resolve：非字符串输入 → usage-bad-month',
    [undefined, null, 123, {}, []].map(month => resolveMonthRange({ now: USAGE_NOW, month })),
    [undefined, null, 123, {}, []].map(() => ({ error: 'usage-bad-month' })))

  // b) month 聚合：桶与等价 from/to 完全同源，恰好铺满 [1 号, 月末]，优先于 from/to/days
  const monthIndex = emptyUsageIndex()
  monthIndex.days['2026-08-31'] = { input: 90, output: 9, cacheRead: 0, cacheWrite: 0, calls: 9, models: { 'p/m1': { input: 90, output: 9, cacheRead: 0, cacheWrite: 0, calls: 9 } } }
  monthIndex.days['2026-09-01'] = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1, models: { 'p/m1': { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } } }
  monthIndex.days['2026-09-03'] = { input: 20, output: 2, cacheRead: 5, cacheWrite: 0, calls: 2, models: { 'p/m1': { input: 12, output: 1, cacheRead: 5, cacheWrite: 0, calls: 1 }, 'p/m2': { input: 8, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 } } }
  monthIndex.days['2026-09-30'] = { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, calls: 3, models: { 'p/m1': { input: 30, output: 3, cacheRead: 0, cacheWrite: 0, calls: 3 } } }
  monthIndex.days['2026-10-01'] = { input: 70, output: 7, cacheRead: 0, cacheWrite: 0, calls: 7, models: { 'p/m1': { input: 70, output: 7, cacheRead: 0, cacheWrite: 0, calls: 7 } } }
  const monthAgg = aggregateUsageRange(monthIndex, { now: USAGE_NOW, month: '2026-09' })
  check('010 month：range 标 month 且 days 由日历现算', monthAgg.range, SEPT_RANGE)
  check('010 month：granularity=day', monthAgg.granularity, 'day')
  check('010 month：30 个日桶恰好铺满整月',
    [monthAgg.buckets.length, monthAgg.buckets[0].from, monthAgg.buckets[29].to],
    [30, '2026-09-01', '2026-09-30'])
  check('010 month：桶 label 是 MM-DD',
    [monthAgg.buckets[0].label, monthAgg.buckets[29].label], ['09-01', '09-30'])
  check('010 month：无记录日补 0 桶',
    [monthAgg.buckets[0].totals.calls, monthAgg.buckets[1].totals.calls, monthAgg.buckets[2].totals.calls],
    [1, 0, 2])
  check('010 month：只累计月内，边界外不计', monthAgg.totals,
    { input: 60, output: 6, cacheRead: 5, cacheWrite: 0, calls: 6, steps: 6, tokens: 71 })
  assertTotalsIdentity('010 month', monthAgg)
  const customSame = aggregateUsageRange(monthIndex, { now: USAGE_NOW, from: '2026-09-01', to: '2026-09-30' })
  check('010 month：与等价 from/to 逐桶相等', monthAgg.buckets, customSame.buckets)
  check('010 month：与等价 from/to totals 相等', monthAgg.totals, customSame.totals)
  check('010 month：与等价 from/to 模型归属相等', monthAgg.models, customSame.models)
  check('010 month：优先于 from/to/days',
    aggregateUsageRange(monthIndex, { now: USAGE_NOW, month: '2026-09', from: '2026-10-01', to: '2026-10-31', days: 3 }).range,
    monthAgg.range)
  check('010 month：非法 month 只被忽略，退回 days 分支',
    aggregateUsageRange(monthIndex, { now: USAGE_NOW, month: '2026-13', days: 7 }).range,
    { kind: '7d', days: 7, from: '2026-11-06', to: '2026-11-12' })
  const currentMonth = aggregateUsageRange(monthIndex, { now: USAGE_NOW, month: '2026-11' })
  check('010 month：当前月只铺到今天',
    [currentMonth.range, currentMonth.buckets.length], [{ kind: 'month', month: '2026-11', days: 12, from: '2026-11-01', to: '2026-11-12' }, 12])
  check('010 month：当前月无记录时 totals 全 0', currentMonth.totals.calls, 0)

  // c) 路由：?month= 200 / 夹紧 / 400 固定码 / 与等价 from-to 逐桶一致；工具同语义
  resetInstanceState()
  const monthPersistence = makeFakePersistence({
    'sess-month': {
      revision: 'r-month',
      events: [
        headerEvent(1, new Date(2026, 8, 1, 12, 0, 0).getTime()),
        usageEvent(2, new Date(2026, 8, 1, 12, 0, 1).getTime(), { inputTokens: 5, outputTokens: 0 }),
        headerEvent(3, new Date(2026, 8, 3, 12, 0, 0).getTime()),
        usageEvent(4, new Date(2026, 8, 3, 12, 0, 1).getTime(), { inputTokens: 10, outputTokens: 0 }),
        headerEvent(5, new Date(2026, 9, 10, 12, 0, 0).getTime()),
        usageEvent(6, new Date(2026, 9, 10, 12, 0, 1).getTime(), { inputTokens: 20, outputTokens: 0 }),
        usageEvent(7, new Date(2026, 10, 12, 12, 0, 0).getTime(), { inputTokens: 40, outputTokens: 0 }),
      ],
    },
  })
  const monthRow = { sources: [], usageIndexPath: join(TEST_HOME, 'usage-index-month-range.json') }
  const monthRouteCtx = makeRouteCtx(monthPersistence)
  resetInstanceState()
  apply(monthRouteCtx.ctx, monthRow)
  const monthRoute = monthRouteCtx.registered.find(item => item.path === '/token-plan-quota')
  const realDateNow = Date.now
  try {
    Date.now = () => USAGE_NOW
    await runUsageSync(monthRouteCtx.ctx, effectiveConfig(monthRow, monthRouteCtx.ctx))
    const sepMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-09')
    check('010 路由：?month=2026-09 → 200', sepMonth.status, 200)
    check('010 路由：range 标 month 并回真值', sepMonth.json.range, SEPT_RANGE)
    check('010 路由：30 个桶与月内 totals',
      [sepMonth.json.buckets.length, sepMonth.json.totals],
      [30, { input: 15, output: 0, cacheRead: 0, cacheWrite: 0, calls: 2, steps: 2, tokens: 15 }])
    check('010 路由：月内无记录日补 0 桶',
      [sepMonth.json.buckets[0].totals.calls, sepMonth.json.buckets[1].totals.calls, sepMonth.json.buckets[2].totals.calls],
      [1, 0, 1])
    const sepCustom = await callUsageRoute(monthRoute, '/token-plan-quota/usage?from=2026-09-01&to=2026-09-30')
    check('010 路由：month 与等价 from/to 逐桶相等', sepMonth.json.buckets, sepCustom.json.buckets)
    check('010 路由：month 与等价 from/to totals 相等', sepMonth.json.totals, sepCustom.json.totals)
    check('010 回归：from/to 仍标 custom', [sepCustom.json.range.kind, sepCustom.json.range.days], ['custom', 30])
    const plainDays = await callUsageRoute(monthRoute, '/token-plan-quota/usage?days=7')
    check('010 回归：days 仍标 7d 且 7 个桶',
      [plainDays.json.range.kind, plainDays.json.range.days, plainDays.json.buckets.length], ['7d', 7, 7])
    const current = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-11')
    check('010 路由：当前月夹到今天并回写真值',
      [current.json.range, current.json.buckets.length],
      [{ kind: 'month', month: '2026-11', days: 12, from: '2026-11-01', to: '2026-11-12' }, 12])
    check('010 路由：当前月 totals', current.json.totals,
      { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, steps: 1, tokens: 40 })
    const monthIgnoringDays = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-09&days=1&range=today')
    check('010 路由：month 在时忽略 days/range', [monthIgnoringDays.json.range.kind, monthIgnoringDays.json.range.days],
      ['month', 30])
    const mixedFrom = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-09&from=2026-09-01')
    check('010 路由：month + from → 400 usage-bad-range', [mixedFrom.status, mixedFrom.json], [400, { error: 'usage-bad-range' }])
    const mixedTo = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-09&to=2026-09-30')
    check('010 路由：month + to → 400 usage-bad-range', [mixedTo.status, mixedTo.json], [400, { error: 'usage-bad-range' }])
    const badMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-13')
    check('010 路由：13 月 → 400 usage-bad-month', [badMonth.status, badMonth.json], [400, { error: 'usage-bad-month' }])
    const futureMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-12')
    check('010 路由：未来月 → 400 usage-bad-month', [futureMonth.status, futureMonth.json], [400, { error: 'usage-bad-month' }])
    const emptyMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=')
    check('010 路由：空 month 视为未给，回到 006 分支',
      [emptyMonth.status, emptyMonth.json.range.kind, emptyMonth.json.range.days], [200, '7d', 7])
    const postMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage?month=2026-09', 'POST')
    check('010 路由：POST → 405', postMonth.status, 405)
    ok('010 路由：响应没有百分号', !sepMonth.raw.includes('%'))
    ok('010 路由：响应没有消息文本 / 表头字段',
      !recursiveKeys(sepMonth.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
    ok('010 路由：400 响应同样只有固定码',
      !recursiveKeys(badMonth.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
    // usage-official 的参数层与 /usage 同码同形：参数错在取凭据 / 联网之前就返回 400。
    const officialBadMonth = await callUsageRoute(monthRoute, '/token-plan-quota/usage-official?month=2026-13')
    check('010 官方路由：非法 month → 400 usage-bad-month', [officialBadMonth.status, officialBadMonth.json],
      [400, { error: 'usage-bad-month' }])
    const officialMixed = await callUsageRoute(monthRoute, '/token-plan-quota/usage-official?month=2026-09&from=2026-09-01')
    check('010 官方路由：month + from → 400 usage-bad-range', [officialMixed.status, officialMixed.json],
      [400, { error: 'usage-bad-range' }])
    const officialFuture = await callUsageRoute(monthRoute, '/token-plan-quota/usage-official?month=2026-12')
    check('010 官方路由：未来月 → 400 usage-bad-month', [officialFuture.status, officialFuture.json],
      [400, { error: 'usage-bad-month' }])

    // 官方侧区间解析（纯函数）：与本机共用 month 语义，但成功快照要联网，单测只验区间层。
    const monthConfig = effectiveConfig(monthRow, monthRouteCtx.ctx)
    check('010 官方 range：month 形状与夹紧',
      resolveOfficialRange(monthConfig, { month: '2026-11' }, USAGE_NOW),
      { kind: 'month', month: '2026-11', days: 12, from: '2026-11-01', to: '2026-11-12' })
    check('010 官方 range：month + from → paramError', resolveOfficialRange(monthConfig, { month: '2026-09', from: '2026-09-01' }, USAGE_NOW),
      { error: 'usage-bad-range', paramError: true })
    check('010 官方 range：非法 month → paramError', resolveOfficialRange(monthConfig, { month: '2026-00' }, USAGE_NOW),
      { error: 'usage-bad-month', paramError: true })
    check('010 官方 range：未给 month 行为不变', resolveOfficialRange(monthConfig, { days: 7 }, USAGE_NOW).kind, '7d')

    // 工具：month 成功 / 非法 / 与 from-to 混用；官方 action 在取凭据前就会因参数错误返回。
    const monthTool = buildQuotaTool(() => effectiveConfig(monthRow, monthRouteCtx.ctx), monthRouteCtx.ctx)
    const toolMonth = await monthTool.execute({ action: 'usage', month: '2026-09' })
    check('010 工具：action=usage 传 month', [toolMonth.ok, toolMonth.usage.range],
      [true, SEPT_RANGE])
    ok('010 工具：文本说「2026 年 9 月（30 天）」', String(toolMonth.text).includes('2026 年 9 月（30 天）'), toolMonth.text)
    const toolBadMonth = await monthTool.execute({ action: 'usage', month: '2026-13' })
    check('010 工具：非法 month → ok=false + 固定码', [toolBadMonth.ok, toolBadMonth.error], [false, 'usage-bad-month'])
    ok('010 工具：月份错误文本给格式提示', String(toolBadMonth.text).includes('YYYY-MM'), toolBadMonth.text)
    const toolMix = await monthTool.execute({ action: 'usage', month: '2026-09', from: '2026-09-01' })
    check('010 工具：month + from → ok=false usage-bad-range', [toolMix.ok, toolMix.error], [false, 'usage-bad-range'])
    ok('010 工具：混用文本点明 month 与 from/to', String(toolMix.text).includes('month'), toolMix.text)
    const toolOfficialBad = await monthTool.execute({ action: 'usage-official', month: '2026-13' })
    check('010 工具：usage-official 非法 month → ok=false', [toolOfficialBad.ok, toolOfficialBad.error], [false, 'usage-bad-month'])
    const toolOfficialMix = await monthTool.execute({ action: 'usage-official', month: '2026-09', to: '2026-09-30' })
    check('010 工具：usage-official 混用 → ok=false', [toolOfficialMix.ok, toolOfficialMix.error], [false, 'usage-bad-range'])
  } finally {
    Date.now = realDateNow
  }
}

/* ============================================ 15. 013 模型归属跨片继承（T201–T205）
 *
 * 反例现场：增量折叠只读 lastSeq+1 之后的切片，切片里没有 request/header 时
 * provider/model 上下文丢失，整片记成 unknown。修复后上下文随 sessions[id] 落盘，
 * 下一片从上一片继承。全部离线（假 persistence + tmp 日志 fixture）。
 */
{
  resetInstanceState()
  const modelConfig = effectiveConfig({ usageBackfillDays: 365, sources: [] }, ctxStub)

  // T201：两片增量，第二片只有 assistant/message，模型沿用第一片的 header
  {
    const persistence = makeFakePersistence({
      'sess-model-two': {
        revision: 'rev-1',
        events: [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW + 1000, { inputTokens: 10, outputTokens: 2 })],
      },
    })
    const index = emptyUsageIndex()
    const first = await syncUsageIndex({ persistence, index, config: modelConfig, now: USAGE_NOW })
    check('013 T201：首片模型归位',
      [Object.keys(index.days[USAGE_DAY].models), index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls],
      [['qwen-token-plan-cn/qwen3.8-flash'], 1])
    check('013 T201：首片把最近模型写进索引',
      [index.sessions['sess-model-two'].lastProvider, index.sessions['sess-model-two'].lastModel],
      ['qwen-token-plan-cn', 'qwen3.8-flash'])
    check('013 T201：首片 unknownModel=0', [first.unknownModel, index.stats.unknownModel], [0, 0])

    persistence.sessions[0].revision = 'rev-2'
    persistence.sessions[0].events.push(usageEvent(3, USAGE_NOW + 2000, { inputTokens: 5, outputTokens: 1 }))
    const second = await syncUsageIndex({ persistence, index, config: modelConfig, now: USAGE_NOW })
    check('013 T201：第二片沿用上一片的模型（不是 unknown）',
      [Object.keys(index.days[USAGE_DAY].models), index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls],
      [['qwen-token-plan-cn/qwen3.8-flash'], 2])
    check('013 T201：第二片 unknownModel=0', [second.unknownModel, index.stats.unknownModel], [0, 0])
    check('013 T201：第二片读起点是 lastSeq+1', persistence.reads[persistence.reads.length - 1].offset, 3)
    check('013 T201：第二片不改写已记下的模型',
      [index.sessions['sess-model-two'].lastProvider, index.sessions['sess-model-two'].lastModel],
      ['qwen-token-plan-cn', 'qwen3.8-flash'])
  }

  // T202：三片 —— 片 2 无 header 沿用片 1，片 3 带新 header 换模型
  {
    const persistence = makeFakePersistence({
      'sess-model-three': {
        revision: 'rev-1',
        events: [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW + 1000, { inputTokens: 10, outputTokens: 2 })],
      },
    })
    const index = emptyUsageIndex()
    await syncUsageIndex({ persistence, index, config: modelConfig, now: USAGE_NOW })

    persistence.sessions[0].revision = 'rev-2'
    persistence.sessions[0].events.push(usageEvent(3, USAGE_NOW + 2000, { inputTokens: 10, outputTokens: 2 }))
    const middle = await syncUsageIndex({ persistence, index, config: modelConfig, now: USAGE_NOW })
    check('013 T202：无 header 的中间片沿用片 1 模型',
      index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls, 2)
    check('013 T202：中间片 unknownModel=0', [middle.unknownModel, index.stats.unknownModel], [0, 0])

    persistence.sessions[0].revision = 'rev-3'
    persistence.sessions[0].events.push(
      headerEvent(4, USAGE_NOW + 3000, 'deepseek', 'deepseek-v4.1-flash-1017'),
      usageEvent(5, USAGE_NOW + 4000, { inputTokens: 7, outputTokens: 3 }),
    )
    const switched = await syncUsageIndex({ persistence, index, config: modelConfig, now: USAGE_NOW })
    check('013 T202：片 3 的新 header 换模型',
      [index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls,
        index.days[USAGE_DAY].models['deepseek/deepseek-v4.1-flash-1017'].calls],
      [2, 1])
    check('013 T202：换模型后索引记新模型',
      [index.sessions['sess-model-three'].lastProvider, index.sessions['sess-model-three'].lastModel],
      ['deepseek', 'deepseek-v4.1-flash-1017'])
    check('013 T202：三片全程 unknownModel=0', [switched.unknownModel, index.stats.unknownModel], [0, 0])
  }

  // T203：兜底目录扫描同样继承（没有 persistence，只能读磁盘日志）
  {
    const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'
    if (HAS_ZSTD) {
      const root = join(TEST_HOME, 'usage-model-fallback')
      rmSync(root, { recursive: true, force: true })
      const writeFallbackLog = events => {
        const dir = join(root, 'p', 'hidden-model')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'session.v4.jsonl.zstd'),
          zlib.zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')))
      }
      const firstEvents = [headerEvent(1, USAGE_NOW), usageEvent(2, USAGE_NOW + 1000, { inputTokens: 10, outputTokens: 2 })]
      writeFallbackLog(firstEvents)
      const index = emptyUsageIndex()
      const first = await syncUsageIndex({ index, config: modelConfig, sessionsDir: root, now: USAGE_NOW })
      check('013 T203：兜底首片救回并归位模型',
        [first.rescued, Object.keys(index.days[USAGE_DAY].models), index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls],
        [1, ['qwen-token-plan-cn/qwen3.8-flash'], 1])
      check('013 T203：兜底首片写下最近模型',
        [index.sessions['hidden-model'].lastProvider, index.sessions['hidden-model'].lastModel],
        ['qwen-token-plan-cn', 'qwen3.8-flash'])

      writeFallbackLog(firstEvents.concat(usageEvent(3, USAGE_NOW + 2000, { inputTokens: 5, outputTokens: 1 })))
      const second = await syncUsageIndex({ index, config: modelConfig, sessionsDir: root, now: USAGE_NOW })
      check('013 T203：兜底第二片沿用上一片模型',
        [second.rescued, index.days[USAGE_DAY].models['qwen-token-plan-cn/qwen3.8-flash'].calls],
        [1, 2])
      check('013 T203：兜底第二片 unknownModel=0', [second.unknownModel, index.stats.unknownModel], [0, 0])
    } else {
      ok('013 T203：本机 Node 无 zstd（兜底模型继承用例跳过）', true)
    }
  }

  // T204：schema 守卫 + v1 索引迁移
  {
    const shapeError = value => {
      try { assertUsageIndexShape(value); return '' } catch (error) { return String(error && error.message ? error.message : error) }
    }
    const paired = emptyUsageIndex()
    paired.sessions['sess-shape'] = { revision: 'r', lastSeq: 1, cut: 0, lastProvider: 'p', lastModel: 'm' }
    check('013 T204：两键齐全且非空 → 放行', shapeError(paired), '')
    const badProvider = structuredClone(paired)
    badProvider.sessions['sess-shape'].lastProvider = ''
    ok('013 T204：lastProvider 空串 → 抛非空字符串错',
      /sessions\[sess-shape\]\.lastProvider 不是非空字符串/.test(shapeError(badProvider)))
    const badModel = structuredClone(paired)
    badModel.sessions['sess-shape'].lastModel = '   '
    ok('013 T204：lastModel 只有空白 → 抛非空字符串错',
      /sessions\[sess-shape\]\.lastModel 不是非空字符串/.test(shapeError(badModel)))
    const badType = structuredClone(paired)
    badType.sessions['sess-shape'].lastProvider = 42
    ok('013 T204：lastProvider 非字符串 → 抛非空字符串错',
      /sessions\[sess-shape\]\.lastProvider 不是非空字符串/.test(shapeError(badType)))
    const onlyProvider = structuredClone(paired)
    delete onlyProvider.sessions['sess-shape'].lastModel
    ok('013 T204：只出现一个键 → 抛必须同时存在',
      /lastProvider 与 lastModel 必须同时存在/.test(shapeError(onlyProvider)))

    const legacy = { version: 1, updatedAt: 0, sessions: { legacy: { revision: 'r', lastSeq: 1, cut: 0 } }, days: {}, stats: { unknownModel: 0, skippedOld: 0 } }
    ok('013 T204：version 1 → schema 报版本错', /version 不是 2/.test(shapeError(legacy)))
    const legacyPath = join(TEST_HOME, 'usage-index-v1.json')
    writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')
    const loaded = loadUsageIndex(legacyPath)
    check('013 T204：v1 文件加载 → 空索引（version 2）',
      [loaded.version, Object.keys(loaded.sessions).length, Object.keys(loaded.days).length, loaded.updatedAt], [2, 0, 0, 0])
    ok('013 T204：v1 加载生成 .bad- 备份',
      readdirSync(TEST_HOME).some(name => name.startsWith('usage-index-v1.json.bad-')))
    ok('013 T204：v1 内容没进内存', !JSON.stringify(loaded).includes('legacy'))
  }

  // T205：foldUsageEvents 的默认值 / 空 header 语义
  {
    const noHeaderIndex = emptyUsageIndex()
    const noHeader = foldUsageEvents(noHeaderIndex, [usageEvent(1, USAGE_NOW, { inputTokens: 1, outputTokens: 0 })], 1, 0,
      { retentionDays: 365, now: USAGE_NOW })
    check('013 T205：无 header 且无默认值 → provider/model 为空串', [noHeader.provider, noHeader.model], ['', ''])
    check('013 T205：无上下文仍记 unknown 并累加',
      [noHeader.unknownModel, noHeaderIndex.stats.unknownModel, noHeaderIndex.days[USAGE_DAY].models['unknown/unknown'].calls], [1, 1, 1])

    const seededIndex = emptyUsageIndex()
    const seeded = foldUsageEvents(seededIndex, [usageEvent(1, USAGE_NOW, { inputTokens: 2, outputTokens: 0 })], 1, 0,
      { retentionDays: 365, now: USAGE_NOW, modelDefaults: { provider: ' qwen-token-plan-cn ', model: ' qwen3.8-flash ' } })
    check('013 T205：默认值在片首播种且 trim', [seeded.provider, seeded.model], ['qwen-token-plan-cn', 'qwen3.8-flash'])
    check('013 T205：默认值让本片不记 unknown',
      [seeded.unknownModel, seededIndex.stats.unknownModel, Object.keys(seededIndex.days[USAGE_DAY].models)],
      [0, 0, ['qwen-token-plan-cn/qwen3.8-flash']])

    const blankIndex = emptyUsageIndex()
    const blank = foldUsageEvents(blankIndex, [
      headerEvent(1, USAGE_NOW, '', ''),
      usageEvent(2, USAGE_NOW + 1000, { inputTokens: 3, outputTokens: 0 }),
    ], 1, 0, { retentionDays: 365, now: USAGE_NOW, modelDefaults: { provider: 'p', model: 'm' } })
    check('013 T205：空串 header 不覆盖默认值', [blank.provider, blank.model], ['p', 'm'])

    const partialIndex = emptyUsageIndex()
    const partial = foldUsageEvents(partialIndex, [
      headerEvent(1, USAGE_NOW, 'deepseek', ''),
      usageEvent(2, USAGE_NOW + 1000, { inputTokens: 3, outputTokens: 0 }),
    ], 1, 0, { retentionDays: 365, now: USAGE_NOW, modelDefaults: { provider: 'p', model: 'm' } })
    check('013 T205：只有一半的 header 不覆盖默认值', [partial.provider, partial.model], ['p', 'm'])

    const overrideIndex = emptyUsageIndex()
    const override = foldUsageEvents(overrideIndex, [
      headerEvent(1, USAGE_NOW, 'deepseek', 'deepseek-v4.1-flash-1017'),
      usageEvent(2, USAGE_NOW + 1000, { inputTokens: 4, outputTokens: 0 }),
    ], 1, 0, { retentionDays: 365, now: USAGE_NOW, modelDefaults: { provider: 'p', model: 'm' } })
    check('013 T205：片内合法 header 覆盖默认值',
      [override.provider, override.model, Object.keys(overrideIndex.days[USAGE_DAY].models)],
      ['deepseek', 'deepseek-v4.1-flash-1017', ['deepseek/deepseek-v4.1-flash-1017']])
  }
}


// ---------------------------------------------------------------------------
// 014：Credits ↔ tokens 换算。纯函数断言 + 只读路由；不联网、不读真实 ~/.dsh。
// ---------------------------------------------------------------------------
{
  const CREDITS_NOW = new Date(2026, 10, 14, 12, 0, 0).getTime()
  const MONTH_RESET = new Date(2026, 11, 1, 0, 0, 0).getTime()
  const WEEK_RESET = new Date(2026, 10, 17, 0, 0, 0).getTime()
  const makeCard = (meters) => ({
    id: 'token-plan-console',
    label: '千问控制台',
    unit: 'Credits',
    total: 80000,
    used: 37196.8802,
    usedPercent: 46.4961,
    meters,
  })
  const monthlyMeter = {
    key: 'monthly', label: '本月', labelEn: 'Monthly', unit: 'Credits',
    total: 80000, used: 37196.8802, usedPercent: 46.4961, resetAt: MONTH_RESET,
  }

  const monthly = creditsCycleOf(makeCard([monthlyMeter, {
    key: 'weekly', total: 999, used: 1, usedPercent: 0.1, resetAt: WEEK_RESET,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：monthly 优先且返回完整窗口',
    [monthly.ok, monthly.key, monthly.label, monthly.labelEn, monthly.from, monthly.to, monthly.resetAt,
      monthly.resetDay, monthly.cycleDays, monthly.elapsedDays, monthly.total, monthly.used, monthly.usedPercent],
    [true, 'monthly', '本月账期', 'Monthly cycle', '2026-11-01', '2026-11-14', MONTH_RESET,
      '2026-11-30', 30, 14, 80000, 37196.8802, 46.4961])

  const weekly = creditsCycleOf(makeCard([{
    key: 'weekly', total: 1000, used: 250, usedPercent: 25, resetAt: WEEK_RESET,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：weekly 回退 7 天',
    [weekly.ok, weekly.key, weekly.label, weekly.labelEn, weekly.from, weekly.to,
      weekly.resetDay, weekly.cycleDays, weekly.elapsedDays, weekly.total, weekly.used],
    [true, 'weekly', '7 天账期', '7-day cycle', '2026-11-10', '2026-11-14',
      '2026-11-16', 7, 5, 1000, 250])

  const fiveOnly = creditsCycleOf(makeCard([{
    key: 'fiveHour', total: 100, used: 10, usedPercent: 10, resetAt: CREDITS_NOW + 3600_000,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：只有 fiveHour → five-hour-only',
    [fiveOnly.ok, fiveOnly.reason], [false, 'five-hour-only'])

  const noTotal = creditsCycleOf(makeCard([{
    key: 'monthly', used: 100, usedPercent: 10, resetAt: MONTH_RESET,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：缺 total → no-credits-total',
    [noTotal.ok, noTotal.reason], [false, 'no-credits-total'])

  const noReset = creditsCycleOf(makeCard([{
    key: 'monthly', total: 1000, used: 100, usedPercent: 10,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：缺 resetAt → no-reset-time',
    [noReset.ok, noReset.reason], [false, 'no-reset-time'])

  const byPercent = creditsCycleOf(makeCard([{
    key: 'monthly', total: 1000, used: null, usedPercent: 40, resetAt: MONTH_RESET,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：used 由 percent 兜底',
    [byPercent.ok, byPercent.used, byPercent.usedPercent], [true, 400, 40])

  const derivedPercent = creditsCycleOf(makeCard([{
    key: 'monthly', total: 1000, used: 250, resetAt: MONTH_RESET,
  }]), CREDITS_NOW)
  check('014 creditsCycleOf：usedPercent 由 used/total 兜底',
    [derivedPercent.ok, derivedPercent.usedPercent], [true, 25])

  const badCard = creditsCycleOf(undefined, CREDITS_NOW)
  const emptyCard = creditsCycleOf({}, CREDITS_NOW)
  check('014 creditsCycleOf：非法卡 → no-credits-reading',
    [badCard.ok, badCard.reason, emptyCard.ok, emptyCard.reason],
    [false, 'no-credits-reading', false, 'no-credits-reading'])

  const futureReset = new Date(2026, 11, 1, 0, 0, 0).getTime()
  const invertedNow = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const inverted = creditsCycleOf(makeCard([{
    key: 'monthly', total: 1000, used: 10, usedPercent: 1, resetAt: futureReset,
  }]), invertedNow)
  check('014 creditsCycleOf：from > to → no-credits-reading', [inverted.ok, inverted.reason],
    [false, 'no-credits-reading'])

  const monthEnd = creditsCycleOf(makeCard([{
    key: 'monthly', total: 1000, used: 10, usedPercent: 1,
    resetAt: new Date(2026, 2, 31, 0, 0, 0).getTime(),
  }]), new Date(2026, 2, 15, 12, 0, 0).getTime())
  check('014 creditsCycleOf：月末回退自然月并夹到 2/28', [monthEnd.ok, monthEnd.from], [true, '2026-02-28'])

  const ratio = creditsTokenRatioOf(2122918870, 37196.8802)
  ok('014 creditsTokenRatioOf：官方示例 ≈ 57072', ratio !== null && Math.abs(ratio - 57072) < 1)
  check('014 creditsTokenRatioOf：tokens=0 → null', creditsTokenRatioOf(0, 100), null)
  check('014 creditsTokenRatioOf：used=0 → null', creditsTokenRatioOf(100, 0), null)
  check('014 creditsTokenRatioOf：负数/NaN/缺失 → null',
    [creditsTokenRatioOf(-1, 10), creditsTokenRatioOf(10, -1), creditsTokenRatioOf(NaN, 10), creditsTokenRatioOf(undefined, 10)],
    [null, null, null, null])

  const officialOk = (overrides = {}) => ({
    generatedAt: CREDITS_NOW,
    range: { kind: 'custom', days: 14, from: '2026-11-01', to: '2026-11-14' },
    granularity: 'day',
    totals: { tokens: 2122918870 },
    buckets: [],
    source: { kind: 'official-account', veracity: 'official' },
    coverage: { cached: false },
    ...overrides,
  })

  const available = composeCreditsToken({
    card: makeCard([monthlyMeter]),
    official: officialOk(),
    localTotals: { totals: { tokens: 2080883520 } },
    now: CREDITS_NOW,
  })
  check('014 compose：available 与 generatedAt', [available.available, available.generatedAt], [true, CREDITS_NOW])
  check('014 compose：window 全字段', available.window, {
    key: 'monthly', label: '本月账期', labelEn: 'Monthly cycle', from: '2026-11-01', to: '2026-11-14',
    resetAt: MONTH_RESET, resetDay: '2026-11-30', cycleDays: 30, elapsedDays: 14,
  })
  check('014 compose：credits 全字段', available.credits,
    { unit: 'Credits', total: 80000, used: 37196.8802, usedPercent: 46.4961 })
  check('014 compose：tokens 官方/本机', available.tokens,
    { official: 2122918870, local: 2080883520 })
  ok('014 compose：ratio.tokensPerCredit 为原始浮点', Math.abs(available.ratio.tokensPerCredit - 57072) < 1)
  check('014 compose：capacityTokens 取整且等于 ratio×total',
    [Number.isInteger(available.ratio.capacityTokens), available.ratio.capacityTokens === Math.round(available.ratio.tokensPerCredit * 80000)],
    [true, true])
  check('014 compose：scope 全字段', available.scope, {
    officialFrom: '2026-11-01', officialTo: '2026-11-14', officialDays: 14, cached: false, clampedFrom: null,
  })
  check('014 compose：source 四字段', available.source, {
    kind: 'credits-token', veracity: 'measured',
    label: '官方 Credits × 官方 tokens（本账期实测）',
    labelEn: 'Official credits × official tokens (measured this cycle)',
  })

  const localMissing = composeCreditsToken({
    card: makeCard([monthlyMeter]), official: officialOk(), localTotals: null, now: CREDITS_NOW,
  })
  check('014 compose：本机 null 时 local=null', localMissing.tokens.local, null)

  const weeklyCompose = composeCreditsToken({
    card: makeCard([{ key: 'weekly', total: 1000, used: 250, usedPercent: 25, resetAt: WEEK_RESET }]),
    official: officialOk({ range: { days: 5, from: '2026-11-10', to: '2026-11-14' } }),
    localTotals: null,
    now: CREDITS_NOW,
  })
  check('014 compose：weekly 标签', [weeklyCompose.available, weeklyCompose.window.label, weeklyCompose.window.labelEn],
    [true, '7 天账期', '7-day cycle'])

  const clamped = composeCreditsToken({
    card: makeCard([monthlyMeter]),
    official: officialOk({ coverage: { cached: true, clampedFrom: '2026-11-03' } }),
    localTotals: null,
    now: CREDITS_NOW,
  })
  check('014 compose：官方明细被夹紧 → official-clamped',
    [clamped.available, clamped.reason, clamped.code, clamped.hint.includes('2026-11-03')],
    [false, 'official-clamped', 'official-clamped', true])

  const officialFailed = composeCreditsToken({
    card: makeCard([monthlyMeter]),
    official: { error: 'official-unavailable', code: 'official-disabled', hint: '官方明细已关闭' },
    localTotals: null,
    now: CREDITS_NOW,
  })
  check('014 compose：官方失败体透传 code/hint',
    [officialFailed.available, officialFailed.reason, officialFailed.code, officialFailed.hint],
    [false, 'official-unavailable', 'official-disabled', '官方明细已关闭'])

  const zeroTokens = composeCreditsToken({
    card: makeCard([monthlyMeter]), official: officialOk({ totals: { tokens: 0 } }), localTotals: null, now: CREDITS_NOW,
  })
  check('014 compose：官方 tokens=0 → no-token-data',
    [zeroTokens.available, zeroTokens.reason], [false, 'no-token-data'])

  const consoleFailed = composeCreditsToken({
    card: { id: 'token-plan-console', error: 'Cookie expired', errorCode: 'NoCredentials', hint: '重新登录控制台' },
    official: null, localTotals: null, now: CREDITS_NOW,
  })
  check('014 compose：控制台卡报错 → console-unavailable 并透传 code/hint',
    [consoleFailed.available, consoleFailed.reason, consoleFailed.code, consoleFailed.hint],
    [false, 'console-unavailable', 'NoCredentials', '重新登录控制台'])

  const noConsole = composeCreditsToken({ card: undefined, official: null, localTotals: null, now: CREDITS_NOW })
  check('014 compose：无控制台卡 → no-console-card', [noConsole.available, noConsole.reason], [false, 'no-console-card'])

  const cycleReasons = [
    composeCreditsToken({ card: makeCard([{ key: 'fiveHour', total: 1, used: 1, usedPercent: 100, resetAt: CREDITS_NOW }]), official: null, localTotals: null, now: CREDITS_NOW }),
    composeCreditsToken({ card: makeCard([{ key: 'monthly', used: 1, usedPercent: 10, resetAt: MONTH_RESET }]), official: null, localTotals: null, now: CREDITS_NOW }),
    composeCreditsToken({ card: makeCard([{ key: 'monthly', total: 100, used: 1, usedPercent: 1 }]), official: null, localTotals: null, now: CREDITS_NOW }),
    composeCreditsToken({ card: makeCard([]), official: null, localTotals: null, now: CREDITS_NOW }),
  ]
  check('014 compose：账期五种失败原因全覆盖',
    cycleReasons.map(item => item.reason),
    ['five-hour-only', 'no-credits-total', 'no-reset-time', 'no-credits-reading'])
  check('014 compose：可用态不含 code/hint 占位', ['code' in available, 'hint' in available], [false, false])

  // 路由：无控制台源 → 200 + available:false（不是 500），POST → 405，404 清单含新路由。
  {
    const persistence = makeFakePersistence({})
    const row = { sources: [], officialUsage: false, usageIndexPath: join(TEST_HOME, 'usage-index-credits-route.json') }
    const { ctx, registered } = makeRouteCtx(persistence)
    resetInstanceState()
    apply(ctx, row)
    const route = registered.find(item => item.path === '/token-plan-quota')
    ok('014 路由：usage-credits 随 prefix 注册', route !== undefined)
    const got = await callUsageRoute(route, '/token-plan-quota/usage-credits')
    check('014 路由：无卡 → 200', got.status, 200)
    check('014 路由：无卡 → available:false / no-console-card',
      [got.json.available, got.json.reason, got.json.code], [false, 'no-console-card', 'no-console-card'])
    ok('014 路由：响应无百分号', !got.raw.includes('%'))
    ok('014 路由：响应无消息文本 / 表头字段', !recursiveKeys(got.json).some(key => /^(text|messages?|headers?|cookies?|body|content|secret)$/i.test(key)))
    ok('014 路由：响应无落盘路径', !got.raw.includes('usage-index-credits-route'))
    const fresh = await callUsageRoute(route, '/token-plan-quota/usage-credits?fresh=1')
    check('014 路由：fresh=1 仍 200', [fresh.status, fresh.json.available], [200, false])
    const post = await callUsageRoute(route, '/token-plan-quota/usage-credits', 'POST')
    check('014 路由：POST → 405', post.status, 405)
    const notFound = await callUsageRoute(route, '/token-plan-quota/nope')
    check('014 路由：404 清单含 usage-credits',
      notFound.status === 404 && notFound.json.routes.includes('usage-credits'), true)
    ok('014 __internals：buildCreditsTokenSnapshot 可调', typeof buildCreditsTokenSnapshot === 'function')
  }
}

// ---------------------------------------------------------------------------
// 015：Credits 比值的官方分项 + 本机按模型贡献。纯函数断言；不联网、不读真实 ~/.dsh。
// ---------------------------------------------------------------------------
{
  const NOW = new Date(2026, 10, 14, 12, 0, 0).getTime()
  const USED = 37196.8802
  const OFFICIAL_TOTALS = {
    tokens: 2122918870,
    input: 2112709710,
    cacheRead: 2039167232,
    output: 10209160,
  }
  const CARD = {
    id: 'token-plan-console',
    label: '千问控制台',
    unit: 'Credits',
    total: 80000,
    used: USED,
    usedPercent: 46.4961,
    meters: [{
      key: 'monthly', label: '本月', labelEn: 'Monthly', unit: 'Credits',
      total: 80000, used: USED, usedPercent: 46.4961,
      resetAt: new Date(2026, 11, 1, 0, 0, 0).getTime(),
    }],
  }
  const officialFull = {
    generatedAt: NOW,
    range: { kind: 'custom', days: 14, from: '2026-11-01', to: '2026-11-14' },
    granularity: 'day',
    totals: OFFICIAL_TOTALS,
    buckets: [],
    source: { kind: 'official-account', veracity: 'official' },
    coverage: { cached: false },
  }

  // 官方 input 含 cacheRead：未命中输入 = input - cacheRead，三类相加必须精确回到官方总量。
  const classes = creditsClassRatios(OFFICIAL_TOTALS, USED)
  check('015 creditsClassRatios：三类 tokens（未命中已减缓存命中）',
    [classes.uncachedInput.tokens, classes.cacheRead.tokens, classes.output.tokens],
    [73542478, 2039167232, 10209160])
  ok('015 creditsClassRatios：三类 perCredit 实测值',
    Math.abs(classes.uncachedInput.perCredit - 1977.11) < 0.01
      && Math.abs(classes.cacheRead.perCredit - 54820.92) < 0.01
      && Math.abs(classes.output.perCredit - 274.46) < 0.01)
  check('015 creditsClassRatios：三类 tokens 之和等于官方 tokens',
    classes.uncachedInput.tokens + classes.cacheRead.tokens + classes.output.tokens,
    OFFICIAL_TOTALS.tokens)
  ok('015 creditsClassRatios：perCredit 保留原始浮点（不取整）',
    classes.cacheRead.perCredit % 1 !== 0 && classes.output.perCredit % 1 !== 0)

  const clamped = creditsClassRatios({ input: 100, cacheRead: 300, output: 10 }, 10)
  check('015 creditsClassRatios：cacheRead > input 时未命中夹到 0',
    [clamped.uncachedInput.tokens, clamped.uncachedInput.perCredit,
      clamped.cacheRead.tokens, clamped.cacheRead.perCredit,
      clamped.output.tokens, clamped.output.perCredit],
    [0, 0, 300, 30, 10, 1])

  const missing = creditsClassRatios({ input: 1000 }, 10)
  check('015 creditsClassRatios：缺 cacheRead / output 按 0',
    [missing.uncachedInput.tokens, missing.cacheRead.tokens, missing.output.tokens,
      missing.uncachedInput.perCredit, missing.cacheRead.perCredit, missing.output.perCredit],
    [1000, 0, 0, 100, 0, 0])

  const noTotals = creditsClassRatios(undefined, 10)
  check('015 creditsClassRatios：官方 totals 缺失 → 全 0',
    [noTotals.uncachedInput.tokens, noTotals.cacheRead.tokens, noTotals.output.tokens], [0, 0, 0])

  check('015 creditsClassRatios：used<=0 / 非有限 → null',
    [creditsClassRatios(OFFICIAL_TOTALS, 0), creditsClassRatios(OFFICIAL_TOTALS, -1),
      creditsClassRatios(OFFICIAL_TOTALS, undefined), creditsClassRatios(OFFICIAL_TOTALS, NaN)],
    [null, null, null, null])

  // 模型行：分子本机、分母账号级 → 只保留 tokens>0，保持入参降序，不重排。
  const localModels = [
    { id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max', totals: { input: 600, cacheRead: 300, output: 200, cacheWrite: 100, tokens: 1200, calls: 4 } },
    { id: 'deepseek/deepseek-v4.1', provider: 'deepseek', model: 'deepseek-v4.1', totals: { tokens: 300, calls: 2 } },
    { id: 'zero/model', provider: 'zero', model: 'model', totals: { tokens: 0, calls: 9 } },
    { id: 'bad/model', provider: 'bad', model: 'model', totals: { tokens: NaN, calls: 1 } },
    { id: 'no/totals', provider: 'no', model: 'totals' },
  ]
  const modelRatios = creditsModelRatios(localModels, 100)
  check('015 creditsModelRatios：只收 tokens>0 且保持降序',
    modelRatios.map(item => item.id), ['qwen/qwen3-max', 'deepseek/deepseek-v4.1'])
  check('015 creditsModelRatios：行字段完整（016 起含 classes）', modelRatios[0],
    {
      id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max', tokens: 1200, calls: 4, tokensPerCredit: 12,
      classes: {
        input: { tokens: 600, perCredit: 6 },
        cacheRead: { tokens: 300, perCredit: 3 },
        output: { tokens: 200, perCredit: 2 },
        cacheWrite: { tokens: 100, perCredit: 1 },
      },
    })
  check('015 creditsModelRatios：tokensPerCredit = tokens / used',
    [modelRatios[1].tokens, modelRatios[1].calls, modelRatios[1].tokensPerCredit], [300, 2, 3])
  check('015 creditsModelRatios：非数组 / 空数组 → []',
    [creditsModelRatios(null, 100), creditsModelRatios({}, 100), creditsModelRatios([], 100)], [[], [], []])
  check('015 creditsModelRatios：used<=0 → []',
    [creditsModelRatios(localModels, 0), creditsModelRatios(localModels, -1), creditsModelRatios(localModels, undefined)],
    [[], [], []])
  check('015 creditsModelRatios：全 0 tokens → []',
    creditsModelRatios([{ id: 'zero/model', provider: 'zero', model: 'model', totals: { tokens: 0, calls: 1 } }], 100), [])

  // 组合：官方分项照给；模型行只在有本机读数时出现，缺了就 []（不是 null）。
  const localFull = {
    totals: { tokens: 2080883520 },
    models: [
      { id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max', totals: { input: 500000, cacheRead: 300000, output: 150000, cacheWrite: 50000, tokens: 1000000, calls: 3 } },
      { id: 'deepseek/deepseek-v4.1', provider: 'deepseek', model: 'deepseek-v4.1', totals: { tokens: 500000, calls: 2 } },
    ],
  }
  const composed = composeCreditsToken({ card: CARD, official: officialFull, localTotals: localFull, now: NOW })
  check('015 compose：ratio.classes 三类 tokens',
    [composed.ratio.classes.uncachedInput.tokens, composed.ratio.classes.cacheRead.tokens,
      composed.ratio.classes.output.tokens],
    [73542478, 2039167232, 10209160])
  ok('015 compose：ratio.classes 三类 perCredit 与纯函数一致',
    Math.abs(composed.ratio.classes.uncachedInput.perCredit - classes.uncachedInput.perCredit) < 1e-9
      && Math.abs(composed.ratio.classes.cacheRead.perCredit - classes.cacheRead.perCredit) < 1e-9
      && Math.abs(composed.ratio.classes.output.perCredit - classes.output.perCredit) < 1e-9)
  check('015 compose：ratio.modelsBasis 固定 local', composed.ratio.modelsBasis, 'local')
  check('015 compose：ratio.models 本机两行且保序',
    composed.ratio.models.map(item => [item.id, item.tokens, item.calls, item.tokensPerCredit]),
    [['qwen/qwen3-max', 1000000, 3, 1000000 / USED], ['deepseek/deepseek-v4.1', 500000, 2, 500000 / USED]])
  check('016 compose：ratio.models 每行带 classes 四键',
    Object.keys(composed.ratio.models[0].classes), ['input', 'cacheRead', 'output', 'cacheWrite'])
  check('016 compose：模型行四类 tokens 相加 === 行 tokens',
    composed.ratio.models[0].classes.input.tokens + composed.ratio.models[0].classes.cacheRead.tokens
      + composed.ratio.models[0].classes.output.tokens + composed.ratio.models[0].classes.cacheWrite.tokens,
    composed.ratio.models[0].tokens)
  ok('015 compose：014 的 ratio 旧字段不回归',
    Math.abs(composed.ratio.tokensPerCredit - 57072) < 1
      && composed.ratio.capacityTokens === Math.round(composed.ratio.tokensPerCredit * 80000))
  check('015 compose：014 的 tokens.local 仍为本机总量',
    [composed.tokens.official, composed.tokens.local], [OFFICIAL_TOTALS.tokens, 2080883520])

  const noLocal = composeCreditsToken({ card: CARD, official: officialFull, localTotals: null, now: NOW })
  check('015 compose：本机读数缺失 → models: []', noLocal.ratio.models, [])
  check('015 compose：本机读数缺失不影响 classes',
    [noLocal.ratio.classes.uncachedInput.tokens, noLocal.ratio.classes.cacheRead.tokens, noLocal.ratio.classes.output.tokens],
    [73542478, 2039167232, 10209160])
  check('015 compose：本机读数缺失仍 tokens.local=null', noLocal.tokens.local, null)

  const emptyLocal = composeCreditsToken({
    card: CARD, official: officialFull, localTotals: { totals: { tokens: 0 }, models: [] }, now: NOW,
  })
  check('015 compose：本机模型为空数组 → models: []', emptyLocal.ratio.models, [])

  const unavailable = composeCreditsToken({
    card: CARD,
    official: { error: 'official-unavailable', code: 'official-disabled', hint: '官方明细已关闭' },
    localTotals: localFull,
    now: NOW,
  })
  check('015 compose：不可用分支不新增 ratio 字段', 'ratio' in unavailable, false)

  ok('015 __internals：两个纯函数可直接调',
    typeof creditsClassRatios === 'function' && typeof creditsModelRatios === 'function')
}

// ---------------------------------------------------------------------------
// 016：模型行再拆四类（input/cacheRead/output/cacheWrite）的 tokens 与 perCredit。
// 分子取本机 totals，分母仍是账号级已用 Credits；perCredit 不取整。
// ---------------------------------------------------------------------------
{
  const CLASS_MODELS = [
    {
      id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max',
      totals: { input: 600, cacheRead: 300, output: 200, cacheWrite: 100, tokens: 1200, calls: 4 },
    },
  ]
  const classRow = creditsModelRatios(CLASS_MODELS, 100)[0]
  check('016 creditsModelRatios：classes 四类 tokens / perCredit', classRow.classes, {
    input: { tokens: 600, perCredit: 6 },
    cacheRead: { tokens: 300, perCredit: 3 },
    output: { tokens: 200, perCredit: 2 },
    cacheWrite: { tokens: 100, perCredit: 1 },
  })
  check('016 creditsModelRatios：四类 tokens 相加 === 行 tokens',
    classRow.classes.input.tokens + classRow.classes.cacheRead.tokens
      + classRow.classes.output.tokens + classRow.classes.cacheWrite.tokens,
    classRow.tokens)
  ok('016 creditsModelRatios：四类 perCredit 相加 === 行 tokensPerCredit',
    Math.abs(classRow.classes.input.perCredit + classRow.classes.cacheRead.perCredit
      + classRow.classes.output.perCredit + classRow.classes.cacheWrite.perCredit
      - classRow.tokensPerCredit) < 1e-12)
  ok('016 creditsModelRatios：perCredit 不取整', classRow.classes.cacheRead.perCredit === 3
    && classRow.tokensPerCredit === 12)

  // 缺字段 / 非有限 / 负数：全部按 0，四类仍是完整对象，不产出 NaN/Infinity。
  const clamped = creditsModelRatios([{
    id: 'mix/model', provider: 'mix', model: 'model',
    totals: { input: 50, cacheRead: NaN, output: -5, cacheWrite: undefined, tokens: 50, calls: '3' },
  }], 10)[0]
  check('016 creditsModelRatios：缺字段 / 非有限 / 负数按 0',
    [clamped.classes.input.tokens, clamped.classes.cacheRead.tokens,
      clamped.classes.output.tokens, clamped.classes.cacheWrite.tokens,
      clamped.classes.input.perCredit, clamped.classes.cacheRead.perCredit,
      clamped.classes.output.perCredit, clamped.classes.cacheWrite.perCredit,
      clamped.calls],
    [50, 0, 0, 0, 5, 0, 0, 0, 3])
  check('016 creditsModelRatios：四类 tokens 相加 === 行 tokens（夹 0 后）',
    clamped.classes.input.tokens + clamped.classes.cacheRead.tokens
      + clamped.classes.output.tokens + clamped.classes.cacheWrite.tokens,
    clamped.tokens)

  const onlyTokens = creditsModelRatios([{
    id: 'only/tokens', provider: 'only', model: 'tokens', totals: { tokens: 100 },
  }], 10)[0]
  check('016 creditsModelRatios：四类全缺也是四键 0 对象', onlyTokens.classes, {
    input: { tokens: 0, perCredit: 0 },
    cacheRead: { tokens: 0, perCredit: 0 },
    output: { tokens: 0, perCredit: 0 },
    cacheWrite: { tokens: 0, perCredit: 0 },
  })
  check('016 creditsModelRatios：tokens=0 的行即使 classes 非零也被过滤',
    creditsModelRatios([{
      id: 'zero/model', provider: 'zero', model: 'model',
      totals: { input: 999, cacheRead: 999, output: 999, cacheWrite: 999, tokens: 0 },
    }], 10), [])
  check('016 creditsModelRatios：used<=0 仍返回 []',
    [creditsModelRatios(CLASS_MODELS, 0), creditsModelRatios(CLASS_MODELS, -1)],
    [[], []])

  // 真实 /usage 数据（2026-11-01..14，used=38280.2997）的 qwen3.8-flash 行：
  // 三类 perCredit 约 1341.40 / 33302.19 / 132.79，cacheWrite 为 0。
  const REAL_USED = 38280.2997
  const REAL_ROW = {
    id: 'qwen-token-plan-cn/qwen3.8-flash',
    provider: 'qwen-token-plan-cn',
    model: 'qwen3.8-flash',
    totals: {
      input: 51349194,
      cacheRead: 1274817814,
      output: 5083241,
      cacheWrite: 0,
      tokens: 1331250249,
      calls: 0,
    },
  }
  const realRow = creditsModelRatios([REAL_ROW], REAL_USED)[0]
  ok('016 实际数据：qwen3.8-flash 三类 perCredit 约 1341.40 / 33302.19 / 132.79',
    Math.abs(realRow.classes.input.perCredit - 1341.40) < 0.01
      && Math.abs(realRow.classes.cacheRead.perCredit - 33302.19) < 0.01
      && Math.abs(realRow.classes.output.perCredit - 132.79) < 0.01)
  check('016 实际数据：四类 tokens 相加 === 行 tokens', realRow.classes.input.tokens
    + realRow.classes.cacheRead.tokens + realRow.classes.output.tokens + realRow.classes.cacheWrite.tokens,
    realRow.tokens)
  ok('016 实际数据：行 tokensPerCredit 约 34776.37 / 34776.38（两位小数舍入差）',
    Math.abs(realRow.tokensPerCredit - 34776.37) < 0.02)
  ok('016 实际数据：四类 perCredit 相加 === 行 tokensPerCredit',
    Math.abs(realRow.classes.input.perCredit + realRow.classes.cacheRead.perCredit
      + realRow.classes.output.perCredit + realRow.classes.cacheWrite.perCredit
      - realRow.tokensPerCredit) < 1e-9)
  check('016 实际数据：cacheWrite 为 0 但仍是完整对象', realRow.classes.cacheWrite,
    { tokens: 0, perCredit: 0 })
  ok('016 实际数据：perCredit 保留原始浮点（不取整）',
    realRow.classes.input.perCredit % 1 !== 0
      && realRow.classes.cacheRead.perCredit % 1 !== 0
      && realRow.classes.output.perCredit % 1 !== 0)
}

// 收尾，不留垃圾；Windows 上账本落盘可能还在收尾，给它几次重试。
setDshHome(ORIG_DSH_HOME)
rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

console.log(`\n${passed} passed, ${failed} failed`)
// 不用 process.exit：全局 undici 的回环保活 socket 与 exit 撞车会触发 libuv 断言。
process.exitCode = failed === 0 ? 0 : 1
