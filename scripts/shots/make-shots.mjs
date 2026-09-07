/**
 * README 截图物料生成器。
 *
 *   node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 [--lang zh|en] [--out docs/images]
 *                                     [--shots 2,3,4] [--edge <path>] [--ffmpeg <path>] [--allow-live]
 *
 * 两件事决定了这个脚本的形状：
 *  - **合成数据**：图里绝不能出现真实余额（README 的立场靠这张图自证，漏一次就白洗过仓库），
 *    所以拦截 `/token-plan-quota/summary` 与 `/token-plan-quota/refresh`，换成 `fixture.mjs` 造的数据。
 *    两个都要拦：面板那个"更新于"按钮会 POST refresh 并把快照覆盖回去（`lib/client.js:1090`）。
 *  - **要活会话**：徽标注入的座位是 `conversation.input.left`（`lib/client.js:1157`），
 *    没有打开的会话就没有 DOM 座位。宿主自带的 `?fixture` 模式（内存假宿主，含种子会话与
 *    默认模型）正好提供这个状态，于是不需要真凭据、不需要种工作区。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { launchEdge, Cdp } from './cdp.mjs'
import { makeSnapshot, assertFixture } from './fixture.mjs'

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { lang: 'zh', out: 'docs/images', shots: [2, 3, 4], allowLive: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--url') out.url = next()
    else if (arg === '--lang') out.lang = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--shots') out.shots = next().split(',').map(v => Number(v.trim())).filter(Boolean)
    else if (arg === '--edge') out.edge = next()
    else if (arg === '--ffmpeg') out.ffmpeg = next()
    else if (arg === '--allow-live') out.allowLive = true
    else if (arg === '-h' || arg === '--help') { out.help = true }
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

const LANGUAGE = { zh: 'zh-CN', en: 'en-US' }

/**
 * 界面串按语言取。宿主客户端的文案由 `pickLocale()` 决定（`client.js:150`），
 * 菜单行与实测 pill 都跟着变，所以这里绝不能把中文写死——英文套会点不到。
 */
