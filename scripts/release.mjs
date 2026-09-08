/**
 * 一键发布：切版本 → 搬 CHANGELOG → 提交 → 打 tag → 全量自检 → 推送。
 *
 *   node scripts/release.mjs --patch          # 0.4.5 → 0.4.6
 *   node scripts/release.mjs --version 0.5.0
 *   node scripts/release.mjs --patch --dry-run
 *
 * 推到 tag 之后就没这台机器的事了：`.github/workflows/publish.yml` 接手，
 * 在 CI 里再跑一遍全量检查才真发 npm。所以本地这一步的失败**不会**发出半个包。
 *
 * 浏览器一键：`.github/workflows/release.yml` 用 `workflow_dispatch` 在 runner 上跑同一段
 * 代码（不复制逻辑），差别只有两处 —— `GITHUB_ACTIONS=true` 时给 `git tag -a` 补上身份，
 * 以及推用的凭据来自 actions/checkout 的 `persist-credentials` 默认注入的 `GITHUB_TOKEN`。
 *
 * 三条硬前置（对齐"永不带脏发布"）：
 *  1. 工作区干净 —— 有未提交改动就停，避免把没写完的东西打上 release tag；
 *  2. `[Unreleased]` 有内容 —— 空版本不发；
 *  3. 当前在 main 且比 origin/main 领先可控 —— 不在别的分支上打 release tag。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// GitHub Actions runner 上没有 `user.name/email`；`git tag -a` 会因此挂在最后一步。
// 浏览器一键（release.yml）跟本地跑的是同一段代码，唯一差别就是这里补个身份。
const IS_CI = process.env.GITHUB_ACTIONS === 'true'

const run = (cmd, args, { capture = true } = {}) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: capture ? 'utf8' : undefined, shell: false })
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    throw new Error(`${cmd} ${args.join(' ')} 失败（exit ${r.status}）${out ? `\n${out}` : ''}`)
  }
  return (r.stdout ?? '').trim()
}
const git = (...args) => run('git', args)

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { dryRun: false, bump: null, version: null }
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--patch' || arg === '--minor' || arg === '--major') out.bump = arg.slice(2)
    else if (arg.startsWith('--version')) out.version = arg.split('=')[1] ?? argv[argv.indexOf(arg) + 1]
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (!arg.startsWith('--')) out.version = out.version ?? arg
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

const nextVersion = (current, kind) => {
  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * 取 `[Unreleased]` 到下一个 `## ` 之间的正文。
 * 注意别用 `\s*\n` 起手：`\s` 也吃换行，会把空节后面那一节的正文一起算进来
 * （探针就因此误报"Unreleased 还有 1587 字"）。按行切最稳。
 */
