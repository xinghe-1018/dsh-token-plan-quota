/**
 * 浏览器半边的离线冒烟测试（不联网、无真 DOM）。
 * 运行：node test/client.mjs
 *
 * 手写 bundle 没有构建期校验，这里用假 React / 假 slots / 假 fetch 跑通：
 * 座位注册、样式只注入一次、组件树可渲染、徽标文案、取数失败不炸。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
  }
}
function ok(label, condition, context) {
  if (condition) passed += 1
  else {
    failed += 1
    // 失败时把现场片段打出来：「X 没出现在输出里」这种断言不给上下文根本查不动（这次就是）。
    console.log(`FAIL ${label}${context === undefined ? '' : `\n  现场 ${String(context).replace(/\\s+/g, ' ').slice(0, 900)}`}`)
  }
}
/** 012：屏幕文本里的百分比只允许是「单项百分比片段」（构成比 x% / 命中率 x% / 模型行 (x%) / <0.1%）。
 *  拼在句子里的百分比（「使用率 80%」这类）或来路不明的 % 都算越界——这是旧「整屏无 %」断言的替代纪律：
 *  百分比只能来自两项实测比值，且只以白名单段拼出的片段出现。 */
function strayPercentFragments(text) {
  return String(text).split(/\s+/).filter((fragment) => fragment.includes('%')
    && !/^(?:\(\d+(?:\.\d+)?%\)|\d+(?:\.\d+)?%|<0\.1%)$/.test(fragment))
}

/* ------------------------------------------------------ 假 React */

/**
 * 函数组件在 createElement 时就实例化：不展开的话 <Chip> 之类的子树永远不会
 * 进入渲染树，断言也就看不到任何文案。hooks 用「槽位数组 + 每次渲染归零游标」
 * 模拟，状态跨渲染保留，所以点 chip 改 setOpen 后下一帧就能看到明细面板。
 */
let hookSlots = []
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    if (typeof type === 'function') return type(props ?? {})
    return { type, props: props ?? {}, children: children.flat(6) }
  },
  useState(initial) {
    const index = hookIndex++
    if (hookSlots[index] === undefined) hookSlots[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = hookSlots[index]
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next
    }]
  },
  useEffect(effect) {
    effect()
  },
  useRef(initial) {
    const index = hookIndex++
    if (hookSlots[index] === undefined) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

/** 新用例：清空状态。 */
function resetHooks() {
  hookSlots = []
  hookIndex = 0
}

/** 一次新的渲染遍历：状态保留，游标归零。 */
function beginRender() {
  hookIndex = 0
}

/* ------------------------------------------------------ 假 DOM */

function makeDom() {
  const styles = []
  const listeners = new Map()
  const document = {
    hidden: false,
    documentElement: { lang: 'zh-CN' },
    body: { tag: 'body' },
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    createElement(tag) {
      return { tag, textContent: '', dataset: {}, remove() {} }
    },
    querySelector(selector) {
      return styles.find(node => node.dataset.pluginCss !== undefined && selector.includes(node.dataset.pluginCss)) ?? null
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener() {},
  }
  return { document, styles, listeners }
}

/* ------------------------------------------------------ 假 fetch */

const SNAPSHOT = {
  generatedAt: Date.now(),
  refreshMinutes: 10,
  pollSeconds: 30,
  endpoint: 'api.deepseek.com',
  credentials: { configured: false, accessKeyId: null, from: null, missing: [] },
  config: { file: 'C:\\\\.dsh\\token-plan-quota.json', fileExists: false, fileError: null, debug: false, showInstanceWindow: true, panelScope: 'current', sources: [{ id: 'deepseek-balance', label: 'DeepSeek 余额', type: 'http', sourceNote: 'DeepSeek 官方 API（Bearer Key）· /user/balance' }] },
  stats: { calls: 1, errors: 0, lastAttemptAt: null },
  throughput: {
    windowSeconds: 60,
    observedSeconds: 300,
    tpm60: 23400,
    out60: 2340,
    outTps60: 39,
    calls60: 3,
    cacheRead60: 18000,
    tokens300: 1200000,
    calls300: 12,
    activeSeconds: 42,
    genTps: 28571,
    byProvider: [
      { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', tpm60: 23400, out60: 2340, outTps60: 39, calls60: 3, tokens300: 1200000, calls300: 12, activeSeconds: 42, genTps: 28571, lastAt: Date.now() - 5000, lastTps: 42, lastTpsAt: Date.now() - 5000 },
      { provider: 'deepseek', model: 'deepseek-chat', tpm60: 0, out60: 0, outTps60: 0, calls60: 0, tokens300: 50000, calls300: 2, activeSeconds: 5, genTps: 10000, lastAt: Date.now() - 400_000, lastTps: 10000, lastTpsAt: Date.now() - 400_000 },
    ],
  },
  notices: [],
  cards: [
    {
      id: 'instance-usage',
      label: '本实例实测用量',
      labelEn: 'This instance (measured)',
      metric: 'count',
      unit: 'tokens',
      monthKey: '2026-09',
      calls: 4,
      tokens: 1010000,
      items: [{ name: 'qwen3.8-flash', tokens: 1010000, calls: 4 }],
      window: { tpm60: 101000, calls60: 1, cacheRead60: 95000, tpm300: 101000, calls300: 1, windowSeconds: 60, observedSeconds: 300 },
      retry: [{
        provider: 'qwen-token-plan-cn',
        attempts: 3,
        lastAt: Date.now() - 60_000,
        lastDelayMs: 60000,
        lastRetry: 3,
        maxRetries: 10,
        lastCode: 'QUOTA',
        abandoned: 0,
        fixedDelayMs: 60000,
        quotaRetryable: true,
        mode: 'normal',
      }],
      veracity: 'local',
      sourceNote: '非官方额度：只统计经过本 DSH 实例的真实调用（精确到 token/次，不折算、不估算）。',
    },
    {
      id: 'deepseek-balance',
      label: 'DeepSeek 余额',
      labelEn: 'DeepSeek balance',
      metric: 'money',
      unit: 'CNY',
      remaining: 45.29,
      total: undefined,
      items: [],
      extra: { granted: 0, toppedUp: 45.29 },
      veracity: 'verified',
      bindProviders: ['deepseek'],
      sourceNote: 'DeepSeek 官方 API（Bearer Key）· /user/balance',
      error: null,
      emptyReason: null,
    },
    {
      id: 'token-plan-window',
      label: 'Token Plan 实测',
      labelEn: 'Token Plan (measured)',
      metric: 'count',
      unit: 'tokens',
      estimated: true,
      veracity: 'local',
      bindProviders: ['qwen-token-plan-cn'],
      windowDays: 7,
      startedAt: Date.now() - 2 * 86_400_000,
      resetAt: Date.now() + 5 * 86_400_000,
      remainingDays: 5,
      tokens: 1_234_567,
      calls: 42,
      items: [{ name: 'qwen3.8-flash', provider: 'qwen-token-plan-cn', tokens: 1_234_567, calls: 42 }],
      sourceNote: '本实例实测：千问 Token Plan 官方无 Key 化额度接口（Credits 余量仅控制台可见）。',
      // 自动检测挂的兜底卡（有官方真值时该收起；用户手写的实测源没有这个标记）
      detected: { by: 'baseURL', rule: 'qwen-token-plan', host: 'token-plan.cn-beijing.maas.aliyuncs.com', fallback: true, credentialRef: null },
      error: null,
    },
    {
      id: 'account-balance',
      label: '阿里云余额',
      metric: 'money',
      unit: 'CNY',
      items: [],
      error: 'account-balance: NoCredentials 未配置 AccessKey',
      errorCode: 'NoCredentials',
      hint: '往 ~/.dsh/.credentials.yaml 加两行',
      veracity: 'verified',
    },
  ],
}

let fetchCalls = []
function makeFetch(mode) {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    // 008 官方账号侧必须排在 /usage 之前：前者是后者的前缀，顺序反了会被本机分支吞掉。
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      const span = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(span) }
    }
    // 整页屏的数据路由（spec 006）：days 从查询串读，快照形状照 INTERFACE §3。
    if (String(url).startsWith('/token-plan-quota/usage')) {
      const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
      return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
    }
    if (mode === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    if (mode === 'garbage') return { ok: true, status: 200, json: async () => null }
    if (mode === 'measured-lies') {
      // 宿主算错/被改坏：实测卡带上了百分比与分母。前端仍不得画条、不得报百分比（「不估算」的最后一道闸）。
      const lying = {
        ...SNAPSHOT.cards.find(card => card.id === 'token-plan-window'),
        metric: 'credits',
        unit: 'Credits',
        total: 10000,
        remaining: 4000,
        usedPercent: 60,
        remainingPercent: 40,
        meters: [{ key: 'weekly', label: '7 天窗口', unit: 'Credits', total: 10000, remaining: 4000, usedPercent: 60, remainingPercent: 40 }],
        detected: { by: 'fallback-window', rule: null, host: null },
      }
      const rest = SNAPSHOT.cards.filter(card => card.id !== 'token-plan-window' && card.veracity !== 'verified')
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: [lying, ...rest] }) }
    }
    if (mode === 'bad-retry') {
      // 宿主侧字段形状变了：`retry` 给成对象而不是数组。for...of 遇到不可迭代值会抛，
      // 抛在渲染里就是整枚徽标被卸载（"胶囊又消失"的一种成因）。
      const broken = SNAPSHOT.cards.map(card => ({ ...card, retry: { provider: 'deepseek', attempts: 2 } }))
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: broken }) }
    }
    if (mode === 'with-console') {
      // 默认快照里没有"官方额度卡"（只有余额卡 + 实测卡），而真实快照有。补一张用来复现
      // "路由解析不出时该挑额度卡、不该被余额卡顶掉"。
      const official = {
        id: 'token-plan-console',
        label: 'Token Plan 余量',
        labelEn: 'Token Plan quota',
        metric: 'credits',
        unit: 'Credits',
        veracity: 'verified',
        bindProviders: ['qwen-token-plan-cn'],
        total: 45000,
        remaining: 41850,
        usedPercent: 7,
        remainingPercent: 93,
        meters: [{ key: 'monthly', label: '本月窗口', labelEn: 'Monthly window', unit: 'Credits', total: 45000, remaining: 41850, usedPercent: 7, remainingPercent: 93, resetAt: Date.now() + 6 * 86_400_000 }],
        items: [],
        error: null,
        sourceNote: '千问AI平台控制台数据网关（Cookie 会话）',
      }
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: [official, ...SNAPSHOT.cards] }) }
    }
    if (mode === 'ratio-only') {
      // 真实形态（2026-09-23 实测：5 次里 1 次）：quota-config 那一路超时，上游只回了
      // per1MonthPercentage。宪法 v2.0.0 之后这张卡照报官方比例，但不画条、不报绝对余量。
      const ratioCard = {
        id: 'token-plan-console',
        label: 'Token Plan 余量',
        labelEn: 'Token Plan quota',
        metric: 'credits',
        unit: 'Credits',
        veracity: 'verified',
        bindProviders: ['qwen-token-plan-cn'],
        usedPercent: 3.3,
        expiresAt: Date.now() + 7 * 86_400_000,
        items: [],
        meters: [{ key: 'monthly', label: '本月窗口', labelEn: 'Monthly window', unit: 'Credits', usedPercent: 3.3, resetAt: Date.now() + 7 * 86_400_000 }],
        extra: { usedPercent: 3.3, denominatorFailed: true, specCode: 'standard', addonTotal: 20000 },
        error: null,
        sourceNote: '千问AI平台控制台数据网关（Cookie 会话）',
      }
      const restRatio = SNAPSHOT.cards.filter(card => card.id !== 'token-plan-window' && card.veracity !== 'verified')
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: [ratioCard, ...restRatio] }) }
    }
    if (mode === 'meter-cap-only') {
      // 档位配了 5 小时上限、这个套餐却没回读数：次级计量没有可说的数，整行都不该出现。
      const capOnly = {
        ...SNAPSHOT.cards.find(card => card.id === 'token-plan-window'),
        id: 'token-plan-console',
        label: 'Token Plan 余量',
        metric: 'credits',
        unit: 'Credits',
        estimated: undefined,
        veracity: 'verified',
        remaining: 1500,
        total: 4000,
        usedPercent: 62.5,
        remainingPercent: 37.5,
        meters: [
          { key: 'weekly', label: '7 天窗口', unit: 'Credits', total: 4000, remaining: 1500, usedPercent: 62.5, remainingPercent: 37.5 },
          { key: 'fiveHour', label: '5 小时窗口', unit: 'Credits', total: 800 },
        ],
        // 控制台接口确实回了 5 小时用量百分比，只是那条窗口没有可展示的余量读数
        // （所以计量行被滤掉）。这时摘要行必须把它补回来——修之前的判定用的是
        // 未过滤的同名局部变量，两边都以为对方会显示，结果谁都没显示。
        extra: { fiveHourTotal: 800, fiveHourUsedPercent: 1.23 },
        items: [],
        error: null,
        sourceNote: '千问AI平台控制台数据网关（Cookie 会话）',
      }
      const rest = SNAPSHOT.cards.filter(card => card.id !== 'token-plan-window' && card.veracity !== 'verified')
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: [capOnly, ...rest] }) }
    }
    if (mode === 'moonshot-usd') {
      // 国际区 Moonshot：端点不回币种字段，unit 由区静态给出——前端必须显 $，不能套 ¥。
      const moonshot = {
        id: 'moonshot-balance',
        label: 'Moonshot 余额',
        metric: 'money',
        unit: 'USD',
        region: 'international',
        remaining: 12.34,
        items: [],
        extra: { toppedUp: 10.34, granted: 2 },
        veracity: 'verified',
        bindProviders: ['moonshot-ai'],
        region: 'international',
        detected: { by: 'baseURL', rule: 'moonshot', host: 'api.moonshot.ai' },
        sourceNote: 'Moonshot 官方 API（Bearer Key）· GET /v1/users/me/balance',
        error: null,
      }
      const rest = SNAPSHOT.cards.filter(card => card.id !== 'token-plan-window' && card.veracity !== 'verified')
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, cards: [moonshot, ...rest] }) }
    }
    const emptyCards = mode === 'empty'
      ? SNAPSHOT.cards.filter(card => card.veracity !== 'verified')
      : SNAPSHOT.cards
    const config = mode === 'scope-all' ? { ...SNAPSHOT.config, panelScope: 'all' } : SNAPSHOT.config
    const throughput = mode === 'idle-tp'
      ? { ...SNAPSHOT.throughput, tpm60: 0, out60: 0, outTps60: 0, calls60: 0, cacheRead60: 0, tokens300: 0, calls300: 0, activeSeconds: 0, genTps: null, byProvider: [] }
      : SNAPSHOT.throughput
    // console-only-err 复用"报错的控制台卡"，只是卡表里不放实测窗口卡。
    const consoleCard = mode === 'console-err' || mode === 'console-only-err'
      ? {
        id: 'token-plan-console',
        label: 'Token Plan 余量',
        metric: 'credits',
        unit: 'Credits',
        veracity: 'verified',
        bindProviders: ['qwen-token-plan-cn'],
        items: [],
        error: 'token-plan-console: NoCredentials 未配置控制台 Cookie',
        errorCode: 'NoCredentials',
        sourceNote: '阿里云百炼控制台网关（Cookie 会话）· tokenplan/personal/api/v2',
      }
      : {
        id: 'token-plan-console',
        label: 'Token Plan 余量',
        metric: 'credits',
        unit: 'Credits',
        veracity: 'verified',
        bindProviders: ['qwen-token-plan-cn'],
        remaining: 6510,
        total: 10000,
        usedPercent: 34.9,
        remainingPercent: 65.1,
        expiresAt: Date.now() + 5 * 86_400_000,
        items: [],
        // 宿主 meters[0] 与顶层 remaining/total 同源；第二条（5 小时窗口）是面板里新增的那行计量。
        meters: [
          { key: 'weekly', label: '7 天窗口', unit: 'Credits', total: 10000, remaining: 6510, usedPercent: 34.9, remainingPercent: 65.1, resetAt: Date.now() + 5 * 86_400_000 },
          { key: 'fiveHour', label: '5 小时窗口', unit: 'Credits', total: 2500, remaining: 2469.3, usedPercent: 1.23, remainingPercent: 98.77, resetAt: Date.now() + 3_000_000 },
        ],
        extra: { fiveHourTotal: 2500, fiveHourUsedPercent: 1.23 },
        error: null,
        sourceNote: '阿里云百炼控制台网关（Cookie 会话）· tokenplan/personal/api/v2',
      }
    // console-only-err：只剩那枚报错的控制台卡 —— 用它钉「报错卡的正面文案」。
    const onlyErrorCard = SNAPSHOT.cards.find(card => card.id === 'instance-usage')
    const cards = mode === 'console-ok' || mode === 'console-err' || mode === 'console-only-err'
      ? (mode === 'console-only-err' ? [onlyErrorCard, consoleCard] : [...emptyCards, consoleCard])
      : emptyCards
    return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, config, throughput, cards, notices: mode === 'empty' ? ['当前没有官方额度源返回数据'] : SNAPSHOT.notices }) }
  }
}

/* ------------------------------------------------------ 装载 bundle */

async function loadBundle(fetchMode, navLanguage = 'zh-CN', fetchImpl = null, options = {}) {
  fetchCalls = []
  hookSlots = []
  hookIndex = 0
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registered = []
  const injected = []
  const effects = []
  const dom = makeDom()
  const declaredSlots = new Set(
    fetchMode === 'no-left' ? ['conversation.input.dock']
      : fetchMode === 'no-dock' ? ['conversation.input.left']
        : ['conversation.input.left', 'conversation.input.dock'])
  // 整页「用量统计」屏（spec 006）：只有用例显式要 main 座位时才把这两格算进宿主。
  if (options.main === true) {
    declaredSlots.add('main')
    declaredSlots.add('sidebar.panellist')
  }

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        this.spec = spec
      },
    },
  }
  // 011：图表浮层的关闭通路里 Esc 与 blur 挂在 window 上（document 的 keydown 是整页屏
  // 「Esc 关闭面板」的既有链路，图表再塞一个会把两样一起关掉）。假 window 本来是裸对象，
  // 这里补最小 addEventListener/removeEventListener 并留登记表，用例才能像浏览器那样
  // 「按一下 Esc → 下一次渲染浮层消失」。
  const windowListeners = new Map()
  globalThis.window.addEventListener = (type, handler) => {
    const list = windowListeners.get(type) ?? []
    list.push(handler)
    windowListeners.set(type, list)
  }
  globalThis.window.removeEventListener = () => {}
  globalThis.document = dom.document
  // fetchImpl：用例要自己控制回包时序（挂住/迟到）时用；bundle 里的 fetch 是这个形参，
  // 所以必须在装载前定好，装载后再改 globalThis.fetch 是不生效的。
  globalThis.fetch = fetchImpl ?? makeFetch(fetchMode)
  // 记下 setInterval 的登记，用例才能钉住「可见期间每 30 秒刷一次」这条约定。
  const intervals = []
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }
  globalThis.clearInterval = () => {}

  // bundle 走 window.__ModuleLoader__.load；navigator 只按形参注入（Node 24 的
  // globalThis.navigator 是只读访问器，不能覆写）。
  const source = code
  const fakeReactDOM = {
    createPortal: (el, container) => ({ ...el, portalTo: container === dom.document.body ? 'body' : 'other' }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    // 011：没有 react-dom 种子词的老宿主 —— 走 createPortal === null 的内联回退分支。
    if (id === 'react-dom') {
      if (options.reactDOM === false) throw new Error('module not found: react-dom')
      return fakeReactDOM
    }
    if (id === '@deepseek-ai/dsh-client-store') {
      // 老宿主没有这个种子词：defineStore 拿不到，整页屏不注册（徽标照常）。
      if (options.clientStore === false) throw new Error('module not found: @deepseek-ai/dsh-client-store')
      return { defineStore: options.defineStore ?? fakeDefineStore }
    }
    throw new Error(`unexpected require(${id})`)
  }
  const factoryRunner = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'require', `${source}; return window.__ModuleLoader__.spec`)
  const spec = factoryRunner(globalThis.window, dom.document, { language: navLanguage }, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, requireStub)

  check('bundle 声明了自己的 id', spec.id, 'dsh-token-plan-quota')
  const api = spec.factory(requireStub)
  return { spec, api, registered, injected, effects, dom, declaredSlots, intervals, windowListeners }
}

/** 极简 SnapshotStore 替身（getSnapshot/subscribe/set 即 notify）。 */
function makeStore(initial) {
  const listeners = new Set()
  return {
    snapshot: initial,
    getSnapshot() { return this.snapshot },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) {
      this.snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** 极简 defineStore 替身：init → draft；actions 先绑 draft；create() 返回同一个实例。 */
function fakeDefineStore(config) {
  const draft = typeof config.init === 'function' ? config.init() : {}
  const instance = {
    state: draft,
    listeners: new Set(),
    getSnapshot() { return this.state },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
  }
  const handle = {}
  for (const [name, action] of Object.entries(config.actions ?? {})) {
    handle[name] = (...args) => {
      action(draft, ...args)
      for (const listener of [...instance.listeners]) listener()
    }
  }
  handle.create = () => instance
  return handle
}

/**
 * 宿主 buildUsageSnapshot() 的假快照（INTERFACE.md §3 的响应形状）。
 * buckets 从旧到新，最后一个桶最高——2D/3D 的等比断言靠它算期望值。
 */
function makeUsageSnapshot(days = 7) {
  const dayMs = 86_400_000
  const end = Date.parse('2026-11-13T00:00:00Z')
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  const buckets = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const start = end - offset * dayMs
    const startDate = new Date(start)
    const month = String(startDate.getUTCMonth() + 1).padStart(2, '0')
    const day = String(startDate.getUTCDate()).padStart(2, '0')
    const tokens = (days - offset) * 1000
    buckets.push({
      from: iso(start),
      to: iso(start + dayMs),
      label: month + '-' + day,
      totals: {
        input: tokens / 2, output: tokens / 4, cacheRead: tokens / 4, cacheWrite: 0,
        calls: days - offset, steps: days - offset, tokens,
      },
      models: {},
    })
  }
  return {
    generatedAt: Date.parse('2026-11-13T00:42:00Z'),
    enabled: true,
    // 闭区间契约（INTERFACE §2 / 宿主实现）：to = 今天，from = to - (days - 1) 天。
    // 旧 fixture 的 to = 明天（右开）会把边界 off-by-one 掩盖掉。
    range: { kind: 'days', days, from: iso(end - (days - 1) * dayMs), to: iso(end) },
    granularity: days > 62 ? 'week' : 'day',
    totals: { input: 600000, output: 300000, cacheRead: 100000, cacheWrite: 0, calls: 30, steps: 30, tokens: 1000000 },
    buckets,
    models: [
      { id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max', totals: { input: 400000, output: 200000, cacheRead: 50000, cacheWrite: 0, calls: 20, steps: 20, tokens: 650000 } },
      { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', totals: { input: 200000, output: 100000, cacheRead: 50000, cacheWrite: 0, calls: 10, steps: 10, tokens: 350000 } },
    ],
    source: { kind: 'session-index', veracity: 'measured', label: '本实例实测' },
    coverage: { sessions: 12, indexed: 12, failed: 0, unknownModel: 0, skippedOld: 0 },
    refreshing: false,
  }
}

/**
 * 官方账号侧假响应（spec 008 / INTERFACE §2.1）。口径必须自洽，否则测出来的「同源」是假的：
 * totals.tokens = input + output，cacheRead 已含在 input 内（不相加）；buckets 每日均摊，
 * 之和等于 totals（三格与拆分同源、任意 days 都能算期望值）。
 * 300,000,000 tokens/天 × 7 天 = 2,100,000,000，与本机 fixture 的 1,000,000 差出正号。
 */
function makeOfficialSnapshot(days = 7) {
  const span = Math.max(1, Math.round(Number(days) || 7))
  const dayMs = 86_400_000
  const end = Date.parse('2026-11-13T00:00:00Z')
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  const perDay = { tokens: 300_000_000, input: 180_000_000, cacheRead: 162_000_000, output: 120_000_000 }
  const buckets = []
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const start = end - offset * dayMs
    buckets.push({ from: iso(start), to: iso(start + dayMs), ...perDay })
  }
  return {
    generatedAt: Date.parse('2026-11-13T00:42:00Z'),
    range: { kind: 'days', days: span, from: iso(end - (span - 1) * dayMs), to: iso(end) },
    granularity: 'day',
    totals: {
      tokens: perDay.tokens * span,
      input: perDay.input * span,
      cacheRead: perDay.cacheRead * span,
      output: perDay.output * span,
    },
    buckets,
    source: { kind: 'official-console', veracity: 'verified', label: '官方账号侧（Token Plan 用量明细）' },
    coverage: { api: 'console-gateway', chunks: 1, step: 'day', cached: false, totalDerived: true },
  }
}

function makeCtx(registered, declaredSlots, styleCount, services) {
  const seats = services?.seats
  const slots = {
    inject(name, callback) {
      if (!declaredSlots.has(name)) return () => {}
      const produced = callback()
      // main 座位注册回调是 generator（INTERFACE §3 照抄宿主的 function* 形状）：
      // 在这里把它跑到完成，并把 generate 的返回值（disposer）交回去。
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        let step = produced.next()
        while (step.done !== true) step = produced.next(step.value)
        return typeof step.value === 'function' ? step.value : () => {}
      }
      return typeof produced === 'function' ? produced : () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
    // 只有用例给了 seats 才假装宿主有 main 整页座位；老用例完全不受影响。
    spec(name) {
      return seats !== undefined && seats.includes(name) ? { name } : undefined
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      return services?.[name]
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') styleCount.push(dispose)
      return dispose
    },
  }
  return ctx
}

/* ============================================ 用例 */

/** 渲染若干轮，让 fetch 的 promise 落地。 */
async function settle(render, rounds = 4) {
  let tree = render()
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
    tree = render()
  }
  return tree
}

{
  const { api, registered, dom } = await loadBundle('ok')
  const disposers = []
  const ctx = makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), disposers)
  const applyResult = api.apply(ctx)
  check('apply 不返回内容（注册型插件）', applyResult, undefined)
  ok('样式注入了一次', dom.styles.filter(node => node.tag === 'style').length === 1)
  ok('样式带上插件标识', dom.styles[0].dataset.plugin === 'dsh-token-plan-quota')
  check('注入三枚 CDN 字体 link（Geist/Geist Mono/Noto Sans SC）',
    dom.styles.filter(node => node.tag === 'link' && node.dataset.plugin === 'dsh-token-plan-quota').map(node => node.href), [
      'https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5/index.css',
      'https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5/index.css',
      'https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans-sc@5/index.css',
    ])
  check('只注册一个座位（首选成功就不重复）', registered.length, 1)
  check('座位名（首选工具行座位：徽标有 312px 硬上限，不会再挤折那一行）', registered[0].options.name, 'conversation.input.left')
  check('座位 id', registered[0].options.id, 'token-plan-quota')
  ok('组件是函数', typeof registered[0].component === 'function')
}

{
  // 老外壳没有工具行座位时，退回通栏的 dock 座位——徽标宁可换个位置也不整个不显示。
  const { api, registered } = await loadBundle('no-dock')
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), []))
  check('只有工具行座位时注册在工具行', registered.map(entry => entry.options.name), ['conversation.input.left'])
}

{
  // 只有 dock（没有工具行座位）时，仍注册在 dock。
  const { api, registered } = await loadBundle('no-left')
  api.apply(makeCtx(registered, new Set(['conversation.input.dock']), []))
  check('只有 dock 座位时注册在 dock', registered.map(entry => entry.options.name), ['conversation.input.dock'])
}

{
  const { api, registered } = await loadBundle('ok')
  const noSlots = { get: () => undefined, effect: (fn) => { fn(); return () => {} } }
  api.apply(noSlots)
  check('没有 slots 服务时静默跳过', registered.length, 0)
}

{
  // 0.1.2 的 client guard 把"fiber 能看见哪些服务"变成了硬声明：没在返回对象上声明
  // inject 时，ctx.get("slots") 只会返回 undefined（直读 ctx.slots 则抛
  // cannot get property "slots" without inject），徽标静默消失且不留日志。
  // 上面的替身一直把服务直接递过来，照不出这个洞——这条断言就是那个回归的锁。
  const { api } = await loadBundle('ok')
  check('client 把 slots / sessions / modelDirectories / layout 声明成 fiber 依赖', api.inject,
    ['slots', 'sessions', 'modelDirectories', 'layout'])
}

{
  // 宿主切换会话时会把输入区整个卸载再重挂，每次重挂都回调一次 inject 工厂。
  // 占位必须随 disposer 释放：早先是个只进不出的布尔闩锁，第二次重挂之后徽标就永久
  // 消失（实机症状：上次启动还能看到，重启后所有历史会话都看不到）。
  const { api, registered } = await loadBundle('ok')
  const callbacks = []
  const slots = {
    inject: (name, callback) => { callbacks.push({ name, callback }); return () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  }
  const ctx = { get: (name) => (name === 'slots' ? slots : undefined), effect: (fn) => { fn(); return () => {} } }
  api.apply(ctx)
  check('三个座位都登记了注入回调（数组顺序即偏好顺序）', callbacks.map(entry => entry.name),
    ['conversation.input.right', 'conversation.input.left', 'conversation.input.dock'])
  const left = callbacks.find(entry => entry.name === 'conversation.input.left')
  const dock = callbacks.find(entry => entry.name === 'conversation.input.dock')
  const disposeFirst = left.callback()
  check('首次渲染注册一次', registered.length, 1)
  left.callback()
  check('占位未释放前重复渲染不重复注册', registered.length, 1)
  disposeFirst()
  const disposeSecond = dock.callback()
  check('卸载后另一座位能接手', registered.length, 2)
  check('接手座位是 dock', registered[1].options.name, 'conversation.input.dock')
  disposeSecond()
  check('再卸载后原座位也能接手', (left.callback(), registered.length), 3)
}

{
  // 断线重连：宿主重建会话目录 store，而 `sessions.list.current` 还是同一个会话 id。
  // 只按 id 变化重挂的写法永远等不到第二次 follow，modelWatch 停在 (null,null)，
  // Badge 就把徽标整个藏空（实机反馈："长时间不看这个页面之后插件会消失"）。
  const { api, registered } = await loadBundle('ok')
  const dirs = [
    makeStore({ current: { provider: 'deepseek', model: 'deepseek-chat' }, routable: true, groups: [], failures: [], status: 'ready', error: null }),
    makeStore({ current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }, routable: true, groups: [], failures: [], status: 'ready', error: null }),
  ]
  let calls = 0
  const sessionsStore = makeStore({ current: 's1' })
  api.apply(makeCtx(registered, new Set(['conversation.input.right']), [], {
    sessions: { list: sessionsStore },
    modelDirectories: {
      directoryFor: () => ({ store: dirs[Math.min(calls, dirs.length - 1)], load: async () => { calls += 1 } }),
    },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  let flat = JSON.stringify(await settle(render, 2))
  ok('重连前：徽标跟着第一份目录 store 出 DeepSeek 卡', flat.includes('DeepSeek 余额'))
  dirs[0].set({ ...dirs[0].snapshot, current: null })
  flat = JSON.stringify(await settle(render, 2))
  // 目录被重建的瞬间 provider 为 null —— 按已定口径**不许藏空**；现在是"只挑一张有数的"，
  // 挑到正在服务请求的那条路由上的实测窗口卡（不再按官方数组顺序撞余额卡）。
  ok('目录被重建的瞬间：徽标不藏空，挂上有数的卡', flat.includes('tpq-chip') && flat.includes('123.5万 tok'))
  sessionsStore.set({ current: 's1' })
  flat = JSON.stringify(await settle(render, 3))
  ok('同一个会话 id 的重新发布也要重挂目录（自愈）', flat.includes('Token Plan 实测'))
}

{
  // 用户选定的位置：徽标跟随当前模型，就该贴在模型选择器左边（input.right 是 .trailing
  // 里排在 model 座位之前的那一格，且是 list 座位，不会挤掉官方控件）。
  const { api, registered } = await loadBundle('ok')
  api.apply(makeCtx(registered, new Set([
    'conversation.input.right', 'conversation.input.left', 'conversation.input.dock',
  ]), []))
  check('三格都在时只挂到模型选择器左边', registered.map(entry => entry.options.name),
    ['conversation.input.right'])
}

{
  // 宿主先渲染通栏行、再渲染工具行：只认"先到先得"会把徽标永久钉在最左边的通栏上
  // （实机症状：位置不对）。更优座位后到时必须接手，并且把旧座位的注册释放掉。
  const { api, registered } = await loadBundle('ok')
  const released = []
  const callbacks = []
  const slots = {
    inject: (name, callback) => { callbacks.push({ name, callback }); return () => {} },
    register: (options, component) => {
      const index = registered.push({ options, component }) - 1
      return () => released.push(index)
    },
  }
  const ctx = { get: (name) => (name === 'slots' ? slots : undefined), effect: (fn) => { fn(); return () => {} } }
  api.apply(ctx)
  const dock = callbacks.find(entry => entry.name === 'conversation.input.dock')
  const left = callbacks.find(entry => entry.name === 'conversation.input.left')
  const releaseDock = dock.callback()
  check('通栏先到时先挂上', registered.map(entry => entry.options.name), ['conversation.input.dock'])
  const releaseLeft = left.callback()
  check('工具行后到时接手', registered.map(entry => entry.options.name),
    ['conversation.input.dock', 'conversation.input.left'])
  check('接手时释放掉通栏的注册', released, [0])
  left.callback()
  check('同一座位仍挂着时重复渲染不重复注册', registered.length, 2)
  releaseLeft()
  check('工具行卸载时释放自己的注册', released, [0, 1])
  dock.callback()
  check('空位之后通栏能接手', registered.length, 3)
  check('接手座位是通栏', registered[2].options.name, 'conversation.input.dock')
  void releaseDock
}

// 组件树渲染（假 fetch 落地后检查徽标与明细）
{
  const { api, registered } = await loadBundle('ok')
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), []))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const tree = await settle(render)
  ok('渲染出徽标容器', tree.type === 'span' && tree.props.className === 'tpq')
  const flat = JSON.stringify(tree)
  ok('官方卡出现在徽标上（真值 ¥45.29）', flat.includes('DeepSeek 余额') && flat.includes('¥45.29'))
  ok('徽标不渲染本实例实测卡（无官方额度冒充）', !flat.includes('本实例实测用量'))
  ok('展开前不渲染明细面板', !flat.includes('额度明细'))

  // 点开徽标 → 明细面板（状态跨渲染保留，所以 setOpen 后下一帧就有面板）
  const chip = findChip(tree)
  ok('找到可点击的徽标', chip !== undefined)
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('明细里显示官方卡充值/赠款拆分', panel.includes('充值') && panel.includes('¥45.29'))
  ok('明细里显示官方接口来源标注（标题 tooltip）', panel.includes('官方接口') && panel.includes('/user/balance'))
  ok('明细里显示本实例实测用量', panel.includes('本实例实测用量'))
  // 1_010_000 在中文界面是 101.0万（中文阶梯不掺 M）；写成三元"或"会让两种单位都算过，
  // 那正是这次要修的毛病，所以钉死成中文那一种。
  ok('明细里显示本实例 token 数（中文缩写用万）', panel.includes('101.0万'))
  ok('明细里显示一行式吞吐摘要', panel.includes('吞吐') && panel.includes('近 5 分'))
  ok('明细里重试观测压缩为每供应商一行', panel.includes('自动重试×3') && panel.includes('固定间隔 60s × 10') && panel.includes('✓QUOTA'))
  ok('明细里不再渲染独立滑动吞吐子块（与顶部一行合并）', !panel.includes('滑动吞吐'))
  ok('明细里显示模型级实测', panel.includes('qwen3.8-flash'))
  ok('错误卡显示上游原因', panel.includes('NoCredentials'))
  ok('明细带配置路径提示', panel.includes('token-plan-quota.json'))
  ok('明细无按钮，只有可点击的更新于时间戳', panel.includes('更新于') && !panel.includes('回源远端') && !panel.includes('清本周期账本') && !panel.includes('tpq-btn'))
  ok('本地实测卡有非官方标注', panel.includes('非官方额度'))
}

function findChip(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (typeof node.props?.onClick === 'function' && String(node.props.className ?? '').includes('tpq-chip')) return node
  for (const child of node.children ?? []) {
    const found = findChip(child)
    if (found !== undefined) return found
  }
  return undefined
}

