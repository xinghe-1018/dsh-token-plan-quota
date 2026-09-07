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
 *   5. README 声称的测试项数与实跑结果一致（数字不许漂）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
 *    主机数说的是**已声明**的出站主机（审计看的就是这个数），不是从预设里推导出来的那批。 */
const tally = { keys: Object.keys(__internals.DEFAULTS).length, sources: Object.keys(__internals.PRESETS).length, hosts: declared.size }
const zhProse = /配置表 (\d+) 个键、(\d+) 个数据源、声明 (\d+) 个出站主机/.exec(zh)
if (zhProse === null) problems.push('README.md 里找不到「配置表 N 个键、M 个数据源、声明 K 个出站主机」这句（措辞被改了？那就同步改这条检查）')
else {
  const [keys, sources, hostCount] = [Number(zhProse[1]), Number(zhProse[2]), Number(zhProse[3])]
  if (keys !== tally.keys) problems.push(`README.md 说配置表 ${keys} 个键，实际 ${tally.keys} 个`)
  if (sources !== tally.sources) problems.push(`README.md 说 ${sources} 个数据源，实际 ${tally.sources} 个`)
  if (hostCount !== tally.hosts) problems.push(`README.md 说声明 ${hostCount} 个出站主机，实际 ${tally.hosts} 个`)
}
const enProse = /(\d+) config keys, (\d+) sources,\s*\n?\s*(\d+) declared outbound hosts/.exec(en)
if (enProse === null) problems.push('README.en.md 里找不到 "N config keys, M sources, K declared outbound hosts" 这句')
else {
  const [keys, sources, hostCount] = [Number(enProse[1]), Number(enProse[2]), Number(enProse[3])]
  if (keys !== tally.keys) problems.push(`README.en.md says ${keys} config keys, actual ${tally.keys}`)
  if (sources !== tally.sources) problems.push(`README.en.md says ${sources} sources, actual ${tally.sources}`)
  if (hostCount !== tally.hosts) problems.push(`README.en.md says ${hostCount} declared outbound hosts, actual ${tally.hosts}`)
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

if (problems.length > 0) {
  console.error('check-docs: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-docs: OK（配置键 ${tally.keys}、数据源 ${tally.sources}、出站主机 ${tally.hosts}、`
    + `host ${counts.host} 项 / client ${counts.client} 项，中英 README 与代码一致）`)
}
