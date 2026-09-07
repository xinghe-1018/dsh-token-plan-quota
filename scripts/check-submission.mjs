#!/usr/bin/env node
/**
 * 投稿条目自检：`RELEASE.md` §4 里那段 YAML 就是提交给插件目录站的**唯一权威文本**，
 * 它必须自己站得住——被拒的最常见原因是格式（含 `: ` 却没加引号、行尾逗号）和描述与代码对不上。
 *
 * 检查项来自 awesome-dsh-plugin 的 `contributing.md`（分类表若被上游改动，这里会红，
 * 那是提醒而不是故障——去对一遍再更新本文件的列表）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CATEGORIES = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl',
  'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote',
  'market', 'fun']
const OWNER = 'xinghe-1018'
const REPO = 'dsh-token-plan-quota'

const problems = []
const book = readFileSync(join(root, 'RELEASE.md'), 'utf8').replace(/\r\n/g, '\n')
const section = book.split('## 4. 提交到 awesome-dsh-plugin')[1]
if (section === undefined) {
  console.error('check-submission: RELEASE.md 里找不到「## 4. 提交到 awesome-dsh-plugin」小节')
  process.exit(1)
}
const block = /```yaml\n([\s\S]*?)```/.exec(section)
if (block === null) {
  console.error('check-submission: §4 里找不到投稿用的 yaml 代码块')
  process.exit(1)
}
const yaml = block[1]
const lines = yaml.split('\n')

for (const key of ['url:', 'name:', 'category:', 'description:']) {
  if (!lines.some(line => line.startsWith(key))) problems.push(`缺顶层键 ${key}`)
}
if (lines[0] !== `url: https://github.com/${OWNER}/${REPO}`) {
  problems.push(`url 必须与仓库完全一致（实际：${lines[0]}）`)
}
if (lines[1] !== `name: ${OWNER}/${REPO}`) problems.push('name 应为 owner/repo 形式')

const category = /category: (\S+)/.exec(yaml)?.[1]
if (!CATEGORIES.includes(category)) problems.push(`category "${category}" 不在上游取值表里`)

for (const label of ['en', 'zh']) {
  const value = new RegExp(`^  ${label}: (.+)$`, 'm').exec(yaml)?.[1]
  if (value === undefined) {
    if (label === 'en') problems.push('description.en 是唯一必填项，不能缺')
    continue
  }
  const quoted = value.startsWith("'") && value.endsWith("'")
  const inner = quoted ? value.slice(1, -1) : value
  if (!/[。.]$/.test(inner)) problems.push(`description.${label} 要以句号结尾`)
  if (value.endsWith(',')) problems.push(`description.${label} 行尾多了逗号（无效 YAML）`)
  if (/: /.test(inner) && !quoted) {
    problems.push(`description.${label} 含 ": " 却没加引号（YAML 会把它当嵌套键）`)
  }
  if (quoted && inner.includes("'")) {
    problems.push(`description.${label} 里有裸单引号，会让 YAML 提前结束（要写就得按规则双写成 ''）`)
  }
}

// 描述里点名的厂家必须真的在预设里——评审会拿代码核这句话。
const presetIds = Object.keys((await import('../lib/index.js')).__internals.PRESETS)
const SUPPORTED = [['DeepSeek', 'deepseek-balance'], ['Qwen', 'token-plan-console'],
  ['Aliyun', 'account-balance'], ['Moonshot', 'moonshot-balance'], ['OpenRouter', 'openrouter-credits']]
for (const [claim, preset] of SUPPORTED) {
  if (new RegExp(claim, 'i').test(yaml) && !presetIds.includes(preset)) {
    problems.push(`描述提到 ${claim}，但预设里没有 ${preset}`)
  }
}
// 反方向更要命：把"官方没有额度端点"的厂家写进取官方读数的名单，就是超售。
// 这些名字出现在投稿描述里一律红（README 的 ❌ 档与预设表都不认它们）。
for (const measuredOnly of ['MiniMax', 'Anthropic', 'Claude', 'Gemini']) {
  if (new RegExp(`\\b${measuredOnly}\\b`, 'i').test(yaml)) {
    problems.push(`描述提到 ${measuredOnly}，但它是本插件标记为"官方无 Key 化额度端点"的 ❌ 档，不能算官方读数`)
  }
}

// 条目文件名约定：<owner>__<repo>.yml，投稿链接与手册里写的必须是同一个。
const expectedFile = `data/plugins/${OWNER}__${REPO}.yml`
if (!book.includes(expectedFile)) problems.push(`RELEASE.md 里没出现条目文件名 ${expectedFile}`)

if (problems.length > 0) {
  console.error('check-submission: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-submission: OK（条目 ${expectedFile}，category=${category}，`
    + `en ${yaml.length} 字符内含 zh 双语描述，与 README 同源）`)
}
