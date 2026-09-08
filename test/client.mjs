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
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(expected === undefined ? actual : actual)}`)
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
    const consoleCard = mode === 'console-err'
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
    const cards = mode === 'console-ok' || mode === 'console-err' ? [...emptyCards, consoleCard] : emptyCards
    return { ok: true, status: 200, json: async () => ({ ...SNAPSHOT, config, throughput, cards, notices: mode === 'empty' ? ['当前没有官方额度源返回数据'] : SNAPSHOT.notices }) }
  }
}

/* ------------------------------------------------------ 装载 bundle */

async function loadBundle(fetchMode) {
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

  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        this.spec = spec
      },
    },
  }
  globalThis.document = dom.document
  globalThis.fetch = makeFetch(fetchMode)
  globalThis.setInterval = () => 1
  globalThis.clearInterval = () => {}

  // bundle 走 window.__ModuleLoader__.load；navigator 只按形参注入（Node 24 的
  // globalThis.navigator 是只读访问器，不能覆写）。
  const source = code
  const fakeReactDOM = {
    createPortal: (el, container) => ({ ...el, portalTo: container === dom.document.body ? 'body' : 'other' }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return fakeReactDOM
    throw new Error(`unexpected require(${id})`)
  }
  const factoryRunner = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'require', `${source}; return window.__ModuleLoader__.spec`)
  const spec = factoryRunner(globalThis.window, dom.document, { language: 'zh-CN' }, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, requireStub)

  check('bundle 声明了自己的 id', spec.id, 'dsh-token-plan-quota')
  const api = spec.factory(requireStub)
  return { spec, api, registered, injected, effects, dom, declaredSlots }
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

function makeCtx(registered, declaredSlots, styleCount, services) {
  const slots = {
    inject(name, callback) {
      if (!declaredSlots.has(name)) return () => {}
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
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
  ok('徽标无状态圆点、无表情符号', !flat.includes('tpq-dot') && !flat.includes('⚡'))

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
  ok('未绑定供应商 → 徽标整个隐藏', !flat.includes('tpq-chip'))
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
  ok('锚定态按徽标上方可用空间夹面板体高度',
    /spaceAbove\s*=\s*r\.top/.test(code) && /bodyStyle\s*=\s*\{\s*maxHeight/.test(code))
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