// 空快照与失败快照
{
  const { api, registered } = await loadBundle('empty')
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), []))
  const component = registered[0].component
  resetHooks()
  const tree = await settle(() => {
    beginRender()
    return component()
  })
  ok('没有官方源时显示「无官方额度接口」而不是空白', JSON.stringify(tree).includes('无官方额度接口'))
}

{
  const { api, registered } = await loadBundle('fail')
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), []))
  const component = registered[0].component
  resetHooks()
  const tree = await settle(() => {
    beginRender()
    return component()
  })
  ok('取数失败不抛异常且徽标仍在', tree.type === 'span' && JSON.stringify(tree).includes('Token Plan'))
}

// 徽标跟随当前模型供应商：单徽标、绑定切换、无绑定隐藏。
{
  const { api, registered } = await loadBundle('ok')
  const sessionsStore = makeStore({ current: 's1' })
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const services = {
    sessions: { list: sessionsStore },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const tree = await settle(render)
  let flat = JSON.stringify(tree)
  ok('模型=deepseek → 徽标只挂 DeepSeek 官方卡', flat.includes('DeepSeek 余额') && !flat.includes('Token Plan 实测'))
  ok('该供应商近 5 分钟无新鲜吞吐 → 徽标不带速度标签', !flat.includes('tpq-speed'))

  dirStore.set({ ...dirStore.snapshot, current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' } })
  flat = JSON.stringify(await settle(render, 2))
  ok('模型=token plan → 徽标切到实测窗口卡', flat.includes('Token Plan 实测') && !flat.includes('DeepSeek 余额'))
  // 1_234_567 在中文界面是 123.5万，不是 1.23M —— 中文阶梯只用 万/亿，
  // 中间插一个 M 会让同一行出现两套量纲（实机反馈"吞吐看不明白"）。
  ok('窗口卡数值带 tok 与实测角标', flat.includes('123.5万 tok') && flat.includes('实测'))
  // 胶囊只露「渐变条 + 余量数字（实测时带那颗 pill 标明口径）」：剩余天数、速度、重试都不再占徽标位，
  // 收进 tooltip 与明细面板。pill 留在脸上是"这张卡不是官方余量"的即时信号，不算"详细内容"。
  ok('胶囊不挂天数/速度/重试标签（详细内容交给面板）',
    !flat.includes('tpq-tag') && !flat.includes('tpq-speed'))
  ok('吞吐速度收进胶囊 tooltip（数字仍在 title 里，只是不占位）', flat.includes('42 tok/s'))
  // 原先这条查的是 `tpq-dot` 与 `⚡`——两个字符串在实现与夹具里都不存在，断言恒真。
  // 改成对所有渲染输出做表情符号扫描：真加了 emoji 就会红。
  ok('徽标不出现表情符号（原断言查的 tpq-dot 实现里根本没有，恒真）', !/\p{Extended_Pictographic}/u.test(flat), flat.slice(0, 200))

  // 点开 → panelScope=current：只列当前供应商的卡 + 本实例实测，DeepSeek 不再常驻。
  const openChip = findChip(await settle(render, 1))
  ok('找到窗口徽标', openChip !== undefined)
  openChip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('面板含当前模型标注', panel.includes('qwen3.8-flash'))
  ok('面板标题带拖拽手柄提示（可拖出悬浮）', panel.includes('拖到任意位置悬浮'))
  ok('面板带右下角缩放手柄', panel.includes('tpq-resize') && panel.includes('拖拽调整面板大小'))
  ok('面板 portal 到 document.body（fixed 视口坐标系成立）', panel.includes('"portalTo":"body"'))
  ok('面板含吞吐一行（生成速度优先 + 60s/5min 汇总）', panel.includes('吞吐') && panel.includes('28.6k tok/s') && panel.includes('近 5 分'))
  // 每个数都带单位，且中文界面不再 万/M 混排（实机反馈："现在的吞吐看不明白了"）。
  ok('吞吐的 token 数带 tok', panel.includes('2.3万 tok') && panel.includes('120.0万 tok'))
  ok('近 5 分的调用数带单位，不写成裸除法', panel.includes('120.0万 tok / 12 次请求'))
  // 聚合值之外不再逐家列速度：头部就是这一实例的总速度，重复一遍既冗余又常出现两家同速。
  ok('吞吐只报聚合值，不列分供应商速度', !panel.includes('qwen-token-plan-cn 28.6k'))
  ok('中文界面不再出现 1.20M 这种混排写法', !panel.includes('1.20M'))
  ok('窗口卡一行摘要含用量与重置倒计时', panel.includes('窗口内已用') && panel.includes('剩5天后重置'), panel)
  ok('实测卡的用量数字带单位（同屏别处都标了 tok，这里不能漏）', panel.includes('窗口内已用 7天 123.5万 tok'))
  ok('panelScope=current：DeepSeek 卡不再出现在面板', !panel.includes('DeepSeek 余额'))
  ok('panelScope=current：面板只列绑定卡，实测用量卡不进面板', panel.includes('Token Plan 实测') && !panel.includes('本实例实测用量'))
  ok('panelScope=current：无隐藏提示灰条', !panel.includes('已隐藏') && !panel.includes('未配置 AK/SK'))
  ok('面板卡带交错渐入序号（--tpq-i）', panel.includes('--tpq-i'))

  dirStore.set({ ...dirStore.snapshot, current: { provider: 'minimax-cn', model: 'MiniMax-M2.5' } })
  flat = JSON.stringify(await settle(render, 2))
  // 匹配不到当前路由就不出徽标，过去是**整个 0×0 隐藏**——用户只会以为插件又坏了
  // （实机反馈："匹配不到就改成全量显示"）。现在退成"只挑一张**有数的**"：
  // 优先正在服务请求的那条路由上的卡，绝不是按数组顺序撞上的报错卡。
  ok('未绑定供应商 → 徽标不消失，且优先挂正在服务请求的路由上那张有数的卡',
    flat.includes('tpq-chip') && flat.includes('123.5万 tok') && flat.includes('Token Plan 实测')
      && !flat.includes('无官方额度数据'))
  // 面板在前一步就点开了，这里不能再点徽标——再点一下就关了。
  const unmatchedPanel = JSON.stringify(await settle(render, 3))
  ok('收敛后一张不剩 → 面板也退回全量', unmatchedPanel.includes('DeepSeek 余额')
    && unmatchedPanel.includes('Token Plan 实测'))
}

// panelScope=all：面板恢复列全部源（含 DeepSeek 官方卡）。
{
  const { api, registered } = await loadBundle('scope-all')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const services = {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const tree = await settle(render)
  const chip = findChip(tree)
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('panelScope=all：面板同时列出官方卡', panel.includes('DeepSeek 余额') && panel.includes('官方接口'))
  ok('panelScope=all：无隐藏提示', !panel.includes('已隐藏'))
}

// 只有 sessions、没有 modelDirectories → 退回 legacy 全量显示，绝不藏徽标。
{
  const { api, registered } = await loadBundle('ok')
  const services = { sessions: { list: makeStore({ current: 's1' }) } }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const flat = JSON.stringify(await settle(() => {
    beginRender()
    return component()
  }))
  ok('缺 modelDirectories 时退回官方卡全量', flat.includes('DeepSeek 余额') && flat.includes('tpq-chip'))
}

// 会话切换也带动模型观察（sessions.list.current 变化 → 重新订阅目录）。
{
  const { api, registered } = await loadBundle('ok')
  const sessionsStore = makeStore({ current: 's1' })
  const dirA = makeStore({ current: { provider: 'deepseek', model: 'deepseek-chat' }, routable: true, groups: [], failures: [], status: 'ready', error: null })
  const dirB = makeStore({ current: { provider: 'qwen-token-plan-cn', model: 'qwen3.7-plus' }, routable: true, groups: [], failures: [], status: 'ready', error: null })
  const services = {
    sessions: { list: sessionsStore },
    modelDirectories: { directoryFor: (id) => ({ store: id === 's1' ? dirA : dirB, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  await settle(render)
  sessionsStore.set({ current: 's2' })
  const flat = JSON.stringify(await settle(render, 2))
  ok('切会话 → 跟随新会话的模型供应商', flat.includes('Token Plan 实测') && !flat.includes('DeepSeek 余额'))
}

// 吞吐行常驻：近 5 分钟无流量也渲染（显示 —，不整行消失）。
{
  const { api, registered } = await loadBundle('idle-tp')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const services = {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const tree = await settle(render)
  findChip(tree).props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('无流量时吞吐行仍在', panel.includes('吞吐') && panel.includes('近 5 分'))
  ok('无流量时不挂速度标签', !panel.includes('tok/s'))
}

// 控制台余量卡有数 → 徽标优先挂它（官方真值 > 实测），进度条按已用百分比。
{
  const { api, registered } = await loadBundle('console-ok')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const services = {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('控制台卡有数 → 徽标挂官方余量（65% + 进度条）', flat.includes('Token Plan 余量') && flat.includes('65%') && flat.includes('tpq-bar'))
  const chip = findChip(await settle(render, 1))
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('面板余量行：剩余 6,510 / 10,000 · 已用 34.9%', panel.includes('6,510') && panel.includes('10,000') && panel.includes('已用 34.9%'))
  ok('5 小时窗口走独立计量行（tpq-meters），不再挤在摘要尾巴上',
    panel.includes('tpq-meters') && panel.includes('5 小时窗口') && panel.includes('2,469') && !panel.includes('5h窗口'))
  {
    // 精确数 class（"tpq-meters" 容器也含 "tpq-meter" 子串，所以按完整 class 值匹配）。
    const meterRows = panel.match(/"className":"tpq-meter"/g) ?? []
    // 一行 = 一个次级窗口；meters[0] 与顶层同源，由标题行＋大条表达，不重复出条。
    ok('只渲染次级窗口（meters[0] 不重复出条）', meterRows.length === 1)
  }
  ok('中英数混排灰列走 UI 栈（tpq-aux），等宽只留给标识串', panel.includes('tpq-aux'))
  ok('控制台卡标「官方接口」来源', panel.includes('官方接口') && panel.includes('tokenplan/personal/api/v2'))
  ok('官方卡有数 → 自动挂的实测兜底卡收起（一家一张额度卡）', !panel.includes('Token Plan 实测'))
}

// 只有上限、没有读数的次级窗口整行不出现（档位配置 ≠ 这个账号的额度）。
{
  const { api, registered } = await loadBundle('meter-cap-only')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const chip = findChip(await settle(render))
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('没读数的 5 小时窗口不出幽灵行', !panel.includes('5 小时窗口') && !panel.includes('tpq-meter'))
  // 这个窗口被当噪声滤掉后，MeterRows 不渲染它；判定「有没有它」必须用同一份**过滤后**的表，
  // 否则两头都不出，5 小时用量这一路信号凭空消失（遮蔽同名 const 的那版就是这个症状）。
  ok('被滤掉的 5 小时窗口由摘要行补回（不再两头都不出）', panel.includes('5h窗口 已用 1.23%'), panel)
  ok('主窗口照常显示（1,500 / 4,000 与已用%）', panel.includes('1,500') && panel.includes('62.5%'))
}

// 国际区 Moonshot：端点不回币种，unit 由区静态给 → 前端必须显 $，不能一律套 ¥。
{
  const { api, registered } = await loadBundle('moonshot-usd')
  const dirStore = makeStore({
    current: { provider: 'moonshot-ai', model: 'kimi-k2' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('徽标按 USD 显 $（而不是 ¥12.34）', flat.includes('$12.34') && !flat.includes('¥12.34'))
  const chip = findChip(await settle(render, 1))
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('明细里充值/赠款沿用已有标签键', panel.includes('充值 $10.34') && panel.includes('赠款 $2.00'))
  ok('Moonshot 卡挂「官方」药丸', panel.includes('tpq-pill') && panel.includes('官方'))
  ok('tooltip 交代识别依据（按哪个 host 认出来的）', panel.includes('按 api.moonshot.ai 自动识别'))
  ok('tooltip 带上当前区（两区 Key 不互通，不写区就是让人猜）', panel.includes('区 international'))
}

// 明细面板是常驻小窗：乱点哪儿都不关，只有再点徽标（toggle）或 Esc 才关。
{
  const { api, registered, dom } = await loadBundle('ok')
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const chip = findChip(await settle(render))
  chip.props.onClick()
  ok('点开后明细在', JSON.stringify(await settle(render, 3)).includes('额度明细'))
  // 面板打开时压根不该注册 mousedown 监听——「点外面就关」这个行为整个被取消，
  // 而不是靠一张选择器名单去豁免（宿主线上产物里连 data-composer-card 都没有）。
  check('不注册 mousedown 监听', (dom.listeners.get('mousedown') ?? []).length, 0)
  const clickEverywhere = () => {
    for (const list of [dom.listeners.get('mousedown') ?? [], dom.listeners.get('click') ?? [], dom.listeners.get('pointerdown') ?? []]) {
      for (const handler of list) handler({ target: { closest: () => null, contains: () => false } })
    }
    return JSON.stringify(render())
  }
  ok('在别处乱点也不关（常驻小窗）', clickEverywhere().includes('额度明细'))
  ok('继续乱点还是不关', clickEverywhere().includes('额度明细'))
  const esc = () => {
    for (const handler of dom.listeners.get('keydown') ?? []) handler({ key: 'Escape' })
    return JSON.stringify(render())
  }
  ok('Esc 关掉', !esc().includes('额度明细'))
  ok('关掉后再点徽标能重新打开', (() => {
    findChip(render()).props.onClick()
    return JSON.stringify(render()).includes('额度明细')
  })())
  ok('再点一次徽标关掉（toggle 是主关闭路径）', (() => {
    findChip(render()).props.onClick()
    return !JSON.stringify(render()).includes('额度明细')
  })())

  // 标题栏那颗 ✕：常驻小窗的第三条关闭路径，也是唯一"看得见"的一条——
  // 「再点徽标」和 Esc 都得先知道有这个习惯。
  const findClass = (node, cls) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    if (String(node.props?.className ?? '').includes(cls)) return node
    for (const child of node.children ?? []) {
      const found = findClass(child, cls)
      if (found !== undefined) return found
    }
    return undefined
  }
  findChip(render()).props.onClick()
  const opened = await settle(render, 2)
  const closeBtn = findClass(opened, 'tpq-close')
  ok('面板标题栏有关闭按钮', closeBtn !== undefined)
  ok('关闭按钮带可读标签（不只画个叉）', closeBtn?.props['aria-label'] === '关闭' && String(closeBtn?.props.title).includes('Esc'))
  ok('关闭按钮自己挡 pointerdown（否则被标题栏拖拽吃掉）', typeof closeBtn?.props.onPointerDown === 'function')
  ok('✕ 没取代拖拽把手（标题栏仍是拖拽区）',
    String(findClass(opened, 'tpq-title')?.props?.title ?? '').includes('拖到任意位置悬浮'))
  closeBtn.props.onClick()
  ok('点 ✕ 关掉面板', !JSON.stringify(render()).includes('额度明细'))
}

// 实测卡即使被宿主错喂了分母与百分比，也绝不画余量条、绝不报百分比（「不估算」的最后一道闸）。
{
  const { api, registered } = await loadBundle('measured-lies')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('无官方源但有实测源 → 徽标照常出现（不再整枚消失）', flat.includes('Token Plan 实测'))
  ok('实测徽标不画余量条', !flat.includes('tpq-bar'))
  const chip = findChip(await settle(render, 1))
  chip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('实测卡进面板', panel.includes('Token Plan 实测'))
  ok('实测卡不出条、不出百分比', !panel.includes('tpq-bar-lg') && !panel.includes('40%') && !panel.includes('60%'))
  ok('实测卡仍挂「实测」药丸与口径 tooltip', panel.includes('tpq-pill') && panel.includes('官方无 Key 化额度接口'))
  ok('兜底源在 tooltip 里自报家门（不是"认出来了"，是"没认出来才挂实测"）',
    panel.includes('没匹配到官方额度接口，按本实例实测显示'))
}

// 控制台卡只有错误（Cookie 没配）→ 徽标退回有数的实测窗口卡，不挂错误卡。
{
  const { api, registered } = await loadBundle('console-err')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const services = {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], services))
  const component = registered[0].component
  resetHooks()
  const flat = JSON.stringify(await settle(() => {
    beginRender()
    return component()
  }))
  ok('Cookie 未配 → 徽标退回实测卡而非错误卡', flat.includes('Token Plan 实测') && !flat.includes('Token Plan 余量'))
  // 兜底收合看的是「有没有数」，不是「源有没有开」：官方卡成了错误卡时实测卡必须在，
  // 否则 Cookie 一过期徽标直接变空白（这条就是那次实机回归的锁）。
  const render = () => {
    beginRender()
    return component()
  }
  findChip(await settle(render, 1)).props.onClick()
  ok('官方卡没数 → 实测兜底卡回到面板', JSON.stringify(await settle(render, 3)).includes('Token Plan 实测'))
}

/* 2026-10-06 实机回归（本条由线上现场反推）：
 *  (1) DSH 0.2 起 `sessions.list` 是 `{ ids, byId, phase }`，**没有 `current`** ——
 *      客户端老写法读 `.current`，于是 provider 恒为 null，徽标永远走降级挑选；
 *  (2) 降级挑选又把"有数字"和"报错"混在同一档且只看官方卡，于是报错的控制台卡
 *      按数组顺序先命中，正面只剩「无官方额度数据」，而同一时刻实测窗口有 3400 万 tokens。
 *  两条一起修，两条一起锁。 */
{
  // ① 新外壳形状（byId + retainedBy.mainView）必须能认出现行会话 → 徽标才跟随模型。
  const { api, registered } = await loadBundle('ok')
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  const mainViewList = (id) => makeStore({ ids: [id], byId: { [id]: { id, retainedBy: { mainView: 1 } } }, phase: 'ready' })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: mainViewList('s1') },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  // provider=deepseek 时挂的是 DeepSeek 官方卡（¥45.29）；未修时只会挂降级挑出的窗口卡。
  ok('新外壳（byId + retainedBy.mainView）能认出现行会话 → 徽标跟随模型',
    flat.includes('¥45.29') && !flat.includes('123.5万 tok'), flat.slice(0, 400))

  // 反向对照：同一份目录，列表里既没有 current 也没有 mainView → 认不出会话 → 退回降级挑选。
  const second = await loadBundle('ok')
  second.api.apply(makeCtx(second.registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ ids: [], byId: {}, phase: 'ready' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  resetHooks()
  const component2 = second.registered[0].component
  const flat2 = JSON.stringify(await settle(() => {
    beginRender()
    return component2()
  }))
  ok('认不出会话也不崩：退回降级挑选，挑到有数的卡', flat2.includes('123.5万 tok'))
}

{
  // ② 实机症状原样复现：控制台卡报错 + 会话解析不出来（provider=null）+ 实测窗口卡
  //    正挂在"正在服务请求的那条路由"上 → 徽标必须是那枚有数的实测卡。
  const { api, registered } = await loadBundle('console-err')
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ ids: [], byId: {}, phase: 'ready' }) },
    modelDirectories: {
      directoryFor: () => ({
        store: makeStore({ current: null, routable: null, groups: [], failures: [], status: 'loading', error: null }),
        load: async () => {},
      }),
    },
  }))
  const component = registered[0].component
  resetHooks()
  const flat = JSON.stringify(await settle(() => {
    beginRender()
    return component()
  }))
  ok('路由解析不出 + 官方卡报错 → 徽标挂有数的实测卡，不再是「无官方额度数据」',
    flat.includes('123.5万 tok') && flat.includes('实测') && !flat.includes('无官方额度数据'), flat.slice(0, 400))
}

{
  // ③ 只剩报错卡（没有任何可显示的卡）：正面文案必须是「失败」，不是「无官方额度数据」；
  //    错误码与修复提示仍留在 tooltip。
  const { api, registered } = await loadBundle('console-only-err')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('只有报错卡时正面说「查询失败」而不是「无官方额度数据」',
    flat.includes('查询失败') && !flat.includes('无官方额度数据'), flat.slice(0, 400))
  const chip = findChip(await settle(render, 1))
  check('报错卡徽标标成 bad（红）', chip?.props?.['data-sev'], 'bad')
  ok('错误码与修复提示仍在 tooltip 里', String(chip?.props?.title ?? '').includes('NoCredentials'))
}

/* 拖拽/缩放态 CSS 禁碰 animation-name：none↔tpq-rise 的开关会被浏览器当成新动画重播
 * （「松手后重播渐入」事故的回归锁）。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const state of ['dragging', 'resizing']) {
    const rule = new RegExp(`\\.tpq-panel\\[data-${state}\\]\\{[^}]*\\}`).exec(code)
    ok(`手势态 data-${state} 规则存在且不含 animation 开关`, rule !== null && !rule[0].includes('animation'))
  }
}

// token 的紧凑单位跟着界面语言走：写死「万/亿」时英文界面会印出 `84.7万 tok`。
{
  const { api, registered } = await loadBundle()
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  // pickLocale() 在 apply() 里跑，所以 lang 要在 apply 之前翻。
  globalThis.document.documentElement.lang = 'en-US'
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  findChip(await settle(render, 1)).props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('英文界面确实是英文（面板标题）', panel.includes('Quota detail'))
  // 客户端必须真的消费 labelEn —— README 的 `label`/`labelEn` 那一行现在就是这么承诺的，
  // 而它过去写着"当前界面不消费它"（英文界面因此整屏中文标签）。
  ok('英文界面读卡片的 labelEn', panel.includes('DeepSeek balance') && !panel.includes('DeepSeek 余额'))
  // 23400 这个数在两种单位下分别是 2.3万 / 23K —— 断言这一对，别去查"整屏有没有汉字"
  // （测试 payload 的 sourceNote 本来就是中文，那样会误判）。
  ok('英文界面：23400 → 23K', panel.includes('23K') && !panel.includes('2.3万'))
  globalThis.document.documentElement.lang = 'zh-CN'
  const zh = await loadBundle()
  zh.api.apply(makeCtx(zh.registered, new Set(['conversation.input.left']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  resetHooks()
  const zhRender = () => {
    beginRender()
    return zh.registered[0].component()
  }
  findChip(await settle(zhRender, 1)).props.onClick()
  const zhPanel = JSON.stringify(await settle(zhRender, 3))
  ok('中文界面维持原样：23400 → 2.3万（不是 23K）', zhPanel.includes('2.3万') && !zhPanel.includes('23K'))
}

// 语言在每次渲染时重取，不在 apply 时定一次：宿主的 locale 插件是异步写 <html lang> 的
// （packages/client/locale/src/client/index.ts:149），动态插件的 apply 可能跑在它之前。
// 那一刻 <html lang> 还是空的，pickLocale 只能退回浏览器语言——中文界面里徽标自己变成
// 英文，而且除非重载否则永不纠正（实机反馈："插件变成英文了"）。
{
  const { api, registered } = await loadBundle('ok', 'en-US')
  globalThis.document.documentElement.lang = ''
  api.apply(makeCtx(registered, new Set(['conversation.input.left']), [], {}))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  findChip(await settle(render, 1)).props.onClick()
  const atApply = JSON.stringify(await settle(render, 3))
  ok('apply 时 <html lang> 还没写：先按浏览器语言出英文', atApply.includes('Quota detail'))
  globalThis.document.documentElement.lang = 'zh-CN'
  const afterHostWrites = JSON.stringify(await settle(render, 3))
  ok('宿主写下 zh-CN 后，下一次渲染就是中文', afterHostWrites.includes('额度明细')
    && !afterHostWrites.includes('Quota detail'))
}

/* 徽标宽度硬上限：宿主输入行是 flex-wrap:wrap，**分行按各项的 base size 决定**，
 * 所以"能收缩"救不了它——实测 317px 以内一行、320px 起把模型选择器挤到第二行。
 * 这条是"别把输入行挤换行"的回归锁；要放宽前先量一遍真实阈值。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const rule = /\.tpq-chip\{[^}]*\}/.exec(code)
  ok('.tpq-chip 规则存在', rule !== null)
  const cap = /max-width:\s*min\((\d+)px/.exec(rule?.[0] ?? '')
  ok('徽标有 max-width 硬上限（不是只写 min-width:0 就以为够了）', cap !== null)
  if (cap !== null) ok(`徽标上限 ${cap[1]}px ≤ 实测折行阈值 317px`, Number(cap[1]) <= 317)
  ok('整条链也允许收缩（min-width:0 + overflow:hidden）',
    rule?.[0].includes('min-width:0') === true && rule?.[0].includes('overflow:hidden') === true)
}

/* 标题栏必须永远是一行：模型名折成两行会把标题撑高，右边的 ✕ 就错位、
 * 看着像压在「额度明细」上（实机反馈）。所以 meta 只能省略号收尾，不能换行。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const meta = /\.tpq-title \.tpq-meta\{[^}]*\}/.exec(code)
  ok('标题栏里的模型名有专门的收缩规则（不是共用面板体那条）', meta !== null)
  ok('它走省略号而不是换行', meta?.[0].includes('white-space:nowrap') === true
    && meta?.[0].includes('text-overflow:ellipsis') === true && meta?.[0].includes('min-width:0') === true)
  const close = /\.tpq-close\{[^}]*\}/.exec(code)
  ok('✕ 不给负外边距（负值会把它拽到面板圆角和边框上）',
    close !== null && !/margin:\s*-\d/.test(close[0]) && close[0].includes('flex:none') === true)
  const title = /\.tpq-title>span:first-child\{[^}]*\}/.exec(code)
  ok('「额度明细」自己不会被挤扁或折行', title?.[0].includes('flex:none') === true
    && title?.[0].includes('white-space:nowrap') === true)
}

/* 徽标座位：dock 必须排在工具行（input.left）之前。徽标带渐变条/速度/天数，和模型
 * 选择器挤同一条工具行时，长模型名必然把右侧 trailing 组挤到第二行——换行取决于模型名的
 * 内容宽度，CSS 量不到，所以 312px 上限治不了。会换行的内容按宿主插槽契约放 dock。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const seatsBlock = /const seats = \[[\s\S]*?\]/.exec(code)
  ok('座位表存在', seatsBlock !== null)
  const dockAt = seatsBlock?.[0].indexOf('conversation.input.dock') ?? -1
  const leftAt = seatsBlock?.[0].indexOf('conversation.input.left') ?? -1
  ok('工具行座位排在 dock 之前（首选工具行）', dockAt !== -1 && leftAt !== -1 && leftAt < dockAt)
  // dock 是通栏行，徽标必须夹到输入卡片的居中列，否则孤零零贴在视口最左边（实机反馈"效果太差"）。
  ok('dock 座位用专门的包裹组件（不是把裸徽标直接塞进通栏行）',
    /const DockEntry = \(\) => React\.createElement\("div", \{ className: "tpq-dock" \}/.test(code))
  ok('dock 包裹复刻卡片居中几何（max-width = 卡片宽 + side-clearance 内边距）',
    /\.tpq-dock\{[^}]*--dsh-composer-side-clearance/.test(code)
    && /\.tpq-dock>\.tpq\{[^}]*--dsh-composer-card-max-width/.test(code))
}

/* 锚定态面板朝上展开，标题栏（含 ✕）在面板顶端。徽标离屏幕顶不够高时（短窗口 / hero 居中态）
 * 整块面板顶出视口、把 ✕ 裁掉。把面板体高度夹到徽标上方可用空间：底边不动、顶边往下挪，
 * ✕ 永远落在 8px 视口边距内（等价于「把详细界面向下移动、给 ✕ 留空间」）。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('锚定态按输入卡片上缘的可用空间夹面板体高度',
    /spaceAbove\s*=\s*anchorTop/.test(code) && /bodyStyle\s*=\s*\{\s*maxHeight/.test(code))
  ok('锚点被卸载/未布局时不照抄全 0 的 rect（面板不会跑到左上角）',
    /const detached = root\.current\.isConnected === false/.test(code)
    && /if \(detached\) anchorTop = Math\.round\(vh \* 0\.35\);/.test(code))
  ok('面板底边贴卡片上缘而不是徽标那一行（不再盖住输入框）',
    /if \(cardRect !== null && cardRect\.height > 0\) anchorTop = cardRect\.top;/.test(code)
    && /bottom: `\$\{Math\.max\(MARGIN, vh - anchorTop \+ GAP\)\}px`/.test(code))
  // 审查规范（Open Code Review 的 system 规则）明令禁止嵌套三元，锚点这段最容易写成
  // 三层套娃，所以把它钉在源码上。
  ok('锚点计算不用嵌套三元（审查规范：Ternary Expressions）',
    !/anchorTop\s*=\s*[^\n]*\?[^\n]*\?/.test(code))
  ok('夹取仍保留 52vh/460 上限，只在上方空间不足时再收紧',
    /Math\.min\(vh \* 0\.52, 460, spaceAbove\)/.test(code))
  ok('夹取值真的透传到 .tpq-body（不是算了不用）',
    /className:\s*"tpq-body",\s*style:\s*bodyStyle/.test(code))
}

/* 面板必须 border-box。拖拽/缩放存进 localStorage 的是 getBoundingClientRect 的 border box，
 * 而 style.width/height 默认按 content box 解释 —— 于是每点一次标题栏（pointerdown 就会 detach
 * 并存尺寸）面板永久胖 2px：实机反馈"每次点开明细，窗口就大一点"，实测六次点击 382→394，
 * 加 border-box 后六次纹丝不动。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const panel = /\.tpq-panel\{[^}]*\}/.exec(code)
  ok('.tpq-panel 规则存在', panel !== null)
  ok('.tpq-panel 是 border-box（存 border box 却按 content box 套回＝每点一次大 2px）',
    panel?.[0].includes('box-sizing:border-box') === true)
  // 双击复位是明确要求保留的功能（能修 bug 就不删功能），这里钉住它还在。
  ok('双击标题栏仍会清掉悬浮矩形、回到锚定态',
    /onDoubleClick:\s*resetFloat/.test(code) === true
      && /const resetFloat = \(\) => \{[\s\S]{0,80}saveFloatBox\(null\)[\s\S]{0,80}setFloatBox\(null\)/.test(code) === true)
}

/* 强制刷新（面板底部「更新于」）必须真的回源。老写法「只要有请求在飞就搭车」会让 fresh=1
 * 静默复用那条 fresh=0 的请求——宿主侧这两条都会绕开 cacheMs 回源（见 lib/index.js），
 * 所以症状就是"点了没反应"。并发的第二条也不能把新数字盖回旧数字：按 generatedAt 取胜。 */
{
  const baseAt = Date.now()
  const moneyAt = (value, at) => ({
    ...SNAPSHOT,
    generatedAt: at,
    cards: SNAPSHOT.cards.map(card => card.id === 'deepseek-balance' ? { ...card, remaining: value } : card),
  })
  const stale = moneyAt(11.11, baseAt)
  const fresh = moneyAt(88.88, baseAt + 60_000)
  let hang = false
  const calls = []
  const releases = []
  const gatedFetch = async (url) => {
    const link = String(url)
    calls.push(link)
    if (link.includes('fresh=0') && hang) {
      await new Promise(resolve => { releases.push(resolve) })
      return { ok: true, status: 200, json: async () => stale }
    }
    return { ok: true, status: 200, json: async () => (link.includes('fresh=1') ? fresh : stale) }
  }
  const { api, registered } = await loadBundle('ok', 'zh-CN', gatedFetch)
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const findByClass = (node, name) => {
    if (node === null || typeof node !== 'object') return null
    if (String(node.props?.className ?? '').includes(name)) return node
    for (const kid of node.children ?? []) {
      const hit = findByClass(kid, name)
      if (hit !== null) return hit
    }
    return null
  }
  findChip(await settle(render)).props.onClick()
  await settle(render, 2)
  ok('起始画面是旧余额 ¥11.11', JSON.stringify(render()).includes('¥11.11'))
  // 假 React 的 useEffect 每帧都跑：下一帧就是那条在飞的普通轮询。
  hang = true
  render()
  ok('普通轮询已在飞（fresh=0）', calls.some(link => link.includes('fresh=0')))
  const button = findByClass(render(), 'tpq-updated')
  ok('面板底部有「更新于」按钮', button !== null && typeof button.props.onClick === 'function')
  button.props.onClick()
  await settle(render, 2)
  ok('强制刷新不被在飞的普通轮询吃掉：另发一条 fresh=1', calls.some(link => link.includes('fresh=1')))
  // 假 React 在 createElement 时就把 Chip 展开成 DOM 节点，所以断言看的是渲染出的 data-busy。
  ok('新快照先到、旧请求未回 → 仍在「刷新中」（busy 按计数收，不被先结束那条掐掉）',
    JSON.stringify(render()).includes('"data-busy":"1"'))
  hang = false
  releases.splice(0).forEach(release => release())
  const done = JSON.stringify(await settle(render, 4))
  ok('迟到的旧快照没把新数字盖回去（画面仍是 ¥88.88）', done.includes('¥88.88') && !done.includes('¥11.11'))
  ok('两条请求都落地后 busy 归零', !done.includes('"data-busy":"1"'), done)
}

/* 脏字段不能把整枚徽标带走（宿主侧形状变了是常态，不是异常）。 */
{
  const { api, registered } = await loadBundle('bad-retry')
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const tree = JSON.stringify(await settle(render))
  ok('retry 是非数组时徽标照常出（渲染没被抛错带走）', tree.includes('tpq-chip') && tree.includes('¥45.29'), tree)
  findChip(await settle(render, 1)).props.onClick()
  ok('retry 是非数组时面板照常开', JSON.stringify(await settle(render, 3)).includes('额度明细'))
}

/* 本轮 Open Code Review 修复里，靠行为测覆盖不到（卸载路径、宿主给脏字段）的几项钉在源码上。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('手写 CJS 壳不再用 var（no-var）', !/^\s+var\s+(module|exports)\s*=/m.test(code))
  // 不数调用点：每加一处用途就要改这个魔数，守卫会退化成抄写作业（这次正是它先红）。
  // 认三件事：换算只有一处（remainingPercentOf）、徽标与次级计量都走它、实测卡一律不出条。
  ok('余量百分比只留一份算法（徽标、值文案、明细主卡、次级窗口行共用同一个函数）',
    /function remainingPercentOf\(card\) \{/.test(code)
      && (code.match(/100 - (?:card|meter)\.usedPercent/g) ?? []).length <= 1
      && /const barPct = remainingPercentOf\(card\)/.test(code)
      && /const pct = allowBar \? remainingPercentOf\(meter\) : null/.test(code)
      && !/isMeasured\(card\) \? null :/.test(code))
  ok('手势监听有卸载收口（拖拽中途被卸掉不再漏绑）',
    /const gestureRelease = React\.useRef\(null\)/.test(code)
      && /React\.useEffect\(\(\) => \(\) => \{\s*const release = gestureRelease\.current/.test(code))
  ok('retry 给成非数组不会炸掉整枚徽标',
    /const rows = Array\.isArray\(card\?\.retry\) \? card\.retry : \[\]/.test(code)
      && !/for \(const row of card\.retry \?\? \[\]\)/.test(code))
  ok('没有恒真的死条件（lastRetry 判空只留一次）', !/lastRetry != null && lastRetry !== undefined/.test(code))
  ok('「更新于」走 reload(true)（吃 busy 与 cache），不再绕过缓存直打 /refresh',
    /onClick: \(\) => void reload\(true\)/.test(code) && !/request\(REFRESH/.test(code))
  ok('items 明细行改成早退分支，不再一路嵌套三元猜到底', /const itemText = \(item\) => \{/.test(code))
  // 搭车规则的可读版本：允许「新搭旧」，禁止「旧搭新」，也禁止把 fresh 参数当摆设。
  ok('在飞请求只有更新鲜时才允许搭车（fresh 不再被忽略）',
    /if \(cache\.inflight !== null && \(cache\.inflightFresh \|\| !wanted\)\) return await cache\.inflight;/.test(code))
  ok('并发收口：后开的那条不会被先结束的那条摘掉',
    /if \(cache\.inflight === run\) \{/.test(code))
  ok('CardDetail 里 extraMeters 只有一份（同名遮蔽会让 5h 信号两头都不出）',
    (code.match(/const extraMeters = /g) ?? []).length === 1
      && (code.match(/const hasFiveHourMeter = /g) ?? []).length === 1)
  // 同一个表达式里三家口径两种语言：老版第三行硬写了「次」，英文界面会中英混排。
  ok('items 明细行的「次」走 copy.calls，不再硬编码', !/\$\{item\.calls\} 次/.test(code))
  // Esc 是「手势中途被打断」的现实路径：临时冻结矩形必须跟着清，否则面板停在半路且回不到锚定态。
  ok('Esc 关面板同时丢掉拖到一半的冻结矩形',
    /if \(event\.key !== "Escape"\) return;[\s\S]{0,220}setDragBox\(null\);/.test(code))
}

/* 英文界面不得出现「我们自己写的」中文（审查第 6 条：硬编码中文绕过 COPY）。
 * 宿主回的数据（label / sourceNote / notices）本来就是宿主语言，不在此列；
 * 这里只查画面文案：官方接口、自动识别那几句、重试 tooltip、5h 窗口标签。 */
{
  const { api, registered } = await loadBundle('scope-all', 'en-US')
  // 宿主已经把语言写下来了（假 DOM 默认写 zh-CN）：不覆写就会正确地出中文。
  globalThis.document.documentElement.lang = 'en'
  const dirStore = makeStore({
    current: { provider: 'deepseek', model: 'deepseek-chat' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  findChip(await settle(render, 1)).props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('英文界面：可信度标签 + 半角冒号（official API: …）', panel.includes('official API: DeepSeek'), panel.slice(0, 400))
  ok('英文界面：自动检测的解释走英文', panel.includes('auto-detected via token-plan.cn-beijing.maas.aliyuncs.com'))
  ok('英文界面：实测卡来源走英文', panel.includes('measured on this instance'))
  ok('英文界面：重试 tooltip 走英文（failure code / retry #3）', panel.includes('failure code') && panel.includes('retry #3'))
  for (const leaked of ['官方接口', '自动识别', '失败码', '次重试', '5h窗口']) {
    ok(`英文界面没有漏网的中文文案「${leaked}」`, !panel.includes(leaked))
  }
}

/* 画面文案只能住在 COPY 里 —— 这条把上面那次清扫固化成结构约束。
 * 刻意留的两类白名单：
 *   ① token 的「万/亿」单位由 cjkTokenUnits 门控（英文出 K/M/B，中文才有这两个字）；
 *   ② ctx.logger 的诊断文案跟随全项目中文日志的约定，不进画面。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const zhBlock = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(code)
  const enBlock = /\n      en: \{([\s\S]*?)\n      \},/.exec(code)
  ok('COPY 有 zh / en 两份字典', zhBlock !== null && enBlock !== null)
  const keysOf = (text) => [...text.matchAll(/^ {8}([A-Za-z]\w*):/gm)].map(match => match[1])
  const zh = keysOf(zhBlock?.[1] ?? '')
  const en = keysOf(enBlock?.[1] ?? '')
  // 007 增了 9 个自定义区间键（109 → 118）；008 增了 10 个官方对照键（INTERFACE §3.3 的 8 个
  // + 「官方」格标签 + clampedFrom 说明），118 → 128；009 增 usageScanRescued（008 的 128 → 129）。
  // 010 增了 5 个月份键（Preset/Label/Apply/Bad/MonthTitle），129 → 134。
  // 012 增了 4 个比例键（ShareOf/HitRateLabel/HitRate/RatioNote），134 → 138。
  // 014 增了 9 个 Credits 换算键（Title/Ratio/Window/Detail/Estimate/Note/Loading/Unavailable/Retry），138 → 147。
  // 015 增了 4 个分项/按模型键（Classes/ClassUncached/ModelsTitle/ModelsNote，Note 是改写），147 → 151。
  check('zh / en 键数一致（新增文案必须两边都写）', [zh.length, en.length], [153, 153])
  ok('只有 zh 有的键：无', zh.filter(key => !en.includes(key)).length === 0, zh.filter(key => !en.includes(key)))
  ok('只有 en 有的键：无', en.filter(key => !zh.includes(key)).length === 0, en.filter(key => !zh.includes(key)))

  // 顺序要紧：先把注释剥掉，再剥字典与 CSS 模板串。反过来会让 CSS 的正则跨行吃掉
  // 注释起始符，把半句中文注释当成代码留下（第一次跑就是这么误报的）。
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/const COPY = \{[\s\S]*?\n    \};/, '')
    .replace(/`[^`]*?\.tpq[^`]*?`/g, '')
  const offenders = stripped.split('\n')
    .map((line, index) => ({ line, no: index + 1 }))
    .filter(({ line }) => /[\u3400-\u9fff]/u.test(line))
    .filter(({ line }) => !/ctx\.logger/u.test(line))
    .filter(({ line }) => !/toFixed\(\d\)\}[万亿]/u.test(line))
  ok('COPY 之外没有进画面的中文字面量（要加先加进字典）', offenders.length === 0,
    offenders.map(entry => `L${entry.no} ${entry.line.trim().slice(0, 90)}`).join(' ⏎ '))
}

/* 有官方比例、没取到档位额度（quota-config 超时）：徽标照旧出「余量% + 条」——
 * 条的两个合法来源是 remainingPercent 与**上游直给**的 usedPercent（宪法原则 I v2.0.0），
 * 唯一不报的是绝对剩余量（没分母就是算不出来）。 */
{
  const { api, registered } = await loadBundle('ratio-only')
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('缺分母时徽标出余量百分比（100 − 官方已用比例）', flat.includes('97%'), flat)
  ok('这种卡照样画条：条来自官方给的比例，不是估算', flat.includes('tpq-bar'), flat)
  ok('但不报绝对剩余量（没分母就是不报那个数）', !flat.includes('/ 45,000'), flat)
  findChip(await settle(render, 1)).props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('明细里报「已用 3.3%」而不编造「剩余 / 上限」', panel.includes('已用 3.3%') && !panel.includes('/ 45,000'))
  ok('实测兜底卡不被这张卡收起（它确实有官方数字）', panel.includes('Token Plan 余量'))
}

/* 同一张卡在英文界面下走 usedOnly。 */
{
  const { api, registered } = await loadBundle('ratio-only', 'en-US')
  globalThis.document.documentElement.lang = 'en'
  const dirStore = makeStore({
    current: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('英文界面同一形态也出余量百分比（走 en 字典标签）', flat.includes('97%') && flat.includes('Token Plan quota'), flat.slice(0, 300))
}

/* 当前路由 id 是包装层（`modlens-qwen-token-plan-cn` 之于 `qwen-token-plan-cn`）：
 * 过去精确相等匹配不到任何卡 → 退化成"全量并排"，实机反馈是**两个胶囊同时出现**
 * （余量 + 余额），但只需要一个。现在按 `-` 边界容忍；边界是为了别让 `qwen` 这种短名乱吞。 */
{
  const { api, registered } = await loadBundle()
  const dirStore = makeStore({
    current: { provider: 'modlens-qwen-token-plan-cn', model: 'deepseek-v4.1-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  const chipCount = (flat.match(/tpq-chip/g) ?? []).length
  ok('包装层路由只挂一张卡：胶囊数为 1', chipCount === 1, `chips=${chipCount}`)
  ok('挂的是 Token Plan 那张，余额那张不出现', flat.includes('Token Plan') && !flat.includes('¥33.80'), flat.slice(0, 300))
  ok('吞吐行也认得包装层（速度仍跟着这张卡）', flat.includes('tok/s'), flat.slice(0, 300))
}

/* 路由解析不出时（目录不认这条路由，如中转/自定义路由）**只出一张**，且挑的是
 * "最近真在服务请求的那条路由"绑定的卡 —— **不是模型名匹配**：初版用模型名当线索，
 * `deepseek-v4.1-flash`（模型家族）把绑 `deepseek` 的余额卡挑了出来，实机反馈
 * "只剩余额的钱数、条状额度不见了"。这里两条模型名都必须是额度卡胜出。 */
for (const model of ['deepseek-v4.1-flash', 'qwen3.8-flash']) {
  const { api, registered } = await loadBundle('with-console')
  const dirStore = makeStore({
    current: { provider: 'some-unrelated-relay', model },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  const chipCount = (flat.match(/tpq-chip/g) ?? []).length
  ok(`路由不认时只出一枚胶囊（model=${model}）`, chipCount === 1, `chips=${chipCount}`)
  ok('挑的是额度卡（Token Plan 余量），不是余额卡',
    flat.includes('Token Plan 余量') && !flat.includes('¥'), flat.slice(0, 260))
}

/* 徽标降级挑选的两处顺序问题（第四轮 Open Code Review，lib/client.js 的 cardValueText / pickOne）。
 *  ① 报错的**余额卡**（metric:money 且没有 remaining）正面写什么：旧写法里 `card.error && !hasNumbers(card)` 那条
 *     排在 money 早退之后，永远走不到，实机症状就是接口坏了却看着像`没有数据`。fixture 里的
 *     account-balance 正是这张卡，此前没有任何用例钉它的正面文案。
 *  ② 降级路径里没有数字的窗口卡（只有 meters）不得排在报错卡之前：前者只能显示`无官方额度数据`，
 *     后者脸上带着`去配 Cookie`。有数的卡早被上面几档收走，走到这两档的必然是没数的。
 */
{
  const emptyWindow = {
    id: 'window-empty', label: '千问窗口', metric: 'count', veracity: 'estimated', estimated: true,
    meters: [{ key: 'weekly', label: '7 天窗口', unit: 'tok', total: null, remaining: null }],
    items: [], error: null,
  }
  const balanceError = SNAPSHOT.cards.find(card => card.id === 'account-balance')
  const snapshot = {
    ...SNAPSHOT,
    throughput: { ...SNAPSHOT.throughput, byProvider: [] },
    cards: [emptyWindow, balanceError],
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => snapshot })
  const { api, registered } = await loadBundle('default', 'zh-CN', fetchImpl)
  const dirStore = makeStore({
    current: { provider: 'some-unrelated-relay', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  api.apply(makeCtx(registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore, load: async () => {} }) },
  }))
  const component = registered[0].component
  resetHooks()
  const render = () => {
    beginRender()
    return component()
  }
  const flat = JSON.stringify(await settle(render))
  ok('降级挑选：报错卡优先于只有 meters 的没数窗口卡',
    flat.includes('阿里云余额') && !flat.includes('千问窗口'), flat.slice(0, 260))
  ok('报错的余额卡正面说「查询失败」（不再落进 — 或 无官方额度数据）',
    flat.includes('查询失败') && !flat.includes('无官方额度数据'), flat.slice(0, 260))
  // 反向那半：有真数字的卡不能被报错卡挤掉——004 那条老教训（报错的控制台卡按数组顺序先命中，
  // 把有 3400 万 tokens 的实测卡顶成「无官方额度数据」）必须继续成立。
  const numberedBalance = { ...balanceError, remaining: 12.5, unit: 'CNY', error: null, errorCode: null, hint: null }
  const snap2 = { ...snapshot, cards: [emptyWindow, numberedBalance] }
  const second = await loadBundle('default', 'zh-CN', async () => ({ ok: true, status: 200, json: async () => snap2 }))
  const dirStore2 = makeStore({
    current: { provider: 'some-unrelated-relay', model: 'qwen3.8-flash' },
    routable: true, groups: [], failures: [], status: 'ready', error: null,
  })
  second.api.apply(makeCtx(second.registered, new Set(['conversation.input.left', 'conversation.input.dock']), [], {
    sessions: { list: makeStore({ current: 's1' }) },
    modelDirectories: { directoryFor: () => ({ store: dirStore2, load: async () => {} }) },
  }))
  second.registered[0].component && resetHooks()
  const flat2 = JSON.stringify(await settle(() => { beginRender(); return second.registered[0].component() }))
  ok('有真数字的余额卡仍然优先于没数的窗口卡（不被 meters 档抢走）',
    flat2.includes('¥12.50') && !flat2.includes('千问窗口'), flat2.slice(0, 260))
}

/* ============================================================ 用量统计整页屏（spec 006，INTERFACE §3/§4）
 * 这一屏是宿主 main 整页座位上的「产品页」，不是徽标小窗：注册形状、五个状态、
 * 2D/3D 共用比例函数、天数输入的夹取语义都在这里逐条钉住。数据用假快照
 * （makeUsageSnapshot），不联网、不依赖宿主路由实现。
 */

/** 深度优先找 className 里含某一格的节点（假 React 的元素树）。 */
function findNodes(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  const classes = String(node.props?.className ?? '').split(/\s+/)
  if (classes.includes(className)) out.push(node)
  for (const child of node.children ?? []) findNodes(child, className, out)
  return out
}

/** 深度优先找 props 里带某个 data-* 的节点（009 脚注这类无 class 的钩子用）。 */
function nodesWithProp(node, prop, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.props?.[prop] !== undefined) out.push(node)
  for (const child of node.children ?? []) nodesWithProp(child, prop, out)
  return out
}

/** 渲染树里的全部文本：文案断言不依赖具体 DOM 结构。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node !== 'object') return out
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

/** 本用例里对整页屏数据路由的全部请求（末尾的 "?" 把 -official 挡在外面）。 */
function usageRequests() {
  return fetchCalls.filter((entry) => String(entry.url).startsWith('/token-plan-quota/usage?'))
}

/** 008：官方账号侧路由的请求（与本机路由分开计数，断言互不污染）。 */
function officialRequests() {
  return fetchCalls.filter((entry) => String(entry.url).startsWith('/token-plan-quota/usage-official'))
}

/** 官方侧回一个 200 包（成功体或 {error, code, hint} 失败体都由调用方给全）。 */
function officialResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

/** 用一份改过的假快照回包（五个状态各要一份）。 */
function usageFetch(mutate) {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
    // 008：官方路由单独回官方形状（mutate 只描述本机快照，别拿它冒充官方数字）。
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(days) }
    }
    return { ok: true, status: 200, json: async () => mutate(makeUsageSnapshot(days)) }
  }
}

/**
 * 挂一个「有 main 整页座位」的宿主：layout 服务 + defineStore 都在。
 * 返回的 renderUsage 直接调用注册进去的组件（假 React 每次 render 都重跑 effect）。
 */
async function mountUsage(options = {}) {
  const bundle = await loadBundle(options.fetchMode ?? 'ok', options.lang ?? 'zh-CN', options.fetchImpl ?? null, {
    main: true,
    clientStore: options.clientStore,
    // 011：reactDOM:false 用来测 createPortal 缺席时的内联浮层路径。
    reactDOM: options.reactDOM,
  })
  bundle.dom.document.documentElement.lang = options.lang ?? 'zh-CN'
  const warns = []
  const layout = {
    calls: [],
    selectPanel(id) { this.calls.push(id) },
    panelInfo: { getSnapshot: () => ({ activePanelId: options.activePanelId ?? null }) },
  }
  const seats = [...bundle.declaredSlots]
  const ctx = makeCtx(bundle.registered, bundle.declaredSlots, [], { seats, layout })
  ctx.logger = { warn: (error) => warns.push(String(error?.message ?? error)) }
  bundle.api.apply(ctx)
  const main = bundle.registered.find((entry) => entry.options.name === 'main')
  const panelIcon = bundle.registered.find((entry) => entry.options.name === 'sidebar.panellist')
  const handle = main?.options.store
  // 010：恢复态用例要在首帧之前把 store 预置成某个状态（宿主重进屏时会带上次的 rangeMode）。
  if (typeof options.seedStore === 'function') options.seedStore(handle)
  const props = {
    useStore: (selector) => selector(handle.create().getSnapshot()),
    actions: handle ?? {},
    // 超时由组件读可选的 props.timeoutMs（宿主不传，生产恒为 15 秒）；测试注入短值避免真等。
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
  const renderUsage = () => {
    beginRender()
    return main.component(props)
  }
  return { ...bundle, warns, layout, main, panelIcon, handle, props, renderUsage }
}

/* §4 ①：座位注册形状。main 的 key、侧栏按钮的 id、内页 id 必须是同一个 PANEL_ID，
 * 否则宿主点侧栏按钮打不开这一屏（app.asar 里 schedule / plugin-manager 就是这个形状）。 */
{
  const bundle = await mountUsage()
  check('main 整页座位的 key 是 PANEL_ID', bundle.main?.options.key, 'token-plan-quota.usage')
  check('侧栏按钮与 main 座位共用一个 id', bundle.panelIcon?.options.id, bundle.main?.options.key)
  check('侧栏按钮排在默认顺位', bundle.panelIcon?.options.order, 10)
  check('侧栏按钮标题走 COPY（跟随界面语言）', bundle.panelIcon?.options.label(), 'Token 计划用量')
  ok('main 注册同时带 store 与 inject（宿主契约要求两项都在）',
    typeof bundle.main?.options.store?.create === 'function' && typeof bundle.main?.options.inject === 'function')
  const first = bundle.main.options.store.create()
  const again = bundle.main.options.store.create()
  ok('store.create() 恒返回同一个实例（切页不闪骨架）', first === again)
  check('store 初值是 7 天 / 2D', [first.getSnapshot().days, first.getSnapshot().mode], [7, '2d'])
  bundle.main.options.store.setDays(30)
  check('setDays 动作写回实例（下次进页记得住）', first.getSnapshot().days, 30)
  bundle.main.options.store.setMode('3d')
  check('setMode 动作写回实例', first.getSnapshot().mode, '3d')
}

/* §4 ②：宿主没有这门能力时不许抛，只降级成徽标并留一条可诊断的警告。 */
{
  const bundle = await mountUsage({ clientStore: false })
  check('没有 defineStore 时只挂徽标', bundle.registered.map((entry) => entry.options.name), ['conversation.input.left'])
  ok('无 main 座位时警告写明原因（不静默失败）',
    bundle.warns.some((text) => text.includes('用量统计屏不注册')), bundle.warns.join(' | '))
}
{
  // 只有 slots、没有 layout：宿主版本过旧，同样退化成徽标。
  const bundle = await loadBundle('ok', 'zh-CN', null, { main: true })
  const warns = []
  const ctx = makeCtx(bundle.registered, bundle.declaredSlots, [], { seats: [...bundle.declaredSlots] })
  ctx.logger = { warn: (error) => warns.push(String(error?.message ?? error)) }
  bundle.api.apply(ctx)
  check('没有 layout 服务时也只挂徽标', bundle.registered.map((entry) => entry.options.name), ['conversation.input.left'])
  ok('同样给出可诊断的警告', warns.some((text) => text.includes('用量统计屏不注册')), warns.join(' | '))
}
{
  // slots.spec('main') 返回 undefined（宿主没这一格）也走降级分支。
  const bundle = await loadBundle('ok', 'zh-CN', null, { main: true })
  const ctx = makeCtx(bundle.registered, bundle.declaredSlots, [], {
    seats: [...bundle.declaredSlots].filter((name) => name !== 'main'),
    layout: { selectPanel() {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }) } },
  })
  bundle.api.apply(ctx)
  check('宿主没有 main 座位时 main 不注册', bundle.registered.some((entry) => entry.options.name === 'main'), false)
  check('侧栏按钮也不注册（不留一个点不开的图标）', bundle.registered.some((entry) => entry.options.name === 'sidebar.panellist'), false)
}

/* §4 ④-a：首帧骨架 + 数据态的完整内容（总数 / 五项拆分 / 图表 / 模型 / 脚注）。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const skeletonTree = bundle.renderUsage()
  ok('首帧是骨架而不是空白（加载态有形状）',
    findNodes(skeletonTree, 'tpq-usage-skel').length === 3
      && collectText(skeletonTree).join(' ').includes('正在读取会话记录'),
    collectText(skeletonTree).join(' ').slice(0, 200))
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('标题 + 区间副标题', text.includes('Token 计划用量') && text.includes('近 7 天'), text.slice(0, 200))
  ok('区间总数走 formatTokens（1,000,000 → 100.0万）', text.includes('100.0万'), text.slice(0, 300))
  // 012：中文界面不许再露出四个英文标签（用户原话「下面的用量改成中文」）。
  const splitLabels = ['输入', '输出', '缓存命中', '缓存写入', '缓存命中率', '调用次数']
  const englishLabels = ['input', 'output', 'cacheRead', 'cacheWrite']
  // 「当前宿主大多不上报 cacheWrite」是既有脚注在点名宿主字段，不是 UI 标签，扫描时排除。
  const labelSurface = text.split('当前宿主大多不上报 cacheWrite，这个数常年为 0 属正常。').join('')
  ok('拆分项在中文界面全中文（输入 / 输出 / 缓存命中 / 缓存写入 / 命中率 / 调用次数）',
    splitLabels.every((label) => text.includes(label))
      && englishLabels.every((label) => !labelSurface.includes(label)),
    'missing=' + splitLabels.filter((label) => !text.includes(label)).join(',')
      + ' stray=' + englishLabels.filter((label) => labelSurface.includes(label)).join(',')
      + ' text=' + text.slice(0, 500))
  ok('总量卡给出四项构成比（分母 = 区间 tokens 总量）',
    text.includes('输入 60.0万 占 60%') && text.includes('输出 30.0万 占 30%')
      && text.includes('缓存命中 10.0万 占 10%'),
    text.slice(0, 500))
  ok('总量卡给出缓存命中率（cacheRead ÷ (input + cacheRead + cacheWrite)）',
    text.includes('缓存命中率 14.3%'), text.slice(0, 500))
  ok('数字来源打「本实例实测」徽标（不是官方余额）', text.includes('本实例实测'))
  ok('数据源脚注按 source.kind 本地化（session-index → 本地 COPY 句，不照抄宿主 label）',
   text.includes('数据源：本实例实测（来自本地会话记录），不是官方余额。'), text.slice(-260))
  ok('脚注声明不折算 Credits、不估算余量', text.includes('不折算 Credits，也不估算余量。'))
  ok('模型行按 tokens 降序（qwen 在 deepseek 前，不按数组顺序）',
    text.indexOf('qwen/qwen3-max') >= 0 && text.indexOf('qwen/qwen3-max') < text.indexOf('deepseek/deepseek-chat'),
    String(text.indexOf('qwen/qwen3-max')) + ' vs ' + String(text.indexOf('deepseek/deepseek-chat')))
  /* 011：原生 <title> 已删除（会与自绘浮层双提示）。可读文本改由 g 的 role/aria-label 提供，
     与浮层首行/总量同一份 usageBucketTitle —— 「不靠眼看」这条意图不变，载体换了。 */
  const bars2d = findNodes(tree, 'tpq-usage-bar2d')
  ok('柱子不再渲染原生 <title>（011：改自绘浮层，避免系统提示与浮层双份）',
    bars2d.length === 7 && bars2d.every((bar) => (bar.children ?? []).every((child) => child?.type !== 'title')),
    bars2d.map((bar) => (bar.children ?? []).map((child) => child?.type).join('+')).join(' | '))
  ok('每根柱子带 011 命中钩子与可读文本（aria-label 与浮层同源）',
    bars2d.every((bar, index) => bar.props['data-usage-bar'] === '1'
      && bar.props['data-usage-bar-index'] === String(index)
      && typeof bar.props['data-usage-bar-from'] === 'string' && bar.props['data-usage-bar-from'].length === 10
      && typeof bar.props['data-usage-bar-to'] === 'string' && bar.props['data-usage-bar-to'].length === 10
      && bar.props.tabIndex === 0 && bar.props.role === 'img'
      && typeof bar.props['aria-label'] === 'string'
      && bar.props['aria-label'].includes(bar.props['data-usage-bar-from'])
      && bar.props['aria-label'].includes('tokens')
      && bar.props['aria-label'].includes('调用次数')),
    bars2d.map((bar) => bar.props['aria-label']).join(' | '))
  ok('「更新于 HH:MM」', /更新于 \d{2}:\d{2}/.test(text), text.slice(-80))
  ok('可见期间每 30 秒刷新一次', bundle.intervals.some((entry) => entry.ms === 30000))
  check('打开时按当前天数请求 data 路由', usageRequests().at(-1)?.url, '/token-plan-quota/usage?days=7')
}

/* §4 ⑤：2D 与 3D 共用同一个比例函数——同一份 buckets，柱子的数据高度必须逐个相等。
 * 3D 只允许加固定等轴偏移（dx=-w/2、dy=-depth），不许透视。 */
{
  const bundle = await mountUsage()
  const internals = bundle.api.__internals
  // 006 的五个是契约，007 只允许在它们之后追加（顺序无关，但一个都不能少）。
  const internalKeys = Object.keys(internals)
  ok('__internals 保留 §4 要求的五个纯函数',
    ['barRatio', 'clampDays', 'formatTokens', 'parseDaysInput', 'projectBar3D'].every(key => internalKeys.includes(key)),
    internalKeys.join(','))
  ok('__internals 追加 007 的区间校验纯函数',
    ['validateUsageRange', 'usageRangeDays', 'usageShiftDay', 'usageTodayKey', 'usageRangeText',
      'usageSnapshotMatchesQuery', 'usageDefaultCustomRange'].every(key => typeof internals[key] === 'function'),
    internalKeys.join(','))
  check('barRatio 线性：一半就是一半', internals.barRatio(500, 1000), 0.5)
  check('barRatio 峰值为 0 不除零', internals.barRatio(5, 0), 0)
  check('barRatio 有值但不足一格时抬到 1/PLOT_H（不然看不见）', internals.barRatio(1, 1000000), 1 / 120)
  check('clampDays 夹到 1..365、非数给 null',
    [internals.clampDays(0), internals.clampDays(366), internals.clampDays(30.4), internals.clampDays('abc')],
    [1, 365, 30, null])
  check('parseDaysInput 只认整数',
    [internals.parseDaysInput('abc'), internals.parseDaysInput(''), internals.parseDaysInput('12')],
    [null, null, 12])
  const barA = internals.projectBar3D(0.2, { x: 10, base: 136, w: 14, plotH: 120, depth: 7 })
  const barB = internals.projectBar3D(0.9, { x: 10, base: 136, w: 14, plotH: 120, depth: 7 })
  check('3D 等轴偏移与柱高无关（没有透视、没有近大远小）',
    [barA.dx, barA.dy, barB.dx, barB.dy], [-7, -7, -7, -7])
  check('3D 正面高度仍由同一个 ratio 决定', [barA.height, barB.height], [24, 108])

  resetHooks()
  const tree2d = await settle(bundle.renderUsage, 5)
  const snapshot = makeUsageSnapshot(7)
  const peak = Math.max(...snapshot.buckets.map((bucket) => bucket.totals.tokens))
  const ratios = snapshot.buckets.map((bucket) => internals.barRatio(bucket.totals.tokens, peak))
  const rects = findNodes(tree2d, 'tpq-usage-rect')
  check('2D：一桶一根柱子', rects.length, 7)
  ok('2D：柱高 = ratio × PLOT_H',
    rects.every((rect, index) => Math.abs(rect.props.height - ratios[index] * 120) < 1e-9),
    rects.map((rect) => rect.props.height).join(','))
  ok('2D：柱高与 tokens 同一线性比例（自洽校验）',
    rects.every((rect, index) => Math.abs(rect.props.height / 120 - snapshot.buckets[index].totals.tokens / peak) <= 0.5 / 120 + 1e-9))
  check('2D：只有最高的桶带数值标签（不糊成一片）', findNodes(tree2d, 'tpq-usage-value').length, 1)
  check('2D 模式不画 3D 面', findNodes(tree2d, 'tpq-usage-face-front').length, 0)

  /* 图表不是固定 22px 一格的小块：量不到容器时用兜底画布宽把 7 根柱铺开，
     每格 115px、柱宽 58px（格宽一半），整张图 817×164 —— 宽卡片上不再缩成一小条。
     高度 164 = TOP_H 26（给最高柱的数值标签留呼吸）+ PLOT_H 120 + AXIS_H 18。 */
  const chart2d = findNodes(tree2d, 'tpq-usage-svg')[0]
  check('2D：兜底画布宽下把柱子铺开（817×164）', [chart2d.props.width, chart2d.props.height], [817, 164])
  check('2D：柱宽取格宽一半（有呼吸缝，不是一条线）', rects.map((rect) => rect.props.width), [58, 58, 58, 58, 58, 58, 58])
  ok('2D：柱子按格宽等距排开（不是挤在左侧）',
    rects.every((rect, index) => Math.abs(rect.props.x - (6 + index * 115 + 28.5)) < 1e-9),
    rects.map((rect) => rect.props.x).join(','))

  const threeDButton = findNodes(tree2d, 'tpq-usage-mode').find((node) => collectText(node).join('') === '3D')
  ok('有 3D 视图切换按钮', threeDButton !== undefined)
  threeDButton.props.onClick()
  const tree3d = await settle(bundle.renderUsage, 4)
  const fronts = findNodes(tree3d, 'tpq-usage-face-front')
  const caps = findNodes(tree3d, 'tpq-usage-face-cap')
  const sides = findNodes(tree3d, 'tpq-usage-face-side')
  check('3D：每桶三个面（顶面 / 正面 / 侧面）', [fronts.length, caps.length, sides.length], [7, 7, 7])
  check('3D 模式不画 2D 矩形', findNodes(tree3d, 'tpq-usage-rect').length, 0)
  const frontHeight = (node) => {
    const ys = String(node.props.points).trim().split(/\s+/).map((pair) => Number(pair.split(',')[1]))
    return Math.max(...ys) - Math.min(...ys)
  }
  ok('3D 正面高度与 2D 矩形高度逐个相等（SC-006：共用同一个比例函数）',
    fronts.every((front, index) => Math.abs(frontHeight(front) - rects[index].props.height) < 1e-9),
    fronts.map(frontHeight).join(','))
  ok('3D 顶面尺寸恒定（等轴：深度 7、横向错开半根柱宽，与柱高无关）',
    caps.every((cap, index) => {
      const points = String(cap.props.points).trim().split(/\s+/).map((pair) => pair.split(',').map(Number))
      const xs = points.map((point) => point[0])
      const ys = points.map((point) => point[1])
      const frontPoints = String(fronts[index].props.points).trim().split(/\s+/).map((pair) => pair.split(',').map(Number))
      const frontXs = frontPoints.map((point) => point[0])
      const capSpan = Math.max(...xs) - Math.min(...xs)
      const frontSpan = Math.max(...frontXs) - Math.min(...frontXs)
      return Math.abs(capSpan - frontSpan - frontSpan / 2) < 1e-9
        && Math.abs((Math.max(...ys) - Math.min(...ys)) - 7) < 1e-9
    }))
}

/* §4 ⑥：天数输入。非数字不发请求并恢复旧值；超界先夹到 1..365 再按夹后的值请求，
 * 输入框回显夹后的值（SC-007）。 */
{
  const bundle = await mountUsage()
  resetHooks()
  await settle(bundle.renderUsage, 5)
  const inputOf = (tree) => findNodes(tree, 'tpq-usage-days-input')[0]
  let tree = bundle.renderUsage()
  const input = inputOf(tree)
  check('天数输入框的 min/max/step 与常量一致', [input.props.min, input.props.max, input.props.step], [1, 365, 1])

  input.props.onChange({ target: { value: 'abc' } })
  tree = bundle.renderUsage()
  const beforeBlur = usageRequests().length
  inputOf(tree).props.onBlur()
  check('非数字：不发请求', usageRequests().length, beforeBlur)
  tree = bundle.renderUsage()
  check('非数字：输入框恢复上一次有效值', inputOf(tree).props.value, '7')

  inputOf(tree).props.onChange({ target: { value: '366' } })
  tree = bundle.renderUsage()
  const before366 = usageRequests().length
  inputOf(tree).props.onBlur()
  check('366：不按 366 发请求', usageRequests().length, before366)
  tree = bundle.renderUsage()
  check('366：夹取后的值写回输入框', inputOf(tree).props.value, '365')
  const clamped = await settle(bundle.renderUsage, 2)
  check('366：下一次请求的是 365 天', usageRequests().at(-1)?.url, '/token-plan-quota/usage?days=365')
  ok('366：副标题回显实际天数（不是用户输入的原值）',
    collectText(clamped).join(' ').includes('近 365 天'), collectText(clamped).join(' ').slice(0, 120))

  const preset30 = findNodes(tree, 'tpq-usage-day').find((node) => collectText(node).join('') === '30')
  ok('有 30 天预设按钮', preset30 !== undefined)
  preset30.props.onClick()
  tree = bundle.renderUsage()
  check('预设 30 天：立刻按 30 天请求', usageRequests().at(-1)?.url, '/token-plan-quota/usage?days=30')
  ok('预设按钮的按下态跟着走',
    findNodes(tree, 'tpq-usage-day').find((node) => collectText(node).join('') === '30').props['data-active'] === '1')

  const preset90 = findNodes(tree, 'tpq-usage-day').find((node) => collectText(node).join('') === '90')
  ok('有 90 天预设按钮', preset90 !== undefined)
  preset90.props.onClick()
  tree = await settle(bundle.renderUsage, 3)
  const wide = findNodes(tree, 'tpq-usage-svg')[0]
  ok('90 天：画布宽随桶数增长（超出容器交给 .tpq-usage-scroll 横滚）',
    wide.props.width > 2000, String(wide.props.width))
  const narrowBars = findNodes(tree, 'tpq-usage-rect')
  check('90 天：一桶一根柱', narrowBars.length, 90)
  ok('90 天：格宽压到 STEP_MIN 后柱宽仍不小于 BAR_MIN（不压成一条线）',
    narrowBars.every((rect) => rect.props.width >= 8), narrowBars.map((rect) => rect.props.width).slice(0, 5).join(','))
}

/* §4 ⑦：关闭。按钮与 Esc 都走 ctx.layout.selectPanel(null)，回到会话主视图。
 * Esc 必须先过 activePanelId 守卫：宿主切页后会保活组件实例，不许误关看不见的屏。 */
{
  const bundle = await mountUsage({ activePanelId: 'token-plan-quota.usage' })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  findNodes(tree, 'tpq-usage-close')[0].props.onClick()
  check('关闭按钮 = 回会话主视图（selectPanel(null)）', bundle.layout.calls, [null])
  const keydowns = bundle.dom.listeners.get('keydown') ?? []
  ok('组件挂了 Esc 监听', keydowns.length > 0)
  const onKey = keydowns.at(-1)
  onKey({ key: 'Enter' })
  check('其它键不关页', bundle.layout.calls.length, 1)
  onKey({ key: 'Escape' })
  check('Esc 也关整页屏', bundle.layout.calls, [null, null])
}
{
  // 本屏不在前台（activePanelId 是别的屏）：Esc 不许动 selectPanel。
  const bundle = await mountUsage({ activePanelId: 'some-other-panel' })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  const onKey = (bundle.dom.listeners.get('keydown') ?? []).at(-1)
  onKey({ key: 'Escape' })
  check('本屏不在前台时 Esc 不关页（不误伤别的屏）', bundle.layout.calls, [])
}

/* 375px 视口：量不到容器时用视口宽度估保守画布宽（减两侧留白 60），7 天整幅落在容器里（不横滚）。 */
{
  const bundle = await mountUsage()
  globalThis.window.innerWidth = 375
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const svg = findNodes(tree, 'tpq-usage-svg')[0]
  check('375px：7 天整幅落在容器内（视口 -60 估宽 → 12+7×43=313）', svg.props.width, 313)
  ok('375px：柱宽仍是格宽一半（22），且不小于 BAR_MIN',
    findNodes(tree, 'tpq-usage-rect').every((rect) => rect.props.width === 22))
  ok('真实宿主里用 ResizeObserver 精修到容器实际宽度（源码级）',
    /new ResizeObserver\(/.test(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')))
}

/* §4 ⑧：数字纪律——012 起画面允许两处实测比值（构成比 / 命中率），
 * 但百分比必须只以白名单段拼出的单值片段出现；除此之外不出现 Credits。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  const fragments = text.match(/\d+(?:\.\d+)?%|<0\.1%/g) ?? []
  // 7 天 fixture：总量 3 个占比 + 1 个命中率；两个模型各 3 个占比 + 1 个命中率（缓存写入 0 不出占比）。
  check('画面的百分比只有实测比值这一种来源（3+1 + 3+1 + 3+1 = 12 处）', fragments.length, 12)
  ok('% 只来自构成比与命中率（没有别的派生百分比）',
    fragments.every((fragment) => ['60%', '30%', '10%', '14.3%', '61.5%', '30.8%', '7.7%', '11.1%', '57.1%', '28.6%', '20%']
      .includes(fragment)), fragments.join(','))
  ok('百分比片段都长成「x%」或「(x%)」，不拼进句子',
    strayPercentFragments(text).length === 0, strayPercentFragments(text).join(' | '))
  // 014：Credits 换算块合法地出现「Credits」——换算块的文案由 usageCredits* 九个键决定，
  // 这里把换算块整段的文本先剔掉，剩下的画面除了那一条脚注白名单外仍不许出现 Credits。
  let withoutCreditsBlock = text.split('不折算 Credits，也不估算余量。').join('')
  for (const chunk of collectText(findNodes(tree, 'tpq-usage-credits')[0] ?? [])) {
    withoutCreditsBlock = withoutCreditsBlock.split(chunk).join('')
  }
  ok('除换算块与那一条脚注白名单外不出现 Credits', !withoutCreditsBlock.includes('Credits'),
    withoutCreditsBlock.slice(0, 400))
  ok('白名单脚注本身确实渲染出来了', text.includes('不折算 Credits，也不估算余量。'))
  ok('比例口径脚注跟着数据一起渲染（公式写在屏上）',
    text.includes('占比与命中率都是本机实测 tokens 的比值')
      && text.includes('不是配额比例'), text.slice(-400))
}

/* 英文界面不许混进中文（COPY 是两张完整字典，不是中文兜底）。
 * lead 第 9 条：宿主 source.label 是写死中文（API 真值），客户端必须按 kind 本地化，
 * 否则英文页会出现 "Source: 本实例实测（来自本地会话记录）, not an official balance."。 */
{
  const bundle = await mountUsage({
    lang: 'en-US',
    fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'session-index', veracity: 'measured', label: '本实例实测（来自本地会话记录）' } })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('英文界面没有中文字符', !/[\u3400-\u9fff]/u.test(text), text.slice(0, 300))
  ok('英文标题与区间副标题', text.includes('Token plan usage') && text.includes('Last 7 days'), text.slice(0, 200))
  ok('英文数据源脚注按 kind 本地化（不照抄宿主中文 label）',
    text.includes('Source: measured in this instance (from local session records), not an official balance.'), text.slice(-260))
  ok('英文页不出现宿主中文 label 的任何片段', !text.includes('本实例实测（来自本地会话记录）'), text.slice(-260))
}

/* 五个状态：回填中 / 空（无记录）/ 空（无持久化）/ 关闭 / 错误。 */
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, refreshing: true, coverage: { ...snap.coverage, sessions: 12, indexed: 3 } })) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('回填中：顶部细进度条 + 正在回填历史（N/M 会话）',
    findNodes(tree, 'tpq-usage-progress').length === 1 && text.includes('正在回填历史（3/12 会话）'), text.slice(0, 220))
  check('进度条按 indexed/sessions 缩放（0.25）',
    findNodes(tree, 'tpq-usage-progress-bar')[0].props.style.transform, 'scaleX(0.25)')
  ok('回填进行中不叠加「正在同步」轻提示（进度条已说明状态）', !text.includes('正在同步'), text.slice(0, 240))
}
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, buckets: [], models: [], emptyReason: 'no-usage' })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('空态（这个区间没用量）：说清原因并给下一步', text.includes('这个区间没有记录到用量') && text.includes('换个天数'), text.slice(0, 220))
}
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, emptyReason: 'no-session-persistence' })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('空态（没有会话持久化）：解释为什么读不到历史', text.includes('宿主没有开启会话持久化'), text.slice(0, 240))
}
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, enabled: false, emptyReason: 'usage-stats-disabled' })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('关闭态：说明已关闭并指向配置项', text.includes('用量统计已关闭') && text.includes('usageStats'), text.slice(0, 240))
  ok('关闭态不渲染数据源脚注（没有来源可声明，不许写死实测口径）',
    !text.includes('数据源') && !text.includes('来自本地会话记录') && !text.includes('本实例实测'), text.slice(0, 300))
}
{
  // 错误态：一行可重试的说明，重试真的再发一次请求。
  const failing = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    return { ok: false, status: 500, json: async () => ({}) }
  }
  const bundle = await mountUsage({ fetchImpl: failing })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('错误态：说清「用量数据没取到」并给重试', text.includes('用量数据没取到') && text.includes('重试'), text.slice(0, 220))
  const before = usageRequests().length
  findNodes(tree, 'tpq-usage-retry')[0].props.onClick()
  ok('点重试会再请求（不是死按钮）', usageRequests().length > before)
}
{
  // 周粒度（>62 天时宿主给 week 桶）：标题与说明换成「每周」。
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, granularity: 'week' })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('周粒度：标题写「每周用量」并注明周一起算', text.includes('每周用量') && text.includes('每 7 天汇总（周一起算）'), text.slice(0, 220))
}

