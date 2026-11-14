/**
 * README 截图物料生成器。
 *
 *   node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 [--lang zh|en] [--out docs/images]
 *                                     [--shots 2,3,4,5,6,7,8,9,10,11,13,14,15,16] [--edge <path>] [--ffmpeg <path>] [--allow-live]
 *                                     [--width <px>] [--height <px>] [--allow-docs]
 *
 * 两件事决定了这个脚本的形状：
 *  - **合成数据**：图里绝不能出现真实余额（README 的立场靠这张图自证，漏一次就白洗过仓库），
 *    所以拦截 `/token-plan-quota/summary` 与 `/token-plan-quota/refresh`，换成 `fixture.mjs` 造的数据。
 *    两个都要拦：面板那个"更新于"按钮会 POST refresh 并把快照覆盖回去（`lib/client.js:1090`）。
 *    用量统计屏是第三个接口（`/token-plan-quota/usage?days=N`，绝对 token 数），同样换成 fixture：
 *    那边的数字一旦来自真实实例，这张图就再也不能证明"仓库里没有真实用量"。
 *    007 起同一接口还接 `from`+`to`（自定义区间），010 起再接 `month=YYYY-MM`（按月份），三个入口互斥，
 *    各按查询分开造夹具（拿 7 天的数据回答 31 天的请求，桶数与区间副标题必然对不上）。
 *  - **要活会话**：徽标注入的座位是 `conversation.input.left`（`lib/client.js:1157`），
 *    没有打开的会话就没有 DOM 座位。宿主自带的 `?fixture` 模式（内存假宿主，含种子会话与
 *    默认模型）正好提供这个状态，于是不需要真凭据、不需要种工作区。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { launchEdge, Cdp } from './cdp.mjs'
import { makeSnapshot, assertFixture, makeUsageSnapshot, assertUsageFixture, makeUsageOfficialSnapshot, assertUsageOfficialFixture, usageTooltipBar, USAGE_TOOLTIP_BAR_MONTH, USAGE_TOOLTIP_BAR_DATE, usageModelSharePercent, usageCacheHitRatePercent, USAGE_COMPOSITION_MODEL_COUNT, USAGE_COMPOSITION_FIRST_MODEL_ID, USAGE_COMPOSITION_FIRST_MODEL_SHARES, USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE, builtCredits, assertUsageCreditsFixture, USAGE_CREDITS_CLASSES, USAGE_CREDITS_MODELS } from './fixture.mjs'

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { lang: 'zh', out: 'docs/images', shots: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16], allowLive: false, width: 1280, height: 860 }
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

/**
 * 007 那张自定义区间图要一段**跨月**的固定跨度：今天所在月往前推 2 个月的 1 号 → 今天。
 * 日期不能写死：写死某天以后，它会变成"未来日期"或超出宿主能回填的范围，图就再也拍不出来。
 * 这里用与 fixture 同一套本地日算法现算（本地时区，不经 UTC 换算）。
 */
function localDayKey(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function customRangeFor(now) {
  const today = new Date(now)
  const first = new Date(today.getFullYear(), today.getMonth() - 2, 1)
  return { from: localDayKey(first), to: localDayKey(today) }
}

/**
 * 010 那张"按月份"的图固定拍**上一个自然月**：当月还没过完，夹到今天之后只有十几天，
 * 读者看不出"整月 31 根柱"这个要点；再往前的月份又可能超出宿主能回填的范围。
 * 1 月要跨年（2026-01 → 2025-12），所以用 Date 构造而不是字符串减一。
 */
function prevMonthOf(now) {
  const today = new Date(now)
  return localDayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7)
}

/**
 * `lib/client.js` 的 `formatTokens` 紧凑量纲在本脚本里的镜像（zh 万/亿，en B/M/K）。
 *
 * 只给 ⑭ 的浮层断言用。INTERFACE §2.2/§6 规定 tokens 行是
 * `formatTokens(totals.tokens) + usageTokensUnit`，所以断言必须按**同一套量纲**比对
 * （zh「140.3万」、en「1.40M」），而不是比对原始整数 1,403,000 —— 浮层本来就不印原始整数。
 * 客户端换了量纲这里会红，那正是截图契约要拦的漂移；反之若这里写死字符串，
 * 客户端改口径时只会得到一句看不懂的"图不对"。
 */
