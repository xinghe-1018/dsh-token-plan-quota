/**
 * README 截图物料生成器。
 *
 *   node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 [--lang zh|en] [--out docs/images]
 *                                     [--shots 2,3,4,5,6,7,8,9] [--edge <path>] [--ffmpeg <path>] [--allow-live]
 *                                     [--width <px>] [--height <px>] [--allow-docs]
 *
 * 两件事决定了这个脚本的形状：
 *  - **合成数据**：图里绝不能出现真实余额（README 的立场靠这张图自证，漏一次就白洗过仓库），
 *    所以拦截 `/token-plan-quota/summary` 与 `/token-plan-quota/refresh`，换成 `fixture.mjs` 造的数据。
 *    两个都要拦：面板那个"更新于"按钮会 POST refresh 并把快照覆盖回去（`lib/client.js:1090`）。
 *    用量统计屏是第三个接口（`/token-plan-quota/usage?days=N`，绝对 token 数），同样换成 fixture：
 *    那边的数字一旦来自真实实例，这张图就再也不能证明"仓库里没有真实用量"。
 *  - **要活会话**：徽标注入的座位是 `conversation.input.left`（`lib/client.js:1157`），
 *    没有打开的会话就没有 DOM 座位。宿主自带的 `?fixture` 模式（内存假宿主，含种子会话与
 *    默认模型）正好提供这个状态，于是不需要真凭据、不需要种工作区。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { launchEdge, Cdp } from './cdp.mjs'
import { makeSnapshot, assertFixture, makeUsageSnapshot, assertUsageFixture } from './fixture.mjs'

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { lang: 'zh', out: 'docs/images', shots: [2, 3, 4, 5, 6, 7, 8, 9], allowLive: false, width: 1280, height: 860 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--url') out.url = next()
    else if (arg === '--lang') out.lang = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--shots') out.shots = next().split(',').map(v => Number(v.trim())).filter(Boolean)
    else if (arg === '--edge') out.edge = next()
    else if (arg === '--ffmpeg') out.ffmpeg = next()
    else if (arg === '--width') out.width = Number(next())
    else if (arg === '--height') out.height = Number(next())
    else if (arg === '--allow-live') out.allowLive = true
    else if (arg === '--allow-docs') out.allowDocs = true
    else if (arg === '-h' || arg === '--help') { out.help = true }
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

const LANGUAGE = { zh: 'zh-CN', en: 'en-US' }

/**
 * 界面串按语言取。宿主客户端的文案由 `pickLocale()` 决定（`client.js:150`），
 * 菜单行与实测 pill 都跟着变，所以这里绝不能把中文写死——英文套会点不到。
 * `onboardingTitle` 是宿主开场模态的标题（`onboarding-copy.ts`），用来按文案定位那层遮罩。
 */
const UI = {
  zh: { modelRow: '模型', measured: '实测', dismissModal: '继续', onboardingTitle: '内测声明' },
  en: { modelRow: 'Model', measured: 'measured', dismissModal: 'Continue', onboardingTitle: 'Internal Testing Notice' },
}

/* ------------------------------------------------- 宿主 fixture 模型目录补全 */

/** 假宿主（含 `fixtureModelGroups()`）所在的那个客户端包。 */
const CONNECTION_BUNDLE = 'dsh-client-connection/client.js'

/**
 * 三连图要拍「Token Plan 用过的模型」和「本实例没用过的 MiniMax」，
 * 而假宿主的模型目录只有 DeepSeek 与 OpenAI 两家 —— 徽标和面板都跟着**当前模型**走
 * （`client.js:994-1003`），目录里没有这两家就根本切不过去。
 *
 * 为什么不改宿主源码：`dsh web` 发的是**预构建**的客户端包，改 `packages/client` 下的 src
 * 不重新构建就不生效（实测过）。截图工具不该要求用的人先去构建宿主，
 * 所以在浏览器侧把这段目录补全。
 */
const EXTRA_MODEL_GROUPS = `, {
				id: "qwen-token-plan-cn",
				name: "Qwen",
				models: [{ id: "qwen3.8-flash", name: "Qwen3.8 Flash", reasoning: OPENAI_REASONING }]
			}, {
				id: "minimax-cn",
				name: "MiniMax",
				models: [{ id: "MiniMax-M3", name: "MiniMax-M3", reasoning: OPENAI_REASONING }]
			}`

/**
 * 锚在 openai 那组**整个对象**后面（含收尾的 `}`）—— 只锚到 `models: [...]` 会把新组
 * 插进数组里，变成 `}], {` 这种语法残骸。不用 /g：只补一次，补两处会出现重复模型。
 */
const CATALOG_ANCHOR = /id:\s*"openai",\s*name:\s*"OpenAI",\s*models:\s*\[\s*\{[^{}]*\}\s*\]\s*\}/

/**
 * @param {string} source 宿主发来的客户端包原文
 * @returns {string} 补全模型目录后的源码
 */
