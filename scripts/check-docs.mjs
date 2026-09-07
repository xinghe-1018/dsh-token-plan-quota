#!/usr/bin/env node
/**
 * 文档自检：README 里的**可核实声明**必须与代码一致。
 *
 * 动机很直接：插件目录站的评审会拿描述去核代码（"写 46 个工具就该有 46 个工具"），
 * 而本项目自己的 README 也反复声称"不估算/只报真值"。这类话一旦写成文字就该是**可执行的**，
 * 否则它就是又一处会腐烂的注释。
 *
 * 检查项：
 *   1. `DEFAULTS` 每个键都在中英两份 README 的配置表里出现；
 *   2. `PRESETS` 每个源名都在中英 README 里出现（新增一家忘了同步文档 = CI 红）；
 *   3. 预设与字体 CDN 的每个出站主机都在 `dshhub.permissions.network` 里；
 *   4. README 里的相对链接指向的文件真实存在；
 *   5. README 声称的测试项数与实跑结果一致（数字不许漂）；
 *   6. 正文里写死的计数（键数/源数/主机数）与代码一致；
 *   7. CHANGELOG 引用的 tag 必须存在；
 *   8. 两张键表逐行对得上代码（配置表 = DEFAULTS，条目键表 = 代码真读的 `source.*`）；
 *   9. 文本没有被错误码页读写过（BOM / U+FFFD / GBK 私用区残骸）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __internals } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(join(root, file), 'utf8')
const zh = read('README.md')
const en = read('README.en.md')
const pkg = JSON.parse(read('package.json'))
const problems = []

/* 1) 配置键 */
for (const key of Object.keys(__internals.DEFAULTS).sort()) {
  const token = '`' + key + '`'
  if (!zh.includes(token)) problems.push(`README.md 的配置表缺键 ${key}`)
  if (!en.includes(token)) problems.push(`README.en.md 的配置表缺键 ${key}`)
}

/* 2) 数据源名 */
for (const id of Object.keys(__internals.PRESETS).sort()) {
  const token = '`' + id + '`'
  if (!zh.includes(token)) problems.push(`README.md 没提到数据源 ${id}`)
  if (!en.includes(token)) problems.push(`README.en.md 没提到数据源 ${id}`)
}

