#!/usr/bin/env node
/**
 * 清单自检：`dsh plugin add` 与插件目录站都要求 package.json 声明 `dsh.bundle.patch`
 * 且那个文件真实存在——只声明 `dsh.client` 是无法安装的（最常见的被拒原因）。
 * 顺带锁几条对外承诺：出站主机清单、许可证、零运行时依赖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const patch = pkg?.dsh?.bundle?.patch
if (typeof patch !== 'string' || patch === '') problems.push('package.json 缺 dsh.bundle.patch（没有它 `dsh plugin add` 装不上）')
else if (!existsSync(join(root, patch.replace(/^\.\//, '')))) problems.push(`dsh.bundle.patch 指向的文件不存在：${patch}`)

if (pkg?.dsh?.client?.platform !== 'web') problems.push('缺 dsh.client.platform = "web"（带前端 UI 的插件必须声明）')
if (!Array.isArray(pkg?.dshhub?.permissions?.network) || pkg.dshhub.permissions.network.length === 0) {
  problems.push('dshhub.permissions.network 为空：所有出站主机都要声明')
} else {
  for (const host of pkg.dshhub.permissions.network) {
    if (!/^https:\/\//.test(host)) problems.push(`permissions.network 有条目不是 https:// 形式：${host}`)
  }
}
if (pkg.license !== 'MIT') problems.push(`license 应为 MIT，当前 ${JSON.stringify(pkg.license)}`)
if (!existsSync(join(root, 'LICENSE'))) problems.push('仓库缺 LICENSE 文件')
if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) {
  problems.push(`本插件承诺零运行时依赖，但 dependencies 非空：${Object.keys(pkg.dependencies).join(', ')}`)
}
if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version))) problems.push(`version 不是 x.y.z：${pkg.version}`)

if (problems.length > 0) {
  console.error('check-manifest: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-manifest: OK（${pkg.name} ${pkg.version}，出站主机 ${pkg.dshhub.permissions.network.length} 个）`)
}