function patchFixtureCatalog(source) {
  if (source.includes('"minimax-cn"')) return source // 构建产物哪天跟上了就直接用
  if (!CATALOG_ANCHOR.test(source)) {
    throw new Error('宿主 fixture 的模型目录锚点没找到（上游改了 fixtureModelGroups？）。'
      + '宁可不出图，也不要拍一张「当前模型」和卡片对不上的假截图。')
  }
  return source.replace(CATALOG_ANCHOR, matched => matched + EXTRA_MODEL_GROUPS)
}

/* ------------------------------------------------------------------ 工具 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function findFfmpeg(explicit) {
  const candidates = [
    explicit,
    process.env.FFMPEG,
    'C:/Users/OMEN/.dsh/.scratch/tools/node_modules/ffmpeg-static/ffmpeg.exe',
    'ffmpeg',
  ].filter(Boolean)
  for (const one of candidates) {
    if (one !== 'ffmpeg' && !existsSync(one)) continue
    const probe = spawnSync(one, ['-version'], { encoding: 'utf8' })
    if (probe.status === 0) return one
  }
  return null
}

/** 徽标/面板这类小控件单独裁出来最好看，但整页也要留一张当上下文。 */
async function clipOf(page, selector, pad) {
  const rect = await page.rectOf(selector)
  if (rect === null) throw new Error(`找不到元素：${selector}`)
  return {
    x: Math.max(0, Math.floor(rect.x - pad)),
    y: Math.max(0, Math.floor(rect.y - pad)),
    width: Math.ceil(rect.width + pad * 2),
    height: Math.ceil(rect.height + pad * 2),
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/shots/make-shots.mjs --url http://127.0.0.1:<port> [--lang zh|en] [--out docs/images] [--shots 2,3,4,5,6,7,8,9] [--width 375] [--height 768] [--allow-docs]')
    return
  }
  if (args.url === undefined) throw new Error('必须给 --url（指向一个装好本插件的 dsh web 实例）')
  const port = Number(new URL(args.url).port || 80)
  if (port === 3080 && args.allowLive !== true) {
    throw new Error('拒绝在 3080（本机日常实例）上跑：模型列表会把真实在用的路由拍进图里。确认要这样做就加 --allow-live。')
  }
  const langKey = args.lang === 'en' ? 'en' : 'zh'
  const outDir = join(args.out, ...(langKey === 'en' ? ['en'] : []))
  /**
   * 中间产物落在仓库根的 `.shots-work/`，**不能**放在 docs/ 下面：`package.json` 的 `files`
   * 显式列了 `docs`，而显式 allowlist 会压过 `.gitignore`——放里面就会把几十 MB 的 GIF 帧
   * 一起打进 npm 包（`npm pack --dry-run` 实测抓到过一次）。
   */
  /**
   * 窄视口（或任何非默认取景）默认**不许**写进 docs/：那批图由 README 引用、由
   * `check-docs.mjs` 第 10 项断言，用 375px 的裁切覆盖它们等于把产品证据悄悄换成另一种口径。
   * 窄视口 QA 请输出到 `.shots-work/`（已 gitignore）；确实要覆盖 docs/ 就显式加 `--allow-docs`。
   */
  const viewport = { width: args.width, height: args.height }
  if (![viewport.width, viewport.height].every(v => Number.isFinite(v) && v > 0)) {
    throw new Error(`--width/--height 必须是正数（收到 ${args.width}×${args.height}）`)
  }
  if ((viewport.width !== 1280 || viewport.height !== 860) && args.allowDocs !== true) {
    const relToDocs = relative(resolve('docs'), resolve(outDir))
    if (relToDocs === '' || (!relToDocs.startsWith('..') && !isAbsolute(relToDocs))) {
      throw new Error(`非默认取景 ${viewport.width}×${viewport.height} 拒绝写入 docs/：会覆盖 README 已引用的已发布图。窄视口 QA 用 --out .shots-work/narrow；确认要覆盖再加 --allow-docs。`)
    }
  }

  const workDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), '.shots-work', langKey)
  mkdirSync(outDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  /** 当前要喂的变体；改它不需要重载页面（点徽标就会重新拉一次 summary）。 */
  const live = { variant: 'panel' }
  const built = variant => {
    const snapshot = makeSnapshot({ variant, lang: langKey, now: Date.now() })
    assertFixture(snapshot, { lang: langKey })
    writeFileSync(join(workDir, `${variant}.json`), JSON.stringify(snapshot, null, 1))
    return snapshot
  }

  const browser = await launchEdge({ lang: LANGUAGE[langKey], edge: args.edge, width: viewport.width, height: viewport.height })
  const cdp = await Cdp.connect(browser.wsUrl)
  /**
   * `dsh web` 启动时打印的地址带一次性 token（首次访问 303 换 cookie）。把那个地址整条传进来时
   * URL 里已经有 `?token=…`，再拼 `/?fixture` 会变成 `?token=…/?fixture`：宿主的 fixture 开关
   * 读不到，页面直接落回真实宿主（图里就会混进真实数据）。所以按有没有查询串分别拼。
   */
  const baseUrl = args.url.replace(/\/+$/, '')
  const fixtureUrl = baseUrl.includes('?') ? `${baseUrl}&fixture` : `${baseUrl}/?fixture`
  const page = await cdp.openPage(fixtureUrl, { width: viewport.width, height: viewport.height, deviceScaleFactor: 2 })
  /** 客户端包改写一次就缓存住：每次重载都重新拉 350 KB 没必要。 */
  let patchedBundle = null
  /**
   * 用量统计是另一个接口，且**按 days 取参**：7 天的 fixture 拿去回答 90 天的请求，
   * 屏上的区间副标题、桶数和坐标轴就会和数字对不上 —— 那不是截图瑕疵，是假数据。
   * 所以按 days 分开缓存，各写一份 .shots-work/<lang>/usage-<days>d.json 供事后核对。
   */
  const usageCache = new Map()
  const builtUsage = days => {
    if (!usageCache.has(days)) {
      const usage = makeUsageSnapshot({ days, now: Date.now() })
      assertUsageFixture(usage, { lang: langKey, days })
      writeFileSync(join(workDir, `usage-${days}d.json`), JSON.stringify(usage, null, 1))
      usageCache.set(days, JSON.stringify(usage))
    }
    return usageCache.get(days)
  }
  const hits = page.intercept({
    patterns: [
      { urlPattern: '*token-plan-quota/summary*' },
      { urlPattern: '*token-plan-quota/refresh*' },
      { urlPattern: '*token-plan-quota/usage*' },
      { urlPattern: `*${CONNECTION_BUNDLE}*` },
    ],
    respond: async request => {
      if (request.url.includes('/token-plan-quota/usage')) {
        // 参数解析不出来就按宿主默认（7 天）；天数上限由 fixture 自己夹紧，不在这里猜。
        const asked = Number(new URL(request.url).searchParams.get('days'))
        const days = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 7
        return { body: builtUsage(days), via: 'fixture' }
      }
      if (!request.url.includes(CONNECTION_BUNDLE)) {
        return { body: JSON.stringify(built(live.variant)), via: 'fixture' }
      }
      if (patchedBundle === null) {
        patchedBundle = patchFixtureCatalog(await (await fetch(request.url)).text())
      }
      return { body: patchedBundle, contentType: 'text/javascript; charset=utf-8', via: 'catalog' }
    },
  })
  console.log(`Edge ${browser.browserVersion} @ ${browser.port}；语言 ${LANGUAGE[langKey]}；输出 ${outDir}`)

  // 首屏：徽标必须挂上，挂不上后面全白拍，所以先断言再动手。
  await page.waitFor(`document.querySelector('.tpq-chip') !== null`, { timeoutMs: 30_000, label: '徽标挂载' })
  console.log('✅ 徽标已挂载：' + JSON.stringify(await page.evaluate(`document.querySelector('.tpq-chip').innerText.replace(/\\s+/g,' ')`)))
  // 宿主语言决定图文种（插件跟着 `<html lang>` 走，不完全等于 --lang）。先打出来，
  // 省得跑完四分钟才发现整套图是另一种语言。
  console.log('   宿主界面语言 <html lang> = ' + JSON.stringify(await page.evaluate('document.documentElement.lang')) + `（--lang ${LANGUAGE[langKey]}）`)

  /**
   * 按可见文案点一个按钮（模态的确认按钮、模型按钮都靠它）。
   * 针和页面文本走同一个归一化：都去掉空白，带空格的名字才点得到。
   */
  const clickText = async (match, where = 'button') => await page.evaluate(`(() => {
    const hit = [...document.querySelectorAll(${JSON.stringify(where)})]
      .find(n => (n.innerText || n.getAttribute('aria-label') || '').replace(/\\s+/g, '').includes(${JSON.stringify(match.replace(/\s+/g, ''))}) && n.offsetParent !== null)
    if (!hit) return false
    hit.click(); return true
  })()`)
  /**
   * 徽标中心被谁盖住了？没被盖住返回 null。用 `elementFromPoint` 而不是枚举模态类名：
   * 挡在上面的东西不止「内测声明」一种，而"拍之前画面是干净的"要的是结论。
   */
  const coveredByOverlay = async () => await page.evaluate(`(() => {
    const c = document.querySelector('.tpq-chip')
    if (!c) return 'no-chip'
    const r = c.getBoundingClientRect()
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (at === null) return 'point-outside-viewport'
    if (at === c || c.contains(at) || at.contains(c)) return null
    return String(at.className || at.tagName)
  })()`)
  /**
   * 清掉宿主挡在徽标上的开场层。除了「内测声明」，**没配过凭据的实例**还会弹
   * 「添加一个 API Key 开始使用」（一个全屏 fixed 的 _root_xxx）—— 两种都得摘掉，否则背景里
   * 永远压着一块模态，而脚本还可能一路绿。
   *
   * 而且它们在 fixture 模式下**点「继续 / 保存并继续」是关不掉的**：假宿主没有 settings
   * 写入通道，\`WelcomeNoticeStore.acknowledge()\` 永远判失败（\`welcome-store.ts:90-95\`），
   * 点「继续」只会亮出「暂时无法保存确认状态」那行错误——正好压在徽标上。所以分两步：
   *  1. 先按正常路径点（「稍后配置 / Configure later / 继续」）—— 真服务器上一击就关；
   *  2. 点不动就把"盖住徽标、又不包含徽标"的最外层 fixed 容器隐藏（宿主的开场物，与本插件无关）；
   *  3. 结束条件是"没有浮层挡着徽标"，不是"我点到过按钮"——后者会静默骗过整条流水线。
   *
   * 两条不能省的细节：
   *  - 只在**不包含徽标**的 dialog 里点按钮：额度面板自己就是 \`role="dialog"\`（\`client.js:1070\`），
   *    宿主也可能把包含徽标的容器标成 dialog，误点会点掉插件自己的面板。
   *  - 按钮先精确匹配、再退回包含匹配：\`保存并继续\` 里也含「继续」，先点它会拿空 API key 去保存。
   */
  const dismissOnboarding = async () => {
    const labels = [...new Set([UI[langKey].dismissModal, '稍后配置', 'Configure later', '稍后', 'Later', '继续', 'Continue'])]
    // 标题不能只按 --lang 取：那句文案由宿主 pickLocale() 决定，和浏览器语言不是一回事
    // （实测英文套里宿主仍弹中文标题，按英文标题找会找不到）。
    const titles = [...new Set([UI[langKey].onboardingTitle, '内测声明', 'Internal Testing Notice', '添加一个 API Key 开始使用', 'Add an API key to get started'])]
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await coveredByOverlay() === null) return true
      await page.evaluate(`(() => {
        const norm = s => (s || '').replace(/\\s+/g, '')
        const chip = document.querySelector('.tpq-chip')
        const dialogs = [...document.querySelectorAll('[class*="dialog" i],[role="dialog"]')]
          .filter(n => n.offsetParent !== null && !(chip && n.contains(chip)))
        if (dialogs.length === 0) return false
        const titles = ${JSON.stringify(titles)}.map(norm)
        const labels = ${JSON.stringify(labels)}.map(norm)
        // 标题对得上就优先用那张；宿主换了文案时退回任意不包含徽标的 dialog。
        const score = d => titles.some(t => norm(d.innerText).startsWith(t)) ? 0 : 1
        const ranked = dialogs.slice().sort((a, b) => score(a) - score(b))
        for (const dlg of ranked) {
          const buttons = [...dlg.querySelectorAll('button')].filter(n => n.offsetParent !== null)
          for (const btn of buttons) {
            const text = norm(btn.innerText)
            if (labels.some(l => text === l)) { btn.click(); return true }
          }
          for (const btn of buttons) {
            if (/保存|Save/.test(btn.innerText || '')) continue
            const text = norm(btn.innerText)
            if (labels.some(l => text.includes(l))) { btn.click(); return true }
          }
        }
        return false
      })()`)
      await sleep(400)
      if (await coveredByOverlay() === null) return true
      await page.evaluate(`(() => {
        const chip = document.querySelector('.tpq-chip')
        if (!chip) return false
        const r = chip.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (!at) return false
        // 从盖住徽标的节点往上找**最外层 fixed**：dialog 只是内容盒，真正铺满视口、
        // 吃掉点击的是固定定位的 _root_xxx；只藏 dialog 藏不住。
        // 一旦某层包含徽标就停手——继续往上会藏掉整个应用根节点（白屏但检查照样通过）。
        let root = at
        for (let up = at.parentElement; up && up !== document.body; up = up.parentElement) {
          if (up.contains(chip)) return false
          if (getComputedStyle(up).position === 'fixed') root = up
        }
        if (root.contains(chip)) return false
        root.style.display = 'none'
        for (const n of document.querySelectorAll('[class*="backdrop" i],[class*="mask" i]')) {
          if (n.offsetParent !== null) n.style.display = 'none'
        }
        return true
      })()`)
      await sleep(300)
    }
    const cover = await coveredByOverlay()
    if (cover !== null) throw new Error(`宿主开场/配置模态清不掉，徽标还被「${cover}」挡着`)
    return true
  }
  /**
   * 取"最深"的匹配节点再点：菜单项的祖先 innerText 也含关键字，点祖先等于点空气。
   * 顺带补一遍悬停事件——宿主的二级菜单是 hover 展开的。
   * 待匹配串要和节点文本走同一个归一化（去空白）：`Qwen3.8 Flash` 这种带空格的名字，
   * 只剥节点文本不剥针，就永远匹配不上（`GPT-5` 没空格，所以这个坑藏了很久）。
   */
  const deepClick = async match => {
    // 重试到点着为止：菜单是异步挂载的，固定 sleep 之后仍可能没渲染完
    // （英文整套连跑时，GIF 刚关掉的旧菜单还会短暂留在 DOM 里，撞上过）。
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const done = await page.evaluate(`(() => {
        // 取最后一个可见的 menu 容器：菜单是后挂载的，第一个往往是侧栏里别的 menu 类节点。
        const menus = [...document.querySelectorAll('[class*="menu" i]')].filter(n => n.offsetParent !== null)
        const root = menus.length > 0 ? menus[menus.length - 1] : document
        const cands = [...root.querySelectorAll('*')].filter(n => n.offsetParent !== null
          && (n.innerText || '').replace(/\\s+/g, '').includes(${JSON.stringify(match.replace(/\s+/g, ''))}))
        if (cands.length === 0) return false
        const leaf = cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
          leaf.dispatchEvent(new PointerEvent(type, { bubbles: type.endsWith('over'), cancelable: true }))
        }
        leaf.click(); return true
      })()`)
      if (done) return true
      await sleep(250)
    }
    return false
  }

  await dismissOnboarding()
  await sleep(600)
  console.log('  （确认没有浮层挡着徽标）')

  const openPanel = async variant => {
    live.variant = variant
    await page.evaluate(`(() => { const c = document.querySelector('.tpq-chip'); if (c) c.click(); return !!c })()`)
    await page.waitFor(`document.querySelector('.tpq-panel') !== null`, { timeoutMs: 10_000, label: '面板打开' })
    // 卡片是按 --tpq-i 交错渐入的（CSS 动画，非 JS），等太短会拍到后半张卡数字发灰。
    await sleep(2200)
  }
  const closePanel = async () => {
    await page.evaluate(`(() => { const c = document.querySelector('.tpq-chip'); if (c && document.querySelector('.tpq-panel')) c.click(); })()`)
    await page.waitFor(`document.querySelector('.tpq-panel') === null`, { timeoutMs: 8_000, label: '面板关闭' })
  }
  /** 悬浮矩形（视口坐标）。几何在挂载时读一次，所以写完必须重载才生效。 */
  const setFloatBox = async box => {
    await page.evaluate(`localStorage.setItem('dsh-token-plan-quota.panel', ${JSON.stringify(JSON.stringify(box))})`)
  }
  /** 重载到「徽标挂上、模态关掉」的干净起点。fixture 的模型选择在内存里，重载即回到默认 DeepSeek。 */
  const freshPage = async () => {
    await page.reloadAndSettle()
    await page.waitFor(`document.querySelector('.tpq-chip') !== null`, { timeoutMs: 30_000, label: '重载后徽标挂载' })
    await dismissOnboarding()
    await sleep(500)
  }
  /**
   * 走宿主自己的 selectModel 换模型：模型按钮 → 「模型」行 → 目标模型，
   * 再等徽标真的跟着换过去（这一步没换成就是白拍，所以断言在等待里）。
   */
  /** 失败时把当前可见的菜单内容抓出来贴进报错——"点不到 X"这种信息不足以复盘。 */
  const menuDump = async () => await page.evaluate(`(() => {
    const menus = [...document.querySelectorAll('[class*="menu" i]')].filter(n => n.offsetParent !== null)
    return menus.slice(-3).map(m => (m.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90))
  })()`)
  /**
   * 依次试多个候选文案，点中任何一个就算成功。
   * **为什么必须有这个**：宿主的界面语言由它自己的设置决定，和浏览器的 `--lang` 不是一回事
   * ——英文套里插件徽标确实是英文（`pickLocale()` 读 navigator），但宿主的菜单仍是「模型 / 推理等级」。
   * 只按 `--lang` 取一个词，就会在"宿主说中文"的那次加载上点空（英文整套连跑时反复翻车的地方）。
   */
  const deepClickAny = async candidates => {
    for (const one of candidates) if (await deepClick(one)) return one
    return null
  }
  const switchModel = async (fromLabel, toLabel, expectChip) => {
    // expectChip 可以是候选数组：徽标的文案跟着**宿主**的语言走（pickLocale 认 <html lang>），
    // 而宿主语言不完全等于浏览器的 --lang。只等一个词，就会在宿主恰好说中文的那次运行里
    // 干等到超时（英文套第一次就是这么挂的）。
    const expects = Array.isArray(expectChip) ? expectChip : [expectChip]
    if (!await clickText(fromLabel)) throw new Error(`点不到模型按钮（应显示「${fromLabel}」）`)
    await sleep(700)
    const rowLabels = [...new Set([UI[langKey].modelRow, '模型', 'Model'])]
    if (await deepClickAny(rowLabels) === null) {
      throw new Error(`点不到菜单里的模型行（试过 ${JSON.stringify(rowLabels)}）；当前可见菜单：${JSON.stringify(await menuDump())}`)
    }
    await page.waitFor(`(() => {
      const menus = [...document.querySelectorAll('[class*="menu" i]')].filter(n => n.offsetParent !== null)
      const root = menus[menus.length - 1]
      return root !== undefined && (root.innerText || '').includes(${JSON.stringify(toLabel)})
    })()`, { timeoutMs: 10_000, label: `二级菜单出现 ${toLabel}` })
    await sleep(600)
    if (!await deepClick(toLabel)) throw new Error(`点不到 ${toLabel}；当前可见菜单：${JSON.stringify(await menuDump())}`)
    // 徽标收成胶囊后**不显示卡名**（名字只在 tooltip 里），所以判断"跟过去了"不能只看可见文字：
    // 只看 innerText 会永远等不到 `Token Plan`（三连图第一次就挂在这）。title 里一定带卡名。
    await page.waitFor(`(() => {
      const c = document.querySelector('.tpq-chip')
      if (!c) return false
      const hay = (c.innerText || '') + ' ' + (c.title || '')
      return ${JSON.stringify(expects)}.some(x => hay.includes(x))
    })()`, { timeoutMs: 12_000, label: `徽标切到 ${expects.join(' / ')}` })
    await sleep(700)
  }
  /**
   * 三连图的取景框：从悬浮面板左上角一直裁到输入行下方 —— 一张图里同时给出
   * 「当前模型 → 面板里那一张卡 → 徽标怎么报」这条链，缺一段就讲不清。
   */
  const framedClip = async () => {
    const panel = await page.rectOf('.tpq-panel')
    const chip = await page.rectOf('.tpq-chip')
    if (panel === null || chip === null) throw new Error('取景失败：面板或徽标不在页面上')
    const vw = await page.evaluate('window.innerWidth')
    const vh = await page.evaluate('window.innerHeight')
    const y = Math.max(0, Math.floor(panel.y - 10))
    const right = Math.min(vw, Math.max(panel.x + panel.width, vw - 8))
    // 参考图里面板约占画面 60%。聊天列是居中的，紧贴面板左缘裁会把画面裁成"面板占满"，
    // 所以向左借一点空白凑到 820 CSS px。不能再宽：越过 ~280 就把侧栏切进来，
    // 会话时间会被裁成"刚刚 / 分钟"这种半截字。
    const x = Math.max(0, Math.min(Math.floor(Math.min(panel.x, chip.x) - 10), Math.floor(right - 820)))
    const bottom = Math.min(vh, Math.floor(chip.y + chip.height + 30))
    return { x, y, width: Math.ceil(right - x), height: Math.ceil(bottom - y) }
  }
  const produced = []
  const save = (name, buffer) => {
    const path = join(outDir, name)
    writeFileSync(path, buffer)
    produced.push(`${name} ${(buffer.length / 1024).toFixed(0)} KB`)
    console.log('  → ' + path)
  }

  if (args.shots.includes(2)) {
    console.log('② 明细面板（官方余量卡 + 多窗口计量条）')
    await openPanel('panel')
    save('panel-official-plus-meters.png', await page.shot({ clip: await clipOf(page, '.tpq-panel', 6) }))
    await closePanel()
  }

  if (args.shots.includes(3)) {
    console.log('③ 面板拖成悬浮小窗')
    // 悬浮框是 localStorage 里的矩形（FLOAT_KEY，client.js:304），在挂载前写好即可复现"拖出去"的结果。
    await setFloatBox({ x: 430, y: 150, w: 392, h: 470 })
    await freshPage()
    await openPanel('float')
    await page.waitFor(`document.querySelector('.tpq-panel[data-float="1"]') !== null`, { timeoutMs: 8_000, label: '悬浮态' })
    await sleep(600)
    save('floating-panel.png', await page.shot({ clip: await clipOf(page, '.tpq-panel', 6) }))
    await page.evaluate(`(() => { localStorage.removeItem('dsh-token-plan-quota.panel') })()`)
    await closePanel()
  }

  if (args.shots.includes(4)) {
    console.log('④ 官方源掉线退回实测卡')
    await openPanel('cookieDrop')
    save('cookie-fallback-measured.png', await page.shot({ clip: await clipOf(page, '.tpq-panel', 6) }))
    await closePanel()
  }

  if (args.shots.includes(1)) {
    console.log('① 徽标跟随模型切换（GIF）')
    live.variant = 'badgeSwitch'
    // ① 依赖"第一个 class 含 menu 的容器就是模型菜单"，而 ②③⑤⑥⑦ 开合面板会留下别的 menu 类节点。
    // 所以这里先重载一次拿到干净页面 —— 顺带让 --shots 的任意子集/顺序都成立。
    await freshPage()
    const before = await page.evaluate(`document.querySelector('.tpq-chip')?.innerText.replace(/\\s+/g,' ') ?? null`)
    console.log(`  起点徽标：${JSON.stringify(before)}`)

    // 录屏 + 逐层点开模型菜单：切模型要走宿主的 selectModel，不是我们改 DOM。
    // 注意全程用 DOM 点击 —— 坐标点击会被「内测声明」遮罩吃掉（踩过）。
    const frameDir = join(workDir, 'frames')
    mkdirSync(frameDir, { recursive: true })
    let frame = 0
    const writeFrame = buffer => { writeFileSync(join(frameDir, `f${String(++frame).padStart(4, '0')}.jpg`), buffer) }
    const cast = await page.startScreencast(writeFrame, { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 860 })
    await sleep(700)
    // 走和 ⑤⑥⑦ 同一个换模型函数：那里面已经有重试和"失败时把菜单内容贴出来"的诊断，
    // 这里再抄一份内联点击，等于让 GIF 这条路径永远拿不到它们（英文整套连跑时就是在这翻的车）。
    await switchModel('DeepSeek-V4-Flash', 'GPT-5', [UI[langKey].measured, '实测', 'measured'])
    await sleep(1600)
    await cast.stop()
    const after = await page.evaluate(`document.querySelector('.tpq-chip')?.innerText.replace(/\\s+/g,' ') ?? null`)
    console.log(`  终点徽标：${JSON.stringify(after)}（帧数 ${frame}）`)
    if (frame < 8) throw new Error(`screencast 只抓到 ${frame} 帧，GIF 没法看`)

    const gif = join(outDir, 'badge-follows-model.gif')
    const ffmpeg = findFfmpeg(args.ffmpeg)
    if (ffmpeg === null) {
      console.log('  ⚠️ 没找到 ffmpeg，跳过 GIF（帧已落在 ' + frameDir + '）。装法：npm i --no-save --prefix <dir> ffmpeg-static')
    } else {
      const run = spawnSync(ffmpeg, [
        '-y', '-framerate', '10', '-i', join(frameDir, 'f%04d.jpg'),
        '-vf', 'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0', gif,
      ], { encoding: 'utf8' })
      if (run.status !== 0) throw new Error('ffmpeg 失败：\n' + String(run.stderr).slice(-1500))
      save('badge-follows-model.gif', readFileSync(gif))
    }
  }

  /* ------------------------------------------------ ⑤⑥⑦ 面板跟随模型的三种状态 */
  if (args.shots.some(n => [5, 6, 7].includes(n))) {
    console.log('⑤⑥ 三种额度状态（同一取景：悬浮面板 + 底部徽标行）')
    live.variant = 'triptych'
    // 视口收窄到 1150：聊天列约 900 宽，裁出来才和参考图的取景比例一致（面板 520 + 右侧留白）。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1150, height: 820, deviceScaleFactor: 2, mobile: false })
    await freshPage()
    const chip0 = await page.rectOf('.tpq-chip')
    if (chip0 === null) throw new Error('量不到徽标位置，无法定位悬浮面板')
    await setFloatBox({ x: Math.round(chip0.x) - 10, y: 18, w: 520, h: 332 })
    await freshPage()

    const shootFramed = async file => {
      await openPanel('triptych')
      await page.waitFor(`document.querySelector('.tpq-panel[data-float="1"]') !== null`, { timeoutMs: 8_000, label: '悬浮态' })
      await sleep(600)
      // 按快门之前再确认一次：开面板/换模型都可能把浮层带回来。
      const cover = await coveredByOverlay()
      if (cover !== null) throw new Error(`拍摄前徽标被盖住了（${cover}）：${file} 不拍`)
      save(file, await page.shot({ clip: await framedClip() }))
      await closePanel()
    }
    /**
     * 模型是一步一步换的：即使只要 ⑦，也要先经过 ⑥ 的目标模型 —— 菜单里点的是
     * 「当前按钮上的那个模型」展开后的分组，跳步会点空。所以这条链按顺序走，
     * 只是不一定每张都拍。
     */
    const chain = [
      { shot: 5, file: 'state-deepseek-balance.png', to: null },
      { shot: 6, file: 'state-token-plan-credits.png', to: 'Qwen3.8 Flash', from: 'DeepSeek-V4-Flash', chip: 'Token Plan' },
      // zhOnly：那张卡的说明文字宿主只发中文，英文界面下也是 —— 英文套宁可少一张。
      { shot: 7, file: 'state-no-history.png', to: 'MiniMax-M3', from: 'Qwen3.8 Flash', chip: 'minimax-cn', zhOnly: true },
    ]
    for (const step of chain) {
      if (step.zhOnly === true && langKey !== 'zh') {
        console.log(`  ⑦ 跳过（英文套）：${step.file} 要展示的文案宿主只有中文版，编一句英文就等于拍假图`)
        continue
      }
      if (step.to !== null) await switchModel(step.from, step.to, step.chip)
      if (args.shots.includes(step.shot)) await shootFramed(step.file)
    }
    await page.evaluate(`(() => { localStorage.removeItem('dsh-token-plan-quota.panel') })()`)
  }

  /* ------------------------------------- ⑧⑨ 用量统计整页座位（2D / 3D 各一张） */
  if (args.shots.some(n => [8, 9].includes(n))) {
    console.log('⑧⑨ 用量统计整页座位（2D / 3D）')
    live.variant = 'panel'
    // ⑤⑥⑦ 把视口改成了 1150×820；这两张是 README 里"整页座位"的证据，固定按默认取景拍。
    // DPR 调回 1：整页图在 dsf=2 下是 2560×1720，README 用不到那个分辨率，只是白胖一倍体积。
    await page.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
    await freshPage()
    await openPanel('panel')
    /*
     * 入口走产品路径本身：徽标小窗底部的「用量统计」按钮。不直接调 layout.selectPanel ——
     * 那样只能证明"座位注册得上"，证明不了"入口点得开"；入口条件写坏时，图照样好看。
     */
    const entered = await page.evaluate("(() => { const b = document.querySelector('.tpq-usage-entry'); if (!b) return false; b.click(); return true })()")
    if (entered !== true) throw new Error('徽标小窗里没有「用量统计」入口（.tpq-usage-entry）：宿主缺 layout 能力，或 usageStats 被关掉了')
    await page.waitFor("document.querySelector('.tpq-usage') !== null", { timeoutMs: 10_000, label: '用量统计整页' })
    // 首帧先是骨架、随后换数据。等「柱子 + 总分数字」都到位再拍，否则拍到的是灰条。
    await page.waitFor("(() => { const root = document.querySelector('.tpq-usage'); if (!root) return false; const bars = root.querySelectorAll('.tpq-usage-rect, .tpq-usage-face-front'); const big = root.querySelector('.tpq-usage-big'); return bars.length > 0 && big !== null && (big.textContent || '').trim().length > 0 })()", { timeoutMs: 20_000, label: '用量数据渲染（柱子 + 总分）' })
    await sleep(600)
    const geometry = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (!root) return null; const r = root.getBoundingClientRect(); return { width: r.width, height: r.height, vw: innerWidth, vh: innerHeight } })()")
    if (geometry === null) throw new Error('量不到用量统计屏的矩形')
    // 座位必须真的替换会话主区（侧栏保留）。只占一小块 = 它退化成了浮层，
    // 与 README 说的「独立整页座位」不符 —— 那种图不能进 docs/。
    if (geometry.width < geometry.vw * 0.6) {
      throw new Error('用量统计没有占满主区（宽 ' + Math.round(geometry.width) + 'px / 视口 ' + geometry.vw + 'px），不拍')
    }
    const bigText = async () => await page.evaluate("(() => { const n = document.querySelector('.tpq-usage-big'); return n === null ? null : (n.textContent || '').trim() })()")
    const barCount = async () => await page.evaluate("document.querySelectorAll('.tpq-usage rect.tpq-usage-rect, .tpq-usage polygon.tpq-usage-face-front').length")
    const headText = async () => await page.evaluate("(() => { const t = document.querySelector('.tpq-usage-title'); const r = document.querySelector('.tpq-usage-range'); return { title: t === null ? null : (t.textContent || '').trim(), range: r === null ? null : (r.textContent || '').trim() } })()")
    /**
     * 两种画法的按钮文案就是 "2D" / "3D"（两种语言都相同），没有 data-mode 之类的钩子，
     * 只能按可见文本选 —— 按顺序取 [1] 会在将来加视图时默默点错。
     */
    const switchMode = async (mode, selector) => {
      const ok = await page.evaluate("(() => { const b = [...document.querySelectorAll('.tpq-usage-mode')].find(n => (n.textContent || '').trim() === '" + mode + "'); if (!b) return false; b.click(); return true })()")
      if (ok !== true) throw new Error('找不到 ' + mode + ' 视图按钮（.tpq-usage-mode）')
      await page.waitFor('document.querySelector(' + JSON.stringify(selector) + ') !== null', { timeoutMs: 8_000, label: mode + ' 柱子' })
      await sleep(400)
    }

    const head = await headText()
    if (head.title === null || head.range === null) throw new Error('用量统计屏缺标题或区间副标题（拍出来会是无标题的图）')
    console.log('  标题：' + head.title + '；区间：' + head.range)

    await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')
    const text2d = await bigText()
    const count2d = await barCount()
    if (text2d === null || count2d === 0) throw new Error('2D 视图没有数据（总分或柱子为空），不拍')
    if (args.shots.includes(8)) save('usage-2d.png', await page.shot({}))

    await switchMode('3D', '.tpq-usage polygon.tpq-usage-face-front')
    const text3d = await bigText()
    const count3d = await barCount()
    if (text3d === null || count3d === 0) throw new Error('3D 视图没有数据（总分或柱子为空），不拍')
    // 同一份数据的两个投影：总分与桶数不一致，说明 3D 那次是另一次（可能失败的）加载，不是换了个画法。
    if (text2d !== text3d || count2d !== count3d) {
      throw new Error('2D/3D 数据不一致（总分 ' + text2d + ' vs ' + text3d + '，柱数 ' + count2d + ' vs ' + count3d + '），不拍 3D')
    }
    if (args.shots.includes(9)) save('usage-3d.png', await page.shot({}))
    console.log('  用量统计：' + count2d + ' 个桶，总分 ' + text2d)

    // 收尾：点屏头关闭回到会话。留着整页座位，后面任何步骤都会拍到统计屏。
    const closed = await page.evaluate("(() => { const b = document.querySelector('.tpq-usage-close'); if (!b) return false; b.click(); return true })()")
    if (closed !== true) throw new Error('找不到用量统计屏的关闭按钮（.tpq-usage-close）')
    await page.waitFor("document.querySelector('.tpq-usage') === null", { timeoutMs: 8_000, label: '关闭用量统计页' })
  }

  console.log('拦截命中次数：' + hits.hits())
  console.log('产物：\n  ' + produced.join('\n  '))
  cdp.close()
  browser.close()
}

await main()