function unreleasedBody(changelog) {
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => /^## \[Unreleased\]/.test(line))
  if (start < 0) throw new Error('CHANGELOG 里没有 ## [Unreleased] 这一节')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^## /.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node scripts/release.mjs (--patch|--minor|--major|--version X.Y.Z) [--dry-run]')
    return
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const changelogPath = join(ROOT, 'CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const current = pkg.version
  const target = args.version ?? (args.bump ? nextVersion(current, args.bump) : null)
  if (target === null) throw new Error('要给版本：--patch / --minor / --major / --version X.Y.Z')
  if (!/^\d+\.\d+\.\d+$/.test(target)) throw new Error(`版本号格式不对：${target}`)

  const blockers = []
  if (git('status', '--porcelain') !== '') blockers.push('工作区不干净：先提交或还原')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  // Actions runner 上 checkout 默认是 detached HEAD（`--abbrev-ref` 会得到 `HEAD`），
  // 但 workflow_dispatch 触发时 `ref` 就是所选分支；这条闸门是给本地误操作准备的，CI 不适用。
  if (branch !== 'main' && !IS_CI) blockers.push(`当前在 ${branch}，release 只在 main 上打`)
  if (unreleasedBody(changelog) === '') blockers.push('[Unreleased] 是空的：没有内容可发')
  if (changelog.includes(`## [${target}]`)) blockers.push(`CHANGELOG 已有 ## [${target}]`)
  if (git('tag', '--list', `v${target}`).trim() !== '') blockers.push(`tag v${target} 已存在`)
  if (blockers.length > 0) {
    console.error('不能发布：')
    for (const b of blockers) console.error(`  - ${b}`)
    process.exitCode = 1
    return
  }

  const previous = git('describe', '--tags', '--abbrev=0').replace(/^v/, '')
  const today = new Date().toISOString().slice(0, 10)
  console.log(`发布计划：${current} → ${target}（上一版 tag：v${previous}，日期 ${today}）`)

  // CHANGELOG：把 [Unreleased] 的正文搬进新版本节，上面留一个空的 [Unreleased]。
  // 匹配范围一直吃到下一节的 `## ` 开头，替换时原样还回去 —— 节与节之间恰好一个空行
  // （早先的版本会把前导换行重复一次，变成两个空行）。
  const body = unreleasedBody(changelog)
  const moved = changelog.replace(
    /## \[Unreleased\]\n[\s\S]*?\n## /,
    `## [Unreleased]\n\n## [${target}] - ${today}\n\n${body}\n\n## `,
  )
  if (!moved.includes(`## [${target}] - ${today}`)) throw new Error('CHANGELOG 搬移失败：没找到 [Unreleased] 的边界')
  const linkNeedle = `\n[${previous}]:`
  const withLink = moved.includes(linkNeedle)
    ? moved.replace(linkNeedle, `\n[${target}]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v${previous}...v${target}\n[${previous}]:`)
    : moved
  if (!withLink.includes(`[${target}]: https://github.com`)) throw new Error(`CHANGELOG 缺 [${previous}] 链接区，无法插入 compare 链接`)

  const pkgText = readFileSync(join(ROOT, 'package.json'), 'utf8')
  const nextPkg = pkgText.replace(/("version":\s*")[\d.]+(")/, `$1${target}$2`)
  if (nextPkg === pkgText) throw new Error('package.json 里没找到 version 字段')

  if (args.dryRun) {
    console.log('\n--dry-run，未写入任何东西。将要写的 CHANGELOG 头部：')
    console.log(withLink.split('\n').slice(8, 16).map(l => `  ${l}`).join('\n'))
    console.log(`  package.json: "version": "${target}"`)
    console.log(`  提交信息：chore(release): ${target}`)
    console.log('  然后：git tag v' + target + ' → npm run check → 推 main 与 tag（tag 一落地，CI 就发 npm）')
    return
  }

  writeFileSync(changelogPath, withLink)
  writeFileSync(join(ROOT, 'package.json'), nextPkg)
  if (IS_CI) {
    // runner 里没配置过身份；不补的话 `git commit` 直接失败。
    // 名字用 GitHub 官方那对（[bot] 邮箱），这样提交会挂在 Actions 图标下，不冒名。
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
  }
  git('add', 'package.json', 'CHANGELOG.md')
  git('commit', '-m', `chore(release): ${target}`)
  // tag 先打在本地：check-docs 会核 CHANGELOG 里的 compare 链接指向真实 tag，
  // 没有它就永远红，于是"先自检再推"变成死循环。
  git('tag', '-a', `v${target}`, '-m', `${pkg.name} ${target}`)
  console.log('本地已提交并打 tag，开始全量自检…')
  const check = spawnSync('npm', ['run', 'check'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (check.status !== 0) {
    console.error('\n自检没过 —— 没有推送任何东西。')
    console.error(`回退：git tag -d v${target} && git reset --soft HEAD~1`)
    console.error('（修好后重跑本脚本，或直接 git push origin main && git push origin ' + `v${target}）`)
    process.exitCode = 1
    return
  }
  // 用 `HEAD:main` 而不是 `main` —— actions/checkout 默认是 detached HEAD，本地分支指针
  // 不会跟着我们的 commit 走，`git push origin main` 在 runner 上会把旧 tip 又推一遍。
  git('push', 'origin', 'HEAD:main')
  git('push', 'origin', `v${target}`)
  console.log(`\n已推送 ${target} + tag v${target}。`)
  console.log('CI：Actions → publish → npm publish。看 https://github.com/xinghe-1018/dsh-token-plan-quota/actions')
}

main()