/* 切天数竞态（lead 复审第 1 条）：慢的旧请求后回来，不许覆盖新天数的快照。
 * 旧实现只判 aliveRef，切天数后旧请求仍看到 true → 副标题（新 days）与坐标轴（旧快照）同屏混搭。 */
{
  const pending = []
  const raceFetch = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
    if (String(url).startsWith('/token-plan-quota/usage') && days === 7) {
      const snapshot = makeUsageSnapshot(7)
      // 慢请求：挂起，等用例手动放行（模拟旧响应后到）。
      return await new Promise((resolve) => {
        pending.push(() => resolve({ ok: true, status: 200, json: async () => snapshot }))
      })
    }
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
  }
  const bundle = await mountUsage({ fetchImpl: raceFetch })
  resetHooks()
  bundle.renderUsage()
  ok('竞态用例：7 天请求确实还挂起（旧响应尚未回包）', pending.length > 0)
  findNodes(bundle.renderUsage(), 'tpq-usage-day').find(node => collectText(node).join('') === '30').props.onClick()
  const tree30 = await settle(bundle.renderUsage, 5)
  ok('切到 30 天后先落到 30 天数据（副标题 + 30 根柱）',
    collectText(tree30).join(' ').includes('近 30 天') && findNodes(tree30, 'tpq-usage-rect').length === 30,
    collectText(tree30).join(' ').slice(0, 200))
  for (const release of pending) release()
  // 让旧请求的 then 落地，然后只渲染一帧：这一帧里新请求还没回包，
  // 旧实现会在这里展示 7 天的数据（30 天副标题 + 7 根柱），新实现仍是 30 天。
  await new Promise(resolve => setTimeout(resolve, 0))
  const staleFrame = bundle.renderUsage()
  ok('旧响应后到不落地：仍是 30 天区间与 30 根柱（不是 7 天）',
    collectText(staleFrame).join(' ').includes('近 30 天') && findNodes(staleFrame, 'tpq-usage-rect').length === 30,
    collectText(staleFrame).join(' ').slice(0, 200) + ' | bars=' + String(findNodes(staleFrame, 'tpq-usage-rect').length))
  await settle(bundle.renderUsage, 2)
}

