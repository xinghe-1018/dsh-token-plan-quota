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
 * 代码（不复制逻辑），差别有三处 —— `GITHUB_ACTIONS=true` 时给 `git tag -a` 补上身份、
 * 推用的凭据来自 actions/checkout 的 `persist-credentials` 默认注入的 `GITHUB_TOKEN`，
 * 以及**推完必须显式 dispatch publish.yml**：用 `GITHUB_TOKEN` 触发的事件不会新建 workflow run
 * （GitHub 防递归的设计，例外只有 workflow_dispatch / repository_dispatch），所以那条路径上
 * publish.yml 的 `on: push: tags` 永远不会自己触发。那一步写在 release.yml 里，因为本地手推
 * tag（用人的凭据）不受这条限制，仍然走自动触发。
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
import { repoPathFromUrl } from './repo-path.mjs'

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
  // Actions runner 上 checkout 默认是 detached HEAD（`--abbrev-ref` 会得到 `HEAD`），拿不到分支名，
  // 所以 CI 下改看 `GITHUB_REF`：workflow_dispatch 的 ref 是人在 UI 上选的，**可以选任意分支**，
  // 而下面推的是 `HEAD:main` —— 不加这道闸门就等于"从任意分支发版会把该分支内容推上 main 再打 tag"。
  if (IS_CI) {
    const ref = process.env.GITHUB_REF ?? ''
    if (ref !== 'refs/heads/main') blockers.push(`CI 的 ref 是 ${ref || '(未知)'}，release 只在 refs/heads/main 上打（在 Actions 页面选 main 再跑）`)
  } else if (branch !== 'main') {
    blockers.push(`当前在 ${branch}，release 只在 main 上打`)
  }
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
  // 仓库路径只有一个来源：package.json#repository.url。原先 owner/repo 在三处各写一遍
  // （这里、check-submission.mjs、package.json），改名时 check-docs 只核 tag 那半段，
  // 于是 compare 链接会静默指向旧仓库而门禁全绿。
  const repoPath = repoPathFromUrl(pkg.repository?.url)
  if (repoPath === undefined) throw new Error('package.json#repository.url 里取不到 owner/repo，compare 链接无法生成')
  const linkNeedle = `\n[${previous}]:`
  const withLink = moved.includes(linkNeedle)
    ? moved.replace(linkNeedle, `\n[${target}]: https://github.com/${repoPath}/compare/v${previous}...v${target}\n[${previous}]:`)
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
  // `--no-verify` 是必需的，不是图快：CONTRIBUTING 推荐的 pre-commit 钩子会跑 `npm run check`，
  // 而此刻 CHANGELOG 刚插进去的 compare 链接指向 `v${target}`，tag 要到下一行才创建 ——
  // check-docs 的"CHANGELOG 引用的 tag 必须存在"必然红，提交被自家门禁拒绝，留下
  // "已改已 add、无 commit"的半途状态（下一次 `git status` 还会说工作区脏，release 自己也走不动）。
  // 脚本自己在下游（打完 tag 之后）跑完整自检，钩子这一步是重复的。
  git('commit', '--no-verify', '-m', `chore(release): ${target}`)
  // tag 先打在本地：check-docs 会核 CHANGELOG 里的 compare 链接指向真实 tag，
  // 没有它就永远红，于是"先自检再推"变成死循环。
  git('tag', '-a', `v${target}`, '-m', `${pkg.name} ${target}`)
  console.log('本地已提交并打 tag，开始全量自检…')
  // 自检不调 `npm`：Windows 上它是 npm.cmd，而 Node 24 起（CVE-2024-27980 的修复）
  // spawnSync 拒绝在不带 shell 的情况下启动 .cmd —— 于是这一步**根本没跑**就返回非零，
  // 报"自检没过"却拿不到任何原因（0.4.7 发布时实机撞上：手动 npm run check 全绿）。
  // 直接用自己的 process.execPath 跑 `npm run check` 里那七步（顺序与 package.json#scripts.check
  // 一致）：跨平台都是真可执行体，不碰 shell，也不触发 DEP0190。
  // 步骤清单以 package.json#scripts.check 为唯一来源：原先在这里又抄了一份，加/换一步就两处漂，
  // 而"release 跑的自检"与"CI 跑的 check"理应是同一套（V：宣称与实际必须一致）。
  const CHECK_STEPS = String(pkg.scripts?.check ?? '').split('&&').map(part => part.trim()).filter(part => part !== '')
  if (CHECK_STEPS.length === 0 || CHECK_STEPS.some(step => !/^node\s+\S+$/.test(step))) {
    throw new Error(`package.json#scripts.check 的形状变了（期望「node <文件> && …」的链），release.mjs 的解析要同步：${pkg.scripts?.check ?? '(缺失)'}`)
  }
  const CHECK_ARGS = CHECK_STEPS.map(step => step.replace(/^node\s+/, '').split(/\s+/))
  let checkFailed = null
  for (const args of CHECK_ARGS) {
    const step = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', shell: false })
    if (step.status !== 0) {
      checkFailed = { step: args[0], status: step.status, error: step.error ? step.error.message : null }
      break
    }
  }
  if (checkFailed !== null) {
    console.error('\n自检没过 —— 没有推送任何东西。')
    if (checkFailed.error !== null) console.error(`  ${checkFailed.step} 连启动都失败：${checkFailed.error}`)
    else console.error(`  失败的是 ${checkFailed.step}（exit ${checkFailed.status}）`)
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
