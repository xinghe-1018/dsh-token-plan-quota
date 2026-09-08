/**
 * 零依赖 CDP 客户端（只用 Node 内建：child_process / fetch / 全局 WebSocket）。
 *
 * 存在意义：README 的四张截图必须带**合成数据**（真实余额绝不能进图）。客户端渲染的唯一输入
 * 是同源 GET `/token-plan-quota/summary`（`lib/client.js` 的 `SUMMARY`）与面板刷新按钮 POST 的
 * `/token-plan-quota/refresh`，所以在浏览器侧把这两个响应换掉，就等于精确控制画面内容，
 * 不必去伪造任何上游接口。
 *
 * 目标 Node ≥22（全局 WebSocket）。Node 20 会被 `assertWebSocket` 明确挡掉，不静默失败。
 *
 * 用法：
 *   const browser = await launchEdge({ lang: 'zh-CN' })
 *   const cdp = await Cdp.connect(browser.wsUrl)
 *   const page = await cdp.openPage('http://127.0.0.1:3099')
 *   await page.interceptJson({ patterns: [...], bodies: {...} })
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 常见安装位置；找不到时由调用方给出 --edge 显式路径。 */
const EDGE_CANDIDATES = [
  process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe') : null,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

/**
 * 定位 Edge 可执行文件。
 * @param {string|undefined} explicit - 用户显式传入的 --edge 路径。
 * @returns {string} 存在的可执行文件路径。
 */
export function findEdge(explicit) {
  const candidates = explicit ? [explicit, ...EDGE_CANDIDATES] : EDGE_CANDIDATES
  for (const one of candidates) {
    try {
      if (readFileSync(one) && one.length > 0) return one
    } catch { /* 不存在就下一个 */ }
  }
  throw new Error(
    `找不到 Microsoft Edge。已试：\n  ${candidates.join('\n  ')}\n`
    + '用 --edge <路径> 指定；Chrome 也可以（--edge 传 chrome.exe 即可，CDP 同源）。')
}

function assertWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error('需要 Node ≥22（全局 WebSocket）；当前 ' + process.version)
  }
}

/**
 * 起一个无头 Edge，等它把调试端口写进 DevToolsActivePort，再拿 browser 级 webSocketDebuggerUrl。
 * @param {object} options - 启动参数。
 * @param {string} [options.lang] - UI 语言（决定插件客户端 pickLocale 走中/英文案）。
 * @param {string} [options.edge] - 显式 Edge 路径。
 * @param {number} [options.width] - 窗口宽。
 * @param {number} [options.height] - 窗口高。
 * @param {string[]} [options.extraArgs] - 追加 flag。
 * @param {number} [options.timeoutMs] - 等端口的上限。
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, port: number, wsUrl: string, profileDir: string, userDataDir: string, close: () => void }>}
 *          句柄；`close()` 杀进程并清理临时 profile。
 */