/* 数据源脚注口径（lead 第 2 / 9 条）：按 source.kind 用本地 COPY 渲染，disabled 态不渲染。
 * 数字口径纪律：写死「来自本地会话记录」在没有持久化的宿主上就是假话。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'in-process', veracity: 'measured', label: '宿主写死的 in-process 文案' } })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('in-process：脚注按 kind 用本地文案（不照抄宿主 label）',
    text.includes('数据源：本进程启动以来（实测），不是官方余额。'), text.slice(-260))
  ok('in-process：宿主 label 不进渲染结果', !text.includes('宿主写死的 in-process 文案'), text.slice(-260))
  ok('in-process：不再出现写死的「来自本地会话记录」', !text.includes('来自本地会话记录'))
}
{
  // 宿主没给 label：kind 已能定来源句，仍然不冒充会话记录。
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'in-process' } })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('in-process 无 label：按 kind 用「本进程启动以来（实测）」',
    text.includes('数据源：本进程启动以来（实测），不是官方余额。'), text.slice(-260))
}
{
  // 未知 kind 才回落到宿主 label（宿主兜底文案是 API 真值）。
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'future-source', veracity: 'measured', label: 'Host fallback label' } })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('未知 kind：回落到宿主 label（不丢兜底文案）',
    text.includes('数据源：Host fallback label，不是官方余额。'), text.slice(-260))
}
{
  // 未知 kind 且无 label：退回整句保守说法。
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'future-source' } })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('未知 kind 且无 label：退回整句 usageNoteSourceFallback',
    text.includes('数据源：本实例实测（来自本地会话记录），不是官方余额。'), text.slice(-260))
}
{
  // kind=disabled 自己也不渲染来源句（关闭态的说明由 disabled 卡片承担）。
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, source: { kind: 'disabled', veracity: 'unknown', label: '不应出现' } })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('kind=disabled：来源句即使 enabled 也不渲染', !text.includes('数据源') && !text.includes('不应出现'), text.slice(-260))
}

/* refreshing ≠ 回填（lead 复审第 3 条）：INTERFACE §2 的 refreshing 空闲时也会为真，
 * 直接画满格进度条会误报「正在回填」。会话已全部索引时只给一句轻提示。 */
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, refreshing: true })) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('refreshing 但会话已全部索引：不画回填进度条，只给「正在同步」轻提示',
    findNodes(tree, 'tpq-usage-progress').length === 0 && text.includes('正在同步'), text.slice(0, 240))
}

/* 全零区间（lead 复审第 5 条）：没有最高值就不许给第一根空柱标 0 并高亮。 */
{
  const zero = (snap) => ({
    ...snap,
    totals: { ...snap.totals, tokens: 0 },
    buckets: snap.buckets.map((bucket) => ({ ...bucket, totals: { ...bucket.totals, tokens: 0 } })),
  })
  const bundle = await mountUsage({ fetchImpl: usageFetch(zero) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const rects = findNodes(tree, 'tpq-usage-rect')
  check('全零区间：柱子高度全为 0（不画假高度）', rects.length === 7 && rects.every((rect) => rect.props.height === 0), true)
  check('全零区间：不给任何柱子标数值（峰值 0 时不冒充最高柱）', findNodes(tree, 'tpq-usage-value').length, 0)
}

/* 30 秒轮询与 Esc 的 activePanelId 守卫（lead 复审第 7/8 条）：
 * 宿主切页后会保活组件实例，看不见的屏不许发请求、更不许被 Esc 关掉。 */
{
  const bundle = await mountUsage({ activePanelId: 'token-plan-quota.usage' })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  const tick = bundle.intervals.filter((entry) => entry.ms === 30000).at(-1)
  ok('前台时确实登记了 30 秒轮询', tick !== undefined)
  const beforeActive = usageRequests().length
  tick.fn()
  check('本屏在前台：30 秒轮询照常发请求', usageRequests().length, beforeActive + 1)
}
{
  const bundle = await mountUsage({ activePanelId: 'some-other-panel' })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  const tick = bundle.intervals.filter((entry) => entry.ms === 30000).at(-1)
  const beforeAway = usageRequests().length
  tick.fn()
  check('本屏不在前台：轮询不发请求', usageRequests().length, beforeAway)
}

/* §3：徽标小窗底部的「用量统计」入口。usageStats 关掉时不许出现一个点开空屏的按钮。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const renderBadge = () => {
    beginRender()
    return bundle.registered[0].component()
  }
  let tree = await settle(renderBadge, 4)
  findNodes(tree, 'tpq-chip')[0].props.onClick()
  tree = await settle(renderBadge, 3)
  const entry = findNodes(tree, 'tpq-usage-entry')[0]
  ok('小窗底部有「用量统计」入口', entry !== undefined && collectText(entry).join('') === '用量统计',
    JSON.stringify(collectText(tree)).slice(0, 240))
  entry.props.onClick()
  check('点入口跳 main 整页座位（selectPanel(PANEL_ID)）', bundle.layout.calls.at(-1), 'token-plan-quota.usage')
  tree = await settle(renderBadge, 2)
  check('跳转时小窗收起（不留两层浮层）', findNodes(tree, 'tpq-panel').length, 0)
}
{
  const bundle = await mountUsage({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, method: init?.method ?? 'GET' })
      return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, config: { ...SNAPSHOT.config, usageStats: false } }) }
    },
  })
  resetHooks()
  const renderBadge = () => {
    beginRender()
    return bundle.registered[0].component()
  }
  let tree = await settle(renderBadge, 4)
  findNodes(tree, 'tpq-chip')[0].props.onClick()
  tree = await settle(renderBadge, 3)
  check('usageStats=false 时不出现入口按钮', findNodes(tree, 'tpq-usage-entry').length, 0)
}

/* 视觉自检的结构面：窄视口自己滚动、375px 排版、零依赖配色。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('窄视口：图表容器自己横向滚动（不撑破整页）', /\.tpq-usage-scroll\{[^}]*overflow-x:auto/.test(code))
  ok('375px：操作区整行铺开、拆分两列（012 六格偶数，不再需要最后格整行补丁）',
    /@media \(max-width:520px\)\{[\s\S]{0,400}\.tpq-usage-actions\{width:100%;margin-left:0\}/.test(code)
      && /\.tpq-usage-splits\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/.test(code)
      && !/\.tpq-usage-splits \.tpq-usage-split:last-child\{grid-column/.test(code))
  ok('格宽是有限范围（窄视口保读性 / 宽卡片铺满 / 兜底画布宽）',
    /const STEP_MIN = 26/.test(code) && /const STEP_MAX = 120/.test(code)
      && /const BAR_MIN = 8/.test(code) && /const BAR_MAX = 64/.test(code)
      && /const FALLBACK_CHART_W = 820/.test(code))
  ok('3D 三面共用一个主色变量 + 两个明度台阶（零依赖）',
    /--tpq-usage-bar:var\(--dsw-alias-brand-primary/.test(code)
      && /color-mix\(in srgb,var\(--tpq-usage-bar\) 78%,white\)/.test(code)
      && /color-mix\(in srgb,var\(--tpq-usage-bar\) 78%,black\)/.test(code))
}

/* C1~C11 复审补测（lead m00674）。都走假快照 / 假 fetch，不联网。 */

/* C1：切天后新响应还没回来时，标题与数据必须同源（旧实现标题用本地 days、日期用旧快照）。 */
{
  let mode30 = 'pending'
  const pending = []
  const staleFetch = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
    if (days === 30) {
      if (mode30 === 'fail') return { ok: false, status: 503, json: async () => ({ error: 'usage-unavailable' }) }
      return await new Promise((resolve) => { pending.push(resolve) })
    }
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
  }
  const bundle = await mountUsage({ fetchImpl: staleFetch })
  resetHooks()
  const tree7 = await settle(bundle.renderUsage, 4)
  ok('C1 起始：标题与数据都是 7 天', collectText(tree7).join(' ').includes('近 7 天'), collectText(tree7).join(' ').slice(0, 160))
  findNodes(tree7, 'tpq-usage-day').find((node) => collectText(node).join('') === '30').props.onClick()
  const waiting = await settle(bundle.renderUsage, 3)
  const waitText = collectText(waiting).join(' ')
  ok('C1 切天未回包：标题仍按快照说 7 天（不出现「近 30 天」）',
    waitText.includes('近 7 天') && !waitText.includes('近 30 天'), waitText.slice(0, 200))
  const staleCards = findNodes(waiting, 'tpq-usage-card')
  ok('C1 切天未回包：数据区标 stale（半透明降级，不冒充新数据）',
    staleCards.length === 3 && staleCards.every((card) => card.props['data-stale'] === '1'),
    staleCards.map((card) => card.props['data-stale']).join(','))
  mode30 = 'fail'
  for (const resolve of pending) resolve({ ok: false, status: 503, json: async () => ({ error: 'usage-unavailable' }) })
  const failed = await settle(bundle.renderUsage, 3)
  const failText = collectText(failed).join(' ')
  ok('C1 切天失败：错误态独占，不残留旧 7 天总分卡',
    failText.includes('用量数据没取到') && findNodes(failed, 'tpq-usage-card').length === 0, failText.slice(0, 240))
}

/* C2：首屏成功后切天失败——错误行必须把旧图表 / 旧总分卡 / 脚注一起收起。 */
{
  const bundle = await mountUsage({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, method: init?.method ?? 'GET' })
      const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
      if (days === 30) return { ok: false, status: 500, json: async () => ({ error: 'internal-db-detail' }) }
      return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
    },
  })
  resetHooks()
  const okTree = await settle(bundle.renderUsage, 4)
  ok('C2 前置：先有完整数据', findNodes(okTree, 'tpq-usage-card').length === 3)
  findNodes(okTree, 'tpq-usage-day').find((node) => collectText(node).join('') === '30').props.onClick()
  const tree = await settle(bundle.renderUsage, 4)
  const text = collectText(tree).join(' ')
  ok('C2 失败后：错误行独占，旧图表与旧总分卡不再显示',
    text.includes('用量数据没取到') && findNodes(tree, 'tpq-usage-card').length === 0, text.slice(0, 240))
  ok('C2 失败后：脚注与「更新于」一起收起', !text.includes('数据源') && !text.includes('更新于'), text.slice(-200))
  ok('C10 宿主错误详情不上屏（只显示本地化通用句）', !text.includes('internal-db-detail'), text.slice(0, 240))
  ok('C4 错误态有可点的重试按钮', findNodes(tree, 'tpq-usage-retry').length === 1)
}

/* C4：请求永不返回时不能一直停在骨架——本地超时后走错误态 + 重试。 */
{
  const hangFetch = (url, init) => new Promise((resolve, reject) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    if (init?.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const bundle = await mountUsage({ fetchImpl: hangFetch, timeoutMs: 40 })
  resetHooks()
  bundle.renderUsage()
  await new Promise((resolve) => setTimeout(resolve, 120))
  const tree = await settle(bundle.renderUsage, 2)
  const text = collectText(tree).join(' ')
  ok('C4 超时：出现错误态而不是永久骨架',
    text.includes('用量数据没取到') && findNodes(tree, 'tpq-usage-retry').length === 1, text.slice(0, 240))
  ok('C4 超时：不把 AbortError / 宿主原文当文案', !/abort|aborted|AbortError/i.test(text), text.slice(0, 240))
}

/* C5：同值 Enter 后紧跟 blur，不许把同一天数再提交一次（旧实现会多发一条请求）。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  const input = findNodes(tree, 'tpq-usage-days-input')[0]
  const before = usageRequests().length
  input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  const afterEnter = usageRequests().length
  input.props.onBlur()
  ok('C5 同值 Enter + 随后 blur 不重复发请求',
    afterEnter === before && usageRequests().length === afterEnter,
    'before=' + String(before) + ' afterEnter=' + String(afterEnter) + ' afterBlur=' + String(usageRequests().length))
}

/* C7：回填还没结束时不许宣称「这个区间没有记录到用量」。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({
      ...snap,
      emptyReason: 'no-usage',
      coverage: { ...snap.coverage, sessions: 12, indexed: 5 },
    })),
  })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('C7 回填中：不出现「这个区间没有记录到用量」', !text.includes('这个区间没有记录到用量'), text.slice(0, 240))
  ok('C7 回填中：进度条仍解释当前状态', findNodes(tree, 'tpq-usage-progress').length === 1, text.slice(0, 200))
}

/* C8：no-sessions 的引导方向与 no-usage 完全不同，en 也必须本地化。 */
{
  const bundle = await mountUsage({ fetchImpl: usageFetch((snap) => ({ ...snap, buckets: [], models: [], emptyReason: 'no-sessions' })) })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('C8 no-sessions：指向「去建会话」而不是「调模型再来」',
    text.includes('这个实例还没有会话记录') && text.includes('先开始一次对话') && !text.includes('这个区间没有记录到用量'),
    text.slice(0, 260))
}
{
  const bundle = await mountUsage({
    lang: 'en-US',
    fetchImpl: usageFetch((snap) => ({ ...snap, buckets: [], models: [], emptyReason: 'no-sessions' })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('C8 no-sessions（en）：本地化且不混中文',
    !/[\u3400-\u9fff]/u.test(text) && text.includes('no sessions yet'), text.slice(0, 260))
}

/* C11：请求选项 + fiber 依赖声明（删掉 layout 或改掉 cache/credentials 都要红）。 */
{
  let captured = null
  const bundle = await mountUsage({
    fetchImpl: async (url, init) => {
      if (String(url).startsWith('/token-plan-quota/usage')) captured = init
      fetchCalls.push({ url, method: init?.method ?? 'GET' })
      const days = Number(new URL(String(url), 'http://localhost').searchParams.get('days')) || 7
      return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
    },
  })
  resetHooks()
  await settle(bundle.renderUsage, 3)
  ok('C11 请求用 same-origin 凭据 + no-store + GET + 无 body',
    captured !== null && captured.credentials === 'same-origin' && captured.cache === 'no-store'
      && captured.body === undefined && (captured.method ?? 'GET') === 'GET',
    JSON.stringify({ credentials: captured?.credentials, cache: captured?.cache, body: captured?.body, method: captured?.method }))
  check('C11 client 把 slots / sessions / modelDirectories / layout 声明成 fiber 依赖', bundle.api.inject,
    ['slots', 'sessions', 'modelDirectories', 'layout'])
}

/* ============================================================ 自定义起止日期（spec 007，INTERFACE §3）
 * 契约要点：查询状态存进既存 singleton store（rangeMode/from/to）、预设之后多一个「自定义」
 * chip、日期行本地校验不通过就零请求、请求走 ?from=&to=（不带 days/range）、
 * 标题全部取自 snapshot.range、400 两个错误码各有本地文案。
 * 假 React 每次渲染都会重跑 effect（所以每帧都会重发当前查询），因此「零请求」的断言
 * 一律在**触发点击后立刻**取计数，并且另外按 URL 过滤，不被下一帧的正常重发干扰。
 */

/** 自定义区间的假路由：from/to 回一份 range.kind="custom" 的快照（形状照 INTERFACE §2）。 */
function usageCustomFetch(options = {}) {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    const from = parsed.searchParams.get('from')
    const to = parsed.searchParams.get('to')
    // 008：官方路由走同一组 from/to，但回官方形状；handler 只用来控制本机侧回包。
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      const spanDays = Number(parsed.searchParams.get('days')) || 7
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(spanDays) }
    }
    if (options.handler) {
      const handled = options.handler({ from, to, parsed })
      if (handled !== undefined) return handled
    }
    const days = Number(parsed.searchParams.get('days')) || 7
    if (from === null || to === null) {
      return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
    }
    const span = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000) + 1
    const safe = Number.isFinite(span) && span > 0 ? span : 1
    return {
      ok: true,
      status: 200,
      json: async () => {
        const snap = makeUsageSnapshot(Math.min(safe, 365))
        snap.range = { kind: 'custom', days: safe, from, to }
        return snap
      },
    }
  }
}

/** 取「自定义」chip（预设之后那一个）。 */
function customChipOf(tree) {
  return findNodes(tree, 'tpq-usage-day').find((node) => node.props?.['data-usage-preset'] === 'custom')
}

/** 取某一侧的日期输入（data-usage-from / data-usage-to）。 */
function dateInputOf(tree, field) {
  return findNodes(tree, 'tpq-usage-date').find((node) => node.props?.['data-usage-' + field] === '1')
}

function applyButtonOf(tree) {
  return findNodes(tree, 'tpq-usage-apply')[0]
}

function rangeErrorTextOf(tree) {
  const node = findNodes(tree, 'tpq-usage-range-error')[0]
  return node === undefined ? null : collectText(node).join('')
}

/** 打开自定义行并让预填进入 state（一次渲染足够：onClick 里直接 set 了 draft/range）。 */
function openCustom(bundle) {
  const chip = customChipOf(bundle.renderUsage())
  ok('自定义 chip 存在且文案取自 COPY', chip !== undefined && collectText(chip).join('') === '自定义')
  chip.props.onClick()
  return bundle.renderUsage()
}

/* T004：静态门禁——钩子、i18n、无百分比 / Credits（与 test/guards.mjs 的客户端矩阵同口径）。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const hooks = [
    '"data-usage-preset": "custom"',
    '"data-usage-custom": "1"',
    '"data-usage-from": field === "from" ? "1" : undefined',
    '"data-usage-to": field === "to" ? "1" : undefined',
    '"data-usage-apply": "1"',
    '"data-usage-range-error": "1"',
    'role: "alert"',
  ]
  for (const hook of hooks) ok('T004 源码带钩子 ' + hook, code.includes(hook))

  const zhBlock = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(code)
  const enBlock = /\n      en: \{([\s\S]*?)\n      \},/.exec(code)
  const keysOf = (text) => [...text.matchAll(/^ {8}([A-Za-z]\w*):/gm)].map((match) => match[1])
  const zhKeys = keysOf(zhBlock?.[1] ?? '')
  const enKeys = keysOf(enBlock?.[1] ?? '')
  const rangeKeys = ['usageRangeCustom', 'usageRangeFrom', 'usageRangeTo', 'usageRangeApply',
    'usageRangeBad', 'usageRangeTooLong', 'usageRangeDayOne', 'usageRangeLocalOnly']
  ok('T004 zh 有 §3.3 的八个键', rangeKeys.every((key) => zhKeys.includes(key)), zhKeys.join(','))
  ok('T004 en 有 §3.3 的八个键', rangeKeys.every((key) => enKeys.includes(key)), enKeys.join(','))
  check('T004 zh / en 键集合完全一致', zhKeys.length, enKeys.length)

  const screenStart = code.indexOf('function UsageScreen')
  ok('T004 能定位到 UsageScreen 区域', screenStart > 0)
  const region = code.slice(screenStart)
  // 012：百分比只许在白名单段里拼（那些函数在 UsageScreen 之前），UsageScreen 自身若出现 % 字面量，
  // 说明有人绕开白名单硬编码了比例。注释里提到 0% / <0.1% 不算渲染路径，先剥注释再判。
  const regionCode = region.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('T004 客户端用量面不出现百分比字面量（比例只在白名单段拼）', regionCode.includes('%') === false,
    (regionCode.match(/.{0,20}%.{0,20}/g) ?? []).join(' | '))
  // 014：Credits 换算块合法引入 credits* 标识符、USAGE_CREDITS 常量与 credits-* 错误码；
  // 画面文案仍只许来自 COPY —— 所以这里改成只在「字符串字面量」层面判（比逐行判更准）。
  const creditLiterals = regionCode.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g) ?? []
  const creditLiteralOffenders = creditLiterals.filter((literal) => /credit/i.test(literal)
    && !/^["'`]credits-[a-z-]+["'`]$/.test(literal))
  ok('T004 代码里没有直接写死的 Credits 画面文案（文案一律走 COPY）',
    creditLiteralOffenders.length === 0, creditLiteralOffenders.join(' | '))
}

/* T005 ①：chip → 日期行展开、预填当前快照区间、按 from/to 请求（不带 days）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageCustomFetch() })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  check('T005 默认不展开日期行', findNodes(tree, 'tpq-usage-custom').length, 0)
  const snapshot = makeUsageSnapshot(7)

  tree = openCustom(bundle)
  check('T005 点自定义展开一行日期控件', findNodes(tree, 'tpq-usage-custom').length, 1)
  check('T005 预填快照的 from', dateInputOf(tree, 'from').props.value, snapshot.range.from)
  check('T005 预填快照的 to', dateInputOf(tree, 'to').props.value, snapshot.range.to)
  check('T005 chip 进入按下态', customChipOf(tree).props['data-active'], '1')
  check('T005 切自定义立刻按预填区间请求',
    usageRequests().at(-1)?.url, '/token-plan-quota/usage?from=' + snapshot.range.from + '&to=' + snapshot.range.to)
  ok('T005 自定义请求不带 days / range 参数',
    !String(usageRequests().at(-1)?.url ?? '').includes('days=') && !String(usageRequests().at(-1)?.url ?? '').includes('range='))
  ok('T005 自定义快照：脚注点明只统计本机',
    collectText(await settle(bundle.renderUsage, 2)).join(' ').includes('仅统计本机 DSH 发出的调用'))

  const preset7 = findNodes(tree, 'tpq-usage-day').find((node) => node.props?.['data-usage-preset'] !== 'custom'
    && collectText(node).join('') === '今日')
  ok('T005 有「今日」预设可回退', preset7 !== undefined)
  preset7.props.onClick()
  tree = await settle(bundle.renderUsage, 2)
  check('T005 点预设收回日期行', findNodes(tree, 'tpq-usage-custom').length, 0)
  check('T005 点预设回到天数模式', customChipOf(tree).props['data-active'], '0')
  check('T005 点预设后按天数请求', usageRequests().at(-1)?.url, '/token-plan-quota/usage?days=1')
}

/* T005 ②：本地校验不通过 → 零请求 + 行内提示（SC-004）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageCustomFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openCustom(bundle)
  const today = bundle.api.__internals.usageTodayKey()
  const shift = bundle.api.__internals.usageShiftDay
  const cases = [
    ['空值', '', '', '起止日期不合法'],
    ['格式不合法', '2026-9-1', '2026-09-10', '起止日期不合法'],
    ['起止颠倒', '2026-09-10', '2026-09-01', '起止日期不合法'],
    ['开始日期在未来', shift(today, 1), shift(today, 2), '起止日期不合法'],
    ['跨度超上限', shift(today, -400), today, '最多查 365 天'],
  ]
  for (const [name, from, to, expected] of cases) {
    tree = bundle.renderUsage()
    dateInputOf(tree, 'from').props.onChange({ target: { value: from } })
    dateInputOf(tree, 'to').props.onChange({ target: { value: to } })
    // 让 onChange 进入 state（闭包拿到新草稿），同时这一帧会重发「当前查询」——所以计数紧贴点击取。
    tree = bundle.renderUsage()
    const before = usageRequests().length
    applyButtonOf(tree).props.onClick()
    check('T005 非法输入（' + name + '）点击查询零请求', usageRequests().length, before)
    tree = bundle.renderUsage()
    check('T005 非法输入（' + name + '）行内提示', rangeErrorTextOf(tree), expected)
  }
  tree = bundle.renderUsage()
  ok('T005 行内提示挂在 role=alert 上（读屏可达）',
    findNodes(tree, 'tpq-usage-range-error')[0].props.role === 'alert')
}

/* T005 ③：合法区间 → 请求带 from/to；标题按 snapshot.range 出单日 / 多天文案。 */
{
  const bundle = await mountUsage({ fetchImpl: usageCustomFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openCustom(bundle)
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-01' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-30' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T005 合法区间按 from/to 请求', usageRequests().at(-1)?.url, '/token-plan-quota/usage?from=2026-09-01&to=2026-09-30')
  ok('T005 多天自定义标题', collectText(tree).join(' ').includes('2026-09-01 至 2026-09-30 · 30 天'),
    collectText(tree).join(' ').slice(0, 160))
  check('T005 数据与查询一致时不标 stale',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])

  // 单日：from===to
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-15' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-15' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  ok('T005 单日自定义标题', collectText(tree).join(' ').includes('2026-09-15 当天'), collectText(tree).join(' ').slice(0, 160))
  check('T005 单日请求 end=start', usageRequests().at(-1)?.url, '/token-plan-quota/usage?from=2026-09-15&to=2026-09-15')
}

/* T005 ④：stale 条件含 from/to——换了区间但新数据还没到时，三张卡降级。 */
{
  const bundle = await mountUsage({ fetchImpl: usageCustomFetch() })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  tree = openCustom(bundle)
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-01' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-30' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T005 stale 前：数据已经对齐当前区间',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])

  // 只改查询、不等回包：这一帧的快照仍是旧区间，卡片必须降级。
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-05' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-10' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = bundle.renderUsage()
  check('T005 换了区间、数据没到时标 stale',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['1', '1', '1'])
  tree = await settle(bundle.renderUsage, 4)
  check('T005 新数据到了之后 stale 落回 0',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])
}

/* T005 ⑤：宿主 400 的两种错误码 → 本地文案 + 重试（不回显宿主原文）。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageCustomFetch({
      handler: ({ from }) => (from === null ? undefined
        : { ok: false, status: 400, json: async () => ({ error: 'usage-bad-range', message: 'from must be <= to' }) }),
    }),
  })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openCustom(bundle)
  tree = await settle(bundle.renderUsage, 3)
  const text = collectText(tree).join(' ')
  ok('T005 400 usage-bad-range 用本地文案', text.includes('起止日期不合法') && !text.includes('from must be'), text.slice(0, 240))
  ok('T005 400 错误态带重试按钮', findNodes(tree, 'tpq-usage-retry').length === 1)
}
{
  const bundle = await mountUsage({
    fetchImpl: usageCustomFetch({
      handler: ({ from }) => (from === null ? undefined
        : { ok: false, status: 400, json: async () => ({ error: 'usage-range-too-long', maxDays: 30 }) }),
    }),
  })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openCustom(bundle)
  tree = await settle(bundle.renderUsage, 3)
  const text = collectText(tree).join(' ')
  ok('T005 400 usage-range-too-long 报到宿主真上限（30）', text.includes('最多查 30 天'), text.slice(0, 240))
  const before = usageRequests().length
  findNodes(tree, 'tpq-usage-retry')[0].props.onClick()
  ok('T005 错误态重试会重发同一条自定义查询', usageRequests().length > before)
}

/* T005 ⑥：英文界面走英文文案，不混中文（i18n 8 键的 en 侧真的被用上）。 */
{
  const bundle = await mountUsage({ lang: 'en-US', fetchImpl: usageCustomFetch() })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  const chip = customChipOf(tree)
  check('T005 en：自定义 chip 文案', collectText(chip).join(''), 'Custom')
  chip.props.onClick()
  tree = bundle.renderUsage()
  ok('T005 en：日期行标签是英文', collectText(findNodes(tree, 'tpq-usage-custom')[0]).join(' ').includes('From'))
  check('T005 en：查询按钮文案', collectText(applyButtonOf(tree)).join(''), 'Apply')

  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-01' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-30' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  const text = collectText(tree).join(' ')
  ok('T005 en：多天标题是英文', text.includes('2026-09-01 to 2026-09-30 · 30 days'), text.slice(0, 240))
  ok('T005 en：整屏不混中文', !/[\u3400-\u9fff]/u.test(text), text.slice(0, 240))
  ok('T005 en：脚注点明只统计本机',
    text.includes('Only calls made by this DSH instance are counted'), text.slice(0, 300))
}

/* T005 ⑦：来源不是本机会话索引时，不许冒充「只统计本机」（脚注跟随来源）。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, source: { ...snap.source, kind: 'in-process' } })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 4)).join(' ')
  ok('T005 source=in-process 时不出现「仅统计本机」',
    !text.includes('仅统计本机 DSH 发出的调用'), text.slice(0, 240))
}

/* T005 ⑧：store 记住查询模式（重开屏恢复），且与 006 的 2D/3D 视图字段互不覆盖。 */
{
  const bundle = await mountUsage({ fetchImpl: usageCustomFetch() })
  const store = bundle.handle
  store.setRange({ rangeMode: 'custom', from: '2026-09-01', to: '2026-09-30' })
  check('T005 store 记住查询模式与起止',
    [store.create().getSnapshot().rangeMode, store.create().getSnapshot().from, store.create().getSnapshot().to],
    ['custom', '2026-09-01', '2026-09-30'])
  store.setMode('3d')
  check('T005 切 3D 不会污染查询模式', store.create().getSnapshot().rangeMode, 'custom')
  store.setRange({ rangeMode: 'days', from: '', to: '' })
  check('T005 回天数模式时清空起止',
    [store.create().getSnapshot().rangeMode, store.create().getSnapshot().from], ['days', ''])
}


/* ======================================================== T006（spec 008）官方账号侧对照条 */

/** 数字是否出现在画面上（错误态「零数字」断言；不依赖正则转义）。 */
function hasDigit(text) {
  return String(text).split('').some((ch) => ch >= '0' && ch <= '9')
}

/** 从渲染树里取官方对照 section。 */
function officialSectionOf(tree) {
  return findNodes(tree, 'tpq-usage-official')[0]
}

/** 取官方三格里某一格的数字文本（official / local / gap）。 */
function officialCellTextOf(tree, which) {
  const cell = findNodes(tree, 'tpq-usage-official-' + which)[0]
  if (cell === undefined) return null
  const value = findNodes(cell, 'tpq-usage-official-value')[0]
  return value === undefined ? null : collectText(value).join('')
}

/** 官方侧回包由本函数指定，本机侧仍回 makeUsageSnapshot（mutate 只管本机）。 */
function officialFetchOf(bodyOrFactory) {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      return { ok: true, status: 200, json: async () => (typeof bodyOrFactory === 'function' ? bodyOrFactory(parsed) : bodyOrFactory) }
    }
    const days = Number(parsed.searchParams.get('days')) || 7
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
  }
}

