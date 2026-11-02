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

/* 兼容区间有两份**手写副本**（dsh.engines.dsh / dshhub.compatibility.dsh，以及
 * engines.node / dshhub.compatibility.node）。JSON 里做不到共享来源，所以把等式钉住：
 * 只改一处时宿主装得上而目录站拒收（或反过来），而在这条之前 npm run check 全绿。
 * CHANGELOG 的 0.4.11 一节记过同一族事故（「兼容声明在预发布线上自相矛盾」）。 */
if (pkg?.dsh?.engines?.dsh !== pkg?.dshhub?.compatibility?.dsh) {
  problems.push(`dsh.engines.dsh 与 dshhub.compatibility.dsh 不相等（兼容区间只能有一个真值）：宿主侧 ${JSON.stringify(pkg?.dsh?.engines?.dsh)} vs 目录站 ${JSON.stringify(pkg?.dshhub?.compatibility?.dsh)}`)
}
if (pkg?.engines?.node !== pkg?.dshhub?.compatibility?.node) {
  problems.push(`engines.node 与 dshhub.compatibility.node 不相等：${JSON.stringify(pkg?.engines?.node)} vs ${JSON.stringify(pkg?.dshhub?.compatibility?.node)}`)
}

if (problems.length > 0) {
  console.error('check-manifest: 不通过')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`check-manifest: OK（${pkg.name} ${pkg.version}，出站主机 ${pkg.dshhub.permissions.network.length} 个）`)
}