function compactTokens(value, langKey) {
  const abs = Math.abs(value)
  if (langKey === 'zh') {
    if (abs >= 1e8) return (value / 1e8).toFixed(2) + '亿'
    if (abs >= 1e4) return (value / 1e4).toFixed(1) + '万'
    if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    return String(Math.round(value * 100) / 100)
  }
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (abs >= 1e4) return Math.round(value / 1e3) + 'K'
  if (abs >= 1e3) return (value / 1e3).toFixed(1) + 'K'
  return String(Math.round(value * 100) / 100)
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/shots/make-shots.mjs --url http://127.0.0.1:<port> [--lang zh|en] [--out docs/images] [--shots 2,3,4,5,6,7,8,9,10,11,13,14,15,16] [--width 375] [--height 768] [--allow-docs]')
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

  /**
   * 当前要喂的变体；改它不需要重载页面（点徽标就会重新拉一次 summary）。
   * `officialError` 是 ⑫ 的开关：置 true 后官方接口回约定的失败体（200 + error/code/hint），
   * 用来拍「官方失败但本机照常可读」的 QA 图（只落 .shots-work，不进 docs/）。
   */
  const live = { variant: 'panel', officialError: false }
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
   * 用量统计是另一个接口，006 按 `days` 取参、007 追加 `from`+`to`（自定义区间）。7 天的 fixture
   * 拿去回答 90 天的请求，屏上的区间副标题、桶数和坐标轴就会和数字对不上 —— 那不是截图瑕疵，是假数据。
   * 所以按查询分开缓存，各写一份 .shots-work/<lang>/usage-<days>d.json、
   * usage-custom-<from>_<to>.json 或 usage-month-<YYYY-MM>.json 供事后核对。
   *
   * `now` 只取一次：自定义区间的 `to` 会被宿主夹到今天，若造 fixture 与断言各取一次 Date.now()，
   * 跨零点那次运行就会出现「桶数对不上」的假失败。
   */
  const usageNow = Date.now()
  const isDayKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  /**
   * 010：`month=YYYY-MM` 是第三个查询入口（与 from/to 互斥）。判定规则与 fixture 的 `usageMonthArg`
   * 对齐 —— 只有 trim 后非空的串才算"给了 month"，空串按宿主语义当没传（退回 days 分支）。
   * 键与落盘文件都按 month 单独命名，免得 31 天的快照被上一轮 7 天的缓存回答。
   */
  const monthArg = query => {
    const raw = typeof query.month === 'string' ? query.month.trim() : ''
    return raw === '' ? null : raw
  }
  const usageCache = new Map()
  const builtUsage = query => {
    const month = monthArg(query)
    const custom = month === null && isDayKey(query.from) && isDayKey(query.to)
    const key = month !== null ? `m${month}` : custom ? `c${query.from}_${query.to}` : `d${query.days}`
    if (!usageCache.has(key)) {
      const usage = makeUsageSnapshot({ now: usageNow, ...query })
      assertUsageFixture(usage, { lang: langKey, now: usageNow, ...query })
      const file = month !== null ? `usage-month-${month}.json` : custom ? `usage-custom-${query.from}_${query.to}.json` : `usage-${query.days}d.json`
      writeFileSync(join(workDir, file), JSON.stringify(usage, null, 1))
      usageCache.set(key, { json: JSON.stringify(usage), usage })
    }
    return usageCache.get(key)
  }
  /**
   * 008：官方账号侧对照是第二个接口（`/token-plan-quota/usage-official`），查询参数与本机那份
   * 完全一致。缓存与落盘都必须分开：两份响应形状不同（官方多 source/coverage、没有 models/calls），
   * 共用一份 JSON 会拍出「官方格读的其实是本机数」的假图。键同样按 days / from+to / month 分开。
   */
  const officialCache = new Map()
  const builtOfficial = query => {
    const month = monthArg(query)
    const custom = month === null && isDayKey(query.from) && isDayKey(query.to)
    const key = month !== null ? `om${month}` : custom ? `oc${query.from}_${query.to}` : `o${query.days}`
    if (!officialCache.has(key)) {
      const official = makeUsageOfficialSnapshot({ now: usageNow, ...query })
      assertUsageOfficialFixture(official, { lang: langKey, now: usageNow, ...query })
      const file = month !== null ? `usage-official-month-${month}.json` : custom ? `usage-official-custom-${query.from}_${query.to}.json` : `usage-official-${query.days}d.json`
      writeFileSync(join(workDir, file), JSON.stringify(official, null, 1))
      officialCache.set(key, { json: JSON.stringify(official), official })
    }
    return officialCache.get(key)
  }
  /**
   * 014：Credits ↔ tokens 换算块是**第三个**接口（`/token-plan-quota/usage-credits`）。
   * 它没有查询参数（永远回本账期），只造一次；落盘单独一份 JSON，避免与 usage / usage-official
   * 混看时误以为"比值是从本机实测推的"——这块的分母是官方 Credits 计量。
   */
  const creditsFixture = (() => {
    const credits = builtCredits({ now: usageNow })
    assertUsageCreditsFixture(credits, { now: usageNow })
    writeFileSync(join(workDir, 'usage-credits.json'), JSON.stringify(credits, null, 1))
    return { json: JSON.stringify(credits), credits }
  })()
  const hits = page.intercept({
    patterns: [
      { urlPattern: '*token-plan-quota/summary*' },
      { urlPattern: '*token-plan-quota/refresh*' },
      { urlPattern: '*token-plan-quota/usage-credits*' },
      { urlPattern: '*token-plan-quota/usage*' },
      { urlPattern: '*token-plan-quota/usage-official*' },
      { urlPattern: `*${CONNECTION_BUNDLE}*` },
    ],
    respond: async request => {
      /*
       * 先判官方路由：`/token-plan-quota/usage-official` 也含 '/token-plan-quota/usage' 这个子串，
       * 顺序反了就会拿本机快照去回答官方请求（对照条上的三格会变成「官方 = 本机」）。
       */
      // 014：`/usage-credits` 同样含 '/token-plan-quota/usage' 子串，必须在泛化的 usage 分支之前判掉。
      if (request.url.includes('/token-plan-quota/usage-credits')) {
        return { body: creditsFixture.json, via: 'fixture-credits' }
      }
      if (request.url.includes('/token-plan-quota/usage-official')) {
        // ⑫ QA 专用：200 + {error,code,hint} 是宿主/客户端约定的失败体，客户端据此只坏这一块。
        if (live.officialError === true) {
          return { body: JSON.stringify({ error: 'official-unavailable', code: 'official-timeout', hint: '检查网络后重试' }), via: 'fixture-error' }
        }
        const params = new URL(request.url).searchParams
        const from = params.get('from')
        const to = params.get('to')
        // 010：month 优先于 from/to 与 days（与宿主 §1.2 的优先级一致）。混用宿主回 400，
        // 这里也直接报错 —— 猜一个分支糊过去，拍出来的必然是"查询条件与数据不一致"的图。
        const month = params.get('month')
        if (month !== null) {
          if (isDayKey(from) || isDayKey(to)) {
            throw new Error('usage-official 拦截：month 与 from/to 混用（' + request.url + '），宿主会回 400 usage-bad-range，不造图')
          }
          return { body: builtOfficial({ month }).json, via: 'fixture-official' }
        }
        if (isDayKey(from) || isDayKey(to)) {
          if (!(isDayKey(from) && isDayKey(to))) {
            throw new Error('usage-official 拦截：请求只带了 from/to 之一（' + request.url + '），宿主会回 400，不造图')
          }
          return { body: builtOfficial({ from, to }).json, via: 'fixture-official' }
        }
        const asked = Number(params.get('days'))
        const days = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 7
        return { body: builtOfficial({ days }).json, via: 'fixture-official' }
      }
      if (request.url.includes('/token-plan-quota/usage')) {
        const params = new URL(request.url).searchParams
        const from = params.get('from')
        const to = params.get('to')
        // 010：month 优先于 from/to 与 days（宿主 §1.2 同一顺序）；混用会回 400 usage-bad-range。
        const month = params.get('month')
        if (month !== null) {
          if (isDayKey(from) || isDayKey(to)) {
            throw new Error('usage 拦截：month 与 from/to 混用（' + request.url + '），宿主会回 400 usage-bad-range，不造图')
          }
          return { body: builtUsage({ month }).json, via: 'fixture' }
        }
        // 007：两端都在才走自定义分支（与宿主路由同一条判据）；只带一个宿主会回 400，
        // 这里也直接报错 —— 拿 days 分支糊过去会拍出一张"查询条件与数据不一致"的图。
        if (isDayKey(from) || isDayKey(to)) {
          if (!(isDayKey(from) && isDayKey(to))) {
            throw new Error('usage 拦截：请求只带了 from/to 之一（' + request.url + '），宿主会回 400，不造图')
          }
          return { body: builtUsage({ from, to }).json, via: 'fixture' }
        }
        // 参数解析不出来就按宿主默认（7 天）；天数上限由 fixture 自己夹紧，不在这里猜。
        const asked = Number(params.get('days'))
        const days = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 7
        return { body: builtUsage({ days }).json, via: 'fixture' }
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
        // 先找最后一个可见的 menu 容器：菜单是后挂载的，第一个往往是侧栏里别的 menu 类节点。
        // **但宿主换过弹层实现**：0.1.7-rc.2 的模型弹层容器 class 里没有 "menu"/"popover" 这类词
        // （行标签是 span._3B-Unq_cellLabel），只在这个容器里找就永远点不到「模型」行。
        // 所以容器里找不到就退回全文档搜：弹层打开时行文本本身就是唯一可点的目标。
        const menus = [...document.querySelectorAll('[class*="menu" i]')].filter(n => n.offsetParent !== null)
        const needles = ${JSON.stringify(match.replace(/\s+/g, ''))}
        const pick = root => [...root.querySelectorAll('*')].filter(n => n.offsetParent !== null
          && (n.innerText || '').replace(/\\s+/g, '').includes(needles))
        const cands = menus.length > 0 && pick(menus[menus.length - 1]).length > 0 ? pick(menus[menus.length - 1]) : pick(document)
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
    return menus.slice(-3).map(m => (m.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90))
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
    // fromLabel 同样可以是候选数组：宿主默认模型的显示名跟着**本体版本**变
    // （0.1.7-rc.2 的按钮写「DeepSeek-V41-Flash」，更早的写「DeepSeek-V4-Flash」）。
    // 只认一个名字时，换模型这一步一断，后面的链和用量图就一张都拍不出来。
    const froms = Array.isArray(fromLabel) ? fromLabel : [fromLabel]
    // 触发按钮在**页面级**（不在弹出的菜单容器里），所以要用 clickText 扫 document 的 button；
    // deepClick 只在"最后一个可见 menu 容器"里找，用在菜单开启之前必然点空。
    let fromHit = null
    for (const one of froms) if (await clickText(one)) { fromHit = one; break }
    if (fromHit === null) {
      const visible = await page.evaluate(`(() => [...document.querySelectorAll('button')].filter(n => n.offsetParent !== null).map(n => (n.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 24))()`)
      throw new Error(`点不到模型按钮（试过 ${JSON.stringify(froms)}）；可见按钮：${JSON.stringify(visible)}`)
    }
    await sleep(700)
    const rowLabels = [...new Set([UI[langKey].modelRow, '模型', 'Model'])]
    if (await deepClickAny(rowLabels) === null) {
      throw new Error(`点不到菜单里的模型行（试过 ${JSON.stringify(rowLabels)}）；当前可见菜单：${JSON.stringify(await menuDump())}`)
    }
    // 同上：宿主的模型弹层容器不一定带 "menu" 类，不能只在"最后一个 menu 容器"里等。
    // 弹层打开后模型名在可见文本里唯一，整页文本检查即可（滚动/隐藏节点不算）。
    await page.waitFor(`(() => {
      return (document.body.innerText || '').includes(${JSON.stringify(toLabel)})
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
    await switchModel(['DeepSeek-V41-Flash', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Flash'], 'GPT-5', [UI[langKey].measured, '实测', 'measured'])
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
      // from 给候选数组：默认模型的显示名随本体版本变（V41 / V4.1 / V4 三种写法都见过）。
      { shot: 6, file: 'state-token-plan-credits.png', to: 'Qwen3.8 Flash', from: ['DeepSeek-V41-Flash', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Flash'], chip: 'Token Plan' },
      // zhOnly：那张卡的说明文字宿主只发中文，英文界面下也是 —— 英文套宁可少一张。
      { shot: 7, file: 'state-no-history.png', to: 'MiniMax-M3', from: ['Qwen3.8 Flash', 'Qwen3.8-Flash'], chip: 'minimax-cn', zhOnly: true },
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

  /* ---------------------------- ⑧⑨⑩⑪⑫⑬⑭⑮⑯ 用量统计整页座位（2D / 3D / 自定义区间 / 官方对照 / 按月 / 悬停 / 构成 / Credits 换算） */
  if (args.shots.some(n => [8, 9, 10, 11, 12, 13, 14, 15, 16].includes(n))) {
    console.log('⑧⑨⑩⑪⑫⑬⑭⑮⑯ 用量统计整页座位（2D / 3D / 自定义区间 / 官方对照 / 按月 / 柱子悬停 / 用量构成 / Credits 换算）')
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
    const geometry = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (!root) return null; const r = root.getBoundingClientRect(); return { width: r.width, height: r.height, vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth } })()")
    if (geometry === null) throw new Error('量不到用量统计屏的矩形')
    // 座位必须真的替换会话主区（侧栏保留）。只占一小块 = 它退化成了浮层，
    // 与 README 说的「独立整页座位」不符 —— 那种图不能进 docs/。
    if (geometry.width < geometry.vw * 0.6) {
      throw new Error('用量统计没有占满主区（宽 ' + Math.round(geometry.width) + 'px / 视口 ' + geometry.vw + 'px），不拍')
    }
    /*
     * 整页座位不许横向溢出：一旦 scrollWidth 超过 clientWidth，右侧（关闭按钮/最后一个日期框）
     * 会被裁在图外，而截图本身看不出来"少了东西"。窄视口 QA 尤其要靠这条，而不是靠肉眼。
     */
    if (geometry.sw > geometry.cw + 1) {
      throw new Error('用量统计整页横向溢出（scrollWidth ' + geometry.sw + ' > clientWidth ' + geometry.cw + '，视口 ' + geometry.vw + 'px），不拍')
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

    /**
     * 官方账号侧对照块（spec 008）就绪断言：008 起每次本机快照成功都会再请求 usage-official，
     * 并把对照条渲染在柱图卡下面。任何用量场景拍之前都要过这一关 —— 少了它，图里要么缺一块，
     * 要么是「官方取不到」的错误态，而截图本身看不出来。
     * 三格数字必须是纯整数（INTERFACE §3.2：无千分位），细分行与说明段非空；块内不许出现 % / Credits。
     */
    const officialReady = async label => {
      const wait = '(() => { const b = document.querySelector("[data-usage-official]"); if (b === null) return false; const neg = b.querySelector("[data-usage-official-error]"); if (neg !== null) return true; const v = b.querySelector("[data-usage-official-local] .tpq-usage-official-value"); return b.getAttribute("data-stale") === "0" && v !== null && (v.textContent || "").trim() !== "" })()'
      await page.waitFor(wait, { timeoutMs: 25_000, label: label + ' 官方账号侧对照块' })
      await sleep(300)
      const probe = '(() => { const box = document.querySelector("[data-usage-official]"); if (box === null) return { ok: false, why: "missing" }; const val = s => { const n = box.querySelector(s + " .tpq-usage-official-value"); return n === null ? null : (n.textContent || "").trim() }; const errEl = box.querySelector("[data-usage-official-error]"); const loadEl = box.querySelector("[data-usage-official-loading]"); const splitEl = box.querySelector("[data-usage-official-split]"); const noteEl = box.querySelector(".tpq-usage-official-note"); const r = box.getBoundingClientRect(); let sc = box.parentElement; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const text = (box.innerText || ""); return { ok: true, stale: box.getAttribute("data-stale"), err: errEl === null ? "" : (errEl.textContent || "").trim(), loading: loadEl !== null, cells: { official: val("[data-usage-official-official]"), local: val("[data-usage-official-local]"), gap: val("[data-usage-official-gap]") }, split: splitEl === null ? "" : (splitEl.textContent || "").trim(), note: noteEl === null ? "" : (noteEl.textContent || "").trim(), percent: text.indexOf("%") >= 0, credits: text.indexOf("Credits") >= 0, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }, vh: innerHeight, scrollTop: sc === null ? 0 : Math.round(sc.scrollTop) } })()'
      const state = await page.evaluate(probe)
      if (state === null || state.ok !== true) throw new Error(label + '：官方账号侧对照块不存在（[data-usage-official] 缺失），官方请求没发或渲染被关掉，不拍')
      if (state.loading === true) throw new Error(label + '：官方对照块还在 loading，不拍')
      if (state.err !== '') throw new Error(label + '：官方对照块是错误态（' + state.err + '），不拍')
      if (state.stale !== '0') throw new Error(label + '：官方对照块 data-stale=' + state.stale + '（还是上一个区间的数据），不拍')
      for (const key of ['official', 'local', 'gap']) {
        const raw = state.cells[key]
        const num = Number(String(raw === null ? '' : raw).replace(/[^0-9-]/g, ''))
        if (raw === null || String(raw).trim() === '' || !Number.isFinite(num)) throw new Error(label + '：官方对照块「' + key + '」格不是数字（' + raw + '），不拍')
      }
      if (state.split === '' || state.note === '') throw new Error(label + '：官方对照块缺细分行或说明段，不拍')
      if (state.percent === true) throw new Error(label + '：官方对照块出现百分比（%），不拍')
      if (state.credits === true) throw new Error(label + '：官方对照块出现 Credits，不拍')
      console.log('  官方对照就绪（' + label + '）：' + JSON.stringify(state.cells) + '；块 top ' + state.rect.top + ' / bottom ' + state.rect.bottom + ' / 高 ' + state.rect.h + '；视口 ' + state.vh + '；scrollTop ' + state.scrollTop)
      return state
    }

    const head = await headText()
    if (head.title === null || head.range === null) throw new Error('用量统计屏缺标题或区间副标题（拍出来会是无标题的图）')
    console.log('  标题：' + head.title + '；区间：' + head.range)

    await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')
    const text2d = await bigText()
    const count2d = await barCount()
    if (text2d === null || count2d === 0) throw new Error('2D 视图没有数据（总分或柱子为空），不拍')
    await officialReady('2D 视图（默认区间）')
    if (args.shots.includes(8)) save('usage-2d.png', await page.shot({}))

    // 3D 只在真要第 9 张（或要交叉验证 2D/3D 同源）时切：--shots 10 不该因为 3D 视图坏掉而失败。
    if (args.shots.some(n => [8, 9].includes(n))) {
      await switchMode('3D', '.tpq-usage polygon.tpq-usage-face-front')
      const text3d = await bigText()
      const count3d = await barCount()
      if (text3d === null || count3d === 0) throw new Error('3D 视图没有数据（总分或柱子为空），不拍')
      // 同一份数据的两个投影：总分与桶数不一致，说明 3D 那次是另一次（可能失败的）加载，不是换了个画法。
      if (text2d !== text3d || count2d !== count3d) {
        throw new Error('2D/3D 数据不一致（总分 ' + text2d + ' vs ' + text3d + '，柱数 ' + count2d + ' vs ' + count3d + '），不拍 3D')
      }
      await officialReady('3D 视图（默认区间）')
      if (args.shots.includes(9)) save('usage-3d.png', await page.shot({}))
    }
    console.log('  用量统计：' + count2d + ' 个桶，总分 ' + text2d)

    if (args.shots.some(n => [10, 11, 12].includes(n))) {
      /*
       * 第 10 张证明 007 的自定义区间：屏上必须有可见的日期行（data-usage-custom + 两个 date input），
       * 桶数必须与 fixture 的 buckets 一致，标题/区间副标题必须回显该 from/to（被宿主夹紧时以响应真值为准）。
       * 任一条不满足就抛错 —— 拍一张没有日期行的图，等于把"自定义查询"的证据换成一张普通柱图。
       * ⑪⑫ 复用这一段查询：8 安装好以后，官方对照条只在这块屏上出现，用同一次自定义查询最省时间。
       */
      const range = customRangeFor(usageNow)
      const expected = builtUsage({ from: range.from, to: range.to }).usage.buckets.length
      if (expected < 1) throw new Error('自定义区间 fixture 没有桶，不拍')
      // 2D 柱形最容易读"桶覆盖区间首尾"；第 9 张可能把视图留在 3D。
      await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')

      const picked = await page.evaluate("(() => { const b = document.querySelector('[data-usage-preset=\"custom\"]'); if (b === null) return false; b.click(); return true })()")
      if (picked !== true) throw new Error('找不到「自定义」天数 chip（[data-usage-preset="custom"]）：007 客户端未落盘或钩子改名，不拍')
      await page.waitFor("document.querySelector('[data-usage-custom]') !== null", { timeoutMs: 8_000, label: '自定义日期行' })
      const hooks = await page.evaluate("(() => { const vis = n => n !== null && n.getBoundingClientRect().width > 0; const row = document.querySelector('[data-usage-custom]'); return { row: vis(row), from: vis(document.querySelector('[data-usage-from]')), to: vis(document.querySelector('[data-usage-to]')), apply: vis(document.querySelector('[data-usage-apply]')) } })()")
      if (hooks.row !== true || hooks.from !== true || hooks.to !== true || hooks.apply !== true) {
        throw new Error('自定义日期行不完整（data-usage-custom / data-usage-from / data-usage-to / data-usage-apply 缺失或不可见），不拍')
      }
      /*
       * 原生 date input 的值必须走 prototype setter 再派发 input/change：直接 el.value = ... 不会更新
       * React 的受控状态，点「查询」时发出去的还是旧日期 —— 那种图拍出来日期行和请求对不上。
       */
      const filled = await page.evaluate("(() => { const set = (selector, value) => { const el = document.querySelector(selector); if (el === null) return null; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value }; return { from: set('[data-usage-from]', '" + range.from + "'), to: set('[data-usage-to]', '" + range.to + "') } })()")
      if (filled === null || filled.from !== range.from || filled.to !== range.to) {
        throw new Error('date input 没接受查询区间（期望 ' + range.from + ' → ' + range.to + '，实际 ' + JSON.stringify(filled) + '），不拍')
      }
      const applied = await page.evaluate("(() => { const b = document.querySelector('[data-usage-apply]'); if (b === null) return false; b.click(); return true })()")
      if (applied !== true) throw new Error('找不到自定义区间的「查询」按钮（data-usage-apply），不拍')

      const waitCustom = "(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return false; const t = root.querySelector('.tpq-usage-title'); const r = root.querySelector('.tpq-usage-range'); const head = ((t === null ? '' : t.textContent) || '') + ' ' + ((r === null ? '' : r.textContent) || ''); const big = root.querySelector('.tpq-usage-big'); const bars = root.querySelectorAll('rect.tpq-usage-rect').length; return bars === " + expected + " && head.indexOf(" + JSON.stringify(range.from) + ") >= 0 && head.indexOf(" + JSON.stringify(range.to) + ") >= 0 && big !== null && (big.textContent || '').trim().length > 0 })()"
      await page.waitFor(waitCustom, { timeoutMs: 25_000, label: '自定义区间数据（日期回显 + 桶数）' })
      await sleep(600)

      const customHead = await headText()
      const customBars = await barCount()
      const customBig = await bigText()
      const headAll = ((customHead.title || '') + ' ' + (customHead.range || '')).replace(/\\s+/g, ' ').trim()
      if (customBars !== expected) throw new Error('自定义区间柱数 ' + customBars + ' 与 fixture 桶数 ' + expected + ' 不一致，不拍')
      if (!headAll.includes(range.from) || !headAll.includes(range.to)) {
        throw new Error('标题/区间副标题没有回显 ' + range.from + ' → ' + range.to + '（实际：' + headAll + '），不拍')
      }
      for (const banned of ['%', 'Credits']) {
        if (headAll.includes(banned) || (customBig || '').includes(banned)) throw new Error('自定义区间屏出现禁用词「' + banned + '」，不拍')
      }
      // chip 必须停在「自定义」：否则日期行与"预设仍在生效"同时出现，读者无法判断这张图是哪种查询。
      const cleanChip = await page.evaluate("(() => { const b = document.querySelector('[data-usage-preset=\"custom\"]'); return b !== null && b.getAttribute('data-active') === '1' && b.getAttribute('aria-pressed') === 'true' })()")
      if (cleanChip !== true) throw new Error('「自定义」chip 没有处于选中态（data-active/aria-pressed 不对），不拍')
      await officialReady('自定义区间 ' + range.from + ' → ' + range.to)
      if (args.shots.includes(10)) save('usage-range-2d.png', await page.shot({}))
      console.log('  自定义区间：' + range.from + ' → ' + range.to + '（' + expected + ' 个桶，总分 ' + customBig + '）')

      /**
       * 把一个块滚进视口。整页座位在宿主的 main 区里滚动，官方对照条位于柱状图下方 ——
       * 自定义区间在 >62 天时会聚合成周桶，这块很容易落到折叠线以下。拍一张"块被裁掉一半"的图
       * 等于没拍到证据。用 scrollIntoView 而不是 window.scrollTo：滚动容器是宿主 main，不一定是 window。
       */
      /**
       * 官方对照条的取景：块在柱图卡下面，自定义区间很容易落到折叠线以下；拍一张"块被裁一半"的图
       * 等于没拍到证据。规则：先把块底边贴到视口底 16px（上面留最多上下文），再把顶边往上吸到
       * 最近的一个 .tpq-usage 子块边界 —— 避免图顶正好切在一行标题中间。只调滚动容器的 scrollTop
       * （滚动容器是宿主 main，不一定是 window）。取完仍不完整就抛错，不拍半块。
       */
      const frameUsage = async label => {
        const info = await page.evaluate(`(() => {
          const root = document.querySelector('.tpq-usage');
          if (root === null) return null;
          let sc = root.parentElement;
          while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement;
          if (sc === null) sc = document.scrollingElement;
          const box = document.querySelector('[data-usage-official]');
          if (box === null) return { missing: true };
          const doc = y => y + sc.scrollTop;
          const br = box.getBoundingClientRect();
          const docTop = doc(br.top);
          const docBottom = doc(br.bottom);
          const vh = innerHeight;
          const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
          const children = [...root.children].map(n => { const r = n.getBoundingClientRect(); return { top: doc(r.top), cls: (n.className || '').toString().slice(0, 30) } });
          let scrollTop = Math.max(0, Math.min(maxScroll, docBottom - (vh - 16)));
          const limit = docTop - 12;
          const cand = children.filter(c => c.top - 12 >= scrollTop && c.top - 12 <= limit).map(c => c.top - 12).sort((a, b) => a - b);
          if (cand.length > 0) scrollTop = Math.max(0, Math.min(maxScroll, cand[0]));
          sc.scrollTop = scrollTop;
          return { scrollTop: Math.round(sc.scrollTop), vh, docTop: Math.round(docTop), docBottom: Math.round(docBottom), blockH: Math.round(br.height) };
        })()`)
        if (info === null) throw new Error(label + '：量不到用量统计屏，不拍')
        if (info.missing === true) throw new Error(label + '：官方对照块不存在，不拍')
        await sleep(400)
        const after = await page.evaluate('(() => { const box = document.querySelector("[data-usage-official]"); if (box === null) return null; const r = box.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight } })()')
        if (after === null || after.top < 6 || after.bottom > after.vh - 4) {
          throw new Error(label + '：官方对照块取景后仍不完整（top ' + (after === null ? '?' : after.top) + ' / bottom ' + (after === null ? '?' : after.bottom) + ' / 视口 ' + (after === null ? '?' : after.vh) + '），不拍')
        }
        console.log('  取景（' + label + '）：scrollTop ' + info.scrollTop + '；块 ' + after.top + '→' + after.bottom + ' / 视口 ' + after.vh + '（块高 ' + info.blockH + '）')
      }

      const bringIntoView = async (selector, label) => {
        const probe = '(() => { const n = document.querySelector(' + JSON.stringify(selector) + '); if (n === null) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight } })()'
        const before = await page.evaluate(probe)
        if (before === null) throw new Error(label + '不存在（' + selector + '），不拍')
        if (before.top >= 0 && before.bottom <= before.vh) return
        await page.evaluate('(() => { const n = document.querySelector(' + JSON.stringify(selector) + '); if (n === null) return false; n.scrollIntoView({ block: "center" }); return true })()')
        await sleep(500)
        const after = await page.evaluate(probe)
        if (after === null || after.top < 0 || after.bottom > after.vh) {
          throw new Error(label + '滚不进视口（top ' + (after === null ? '?' : Math.round(after.top)) + ' / bottom ' + (after === null ? '?' : Math.round(after.bottom)) + ' / 视口高 ' + (after === null ? '?' : after.vh) + '），不拍')
        }
      }

      /*
       * ⑪ 官方账号侧对照（spec 008）。三格数字必须与 fixture 的 totals 逐个相等 —— 只等"块出现"
       * 会拍到 loading，或拍到上一个区间的数字。差额按官方 − 本机带符号比，别信肉眼。
       * 说明段要同时含两层意思：其他设备/客户端也算在里面；官方口径是 Token 总数、输入侧已含缓存读取（两项不相加）。
       */
      if (args.shots.includes(11)) {
        const officialFixture = builtOfficial({ from: range.from, to: range.to }).official
        const localFixture = builtUsage({ from: range.from, to: range.to }).usage
        const expectOfficial = Math.round(Number(officialFixture.totals.tokens))
        const expectLocal = Math.round(Number(localFixture.totals.tokens))
        const expectGap = expectOfficial - expectLocal
        const gapText = expectGap > 0 ? '+' + expectGap : String(expectGap)
        const waitOfficial = '(() => { const root = document.querySelector("[data-usage-official]"); if (root === null) return false; const val = s => { const n = root.querySelector(s + " .tpq-usage-official-value"); if (n === null) return false; const t = (n.textContent || "").trim(); return t !== "" && Number.isFinite(Number(t)) }; return root.getAttribute("data-stale") === "0" && val("[data-usage-official-official]") && val("[data-usage-official-local]") && val("[data-usage-official-gap]") })()'
        await page.waitFor(waitOfficial, { timeoutMs: 25_000, label: '官方账号侧对照（三格数字）' })
        await sleep(400)
        const cells = await page.evaluate('(() => { const root = document.querySelector("[data-usage-official]"); if (root === null) return null; const val = s => { const n = root.querySelector(s + " .tpq-usage-official-value"); return n === null ? null : (n.textContent || "").trim() }; const split = root.querySelector("[data-usage-official-split]"); const note = root.querySelector(".tpq-usage-official-note"); const gapCell = root.querySelector("[data-usage-official-gap]"); return { official: val("[data-usage-official-official]"), local: val("[data-usage-official-local]"), gap: val("[data-usage-official-gap]"), gapSign: gapCell === null ? null : gapCell.getAttribute("data-sign"), split: split === null ? null : (split.textContent || "").trim(), note: note === null ? null : (note.textContent || "").trim() } })()')
        if (cells === null) throw new Error('官方对照块读不到（[data-usage-official] 缺失），不拍')
        const toInt = text => { const num = Number(String(text === null ? '' : text).replace(/[^0-9-]/g, '')); return Number.isFinite(num) ? num : null }
        const gotOfficial = toInt(cells.official)
        const gotLocal = toInt(cells.local)
        if (gotOfficial !== expectOfficial) throw new Error('官方格「' + cells.official + '」与 fixture totals.tokens ' + expectOfficial + ' 不一致，不拍')
        if (gotLocal !== expectLocal) throw new Error('本机格「' + cells.local + '」与 fixture totals.tokens ' + expectLocal + ' 不一致，不拍')
        if (String(cells.gap).replace(/\s+/g, '') !== gapText) throw new Error('差额格「' + cells.gap + '」应为「' + gapText + '」（官方 − 本机），不拍')
        const expectSign = expectGap > 0 ? 'pos' : expectGap < 0 ? 'neg' : 'zero'
        if (cells.gapSign !== expectSign) throw new Error('差额格的 data-sign 是「' + cells.gapSign + '」，应为「' + expectSign + '」，不拍')
        const splitNumbers = (String(cells.split === null ? '' : cells.split).match(/-?[0-9]+/g) || []).map(Number).sort((a, b) => a - b)
        const expectSplit = [Math.round(Number(officialFixture.totals.input)), Math.round(Number(officialFixture.totals.cacheRead)), Math.round(Number(officialFixture.totals.output))].sort((a, b) => a - b)
        if (splitNumbers.length !== 3 || splitNumbers.some((value, index) => value !== expectSplit[index])) {
          throw new Error('官方四项细分「' + cells.split + '」与 fixture 的 input/cacheRead/output ' + JSON.stringify(expectSplit) + ' 不一致，不拍')
        }
        const noteNeedles = langKey === 'zh' ? ['其他设备', '缓存读取', '不相加'] : ['other devices', 'cache reads', 'do not add']
        for (const needle of noteNeedles) {
          if (!String(cells.note === null ? '' : cells.note).includes(needle)) {
            throw new Error('官方说明段缺「' + needle + '」（实际：' + cells.note + '），不拍')
          }
        }
        /*
         * 口径：012 起屏上允许出现百分比 —— 只有构成比与命中率走白名单段，且它们的值由 ⑮ 逐格复算；
         * 这里不再整屏禁 %（旧的一刀切会把合法的「占 57%」判成错图）。「Credits」仍只允许出现在脚注
         * （006 起脚注原文就有"不折算 Credits"），所以只扫 Credits。
         */
        const banned = await page.evaluate('(() => { const root = document.querySelector(".tpq-usage"); if (root === null) return null; const notes = root.querySelector(".tpq-usage-notes"); const notesText = notes === null ? "" : (notes.innerText || ""); const body = (root.innerText || "").replace(notesText, ""); return { credits: body.indexOf("Credits") >= 0 } })()')
        if (banned === null) throw new Error('量不到用量统计屏，不拍')
        if (banned.credits === true) throw new Error('官方对照屏（脚注以外）出现 Credits，不拍')
        await frameUsage('官方对照块')
        save('usage-official-2d.png', await page.shot({}))
        console.log('  官方对照：官方 ' + expectOfficial + ' / 本机 ' + expectLocal + ' / 差额 ' + gapText + '；细分 ' + cells.split)
      }

      /*
       * ⑫ QA：官方失败态（只落 .shots-work，不进 docs/）。失败体是 200 + {error,code,hint}，
       * 客户端只把这一块换成「原因 + 重试」，本机三张卡照旧 —— 图要证明的是「块内零数字」。
       * 失败必须靠换查询来触发：官方请求只在 key 变了（或显式 fresh）时才重发，而重试按钮本身
       * 只存在于错误态 —— 在成功态去找它，等于找一个不存在的按钮（实测踩过）。
       */
      if (args.shots.includes(12)) {
        live.officialError = true
        const altDate = new Date(range.from + 'T00:00:00')
        altDate.setDate(altDate.getDate() + 1)
        const altFrom = localDayKey(altDate)
        const altExpected = builtUsage({ from: altFrom, to: range.to }).usage.buckets.length
        const refilled = await page.evaluate('(() => { const el = document.querySelector("[data-usage-from]"); if (el === null) return null; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(el, ' + JSON.stringify(altFrom) + '); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value })()')
        if (refilled !== altFrom) throw new Error('官方失败态换日期没生效（期望 ' + altFrom + '，实际 ' + refilled + '），不拍')
        const reapplied = await page.evaluate('(() => { const b = document.querySelector("[data-usage-apply]"); if (b === null) return false; b.click(); return true })()')
        if (reapplied !== true) throw new Error('找不到自定义区间的「查询」按钮（data-usage-apply），拍不了官方失败态')
        await page.waitFor('document.querySelector("[data-usage-official] [data-usage-official-error]") !== null', { timeoutMs: 25_000, label: '官方失败态' })
        await sleep(400)
        const errorState = await page.evaluate('(() => { const blk = document.querySelector("[data-usage-official]"); if (blk === null) return null; const digits = (blk.innerText || "").match(/[0-9]/g); return { hasError: blk.querySelector("[data-usage-official-error]") !== null, hasRetry: blk.querySelector("[data-usage-official-retry]") !== null, cells: blk.querySelectorAll("[data-usage-official-official],[data-usage-official-local],[data-usage-official-gap],[data-usage-official-split]").length, digits: digits === null ? 0 : digits.length, text: (blk.innerText || "").trim() } })()')
        if (errorState === null) throw new Error('官方失败态读不到块，不拍')
        if (errorState.hasError !== true || errorState.hasRetry !== true) throw new Error('官方失败态缺 [data-usage-official-error] 或重试按钮，不拍')
        if (errorState.cells !== 0) throw new Error('官方失败态还留着 ' + errorState.cells + ' 个数字格，不拍')
        if (errorState.digits !== 0) throw new Error('官方失败态块内出现 ' + errorState.digits + ' 个数字字符，不拍')
        const errCopy = langKey === 'zh' ? '官方账号侧用量没取到' : 'Could not load official account usage'
        if (!errorState.text.includes(errCopy)) throw new Error('官方失败态文案不对（应含「' + errCopy + '」，实际：' + errorState.text + '），不拍')
        if (langKey === 'zh' && !errorState.text.includes('检查网络后重试')) throw new Error('官方失败态没有透出 hint（实际：' + errorState.text + '），不拍')
        /* 失败只落在一块：本机柱图必须照旧是这份 fixture 的桶数，别把整屏拍成空的。 */
        const errorBars = await barCount()
        if (errorBars !== altExpected) throw new Error('官方失败态下本机柱数 ' + errorBars + ' 与 fixture 桶数 ' + altExpected + ' 不一致，不拍')
        await frameUsage('官方失败态块')
        const qaDir = join(workDir, 'qa')
        mkdirSync(qaDir, { recursive: true })
        const qaPath = join(qaDir, 'usage-official-error.png')
        const qaBuffer = await page.shot({})
        writeFileSync(qaPath, qaBuffer)
        console.log('  QA 官方失败态（不进 docs/）：' + qaPath + '（' + (qaBuffer.length / 1024).toFixed(0) + ' KB）')
        live.officialError = false
      }
    }

    /*
     * ⑬ 按月查询（spec 010）。三件事必须同时成立才算证据：
     *  - 屏上有月份行（data-usage-month + <input type="month"> + 查询按钮），且 chip 停在「月份」；
     *  - 输入框吃掉填入的月份（受控组件要走 prototype setter，直接 el.value = … 不会更新 React 状态）；
     *  - 点查询后标题回显该月、柱数等于 fixture 该月的 buckets（整月 31 天 = 31 根柱是这张图的要点）。
     * 任一条不满足就抛错：拍一张"预设仍是近 7 天"的图，等于把按月查询的证据换成普通柱图。
     */
    if (args.shots.includes(13)) {
      const month = prevMonthOf(usageNow)
      const expectedMonth = builtUsage({ month }).usage
      const expectedBars = expectedMonth.buckets.length
      if (expectedBars < 1) throw new Error('按月 fixture 没有桶（month=' + month + '），不拍')
      await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')

      const pickedMonth = await page.evaluate("(() => { const b = document.querySelector('[data-usage-preset=\"month\"]'); if (b === null) return false; b.click(); return true })()")
      if (pickedMonth !== true) throw new Error('找不到「月份」chip（[data-usage-preset="month"]）：010 客户端未落盘或钩子改名，不拍')
      await page.waitFor("document.querySelector('[data-usage-month]') !== null", { timeoutMs: 8_000, label: '月份行' })
      const monthHooks = await page.evaluate("(() => { const vis = n => n !== null && n.getBoundingClientRect().width > 0; const row = document.querySelector('[data-usage-month]'); const input = document.querySelector('[data-usage-month-input]'); return { row: vis(row), input: vis(input), apply: vis(document.querySelector('[data-usage-month-apply]')), type: input === null ? null : input.getAttribute('type') } })()")
      if (monthHooks.row !== true || monthHooks.input !== true || monthHooks.apply !== true) {
        throw new Error('月份行不完整（data-usage-month / data-usage-month-input / data-usage-month-apply 缺失或不可见），不拍')
      }
      if (monthHooks.type !== 'month') throw new Error('月份输入框不是 <input type="month">（type=' + monthHooks.type + '），不拍')

      const filledMonth = await page.evaluate("(() => { const el = document.querySelector('[data-usage-month-input]'); if (el === null) return null; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, " + JSON.stringify(month) + "); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value })()")
      if (filledMonth !== month) throw new Error('月份输入框没接受 ' + month + '（实际 ' + filledMonth + '），不拍')
      const appliedMonth = await page.evaluate("(() => { const b = document.querySelector('[data-usage-month-apply]'); if (b === null) return false; b.click(); return true })()")
      if (appliedMonth !== true) throw new Error('找不到月份查询按钮（data-usage-month-apply），不拍')

      const parts = month.split('-')
      const year = parts[0]
      const monthNum = String(Number(parts[1]))
      // 标题里 {m} 补不补零，spec 自己的两处示例就不一致（"9 月" vs "09 月"），比较前两侧都去掉空白，两种都认。
      const titleNeedles = langKey === 'zh' ? [year + '年', monthNum + '月'] : [month]
      const waitMonth = "(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return false; const big = root.querySelector('.tpq-usage-big'); const bars = root.querySelectorAll('rect.tpq-usage-rect').length; return bars === " + expectedBars + " && big !== null && (big.textContent || '').trim().length > 0 })()"
      await page.waitFor(waitMonth, { timeoutMs: 25_000, label: '按月数据（桶数 + 总分）' })
      await sleep(600)

      // 标题/副标题可能比柱子晚一帧；用同步轮询等它回显，而不是拍完再肉眼发现不对。
      let monthHeadAll = ''
      let headOk = false
      for (let attempt = 0; attempt < 40 && headOk !== true; attempt += 1) {
        const head = await headText()
        monthHeadAll = ((head.title || '') + ' ' + (head.range || '')).trim()
        const compact = monthHeadAll.split(' ').join('')
        headOk = titleNeedles.every(needle => compact.includes(needle))
        if (headOk !== true) await sleep(200)
      }
      const monthBars = await barCount()
      const monthBig = await bigText()
      if (monthBars !== expectedBars) throw new Error('按月柱数 ' + monthBars + ' 与 fixture 桶数 ' + expectedBars + ' 不一致，不拍')
      if (headOk !== true) throw new Error('标题/区间副标题没有回显 ' + month + '（期望含 ' + JSON.stringify(titleNeedles) + '，实际：' + monthHeadAll + '），不拍')
      const monthChip = await page.evaluate("(() => { const b = document.querySelector('[data-usage-preset=\"month\"]'); return b !== null && b.getAttribute('data-active') === '1' && b.getAttribute('aria-pressed') === 'true' })()")
      if (monthChip !== true) throw new Error('「月份」chip 没有处于选中态（data-active/aria-pressed 不对），不拍')
      /* 口径同 ⑪：012 起构成比与命中率允许出现 %（值由 ⑮ 复算），这里只查脚注以外的 Credits。 */
      const monthBanned = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return null; const notes = root.querySelector('.tpq-usage-notes'); const notesText = notes === null ? '' : (notes.innerText || ''); const body = (root.innerText || '').split(notesText).join(''); return { credits: body.indexOf('Credits') >= 0 } })()")
      if (monthBanned === null) throw new Error('量不到用量统计屏，不拍')
      if (monthBanned.credits === true) throw new Error('按月屏（脚注以外）出现 Credits，不拍')
      await officialReady('按月 ' + month)

      /*
       * 脚注（.tpq-usage-notes）排在官方对照块之后：860 视口从页顶拍时它整个在折叠线下，
       * 这张图里看不到 007 的「仅统计本机」那句。图不改取景（否则丢掉月份行与柱图的证据），
       * 所以这里断言它确实在 DOM 里、文案对，并另存一张只进 .shots-work 的 QA 图做可见证据。
       */
      const notesProbe = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return null; const notes = root.querySelector('.tpq-usage-notes'); const r = notes === null ? null : notes.getBoundingClientRect(); return { lines: notes === null ? [] : Array.prototype.map.call(notes.querySelectorAll('p'), function (p) { return (p.textContent || '').trim() }), rect: r === null ? null : { top: Math.round(r.top), bottom: Math.round(r.bottom) }, vh: innerHeight } })()")
      if (notesProbe === null || notesProbe.rect === null) throw new Error('按月屏没有脚注（.tpq-usage-notes 缺失），不拍')
      const localOnlyNeedle = langKey === 'zh' ? '仅统计本机' : 'Only calls made by this DSH instance'
      if (!notesProbe.lines.some(function (t) { return t.indexOf(localOnlyNeedle) >= 0 })) {
        throw new Error('脚注缺「' + localOnlyNeedle + '」这句（实际：' + notesProbe.lines.join(' / ') + '），不拍')
      }
      console.log('  脚注：' + notesProbe.lines.length + ' 行，top ' + notesProbe.rect.top + ' / bottom ' + notesProbe.rect.bottom + '（视口高 ' + notesProbe.vh + '；从页顶拍时在折叠线下）')
      save('usage-month-2d.png', await page.shot({}))
      // QA（不进 docs/）：滚到脚注，把「仅统计本机」拍成可见证据，免得「图里没有」被读成「页面上没有」。
      // scrollIntoView({block:'end'}) 只保证「整块别在屏外」，实测底部正好贴着 860，按差值再多收 12px。
      await page.evaluate("(() => { const notes = document.querySelector('.tpq-usage .tpq-usage-notes'); if (notes === null) return null; notes.scrollIntoView({ block: 'end' }); let sc = notes.parentElement; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const box = sc === null ? document.scrollingElement : sc; const before = notes.getBoundingClientRect(); box.scrollTop = Math.max(0, box.scrollTop + Math.round(before.bottom - (innerHeight - 12))); return null })()")
      await sleep(350)
      const notesQa = await page.evaluate("(() => { const notes = document.querySelector('.tpq-usage .tpq-usage-notes'); if (notes === null) return null; const r = notes.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight } })()")
      if (notesQa === null || notesQa.top < 4 || notesQa.bottom > notesQa.vh - 4) {
        throw new Error('滚到脚注后仍不完整（top ' + (notesQa === null ? 'null' : notesQa.top) + ' / bottom ' + (notesQa === null ? 'null' : notesQa.bottom) + ' / vh ' + (notesQa === null ? 'null' : notesQa.vh) + '），不落 QA 图')
      }
      console.log('  QA 脚注取景：top ' + notesQa.top + ' / bottom ' + notesQa.bottom + ' / 视口 ' + notesQa.vh)
      const monthQaDir = join(workDir, 'qa')
      mkdirSync(monthQaDir, { recursive: true })
      const monthNotesPath = join(monthQaDir, 'usage-month-notes.png')
      writeFileSync(monthNotesPath, await page.shot({}))
      console.log('  QA 脚注（不进 docs/）：' + monthNotesPath)
      console.log('  按月查询：' + month + '（' + expectedBars + ' 个桶，总分 ' + monthBig + '）')
    }

    /*
     * ⑭ 柱子悬停（spec 011）：把**真鼠标**移到某根柱上，浮层要报出该桶的 tokens 明细。
     *
     * 这张图证明的是「柱 ↔ 桶」的对应关系，所以不能"随便找根柱子 hover 一下"：
     *  - 月份与锚柱取自 fixture 的常量（USAGE_TOOLTIP_BAR_*），不随真实时钟走，
     *    同一张 docs 图每次重拍的字节才可复现；
     *  - 浮层总量按 formatTokens 的紧凑量纲（zh 140.3万 / en 1.40M）比对，
     *    INTERFACE §2.2 规定它印的就是这个串，不是原始整数；
     *  - 位置、条数、禁用词（Credits；012 起 % 只允许来自构成比白名单）、四边夹紧逐项断言，最后才拍整视口。
     * 任一条不成立就抛错：拍一张"浮层首行是别的日期"的图，等于把悬停的证据换成一张普通柱图。
     */
    if (args.shots.includes(14)) {
      const month = USAGE_TOOLTIP_BAR_MONTH
      const expectedMonth = builtUsage({ month }).usage
      const anchor = usageTooltipBar(expectedMonth)
      const expectedBars = expectedMonth.buckets.length
      const expectedIndex = expectedMonth.buckets.findIndex(one => one.from === USAGE_TOOLTIP_BAR_DATE)
      if (expectedIndex < 0) throw new Error('fixture 的 ' + month + ' 里没有 ' + USAGE_TOOLTIP_BAR_DATE + ' 的桶，不拍')
      const tokensNeedle = compactTokens(anchor.totals.tokens, langKey)
      const needTip = { input: compactTokens(anchor.totals.input, langKey), output: compactTokens(anchor.totals.output, langKey), cacheRead: compactTokens(anchor.totals.cacheRead, langKey), cacheWrite: compactTokens(anchor.totals.cacheWrite, langKey), calls: compactTokens(anchor.totals.calls, langKey) }

      await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')
      // 回页顶：⑬ 可能刚为 QA 脚注滚到了底，柱子不在视口里就 hover 不到、也拍不到。
      const scrollTop = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return null; let sc = root; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const box = sc === null ? document.scrollingElement : sc; box.scrollTop = 0; return Math.round(box.scrollTop) })()")
      if (scrollTop === null) throw new Error('量不到用量统计屏的滚动容器，不拍')
      await sleep(250)

      // 月份视图用产品路径切：chip → 月份框 → 查询。直接调内部状态证明不了"用户点得开"。
      // 但 ⑬ 结束时月份行可能已经展开，再点一次 chip 会把它收起 —— 所以先看输入框在不在。
      const monthRowState = await page.evaluate("(() => { if (document.querySelector('[data-usage-month-input]') !== null) return 'open'; const b = document.querySelector('[data-usage-preset=month]'); if (b === null) return 'nochip'; b.click(); return 'clicked' })()")
      if (monthRowState === 'nochip') throw new Error('找不到「月份」chip（[data-usage-preset=month]），不拍')
      await page.waitFor("document.querySelector('[data-usage-month-input]') !== null", { timeoutMs: 8_000, label: '⑭ 月份行' })
      const filledMonth = await page.evaluate("(() => { const el = document.querySelector('[data-usage-month-input]'); if (el === null) return null; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, " + JSON.stringify(month) + "); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value })()")
      if (filledMonth !== month) throw new Error('⑭ 月份输入框没接受 ' + month + '（实际 ' + filledMonth + '），不拍')
      const appliedMonth14 = await page.evaluate("(() => { const b = document.querySelector('[data-usage-month-apply]'); if (b === null) return false; b.click(); return true })()")
      if (appliedMonth14 !== true) throw new Error('找不到月份查询按钮（data-usage-month-apply），不拍')
      const waitMonth14 = "(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return false; const bars = root.querySelectorAll('rect.tpq-usage-rect').length; const big = root.querySelector('.tpq-usage-big'); return bars === " + expectedBars + " && big !== null && (big.textContent || '').trim().length > 0 })()"
      await page.waitFor(waitMonth14, { timeoutMs: 25_000, label: '⑭ 按月数据（' + expectedBars + ' 根柱）' })
      await sleep(500)

      // 标题回显（口径同 ⑬：zh 认「YYYY 年 M 月」与补零两种，en 认 YYYY-MM）。
      const monthParts = month.split('-')
      const monthNeedles = langKey === 'zh' ? [monthParts[0] + '年', String(Number(monthParts[1])) + '月'] : [month]
      let monthHeadAll = ''
      let monthHeadOk = false
      for (let attempt = 0; attempt < 40 && monthHeadOk !== true; attempt += 1) {
        const head = await headText()
        monthHeadAll = ((head.title || '') + ' ' + (head.range || '')).trim()
        const compact = monthHeadAll.split(' ').join('')
        monthHeadOk = monthNeedles.every(needle => compact.includes(needle))
        if (monthHeadOk !== true) await sleep(200)
      }
      if (monthHeadOk !== true) throw new Error('⑭ 标题/区间副标题没有回显 ' + month + '（期望含 ' + JSON.stringify(monthNeedles) + '，实际：' + monthHeadAll + '），不拍')

      /*
       * 前置条件与 ⑬ 相同：同屏同取景，官方对照块也必须先就绪（它在 860 折叠线下、不进图，
       * 但少这道断言就分不清"图里恰好没露到"和"官方根本没取到"）。
       */
      await officialReady('柱子悬停')

      /*
       * 脚注口径同 ⑬：.tpq-usage-notes 排在官方对照块之后，从页顶拍时整个在折叠线下、图里看不到。
       * 这里只断言它存在且文案对（不落 QA 图）；否则实现回退把脚注删了，⑭ 会静默通过。
       */
      const notesProbe14 = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return null; const notes = root.querySelector('.tpq-usage-notes'); const r = notes === null ? null : notes.getBoundingClientRect(); return { lines: notes === null ? [] : Array.prototype.map.call(notes.querySelectorAll('p'), function (p) { return (p.textContent || '').trim() }), rect: r === null ? null : { top: Math.round(r.top), bottom: Math.round(r.bottom) }, vh: innerHeight } })()")
      if (notesProbe14 === null || notesProbe14.rect === null) throw new Error('⑭ 悬停屏没有脚注（.tpq-usage-notes 缺失），不拍')
      const localOnlyNeedle14 = langKey === 'zh' ? '仅统计本机' : 'Only calls made by this DSH instance'
      if (!notesProbe14.lines.some(function (t) { return t.indexOf(localOnlyNeedle14) >= 0 })) {
        throw new Error('⑭ 脚注缺「' + localOnlyNeedle14 + '」这句（实际：' + notesProbe14.lines.join(' / ') + '），不拍')
      }

      /*
       * 锚柱的测试钩子（INTERFACE §5）：命中区必须是 <g data-usage-bar>，带 index/from/to、
       * role="img"、tabindex=0 与非空 aria-label（键盘 Tab 与读屏走同一份文案）。
       */
      const barSelector = '[data-usage-bar][data-usage-bar-from="' + USAGE_TOOLTIP_BAR_DATE + '"]'
      await page.waitFor('document.querySelector(' + JSON.stringify(barSelector) + ') !== null', { timeoutMs: 8_000, label: '⑭ 锚柱（' + USAGE_TOOLTIP_BAR_DATE + '）' })
      const barHooks = await page.evaluate("(() => { const g = document.querySelector(" + JSON.stringify(barSelector) + "); if (g === null) return null; const r = g.getBoundingClientRect(); return { index: g.getAttribute('data-usage-bar-index'), from: g.getAttribute('data-usage-bar-from'), to: g.getAttribute('data-usage-bar-to'), role: g.getAttribute('role'), tabIndex: g.getAttribute('tabindex'), aria: g.getAttribute('aria-label'), rect: { x: r.x, y: r.y, width: r.width, height: r.height } } })()")
      if (barHooks === null) throw new Error('⑭ 找不到锚柱 ' + barSelector + '，不拍')
      if (barHooks.from !== USAGE_TOOLTIP_BAR_DATE || barHooks.to !== USAGE_TOOLTIP_BAR_DATE) throw new Error('⑭ 锚柱的 data-usage-bar-from/to 不是 ' + USAGE_TOOLTIP_BAR_DATE + '（' + barHooks.from + ' / ' + barHooks.to + '），不拍')
      if (barHooks.index !== String(expectedIndex)) throw new Error('⑭ 锚柱 index 是 ' + barHooks.index + '，fixture 里该桶序号是 ' + expectedIndex + '，不拍')
      if (barHooks.role !== 'img' || barHooks.tabIndex !== '0') throw new Error('⑭ 锚柱的 role/tabindex 不对（' + barHooks.role + ' / ' + barHooks.tabIndex + '），键盘不可达，不拍')
      if (typeof barHooks.aria !== 'string' || barHooks.aria === '' || barHooks.aria.indexOf(USAGE_TOOLTIP_BAR_DATE) < 0 || barHooks.aria.indexOf(tokensNeedle) < 0) {
        throw new Error('⑭ 锚柱 aria-label 不含日期或 tokens（' + barHooks.aria + '），不拍')
      }
      const barRect = barHooks.rect
      if (!(barRect.width > 0 && barRect.height > 0)) throw new Error('⑭ 锚柱矩形为空（' + JSON.stringify(barRect) + '），不拍')
      const centerX = barRect.x + barRect.width / 2
      const centerY = barRect.y + barRect.height / 2
      const vw14 = await page.evaluate('innerWidth')
      const vh14 = await page.evaluate('innerHeight')
      if (!(centerX > 0 && centerY > 0 && centerX < vw14 && centerY < vh14)) {
        throw new Error('⑭ 锚柱中心不在视口内（' + Math.round(centerX) + ',' + Math.round(centerY) + ' / ' + vw14 + '×' + vh14 + '），不拍')
      }

      await page.moveMouse(centerX, centerY)
      await page.waitFor("document.querySelector('[data-usage-tip]') !== null", { timeoutMs: 6_000, label: '⑭ 悬停浮层' })
      await sleep(300)
      const tip = await page.evaluate("(() => { const tips = document.querySelectorAll('[data-usage-tip]'); const tip = tips.length > 0 ? tips[0] : null; const txt = sel => { const n = tip === null ? null : tip.querySelector(sel); return n === null ? null : (n.textContent || '').trim() }; const r = tip === null ? null : tip.getBoundingClientRect(); const root = document.querySelector('.tpq-usage'); const notes = root === null ? null : root.querySelector('.tpq-usage-notes'); const notesText = notes === null ? '' : (notes.innerText || ''); const body = root === null ? '' : (root.innerText || '').split(notesText).join(''); return { count: tips.length, notesLen: notesText.trim().length, index: tip === null ? null : tip.getAttribute('data-usage-tip-index'), role: tip === null ? null : tip.getAttribute('role'), ariaHidden: tip === null ? null : tip.getAttribute('aria-hidden'), range: txt('[data-usage-tip-range]'), tokens: txt('[data-usage-tip-tokens]'), input: txt('[data-usage-tip-input]'), output: txt('[data-usage-tip-output]'), cacheRead: txt('[data-usage-tip-cache-read]'), cacheWrite: txt('[data-usage-tip-cache-write]'), calls: txt('[data-usage-tip-calls]'), rect: r === null ? null : { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }, vw: innerWidth, vh: innerHeight, percent: body.indexOf('%') >= 0, credits: body.indexOf('Credits') >= 0 } })()")
      if (tip === null || tip.rect === null) throw new Error('⑭ 悬停后量不到浮层，不拍')
      if (!(tip.notesLen > 0)) throw new Error('⑭ 浮层探针量不到脚注文本（.tpq-usage-notes 为空），Credits 的剔除口径不成立，不拍')
      if (tip.count !== 1) throw new Error('⑭ 同时存在 ' + tip.count + ' 个浮层（INTERFACE §2.2：最多一个），不拍')
      // 浮层是纯视觉呈现（012 复核第二轮）：不再有 role/id，只标 aria-hidden，避免读屏把同一桶念两遍。
      if (tip.ariaHidden !== 'true') throw new Error('⑭ 浮层没有标 aria-hidden="true"（' + tip.ariaHidden + '），不拍')
      if (tip.role !== null) throw new Error('⑭ 浮层又挂回了 role（' + tip.role + '），012 复核已把它改成纯视觉，不拍')
      if (tip.index !== String(expectedIndex)) throw new Error('⑭ 浮层 data-usage-tip-index 是 ' + tip.index + '，期望 ' + expectedIndex + '，不拍')
      if (typeof tip.range !== 'string' || tip.range.indexOf(USAGE_TOOLTIP_BAR_DATE) < 0) throw new Error('⑭ 浮层首行不是 ' + USAGE_TOOLTIP_BAR_DATE + '（' + tip.range + '），不拍')
      if (typeof tip.tokens !== 'string' || tip.tokens.indexOf(tokensNeedle) < 0) throw new Error('⑭ 浮层 tokens 行不含 ' + tokensNeedle + '（' + tip.tokens + '），不拍')
      const rowNeedles = { input: [tip.input, needTip.input], output: [tip.output, needTip.output], cacheRead: [tip.cacheRead, needTip.cacheRead], cacheWrite: [tip.cacheWrite, needTip.cacheWrite], calls: [tip.calls, needTip.calls] }
      for (const [key, [actual, expected]] of Object.entries(rowNeedles)) {
        if (typeof actual !== 'string' || actual === '') throw new Error('⑭ 浮层缺 ' + key + ' 行，不拍')
        if (actual.indexOf(expected) < 0) throw new Error('⑭ 浮层 ' + key + ' 行不含 ' + expected + '（' + actual + '），不拍')
      }
      // SC-004：浮层与视口四边都留 ≥8px（夹紧逻辑的可见证据）。
      if (tip.rect.left < 8 || tip.rect.top < 8 || tip.rect.right > tip.vw - 8 || tip.rect.bottom > tip.vh - 8) {
        throw new Error('⑭ 浮层没有完整落在视口内（' + JSON.stringify(tip.rect) + ' / 视口 ' + tip.vw + '×' + tip.vh + '），不拍')
      }
      // 012 起整屏允许构成比/命中率的 %（白名单段），不再按「屏上有 %」判错，只查 Credits。
      if (tip.credits === true) throw new Error('⑭ 浮层所在屏（脚注以外）出现 Credits，不拍')
      if (langKey === 'en' && /\p{Script=Han}/u.test((tip.range || '') + (tip.tokens || ''))) throw new Error('⑭ 英文套浮层里混了中文（' + tip.range + ' / ' + tip.tokens + '），不拍')

      console.log('  ⑭ 锚柱 ' + USAGE_TOOLTIP_BAR_DATE + '：' + anchor.totals.tokens + ' tokens（界面写作 ' + tokensNeedle + '）；浮层 ' + JSON.stringify(tip.rect) + '；视口 ' + tip.vw + '×' + tip.vh)
      save('usage-tooltip-2d.png', await page.shot({}))
      // 移开指针：后面的步骤别带着浮层走，也别让"浮层没关掉"被当成关闭通路坏了。
      await page.moveMouse(0, 0)
      await page.waitFor("document.querySelector('[data-usage-tip]') === null", { timeoutMs: 5_000, label: '⑭ 移开后浮层消失' })
    }


    /*
     * ⑮ 用量构成（012）：一屏同时证明四件事 —— 中文分项标签、四类占比、缓存命中率、
     * 模型列表的内滚动。取景因此不再是页顶：把「按模型用量」卡滚进可视区上半部，
     * 图里能完整看到卡头、四行模型与那条细滚动条；官方对照与脚注仍在折叠线下，
     * 各自由 officialReady / 脚注断言兜底。
     * 数字口径：首条模型的 61.5% / 30.8% / 7.7% / 0 与命中率 11.1% 由 fixture 的权重算死；
     * 总量卡的命中率用 usageCacheHitRatePercent(week.totals) 复算，不从 DOM 反抄一遍。
     */
    if (args.shots.includes(15)) {
      const week = builtUsage({ days: 7 }).usage
      const expectedBars15 = week.buckets.length
      if (expectedBars15 !== 7) throw new Error('⑮ fixture 的 7 天响应不是 7 个桶（' + expectedBars15 + '），不拍')
      const first15 = week.models[0]
      if (first15 === undefined || first15.id !== USAGE_COMPOSITION_FIRST_MODEL_ID) throw new Error('⑮ fixture 首条模型不是 ' + USAGE_COMPOSITION_FIRST_MODEL_ID + '，不拍')
      const percentText = value => value === null || value === undefined ? '—' : (Number.isInteger(value) ? String(value) : value.toFixed(1)) + '%'
      const label15 = langKey === 'zh'
        ? { input: '输入', output: '输出', cacheRead: '缓存命中', cacheWrite: '缓存写入', hitRate: '缓存命中率', calls: '调用次数' }
        : { input: 'input', output: 'output', cacheRead: 'cache hit', cacheWrite: 'cache write', hitRate: 'cache hit rate', calls: 'requests' }
      const share15 = value => {
        const pct = percentText(usageModelSharePercent(value, week.totals.tokens))
        return langKey === 'zh' ? '占 ' + pct : pct + ' of total'
      }

      await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')
      // 回页顶再点 7 天：⑬/⑭ 可能把视图留在月份，那一排预设按钮只在页顶露出来。
      const top15 = await page.evaluate("(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return null; let sc = root; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const box = sc === null ? document.scrollingElement : sc; box.scrollTop = 0; return Math.round(box.scrollTop) })()")
      if (top15 === null) throw new Error('⑮ 量不到用量统计屏的滚动容器，不拍')
      await sleep(200)
      const picked7 = await page.evaluate("(() => { const b = [...document.querySelectorAll('.tpq-usage-day')].find(n => (n.textContent || '').trim() === '7'); if (!b) return false; b.click(); return true })()")
      if (picked7 !== true) throw new Error('⑮ 找不到「7 天」预设按钮（.tpq-usage-day），不拍')
      const wait15 = "(() => { const root = document.querySelector('.tpq-usage'); if (root === null) return false; const bars = root.querySelectorAll('rect.tpq-usage-rect').length; const big = root.querySelector('.tpq-usage-big'); return bars === " + expectedBars15 + " && big !== null && (big.textContent || '').trim().length > 0 })()"
      await page.waitFor(wait15, { timeoutMs: 25_000, label: '⑮ 7 天数据（' + expectedBars15 + ' 根柱）' })
      await sleep(500)

      let head15 = ''
      let headOk15 = false
      for (let attempt = 0; attempt < 40 && headOk15 !== true; attempt += 1) {
        const h = await headText()
        head15 = ((h.title || '') + ' ' + (h.range || '')).trim()
        headOk15 = head15.indexOf(week.range.from) >= 0 && head15.indexOf(week.range.to) >= 0
        if (headOk15 !== true) await sleep(200)
      }
      if (headOk15 !== true) throw new Error('⑮ 标题/区间副标题没有回显 7 天区间 ' + week.range.from + ' → ' + week.range.to + '（实际：' + head15 + '），不拍')
      const dayActive15 = await page.evaluate("(() => { const b = [...document.querySelectorAll('.tpq-usage-day')].find(n => (n.textContent || '').trim() === '7'); return b === null ? null : b.getAttribute('data-active') })()")
      if (dayActive15 !== '1') throw new Error('⑮「7 天」按钮不是选中态（data-active=' + dayActive15 + '），不拍')

      // 前置同 ⑬/⑭：官方对照块先就绪（它在折叠线下，不进图，但少这道断言就分不清"没露到"和"没取到"）。
      await officialReady('用量构成 7 天')

      // ① 总量卡六格：标签、数值、占比子行、命中率。标签与顺序都钉死 —— 少一格或退回英文都算不合格。
      const splitProbe = await page.evaluate("(() => { const box = document.querySelector('.tpq-usage .tpq-usage-splits'); if (box === null) return null; const pick = function (n, sel) { const el = n.querySelector(sel); return el === null ? null : (el.textContent || '').trim() }; const cells = [...box.querySelectorAll('.tpq-usage-split')].map(function (c) { return { label: pick(c, '.tpq-usage-split-label'), value: pick(c, '.tpq-usage-split-value'), share: pick(c, '.tpq-usage-split-share') } }); const root = document.querySelector('.tpq-usage'); const notes = root === null ? null : root.querySelector('.tpq-usage-notes'); const notesText = notes === null ? '' : (notes.innerText || ''); const body = root === null ? '' : (root.innerText || '').split(notesText).join(''); return { cells: cells, text: (box.innerText || ''), notesText: notesText, bodyCredits: body.indexOf('Credits') >= 0 } })()")
      if (splitProbe === null) throw new Error('⑮ 找不到总量卡的拆分格（.tpq-usage-splits），12 客户端未落盘，不拍')
      const expectLabels15 = [label15.input, label15.output, label15.cacheRead, label15.cacheWrite, label15.hitRate, label15.calls]
      const actualLabels15 = splitProbe.cells.map(c => c.label)
      if (actualLabels15.length !== 6) throw new Error('⑮ 总量卡不是 6 格（实际 ' + actualLabels15.length + ' 格：' + JSON.stringify(actualLabels15) + '），不拍')
      for (let i = 0; i < 6; i += 1) {
        if (actualLabels15[i] !== expectLabels15[i]) throw new Error('⑮ 总量卡第 ' + (i + 1) + ' 格标签是「' + actualLabels15[i] + '」，期望「' + expectLabels15[i] + '」，不拍')
      }
      if (langKey === 'zh' && /\b(input|output|cacheRead|cacheWrite)\b/.test(splitProbe.text)) throw new Error('⑮ 中文界面总量卡混了英文分项名（' + splitProbe.text + '），不拍')
      const splitValues15 = [week.totals.input, week.totals.output, week.totals.cacheRead, week.totals.cacheWrite]
      for (let i = 0; i < 4; i += 1) {
        const want = compactTokens(splitValues15[i], langKey)
        if ((splitProbe.cells[i].value || '') !== want) throw new Error('⑮ 总量卡「' + expectLabels15[i] + '」值是 ' + splitProbe.cells[i].value + '，期望 ' + want + '，不拍')
        const wantShare = share15(splitValues15[i])
        if ((splitProbe.cells[i].share || '') !== wantShare) throw new Error('⑮ 总量卡「' + expectLabels15[i] + '」占比子行是 ' + splitProbe.cells[i].share + '，期望 ' + wantShare + '，不拍')
      }
      const wantHit15 = percentText(usageCacheHitRatePercent(week.totals))
      if ((splitProbe.cells[4].value || '') !== wantHit15) throw new Error('⑮ 总量卡命中率是 ' + splitProbe.cells[4].value + '，期望 ' + wantHit15 + '，不拍')
      const wantCalls15 = compactTokens(week.totals.calls, langKey)
      if ((splitProbe.cells[5].value || '') !== wantCalls15) throw new Error('⑮ 总量卡调用次数是 ' + splitProbe.cells[5].value + '，期望 ' + wantCalls15 + '，不拍')

      // ② 模型列表：8 条、内滚动生效、键盘可达；首条的占比与命中率逐项对上 fixture。
      const modelProbe = await page.evaluate("(() => { const box = document.querySelector('[data-usage-models-scroll=\"1\"]'); if (box === null) return null; const pick = function (n, sel) { const el = n.querySelector(sel); return el === null ? null : (el.textContent || '').trim() }; const rows = [...box.querySelectorAll('.tpq-usage-model')].map(function (r) { return { id: pick(r, '.tpq-usage-model-id'), tokens: pick(r, '.tpq-usage-model-tokens'), splits: pick(r, '.tpq-usage-model-splits') } }); const cs = getComputedStyle(box); return { count: rows.length, rows: rows, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight, overflowY: cs.overflowY, maxHeight: cs.maxHeight, tabIndex: box.getAttribute('tabindex'), role: box.getAttribute('role'), aria: box.getAttribute('aria-label'), text: (box.innerText || '') } })()")
      if (modelProbe === null) throw new Error('⑮ 找不到模型列表容器（[data-usage-models-scroll="1"]），12 客户端未落盘，不拍')
      if (modelProbe.count !== USAGE_COMPOSITION_MODEL_COUNT) throw new Error('⑮ 模型列表有 ' + modelProbe.count + ' 条，fixture 是 ' + USAGE_COMPOSITION_MODEL_COUNT + ' 条，不拍')
      if (!(modelProbe.scrollHeight > modelProbe.clientHeight + 20)) throw new Error('⑮ 模型列表没有内滚动（scrollHeight ' + modelProbe.scrollHeight + ' / clientHeight ' + modelProbe.clientHeight + '），不拍')
      if (modelProbe.overflowY !== 'auto' && modelProbe.overflowY !== 'scroll') throw new Error('⑮ 模型列表 computed overflow-y 是 ' + modelProbe.overflowY + '，不是 auto/scroll，不拍')
      if (modelProbe.tabIndex !== '0') throw new Error('⑮ 模型列表 tabindex 是 ' + modelProbe.tabIndex + '，键盘不可达，不拍')
      if (modelProbe.role !== 'group') throw new Error('⑮ 模型列表 role 是 ' + modelProbe.role + '，不是 group，不拍')
      if (typeof modelProbe.aria !== 'string' || modelProbe.aria.trim() === '') throw new Error('⑮ 模型列表没有 aria-label，不拍')
      if (/undefined|NaN/.test(modelProbe.text)) throw new Error('⑮ 模型列表出现 undefined/NaN（' + modelProbe.text + '），不拍')
      const firstRow = modelProbe.rows[0]
      if (firstRow.id !== USAGE_COMPOSITION_FIRST_MODEL_ID) throw new Error('⑮ 模型列表首条是 ' + firstRow.id + '，期望 ' + USAGE_COMPOSITION_FIRST_MODEL_ID + '，不拍')
      if (firstRow.tokens !== compactTokens(first15.totals.tokens, langKey)) throw new Error('⑮ 首条模型 tokens 是 ' + firstRow.tokens + '，期望 ' + compactTokens(first15.totals.tokens, langKey) + '，不拍')
      const rowNeedles15 = [label15.input + ' ', label15.output + ' ', label15.cacheRead + ' ', label15.cacheWrite + ' ', '(' + percentText(USAGE_COMPOSITION_FIRST_MODEL_SHARES.input) + ')', '(' + percentText(USAGE_COMPOSITION_FIRST_MODEL_SHARES.output) + ')', '(' + percentText(USAGE_COMPOSITION_FIRST_MODEL_SHARES.cacheRead) + ')', (langKey === 'zh' ? '命中率 ' : 'hit rate ') + percentText(USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE)]
      for (const needle of rowNeedles15) {
        if (firstRow.splits.indexOf(needle) < 0) throw new Error('⑮ 首条模型的分项行缺「' + needle + '」（实际：' + firstRow.splits + '），不拍')
      }
      if (firstRow.splits.indexOf('(0%)') >= 0) throw new Error('⑮ 首条模型的缓存写入为 0 却印了 (0%)（' + firstRow.splits + '），不拍')
      if (langKey === 'zh' && /\b(input|output|cacheRead|cacheWrite)\b/.test(modelProbe.text)) throw new Error('⑮ 中文界面模型行混了英文分项名（' + modelProbe.text + '），不拍')
      if (langKey === 'en' && /\p{Script=Han}/u.test(modelProbe.text + splitProbe.text)) throw new Error('⑮ 英文界面模型行/总量卡混了中文，不拍')

      // ③ 脚注：两条公式与「不是配额比例」必须在（脚注在折叠线下，只断言、不进图）。
      const notesNeedle15 = langKey === 'zh' ? '不是配额比例' : 'not quota'
      const formulaNeedle15 = langKey === 'zh' ? '缓存命中率 = 缓存命中' : 'cache hit rate = cache hit'
      if (splitProbe.notesText.trim() === '') throw new Error('⑮ 屏上没有脚注文本（.tpq-usage-notes 为空），不拍')
      if (splitProbe.notesText.indexOf(notesNeedle15) < 0) throw new Error('⑮ 脚注缺「' + notesNeedle15 + '」（实际：' + splitProbe.notesText + '），不拍')
      if (splitProbe.notesText.indexOf(formulaNeedle15) < 0) throw new Error('⑮ 脚注缺命中率公式「' + formulaNeedle15 + '」（实际：' + splitProbe.notesText + '），不拍')
      // 006 的来源脚注本身含「不折算 Credits」，所以按脚注剔除后再查：图里别处仍不许出现 Credits。
      if (splitProbe.bodyCredits === true) throw new Error('⑮ 除脚注外整屏出现 Credits，不拍')

      /*
       * 取景：模型卡滚到可视区上半部（卡头 + 四行可见行 + 细滚动条同框）。
       * 等一帧再量，避免平滑滚动还没停下就拍；卡必须完整落在视口内，否则滚动条会被裁掉。
       */
      const framed15 = await page.evaluate("(() => { const list = document.querySelector('[data-usage-models-scroll=\"1\"]'); if (list === null) return null; const section = list.closest('section'); if (section === null) return null; section.scrollIntoView({ block: 'center' }); let sc = section.parentElement; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const box = sc === null ? document.scrollingElement : sc; const before = section.getBoundingClientRect(); box.scrollTop = Math.max(0, box.scrollTop + Math.round(before.top - 120)); list.scrollTop = 0; return { top: Math.round(section.getBoundingClientRect().top), scrollTop: Math.round(box.scrollTop) } })()")
      if (framed15 === null) throw new Error('⑮ 量不到「按模型用量」卡片的位置，不拍')
      await sleep(350)
      const frameState15 = await page.evaluate("(() => { const list = document.querySelector('[data-usage-models-scroll=\"1\"]'); if (list === null) return null; const section = list.closest('section'); if (section === null) return null; const r = section.getBoundingClientRect(); const lr = list.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), listTop: Math.round(lr.top), listBottom: Math.round(lr.bottom), listScrollTop: Math.round(list.scrollTop), vw: innerWidth, vh: innerHeight } })()")
      if (frameState15 === null) throw new Error('⑮ 取景后找不到「按模型用量」卡片，不拍')
      if (frameState15.top < 8 || frameState15.bottom > frameState15.vh - 8) throw new Error('⑮「按模型用量」卡片没有完整落在视口内（' + JSON.stringify(frameState15) + '），滚动条会被裁掉，不拍')
      if (frameState15.listBottom - frameState15.listTop < 100) throw new Error('⑮ 模型列表在取景里只剩 ' + (frameState15.listBottom - frameState15.listTop) + 'px，滚动条证据不明显，不拍')

      console.log('  ⑮ 7 天：' + modelProbe.count + ' 条模型；首条 ' + firstRow.id + ' 占比 ' + JSON.stringify(USAGE_COMPOSITION_FIRST_MODEL_SHARES) + ' / 命中率 ' + USAGE_COMPOSITION_FIRST_MODEL_HIT_RATE + '%；总量卡命中率 ' + wantHit15 + '；列表 ' + modelProbe.scrollHeight + '/' + modelProbe.clientHeight + 'px（' + modelProbe.overflowY + '）；取景 ' + JSON.stringify(frameState15))
      save('usage-composition-2d.png', await page.shot({}))
    }

    if (args.shots.includes(16)) {
      /*
       * ⑯ Credits ↔ tokens 换算块（014）：唯一一个**本账期混合口径**的块 ——
       * 分母是官方 Credits 计量、分子是官方账号 tokens，所以它既不是本机实测也不是区间快照。
       * 断言分五层：① 四个文本钩子都在且非空；② 展示串逐项等于 fixture 现值（比值 / 官方 tokens /
       * 已用 ÷ 总额 / 折算容量），这样客户端换量纲或换公式会在这里红，而不是拍出一张自相矛盾的图；
       * ③ 015 分项行：前缀 + 三类标签顺序 + 每类「每 Credit 多少 tokens」逐项等于 fixture 的 perCredit
       * （是 perCredit，不是三类 tokens 本身），且整行无 %；
       * ④ 015 按模型块：tabIndex/role/aria、行数与宿主顺序、每行 tokens/比值文本、252px 定高内滚；
       * ⑤ 口径护栏：无货币符号、无「Credits 剩余」、无 NaN/undefined，英文套不混中文。
       */
      const credits = creditsFixture.credits
      await switchMode('2D', '.tpq-usage rect.tpq-usage-rect')
      const wait16 = '(() => { const s = document.querySelector("[data-usage-credits]"); if (s === null) return false; const r = s.querySelector("[data-usage-credits-ratio]"); return s.getAttribute("data-stale") === "0" && r !== null && (r.textContent || "").trim() !== "" })()'
      await page.waitFor(wait16, { timeoutMs: 25_000, label: '⑯ Credits 换算块' })
      await sleep(400)
      const probe16 = await page.evaluate("(() => { const all = document.querySelectorAll('[data-usage-credits]'); const s = all.length > 0 ? all[0] : null; if (s === null) return { ok: false }; const pick = sel => { const n = s.querySelector(sel); return n === null ? null : (n.innerText || n.textContent || '').trim() }; const official = document.querySelector('[data-usage-official]'); const r = s.getBoundingClientRect(); return { ok: true, count: all.length, stale: s.getAttribute('data-stale'), ratio: pick('[data-usage-credits-ratio]'), window: pick('[data-usage-credits-window]'), detail: pick('[data-usage-credits-detail]'), estimate: pick('[data-usage-credits-estimate]'), note: pick('.tpq-usage-credits-note'), loading: s.querySelector('.tpq-usage-credits-loading') !== null, unavailable: s.querySelector('[data-usage-credits-unavailable]') !== null, retry: s.querySelector('[data-usage-credits-retry]') !== null, afterOfficial: official === null ? null : (official.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }, vh: innerHeight, text: (s.innerText || '') } })()")
      if (probe16 === null || probe16.ok !== true) throw new Error('⑯ 找不到 Credits 换算块（[data-usage-credits] 缺失）：014 客户端未落盘或请求没发，不拍')
      if (probe16.count !== 1) throw new Error('⑯ 屏上有 ' + probe16.count + ' 个 [data-usage-credits]，同一时刻应只有一个，不拍')
      if (probe16.stale !== '0') throw new Error('⑯ Credits 换算块 data-stale=' + probe16.stale + '（还是旧账期数据），不拍')
      if (probe16.loading === true) throw new Error('⑯ Credits 换算块还在 loading，不拍')
      if (probe16.unavailable === true) throw new Error('⑯ Credits 换算块是「暂不可用」态（fixture 给的是可用态），不拍')
      if (probe16.retry === true) throw new Error('⑯ 可用态不该出现重试按钮（[data-usage-credits-retry]），不拍')
      for (const key of ['ratio', 'window', 'detail', 'estimate', 'note']) {
        if (probe16[key] === null || probe16[key] === '') throw new Error('⑯ Credits 换算块的 ' + key + ' 是空的，不拍')
      }
      if (probe16.afterOfficial !== true) throw new Error('⑯ Credits 换算块不在官方对照块之后（INTERFACE §3.2 插入位置），不拍')

      // 015 §3.2/§3.3：分项行与按模型块。块内位置的插入顺序（明细 → 分项 → 折算 → 模型 → 脚注）也一起钉住，
      // 因为图里看到的是最终排布，顺序错了读者会把「每 Credit 分项」当成折算参考的一部分。
      const probe15 = await page.evaluate("(() => { const s = document.querySelector('[data-usage-credits]'); if (s === null) return null; const c = s.querySelector('[data-usage-credits-classes]'); const m = s.querySelector('[data-usage-credits-models]'); const detail = s.querySelector('[data-usage-credits-detail]'); const estimate = s.querySelector('[data-usage-credits-estimate]'); const note = s.querySelector('.tpq-usage-credits-note'); const order = c !== null && m !== null && detail !== null && estimate !== null && note !== null && (detail.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && (c.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && (estimate.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && (m.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; const rows = m === null ? [] : Array.from(m.querySelectorAll('[data-usage-credits-model]')).map(function (n) { const name = n.querySelector('.tpq-usage-credits-model-name'); const tk = n.querySelector('.tpq-usage-credits-model-tokens'); const ra = n.querySelector('.tpq-usage-credits-model-ratio'); return { id: n.getAttribute('data-model'), name: name === null ? null : (name.innerText || '').trim(), title: name === null ? null : name.getAttribute('title'), tokens: tk === null ? null : (tk.innerText || '').trim(), ratio: ra === null ? null : (ra.innerText || '').trim() } }); const ms = m === null ? null : getComputedStyle(m); const noteNode = m === null ? null : m.querySelector('.tpq-usage-credits-models-note'); return { classesNode: c !== null, classes: c === null ? null : (c.innerText || '').trim(), modelsNode: m !== null, modelsTabIndex: m === null ? null : m.tabIndex, modelsRole: m === null ? null : m.getAttribute('role'), modelsAria: m === null ? null : m.getAttribute('aria-label'), modelsMaxH: ms === null ? null : ms.maxHeight, modelsOverflowY: ms === null ? null : ms.overflowY, scrollH: m === null ? 0 : m.scrollHeight, clientH: m === null ? 0 : m.clientHeight, rows: rows, modelsNote: noteNode === null ? null : (noteNode.innerText || '').trim(), modelsText: m === null ? '' : (m.innerText || ''), order: order } })()")
      if (probe15 === null) throw new Error("⑯ 量不到 Credits 换算块，分项/模型断言无从谈起，不拍")
      if (probe15.classesNode !== true) throw new Error("⑯ 缺分项行（[data-usage-credits-classes]）：015 客户端未落盘，或 ratio.classes 不完整被整行闸门丢弃，不拍")
      if (probe15.modelsNode !== true) throw new Error("⑯ 缺按模型块（[data-usage-credits-models]）：015 客户端未落盘，或 ratio.models 为空被整块闸门丢弃，不拍")
      if (probe15.order !== true) throw new Error("⑯ 分项行/模型块插入位置不对（应 明细 → 分项 → 折算 → 模型 → 脚注），不拍")
      console.log("  ⑯ 模型块：行数=" + probe15.rows.length + " scrollHeight=" + probe15.scrollH + " clientHeight=" + probe15.clientH + " maxHeight=" + probe15.modelsMaxH + " overflowY=" + probe15.modelsOverflowY)

      // ① 比值：唯一允许写「1 Credit ≈ … tokens」的地方，数值按 fixture 现值 + 客户端量纲。
      const ratioNeedle = compactTokens(credits.ratio.tokensPerCredit, langKey)
      if (!/credit/i.test(probe16.ratio)) throw new Error('⑯ 比值行没有 Credit 字样（' + probe16.ratio + '），不拍')
      if (probe16.ratio.indexOf(ratioNeedle) < 0) throw new Error('⑯ 比值行是「' + probe16.ratio + '」，期望含 ' + ratioNeedle + '，不拍')

      // ② 明细：官方 tokens 与 已用/总额（Credits 用 usageCount：纯整数无千分位），百分比按 4 位取整。
      const officialNeedle = compactTokens(credits.tokens.official, langKey)
      const usedNeedle = String(Math.round(credits.credits.used))
      const totalNeedle = String(credits.credits.total)
      const percent16 = Math.round((credits.credits.used / credits.credits.total) * 1000) / 10
      const percentNeedle = (Number.isInteger(percent16) ? String(percent16) : percent16.toFixed(1)) + '%'
      for (const needle of [officialNeedle, usedNeedle, totalNeedle, percentNeedle]) {
        if (probe16.detail.indexOf(needle) < 0) throw new Error('⑯ 明细行缺「' + needle + '」（实际：' + probe16.detail + '），不拍')
      }
      // ③ 账期：起点与重置日都要出现（日期来自 fixture 的 window，不跟今天的实际日期走）。
      for (const needle of [credits.window.from, credits.window.resetDay]) {
        if (probe16.window.indexOf(needle) < 0) throw new Error('⑯ 账期行缺日期「' + needle + '」（实际：' + probe16.window + '），不拍')
      }
      // ④ 折算参考：容量 tokens + 总额 Credits，并明确标注「折算参考 / derived」。
      const capacityNeedle = compactTokens(credits.ratio.capacityTokens, langKey)
      const estimateNeedle = langKey === 'zh' ? '折算参考' : 'derived'
      for (const needle of [capacityNeedle, totalNeedle, estimateNeedle]) {
        if (probe16.estimate.indexOf(needle) < 0) throw new Error('⑯ 折算行缺「' + needle + '」（实际：' + probe16.estimate + '），不拍')
      }

      // ⑥ 015 §3.2 分项行：文案前缀 + 三类标签顺序，数值是**每 Credit 的 tokens**（formatTokens 口径），
      // 不是三类 tokens 本身 —— 图里读者看到的是「缓存命中 5.5万」，把它当成 tokens 就会差四个数量级。
      const classesPrefix15 = langKey === "zh" ? "每 Credit 的分项（tokens）：" : "Per credit by class (tokens):"
      const classLabels15 = langKey === "zh" ? ["缓存命中", "未命中输入", "输出"] : ["cache hit", "uncached input", "output"]
      const classCells15 = [USAGE_CREDITS_CLASSES.cacheRead, USAGE_CREDITS_CLASSES.uncachedInput, USAGE_CREDITS_CLASSES.output]
      if (probe15.classes === null || probe15.classes === "") throw new Error("⑯ 分项行是空的，不拍")
      if (probe15.classes.indexOf(classesPrefix15) < 0) throw new Error("⑯ 分项行缺前缀「" + classesPrefix15 + "」（实际：" + probe15.classes + "），不拍")
      let cursor15 = 0
      for (let i = 0; i < 3; i += 1) {
        const label15 = classLabels15[i]
        const needle15 = compactTokens(classCells15[i].perCredit, langKey)
        const labelAt15 = probe15.classes.indexOf(label15, cursor15)
        if (labelAt15 < 0) throw new Error("⑯ 分项行缺「" + label15 + "」或顺序不对（实际：" + probe15.classes + "），不拍")
        const valueAt15 = probe15.classes.indexOf(needle15, labelAt15 + label15.length)
        if (valueAt15 < 0) throw new Error("⑯ 分项行「" + label15 + "」的每 Credit 值不是 " + needle15 + "（实际：" + probe15.classes + "），不拍")
        cursor15 = valueAt15 + needle15.length
      }
      if (probe15.classes.indexOf("%") >= 0) throw new Error("⑯ 分项行出现百分比（分项是每 Credit 的 tokens，不是比例）：" + probe15.classes)

      // ⑦ 015 §3.3 模型块：宿主顺序原样保留、每行 tokens/比值与 fixture 现算值相等、键盘可聚焦、252px 定高内滚。
      if (probe15.modelsTabIndex !== 0) throw new Error("⑯ 模型块 tabIndex=" + probe15.modelsTabIndex + "，键盘滚不进这块定高列表，不拍")
      if (probe15.modelsRole !== "group") throw new Error("⑯ 模型块 role=" + probe15.modelsRole + "，应为 group，不拍")
      const modelsAria15 = langKey === "zh" ? "每个模型各自的比值" : "Ratio per model"
      if (probe15.modelsAria !== modelsAria15) throw new Error("⑯ 模型块 aria-label 应为「" + modelsAria15 + "」（实际：" + probe15.modelsAria + "），不拍")
      if (probe15.rows.length !== USAGE_CREDITS_MODELS.length) throw new Error("⑯ 模型行数 " + probe15.rows.length + " ≠ fixture " + USAGE_CREDITS_MODELS.length + " 行，不拍")
      USAGE_CREDITS_MODELS.forEach(function (expected, index) {
        const row = probe15.rows[index]
        if (row === null || row === undefined) throw new Error("⑯ 模型块缺第 " + index + " 行，不拍")
        if (row.id !== expected.id) throw new Error("⑯ 模型第 " + index + " 行 data-model=" + row.id + "，期望 " + expected.id + "（宿主顺序要原样保留），不拍")
        if (row.title !== expected.id) throw new Error("⑯ 模型第 " + index + " 行 name 的 title 不是完整 id（" + row.title + "），悬停看不到全名，不拍")
        if (row.name !== expected.id) throw new Error("⑯ 模型第 " + index + " 行显示名 ≠ id（" + row.name + "），不拍")
        const tokensNeedle15 = compactTokens(expected.tokens, langKey) + " tokens"
        if (row.tokens !== tokensNeedle15) throw new Error("⑯ 模型第 " + index + " 行 tokens 文本「" + row.tokens + "」≠「" + tokensNeedle15 + "」，不拍")
        const ratioNeedle15 = compactTokens(expected.tokensPerCredit, langKey)
        if (row.ratio.indexOf(ratioNeedle15) < 0) throw new Error("⑯ 模型第 " + index + " 行比值「" + row.ratio + "」不含 " + ratioNeedle15 + "，不拍")
        if (!/credit/i.test(row.ratio)) throw new Error("⑯ 模型第 " + index + " 行比值没有 Credit 字样（" + row.ratio + "），不拍")
      })
      const modelsNoteNeedle15 = langKey === "zh" ? "本账期已用 Credits" : "credits used this cycle"
      if (probe15.modelsNote === null || probe15.modelsNote.indexOf(modelsNoteNeedle15) < 0) throw new Error("⑯ 模型块脚注缺「" + modelsNoteNeedle15 + "」（实际：" + probe15.modelsNote + "），贡献值口径没交代，不拍")
      if (probe15.modelsText.indexOf("%") >= 0) throw new Error("⑯ 模型块出现百分比（模型比值是每 Credit 的 tokens）：" + probe15.modelsText)
      if (probe15.modelsMaxH !== "252px") throw new Error("⑯ 模型块 max-height=" + probe15.modelsMaxH + "，INTERFACE §3.4 要求 252px，不拍")
      if (probe15.modelsOverflowY !== "auto") throw new Error("⑯ 模型块 overflow-y=" + probe15.modelsOverflowY + "，INTERFACE §3.4 要求 auto（定高内滚），不拍")
      // 内滚的**硬证据**要求内容高于 252px；fixture 的 8 行（与 ⑮ 同一份本机按模型数据）实测 229px，
      // 定高没被触发，所以这里断言的是「cap 在位且真实 8 行没被裁切」，而不是「scrollHeight > clientHeight」。
      // 真要证明滚动，只能加临时克隆行（改 DOM）或往 fixture 塞不存在的模型，两者都会让截图/数据失真 —— 留给 lead 定。
      if (!(probe15.clientH <= 252)) throw new Error("⑯ 模型块 clientHeight=" + probe15.clientH + " > 252px，max-height 没生效，不拍")
      if (probe15.scrollH !== probe15.clientH) throw new Error("⑯ 模型块 8 行被定高裁切（scrollHeight=" + probe15.scrollH + " > clientHeight=" + probe15.clientH + "），图里会缺行，不拍")

      // ⑤ 口径护栏：这块是整个用量屏唯一合法出现 Credits 的地方，仍不许出现货币符号与「剩余」话术。
      if (/[¥$€£]|元/.test(probe16.text)) throw new Error('⑯ 换算块出现货币符号（' + probe16.text + '），不拍')
      if (/Credits\s*剩余/i.test(probe16.text)) throw new Error('⑯ 换算块出现「Credits 剩余」话术（Credits 只有已用口径），不拍')
      if (/NaN|undefined/.test(probe16.text)) throw new Error('⑯ 换算块出现 NaN/undefined（' + probe16.text + '），不拍')
      const noteNeedle = langKey === 'zh' ? '不是固定兑换率' : 'not a fixed exchange rate'
      if (probe16.note.indexOf(noteNeedle) < 0) throw new Error('⑯ 脚注缺「' + noteNeedle + '」（实际：' + probe16.note + '），不拍')
      if (langKey === 'en' && /\p{Script=Han}/u.test(probe16.text)) throw new Error('⑯ 英文界面换算块混了中文（' + probe16.text + '），不拍')
      if (langKey === 'zh' && /\b(credits used|allowance resets|Official tokens)\b/.test(probe16.text)) throw new Error('⑯ 中文界面换算块混了英文句式（' + probe16.text + '），不拍')

      // 取景：换算块滚到可视区上半部；块必须完整落在视口内（裁一半的图不能进 docs/）。
      const framed16 = await page.evaluate("(() => { const s = document.querySelector('[data-usage-credits]'); if (s === null) return null; s.scrollIntoView({ block: 'center' }); let sc = s.parentElement; while (sc !== null && sc !== document.scrollingElement && !(sc.scrollHeight > sc.clientHeight + 2)) sc = sc.parentElement; const box = sc === null ? document.scrollingElement : sc; const before = s.getBoundingClientRect(); box.scrollTop = Math.max(0, box.scrollTop + Math.round(before.top - 120)); return { top: Math.round(s.getBoundingClientRect().top), scrollTop: Math.round(box.scrollTop) } })()")
      if (framed16 === null) throw new Error('⑯ 量不到 Credits 换算块的位置，不拍')
      await sleep(350)
      const frameState16 = await page.evaluate("(() => { const s = document.querySelector('[data-usage-credits]'); if (s === null) return null; const r = s.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight } })()")
      if (frameState16 === null) throw new Error('⑯ 取景后找不到 Credits 换算块，不拍')
      if (frameState16.top < 8 || frameState16.bottom > frameState16.vh - 8) throw new Error('⑯ 换算块没有完整落在视口内（' + JSON.stringify(frameState16) + '），不拍')
      if (frameState16.h < 120) throw new Error('⑯ 换算块在取景里只有 ' + frameState16.h + 'px 高，内容不像渲染完整，不拍')
      // 模型块是 252px 定高内滚列表，整块必须落在视口里：截一半的图会把「内滚」截成「列表被切掉」。
      const frameModels16 = await page.evaluate("(() => { const m = document.querySelector('[data-usage-credits-models]'); if (m === null) return null; const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight } })()")
      if (frameModels16 === null) throw new Error('⑯ 取景后找不到按模型块，不拍')
      if (frameModels16.top < 8 || frameModels16.bottom > frameModels16.vh - 8) throw new Error('⑯ 模型块没有完整落在视口内（' + JSON.stringify(frameModels16) + '），不拍')
      if (frameModels16.h > 253) throw new Error('⑯ 模型块渲染高度 ' + frameModels16.h + 'px > max-height 252px + 1px 容差，定高没生效，不拍')

      console.log('  ⑯ 换算块：比值「' + probe16.ratio + '」；明细「' + probe16.detail + '」；分项「' + probe15.classes + '」；模型 ' + probe15.rows.length + ' 行（首行 ' + probe15.rows[0].name + ' / ' + probe15.rows[0].tokens + ' / ' + probe15.rows[0].ratio + '）；账期「' + probe16.window + '」；折算「' + probe16.estimate + '」；取景 ' + JSON.stringify(frameState16))
      save('usage-credits-2d.png', await page.shot({}))
    }

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