/* T006 ①：静态契约 —— 路由常量、10 个官方文案键双语齐备、禁 % 与 Credits、375px 折行。 */
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T006 官方路由常量与 INTERFACE §3 一致（/token-plan-quota/usage-official）',
    source.includes('const USAGE_OFFICIAL = "/token-plan-quota/usage-official"'))
  const zhBlock = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(source)?.[1] ?? ''
  const enBlock = /\n      en: \{([\s\S]*?)\n      \},/.exec(source)?.[1] ?? ''
  // 逐行取值（不拼动态正则：转义层数一多，测试本身就先错了）。
  const copyEntriesOf = (block) => block.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    const colon = trimmed.indexOf(': "')
    if (colon <= 0) return []
    const rest = trimmed.slice(colon + 3)
    const end = rest.lastIndexOf('"')
    if (end < 0) return []
    return [{ key: trimmed.slice(0, colon), value: rest.slice(0, end) }]
  })
  const zhEntries = copyEntriesOf(zhBlock)
  const enEntries = copyEntriesOf(enBlock)
  const officialOf = (entries) => entries.filter((entry) => entry.key.startsWith('usageOfficial'))
  const zhOfficial = officialOf(zhEntries)
  const enOfficial = officialOf(enEntries)
  check('T006 官方文案 zh / en 各 10 键（8 契约键 + 格标签 + 夹紧说明）',
    [zhOfficial.length, enOfficial.length], [10, 10])
  const contractKeys = ['usageOfficialTitle', 'usageOfficialLocal', 'usageOfficialGap', 'usageOfficialLoading',
    'usageOfficialError', 'usageOfficialRetry', 'usageOfficialNote', 'usageOfficialEmpty']
  const zhKeys = zhOfficial.map((entry) => entry.key)
  const enKeys = enOfficial.map((entry) => entry.key)
  ok('T006 INTERFACE §3.3 的 8 个键 zh / en 一个不少',
    contractKeys.every((key) => zhKeys.includes(key) && enKeys.includes(key)), zhKeys.join(','))
  const zhCopy = zhOfficial.map((entry) => entry.value).join(' ')
  const enCopy = enOfficial.map((entry) => entry.value).join(' ')
  ok('T006 zh 官方文案不含 % 与 Credits', !zhCopy.includes('%') && !zhCopy.includes('Credits'), zhCopy)
  ok('T006 en 官方文案不含 % 与 Credits、也不混中文',
    !enCopy.includes('%') && !enCopy.includes('Credits') && !/[\u3400-\u9fff]/u.test(enCopy), enCopy)
  const zhNote = zhOfficial.find((entry) => entry.key === 'usageOfficialNote')?.value ?? ''
  const enNote = enOfficial.find((entry) => entry.key === 'usageOfficialNote')?.value ?? ''
  ok('T006 中文脚注写明含其他设备 / Token 口径 / 输入侧已含缓存且不相加',
    zhNote.includes('其他设备') && zhNote.includes('Token') && zhNote.includes('缓存') && zhNote.includes('不相加'), zhNote)
  ok('T006 英文脚注写明 cacheRead 已在 input 内、不相加',
    enNote.includes('cache reads') && enNote.includes('input') && enNote.includes('do not add'), enNote)
  const narrowCss = source.slice(source.indexOf('@media (max-width:520px){'))
  ok('T006 375px：官方三格折两行、差额整行（不横向溢出）',
    narrowCss.includes('.tpq-usage-official-grid{grid-template-columns:repeat(2,minmax(0,1fr))}')
    && narrowCss.includes('.tpq-usage-official-gap{grid-column:1/-1}'))
  ok('T006 宽屏三格自适应（auto-fit），数字可换行不撑破卡片',
    source.includes('.tpq-usage-official-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr))')
    && source.includes('.tpq-usage-official-value{font-size:18px') && source.includes('overflow-wrap:anywhere}'))
}

/* T006 ②：__internals 的纯函数 —— 请求串唯一构造、ready 只看参数 key、差额符号。 */
{
  const bundle = await mountUsage()
  const internals = bundle.api.__internals
  ok('T006 __internals 暴露官方查询 / 判定 / 差额的纯函数',
    ['usageQueryPath', 'officialQueryKeyOf', 'officialPayloadState', 'officialIsEmpty', 'officialGapText', 'usageOfficialSection']
      .every((key) => typeof internals[key] === 'function'))
  check('T006 官方与本机共用同一个请求串构造函数',
    [internals.usageQueryPath({ mode: 'days', days: 7 }),
      internals.usageQueryPath({ mode: 'custom', from: '2026-09-01', to: '2026-09-30' })],
    ['?days=7', '?from=2026-09-01&to=2026-09-30'])
  check('T006 非法自定义区间 → 零请求（null）',
    internals.usageQueryPath({ mode: 'custom', from: '2026-09-30', to: '2026-09-01' }), null)
  check('T006 天数照旧走 clampDays（0 被夹到 1）', internals.usageQueryPath({ mode: 'days', days: 0 }), '?days=1')
  check('T006 查询 key 只由请求参数决定（不掺响应内容）',
    [internals.officialQueryKeyOf({ mode: 'days', days: 7 }),
      internals.officialQueryKeyOf({ mode: 'days', days: 7.4 }),
      internals.officialQueryKeyOf({ mode: 'custom', from: '2026-09-01', to: '2026-09-30' }),
      internals.officialQueryKeyOf({ mode: 'custom', from: 'bad', to: 'bad' }),
      internals.officialQueryKeyOf(null)],
    ['days:7', 'days:7', 'custom:2026-09-01:2026-09-30', null, null])
  const ready = internals.officialPayloadState(makeOfficialSnapshot(7))
  check('T006 成功体判为 ready', [ready.kind, ready.code], ['ready', ''])
  const failed = internals.officialPayloadState({ error: 'official-unavailable', code: 'official-disabled', hint: '去控制台开一下' })
  check('T006 失败体保留 code / hint（code 不上屏、hint 可展示）',
    [failed.kind, failed.code, failed.hint], ['error', 'official-disabled', '去控制台开一下'])
  check('T006 形状不对判 official-bad-response（绝不当成 0 用量）',
    internals.officialPayloadState({ totals: {}, buckets: null }).code, 'official-bad-response')
  ok('T006 只有全 0 才算「官方也没用量」',
    internals.officialIsEmpty({ totals: { tokens: 0 }, buckets: [{ tokens: 0 }] }) === true
    && internals.officialIsEmpty(makeOfficialSnapshot(7)) === false)
  ok('T006 totals 为 0 但桶里有量 → 不算空（不拿 0 冒充）',
    internals.officialIsEmpty({ totals: { tokens: 0 }, buckets: [{ tokens: 5 }] }) === false)
  check('T006 差额：正数带 +、负数带 -、0 写 0、缺数据不瞎算',
    [internals.officialGapText(2100000000, 1000000), internals.officialGapText(500000, 1000000),
      internals.officialGapText(1000000, 1000000), internals.officialGapText(undefined, 5)],
    ['+2099000000', '-500000', '0', '-5'])
}

/* T006 ③：就绪态三格与拆分严格同源，脚注与请求次数也在这里钉住。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const section = officialSectionOf(tree)
  ok('T006 柱状图卡片之后渲染官方对照条（data-usage-official）',
    section !== undefined && section.props['data-usage-official'] === '1')
  check('T006 官方对照条是独立 section，不共用 .tpq-usage-card（既有 3 卡计数不被污染）',
    section?.props.className, 'tpq-usage-official')
  check('T006 就绪态不是 stale', section?.props['data-stale'], '0')
  check('T006 标题取自 COPY', collectText(findNodes(section, 'tpq-usage-official-title')[0]).join(''), '官方账号侧用量对照')
  check('T006 三格与两边 totals.tokens 严格同源（官方 2.1e9 / 本机 1e6）',
    [officialCellTextOf(tree, 'official'), officialCellTextOf(tree, 'local')], ['2100000000', '1000000'])
  check('T006 差额 = 官方 − 本机（正号必显）',
    [officialCellTextOf(tree, 'gap'), findNodes(tree, 'tpq-usage-official-gap')[0].props['data-sign']],
    ['+2099000000', 'pos'])
  // 012：中文界面标签中文化（顺序沿用官方 payload 的 input / cacheRead / output）。
  check('T006 官方四项拆分同源且不与 tokens 相加',
    collectText(findNodes(tree, 'tpq-usage-official-split')[0]).join(''),
    '输入 1260000000 · 缓存命中 1134000000 · 输出 840000000')
  const note = collectText(findNodes(tree, 'tpq-usage-official-note')[0]).join('')
  ok('T006 脚注点明口径差异（其他设备 + 不相加）',
    note.includes('其他设备') && note.includes('不相加') && note.includes('本机会话记录'), note)
  ok('T006 就绪态不残留 loading / empty 文案',
    findNodes(tree, 'tpq-usage-official-loading').length === 0
    && findNodes(tree, 'tpq-usage-official-empty').length === 0)
  check('T006 同一查询只打一次官方（重复渲染 / 轮询不重复回源）',
    officialRequests().filter((entry) => entry.url === '/token-plan-quota/usage-official?days=7').length, 1)
  check('T006 官方接入不改既有结构（本机三张卡照旧）', findNodes(tree, 'tpq-usage-card').length, 3)
}

/* T006 ④：差额负数与零 —— 同一个函数，三种符号。 */
{
  const negative = { ...makeOfficialSnapshot(7), totals: { tokens: 500000, input: 400000, cacheRead: 0, output: 100000 } }
  const bundle = await mountUsage({ fetchImpl: officialFetchOf(negative) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  check('T006 负差额（官方低于本机）带负号',
    [officialCellTextOf(tree, 'gap'), findNodes(tree, 'tpq-usage-official-gap')[0].props['data-sign']],
    ['-500000', 'neg'])
  ok('T006 负差额时两格照旧各自取值（不是把差额当绝对值）',
    officialCellTextOf(tree, 'official') === '500000' && officialCellTextOf(tree, 'local') === '1000000')
}
{
  const equal = { ...makeOfficialSnapshot(7), totals: { tokens: 1000000, input: 700000, cacheRead: 0, output: 300000 } }
  const bundle = await mountUsage({ fetchImpl: officialFetchOf(equal) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  check('T006 零差额写 0（不带正负号）',
    [officialCellTextOf(tree, 'gap'), findNodes(tree, 'tpq-usage-official-gap')[0].props['data-sign']], ['0', 'zero'])
}

/* T006 ⑤：官方全 0 → 空文案，且不出现任何 0 的对照数字。 */
{
  const empty = {
    ...makeOfficialSnapshot(7),
    totals: { tokens: 0, input: 0, cacheRead: 0, output: 0 },
    buckets: [{ from: '2026-11-13', to: '2026-11-14', tokens: 0, input: 0, cacheRead: 0, output: 0 }],
  }
  const bundle = await mountUsage({ fetchImpl: officialFetchOf(empty) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const section = officialSectionOf(tree)
  const text = collectText(section).join(' ')
  ok('T006 官方空区间显示空文案', findNodes(tree, 'tpq-usage-official-empty').length === 1 && text.includes('官方账号侧这段时间也没有用量记录'))
  check('T006 空态不渲染三格', findNodes(tree, 'tpq-usage-official-grid').length, 0)
  ok('T006 空态不出现任何数字（不拿 0 冒充对照）', !hasDigit(text), text)
}

/* T006 ⑥：错误态零数字、不显示 code 原文、重试带 fresh=1 且不污染本机三卡。 */
{
  let officialHits = 0
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      officialHits += 1
      if (officialHits === 1) {
        return { ok: true, status: 200, json: async () => ({ error: 'official-unavailable', code: 'official-disabled', hint: '去 Token Plan 控制台开启用量统计后重试。' }) }
      }
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(7) }
    }
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(Number(parsed.searchParams.get('days')) || 7) }
  }
  const bundle = await mountUsage({ fetchImpl })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 8)
  const section = officialSectionOf(tree)
  const text = collectText(section).join(' ')
  const errorNode = findNodes(tree, 'tpq-usage-official-error')[0]
  ok('T006 错误态一行 role=status 的说明', errorNode !== undefined && errorNode.props.role === 'status')
  ok('T006 错误态用 COPY 文案 + 宿主中文 hint', text.includes('官方账号侧用量没取到') && text.includes('去 Token Plan 控制台开启用量统计后重试'), text)
  ok('T006 错误态零数字（连 0 都不许出现）', !hasDigit(text), text)
  ok('T006 错误态不回显 code 原文', !text.includes('official-disabled') && !text.includes('official-unavailable'), text)
  check('T006 错误态只有一个重试按钮', findNodes(tree, 'tpq-usage-official-retry').length, 1)
  check('T006 错误态不渲染三格', findNodes(tree, 'tpq-usage-official-grid').length, 0)
  ok('T006 官方失败不污染本机屏（三张卡与区间总数照旧）',
    findNodes(tree, 'tpq-usage-card').length === 3 && findNodes(tree, 'tpq-usage-value').length === 1)
  const localBefore = usageRequests().length
  findNodes(tree, 'tpq-usage-official-retry')[0].props.onClick()
  check('T006 官方重试带 fresh=1（强制回源）',
    officialRequests().at(-1)?.url, '/token-plan-quota/usage-official?days=7&fresh=1')
  check('T006 官方重试不重打本机路由', usageRequests().length, localBefore)
  tree = await settle(bundle.renderUsage, 8)
  ok('T006 重试成功后换成三格、错误消失',
    findNodes(tree, 'tpq-usage-official-official').length === 1
    && findNodes(tree, 'tpq-usage-official-error').length === 0
    && officialCellTextOf(tree, 'official') === '2100000000')
}

/* T006 ⑦：loading —— 官方还没回来时只出「正在读取」，不先摆 0。 */
{
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      await gate
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(7) }
    }
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(Number(parsed.searchParams.get('days')) || 7) }
  }
  const bundle = await mountUsage({ fetchImpl, timeoutMs: 5000 })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  ok('T006 loading：官方未回包时出 COPY 的读取文案',
    findNodes(tree, 'tpq-usage-official-loading').length === 1
    && collectText(findNodes(tree, 'tpq-usage-official-loading')[0]).join('') === '正在读取官方账号侧用量…')
  check('T006 loading：不渲染三格（不先摆 0）', findNodes(tree, 'tpq-usage-official-grid').length, 0)
  ok('T006 loading 期间本机三卡照旧可用', findNodes(tree, 'tpq-usage-card').length === 3)
  release()
  tree = await settle(bundle.renderUsage, 8)
  ok('T006 官方回包后替换成三格', findNodes(tree, 'tpq-usage-official-official').length === 1
    && officialCellTextOf(tree, 'official') === '2100000000')
}

/* T006 ⑧：切天数 —— 立刻 stale 且不展示上一区间数字，新请求换成 days=30。 */
{
  const bundle = await mountUsage()
  resetHooks()
  let tree = await settle(bundle.renderUsage, 8)
  const thirty = findNodes(tree, 'tpq-usage-day').find((node) => collectText(node).join('') === '30')
  thirty.props.onClick()
  tree = bundle.renderUsage()
  check('T006 切天数后官方块立刻 stale 并退回 loading（不显示上一区间数字）',
    [officialSectionOf(tree).props['data-stale'], findNodes(tree, 'tpq-usage-official-official').length], ['1', 0])
  tree = await settle(bundle.renderUsage, 8)
  check('T006 切 30 天后官方请求换成 days=30（常规取数不带 fresh）',
    officialRequests().at(-1)?.url, '/token-plan-quota/usage-official?days=30')
  check('T006 30 天的官方三格跟着换区间', [officialCellTextOf(tree, 'official'), officialCellTextOf(tree, 'gap')],
    ['9000000000', '+8999000000'])
}

/* T006 ⑨：自定义区间 —— 官方与本机参数一字不差（共用 usageQueryPath）。 */
{
  const bundle = await mountUsage()
  resetHooks()
  await settle(bundle.renderUsage, 8)
  let tree = openCustom(bundle)
  tree = await settle(bundle.renderUsage, 2)
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-09-01' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-09-30' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 8)
  check('T006 自定义区间：官方与本机请求参数一字不差',
    [officialRequests().at(-1)?.url, usageRequests().at(-1)?.url],
    ['/token-plan-quota/usage-official?from=2026-09-01&to=2026-09-30',
      '/token-plan-quota/usage?from=2026-09-01&to=2026-09-30'])
}

/* T006 ⑩：clampedFrom —— 官方把起点夹紧时仍然 ready，文案写「被夹掉的原始起点」。 */
{
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ...makeOfficialSnapshot(7),
          range: { kind: 'custom', from: '2026-06-01', to: '2026-11-13' },
          totals: { tokens: 500000000, input: 300000000, cacheRead: 0, output: 200000000 },
          coverage: { api: 'console-gateway', chunks: 6, step: 'day', cached: false, totalDerived: true, clampedFrom: '2026-01-01' },
        }),
      }
    }
    const from = parsed.searchParams.get('from')
    const to = parsed.searchParams.get('to')
    const base = makeUsageSnapshot(7)
    if (from === null || to === null) return { ok: true, status: 200, json: async () => base }
    return { ok: true, status: 200, json: async () => ({ ...base, range: { kind: 'custom', days: 317, from, to } }) }
  }
  const bundle = await mountUsage({ fetchImpl })
  resetHooks()
  let tree = openCustom(bundle)
  tree = await settle(bundle.renderUsage, 2)
  dateInputOf(tree, 'from').props.onChange({ target: { value: '2026-01-01' } })
  dateInputOf(tree, 'to').props.onChange({ target: { value: '2026-11-13' } })
  tree = bundle.renderUsage()
  applyButtonOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 10)
  const section = officialSectionOf(tree)
  check('T006 官方夹紧起点时仍判 ready（ready 只看请求参数，不比响应 range.from）',
    section?.props['data-stale'], '0')
  const clamped = findNodes(tree, 'tpq-usage-official-clamped')[0]
  ok('T006 夹紧说明写「你查的原始起点」而不是夹紧后的值',
    clamped !== undefined && collectText(clamped).join('') === '你查的 2026-01-01 起，官方最早只到 2026-06-01 起。',
    clamped === undefined ? 'clamped 节点不存在' : collectText(clamped).join(''))
  check('T006 夹紧不影响三格取值', officialCellTextOf(tree, 'official'), '500000000')
}

