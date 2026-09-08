#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里抠出某一版的正文，写到 stdout。
 *
 *   node scripts/extract-changelog-section.mjs 0.4.5
 *   node scripts/extract-changelog-section.mjs 0.4.5 --heading   # 连 "## [0.4.5] - 2026-09-08" 一起
 *
 * 给 `.github/workflows/publish.yml` 里的 `softprops/action-gh-release@v2` 用：
 * `body_path` 只吃一个文件，所以我们把这一节写成 release-notes.md 递过去。
 *
 * 按行切，不用 `[\s\S]*?` 之类的正则：release.mjs 早期就用行首多吞空行的写法踩过坑
 * （`\s*\n` 会把整个下一节一起吃进来），这里干脆沿用同一套逐行扫描。
 *
 * `extract` 也导出给 test/host.mjs 用；CLI 入口只在被直接跑的时候触发，别 import 时抢着打印。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function extract(changelog, version, { heading = false } = {}) {
  if (!/^\d+\.\d+\.\d+/.test(version)) return null
  const lines = changelog.split('\n')
  // 精确匹配 `## [X.Y.Z]` 后面紧跟空格或行尾；不然 `0.4` 会顺带命中 `## [0.4.5]` 的锚。
  const re = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](\\s|$)`)
  const start = lines.findIndex(l => re.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break }
  }
  const body = lines.slice(start + 1, end).join('\n').trimEnd()
  return heading ? `${lines[start].trimEnd()}\n\n${body}` : body
}

// Node 里 import 时 argv[1] 是本文件的情况只有直接 `node script.mjs`；
// 被别的模块 import 时 argv[1] 指向入口文件，不匹配 —— 这段就不会跑。
// 用 URL 对 URL（Windows 的 `argv[1]` 是反斜杠原生路径，`fileURLToPath` 却给正斜杠），
// 直接字符串比较会假阳，永远进不去这段。
const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invoked) {
  const argv = process.argv.slice(2)
  const heading = argv.includes('--heading')
  const version = argv.find(a => !a.startsWith('--'))
  if (!version) {
    console.error('用法：node scripts/extract-changelog-section.mjs <X.Y.Z> [--heading]')
    process.exit(2)
  }
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const section = extract(text, version, { heading })
  if (section === null) {
    console.error(`CHANGELOG 里没有 ## [${version}] 这一节`)
    process.exit(1)
  }
  process.stdout.write(section + '\n')
}
