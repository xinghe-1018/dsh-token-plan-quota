#!/usr/bin/env node
/**
 * 从已渲染的 Archify HTML 里裁出架构图，产出 README 用的位图。
 *
 * 为什么要有这个脚本：`docs/images/` 下的图历来"只能由脚本生成、不许手改"（`AGENTS.md` 的规则），
 * 架构图也照这个规矩来——否则它就是一张没人能再生成的二进制孤儿，且与源规格脱钩。
 *
 * 为什么产物是位图而不是矢量：实测交付 HTML 里的 `<svg>` 用查看器页面的 CSS 类着色
 * （`class="m-default"` 等）、**自身不含 `<style>`**，直接抽出 SVG 会丢配色与字体。
 * 重做一版自带的矢量图需要重建样式层，保真风险大于收益。
 *
 * 为什么只做"编排"而不自己写 CDP：`scripts/shots/cdp.mjs` 已经导出定位 Edge / 起无头浏览器 /
 * 连 CDP / 按裁剪区截图（`shot` 支持 `clip.scale`）的全套能力，本项目零依赖，不另造一份。
 *
 * 前置（两者都在仓库之外，因此本脚本**不进 CI**）：
 *   1. Archify 技能已用 `validate` + `deliver` 把规格渲染成一份独立 HTML；
 *   2. 本机有 Edge / Chrome（CDP 同源）。
 *
 * 用法：
 *   node diagrams/make-diagram-png.mjs --html <已渲染的.html> [--out docs/images/architecture.png]
 *                                    [--scale 2] [--viewport 1600x1000] [--edge <浏览器路径>]
 *
 * 自证要求（PLAN 的"空数据会伪装成结论"）：读回空矩形、图被视口裁掉、产物太小或超体积上限，
 * 一律**非零退出并说清原因**，绝不把空数据落盘当成功。
 */

import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Cdp, launchEdge } from '../scripts/shots/cdp.mjs'

/** 图的根节点带 Archify 自己的属性，比 `svg` 更精确（查看器工具栏里也有 svg 图标）。 */
const SVG_SELECTOR = 'svg[data-quality-profile]'

/**
 * 空白图的体积下限。**这个数不是猜的**：004 的 Lens 1 在真实 Chromium 上对同一裁剪区实测——
 * 纯白 13,198 B、只剩背景的"真·白图"19,304 B、入库的真图 186,019 B。初版取 20,000 B，
 * 距离白图只差 696 B，等于没设门。现在取 60,000 B：对白图有 3.1× 余量、对真图有 3.1× 余量。
 * 若图将来确实变简单而低于此值，**按新基线重新校准这个常量**，不要直接删掉这道门。
 */
const MIN_BYTES = 60_000

/** SVG 里 `<text>` 的数量下限——体积挡不住"截到了别的元素 / 标签全丢"这一类。
 *  004 的 Lens 1 实测：注入第二个 `svg[data-quality-profile]`（标签全丢）后产物 96,856 B，
 *  照样越过了体积下限。真图有几十个 `<text>`，这里取 8 只是"这确实是一张渲染出来的图"的下限。 */
const MIN_TEXT = 8
const RELOAD_TIMEOUT_MS = Number(process.env.TPQ_DIAGRAM_RELOAD_TIMEOUT_MS || 60000)   // 有界等待：见 reload 处的注释

/** 体积上限：对齐 `docs/images/` 现有兄弟文件 106–342 KB 的量级，别让 README 多背一张 1 MB 的图。 */
const MAX_BYTES = 400_000