const UI = {
  zh: { modelRow: '模型', measured: '实测', dismissModal: '继续' },
  en: { modelRow: 'Model', measured: 'measured', dismissModal: 'Continue' },
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
    console.log('用法：node scripts/shots/make-shots.mjs --url http://127.0.0.1:<port> [--lang zh|en] [--out docs/images] [--shots 2,3,4]')
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
  const workDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), '.shots-work', langKey)
  mkdirSync(outDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  /** 当前要喂的变体；改它不需要重载页面（点徽标就会重新拉一次 summary）。 */
  const live = { variant: 'panel' }
  const built = variant => {
    const snapshot = makeSnapshot({ variant, lang: langKey, now: Date.now() })
    assertFixture(snapshot)
    writeFileSync(join(workDir, `${variant}.json`), JSON.stringify(snapshot, null, 1))
    return snapshot
  }

  const browser = await launchEdge({ lang: LANGUAGE[langKey], edge: args.edge, width: 1280, height: 860 })
  const cdp = await Cdp.connect(browser.wsUrl)
  const page = await cdp.openPage(`${args.url.replace(/\/$/, '')}/?fixture`, { width: 1280, height: 860, deviceScaleFactor: 2 })
  const hits = page.intercept({
    patterns: [{ urlPattern: '*token-plan-quota/summary*' }, { urlPattern: '*token-plan-quota/refresh*' }],
    respond: () => ({ body: JSON.stringify(built(live.variant)), via: 'fixture' }),
  })
  console.log(`Edge ${browser.browserVersion} @ ${browser.port}；语言 ${LANGUAGE[langKey]}；输出 ${outDir}`)

  // 首屏：徽标必须挂上，挂不上后面全白拍，所以先断言再动手。
  await page.waitFor(`document.querySelector('.tpq-chip') !== null`, { timeoutMs: 30_000, label: '徽标挂载' })
  console.log('✅ 徽标已挂载：' + JSON.stringify(await page.evaluate(`document.querySelector('.tpq-chip').innerText.replace(/\\s+/g,' ')`)))

  /**
   * 关掉「内测声明」模态。它每次新 profile 都会弹（fixture 模式没有写设置的通道，
   * 弹窗自己还提示"暂时无法保存确认状态"），不关掉会漏进截图背景。
   */
  const clickText = async (match, where = 'button') => await page.evaluate(`(() => {
    const hit = [...document.querySelectorAll(${JSON.stringify(where)})]
      .find(n => (n.innerText || n.getAttribute('aria-label') || '').replace(/\\s+/g, '').includes(${JSON.stringify(match)}) && n.offsetParent !== null)
    if (!hit) return false
    hit.click(); return true
  })()`)
  /**
   * 关掉「内测声明」模态：它每次新 profile 都会弹（fixture 模式没有写设置的通道，
   * 弹窗自己还提示"暂时无法保存确认状态"），不关掉会漏进截图背景。
   * 按钮文案跟语言走，所以按候选串找，找不到就算了（模态可能已不在）。
   */
  const dismissOnboarding = async () => {
    for (const label of [UI[langKey].dismissModal, '继续', 'Continue', '知道了', 'Got it']) {
      if (await clickText(label)) return true
    }
    return false
  }
  /**
   * 取"最深"的匹配节点再点：菜单项的祖先 innerText 也含关键字，点祖先等于点空气。
   * 顺带补一遍悬停事件——宿主的二级菜单是 hover 展开的。
   */
  const deepClick = async match => await page.evaluate(`(() => {
    // 取最后一个可见的 menu 容器：菜单是后挂载的，第一个往往是侧栏里别的 menu 类节点。
    const menus = [...document.querySelectorAll('[class*="menu" i]')].filter(n => n.offsetParent !== null)
    const root = menus.length > 0 ? menus[menus.length - 1] : document
    const cands = [...root.querySelectorAll('*')].filter(n => n.offsetParent !== null
      && (n.innerText || '').replace(/\\s+/g, '').includes(${JSON.stringify(match)}))
    if (cands.length === 0) return false
    const leaf = cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
      leaf.dispatchEvent(new PointerEvent(type, { bubbles: type.endsWith('over'), cancelable: true }))
    }
    leaf.click(); return true
  })()`)

  if (await dismissOnboarding()) {
    await sleep(600)
    console.log('  （已关掉内测声明模态）')
  }

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
    await page.evaluate(`(() => {
      localStorage.setItem('dsh-token-plan-quota.panel', JSON.stringify({ x: 430, y: 150, w: 392, h: 470 }))
    })()`)
    await page.reloadAndSettle()
    await page.waitFor(`document.querySelector('.tpq-chip') !== null`, { timeoutMs: 30_000, label: '重载后徽标挂载' })
    // reload 会把内测声明模态再弹一次（它无法持久化确认状态），不关就漏进背景。
    if (await dismissOnboarding()) await sleep(500)
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
    // ① 依赖"第一个 class 含 menu 的容器就是模型菜单"，而 ②③④ 开合面板会留下别的 menu 类节点。
    // 所以这里先重载一次拿到干净页面 —— 顺带让 --shots 的任意子集/顺序都成立。
    await page.reloadAndSettle()
    await page.waitFor(`document.querySelector('.tpq-chip') !== null`, { timeoutMs: 30_000, label: '重载后徽标挂载' })
    if (await dismissOnboarding()) await sleep(500)
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
    if (!await clickText('DeepSeek-V4-Flash')) throw new Error('点不到模型按钮')
    await sleep(700)
    if (!await deepClick(UI[langKey].modelRow)) throw new Error(`点不到菜单里的「${UI[langKey].modelRow}」行`)
    await page.waitFor(`(() => { const r = document.querySelector('[class*="menu" i]'); return r !== null && /GPT-5/.test(r.innerText || '') })()`,
      { timeoutMs: 10_000, label: '二级菜单出现 GPT-5' })
    await sleep(600)
    if (!await deepClick('GPT-5')) throw new Error('点不到 GPT-5')
    await page.waitFor(`document.querySelector('.tpq-chip')?.innerText.includes(${JSON.stringify(UI[langKey].measured)}) === true`, { timeoutMs: 12_000, label: '徽标切到实测卡' })
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

  console.log('拦截命中次数：' + hits.hits())
  console.log('产物：\n  ' + produced.join('\n  '))
  cdp.close()
  browser.close()
}

await main()