export async function launchEdge(options = {}) {
  assertWebSocket()
  const exe = findEdge(options.edge)
  const base = mkdtempSync(join(tmpdir(), 'dsh-shots-edge-'))
  // Edge 只在 user-data-dir 根写 DevToolsActivePort，其余都在子目录里。
  const userDataDir = join(base, 'profile')
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--hide-scrollbars',
    `--lang=${options.lang ?? 'zh-CN'}`,
    `--window-size=${options.width ?? 1280},${options.height ?? 800}`,
    'about:blank',
  ]
  if (Array.isArray(options.extraArgs)) args.splice(args.length - 1, 0, ...options.extraArgs)

  const proc = spawn(exe, args, { detached: false, stdio: ['ignore', 'ignore', 'ignore'] })
  const portFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  let port = 0
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break
    try {
      const first = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (/^\d+$/.test(first)) { port = Number(first); break }
    } catch { /* 还没写 */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (port === 0) {
    proc.kill()
    throw new Error(`Edge 没在 ${options.timeoutMs ?? 30_000}ms 内写出 DevToolsActivePort（exit=${String(proc.exitCode)}）`)
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()

  return {
    proc,
    port,
    wsUrl: version.webSocketDebuggerUrl,
    browserVersion: version['Browser'],
    profileDir: base,
    userDataDir,
    close() {
      try { proc.kill() } catch { /* 已经没了 */ }
      try { rmSync(base, { recursive: true, force: true, maxRetries: 5 }) } catch { /* 文件锁 */ }
    },
  }
}

/** 一条待响应的 CDP 命令。 */
class Pending {
  /** @param {(v: any) => void} resolve @param {(e: Error) => void} reject */
  constructor(resolve, reject) { this.resolve = resolve; this.reject = reject }
}

/**
 * 已连上 browser 端点的 CDP 会话。
 *
 * 说明：`sessionId` 走 flatten 模式（Target.attachToTarget {flatten:true}），事件的 sessionId 用于路由；
 * 本工具同时只需要一个页面 target，因此事件表按 `method` 广播，处理器自己带 sessionId 过滤。
 */
export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', event => this.onMessage(event))
  }

  /**
   * @param {string} wsUrl - browser 级 webSocketDebuggerUrl。
   * @returns {Promise<Cdp>}
   */
  static connect(wsUrl) {
    assertWebSocket()
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15_000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)) })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败：' + wsUrl)) })
    })
  }

  onMessage(event) {
    let message
    try { message = JSON.parse(String(event.data)) } catch { return }
    if (message.id !== undefined) {
      const wait = this.pending.get(message.id)
      if (wait !== undefined) {
        this.pending.delete(message.id)
        if (message.error) wait.reject(new Error(`${message.error.message} (code ${message.error.code})`))
        else wait.resolve(message.result)
      }
      return
    }
    const list = this.handlers.get(message.method)
    if (list !== undefined) for (const handler of [...list]) handler(message.params ?? {}, message.sessionId)
  }

  /**
   * @param {string} method
   * @param {(params: any, sessionId?: string) => void} handler
   */
  on(method, handler) {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
    return () => {
      const all = this.handlers.get(method) ?? []
      const at = all.indexOf(handler)
      if (at >= 0) all.splice(at, 1)
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, new Pending(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) }))
      this.ws.send(JSON.stringify(payload))
    })
  }

  close() {
    try { this.ws.close() } catch { /* 已经关了 */ }
  }

  /**
   * 开一个页面并附着。
   * @param {string} url
   * @param {{width?: number, height?: number, deviceScaleFactor?: number}} [viewport]
   * @returns {Promise<PageHandle>}
   */
  async openPage(url, viewport = {}) {
    const { targetId } = await this.send('Target.createTarget', { url })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new PageHandle(this, targetId, sessionId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    if (viewport.width) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: Number(viewport.width), height: Number(viewport.height) ?? 800,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1, mobile: false,
      })
    }
    return page
  }
}