function parseArgs(argv) {
  const out = { scale: 2, viewport: '1600x1000' }
  for (let at = 0; at < argv.length; at++) {
    const key = argv[at]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} 需要取值`)
    at++
    if (name === 'edge') out.edge = value
    else if (name === 'html') out.html = value
    else if (name === 'out') out.out = value
    else if (name === 'scale') out.scale = Number(value)
    else if (name === 'viewport') out.viewport = value
    else throw new Error(`未知参数：${key}`)
  }
  if (out.html === undefined) throw new Error('必须给 --html <已渲染的 Archify HTML>')
  if (!Number.isFinite(out.scale) || out.scale <= 0) throw new Error(`--scale 必须是正数，收到 ${out.scale}`)
  const matched = /^(\d+)x(\d+)$/.exec(out.viewport)
  if (matched === null) throw new Error(`--viewport 形如 1600x1000，收到 ${out.viewport}`)
  out.width = Number(matched[1])
  out.height = Number(matched[2])
  // '0x0' 能通过上面那条正则，但 openPage 里的设备度量是 'if (viewport.width)' 才下发——
  // 宽为 0 时整个 override 被跳过，页面用的是窗口的真实尺寸，而"SVG 超出视口"那道门报出来的却是
  // "视口=0x0"：判据与报错自相矛盾，会把排查方向带偏（§6 第 9 条）。
  if (!(out.width > 0) || !(out.height > 0)) throw new Error('--viewport 的宽高必须是正整数，收到 ' + out.viewport)
  return out
}

/** PNG 文件签名。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 只读前 8 字节（PNG 签名的长度）：判断"能不能覆盖"不必把整个文件读进内存。 */
function readSignature(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(8)
    const n = readSync(fd, head, 0, 8, 0)
    return n === 8 ? head : Buffer.alloc(0)
  } finally { closeSync(fd) }
}

/** 只判签名，不解析结构——用来决定"能不能覆盖这个已存在的文件"。 */
function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)
}

/** 读 PNG 的 IHDR 宽高；顺带验签名，坏文件当场失败而不是写进仓库。 */
function pngSize(buffer) {
  if (!isPng(buffer)) throw new Error('产物不是 PNG（签名不符）')
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('产物不是 PNG（缺 IHDR）')
  if (buffer.subarray(-8, -4).toString('latin1') !== 'IEND') throw new Error('产物不是 PNG（缺 IEND，可能被截断）')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const html = resolve(args.html)
  const out = resolve(args.out ?? 'docs/images/architecture.png')

  if (!existsSync(html)) throw new Error(`找不到已渲染的 HTML：${html}（先用 Archify 的 deliver 生成它）`)
  const htmlBytes = statSync(html).size
  if (htmlBytes <= 0) throw new Error(`HTML 是空文件：${html}`)

  // `--out` 由本机开发者手输，没有远程触发面；但它曾经能**静默覆盖任意文件**：
  // `--out README.md` 手滑就把一个已跟踪文件替换成 PNG 二进制，未跟踪的文件更不可恢复
  // （004 的 Lens 2 F1）。两道守卫：尾缀必须是 .png；目标已存在且不是 PNG 就直接拒绝。
  if (!out.toLowerCase().endsWith('.png')) throw new Error(`--out 必须以 .png 结尾：${out}`)
  if (existsSync(out)) {
    // 原先写的是 'isPng(readFileSync(out))'：目标若是目录 / FIFO / 设备节点，抛出来的是 EISDIR
    // 之类的底层错误，把这条精心写过的安全提示顶掉；真是一张巨大的 PNG 时还会整文件读进内存
    // （本脚本别处都在用 statSync）。§6 第 13 条。
    if (!statSync(out).isFile()) throw new Error(`目标存在但不是普通文件（目录 / FIFO / 设备节点？），拒绝写入：${out}`)
    if (!isPng(readSignature(out))) {
      throw new Error(`目标已存在且不是 PNG，拒绝覆盖（怕把文本/配置换成位图）：${out}`)
    }
  }

  const url = pathToFileURL(html).href
  console.log(`源 HTML : ${relative(process.cwd(), html)} (${htmlBytes} B)`)
  console.log(`视口    : ${args.width}x${args.height} · 倍率 ${args.scale}`)

  const browser = await launchEdge({ width: args.width, height: args.height, edge: args.edge })
  let png
  let rect
  let rounded
  // cdp 声明必须在 try 外面：原先写在 try 里，finally 看不见它，WebSocket 句柄只能靠对端死亡
  // 间接释放（§6 第 10 条）。
  let cdp = null
  try {
    cdp = await Cdp.connect(browser.wsUrl)
    const page = await cdp.openPage(url, { width: args.width, height: args.height, deviceScaleFactor: 1 })
    // `Target.createTarget` 会立刻开始加载，而设备度量是在附着之后才覆盖的——查看器按**窗口**尺寸
    // 算过一次面板大小就不再看后续变化（实测：窗口 1600x1000 时裁到 w=1192，而同一视口下重载后是
    // w=1338）。重载一次，让"读到的视口"和"算面板用的视口"是同一个，否则产物尺寸会随启动窗口漂。
    // reloadAndSettle 里面 await 的是 Page.loadEventFired，**没有任何超时**：本文件自己就承认
    // 离线时 CDN 字体本就会失败，而同一环境下 <head> 里的 CDN 请求可能既不快速失败也不结束，
    // load 永远不来 → 脚本既不落盘也不非零退出（违背头注释的"一律非零退出并说清原因"）。
    // 包一层有界等待，把它变成一条能读的失败。
    await Promise.race([
      page.reloadAndSettle(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面在 ' + RELOAD_TIMEOUT_MS + 'ms 内没有完成加载（离线或 CDN 不可达？），已中止')), RELOAD_TIMEOUT_MS)),
    ])
    await page.waitFor(`!!document.querySelector(${JSON.stringify(SVG_SELECTOR)})`, { label: '架构图 SVG 出现' })

    // 字体晚到会让文字排版在两张截图之间漂移；等不到就只是告警（离线时 CDN 字体本就会失败）。
    try {
      await page.waitFor('document.fonts && document.fonts.status === "loaded"', { label: '字体就绪', timeoutMs: 8000 })
    } catch {
      console.log('提示    : 字体未在 8s 内就绪，按系统字体栈继续（离线常见，不影响结构）')
    }

    // 体积只能证明"有内容"，证明不了"是这张图"——所以先核一遍图上真的有字。
    // 不在页面里链式取值：上一行 waitFor 到这里还隔着最长 8s 的字体等待与一次往返，页面若在此期间
    // 被脚本重排/替换，链式就抛 null 解引用，报出来是"页面求值异常"而不是"SVG 没了"，看不出真因
    // （§6 第 12 条）。空安全地返回 -1，交给下面的门报人话。
    const textCount = await page.evaluate(`(() => {
      const svg = document.querySelector(${JSON.stringify(SVG_SELECTOR)})
      return svg === null ? -1 : svg.querySelectorAll('text').length
    })()`)
    console.log(`SVG 文本 : ${textCount} 个 <text>（下限 ${MIN_TEXT}）`)
    if (textCount < 0) throw new Error(`页面里找不到 ${SVG_SELECTOR}（字体等待期间被重排或替换掉了？）——已拒绝继续`)
    if (textCount < MIN_TEXT) throw new Error(`选中的 SVG 只有 ${textCount} 个 <text>（下限 ${MIN_TEXT}）——多半截到了别的元素或标签全丢，已拒绝继续`)

    rect = await page.rectOf(SVG_SELECTOR)
    if (rect === null) throw new Error(`页面上找不到 ${SVG_SELECTOR}（空数据不许当成功）`)
    if (!(rect.width > 0) || !(rect.height > 0)) throw new Error(`SVG 矩形是空的：${JSON.stringify(rect)}`)

    const inside = await page.evaluate(`(() => {
      const svg = document.querySelector(${JSON.stringify(SVG_SELECTOR)})
      if (svg === null) return { missing: true }
      const r = svg.getBoundingClientRect()
      return { missing: false, fitsX: r.left >= 0 && r.right <= innerWidth, fitsY: r.top >= 0 && r.bottom <= innerHeight }
    })()`)
    // 同上：这一步在截图前最后一刻，页面已经等过字体，SVG 可能已经不在了。
    if (inside.missing) throw new Error(`截图前一刻 ${SVG_SELECTOR} 又从页面上消失了——已拒绝继续`)
    if (!inside.fitsX || !inside.fitsY) {
      throw new Error(`SVG 超出视口（会被裁掉）：rect=${JSON.stringify(rect)} 视口=${args.width}x${args.height}。`
        + '调大 --viewport 再试——裁一半的图不许落盘。')
    }

    rounded = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    png = await page.shot({ clip: { ...rounded, scale: args.scale } })
    console.log(`裁剪区  : x=${rounded.x} y=${rounded.y} w=${rounded.width} h=${rounded.height}`)
  } finally {
    // 顺序要紧：先关会话释放 WebSocket 句柄，再杀浏览器。原先只靠杀进程间接断开，而
    // browser.close() 里的 kill 是静默 try/catch 的——它失败时脚本会打印完结果却迟迟不退出。
    if (cdp !== null) cdp.close()
    browser.close()
  }

  const size = pngSize(png)
  // 断言要用**真正传给 shot 的那组数**（rounded），不是未取整的 rect：位图宽 ≈ rounded.width × scale，
  // 用 rect 反推时偏差 ≈ (rect.width - rounded.width) × scale，--scale 3/4 时能差到 2px，
  // 一张完全正常的图会被自己的尺寸门误拒（第五轮审查第 1 条）。
  const expectW = rounded.width * args.scale
  const expectH = rounded.height * args.scale
  if (Math.abs(size.width - expectW) > 1 || Math.abs(size.height - expectH) > 1) {
    throw new Error(`产物尺寸与预期不符：得到 ${size.width}x${size.height}，预期约 ${expectW}x${expectH}`)
  }
  if (png.length < MIN_BYTES) {
    throw new Error(`产物只有 ${png.length} B（下限 ${MIN_BYTES}）——很可能截到一张空白图，已拒绝落盘`)
  }
  if (png.length > MAX_BYTES) {
    throw new Error(`产物 ${png.length} B 超过上限 ${MAX_BYTES} B——降低 --scale 重截，不要照收`)
  }

  writeFileSync(out, png)
  const sha256 = createHash('sha256').update(png).digest('hex')
  console.log('')
  console.log(`产物    : ${relative(process.cwd(), out)}`)
  console.log(`尺寸    : ${size.width}x${size.height} px（${args.scale}×）`)
  console.log(`字节    : ${png.length}`)
  console.log(`sha256  : ${sha256}`)
}

/* 失败路径要说清原因，这是本脚本的核心契约（文件头的自证要求）。三条：
 *  · 不用 console.error 紧接 process.exit：stderr 接管道（CI 重定向、`| tee`）时 Node 的写是
 *    **异步**的，exit 会把原因截掉——只能看到"exit code 1"却不知道为什么（§6 第 11 条）。
 *    改成 writeSync(2, …) 同步落盘后再退出。
 *  · 抛出非 Error 值时原先打印"失败：undefined"（`error.message` 不存在）。
 *  · 只打 message 会丢 stack：脚本里大量 page.evaluate / CDP 抛出的原始错误本身就含糊，
 *    没有调用栈定位不到是本脚本哪一行。 */
main().catch(error => {
  const isReal = error instanceof Error
  const head = '失败：' + (isReal ? error.message : String(error))
  const stack = isReal && typeof error.stack === 'string' ? '\n' + error.stack.split('\n').slice(1).join('\n') : ''
  try {
    writeSync(2, head + stack + '\n')
  } catch {
    console.error(head + stack)   // 连 fd 2 都写不了时的最后一道兜底
  }
  process.exit(1)
})