/* 3) 出站主机 */
const declared = new Set((pkg.dshhub?.permissions?.network ?? []).map(entry => entry.replace(/\/+$/, '')))
const hosts = new Set()
for (const preset of Object.values(__internals.PRESETS)) {
  for (const url of [preset.url, ...(preset.regions ? Object.values(preset.regions).map(r => r.url) : []), preset.infoUrl]) {
    const match = typeof url === 'string' ? /^https?:\/\/([^/?#]+)/.exec(url) : null
    if (match !== null) hosts.add(`https://${match[1]}`)
  }
}
for (const url of zh.match(/https:\/\/cdn\.jsdelivr\.net/g) ?? []) hosts.add(url)
for (const host of [...hosts].sort()) {
  if (!declared.has(host)) problems.push(`出站主机 ${host} 未声明在 dshhub.permissions.network`)
}

/* 4) 相对链接 */
for (const [file, text] of [['README.md', zh], ['README.en.md', en]]) {
  for (const link of new Set([...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)].map(m => m[1]))) {
    if (!existsSync(join(root, link))) problems.push(`${file} 的链接目标不存在：${link}`)
  }
}

/* 5) 测试项数 */
const counts = {}
for (const suite of ['host', 'client']) {
  const out = execFileSync(process.execPath, [join(root, 'test', `${suite}.mjs`)], { encoding: 'utf8' })
  const match = /(\d+) passed, (\d+) failed/.exec(out)
  if (match === null) problems.push(`test/${suite}.mjs 没给出可解析的结果行`)
  else if (match[2] !== '0') problems.push(`test/${suite}.mjs 有 ${match[2]} 项失败`)
  else counts[suite] = Number(match[1])
}
for (const [suite, text] of [['host', zh], ['client', en]]) {
  void text
  const claimed = [...zh.matchAll(new RegExp(`test/${suite}\\.mjs\\s+#?\\s*(\\d+) 项`, 'g'))].map(m => Number(m[1]))
    .concat([...en.matchAll(new RegExp(`test/${suite}\\.mjs\\s*\\n?\\s*#\\s*(\\d+) assertions`, 'g'))].map(m => Number(m[1])))
  for (const value of claimed) {
    if (counts[suite] !== undefined && value !== counts[suite]) {
      problems.push(`README 声称 test/${suite}.mjs 是 ${value} 项，实跑 ${counts[suite]} 项`)
    }
  }
  if (claimed.length === 0 && counts[suite] !== undefined) {
    problems.push(`README 里找不到 test/${suite}.mjs 的项数声明（应为 ${counts[suite]}）`)
  }
}

/* 6) 正文里写死的计数也是声明：新增一家忘了改这句，就该 CI 红。
 *    主机数说的是**已声明**的出站主机（审计看的就是这个数），不是从预设里推导出来的那批。
 *    键数与"配置表行数"分开声明（17 个 DEFAULTS 键 vs 表里 18 行），因为盲测时有读者把这两个数当成
 *    互相矛盾的证据——两个都检查，两个就都别再想漂。 */
const tally = { keys: Object.keys(__internals.DEFAULTS).length, sources: Object.keys(__internals.PRESETS).length, hosts: declared.size }
const zhProse = /DEFAULTS (\d+) 个键、配置表 (\d+) 行、(\d+) 个数据源、声明 (\d+) 个出站主机/.exec(zh)
if (zhProse === null) problems.push('README.md 里找不到「DEFAULTS N 个键、配置表 M 行、K 个数据源、声明 L 个出站主机」这句（措辞被改了？那就同步改这条检查）')
else {
  const [keys, rows, sources, hostCount] = [Number(zhProse[1]), Number(zhProse[2]), Number(zhProse[3]), Number(zhProse[4])]
  if (keys !== tally.keys) problems.push(`README.md 说 DEFAULTS ${keys} 个键，实际 ${tally.keys} 个`)
  if (rows !== tally.keys + 1) problems.push(`README.md 说配置表 ${rows} 行，应为 ${tally.keys + 1}（DEFAULTS 键 + moonshotRegion）`)
  if (sources !== tally.sources) problems.push(`README.md 说 ${sources} 个数据源，实际 ${tally.sources} 个`)
  if (hostCount !== tally.hosts) problems.push(`README.md 说声明 ${hostCount} 个出站主机，实际 ${tally.hosts} 个`)
}
const enProse = /(\d+) DEFAULTS keys, an (\d+)-row\s*\n?\s*config table, (\d+) sources,\s*\n?\s*(\d+) declared outbound hosts/.exec(en)
if (enProse === null) problems.push('README.en.md 里找不到 "N DEFAULTS keys, an M-row config table, K sources, L declared outbound hosts" 这句')
else {
  const [keys, rows, sources, hostCount] = [Number(enProse[1]), Number(enProse[2]), Number(enProse[3]), Number(enProse[4])]
  if (keys !== tally.keys) problems.push(`README.en.md says ${keys} DEFAULTS keys, actual ${tally.keys}`)
  if (rows !== tally.keys + 1) problems.push(`README.en.md says an ${rows}-row config table, expected ${tally.keys + 1}`)
  if (sources !== tally.sources) problems.push(`README.en.md says ${sources} sources, actual ${tally.sources}`)
  if (hostCount !== tally.hosts) problems.push(`README.en.md says ${hostCount} declared outbound hosts, actual ${tally.hosts}`)
}
/* 6b) 正文里成对写的"N/M tests"也是声明。这条原本没人管，英文 README 就一直漂着 324/102。 */
for (const [file, text] of [['README.md', zh], ['README.en.md', en]]) {
  for (const m of text.matchAll(/(\d+)\/(\d+)\s*(?:tests|项)/g)) {
    if (counts.host !== undefined && Number(m[1]) !== counts.host) problems.push(`${file} 正文写 ${m[1]}/${m[2]} tests，host 实跑 ${counts.host}`)
    if (counts.client !== undefined && Number(m[2]) !== counts.client) problems.push(`${file} 正文写 ${m[1]}/${m[2]} tests，client 实跑 ${counts.client}`)
  }
}

/* 7) CHANGELOG 里的版本链接不能指向不存在的 tag（留个死链就是又一处假声明） */
const changelog = read('CHANGELOG.md')
// 只看链接定义行（`[0.4.0]: https://…`），正文里提到 vX.Y.Z 的说明文字不算声明。
const referenced = [...new Set([...changelog.matchAll(/^\[[\d.]+\]:\s.*?(v\d+\.\d+\.\d+)(?:\.\.\.)?(v\d+\.\d+\.\d+)?/gm)]
  .flatMap(m => [m[1], m[2]].filter(Boolean)))]
const tags = execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
for (const tag of referenced.sort()) {
  if (!tags.includes(tag)) problems.push(`CHANGELOG 引用了 ${tag}，但仓库没有这个 tag（要么补 tag，要么把链接删掉）`)
}
if (pkg.version !== '0.0.0' && !referenced.some(t => t === `v${pkg.version}`) && tags.includes(`v${pkg.version}`) === false) {
  // 当前版本尚未在 CHANGELOG 里出现时，至少要有对应章节
  if (!changelog.includes(`## [${pkg.version}]`)) problems.push(`CHANGELOG 缺当前版本 ${pkg.version} 的章节`)
}

/* 8) 两张键表是外人唯一能照着写配置的地方：文档说的键，代码必须真读。
 *    动机：盲测时有读者照着 README 写 `card.meters`，而那个键手写根本无效——
 *    "照文档写出来却静默失效"这类洞不该等下一次人工发现。 */
const libText = read('lib/index.js')
const codeSourceKeys = new Set([...libText.matchAll(/\bsource\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))

/** 取某小节里表格每行第一个单元格内的反引号标识符（行尾按 \n 归一：工作副本是 CRLF）。 */
function tableKeys(input, startMarker, endMarker) {
  const text = input.replace(/\r\n/g, '\n')
  const start = text.indexOf(startMarker)
  if (start < 0) return null
  const rest = text.slice(start + startMarker.length)
  const at = endMarker === undefined ? -1 : rest.indexOf(endMarker)
  const slice = at < 0 ? rest : rest.slice(0, at)
  const keys = []
  for (const line of slice.split(/\r?\n/)) {
    const cell = /^\|\s*([^|]+)\|/.exec(line)
    if (cell === null) continue
    // 允许点号：`card.meters` 这类"点出来的键"恰恰是最该被抓的（它就是当初误导读者的那个词）。
    for (const token of cell[1].matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) keys.push(token[1])
  }
  return keys
}

const documentedDefaults = new Set(Object.keys(__internals.DEFAULTS))
for (const [file, text, marker] of [['README.md', zh, '## 配置\n'], ['README.en.md', en, '## Configuration\n']]) {
  const configKeys = tableKeys(text, marker, '\n### ')
  if (configKeys === null) { problems.push(`${file} 找不到「${marker.trim()}」小节，配置表检查失去落点`); continue }
  const missing = [...documentedDefaults].filter(key => !configKeys.includes(key))
  if (missing.length > 0) problems.push(`${file} 的配置表缺键：${missing.join(', ')}`)
  for (const key of configKeys) {
    if (!documentedDefaults.has(key) && key !== 'moonshotRegion') {
      problems.push(`${file} 配置表里的 ${key} 既不是 DEFAULTS 键，也不在允许的单列例外里`)
    }
  }
  if (new Set(configKeys).size !== configKeys.length) problems.push(`${file} 配置表里同一个键出现了多次`)
  if (configKeys.length !== documentedDefaults.size + 1) {
    problems.push(`${file} 配置表列了 ${configKeys.length} 个键，应为 ${documentedDefaults.size} 个 DEFAULTS 键 + moonshotRegion`)
  }
}
for (const [file, text, marker, endMarker] of [
  ['README.md', zh, '#### 手写条目的全部可用键', '**表外的键'],
  ['README.en.md', en, '#### Every key a hand-written entry accepts', '**Keys outside this table'],
]) {
  const entryKeys = tableKeys(text, marker, endMarker)
  if (entryKeys === null) { problems.push(`${file} 找不到条目键表小节（${marker}），这条检查失去落点`); continue }
  if (entryKeys.length < 20) problems.push(`${file} 条目键表只解析出 ${entryKeys.length} 个键，不像一张完整的表`)
  for (const key of new Set(entryKeys)) {
    if (!codeSourceKeys.has(key)) problems.push(`${file} 条目键表里的 ${key} 代码从没读过（写成这样就是又一处死文档）`)
  }
}

/* 9) 编码护栏：Windows PowerShell 5.1 的 `Get-Content` 按 ANSI(GBK) 读 UTF-8，一次
 *    `Get-Content | Set-Content -Encoding utf8` 往返就把中文变成乱码 + BOM，而且**不可逆**
 *    （GBK 私用区字符没有反向映射）。本仓库真的踩过，所以这类损坏必须当场红灯。
 *    判断只看码位，不用字面量——不然这条检查自己就会成为又一处隐形损坏。 */
const textFiles = ['README.md', 'README.en.md', 'ROADMAP.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'RELEASE.md', 'LICENSE', 'package.json', 'cordis.patch.yml']
for (const dir of ['docs', 'lib', 'scripts', 'test', '.github/workflows', '.github/ISSUE_TEMPLATE']) {
  const abs = join(root, dir)
  if (!existsSync(abs)) continue
  for (const name of readdirSync(abs)) {
    if (statSync(join(abs, name)).isFile()) textFiles.push(join(dir, name))
  }
}
const isCjk = ch => { const cp = ch.codePointAt(0); return cp >= 0x4E00 && cp <= 0x9FFF }
const isPua = ch => { const cp = ch.codePointAt(0); return cp >= 0xE000 && cp <= 0xF8FF }
for (const rel of textFiles) {
  let raw
  try {
    raw = readFileSync(join(root, rel)).toString('utf8')
  } catch {
    continue
  }
  if (raw.charCodeAt(0) === 0xFEFF) {
    problems.push(`${rel} 以 BOM 开头（多半是 PowerShell 5.1 的 Set-Content -Encoding utf8 写的；JSON 解析会直接炸）`)
  }
  let hasReplacement = false
  let hasCjkChar = false
  let hasPuaChar = false
  for (const ch of raw) {
    const cp = ch.codePointAt(0)
    if (cp === 0xFFFD) hasReplacement = true
    else if (isCjk(ch)) hasCjkChar = true
    else if (isPua(ch)) hasPuaChar = true
  }
  if (hasReplacement) problems.push(`${rel} 含 U+FFFD 替换符：这份文本已经被错误的码页读过一次了`)
  if (hasCjkChar && hasPuaChar) problems.push(`${rel} 同时含中日韩文字与私用区字符，是 GBK 误读 UTF-8 的典型残骸`)
}

if (problems.length > 0) {
  console.error('check-docs: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-docs: OK（配置键 ${tally.keys}、数据源 ${tally.sources}、出站主机 ${tally.hosts}、`
    + `host ${counts.host} 项 / client ${counts.client} 项，中英 README 与代码一致）`)
}