/** 单个页面 target 的命令面（所有 send 自动带 sessionId）。 */
export class PageHandle {
  /**
   * @param {Cdp} cdp
   * @param {string} targetId
   * @param {string} sessionId
   */
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp
    this.targetId = targetId
    this.sessionId = sessionId
  }

  /** @param {string} method @param {object} [params] @param {number} [timeoutMs] */
  send(method, params = {}, timeoutMs = 30_000) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs)
  }

  /** @param {string} method @param {(params: any, sessionId?: string) => void} handler */
  on(method, handler) {
    return this.cdp.on(method, (params, sessionId) => {
      if (sessionId !== undefined && sessionId !== this.sessionId) return
      handler(params, sessionId)
    })
  }

  /**
   * 在页面里求值。
   * @param {string} expression - JS 表达式（不是语句；要 return 得写成箭头 IIFE）。
   * @param {{awaitPromise?: boolean}} [options]
   */
  async evaluate(expression, options = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: options.awaitPromise ?? true,
    })
    if (result.exceptionDetails) {
      throw new Error('页面求值异常：' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    }
    return result.result?.value
  }

  /** 等表达式为真值。 */
  async waitFor(expression, { timeoutMs = 15_000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await this.evaluate(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)
      if (value === true) return true
      if (Date.now() > deadline) throw new Error(`等超时（${timeoutMs}ms）：${label}`)
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  /** @param {string} url */
  async navigate(url) {
    await this.send('Page.navigate', { url })
  }

  /** 重新加载并等 DOM 稳定。 */
  async reloadAndSettle() {
    const loaded = new Promise(resolve => {
      const off = this.on('Page.loadEventFired', () => { off(); resolve() })
    })
    await this.send('Page.reload', { ignoreCache: true })
    await loaded
  }

  /**
   * 用给定 JSON 顶掉匹配 URL 的响应；其余请求原样放行。
   *
   * 一次注册常驻：轮询、点刷新、重载都吃同一份 body（body 是 getter，所以 `generatedAt`
   * 这类相对时间每次都能重新算，不会出现「剩 5d」过几秒变「剩 4.9d」的抖动）。
   *
   * @param {{patterns: Array<{urlPattern: string}>, respond: (req: any) => {body: string}|null, log?: (line: string) => void}} options
   * @returns {{stop: () => void, hits: () => number}}
   */
  intercept(options) {
    const counter = { hits: 0 }
    const offPaused = this.on('Fetch.requestPaused', async params => {
      const requestId = params.requestId
      try {
        const made = await options.respond(params.request)
        if (made !== null && made !== undefined) {
          counter.hits++
          options.log?.(`${made.via ?? 'fulfill'} ${params.request.url}`)
          await this.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [
              // 默认按 JSON 回（额度接口就是 JSON）；改写的 JS 包必须给真的 MIME，
              // 否则浏览器拒绝执行模块，页面直接白屏。
              { name: 'content-type', value: made.contentType ?? 'application/json' },
              { name: 'cache-control', value: 'no-store' },
            ],
            body: Buffer.from(made.body, 'utf8').toString('base64'),
          })
          return
        }
        await this.send('Fetch.continueRequest', { requestId })
      } catch (error) {
        // 拦不住也要放行：宁可得真数据页面，也不要让脚本卡在无限 pending 里。
        options.log?.(`intercept 失败（放行）：${error.message}`)
        try { await this.send('Fetch.continueRequest', { requestId }) } catch { /* target 已关 */ }
      }
    })
    this.send('Fetch.enable', {
      patterns: options.patterns.map(one => ({ urlPattern: one.urlPattern, requestStage: 'Request' })),
      handleAuthRequests: false,
    }).catch(() => { /* close 之后的竞态 */ })
    return { stop: () => offPaused(), hits: () => counter.hits }
  }

  /**
   * 某个选择器元素的视口矩形。
   * @param {string} selector
   */
  async rectOf(selector) {
    return await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)
  }

  /**
   * @param {string} selector
   * @returns {Promise<{x:number,y:number}>} 元素视口中心。
   */
  async centerOf(selector) {
    const rect = await this.rectOf(selector)
    if (rect === null) throw new Error(`找不到元素：${selector}`)
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }

  /** 真鼠标点击（CDP Input，不是 element.click()：面板拖拽监听的是 pointer 事件）。 */
  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
      })
    }
  }

  /**
   * 截图。
   * @param {{selector?: string, clip?: object, pad?: number, format?: string, quality?: number}} [options]
   *        selector 时按元素矩形（可外扩 pad 像素）裁；否则截整个视口。
   * @returns {Promise<Buffer>}
   */
  async shot(options = {}) {
    let clip = options.clip
    if (options.selector !== undefined) {
      const rect = await this.rectOf(options.selector)
      if (rect === null) throw new Error(`截图找不到元素：${options.selector}`)
      const pad = options.pad ?? 0
      clip = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2 }
    }
    if (clip !== undefined) clip = { ...clip, scale: clip.scale ?? 1 }
    const result = await this.send('Page.captureScreenshot', {
      format: options.format ?? 'png',
      ...(clip !== undefined ? { clip } : {}),
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
    })
    return Buffer.from(result.data, 'base64')
  }

  /**
   * 录一帧一帧（GIF 的原料）。
   * @param {(frame: Buffer, meta: any) => void} onFrame
   * @param {{format?: string, quality?: number, maxWidth?: number, maxHeight?: number, everyNthFrame?: number}} [options]
   * @returns {Promise<{stop: () => Promise<void>}>}
   */
  async startScreencast(onFrame, options = {}) {
    await this.send('Page.startScreencast', {
      format: options.format ?? 'jpeg',
      quality: options.quality ?? 85,
      maxWidth: options.maxWidth ?? 1280,
      maxHeight: options.maxHeight ?? 800,
      everyNthFrame: options.everyNthFrame ?? 1,
    })
    const off = this.on('Page.screencastFrame', async params => {
      try {
        onFrame(Buffer.from(params.data, 'base64'), params.metadata)
        await this.send('Page.screencastFrameAck', { sessionId: params.sessionId })
      } catch { /* 停录之后的尾巴帧 */ }
    })
    return {
      stop: async () => {
        off()
        try { await this.send('Page.stopScreencast') } catch { /* 已停 */ }
      },
    }
  }

  /** @param {string} path 落盘用的小 helper（Node 端）。 */
  writeFile(path, data) {
    writeFileSync(path, data)
  }
}