/* T006 ⑪：英文界面 —— 官方块的 en 文案真的用上，中文 hint 不上屏。 */
{
  const bundle = await mountUsage({ lang: 'en-US', fetchImpl: officialFetchOf({ error: 'official-unavailable', code: 'official-disabled', hint: '去控制台开启用量统计' }) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const text = collectText(tree).join(' ')
  ok('T006 en 错误态文案是英文', text.includes('Could not load official account usage') && text.includes('Retry official query'), text.slice(0, 300))
  ok('T006 en 不展示中文 hint（宿主提示只给中文界面）', !text.includes('去控制台开启用量统计'), text.slice(0, 300))
  ok('T006 en 整屏没有中文字符', !/[\u3400-\u9fff]/u.test(text), text.slice(0, 300))
}


/* ============================================================ T009：兜底扫描脚注（FR-008） */

/** 本机快照带上 coverage 的兜底扫描四键（官方分支仍走 usageFetch 的正常形状）。 */
function rescuedFetch(n) {
  return usageFetch((snapshot) => ({
    ...snapshot,
    coverage: { ...snapshot.coverage, scanned: 219, rescued: n, scanFailed: 0, scanDeferred: 0 },
  }))
}

/* T009 ①：静态门禁 —— 钩子、双语键、文案原句（与 T004 同口径：禁 % / Credits）。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T009 源码渲染 data-usage-rescued 钩子（原始数量进属性）', code.includes('"data-usage-rescued": String(rescued)'))
  ok('T009 只有 rescued > 0 才追加这一行', code.includes('if (rescued > 0) {'))
  check('T009 COPY 的 usageScanRescued 在 zh / en 各一处', (code.match(/usageScanRescued:/g) ?? []).length, 2)

  const zhBlock = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(code)
  const enBlock = /\n      en: \{([\s\S]*?)\n      \},/.exec(code)
  const zhLine = /usageScanRescued: "([^"]*)"/.exec(zhBlock?.[1] ?? '')?.[1]
  const enLine = /usageScanRescued: "([^"]*)"/.exec(enBlock?.[1] ?? '')?.[1]
  check('T009 zh 文案是 INTERFACE §3 的原句',
    zhLine, '另有 {n} 个会话不在宿主的会话列表里，已按日志目录补扫。')
  check('T009 en 文案是 INTERFACE §3 的原句',
    enLine, '{n} more session(s) were not in the host list and were recovered from the log directory.')
  ok('T009 双语文案都不带百分比', !String(zhLine).includes('%') && !String(enLine).includes('%'))
  ok('T009 双语文案都不提 Credits', !/credit/i.test(String(zhLine)) && !/credit/i.test(String(enLine)))
}

/* T009 ②：rescued > 0 —— 脚注多一行，数字与钩子对得上，既有「仅统计本机」不被挤掉。 */
{
  const bundle = await mountUsage({ fetchImpl: rescuedFetch(2) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const notes = findNodes(tree, 'tpq-usage-notes')
  check('T009 脚注块仍然只有一块', notes.length, 1)
  const rescuedNodes = nodesWithProp(tree, 'data-usage-rescued')
  check('T009 rescued>0 时脚注恰好多一行', rescuedNodes.length, 1)
  check('T009 钩子带原始会话数（不是格式化后的串）', rescuedNodes[0]?.props?.['data-usage-rescued'], '2')
  check('T009 中文文案按 INTERFACE §3 渲染', collectText(rescuedNodes[0]).join(''),
    '另有 2 个会话不在宿主的会话列表里，已按日志目录补扫。')
  ok('T009 新行落在同一块脚注里（官方对照条下方、来源声明旁边）',
    notes[0] !== undefined && nodesWithProp(notes[0], 'data-usage-rescued').length === 1)
  // 既有 5 行 + rescued 1 行 + 012 比例口径 1 行 = 7。
  check('T009 有 rescued 时脚注行数 = 既有 5 行 + rescued 1 行 + 比例口径 1 行',
    notes[0] === undefined ? -1 : notes[0].children.length, 7)
  const text = collectText(tree).join(' ')
  ok('T009 既有「仅统计本机」脚注仍渲染（新行不替换来源声明）',
    text.includes('仅统计本机 DSH 发出的调用；其他设备的用量不在此列。'), text.slice(-260))
  ok('T009 官方对照条照旧在脚注上方渲染', findNodes(tree, 'tpq-usage-official').length === 1)
}

/* T009 ③：rescued = 0 —— 不渲染，脚注与 008 的 fixture 逐行一致（4 张截图布局不变）。 */
{
  const bundle = await mountUsage({ fetchImpl: rescuedFetch(0) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const notes = findNodes(tree, 'tpq-usage-notes')
  check('T009 rescued=0 时一行都不渲染', nodesWithProp(tree, 'data-usage-rescued').length, 0)
  // 008 的 5 行 + 012 比例口径 1 行；rescue 行不出现。
  check('T009 rescued=0 时脚注 = 既有 5 行 + 比例口径 1 行',
    notes[0] === undefined ? -1 : notes[0].children.length, 6)
  const text = collectText(tree).join(' ')
  ok('T009 rescued=0 时既有脚注照旧（含「仅统计本机」与「不折算 Credits」）',
    text.includes('仅统计本机 DSH 发出的调用') && text.includes('不折算 Credits，也不估算余量。'), text.slice(-260))
}

/* T009 ④：老宿主 / 缺键 —— coverage 没有 rescued 时同 rescued=0，不抛也不渲染。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  check('T009 coverage 缺 rescued 键时同样不渲染（老宿主兼容）',
    nodesWithProp(tree, 'data-usage-rescued').length, 0)
  ok('T009 缺键时其余脚注照常', collectText(tree).join(' ').includes('仅统计本机 DSH 发出的调用'))
}

/* T009 ⑤：数量格式化 —— 四位数走千分位分组，不能被压成 1.2K。 */
{
  const bundle = await mountUsage({ fetchImpl: rescuedFetch(1234) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const node = nodesWithProp(tree, 'data-usage-rescued')[0]
  check('T009 四位数走千分位（1234 → 1,234，不压成 1.2K）', collectText(node).join(''),
    '另有 1,234 个会话不在宿主的会话列表里，已按日志目录补扫。')
  check('T009 属性仍是原始数字', node?.props?.['data-usage-rescued'], '1234')
}

/* T009 ⑥：英文界面 —— en 文案、无中文、无 % / Credits。 */
{
  const bundle = await mountUsage({ lang: 'en-US', fetchImpl: rescuedFetch(2) })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 8)
  const node = nodesWithProp(tree, 'data-usage-rescued')[0]
  check('T009 en 文案按 INTERFACE §3 渲染', collectText(node).join(''),
    '2 more session(s) were not in the host list and were recovered from the log directory.')
  ok('T009 en 该行不含中文字符', !/[\u3400-\u9fff]/u.test(collectText(node).join('')), collectText(node).join(''))
  const own = collectText(node).join('')
  ok('T009 en 该行不带百分比、不提 Credits', !own.includes('%') && !/credit/i.test(own), own)
  ok('T009 en 既有「仅统计本机」来源声明仍是英文', collectText(tree).join(' ').includes('Only calls made by this DSH instance are counted'))
}

/* ======================================================== T010（spec 010）按月查询 */

/** 某个月的假快照：range.kind="month"；末日超过 fixture 的「今天」（2026-11-13）就夹到今天。 */
function makeMonthSnapshot(month) {
  const parts = String(month).split('-')
  const year = Number(parts[0])
  const mm = Number(parts[1])
  const monthDays = new Date(Date.UTC(year, mm, 0)).getUTCDate()
  const startMs = Date.UTC(year, mm - 1, 1)
  const endMs = Date.UTC(year, mm - 1, monthDays)
  const fixtureTodayMs = Date.UTC(2026, 10, 13)
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  const lastMs = Math.min(endMs, fixtureTodayMs)
  const span = Math.max(1, Math.round((lastMs - startMs) / 86400000) + 1)
  const snap = makeUsageSnapshot(span)
  snap.range = { kind: 'month', month, days: span, from: iso(startMs), to: iso(lastMs) }
  return snap
}

/** 月份查询的假路由：带 month 参数回月份快照，其余回天数快照；options.handler 可接管本机路由。 */
function usageMonthFetch(options = {}) {
  return async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    const parsed = new URL(String(url), 'http://localhost')
    if (String(url).startsWith('/token-plan-quota/usage-official')) {
      const officialDays = Number(parsed.searchParams.get('days')) || 7
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(officialDays) }
    }
    const month = parsed.searchParams.get('month')
    if (typeof options.handler === 'function') {
      const handled = options.handler({ month, url: String(url), parsed })
      if (handled !== undefined) return handled
    }
    if (month !== null) return { ok: true, status: 200, json: async () => makeMonthSnapshot(month) }
    const days = Number(parsed.searchParams.get('days')) || 7
    return { ok: true, status: 200, json: async () => makeUsageSnapshot(days) }
  }
}

function monthChipOf(tree) {
  return findNodes(tree, 'tpq-usage-day').find((node) => node.props?.['data-usage-preset'] === 'month')
}
function monthRowOf(tree) {
  return findNodes(tree, 'tpq-usage-month')[0]
}
function monthInputOf(tree) {
  return findNodes(tree, 'tpq-usage-month-input').find((node) => node.props?.['data-usage-month-input'] === '1')
}
function monthApplyOf(tree) {
  return findNodes(tree, 'tpq-usage-apply').find((node) => node.props?.['data-usage-month-apply'] === '1')
}
function monthErrorTextOf(tree) {
  const node = findNodes(tree, 'tpq-usage-range-error').find((item) => item.props?.['data-usage-month-error'] === '1')
  return node === undefined ? null : collectText(node).join('')
}
function monthRangeTextOf(tree) {
  const node = findNodes(tree, 'tpq-usage-range')[0]
  return node === undefined ? '' : collectText(node).join('')
}
function openMonth(bundle) {
  const chip = monthChipOf(bundle.renderUsage())
  ok('T010 月份 chip 存在', chip !== undefined)
  chip.props.onClick()
  return bundle.renderUsage()
}
const monthParamOf = (url) => new URL(String(url), 'http://localhost').searchParams.get('month')

/* T010 ①：静态契约 + 五个新文案键双语齐备（禁 % 与 Credits）。 */
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const hooks = [
    '"data-usage-preset": "month"',
    '"data-usage-month": "1"',
    '"data-usage-month-input": "1"',
    '"data-usage-month-apply": "1"',
    '"data-usage-month-error": "1"',
  ]
  hooks.forEach((hook) => ok('T010 静态契约：源码含 ' + hook, source.includes(hook)))
  ok('T010 月份请求串只带 month（不带 days/from/to）', source.includes('"?month=" + checked.month'))
  ok('T010 月份行用原生 input[type=month]', source.includes('type: "month"'))
  ok('T010 月份行沿用量卡片底色变量', /\.tpq-usage-month\{[^}]*var\(--dsw-alias-bg-layer-2/.test(source))
  ok('T010 月份输入框限宽（375px 不横向溢出）', /\.tpq-usage-month-input\{width:150px\}/.test(source))
  ok('T010 月份输入框进焦点环名单', source.includes('.tpq-usage-month-input:focus-visible,'))
  const zhBlock = /const COPY = \{\n      zh: \{([\s\S]*?)\n      \},/.exec(source)?.[1] ?? ''
  const enBlock = /\n      en: \{([\s\S]*?)\n      \},/.exec(source)?.[1] ?? ''
  const copyEntriesOf = (blockText) => blockText.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    const colon = trimmed.indexOf(': "')
    if (colon <= 0) return []
    const rest = trimmed.slice(colon + 3)
    const end = rest.lastIndexOf('"')
    if (end < 0) return []
    return [{ key: trimmed.slice(0, colon), value: rest.slice(0, end) }]
  })
  const zhEntries = copyEntriesOf(zhBlock)
  const enEntries = copyEntriesOf(enBlock)
  const monthKeys = ['usageMonthPreset', 'usageMonthLabel', 'usageMonthApply', 'usageMonthBad', 'usageRangeMonthTitle']
  const pick = (entries, key) => entries.find((entry) => entry.key === key)?.value
  check('T010 中文月份文案逐字照 INTERFACE §3.4',
    monthKeys.map((key) => pick(zhEntries, key)),
    ['按月', '月份', '查询', '月份不合法', '{y} 年 {m} 月 · {n} 天'])
  check('T010 英文月份文案逐字照 INTERFACE §3.4',
    monthKeys.map((key) => pick(enEntries, key)),
    ['Month', 'Month', 'Apply', 'Invalid month', '{y}-{mm} · {n} days'])
  const zhMonthCopy = monthKeys.map((key) => pick(zhEntries, key) ?? '').join(' ')
  const enMonthCopy = monthKeys.map((key) => pick(enEntries, key) ?? '').join(' ')
  ok('T010 zh 月份文案不含 % 与 Credits', !zhMonthCopy.includes('%') && !zhMonthCopy.includes('Credits'), zhMonthCopy)
  ok('T010 en 月份文案不含 % / Credits、也不混中文',
    !enMonthCopy.includes('%') && !enMonthCopy.includes('Credits') && !/[\u3400-\u9fff]/u.test(enMonthCopy), enMonthCopy)
  // zh 用不补零的 {m}、en 用两位零填充的 {mm}：同一个 range.month 两种读法（INTERFACE §3.2）。
  ok('T010 标题模板 zh 带 {y} / {m} / {n}、en 带 {y} / {mm} / {n}',
    monthKeys.slice(4).every((key) => ['{y}', '{m}', '{n}'].every((token) => String(pick(zhEntries, key)).includes(token))
      && ['{y}', '{mm}', '{n}'].every((token) => String(pick(enEntries, key)).includes(token))))
}

/* T010 ②：__internals 的月份纯函数 —— 校验只认 YYYY-MM、请求串唯一构造、月份快照只认 month。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  const internals = bundle.api.__internals
  ok('T010 __internals 暴露月份校验与查询描述',
    typeof internals.validateUsageMonth === 'function' && typeof internals.usageQueryOf === 'function')
  const today = '2026-11-13'
  const badMonths = ['', '2026-9', '2026-13', '2026-00', '0000-01', '2030-01', '2026/09', '  ', '2026-9 '.trim()]
  const badResults = badMonths.map((value) => internals.validateUsageMonth(value, today).ok)
  ok('T010 非法月份一律拒绝（空 / 缺零 / 13 月 / 00 月 / 未来月 / 斜杠）',
    badResults.every((flag) => flag === false), JSON.stringify(badResults))
  check('T010 合法月份 trim 后返回规范值',
    internals.validateUsageMonth(' 2026-09 ', today), { ok: true, month: '2026-09' })
  check('T010 当月合法（不晚于今天所在月）', internals.validateUsageMonth('2026-11', today).month, '2026-11')
  check('T010 usageQueryOf 月份态只带 month',
    internals.usageQueryOf('month', 7, '2026-09-01', '2026-09-30', '2026-09'), { mode: 'month', month: '2026-09' })
  check('T010 月份请求串 / 非法月份零请求',
    [internals.usageQueryPath({ mode: 'month', month: '2026-09' }),
      internals.usageQueryPath({ mode: 'month', month: '2026-9' })],
    ['?month=2026-09', null])
  check('T010 官方查询 key 按月区分',
    [internals.officialQueryKeyOf({ mode: 'month', month: '2026-09' }),
      internals.officialQueryKeyOf({ mode: 'month', month: 'bad' })],
    ['month:2026-09', null])
  const monthSnap = makeMonthSnapshot('2026-09')
  const monthQuery = { mode: 'month', month: '2026-09' }
  check('T010 月份快照与月份查询一致', internals.usageSnapshotMatchesQuery(monthSnap, monthQuery), true)
  check('T010 月份不同 → 不一致（不拿旧月数据冒充）',
    internals.usageSnapshotMatchesQuery(makeMonthSnapshot('2026-10'), monthQuery), false)
  check('T010 自定义快照不算月份查询',
    internals.usageSnapshotMatchesQuery({ range: { kind: 'custom', from: '2026-09-01', to: '2026-09-30' } }, monthQuery), false)
  check('T010 月份快照不算天数查询',
    internals.usageSnapshotMatchesQuery(monthSnap, { mode: 'days', days: 30 }), false)
  const monthTitleCopy = { usageRangeMonthTitle: '{y} 年 {m} 月 · {n} 天' }
  check('T010 月份标题 zh 不补零、天数取自 snapshot.range',
    internals.usageRangeText(monthTitleCopy, monthSnap, 7), '2026 年 9 月 · 30 天')
  check('T010 月份标题 en 补零成 ISO 月',
    internals.usageRangeText({ usageRangeMonthTitle: '{y}-{mm} · {n} days' }, monthSnap, 7), '2026-09 · 30 days')
  check('T010 month 字段缺失时从 range.from 兜底',
    internals.usageRangeText(monthTitleCopy, { range: { kind: 'month', from: '2026-08-01', to: '2026-08-31', days: 31 } }, 7),
    '2026 年 8 月 · 31 天')
}

/* T010 ③：点「按月」展开月份行、预填当前月、立刻按该月取数（不带 days/from/to）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  check('T010 默认（天数态）不展开月份行', monthRowOf(tree), undefined)
  const currentMonth = bundle.api.__internals.usageTodayKey().slice(0, 7)
  tree = openMonth(bundle)
  ok('T010 点按月展开月份行', monthRowOf(tree) !== undefined && monthRowOf(tree).props['data-usage-month'] === '1')
  check('T010 月份输入预填本机当前月', monthInputOf(tree).props.value, currentMonth)
  check('T010 月份 chip 进入按下态', monthChipOf(tree).props['data-active'], '1')
  check('T010 月份态下预设与自定义都不处于按下态',
    findNodes(tree, 'tpq-usage-day')
      .filter((node) => node.props?.['data-usage-preset'] !== 'month')
      .map((node) => node.props['data-active']),
    ['0', '0', '0', '0', '0'])
  tree = await settle(bundle.renderUsage, 4)
  check('T010 切按月立刻按当前月取数', usageRequests().at(-1)?.url, '/token-plan-quota/usage?month=' + currentMonth)
  ok('T010 月份请求不夹带 days / from / to',
    !String(usageRequests().at(-1)?.url).includes('days=') && !String(usageRequests().at(-1)?.url).includes('from='))
  ok('T010 月份标题来自 snapshot.range（年 月 · N 天）',
    /20\d\d 年 \d\d 月 · \d+ 天/.test(monthRangeTextOf(tree)), monthRangeTextOf(tree))
}

/* T010 ④：非法月份点「查询」只出行内提示、零请求（SC-004），宿主一次都没被打扰。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openMonth(bundle)
  tree = await settle(bundle.renderUsage, 3)
  const cases = [['空值', ''], ['缺零', '2026-9'], ['13 月', '2026-13'], ['未来月', '2099-01']]
  for (const pair of cases) {
    tree = bundle.renderUsage()
    monthInputOf(tree).props.onChange({ target: { value: pair[1] } })
    tree = bundle.renderUsage()
    const before = usageRequests().length
    monthApplyOf(tree).props.onClick()
    check('T010 非法月份（' + pair[0] + '）点查询零请求', usageRequests().length, before)
    tree = bundle.renderUsage()
    check('T010 非法月份（' + pair[0] + '）行内提示', monthErrorTextOf(tree), '月份不合法')
  }
  tree = bundle.renderUsage()
  ok('T010 行内提示挂在 role=alert 上',
    findNodes(tree, 'tpq-usage-range-error').every((node) => node.props.role === 'alert'))
  ok('T010 全程没有发出 month= 非法值的请求',
    usageRequests().every((entry) => {
      const month = monthParamOf(entry.url)
      return month === null || /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    }))
  tree = bundle.renderUsage()
  monthInputOf(tree).props.onChange({ target: { value: '2026-09' } })
  tree = bundle.renderUsage()
  check('T010 改回合法月份后行内提示消失', monthErrorTextOf(tree), '')
}

/* T010 ⑤：合法月份 → 请求只带 month、标题与快照同源、不标 stale、store 记住。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openMonth(bundle)
  monthInputOf(tree).props.onChange({ target: { value: '2026-09' } })
  tree = bundle.renderUsage()
  monthApplyOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T010 合法月份请求只带 month', usageRequests().at(-1)?.url, '/token-plan-quota/usage?month=2026-09')
  ok('T010 月份标题与快照同源（2026 年 9 月 · 30 天）',
    monthRangeTextOf(tree).includes('2026 年 9 月 · 30 天'), monthRangeTextOf(tree))
  check('T010 月份数据到了不标 stale',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])
  const snapshot = bundle.handle.create().getSnapshot()
  check('T010 查询的月份写进 store（重开屏能恢复）', [snapshot.rangeMode, snapshot.month], ['month', '2026-09'])
  // 假 React 每次 render 都会重跑 effect（会发一条），所以计数要在 render 之后取。
  const applyTree = bundle.renderUsage()
  const before = usageRequests().length
  monthApplyOf(applyTree).props.onClick()
  check('T010 同月重复点查询再发一次', usageRequests().length, before + 1)
  check('T010 重发的是同一个月', usageRequests().at(-1)?.url, '/token-plan-quota/usage?month=2026-09')
  const monthText = collectText(bundle.renderUsage()).join(' ')
  ok('T010 月份态的百分比同样只来自实测比值（不拼进句子）',
    monthText.includes('占 ') && monthText.includes('缓存命中率 ') && strayPercentFragments(monthText).length === 0,
    strayPercentFragments(monthText).join(' | ') || monthText.slice(0, 300))
}

/* T010 ⑥：换月份、新响应没到时标 stale（旧月数据不许冒充新月）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openMonth(bundle)
  monthInputOf(tree).props.onChange({ target: { value: '2026-09' } })
  tree = bundle.renderUsage()
  monthApplyOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T010 前置：9 月数据到位', findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])
  monthInputOf(tree).props.onChange({ target: { value: '2026-10' } })
  tree = bundle.renderUsage()
  monthApplyOf(tree).props.onClick()
  tree = bundle.renderUsage()
  check('T010 换了月份、数据没到时标 stale',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['1', '1', '1'])
  tree = await settle(bundle.renderUsage, 4)
  check('T010 新月份数据到了 stale 落回 0',
    findNodes(tree, 'tpq-usage-card').map((node) => node.props['data-stale']), ['0', '0', '0'])
  ok('T010 新月份标题跟着快照走', monthRangeTextOf(tree).includes('2026 年 10 月 · 31 天'), monthRangeTextOf(tree))
}

/* T010 ⑦：点预设必须真的切回天数模式（收起月份行、请求 days、store 清月份）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openMonth(bundle)
  tree = await settle(bundle.renderUsage, 4)
  const presets = findNodes(tree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)
  check('T010 预设按钮仍是 4 个', presets.length, 4)
  presets[1].props.onClick()
  tree = await settle(bundle.renderUsage, 3)
  check('T010 点预设后月份行收起', monthRowOf(tree), undefined)
  check('T010 点预设后请求回到天数', usageRequests().at(-1)?.url, '/token-plan-quota/usage?days=7')
  check('T010 点预设后月份 chip 退出按下态', monthChipOf(tree).props['data-active'], '0')
  const snapshot = bundle.handle.create().getSnapshot()
  check('T010 点预设后 store 清掉月份', [snapshot.rangeMode, snapshot.month], ['days', ''])
}

/* T010 ⑧：store 三态互不覆盖（月份 / 天数 / 2D-3D 视图）。 */
{
  const bundle = await mountUsage({ fetchImpl: usageMonthFetch() })
  const store = bundle.handle
  const snapshot = () => store.create().getSnapshot()
  check('T010 store 初值带空月份',
    [snapshot().rangeMode, snapshot().month], ['days', ''])
  store.setRange({ rangeMode: 'month', month: '2026-09', from: '', to: '' })
  check('T010 store 记住月份',
    [snapshot().rangeMode, snapshot().month, snapshot().from, snapshot().to], ['month', '2026-09', '', ''])
  store.setMode('3d')
  check('T010 切 3D 不污染月份',
    [snapshot().mode, snapshot().rangeMode, snapshot().month], ['3d', 'month', '2026-09'])
  store.setRange({ rangeMode: 'days', from: '', to: '' })
  check('T010 回天数模式清掉月份', [snapshot().rangeMode, snapshot().month], ['days', ''])
  store.setRange({ rangeMode: 'month', month: '2026-11' })
  check('T010 setRange 缺 from/to 时保底为空串',
    [snapshot().from, snapshot().to], ['', ''])
}

/* T010 ⑨：重开屏恢复 —— 合法月份才恢复，非法/未来月份回落天数（不发注定的 400）。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageMonthFetch(),
    seedStore: (handle) => handle.setRange({ rangeMode: 'month', month: '2026-09', from: '', to: '' }),
  })
  resetHooks()
  const startIndex = usageRequests().length
  let tree = await settle(bundle.renderUsage, 4)
  ok('T010 恢复态首帧就展开月份行', monthRowOf(tree) !== undefined)
  check('T010 恢复的月份进输入框', monthInputOf(tree).props.value, '2026-09')
  check('T010 恢复后首个请求就是月份查询', usageRequests()[startIndex]?.url, '/token-plan-quota/usage?month=2026-09')
  ok('T010 恢复态标题同源', monthRangeTextOf(tree).includes('2026 年 9 月 · 30 天'), monthRangeTextOf(tree))
}
{
  const bundle = await mountUsage({
    fetchImpl: usageMonthFetch(),
    seedStore: (handle) => handle.setRange({ rangeMode: 'month', month: '2099-01', from: '', to: '' }),
  })
  resetHooks()
  const startIndex = usageRequests().length
  let tree = await settle(bundle.renderUsage, 4)
  check('T010 未来月份不恢复月份行', monthRowOf(tree), undefined)
  check('T010 未来月份回落天数查询', usageRequests()[startIndex]?.url, '/token-plan-quota/usage?days=7')
}
{
  const bundle = await mountUsage({
    fetchImpl: usageMonthFetch(),
    seedStore: (handle) => handle.setRange({ rangeMode: 'month', month: '2026-13', from: '', to: '' }),
  })
  resetHooks()
  const startIndex = usageRequests().length
  let tree = await settle(bundle.renderUsage, 4)
  check('T010 格式非法的旧月份同样回落天数', monthRowOf(tree), undefined)
  check('T010 格式非法旧月份不发月份请求', usageRequests()[startIndex]?.url, '/token-plan-quota/usage?days=7')
}

/* T010 ⑩：宿主 400 usage-bad-month → 本地文案 + 重试；宿主原文与错误码不上屏。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageMonthFetch({
      handler: ({ month }) => (month === null ? undefined
        : { ok: false, status: 400, json: async () => ({ error: 'usage-bad-month', message: 'month must be YYYY-MM' }) }),
    }),
  })
  resetHooks()
  await settle(bundle.renderUsage, 4)
  let tree = openMonth(bundle)
  tree = await settle(bundle.renderUsage, 3)
  const text = collectText(tree).join(' ')
  ok('T010 400 usage-bad-month 用本地文案', text.includes('月份不合法'), text.slice(0, 240))
  ok('T010 错误码与宿主原文不上屏',
    !text.includes('usage-bad-month') && !text.includes('month must be'), text.slice(0, 240))
  check('T010 月份错误态带重试按钮', findNodes(tree, 'tpq-usage-retry').length, 1)
  const before = usageRequests().length
  findNodes(tree, 'tpq-usage-retry')[0].props.onClick()
  ok('T010 重试重发同一条月份查询',
    usageRequests().length > before && String(usageRequests().at(-1)?.url).includes('month='))
  check('T010 重试的仍是失败的那个月', monthParamOf(usageRequests().at(-1)?.url), '2026-11')
}

/* T010 ⑪：英文界面走英文文案，不混中文、不带百分比。 */
{
  const bundle = await mountUsage({ lang: 'en-US', fetchImpl: usageMonthFetch() })
  resetHooks()
  let tree = await settle(bundle.renderUsage, 4)
  check('T010 en：月份 chip 文案', collectText(monthChipOf(tree)).join(''), 'Month')
  tree = openMonth(bundle)
  check('T010 en：查询按钮文案', collectText(monthApplyOf(tree)).join(''), 'Apply')
  check('T010 en：月份输入框 aria-label 走 COPY', monthInputOf(tree).props['aria-label'], 'Month')
  monthInputOf(tree).props.onChange({ target: { value: '2026-09' } })
  tree = bundle.renderUsage()
  monthApplyOf(tree).props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  const text = collectText(tree).join(' ')
  ok('T010 en：月份标题', text.includes('2026-09 · 30 days'), text.slice(0, 240))
  ok('T010 en：整屏不混中文', !/[\u3400-\u9fff]/u.test(text), text.slice(0, 240))
  ok('T010 en：百分比只来自实测比值（of total / hit rate；不混中文标签）',
    text.includes('% of total') && text.includes('hit rate ')
      && strayPercentFragments(text).length === 0 && !text.includes('占 '),
    strayPercentFragments(text).join(' | ') || text.slice(0, 300))
  ok('T010 en：月份行不带 Credits', !/credit/i.test(collectText(monthRowOf(tree)).join(' ')))
  ok('T010 en：脚注仍是英文「仅统计本机」',
    text.includes('Only calls made by this DSH instance are counted'))
}

/* ============================================ T011 柱子悬停浮层
 *
 * 011「柱子悬停看当时用了多少 tokens」。契约唯一真值：specs/011-bar-tooltip/INTERFACE.md
 * §2 DOM 钩子 / §3 行为 / §4 验收 SC-001..008。全部用假快照与假事件，不联网。
 */

/** 011：日桶形态（宿主 lib/usage-stats.js 的日桶 from === to）——首行只印一天。 */
function makeDaySnapshot(days = 7) {
  const snapshot = makeUsageSnapshot(days)
  for (const bucket of snapshot.buckets) bucket.to = bucket.from
  return snapshot
}

/** 011：日桶回包（任意天数都保持 from === to）。 */
function dayFetch() {
  return usageFetch(() => makeDaySnapshot(7))
}

function tipOf(tree) {
  return nodesWithProp(tree, 'data-usage-tip')[0]
}

function tipCount(tree) {
  return nodesWithProp(tree, 'data-usage-tip').length
}

function barOf(tree, index) {
  return nodesWithProp(tree, 'data-usage-bar').find((node) => node.props['data-usage-bar-index'] === String(index))
}

function tipPartOf(tree, key) {
  return nodesWithProp(tree, 'data-usage-tip-' + key)[0]
}

/** 011：一行 = 「标签|数值」两段文本（浮层内部结构就是 label span + value span）。 */
function tipRowText(tree, key) {
  const row = tipPartOf(tree, key)
  if (row === undefined) return '<missing>'
  const parts = (row.children ?? []).map((child) => collectText(child).join(''))
  return parts.join('|')
}

function tipRowsOf(tree) {
  return ['input', 'output', 'cache-read', 'cache-write', 'calls'].map((key) => tipPartOf(tree, key))
}

/** 011：模拟「指针进到第 index 根柱子」，返回重渲染后的树。 */
function hoverPointer(bundle, tree, index, clientX = 40, clientY = 60) {
  barOf(tree, index).props.onPointerEnter({ clientX, clientY })
  return bundle.renderUsage()
}

/* T011 ①：命中钩子 + 浮层 DOM/内容逐字（SC-001）、最多一个浮层。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  // 011 的夹紧要读视口尺寸；假 window 是裸对象，这里直接给（每次渲染现读）。
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  const bars = nodesWithProp(tree, 'data-usage-bar')
  check('T011 每根柱子一个命中钩子', bars.length, 7)
  check('T011 钩子 index 连号且从 0 起', bars.map((bar) => bar.props['data-usage-bar-index']), ['0', '1', '2', '3', '4', '5', '6'])
  ok('T011 日桶 from/to 同一天（浮层首行该只印一天）',
    bars.every((bar) => bar.props['data-usage-bar-from'] === bar.props['data-usage-bar-to']),
    bars.map((bar) => bar.props['data-usage-bar-from'] + '/' + bar.props['data-usage-bar-to']).join(' '))
  ok('T011 每根柱子可聚焦（tabIndex 0）且 role=img',
    bars.every((bar) => bar.props.tabIndex === 0 && bar.props.role === 'img'))
  check('T011 未命中时不渲染浮层节点（不是 CSS 隐藏）', tipCount(tree), 0)

  const fixture = makeDaySnapshot(7).buckets[3]
  tree = hoverPointer(bundle, tree, 3, 100, 120)
  check('T011 指针进入后渲染恰好一个浮层', tipCount(tree), 1)
  const tip = tipOf(tree)
  // 012 复核：浮层不进无障碍树（aria-hidden），role="tooltip" 随之去掉——柱子 aria-label 才是数字来源。
  check('T011 浮层 data 钩子 / index / aria-hidden',
    [tip.props['data-usage-tip'], tip.props['data-usage-tip-index'], tip.props['aria-hidden']], ['1', '3', 'true'])
  check('T011 指针坐标偏移 12px（portal + fixed）',
    [tip.props.style.position, tip.props.style.left, tip.props.style.top], ['fixed', 112, 132])
  check('T011 首行日期（日桶只印一天）', collectText(tipPartOf(tree, 'range')).join(''), fixture.from)
  check('T011 总量行 = formatTokens + 单位（无空格、无百分比）',
    collectText(tipPartOf(tree, 'tokens')).join(''), '4,000tokens')
  // 012：浮层内容与行为一字不改，只跟着 COPY 换标签（中文界面）。
  check('T011 input 行', tipRowText(tree, 'input'), '输入|2,000')
  check('T011 output 行', tipRowText(tree, 'output'), '输出|1,000')
  check('T011 cache-read 行', tipRowText(tree, 'cache-read'), '缓存命中|1,000')
  check('T011 cache-write 行（0 也照样印，不隐藏）', tipRowText(tree, 'cache-write'), '缓存写入|0')
  check('T011 调用次数行', tipRowText(tree, 'calls'), '调用次数|4')
  const tipText = collectText(tip).join(' ')
  ok('T011 浮层不出现百分比 / Credits / 估算余量字样',
    !tipText.includes('%') && !/credit/i.test(tipText) && !/估算|余量/.test(tipText), tipText)
  const aria3 = barOf(tree, 3).props['aria-label']
  ok('T011 aria-label 与浮层同源（日期 + 总量 + 调用次数都在）',
    aria3.includes(fixture.from) && aria3.includes('4,000') && aria3.includes('调用次数'), aria3)

  tree = hoverPointer(bundle, tree, 5, 50, 70)
  check('T011 换一根柱子仍只有一个浮层、index 跟着换',
    [tipCount(tree), tipOf(tree).props['data-usage-tip-index']], [1, '5'])
}

/* T011 ②：英文界面逐字走英文、不混中文（SC-007）。 */
{
  const bundle = await mountUsage({ lang: 'en-US', fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 3, 40, 60)
  const tipText = collectText(tipOf(tree)).join(' ')
  check('T011 en：调用次数行走 requests', tipRowText(tree, 'calls'), 'requests|4')
  check('T011 en：总量行用拉丁量纲', collectText(tipPartOf(tree, 'tokens')).join(''), '4.0Ktokens')
  ok('T011 en：浮层不混中文', !/[\u3400-\u9fff]/u.test(tipText), tipText)
  ok('T011 en：浮层无百分比 / Credits', !tipText.includes('%') && !/credit/i.test(tipText), tipText)
  const aria = barOf(tree, 3).props['aria-label']
  ok('T011 en：aria-label 也是英文（requests + tokens）', aria.includes('requests') && aria.includes('tokens'), aria)
}

/* T011 ③：2D / 3D 同一根柱内容逐字相同（SC-002），切换清空 hover（§3）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 4, 60, 60)
  const text2d = collectText(tipOf(tree)).join('|')
  const aria2d = barOf(tree, 4).props['aria-label']
  const mode3d = findNodes(tree, 'tpq-usage-mode').find((node) => collectText(node).join('') === '3D')
  ok('T011 有 3D 视图切换按钮', mode3d !== undefined)
  mode3d.props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T011 切 2D→3D 清空 hover（旧坐标不残留）', tipCount(tree), 0)
  tree = hoverPointer(bundle, tree, 4, 60, 60)
  ok('T011 3D 同一根柱浮层内容与 2D 逐字相同', collectText(tipOf(tree)).join('|') === text2d, text2d)
  check('T011 3D aria-label 与 2D 同源', barOf(tree, 4).props['aria-label'], aria2d)
  check('T011 3D 柱子仍挂同一组命中钩子', barOf(tree, 4).props['data-usage-bar'], '1')
}

/* T011 ④：周桶首行是 from – to（U+2013 两端各一个空格，SC-003）。 */
{
  const weeklyFetch = usageFetch((snapshot) => {
    snapshot.granularity = 'week'
    snapshot.range = { kind: 'days', days: 14, from: '2026-10-31', to: '2026-11-13' }
    snapshot.buckets = [
      { from: '2026-10-31', to: '2026-11-06', label: '10-31', totals: { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, calls: 2, steps: 2, tokens: 175 } },
      { from: '2026-11-07', to: '2026-11-13', label: '11-07', totals: { input: 200, output: 100, cacheRead: 50, cacheWrite: 10, calls: 4, steps: 4, tokens: 350 } },
    ]
    return snapshot
  })
  const bundle = await mountUsage({ fetchImpl: weeklyFetch })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 1, 40, 60)
  const rangeText = collectText(tipPartOf(tree, 'range')).join('')
  check('T011 周桶首行 = from – to（en dash）', rangeText, '2026-11-07 \u2013 2026-11-13')
  check('T011 连接符是 U+2013 且两端各一个空格',
    [rangeText.indexOf(' \u2013 '), rangeText.charCodeAt(11)], [10, 0x2013])
  check('T011 周桶总量行', collectText(tipPartOf(tree, 'tokens')).join(''), '350tokens')
  check('T011 周桶调用次数行', tipRowText(tree, 'calls'), '调用次数|4')
}

/* T011 ⑤：坐标纯函数——偏移、翻面、四边夹紧、无效视口不崩（SC-004）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  const internals = bundle.api.__internals
  ok('T011 __internals 追加浮层纯函数',
    ['usageBucketRange', 'usageTipContent', 'usageTipPlacement', 'usageTipInline', 'usagePointerPoint', 'usageBarRectOf']
      .every((key) => typeof internals[key] === 'function'),
    Object.keys(internals).join(','))
  check('T011 usageBucketRange：日桶只印一天',
    internals.usageBucketRange({ from: '2026-10-22', to: '2026-10-22' }), '2026-10-22')
  check('T011 usageBucketRange：周桶 en dash',
    internals.usageBucketRange({ from: '2026-09-01', to: '2026-09-07' }), '2026-09-01 \u2013 2026-09-07')
  const content = internals.usageTipContent(
    { from: '2026-10-22', to: '2026-10-22', totals: { tokens: 12345, input: 6000, output: 3000, cacheRead: 3000, cacheWrite: 345, calls: 7 } },
    { usageTokensUnit: 'tokens', usageSplitInput: 'input', usageSplitOutput: 'output', usageSplitCacheRead: 'cacheRead',
      usageSplitCacheWrite: 'cacheWrite', usageCalls: 'calls' })
  check('T011 usageTipContent：区间 / 总量 / 单位 / 五行键',
    [content.range, content.tokens, content.unit, content.rows.map((row) => row.key).join(',')],
    ['2026-10-22', '1.2万', 'tokens', 'input,output,cache-read,cache-write,calls'])
  check('T011 usageTipContent：五行值都过 formatTokens',
    content.rows.map((row) => row.value), ['6,000', '3,000', '3,000', '345', '7'])
  check('T011 usagePointerPoint：缺坐标退 0', internals.usagePointerPoint({}), { x: 0, y: 0 })
  check('T011 usageBarRectOf：rect 全 0 → null（调用方退回图表内几何）',
    internals.usageBarRectOf({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0 }) } }), null)
  check('T011 usageBarRectOf：取柱中心 / 上沿 / 下沿',
    internals.usageBarRectOf({ currentTarget: { getBoundingClientRect: () => ({ left: 300, top: 200, width: 60, height: 120, bottom: 320 }) } }),
    { x: 330, top: 200, bottom: 320 })
  const place = (options) => internals.usageTipPlacement(options)
  check('T011 指针右下偏移 12px', place({ source: 'pointer', x: 100, y: 120, w: 210, h: 132, vw: 800, vh: 600 }),
    { left: 112, top: 132, flipX: false, flipY: false })
  check('T011 右下放不下翻到指针左/上并夹紧', place({ source: 'pointer', x: 790, y: 590, w: 210, h: 132, vw: 800, vh: 600 }),
    { left: 568, top: 446, flipX: true, flipY: true })
  check('T011 指针贴左上仍留 8px', place({ source: 'pointer', x: 0, y: 0, w: 210, h: 132, vw: 800, vh: 600 }),
    { left: 12, top: 12, flipX: false, flipY: false })
  check('T011 视口尺寸无效时不出现负坐标', place({ source: 'pointer', x: -50, y: -50, w: 210, h: 132, vw: 0, vh: 0 }),
    { left: 0, top: 0, flipX: false, flipY: false })
  check('T011 锚定柱：上方居中', place({ source: 'anchor', x: 400, top: 300, bottom: 420, w: 210, h: 132, vw: 800, vh: 600 }),
    { left: 295, top: 160, flipX: false, flipY: false })
  check('T011 锚定柱：上方不够翻到柱下', place({ source: 'anchor', x: 400, top: 50, bottom: 170, w: 210, h: 132, vw: 800, vh: 600 }),
    { left: 295, top: 178, flipX: false, flipY: true })
  check('T011 内联：柱中心上方并夹进容器宽',
    internals.usageTipInline({ x: 100, top: 60, bottom: 160, w: 210, h: 132, vw: 800 }), { left: 0, top: 172 })
  check('T011 内联：容器宽量不到也不出负坐标',
    internals.usageTipInline({ x: 10, top: 10, bottom: 40, w: 210, h: 132, vw: 0 }), { left: 0, top: 52 })
}

/* T011 ⑥：DOM 里的夹紧（注入视口尺寸与指针坐标后四边 ≥8px，SC-004）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 2, 790, 590)
  const corner = tipOf(tree).props.style
  check('T011 DOM：右下角翻到指针左上并夹进视口', [corner.left, corner.top], [568, 446])
  ok('T011 DOM：四边都留 ≥8px',
    corner.left >= 8 && corner.top >= 8 && corner.left + 210 <= 800 - 8 && corner.top + 132 <= 600 - 8,
    JSON.stringify(corner))
  tree = hoverPointer(bundle, tree, 2, 0, 0)
  check('T011 DOM：贴左上角也不出界', [tipOf(tree).props.style.left, tipOf(tree).props.style.top], [12, 12])
  tree = hoverPointer(bundle, tree, 2, 795, 100)
  check('T011 DOM：右侧放不下、下方放得下 → 只翻横向',
    [tipOf(tree).props.style.left, tipOf(tree).props.style.top], [573, 112])
}

/* T011 ⑦：关闭通路（SC-005）——每个入口都真的移除节点。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 3)
  barOf(tree, 3).props.onPointerLeave()
  tree = bundle.renderUsage()
  check('T011 pointerleave 关闭', tipCount(tree), 0)

  tree = hoverPointer(bundle, tree, 3)
  const keydownHandler = bundle.windowListeners.get('keydown')?.at(-1)
  ok('T011 Esc 挂在 window 上（document keydown 留给整页屏）', typeof keydownHandler === 'function')
  keydownHandler({ key: 'Enter' })
  tree = bundle.renderUsage()
  check('T011 非 Esc 键不关浮层', tipCount(tree), 1)
  bundle.windowListeners.get('keydown').at(-1)({ key: 'Escape' })
  tree = bundle.renderUsage()
  check('T011 Esc 关闭浮层', tipCount(tree), 0)

  tree = hoverPointer(bundle, tree, 3)
  bundle.dom.listeners.get('pointerdown').at(-1)({ target: { closest: () => null } })
  tree = bundle.renderUsage()
  check('T011 点别处关闭（document 捕获 pointerdown）', tipCount(tree), 0)

  tree = hoverPointer(bundle, tree, 3)
  bundle.dom.listeners.get('pointerdown').at(-1)({ target: { closest: (selector) => (selector === '[data-usage-bar]' ? {} : null) } })
  tree = bundle.renderUsage()
  check('T011 点在柱子上的 pointerdown 不关（触屏是「显示并锚定」）', tipCount(tree), 1)

  bundle.dom.listeners.get('scroll').at(-1)()
  tree = bundle.renderUsage()
  check('T011 滚动关闭（捕获 scroll）', tipCount(tree), 0)

  tree = hoverPointer(bundle, tree, 3)
  bundle.windowListeners.get('blur').at(-1)()
  tree = bundle.renderUsage()
  check('T011 窗口失焦关闭', tipCount(tree), 0)
  check('T011 关闭后节点彻底移除（不是 CSS 隐藏）', nodesWithProp(tree, 'data-usage-tip').length, 0)
}

/* T011 ⑧：focus/blur（SC-006）——锚到柱上方居中，aria-label 与浮层同源。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  const rectTarget = { getBoundingClientRect: () => ({ left: 300, top: 200, width: 60, height: 120, bottom: 320 }) }
  barOf(tree, 2).props.onFocus({ currentTarget: rectTarget })
  tree = bundle.renderUsage()
  const focusedTip = tipOf(tree)
  check('T011 focus 显示并锚到柱上方居中', [focusedTip.props.style.left, focusedTip.props.style.top], [225, 60])
  check('T011 focus 的浮层 index 指向该柱', focusedTip.props['data-usage-tip-index'], '2')
  const focusedAria = barOf(tree, 2).props['aria-label']
  ok('T011 focus 时 aria-label 与浮层内容同源',
    focusedAria.includes(collectText(tipPartOf(tree, 'range')).join(''))
      && focusedAria.includes('tokens') && focusedAria.includes('调用次数'),
    focusedAria)
  barOf(tree, 2).props.onBlur()
  tree = bundle.renderUsage()
  check('T011 blur 关闭', tipCount(tree), 0)

  barOf(tree, 2).props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, bottom: 0 }) } })
  tree = bundle.renderUsage()
  const fallbackTip = tipOf(tree)
  ok('T011 rect 全 0 时退回图表内几何（不崩、坐标有限）',
    fallbackTip !== undefined
      && Number.isFinite(fallbackTip.props.style.left) && Number.isFinite(fallbackTip.props.style.top),
    fallbackTip === undefined ? '<missing>' : JSON.stringify(fallbackTip.props.style))
  check('T011 rect 全 0 时浮层照样渲染', tipCount(tree), 1)
  bundle.windowListeners.get('keydown').at(-1)({ key: 'Escape' })
  tree = bundle.renderUsage()

  barOf(tree, 3).props.onPointerDown({
    clientX: 500,
    clientY: 400,
    currentTarget: { getBoundingClientRect: () => ({ left: 480, top: 300, width: 40, height: 120, bottom: 420 }) },
  })
  tree = bundle.renderUsage()
  check('T011 触屏 pointerdown 显示并锚到柱上方',
    [tipOf(tree).props.style.left, tipOf(tree).props.style.top], [395, 160])
}

/* T011 ⑨：0 token 的桶也能悬停（透明命中区），数字照样印 0。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snapshot) => {
      snapshot.buckets[3].totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, steps: 0, tokens: 0 }
      for (const bucket of snapshot.buckets) bucket.to = bucket.from
      return snapshot
    }),
  })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  check('T011 0 token 的柱仍铺透明命中区（柱高 0 时可悬停）',
    findNodes(barOf(tree, 3), 'tpq-usage-hit').length, 1)
  tree = hoverPointer(bundle, tree, 3, 40, 60)
  check('T011 0 token：总量行印 0 而不是空', collectText(tipPartOf(tree, 'tokens')).join(''), '0tokens')
  check('T011 0 token：五行全 0（不省略行）',
    tipRowsOf(tree).map((row) => collectText(row).join('')), ['输入0', '输出0', '缓存命中0', '缓存写入0', '调用次数0'])
}

/* T011 ⑩：切区间（数据变化）同样清空 hover。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snapshot) => {
      for (const bucket of snapshot.buckets) bucket.to = bucket.from
      return snapshot
    }),
  })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 3)
  check('T011 切区间前浮层在', tipCount(tree), 1)
  // 预设按钮（1/7/30/90）没有 data-usage-preset 钩子，按顺序取；[2] = 30 天。
  const dayPresets = findNodes(tree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)
  check('T011 天数预设仍是 4 个', dayPresets.length, 4)
  dayPresets[2].props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T011 切到 30 天后浮层清空（新数据不该带走旧坐标）', tipCount(tree), 0)
  check('T011 切区间后确实是 30 根柱', nodesWithProp(tree, 'data-usage-bar').length, 30)
  // 代次 key 的回归：7 天 → 30 天 → 7 天 往返后，形状 key 与最初完全一样，
  // 但快照换了对象。旧坐标上的浮层不许复活。
  const backPresets = findNodes(tree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)
  check('T011 往返前仍能拿到 4 个天数预设', backPresets.length, 4)
  backPresets[1].props.onClick()
  tree = await settle(bundle.renderUsage, 4)
  check('T011 7→30→7 往返后旧浮层不复活（快照代次 key）', tipCount(tree), 0)
  check('T011 往返后回到 7 根柱', nodesWithProp(tree, 'data-usage-bar').length, 7)
}

/* T011 ⑪：portal 与内联两条渲染路径（§3 位置规则的后半句）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 3)
  const tip = tipOf(tree)
  check('T011 有 react-dom 时浮层 portal 到 body', tip.portalTo, 'body')
  check('T011 portal 路径用 fixed 定位', tip.props.style.position, 'fixed')
  check('T011 图表外层有定位容器（滚动容器不裁浮层）', findNodes(tree, 'tpq-usage-chart-wrap').length, 1)
}
{
  const bundle = await mountUsage({ fetchImpl: dayFetch(), reactDOM: false })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  tree = hoverPointer(bundle, tree, 3)
  const tip = tipOf(tree)
  ok('T011 无 react-dom 时浮层退回容器内 absolute',
    tip !== undefined && tip.props.style.position === 'absolute',
    tip === undefined ? '<missing>' : String(tip.props.style.position))
  check('T011 回退路径带 -inline 类（CSS 用它盖掉 fixed）',
    String(tip.props.className).split(/\s+/).includes('tpq-usage-tip-inline'), true)
  ok('T011 回退路径锚到柱上方且不出负坐标',
    tip.props.style.left >= 0 && tip.props.style.top >= 0, JSON.stringify(tip.props.style))
  check('T011 回退路径不 portal', tip.portalTo, undefined)
}

/* ============================================ T012 按模型用量的中文标签、占比与缓存命中
 *
 * 规格：specs/012-usage-composition/INTERFACE.md（唯一真值）+ spec.md 的 SC-001..SC-007。
 * 012 把 006「整屏无百分比」收窄为「百分比只能来自本机实测 tokens 的两项比值」：
 * 构成比（四项 ÷ 区间 tokens）与缓存命中率（cacheRead ÷ (input + cacheRead + cacheWrite)）。
 * fixture 数字按 INTERFACE §9 手算，不复用实现里的比例函数，避免自证。
 */

/* SC-001 / SC-002：总量卡六格、四项构成比、命中率、逐字中文。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const cells = findNodes(tree, 'tpq-usage-split')
  check('T012 总量卡拆分成 6 格（012 从 5 格变 6 格）', cells.length, 6)
  check('T012 六格逐字内容（中文标签 + 数值 + 占比子行）',
    cells.map((cell) => collectText(cell).join('')),
    ['输入60.0万占 60%', '输出30.0万占 30%', '缓存命中10.0万占 10%',
      '缓存写入0', '缓存命中率14.3%', '调用次数30'])
  const shares = findNodes(tree, 'tpq-usage-split-share')
  check('T012 占比子行只挂 3 格（缓存写入 0 / 命中率 / 调用次数不挂）', shares.length, 3)
  check('T012 占比子行文案逐字（模板来自 COPY.usageShareOf）',
    shares.map((node) => collectText(node).join('')), ['占 60%', '占 30%', '占 10%'])
  const text = collectText(tree).join(' ')
  // 既有脚注「当前宿主大多不上报 cacheWrite」在点名宿主字段，不是 UI 标签。
  const labelSurface = text.split('当前宿主大多不上报 cacheWrite，这个数常年为 0 属正常。').join('')
  ok('T012 中文界面不再出现四个英文标签',
    ['input', 'output', 'cacheRead', 'cacheWrite'].every((label) => !labelSurface.includes(label)),
    labelSurface.slice(0, 500))
}

/* SC-001 / SC-003：模型行中文标签、占比后缀与命中率；分母是该模型自己的 tokens。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const models = findNodes(tree, 'tpq-usage-model')
  check('T012 模型行数不变（fixture 两个模型都渲染）', models.length, 2)
  check('T012 模型顺序不变（按 tokens 降序：qwen 在前）',
    models.map((row) => collectText(findNodes(row, 'tpq-usage-model-id')[0]).join('')),
    ['qwen/qwen3-max', 'deepseek/deepseek-chat'])
  check('T012 首条模型第二行逐字（占比分母 = 该模型 tokens）',
    collectText(findNodes(models[0], 'tpq-usage-model-splits')[0]).join(''),
    '输入 40.0万 (61.5%) · 输出 20.0万 (30.8%) · 缓存命中 5.0万 (7.7%) · 缓存写入 0 · 命中率 11.1%')
  check('T012 第二条模型第二行逐字（50,000 / 350,000 = 14.3%，命中率 50,000 / 300,000 = 20%）',
    collectText(findNodes(models[1], 'tpq-usage-model-splits')[0]).join(''),
    '输入 20.0万 (57.1%) · 输出 10.0万 (28.6%) · 缓存命中 5.0万 (14.3%) · 缓存写入 0 · 命中率 20%')
  ok('T012 模型行数值仍走 formatTokens（中文万量纲，不换单位）',
    collectText(models[0]).join(' ').includes('65.0万'), collectText(models[0]).join(' '))
  ok('T012 值为 0 的拆分不挂 (0%) 后缀',
    !collectText(findNodes(models[0], 'tpq-usage-model-splits')[0]).join('').includes('缓存写入 0 (0%)'))
}

/* SC-004：比例纯函数的边界（0 分母 / <0.1% / 100% / 负数 / 非有限数）。 */
{
  const bundle = await mountUsage()
  const internals = bundle.api.__internals
  ok('T012 __internals 导出比例白名单段的四个纯函数',
    ['usagePercentText', 'usageShareText', 'usagePercentSuffix', 'usageHitRateText']
      .every((name) => typeof internals[name] === 'function'))
  const pct = internals.usagePercentText
  check('T012 分母 0 → null（不印 0% 冒充比例）', [pct(0, 0), pct(5, 0), pct(5, -1)], [null, null, null])
  check('T012 负数 / 非有限数 → null',
    [pct(-1, 10), pct(NaN, 10), pct(10, NaN), pct(10, Infinity)], [null, null, null, null])
  check('T012 0 与 100 写成整数百分比', [pct(0, 100), pct(100, 100)], ['0%', '100%'])
  check('T012 0 < pct < 0.1 写成 <0.1%', [pct(5, 10000), pct(1, 2000)], ['<0.1%', '<0.1%'])
  check('T012 一位小数四舍五入', [pct(571, 1000), pct(2, 3), pct(1, 3)], ['57.1%', '66.7%', '33.3%'])
  check('T012 整数百分比不带 .0', [pct(57, 100), pct(100, 100)], ['57%', '100%'])
  check('T012 usageShareText 套模板 / null → 空串',
    [internals.usageShareText({ usageShareOf: '占 {percent}' }, 571, 1000),
      internals.usageShareText({ usageShareOf: '占 {percent}' }, 5, 0)], ['占 57.1%', ''])
  check('T012 usagePercentSuffix 带前导空格 / null → 空串',
    [internals.usagePercentSuffix(571, 1000), internals.usagePercentSuffix(5, 0)], [' (57.1%)', ''])
  check('T012 usageHitRateText 分母 = input + cacheRead + cacheWrite',
    internals.usageHitRateText({ usageHitRate: '命中率 {percent}' },
      { input: 600000, cacheRead: 100000, cacheWrite: 0 }), '命中率 14.3%')
  check('T012 命中率分母 0 → 空串（整段省略，不写 命中率 —）',
    [internals.usageHitRateText({ usageHitRate: '命中率 {percent}' },
      { input: 0, cacheRead: 0, cacheWrite: 0 }),
      internals.usageHitRateText({ usageHitRate: '命中率 {percent}' }, null)], ['', ''])
}

/* SC-004：分母为 0 时总量卡命中率印 —（不是 0%）。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({
      ...snap,
      totals: { input: 0, output: 5000, cacheRead: 0, cacheWrite: 0, calls: 2, steps: 2, tokens: 5000 },
      models: [],
    })),
  })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const cells = findNodes(tree, 'tpq-usage-split')
  check('T012 命中率分母为 0 → 印 —', collectText(cells[4]).join(''), '缓存命中率—')
  ok('T012 分母为 0 时不出现 0% 命中率', !collectText(cells[4]).join('').includes('%'), collectText(cells[4]).join(''))
}

/* SC-005：百分比只可能来自白名单段；客户端其余代码 0 个 % 字面量。 */
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const startMarker = '/* 012 比例白名单段：本产品唯一允许出现百分号的地方（实测 token 的构成比与命中率）。 */'
  const endMarker = '/* 012 比例白名单段结束 */'
  check('T012 白名单段起始标记恰一处', source.split(startMarker).length - 1, 1)
  check('T012 白名单段结束标记恰一处', source.split(endMarker).length - 1, 1)
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  const segment = source.slice(start + startMarker.length, end)
  ok('T012 白名单段内四个比例函数都在',
    ['function usagePercentText', 'function usageShareText', 'function usagePercentSuffix', 'function usageHitRateText']
      .every((signature) => segment.includes(signature)))
  const outside = source.slice(0, start) + source.slice(end + endMarker.length)
  // 只剥注释与模板串（CSS 里的 100% 宽度合法）；剩下的 JS 里一个 % 都不许有。
  const TICK = String.fromCharCode(96)
  const stripped = outside
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split(TICK)
    .filter((_, index) => index % 2 === 0)
    .join('')
  // 「index % labelStep」是取模运算符（两侧空格），不是百分号；其余 % 一律不许有。
  const stray = (stripped.replace(/ % /g, ' ').match(/.{0,18}%.{0,18}/g) ?? [])
  ok('T012 白名单段之外没有 % 字面量（注释、CSS 模板与取模运算符已剥）', stray.length === 0, stray.join(' | '))
  const templates = source.match(/usage(?:ShareOf|HitRate): "[^"]*\{percent\}[^"]*"/g) ?? []
  check('T012 {percent} 模板只出现在 COPY 的两个键（zh/en 各一）', templates.length, 4)
}

/* SC-006：模型列表自己内滚动、可聚焦、有可访问名称；行数与排序不变。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const container = findNodes(tree, 'tpq-usage-models')[0]
  check('T012 模型容器带滚动钩子', container?.props?.['data-usage-models-scroll'], '1')
  check('T012 模型容器可聚焦（键盘可翻动）', container?.props?.tabIndex, 0)
  check('T012 模型容器可访问名称走 COPY', container?.props?.['aria-label'], '按模型用量')
  check('T012 模型容器有 group 语义', container?.props?.role, 'group')
  check('T012 模型容器不用 aria-live（不抢读屏）', container?.props?.['aria-live'], undefined)
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T012 模型列表 max-height + 纵向滚动 + 滚动链隔离',
    /\.tpq-usage-models\{[^}]*max-height:252px/.test(code)
      && /\.tpq-usage-models\{[^}]*overflow-y:auto/.test(code)
      && /\.tpq-usage-models\{[^}]*overscroll-behavior:contain/.test(code),
    code.slice(code.indexOf('.tpq-usage-models{'), code.indexOf('.tpq-usage-models{') + 260))
  ok('T012 滚动条细、thumb 用既有 border 变量（深色主题不写死颜色）',
    /\.tpq-usage-models\{[^}]*scrollbar-width:thin/.test(code)
      && /\.tpq-usage-models\{[^}]*scrollbar-color:var\(--dsw-alias-border-l2/.test(code)
      && /\.tpq-usage-models::-webkit-scrollbar\{width:8px\}/.test(code))
  ok('T012 焦点环用品牌色变量并留 offset',
    /\.tpq-usage-models:focus-visible\{[^}]*outline:2px solid var\(--dsw-alias-brand-primary/.test(code)
      && /\.tpq-usage-models:focus-visible\{[^}]*outline-offset:2px/.test(code))
  check('T012 滚动容器里仍是全部模型行（滚动不裁数据）',
    findNodes(container, 'tpq-usage-model').length, 2)
}

/* SC-007：脚注中英各一条、含两条公式；无 Credits 之外的措辞、无「还剩」。 */
{
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const notes = findNodes(tree, 'tpq-usage-notes')[0]
  const noteRows = (notes?.children ?? []).map((child) => collectText(child).join(''))
  const ratioRow = noteRows.find((row) => row.includes('占比与命中率都是本机实测 tokens 的比值'))
  ok('T012 比例口径脚注渲染出来了', ratioRow !== undefined, noteRows.join(' | '))
  ok('T012 脚注含两条公式（命中率分母三项 / 占比分母区间总量）',
    ratioRow !== undefined
      && ratioRow.includes('缓存命中率 = 缓存命中 ÷ (输入 + 缓存命中 + 缓存写入)')
      && ratioRow.includes('各自 ÷ 区间 tokens 总量'), String(ratioRow))
  ok('T012 脚注明说不是配额比例', String(ratioRow).includes('不是配额比例'), String(ratioRow))
  const text = collectText(tree).join(' ')
  ok('T012 全屏不出现「还剩」类措辞', !/还剩|剩余/.test(text), text.slice(0, 400))
}
{
  const bundle = await mountUsage({ lang: 'en-US' })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const text = collectText(tree).join(' ')
  ok('T012 en：总量卡标签与占比模板（of total）',
    text.includes('input 600K 60% of total') && text.includes('output 300K 30% of total')
      && text.includes('cache hit 100K 10% of total'), text.slice(0, 500))
  ok('T012 en：缓存命中率标签与数值', text.includes('cache hit rate 14.3%'), text.slice(0, 500))
  ok('T012 en：模型行中文标签换成英文',
    text.includes('input 400K (61.5%) · output 200K (30.8%) · cache hit 50K (7.7%) · cache write 0 · hit rate 11.1%'),
    text.slice(0, 900))
  ok('T012 en：比例脚注是英文且含两条公式',
    text.includes('cache hit rate = cache hit ÷ (input + cache hit + cache write)')
      && text.includes('each ÷ total tokens in the range'), text.slice(-500))
  ok('T012 en：整屏无中文（en 不是中文兜底）', !/[\u3400-\u9fff]/u.test(text), text.slice(0, 400))
}

/* SC-007 边界：关闭态与错误态都不渲染比例口径脚注（没有数据就不谈口径）。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, enabled: false, emptyReason: 'usage-stats-disabled' })),
  })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('T012 关闭态不渲染比例口径脚注', !text.includes('占比与命中率都是本机实测'), text.slice(0, 300))
}
{
  const failing = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    return { ok: false, status: 500, json: async () => ({}) }
  }
  const bundle = await mountUsage({ fetchImpl: failing })
  resetHooks()
  const text = collectText(await settle(bundle.renderUsage, 5)).join(' ')
  ok('T012 错误态不渲染比例口径脚注', !text.includes('占比与命中率都是本机实测'), text.slice(0, 300))
}

/* ======================================================== T013（012 复核）
 *
 * OpenCodeReview 对 011/012 增量的复核结论里，能在测试里钉住的部分都在这里回归：
 * 0 值占比、命中率分母共享、图表与浮层的无障碍钩子、3D 命中区几何、模型行脏数据、浮层字体变量。
 */

/* #10 / #2：占比白名单段的 0 值纪律与命中率分母共享。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  const internals = bundle.api.__internals
  const shareOf = { usageShareOf: '占 {percent}' }
  check('T013 占比 0 / 负数 / 非数一律空串（不印「占 0%」）',
    [internals.usageShareText(shareOf, 0, 1000), internals.usageShareText(shareOf, -5, 1000),
      internals.usageShareText(shareOf, NaN, 1000), internals.usageShareText(shareOf, '12', 1000),
      internals.usagePercentSuffix(0, 1000), internals.usagePercentSuffix('12', 1000)],
    ['', '', '', '', '', ''])
  check('T013 非 0 占比照旧',
    [internals.usageShareText(shareOf, 571, 1000), internals.usagePercentSuffix(571, 1000)],
    ['占 57.1%', ' (57.1%)'])
  check('T013 命中率分母是 input + cacheRead + cacheWrite 的归一和（总量卡与模型行共用）',
    [internals.usageHitRateBase({ input: 100, cacheRead: 40, cacheWrite: 10 }),
      internals.usageHitRateBase({ input: 100, cacheRead: NaN, cacheWrite: '10' }),
      internals.usageHitRateBase(null)],
    [150, 100, 0])
  check('T013 命中率文本走同一个分母',
    internals.usageHitRateText({ usageHitRate: '命中率 {percent}' }, { input: 100, cacheRead: 40, cacheWrite: 10 }),
    '命中率 26.7%')
}

/* #8：图表 role 与浮层不重复进无障碍树（柱子的 aria-label 已含全部数字）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  resetHooks()
  globalThis.window.innerWidth = 800
  globalThis.window.innerHeight = 600
  let tree = await settle(bundle.renderUsage, 4)
  const svg = findNodes(tree, 'tpq-usage-svg')[0]
  check('T013 图表 <svg> 用 role=group（role=img 会剪掉可聚焦柱子）', svg?.props?.role, 'group')
  check('T013 图表仍有可访问名称', svg?.props?.['aria-label'], '每日用量')
  tree = hoverPointer(bundle, tree, 2, 100, 120)
  check('T013 浮层上屏但 aria-hidden（读屏不会把同一个桶念两遍）',
    [tipOf(tree)?.props?.['aria-hidden'], tipOf(tree)?.props?.id], ['true', undefined])
  check('T013 柱子不再挂 aria-describedby（数字已全在 aria-label 里）',
    [barOf(tree, 2)?.props?.['aria-describedby'], barOf(tree, 1)?.props?.['aria-describedby']],
    [undefined, undefined])
  const tick = findNodes(tree, 'tpq-usage-tick')[0]
  const peak = findNodes(tree, 'tpq-usage-value')[0]
  check('T013 轴标与峰值标签标注 aria-hidden（role=group 下不再线性念一遍）',
    [tick?.props?.['aria-hidden'], peak?.props?.['aria-hidden']], ['true', 'true'])
}

/* #5 / #1：浮层坐标纯函数的边界（导出就是为了能这么钉）。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  const internals = bundle.api.__internals
  check('T013 usageTipAnchorOf 只认有限 number，null / 空串 / 数组 / 布尔一律回兜底',
    [internals.usageTipAnchorOf(120, 7), internals.usageTipAnchorOf(NaN, 7),
      internals.usageTipAnchorOf(null, 7), internals.usageTipAnchorOf('', 7),
      internals.usageTipAnchorOf('120', 7), internals.usageTipAnchorOf([], 7),
      internals.usageTipAnchorOf(true, 7), internals.usageTipAnchorOf(undefined, 7)],
    [120, 7, 7, 7, 7, 7, 7, 7])
  const rect = (left) => () => ({ left: left })
  const scroller = { firstElementChild: { getBoundingClientRect: rect(240) }, getBoundingClientRect: rect(40) }
  check('T013 usageTipInlineOffsetX = SVG 左边 − 容器左边（居中留白与横向滚动已含在差值里）',
    [internals.usageTipInlineOffsetX(scroller),
      internals.usageTipInlineOffsetX({ firstElementChild: {}, getBoundingClientRect: rect(0) }),
      internals.usageTipInlineOffsetX({ firstElementChild: null, getBoundingClientRect: rect(0) }),
      internals.usageTipInlineOffsetX(null),
      internals.usageTipInlineOffsetX({ getBoundingClientRect: rect(0) })],
    [200, 0, 0, 0, 0])
  check('T013 usageTipInlineOffsetX 绝不返回 NaN（矩形缺失 / 非数都按 0）',
    [internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: () => ({}) }, getBoundingClientRect: rect(0) }),
      internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: rect(NaN) }, getBoundingClientRect: rect(0) })],
    [0, 0])
  check('T013 usageTipInlineOffsetX 遇到「有函数但矩形是 null/undefined/非对象」也按 0（不能抛 TypeError）',
    [internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: () => null }, getBoundingClientRect: rect(0) }),
      internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: () => undefined }, getBoundingClientRect: rect(0) }),
      internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: rect(240) }, getBoundingClientRect: () => null }),
      internals.usageTipInlineOffsetX({ firstElementChild: { getBoundingClientRect: () => 240 }, getBoundingClientRect: rect(0) })],
    [0, 0, 0, 0])
  check('T013 usageFiniteToken 是唯一的归一化入口',
    [internals.usageFiniteToken(42), internals.usageFiniteToken(NaN), internals.usageFiniteToken('42'),
      internals.usageFiniteToken(null), internals.usageFiniteToken(Infinity)],
    [42, 0, 0, 0, 0])
}

/* #7：模型行 key 用 id（有 id 时），缺 id 才退到序号；空标题不挂空 title。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, models: [{ id: 'm2', model: 'm2', totals: { tokens: 10 } }, { totals: {} }] })),
  })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  const rows = findNodes(tree, 'tpq-usage-model')
  check('T013 有 id 的模型行 key 用 id（降序重排不整列重挂载）', rows[0]?.props?.key, 'model-m2')
  check('T013 缺 id 的模型行 key 退到序号且带 # 前缀（不与真实 id 撞）', rows[1]?.props?.key, 'model-#1')
  check('T013 缺 id 的行不给空 title（与可见的 — 一致）',
    [findNodes(rows[1], 'tpq-usage-model-id')[0]?.props?.title, findNodes(rows[0], 'tpq-usage-model-id')[0]?.props?.title],
    [undefined, 'm2'])
}

/* #9：3D 命中区要盖住「正面 + 向左半柱宽 + 向上一个 ISO_DEPTH」的可见足迹。 */
{
  const bundle = await mountUsage({ fetchImpl: dayFetch() })
  bundle.handle.setMode('3d')
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  const bar = barOf(tree, 2)
  const hits = findNodes(bar, 'tpq-usage-hit')
  check('T013 3D 柱仍带透明命中矩形', hits.length, 1)
  const hit = hits[0].props
  const frontXs = String(findNodes(bar, 'tpq-usage-face-front')[0]?.props?.points ?? '')
    .split(' ').map((point) => Number(String(point).split(',')[0]))
  const minX = Math.min(...frontXs)
  const barWidth = Math.max(...frontXs) - minX
  check('T013 3D 命中区往左上扩：x 减半柱宽、y 抬一个 ISO_DEPTH、宽 1.5 柱宽、高补一个 ISO_DEPTH',
    [hit.x, hit.y, hit.width, hit.height],
    [minX - barWidth / 2, 26 - 7, barWidth * 1.5, 120 + 7])
}

/* #3：模型数组是外部数据 —— 缺 id / 缺 totals 的条目也要渲染，坏一条不许把面板打成错误态。 */
{
  const bundle = await mountUsage({
    fetchImpl: usageFetch((snap) => ({ ...snap, models: [{}, null, { id: 'm2', model: 'm2', totals: null }] })),
  })
  resetHooks()
  let tree = null
  try {
    tree = await settle(bundle.renderUsage, 5)
  } catch {
    tree = null
  }
  ok('T013 模型行缺 id / 缺 totals 时渲染不抛', tree !== null)
  if (tree !== null) {
    const rows = findNodes(tree, 'tpq-usage-model')
    check('T013 三条脏模型仍各渲染一行', rows.length, 3)
    ok('T013 缺模型名的行印 — 而不是 undefined',
      collectText(rows[0]).join('').startsWith('—'), collectText(rows[0]).join('').slice(0, 40))
  }
}

/* #6：浮层 portal 到 body 之后拿不到 .tpq 上的字体变量，规则里要自带一份。 */
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('.tpq-usage-tip{')
  const rule = start < 0 ? '' : source.slice(start, source.indexOf('}', start) + 1)
  ok('T013 浮层规则自带 --tpq-font（portal 离开 .tpq 后仍是同一套字体）',
    rule.includes('--tpq-font:') && rule.includes('font-family:var(--tpq-font)'), rule.slice(0, 220))
}

/* ============================================================ 013 T101–T103 整页滚动视口
 * 用户反馈：内容 1183px 被 860px 的宿主 main 区裁掉，整屏没有垂直滚动条。
 * 契约（specs/013.../INTERFACE.md §2）：错误态短路与正常态两个 return 点都包成
 * .tpq-usage-viewport > .tpq-usage；内层 class / 顺序 / max-width 排版不动。 */
{
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  /* T101 静态钩子：截图/探针定位、读屏识别、键盘可滚。 */
  ok('T101 源码带 data-usage-scroll 钩子', code.includes('"data-usage-scroll": "1"'))
  ok('T101 视口 role 是 region（读屏能识别为区域）', code.includes('role: "region",'))
  ok('T101 视口 tabIndex: 0（可聚焦后键盘滚）', code.includes('tabIndex: 0,'))
  ok('T101 视口 aria-label 取 copy.usageTitle', code.includes('"aria-label": copy.usageTitle,'))
  check('T101 usageViewport 定义 1 处 + 两个 return 点调用 = 3 处',
    (code.match(/usageViewport\(/g) ?? []).length, 3)
  check('T101 两个 return 点都走 helper（无遗留裸根节点）',
    (code.match(/return usageViewport\(copy, blocks\);/g) ?? []).length, 2)
  ok('T101 不再有裸返回 <div className="tpq-usage"> 的 return 点',
    !/return React\.createElement\("div", \{ className: "tpq-usage" \}, blocks\);/.test(code))

  /* T102 CSS 六件 + 焦点环 + 细滚动条；不写 scrollbar-gutter:stable（会让 920px 列位移）。 */
  const viewportStart = code.indexOf('.tpq-usage-viewport{')
  const viewportRule = viewportStart < 0 ? '' : code.slice(viewportStart, code.indexOf('}', viewportStart) + 1)
  ok('T102 视口规则存在且排在 .tpq-usage 之后（只换「谁来滚」，不改内层排版）',
    viewportStart > code.indexOf('.tpq-usage{'), viewportRule.slice(0, 240))
  const cssBits = [
    ['height:100%', 'height:100%'],
    ['overflow-y:auto', 'overflow-y:auto'],
    ['overflow-x:hidden', 'overflow-x:hidden'],
    ['overscroll-behavior:contain', 'overscroll-behavior:contain'],
    ['scrollbar-width:thin', 'scrollbar-width:thin'],
  ]
  for (const [name, needle] of cssBits) ok('T102 视口规则含 ' + name, viewportRule.includes(needle), viewportRule.slice(0, 300))
  ok('T102 视口规则不写 scrollbar-gutter（避免挤压居中列）', !viewportRule.includes('scrollbar-gutter'))
  ok('T102 滚动条 thumb 圆角 + 主题色变量',
    /\.tpq-usage-viewport::-webkit-scrollbar-thumb\{[^}]*border-radius:4px[^}]*background:var\(--dsw-alias-border-l2/.test(code))
  ok('T102 滚动条宽度 8px', /\.tpq-usage-viewport::-webkit-scrollbar\{width:8px\}/.test(code))
  ok('T102 视口焦点环 2px 品牌色、内偏移（不顶开内容）',
    /\.tpq-usage-viewport:focus-visible\{[^}]*outline:2px solid var\(--dsw-alias-brand-primary[^}]*outline-offset:-2px/.test(code))
}

/* T103 两种 return 态都在假 DOM 里渲染出 .tpq-usage-viewport > .tpq-usage。 */
function viewportOf(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return null
  return String(tree.props?.className ?? '').split(/\s+/).includes('tpq-usage-viewport') ? tree : null
}
{
  /* 正常态（数据态）：视口是最外层，内层 .tpq-usage 才是既有排版根，三张卡都在它里面。 */
  const bundle = await mountUsage()
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  const viewport = viewportOf(tree)
  ok('T103 正常态最外层是 .tpq-usage-viewport', viewport !== null,
    JSON.stringify(tree?.props?.className ?? null))
  const inner = viewport?.children?.[0]
  check('T103 正常态视口只有一个内层子节点（不多包一层）', viewport?.children?.length, 1)
  check('T103 正常态内层仍是 .tpq-usage（class 与顺序不变）', inner?.props?.className, 'tpq-usage')
  check('T103 正常态内层节点仍是页面内容根（3 张数据卡都在里面）',
    findNodes(inner, 'tpq-usage-card').length, 3)
  check('T103 正常态 data-usage-scroll=1', viewport?.props?.['data-usage-scroll'], '1')
  check('T103 正常态 role=region + tabIndex=0', [viewport?.props?.role, viewport?.props?.tabIndex], ['region', 0])
  check('T103 正常态 aria-label=屏幕标题（zh）', viewport?.props?.['aria-label'], 'Token 计划用量')
}
{
  /* 错误态短路：同样包一层，否则错误屏在 375px 下也会被裁。 */
  const failing = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    return { ok: false, status: 500, json: async () => ({}) }
  }
  const bundle = await mountUsage({ fetchImpl: failing })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  const viewport = viewportOf(tree)
  ok('T103 错误态最外层也是 .tpq-usage-viewport', viewport !== null,
    JSON.stringify(tree?.props?.className ?? null))
  const inner = viewport?.children?.[0]
  check('T103 错误态内层仍是 .tpq-usage', inner?.props?.className, 'tpq-usage')
  check('T103 错误态视口只有一个内层子节点', viewport?.children?.length, 1)
  ok('T103 错误态内容（错误标题 + 重试按钮）都在内层里',
    collectText(inner).join(' ').includes('用量数据没取到') && findNodes(inner, 'tpq-usage-retry').length === 1,
    collectText(inner).join(' ').slice(0, 160))
  check('T103 错误态 aria-label 仍非空', viewport?.props?.['aria-label'], 'Token 计划用量')
}
{
  /* 英文界面 aria-label 跟随 COPY.usageTitle（不是写死中文）。 */
  const bundle = await mountUsage({ lang: 'en-US' })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 4)
  const label = viewportOf(tree)?.props?.['aria-label']
  ok('T103 en 界面 aria-label 跟随英文标题且不含中文',
    typeof label === 'string' && label.length > 0 && !/[\u4e00-\u9fff]/.test(label), String(label))
}


/* ==========================================================================
 * 014：Credits ↔ tokens 换算块（specs/014-credits-token-ratio/INTERFACE.md §3 / §4）
 * 路由 GET /token-plan-quota/usage-credits：成功恒 200，可用性由 available 区分；
 * 宿主侧路由由 host-core 并行实现，这里只按契约形状造假快照，不联网。
 * ========================================================================== */

/** 契约 §1.1 的可用态快照（数值取示例那一组，逐字断言的期望值据此算）。 */
function makeCreditsSnapshot(overrides = {}) {
  const base = {
    generatedAt: Date.now(),
    available: true,
    window: {
      key: 'monthly',
      label: '本月窗口',
      labelEn: 'Monthly window',
      from: '2026-11-01',
      to: '2026-11-14',
      resetAt: '2026-11-30T00:00:00.000Z',
      resetDay: '2026-11-30',
      cycleDays: 30,
      elapsedDays: 14,
    },
    credits: { unit: 'Credits', total: 80000, used: 37196.8802, usedPercent: 46.4961 },
    tokens: { official: 2122918870, local: 2080883520 },
    ratio: { tokensPerCredit: 57072.3, capacityTokens: 4565784000 },
    scope: { officialFrom: '2026-10-16', officialTo: '2026-11-14', officialDays: 30, cached: false, clampedFrom: null },
    source: { kind: 'credits-token', veracity: 'measured', label: '本账期实测', labelEn: 'measured this cycle' },
  }
  const merged = { ...base, ...overrides }
  for (const key of ['window', 'credits', 'tokens', 'ratio', 'scope', 'source']) {
    if (overrides[key] !== undefined) merged[key] = { ...base[key], ...overrides[key] }
  }
  return merged
}

/**
 * 专用 fetch：credits 走契约形状，本机 / 官方仍回既有假快照（否则官方块会红）。
 * options.pending / networkError / httpError / body(index, url) 用来造五种状态。
 */
function usageCreditsFetch(options = {}, mutateUsage = (snap) => snap) {
  let creditsIndex = 0
  return async (url, init) => {
    const target = String(url)
    fetchCalls.push({ url: target, method: init?.method ?? 'GET' })
    if (target.startsWith('/token-plan-quota/usage-credits')) {
      creditsIndex += 1
      if (options.pending === true) return new Promise(() => {})
      if (options.networkError === true) throw new TypeError('network down')
      if (options.httpError === true) {
        return { ok: false, status: 500, json: async () => ({ error: 'credits-unavailable' }) }
      }
      const body = typeof options.body === 'function'
        ? options.body(creditsIndex, target)
        : (options.body !== undefined ? options.body : makeCreditsSnapshot())
      return { ok: true, status: 200, json: async () => body }
    }
    const days = Number(new URL(target, 'http://localhost').searchParams.get('days')) || 7
    if (target.startsWith('/token-plan-quota/usage-official')) {
      return { ok: true, status: 200, json: async () => makeOfficialSnapshot(days) }
    }
    return { ok: true, status: 200, json: async () => mutateUsage(makeUsageSnapshot(days)) }
  }
}

function creditsRequests() {
  return fetchCalls.filter((entry) => String(entry.url).startsWith('/token-plan-quota/usage-credits'))
}

function creditsSectionOf(tree) {
  return findNodes(tree, 'tpq-usage-credits')[0]
}

function creditsTextOf(tree) {
  const section = creditsSectionOf(tree)
  return section === undefined ? '' : collectText(section).join(' ')
}

function creditsAttrNode(tree, attr) {
  const section = creditsSectionOf(tree)
  return section === undefined ? undefined : nodesWithProp(section, attr)[0]
}

async function mountCreditsScreen(options = {}) {
  const bundle = await mountUsage({
    lang: options.lang ?? 'zh-CN',
    fetchImpl: options.fetchImpl ?? usageCreditsFetch(options.credits ?? {}),
    timeoutMs: options.timeoutMs,
  })
  resetHooks()
  const tree = await settle(bundle.renderUsage, options.rounds ?? 4)
  return { bundle, tree }
}

/* ① §3.1 / §3.4 静态契约：路由常量、一次性取数的闸门、CSS 与 __internals。 */
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T014 路由常量紧跟 USAGE_OFFICIAL（同一个常量区）',
    /const USAGE_OFFICIAL = "[^"]+";[\s\S]{0,400}const USAGE_CREDITS = "\/token-plan-quota\/usage-credits";/.test(source))
  ok('T014 fresh 只在重试时拼 ?fresh=1（唯一构造路径）',
    /USAGE_CREDITS \+ \(fresh === true \? "\?fresh=1" : ""\)/.test(source))
  ok('T014 挂载只取一次用 ref 闸门（不靠依赖数组，假 React 每帧都跑 effect）',
    /if \(creditsBootRef\.current === true\) return undefined;/.test(source))
  const creditsCallSites = [...source.matchAll(/(?<!function )fetchCredits\(/g)].map((match) => match.index)
  check('T014 fetchCredits 只有「挂载」与「重试」两个调用点（不随区间重取）', creditsCallSites.length, 2)
  ok('T014 换算块按「官方对照之后、整页脚注之前」插入',
    /blocks\.push\(usageOfficialSection\([\s\S]{0,700}blocks\.push\(usageCreditsSection\(/.test(source))
  const cssRegion = source.slice(source.indexOf('.tpq-usage-credits{'), source.indexOf('@media (max-width:520px)', source.indexOf('.tpq-usage-credits{')))
  ok('T014 卡片视觉与官方条同档（边框/12px 圆角/14px 16px 内边距/12px 上间距）',
    cssRegion.includes('border:1px solid') && cssRegion.includes('border-radius:12px')
      && cssRegion.includes('padding:14px 16px') && cssRegion.includes('margin-top:12px'), cssRegion.slice(0, 260))
  ok('T014 比值 18px/600 且数字等宽（tabular-nums）',
    /\.tpq-usage-credits-ratio\{[^}]*font-size:18px;font-weight:600;[\s\S]{0,140}tabular-nums/.test(cssRegion))
  ok('T014 长文案允许任意位置折行（375px 不横向溢出）',
    (cssRegion.match(/overflow-wrap:anywhere/g) ?? []).length >= 5 && cssRegion.includes('min-width:0'),
    String((cssRegion.match(/overflow-wrap:anywhere/g) ?? []).length))
  ok('T014 换算块不写死像素宽（只随容器走）', /width:\s*\d{3,}px/.test(cssRegion) === false)
  const sectionRegion = source.slice(source.indexOf('function usageCreditsSection'), source.indexOf('function usageViewport'))
  const sectionCode = sectionRegion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok('T014 渲染函数自身不写百分比字面量（比例只走 usagePercentText）',
    sectionCode.includes('%') === false && /usagePercentText\(used, total\)/.test(sectionCode),
    (sectionCode.match(/.{0,20}%.{0,20}/g) ?? []).join(' | '))
  const internals = (await mountUsage()).api.__internals
  ok('T014 __internals 暴露 creditsPayloadState / usageCreditsSection',
    typeof internals.creditsPayloadState === 'function' && typeof internals.usageCreditsSection === 'function')
}

/* ② 契约 §1 的 200 响应分类矩阵（纯函数；别把半截数字当成功）。 */
{
  const internals = (await mountUsage()).api.__internals
  const state = internals.creditsPayloadState
  check('T014 可用态判 ready', state(makeCreditsSnapshot()).kind, 'ready')
  ok('T014 tokens.local 可为 null（不参与比值）', state(makeCreditsSnapshot({ tokens: { local: null } })).kind === 'ready')
  const unavailable = state({ available: false, reason: 'no-console-card', hint: '去控制台复制额度' })
  check('T014 available:false 判 unavailable 并保留 reason 当 code', [unavailable.kind, unavailable.code, unavailable.hint],
    ['unavailable', 'no-console-card', '去控制台复制额度'])
  const unavailableWithCode = state({ available: false, reason: 'no-console-card', code: 'credits-no-console-card' })
  check('T014 unavailable 有 code 时优先 code', unavailableWithCode.code, 'credits-no-console-card')
  const failedBody = state({ error: 'credits-unavailable', code: 'credits-console-missing', hint: 'h' })
  check('T014 200 + error 体判 error（绝不当成功数据）', [failedBody.kind, failedBody.code, failedBody.hint],
    ['error', 'credits-console-missing', 'h'])
  check('T014 null / 非对象都判 error（不炸）', [state(null).kind, state('nope').kind], ['error', 'error'])
  check('T014 缺 available 判 error', state({ generatedAt: 1 }).kind, 'error')
  check('T014 缺 window/tokens/ratio 判 error',
    ['window', 'tokens', 'ratio'].map((key) => state({ ...makeCreditsSnapshot(), [key]: null }).kind), ['error', 'error', 'error'])
  check('T014 total 为 0 / 负数 / 非有限判 error',
    [state(makeCreditsSnapshot({ credits: { total: 0 } })).kind,
      state(makeCreditsSnapshot({ credits: { total: -1 } })).kind,
      state(makeCreditsSnapshot({ credits: { total: 'x' } })).kind,
      state(makeCreditsSnapshot({ credits: { used: -1 } })).kind,
      state(makeCreditsSnapshot({ ratio: { tokensPerCredit: 0 } })).kind,
      state(makeCreditsSnapshot({ tokens: { official: -5 } })).kind], ['error', 'error', 'error', 'error', 'error', 'error'])
}

/* ③ §4：就绪态中文逐字（数值格式按 formatTokens / usageCount / usagePercentText 的真实口径）。 */
{
  const { tree } = await mountCreditsScreen()
  const section = creditsSectionOf(tree)
  ok('T014 有快照时渲染换算块', section !== undefined)
  check('T014 section 钩子 data-usage-credits', section?.props?.['data-usage-credits'], '1')
  check('T014 尚未切区间，data-stale=0', section?.props?.['data-stale'], '0')
  check('T014 标题逐字（zh）', collectText(findNodes(section, 'tpq-usage-credits-title')[0]).join(''),
    'Credits 与 tokens 换算')
  check('T014 整屏只有一块换算（标题只出现一次）', findNodes(tree, 'tpq-usage-credits-title').length, 1)
  check('T014 比值行逐字（57072.3 → 5.7万）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
  check('T014 账期行逐字',
    collectText(creditsAttrNode(tree, 'data-usage-credits-window')).join(''),
    '本账期 2026-11-01 起至今 · 官方额度 2026-11-30 重置')
  check('T014 明细行逐字（官方 tokens / 已用 Credits / 官方已用比例）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-detail')).join(''),
    '官方账号 tokens 21.23亿 · 已用 Credits 37197 / 80000（46.5%）')
  check('T014 折算行逐字（明写非官方口径）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-estimate')).join(''),
    '按本账期实测比值，80000 Credits 约合 45.66亿 tokens（折算参考，非官方口径）')
  check('T014 口径脚注逐字（比值定义 + 混合口径均值）',
    collectText(findNodes(section, 'tpq-usage-credits-note')[0]).join(''),
    '比值 = 官方账号 tokens ÷ 已用 Credits；已用 Credits = 官方额度 × 官方已用比例。分项按官方口径拆成缓存命中 / 未命中输入 / 输出（官方 input 含缓存命中，这里相减后单列），三者相加等于官方 tokens。它是本账期的混合口径均值，随模型与缓存命中率变化，不是固定兑换率。')
  check('T014 就绪态不给重试按钮', nodesWithProp(section, 'data-usage-credits-retry').length, 0)
  ok('T014 就绪态不带 unavailable / error 钩子',
    nodesWithProp(section, 'data-usage-credits-unavailable').length === 0
      && nodesWithProp(section, 'data-usage-credits-error').length === 0)
  const creditsText = creditsTextOf(tree)
  ok('T014 就绪态没有占位符残留（{tokens}/{percent}…）', !/\{[a-zA-Z]+\}/.test(creditsText), creditsText)
  ok('T014 就绪态不含未取整的长小数（37196.8802 不上屏）', !creditsText.includes('37196.88'), creditsText)
  ok('T014 明细的百分比 = usagePercentText(used, total) 的同一口径',
    collectText(creditsAttrNode(tree, 'data-usage-credits-detail')).join('').includes('（46.5%）'))
}

/* ④ §4：就绪态英文逐字，且英文界面不混中文。 */
{
  const { tree } = await mountCreditsScreen({ lang: 'en-US' })
  check('T014 en 标题', collectText(findNodes(tree, 'tpq-usage-credits-title')[0]).join(''), 'Credits ↔ tokens')
  check('T014 en 比值行（57072.3 → 57K）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 credit ≈ 57K tokens')
  check('T014 en 账期行',
    collectText(creditsAttrNode(tree, 'data-usage-credits-window')).join(''),
    'Cycle from 2026-11-01 · allowance resets 2026-11-30')
  check('T014 en 明细行',
    collectText(creditsAttrNode(tree, 'data-usage-credits-detail')).join(''),
    'Official tokens 2.12B · credits used 37197 / 80000 (46.5%)')
  check('T014 en 折算行',
    collectText(creditsAttrNode(tree, 'data-usage-credits-estimate')).join(''),
    "At this cycle's measured ratio, 80000 credits ≈ 4.57B tokens (derived, not official)")
  ok('T014 en 换算块整段无中文', !/[\u3400-\u9fff]/u.test(creditsTextOf(tree)), creditsTextOf(tree))
  ok('T014 en 脚注是英文',
    /blended average/.test(collectText(findNodes(tree, 'tpq-usage-credits-note')[0]).join('')))
}

/* ⑤ §4：数字格式（万/亿、千分位、百分比；四舍五入口径与相邻卡片同源）。 */
{
  const { tree } = await mountCreditsScreen({
    credits: {
      body: makeCreditsSnapshot({
        credits: { total: 8000, used: 4000 },
        tokens: { official: 8000, local: null },
        ratio: { tokensPerCredit: 8000, capacityTokens: 45600 },
      }),
    },
  })
  check('T014 千分位：8000 → 8,000',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 8,000 tokens')
  check('T014 明细同时用千分位与已用百分比',
    collectText(creditsAttrNode(tree, 'data-usage-credits-detail')).join(''),
    '官方账号 tokens 8,000 · 已用 Credits 4000 / 8000（50%）')
  check('T014 折算行按 formatTokens 输出（45600 → 4.6万）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-estimate')).join(''),
    '按本账期实测比值，8000 Credits 约合 4.6万 tokens（折算参考，非官方口径）')
}
{
  const { tree } = await mountCreditsScreen({
    credits: { body: makeCreditsSnapshot({ credits: { total: 80000, used: 0 } }) },
  })
  const zeroDetail = collectText(creditsAttrNode(tree, 'data-usage-credits-detail')).join('')
  ok('T014 used=0 时明细显示 0%', zeroDetail.includes('（0%）'), zeroDetail)
  check('T014 used=0 仍显示比值',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
}

/* ⑥ §4：加载态（挂载即 loading，只发一条请求；多帧 render 不重复取数）。 */
{
  const { tree } = await mountCreditsScreen({ credits: { pending: true }, timeoutMs: 50, rounds: 1 })
  const section = creditsSectionOf(tree)
  check('T014 loading 态文本', collectText(findNodes(section, 'tpq-usage-credits-loading')[0]).join(''),
    '正在读取 Credits 换算…')
  check('T014 loading 态不显示数字行', nodesWithProp(section, 'data-usage-credits-ratio').length, 0)
  check('T014 loading 态不给重试按钮', nodesWithProp(section, 'data-usage-credits-retry').length, 0)
  check('T014 挂载只发一条 Credits 请求', creditsRequests().length, 1)
  check('T014 首取不带 ?fresh=1', creditsRequests()[0]?.url, '/token-plan-quota/usage-credits')
}

/* ⑦ §4：不可用态 —— 中文附宿主 hint，英文不透传中文 hint；两态都可重试。 */
{
  const body = { available: false, reason: 'no-console-card', code: 'credits-no-console-card', hint: '打开 Token Plan 控制台复制额度' }
  const { tree } = await mountCreditsScreen({ credits: { body } })
  const section = creditsSectionOf(tree)
  check('T014 unavailable 文本 = 主文案 + · + hint（zh）',
    collectText(nodesWithProp(section, 'data-usage-credits-unavailable')[0]).join(''),
    '本账期换算暂不可用 · 打开 Token Plan 控制台复制额度')
  check('T014 unavailable 有重试按钮', nodesWithProp(section, 'data-usage-credits-retry').length, 1)
  check('T014 unavailable 不给 error 钩子', nodesWithProp(section, 'data-usage-credits-error').length, 0)
  check('T014 unavailable 不渲染数字行', nodesWithProp(section, 'data-usage-credits-detail').length, 0)
  ok('T014 unavailable 回包 code 原文不上屏', !creditsTextOf(tree).includes('credits-no-console-card'), creditsTextOf(tree))
}
{
  const body = { available: false, reason: 'no-console-card', hint: '打开 Token Plan 控制台复制额度' }
  const { tree } = await mountCreditsScreen({ lang: 'en-US', credits: { body } })
  const section = creditsSectionOf(tree)
  check('T014 en unavailable 文本（中文 hint 不透传）',
    collectText(nodesWithProp(section, 'data-usage-credits-unavailable')[0]).join(''), 'Conversion unavailable this cycle')
  ok('T014 en unavailable 整段无中文', !/[\u3400-\u9fff]/u.test(creditsTextOf(tree)), creditsTextOf(tree))
}

/* ⑧ §4：错误态（HTTP 失败 / 坏形状）与重试 —— 重试带 ?fresh=1。 */
{
  const { tree } = await mountCreditsScreen({ credits: { httpError: true } })
  const section = creditsSectionOf(tree)
  const errorNode = nodesWithProp(section, 'data-usage-credits-error')[0]
  ok('T014 HTTP 失败进 error 态（主文案 + 重试）', errorNode !== undefined
    && collectText(errorNode).join('') === '本账期换算暂不可用'
    && nodesWithProp(section, 'data-usage-credits-retry').length === 1, creditsTextOf(tree))
  ok('T014 error 态不回显宿主 code / HTTP 状态码',
    !/credits-unavailable|500|http/i.test(creditsTextOf(tree)), creditsTextOf(tree))
  ok('T014 error 态没有传输层文案混进屏里', !creditsTextOf(tree).includes('network down'), creditsTextOf(tree))
}
{
  const { tree } = await mountCreditsScreen({ credits: { body: { available: true } } })
  const section = creditsSectionOf(tree)
  ok('T014 坏形状（available:true 但缺数字）退 error，不渲染半截数字',
    nodesWithProp(section, 'data-usage-credits-error')[0] !== undefined
      && nodesWithProp(section, 'data-usage-credits-ratio').length === 0, creditsTextOf(tree))
}
{
  /* 重试：第一回不可用，第二回可用 —— 按钮真的重新取数、带 fresh=1、数字落地。 */
  const { bundle, tree: firstTree } = await mountCreditsScreen({
    credits: {
      body: (index) => (index === 1
        ? { available: false, reason: 'no-console-card', code: 'credits-no-console-card', hint: '' }
        : makeCreditsSnapshot()),
    },
  })
  ok('T014 重试前是不可用态', creditsTextOf(firstTree).includes('本账期换算暂不可用'))
  const before = creditsRequests().length
  nodesWithProp(creditsSectionOf(firstTree), 'data-usage-credits-retry')[0].props.onClick()
  const tree = await settle(bundle.renderUsage, 4)
  check('T014 点重试只多发一条 Credits 请求', creditsRequests().length, before + 1)
  ok('T014 重试请求带 ?fresh=1', String(creditsRequests()[before]?.url).endsWith('/usage-credits?fresh=1'),
    String(creditsRequests()[before]?.url))
  check('T014 重试成功后比值落地',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
  ok('T014 重试成功后不再显示不可用态', !creditsTextOf(tree).includes('本账期换算暂不可用'), creditsTextOf(tree))
}

/* ⑨ §4：切 30 天 / 换区间不重取 Credits（账期口径与本屏查询区间解耦），data-stale 跟随本屏数据。 */
{
  const { bundle, tree: firstTree } = await mountCreditsScreen({ rounds: 4 })
  const dayPresets = findNodes(firstTree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)
  ok('T014 找到天数预设按钮（1/7/30/90）', dayPresets.length >= 3, String(dayPresets.length))
  const creditsBefore = creditsRequests().length
  const usageBefore = usageRequests().length
  dayPresets[2].props.onClick()
  const tree = await settle(bundle.renderUsage, 4)
  check('T014 切 30 天不重取 Credits', creditsRequests().length, creditsBefore)
  ok('T014 切 30 天照旧重取本机用量（别的块没被连累）', usageRequests().length > usageBefore,
    usageRequests().length + ' vs ' + usageBefore)
  check('T014 切天后换算块数字不变（本账期口径）',
    collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
}
{
  /* data-stale：宿主回的仍是 7 天快照而屏上问的是 30 天 → 本屏数据在换 → 换算块置灰；
     回到 7 天重新对齐后恢复。 */
  const { bundle, tree: firstTree } = await mountCreditsScreen({
    fetchImpl: usageCreditsFetch({}, () => makeUsageSnapshot(7)),
  })
  check('T014 数据对齐时 data-stale=0', creditsSectionOf(firstTree)?.props?.['data-stale'], '0')
  findNodes(firstTree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)[2].props.onClick()
  const staleTree = await settle(bundle.renderUsage, 4)
  check('T014 本屏数据未对齐时换算块 data-stale=1', creditsSectionOf(staleTree)?.props?.['data-stale'], '1')
  check('T014 stale 只置灰、不丢数字（比值仍可读）',
    collectText(creditsAttrNode(staleTree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
  const presetsBack = findNodes(staleTree, 'tpq-usage-day').filter((node) => node.props?.['data-usage-preset'] === undefined)
  presetsBack[1].props.onClick()
  const backTree = await settle(bundle.renderUsage, 4)
  const backSection = creditsSectionOf(backTree)
  check('T014 回到 7 天、快照对齐后 data-stale 回 0',
    backSection === undefined ? 'missing' : backSection.props?.['data-stale'], '0')
}

/* ⑩ 位置与状态隔离：换算块在官方对照之后、脚注之前；本机错误态不渲染它。 */
{
  const { tree } = await mountCreditsScreen()
  const usageRoot = findNodes(tree, 'tpq-usage')[0]
  const classes = (usageRoot?.children ?? []).map((child) => String(child?.props?.className ?? ''))
  const officialIndex = classes.findIndex((value) => value.includes('tpq-usage-official'))
  const creditsIndex = classes.findIndex((value) => value.includes('tpq-usage-credits'))
  const notesIndex = classes.findIndex((value) => value.includes('tpq-usage-notes'))
  ok('T014 位置：官方对照 → Credits 换算 → 整页脚注',
    officialIndex >= 0 && creditsIndex > officialIndex && notesIndex > creditsIndex, JSON.stringify(classes))
}
{
  const failing = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    return { ok: false, status: 500, json: async () => ({}) }
  }
  const bundle = await mountUsage({ fetchImpl: failing })
  resetHooks()
  const tree = await settle(bundle.renderUsage, 5)
  check('T014 本机数据错误态不渲染换算块（错误态独占整屏）', creditsSectionOf(tree), undefined)
}

/* ===== 015 分项比值 + 按模型比值（INTERFACE §3.1-§3.4）=====
 * 数据形状照契约 §2：ratio.classes 三类官方口径、ratio.models 本机口径（已按 tokens 降序）。
 * 这里不重复 014 的五行业务断言，只在「新旧同屏」时确认五行没被挤掉。 */
function makeCreditsBreakdownSnapshot(overrides = {}) {
  const ratio = {
    tokensPerCredit: 57072.3,
    capacityTokens: 4565784000,
    classes: {
      uncachedInput: { tokens: 73542478, perCredit: 1977.11 },
      cacheRead: { tokens: 2039167232, perCredit: 54820.92 },
      output: { tokens: 10209160, perCredit: 274.46 },
    },
    modelsBasis: 'local',
    models: [
      { id: 'qwen3-max-2026-09-01', provider: 'qwen', model: 'qwen3-max', tokens: 1313000000, calls: 1200, tokensPerCredit: 35305.2 },
      { id: 'deepseek-v4.1', provider: 'deepseek', model: 'deepseek-v4.1', tokens: 350000000, calls: 800, tokensPerCredit: 9411.9 },
      { id: 'qwen3-coder', provider: 'qwen', model: 'qwen3-coder', tokens: 12000000, calls: 40, tokensPerCredit: 322.6 },
    ],
  }
  return makeCreditsSnapshot({ ratio: { ...ratio, ...(overrides.ratio ?? {}) } })
}

async function mountBreakdown(credits, options = {}) {
  return mountCreditsScreen({ ...options, credits: { body: credits } })
}

/* ① 静态契约：钩子、__internals、CSS 五件、渲染段无百分比字面量。 */
{
  const bundle = await mountUsage()
  const internals = bundle.api.__internals
  ok('T015 __internals 暴露分项行与模型块纯函数',
    typeof internals.usageCreditsClassesLine === 'function'
    && typeof internals.usageCreditsModelsBlock === 'function')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T015 三个 data 钩子与 data-model 落地',
    source.includes('"data-usage-credits-classes": "1"')
    && source.includes('"data-usage-credits-models": "1"')
    && source.includes('"data-usage-credits-model": "1"')
    && source.includes('"data-model": id'))
  ok('T015 COPY 四个新键 + 改写脚注都带分项口径',
    source.includes('usageCreditsClasses: "每 Credit 的分项（tokens）："')
    && source.includes('usageCreditsClassUncached: "未命中输入"')
    && source.includes('usageCreditsModelsTitle: "每个模型各自的比值"')
    && source.includes('usageCreditsModelsNote: "模型行 = 本机该模型 tokens')
    && source.includes('分项按官方口径拆成缓存命中 / 未命中输入 / 输出'))
  const cssStart = source.indexOf('.tpq-usage-credits-classes{')
  const cssEnd = source.indexOf('@media (max-width:520px)', cssStart)
  const creditsCss = cssStart >= 0 && cssEnd > cssStart ? source.slice(cssStart, cssEnd) : ''
  ok('T015 CSS 分项行 12px 弱化色',
    /\.tpq-usage-credits-classes\{[^}]*font-size:12px;[\s\S]{0,160}label-secondary/.test(creditsCss))
  ok('T015 CSS 模型块定高内滚（252px / auto / contain / thin / scrollbar-color）',
    /\.tpq-usage-credits-models\{[^}]*max-height:252px;[\s\S]{0,120}overflow-y:auto;[\s\S]{0,160}overscroll-behavior:contain;[\s\S]{0,160}scrollbar-width:thin;[\s\S]{0,200}scrollbar-color:var\(--dsw-alias-border-l2/.test(creditsCss))
  ok('T015 CSS 细滚动条 8px + thumb 圆角 + 焦点环',
    creditsCss.includes('.tpq-usage-credits-models::-webkit-scrollbar{width:8px}')
    && /\.tpq-usage-credits-models::-webkit-scrollbar-thumb\{[^}]*border-radius:4px/.test(creditsCss)
    && /\.tpq-usage-credits-models:focus-visible\{[^}]*outline:2px solid/.test(creditsCss))
  ok('T015 CSS 标题 12.5px / 行 flex gap 8px / name 省略 / 数字 nowrap+tabular / 脚注 10.5px',
    /\.tpq-usage-credits-models-title\{[^}]*margin:0 0 4px;[^}]*font-size:12.5px/.test(creditsCss)
    && /\.tpq-usage-credits-model\{[^}]*display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline/.test(creditsCss)
    && /\.tpq-usage-credits-model-name\{[^}]*overflow:hidden;text-overflow:ellipsis;[\s\S]{0,80}white-space:nowrap/.test(creditsCss)
    && /\.tpq-usage-credits-model-tokens,\.tpq-usage-credits-model-ratio\{[^}]*white-space:nowrap;[\s\S]{0,120}tabular-nums/.test(creditsCss)
    && /\.tpq-usage-credits-models-note\{[^}]*font-size:10.5px/.test(creditsCss))
  const fnStart = source.indexOf('function usageCreditsClassesLine')
  const fnEnd = source.indexOf('function usageCreditsSection')
  const fnRegion = fnStart >= 0 && fnEnd > fnStart ? source.slice(fnStart, fnEnd) : ''
  const codeOnly = fnRegion.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  ok('T015 两个渲染函数里没有百分比字面量', codeOnly !== '' && !codeOnly.includes('%'), codeOnly.slice(0, 200))
}

/* ② 中文就绪态：分项行逐字、模型块结构/顺序/三 span、与 014 五行同屏。 */
{
  const { tree } = await mountBreakdown(makeCreditsBreakdownSnapshot())
  const section = creditsSectionOf(tree)
  const classesLine = nodesWithProp(section, 'data-usage-credits-classes')[0]
  ok('T015 zh 分项行存在且 class 正确',
    classesLine !== undefined && String(classesLine.props.className).includes('tpq-usage-credits-classes'))
  check('T015 zh 分项行逐字（formatTokens 口径：5.5万 / 1,977 / 274.46）',
    collectText(classesLine).join(''),
    '每 Credit 的分项（tokens）：缓存命中 5.5万 · 未命中输入 1,977 · 输出 274.46')
  ok('T015 zh 分项行不出现百分比', !collectText(classesLine).join('').includes('%'))
  const modelsBlock = nodesWithProp(section, 'data-usage-credits-models')[0]
  ok('T015 zh 模型块存在', modelsBlock !== undefined)
  check('T015 模型块 tabIndex / role / aria-label',
    [modelsBlock.props.tabIndex, modelsBlock.props.role, modelsBlock.props['aria-label']],
    [0, 'group', '每个模型各自的比值'])
  check('T015 模型块标题逐字', collectText(findNodes(modelsBlock, 'tpq-usage-credits-models-title')[0]).join(''), '每个模型各自的比值')
  check('T015 模型块脚注逐字',
    collectText(findNodes(modelsBlock, 'tpq-usage-credits-models-note')[0]).join(''),
    '模型行 = 本机该模型 tokens ÷ 本账期已用 Credits（官方不按模型拆分，这是贡献值）；每行的输入 / 缓存命中 / 输出各自是「该模型这一类 tokens ÷ 同一个账号级分母」，三者相加等于该行总量。各行相加约等于本机总量，与账号级官方总量有少量差额。')
  const rows = findNodes(modelsBlock, 'tpq-usage-credits-model')
  check('T015 模型行数不截断（三条入参 → 三行）', rows.length, 3)
  check('T015 模型行顺序严格照宿主（降序，不重排）',
    rows.map((row) => row.props['data-model']),
    ['qwen3-max-2026-09-01', 'deepseek-v4.1', 'qwen3-coder'])
  ok('T015 模型行不带 role', rows.every((row) => row.props.role === undefined))
  const firstRow = rows[0]
  check('T015 首行三 span 文本（name / tokens / ratio）',
    [collectText(findNodes(firstRow, 'tpq-usage-credits-model-name')[0]).join(''),
      collectText(findNodes(firstRow, 'tpq-usage-credits-model-tokens')[0]).join(''),
      collectText(findNodes(firstRow, 'tpq-usage-credits-model-ratio')[0]).join('')],
    ['qwen3-max-2026-09-01', '13.13亿 tokens', '1 Credit ≈ 3.5万 tokens'])
  check('T015 name span 的 title 是 id 全名',
    findNodes(firstRow, 'tpq-usage-credits-model-name')[0].props.title, 'qwen3-max-2026-09-01')
  check('T015 第二行 tokens / ratio（3.50亿 / 9,412）',
    [collectText(findNodes(rows[1], 'tpq-usage-credits-model-tokens')[0]).join(''),
      collectText(findNodes(rows[1], 'tpq-usage-credits-model-ratio')[0]).join('')],
    ['3.50亿 tokens', '1 Credit ≈ 9,412 tokens'])
  check('T015 第三行 tokens / ratio（1200.0万 / 322.6）',
    [collectText(findNodes(rows[2], 'tpq-usage-credits-model-tokens')[0]).join(''),
      collectText(findNodes(rows[2], 'tpq-usage-credits-model-ratio')[0]).join('')],
    ['1200.0万 tokens', '1 Credit ≈ 322.6 tokens'])
  const seq = (section.children ?? []).map((child) => String(child?.props?.className ?? ''))
  check('T015 块内顺序：detail → classes → estimate → models → note',
    seq,
    ['tpq-usage-credits-title', 'tpq-usage-credits-ratio', 'tpq-usage-credits-window',
      'tpq-usage-credits-detail', 'tpq-usage-credits-classes', 'tpq-usage-credits-estimate',
      'tpq-usage-credits-models', 'tpq-usage-credits-note'])
  check('T015 014 总量比值行未变', collectText(creditsAttrNode(tree, 'data-usage-credits-ratio')).join(''), '1 Credit ≈ 5.7万 tokens')
  ok('T015 014 五行仍在（ratio/window/detail/estimate/note）',
    ['data-usage-credits-ratio', 'data-usage-credits-window', 'data-usage-credits-detail',
      'data-usage-credits-estimate'].every((attr) => nodesWithProp(section, attr).length === 1)
    && findNodes(section, 'tpq-usage-credits-note').length === 1)
}

/* ③ 英文就绪态：逐字、无汉字/万/亿。 */
{
  const { tree } = await mountBreakdown(makeCreditsBreakdownSnapshot(), { lang: 'en-US' })
  const section = creditsSectionOf(tree)
  check('T015 en 分项行逐字（55K / 2.0K / 274.46）',
    collectText(nodesWithProp(section, 'data-usage-credits-classes')[0]).join(''),
    'Per credit by class (tokens): cache hit 55K · uncached input 2.0K · output 274.46')
  const modelsBlock = nodesWithProp(section, 'data-usage-credits-models')[0]
  check('T015 en 模型块 aria-label 用英文标题',
    [modelsBlock.props['aria-label'], collectText(findNodes(modelsBlock, 'tpq-usage-credits-models-title')[0]).join('')],
    ['Ratio per model', 'Ratio per model'])
  const rows = findNodes(modelsBlock, 'tpq-usage-credits-model')
  check('T015 en 首行 tokens / ratio',
    [collectText(findNodes(rows[0], 'tpq-usage-credits-model-tokens')[0]).join(''),
      collectText(findNodes(rows[0], 'tpq-usage-credits-model-ratio')[0]).join('')],
    ['1.31B tokens', '1 credit ≈ 35K tokens'])
  ok('T015 en 模型块没有汉字与万/亿',
    !/[\u3400-\u9fff]|万|亿/.test(collectText(modelsBlock).join('')), collectText(modelsBlock).join(''))
  ok('T015 en 脚注写清 official 不按模型拆分', /not split by model/.test(collectText(modelsBlock).join('')))
}

/* ④ 降级矩阵：缺字段/空数组/非有限一律整块不渲染，且不抛错。 */
{
  const cases = [
    ['014 旧形状无 classes/models', makeCreditsSnapshot(), 0, 0],
    ['classes 非对象', makeCreditsBreakdownSnapshot({ ratio: { classes: 'nope' } }), 0, 1],
    ['classes 缺 output', makeCreditsBreakdownSnapshot({ ratio: { classes: { cacheRead: { perCredit: 1 }, uncachedInput: { perCredit: 2 } } } }), 0, 1],
    ['classes 的 perCredit 非有限', makeCreditsBreakdownSnapshot({ ratio: { classes: { cacheRead: { perCredit: 1 }, uncachedInput: { perCredit: 2 }, output: { perCredit: NaN } } } }), 0, 1],
    ['models 空数组', makeCreditsBreakdownSnapshot({ ratio: { models: [] } }), 1, 0],
    ['models 非数组', makeCreditsBreakdownSnapshot({ ratio: { models: 'nope' } }), 1, 0],
    ['models 全无有限 perCredit', makeCreditsBreakdownSnapshot({ ratio: { models: [{ id: 'a', tokens: 10, tokensPerCredit: NaN }] } }), 1, 0],
    ['classes 与 models 都没有（但 ratio 还在）', makeCreditsBreakdownSnapshot({ ratio: { classes: undefined, models: undefined } }), 0, 0],
  ]
  for (const [label, credits, expectedClasses, expectedModels] of cases) {
    const { tree } = await mountBreakdown(credits)
    const section = creditsSectionOf(tree)
    check('T015 降级 ' + label + '：分项行数量', nodesWithProp(section, 'data-usage-credits-classes').length, expectedClasses)
    check('T015 降级 ' + label + '：模型块数量', nodesWithProp(section, 'data-usage-credits-models').length, expectedModels)
    check('T015 降级 ' + label + '：014 比值行仍在', nodesWithProp(section, 'data-usage-credits-ratio').length, 1)
  }
}

/* ⑤ 模型行只收能算的：混合入参下跳过非有限行，顺序仍是宿主顺序。 */
{
  const models = [
    { id: 'small-first', tokens: 100, tokensPerCredit: 2.5 },
    { id: 'broken', tokens: 900, tokensPerCredit: undefined },
    { id: 'big-second', tokens: 10000, tokensPerCredit: 250 },
  ]
  const { tree } = await mountBreakdown(makeCreditsBreakdownSnapshot({ ratio: { models } }))
  const rows = findNodes(creditsSectionOf(tree), 'tpq-usage-credits-model')
  check('T015 混合入参：跳过非有限行且保持宿主顺序',
    rows.map((row) => row.props['data-model']), ['small-first', 'big-second'])
  check('T015 混合入参：行数', rows.length, 2)
}

/* ===== 016 模型行第二行：按类摊开的每 Credit 比值（INTERFACE §3）=====
 * 数据形状照 §2：models[i].classes 四键（input/cacheRead/output/cacheWrite），每键 { tokens, perCredit }。
 * 渲染只依赖三个必填类的 perCredit；cacheWrite 是可选第四段（有限且 > 0 才追加）。
 * 与 015 的行语义互不影响：第一行三个 span 照旧，第二行整行换行。 */
function modelClasses(input, cacheRead, output, cacheWrite) {
  const cell = (perCredit) => ({ tokens: 1, perCredit })
  const classes = { input: cell(input), cacheRead: cell(cacheRead), output: cell(output) }
  if (cacheWrite !== undefined) classes.cacheWrite = cell(cacheWrite)
  return classes
}

function modelWith(classes, overrides = {}) {
  return { id: 'm', provider: 'qwen', model: 'qwen3-max', tokens: 1000, calls: 1, tokensPerCredit: 10, classes, ...overrides }
}

async function mountModelClasses(models, options = {}) {
  return mountBreakdown(makeCreditsBreakdownSnapshot({ ratio: { models } }), options)
}

/* ① 静态契约：COPY 两键 + 改写脚注、钩子、__internals、CSS 两件、渲染段无 %。 */
{
  const bundle = await mountUsage()
  const internals = bundle.api.__internals
  ok('T016 __internals 暴露模型行第二行纯函数', typeof internals.usageCreditsModelClassesLine === 'function')
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('T016 COPY 两键与改写脚注（zh）',
    source.includes('usageCreditsModelClasses: "每 Credit：输入 {input} · 缓存命中 {cacheRead} · 输出 {output}"')
    && source.includes('usageCreditsModelClassWrite: " · 缓存写入 {tokens}"')
    && source.includes('每行的输入 / 缓存命中 / 输出各自是「该模型这一类 tokens ÷ 同一个账号级分母」，三者相加等于该行总量'))
  ok('T016 COPY 两键与改写脚注（en，全 ASCII）',
    source.includes('usageCreditsModelClasses: "Per credit: input {input} · cache hit {cacheRead} · output {output}"')
    && source.includes('usageCreditsModelClassWrite: " · cache write {tokens}"')
    && source.includes("each row's input / cache hit / output is that class's tokens for the model over the same account-level denominator"))
  ok('T016 第二行钩子与类名落地',
    source.includes('"data-usage-credits-model-classes": "1"')
    && source.includes('className: "tpq-usage-credits-model-classes"'))
  const cssStart = source.indexOf('.tpq-usage-credits-model{')
  const cssEnd = source.indexOf('.tpq-usage-credits-models-note{', cssStart)
  const modelCss = cssStart >= 0 && cssEnd > cssStart ? source.slice(cssStart, cssEnd) : ''
  ok('T016 CSS 模型行 flex-wrap + 2px 8px 行内间距',
    /\.tpq-usage-credits-model\{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;padding:2px 0;font-size:12px\}/.test(modelCss))
  ok('T016 CSS 第二行整行换行 / 10.5px / 弱化色 / tabular',
    /\.tpq-usage-credits-model-classes\{flex:0 0 100%;font-size:10.5px;line-height:1.6;overflow-wrap:anywhere;[\s\S]{0,120}label-tertiary[^}]*font-variant-numeric:lining-nums tabular-nums\}/.test(modelCss))
  const fnStart = source.indexOf('function usageCreditsModelClassesLine')
  const fnEnd = source.indexOf('function usageCreditsModelsBlock', fnStart)
  const fnSource = fnStart >= 0 && fnEnd > fnStart ? source.slice(fnStart, fnEnd) : ''
  const stripped = fnSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  ok('T016 第二行渲染段（剥注释后）无 % 字面量', stripped.length > 0 && !stripped.includes('%'), stripped.includes('%') ? stripped : '')
}

/* ② 中文就绪态：逐字、四段追加、0 值照实、缺 classes 不渲染。 */
{
  const models = [
    modelWith(modelClasses(1341, 33000, 133, 250), { id: 'full' }),
    modelWith(modelClasses(0, 0, 0, 0), { id: 'zero-write' }),
    modelWith(undefined, { id: 'no-classes' }),
    modelWith(modelClasses(5, 6, 7), { id: 'no-write-key' }),
  ]
  const { tree } = await mountModelClasses(models)
  const rows = findNodes(creditsSectionOf(tree), 'tpq-usage-credits-model')
  check('T016 zh 四行都在（顺序照宿主）', rows.map((row) => row.props['data-model']), ['full', 'zero-write', 'no-classes', 'no-write-key'])
  const lineOf = (row) => findNodes(row, 'tpq-usage-credits-model-classes')
  check('T016 zh 满配行：第二行整行文本（输入 1,341 / 缓存命中 3.3万 / 输出 133 + 缓存写入 250）',
    collectText(lineOf(rows[0])[0]).join(''),
    '每 Credit：输入 1,341 · 缓存命中 3.3万 · 输出 133 · 缓存写入 250')
  ok('T016 zh 满配行：第二行是第 4 个子节点（flex 100% 会后换行）',
    rows[0].children.length === 4
    && rows[0].children[3].props.className === 'tpq-usage-credits-model-classes'
    && rows[0].children[3].props['data-usage-credits-model-classes'] === '1')
  check('T016 zh 满配行：第一行三 span 仍是 name/tokens/ratio',
    [0, 1, 2].map((i) => rows[0].children[i].props.className),
    ['tpq-usage-credits-model-name', 'tpq-usage-credits-model-tokens', 'tpq-usage-credits-model-ratio'])
  check('T016 zh cacheWrite=0：照实印三类 0，不追加第四段',
    collectText(lineOf(rows[1])[0]).join(''), '每 Credit：输入 0 · 缓存命中 0 · 输出 0')
  ok('T016 zh cacheWrite=0：文本里没有「缓存写入」', !collectText(lineOf(rows[1])[0]).join('').includes('缓存写入'))
  check('T016 zh 缺 classes（旧宿主）：不渲染第二行', lineOf(rows[2]).length, 0)
  check('T016 zh 缺 classes：该行仍是 3 个子节点', rows[2].children.length, 3)
  check('T016 zh 缺 cacheWrite 键：第二行照渲染、无第四段',
    collectText(lineOf(rows[3])[0]).join(''), '每 Credit：输入 5 · 缓存命中 6 · 输出 7')
  ok('T016 zh 所有第二行文本无 % 字面量',
    lineOf(rows[0]).concat(lineOf(rows[1]), lineOf(rows[3])).every((n) => !collectText(n).join('').includes('%')))
  ok('T016 zh 第二行不带 role / tabIndex（整行可读但不必单独聚焦）',
    lineOf(rows[0]).every((n) => n.props.role === undefined && n.props.tabIndex === undefined))
}

/* ③ 英文就绪态：逐字、全 ASCII、无万/亿。 */
{
  const models = [
    modelWith(modelClasses(1341, 33000, 133, 250), { id: 'full' }),
    modelWith(modelClasses(0, 0, 0, 0), { id: 'zero-write' }),
  ]
  const { tree } = await mountModelClasses(models, { lang: 'en-US' })
  const rows = findNodes(creditsSectionOf(tree), 'tpq-usage-credits-model')
  const lineOf = (row) => findNodes(row, 'tpq-usage-credits-model-classes')
  check('T016 en 满配行逐字（1.3K / 33K / 133 + cache write 250）',
    collectText(lineOf(rows[0])[0]).join(''),
    'Per credit: input 1.3K · cache hit 33K · output 133 · cache write 250')
  check('T016 en cacheWrite=0：不追加第四段',
    collectText(lineOf(rows[1])[0]).join(''), 'Per credit: input 0 · cache hit 0 · output 0')
  ok('T016 en 第二行无汉字 / 万 / 亿 / %',
    lineOf(rows[0]).concat(lineOf(rows[1])).every((n) => !/[\u3400-\u9fff]|万|亿|%/.test(collectText(n).join(''))))
}

/* ④ 降级矩阵：三类缺一 / 非对象 / 非有限都整行不渲染；cacheWrite 异常只影响第四段。 */
{
  const cases = [
    ['classes 非对象', 'nope'],
    ['classes 是数组', []],
    ['classes 空对象', {}],
    ['缺 input', { cacheRead: { perCredit: 2 }, output: { perCredit: 3 } }],
    ['缺 cacheRead', { input: { perCredit: 1 }, output: { perCredit: 3 } }],
    ['缺 output', { input: { perCredit: 1 }, cacheRead: { perCredit: 2 } }],
    ['input perCredit 非有限（NaN）', { input: { perCredit: NaN }, cacheRead: { perCredit: 2 }, output: { perCredit: 3 } }],
    ['cacheRead perCredit 是字符串', { input: { perCredit: 1 }, cacheRead: { perCredit: 'two' }, output: { perCredit: 3 } }],
    ['output perCredit 是 null（不是 0）', { input: { perCredit: 1 }, cacheRead: { perCredit: 2 }, output: { perCredit: null } }],
    ['output perCredit 是 Infinity', { input: { perCredit: 1 }, cacheRead: { perCredit: 2 }, output: { perCredit: Infinity } }],
  ]
  for (const [label, classes] of cases) {
    const { tree } = await mountModelClasses([modelWith(classes, { id: 'row' })])
    const section = creditsSectionOf(tree)
    check('T016 降级 ' + label + '：第二行不渲染', findNodes(section, 'tpq-usage-credits-model-classes').length, 0)
    check('T016 降级 ' + label + '：第一行照旧（行还在）', findNodes(section, 'tpq-usage-credits-model').length, 1)
    check('T016 降级 ' + label + '：第一行 tokens 仍在',
      collectText(findNodes(section, 'tpq-usage-credits-model-tokens')[0]).join(''), '1,000 tokens')
  }
  const tails = [
    ['cacheWrite=0 不追加', 0, ''],
    ['cacheWrite 负数不追加', -5, ''],
    ['cacheWrite=NaN 不追加', NaN, ''],
    ['cacheWrite 缺键不追加', undefined, ''],
    ['cacheWrite 有限正数追加', 12.5, ' · 缓存写入 12.5'],
  ]
  for (const [label, write, suffix] of tails) {
    const classes = modelClasses(1, 2, 3, write)
    const { tree } = await mountModelClasses([modelWith(classes, { id: 'row' })])
    check('T016 ' + label, collectText(findNodes(creditsSectionOf(tree), 'tpq-usage-credits-model-classes')[0]).join(''),
      '每 Credit：输入 1 · 缓存命中 2 · 输出 3' + suffix)
  }
}

/* ⑤ 015 不回归：行筛选/顺序/第一行三件与脚注位置都不受第二行影响。 */
{
  const models = [
    { id: 'big', tokens: 9000, tokensPerCredit: 200, classes: modelClasses(10, 20, 30, 40) },
    { id: 'broken', tokens: 500, tokensPerCredit: undefined, classes: modelClasses(1, 1, 1, 1) },
    { id: 'small', tokens: 100, tokensPerCredit: 2.5, classes: modelClasses(1, 0, 0) },
  ]
  const { tree } = await mountModelClasses(models)
  const section = creditsSectionOf(tree)
  const rows = findNodes(section, 'tpq-usage-credits-model')
  check('T016 回归：跳过非有限行且顺序照宿主', rows.map((row) => row.props['data-model']), ['big', 'small'])
  check('T016 回归：第一行 tokens / ratio 文本未变',
    [collectText(findNodes(rows[0], 'tpq-usage-credits-model-tokens')[0]).join(''),
      collectText(findNodes(rows[0], 'tpq-usage-credits-model-ratio')[0]).join('')],
    ['9,000 tokens', '1 Credit ≈ 200 tokens'])
  check('T016 回归：模型块标题 / 脚注各一份',
    [findNodes(section, 'tpq-usage-credits-models-title').length, findNodes(section, 'tpq-usage-credits-models-note').length], [1, 1])
  ok('T016 回归：每行第二行最多一条（不重复渲染）',
    rows.every((row) => findNodes(row, 'tpq-usage-credits-model-classes').length === 1))
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
