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
    label: lang === 'en' ? `${provider} (measured)` : `${provider}（实测）`,
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
    label: lang === 'en' ? `${provider} (measured)` : `${provider}（实测）`,
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
  const text = JSON.stringify(snapshot)
  // 真实痕迹：本机账号、真实余额，以及用户实拍图里出现过的真实额度值 ——
  // 那三张图是真实账号，任何"照着抄一组数"的改动都必须被这里拦住。
  for (const banned of ['OMEN', '39.91', '9063', '7943', '2026-09-14', 'C:\\', 'D:\\', '/Users/', '.scratch']) {
    need(`不含真实痕迹 ${JSON.stringify(banned)}`, !text.includes(banned))
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
