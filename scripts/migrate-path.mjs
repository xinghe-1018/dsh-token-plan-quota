/**
 * 一次性迁移：把误建在 <DSH_HOME>/.dsh/ 下的插件文件搬回 <DSH_HOME>/，并删掉空壳目录。
 * 用法：node migrate-path.mjs
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME, '.dsh')
const stray = join(home, '.dsh')

console.log('DSH_HOME =', home)
if (!existsSync(stray)) {
  console.log('没有误建目录，无需迁移')
  process.exit(0)
}
console.log('误建目录内容：', readdirSync(stray).join(', ') || '(空)')

for (const name of readdirSync(stray)) {
  if (!name.startsWith('token-plan-quota')) {
    console.log(`跳过非本插件文件：${name}`)
    continue
  }
  const from = join(stray, name)
  const to = join(home, name)
  if (existsSync(to)) {
    console.log(`目标已存在，保留两份：${name} → 备份为 ${name}.from-stray`)
    writeFileSync(`${to}.from-stray`, readFileSync(from))
    continue
  }
  const size = statSync(from).size
  renameSync(from, to)
  console.log(`已迁移 ${name}（${size} 字节）→ ${to}`)
}

const left = readdirSync(stray)
if (left.length === 0) {
  rmSync(stray, { recursive: true, force: true })
  console.log('空壳目录已删除')
} else {
  console.log('目录仍有其它内容，保留：', left.join(', '))
}
