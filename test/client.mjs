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
function ok(label, condition) {
  if (condition) passed += 1
  else {
    failed += 1
    console.log(`FAIL ${label}`)
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
  const declaredSlots = new Set(fetchMode === 'no-left' ? ['conversation.input.dock'] : ['conversation.input.left', 'conversation.input.dock'])

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
  const factoryRunner = new Function('window', 'document', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'require', `${source}; return window.__ModuleLoader__.spec`)
  const spec = factoryRunner(globalThis.window, dom.document, { language: 'zh-CN' }, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, (id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })

  check('bundle 声明了自己的 id', spec.id, 'dsh-token-plan-quota')
  const api = spec.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })
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
  ok('样式注入了一次', dom.styles.length === 1)
  ok('样式带上插件标识', dom.styles[0].dataset.plugin === 'dsh-token-plan-quota')
  check('只注册一个座位（首选成功就不重复）', registered.length, 1)
  check('座位名', registered[0].options.name, 'conversation.input.left')
  check('座位 id', registered[0].options.id, 'token-plan-quota')
  ok('组件是函数', typeof registered[0].component === 'function')
}

{
  const { api, registered, dom } = await loadBundle('no-left')
  api.apply(makeCtx(registered, new Set(['conversation.input.dock']), []))
  check('老外壳退到 dock 座位', registered.map(entry => entry.options.name), ['conversation.input.dock'])
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
  ok('明细里显示本实例 token 数（缩写格式）', panel.includes('1.01M') || panel.includes('1,010,000'))
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
  ok('窗口卡数值带 tok 与实测角标', flat.includes('1.23M tok') && flat.includes('实测'))
  ok('窗口卡显示剩余天数', flat.includes('剩5天'))
  ok('窗口徽标带实测吞吐标签（最近单流速度，纯文本无图标）', flat.includes('42 tok/s'))
  ok('徽标无状态圆点、无表情符号', !flat.includes('tpq-dot') && !flat.includes('⚡'))

  // 点开 → panelScope=current：只列当前供应商的卡 + 本实例实测，DeepSeek 不再常驻。
  const openChip = findChip(await settle(render, 1))
  ok('找到窗口徽标', openChip !== undefined)
  openChip.props.onClick()
  const panel = JSON.stringify(await settle(render, 3))
  ok('面板含当前模型标注', panel.includes('qwen3.8-flash'))
  ok('面板含吞吐一行（生成速度优先 + 60s/5min 汇总）', panel.includes('吞吐') && panel.includes('28.6k tok/s') && panel.includes('近 5 分'))
  ok('窗口卡一行摘要含用量与重置倒计时', panel.includes('窗口内已用') && panel.includes('剩5天后重置'))
  ok('panelScope=current：DeepSeek 卡不再出现在面板', !panel.includes('DeepSeek 余额'))
  ok('panelScope=current：面板只列绑定卡，实测用量卡不进面板', panel.includes('Token Plan 实测') && !panel.includes('本实例实测用量'))
  ok('panelScope=current：无隐藏提示灰条', !panel.includes('已隐藏') && !panel.includes('未配置 AK/SK'))

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
  ok('面板余量行：剩余 6,510 / 10,000 · 已用 34.9% · 5h窗口', panel.includes('6,510') && panel.includes('10,000') && panel.includes('已用 34.9%') && panel.includes('5h窗口'))
  ok('控制台卡标「官方接口」来源', panel.includes('官方接口') && panel.includes('tokenplan/personal/api/v2'))
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
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
