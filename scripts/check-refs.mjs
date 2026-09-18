#!/usr/bin/env node
/**
 * 引用形态自检：**活文档**里不得出现 `文件:行号` 形态的引用。
 *
 * 动机（2026-09-18 的 retro，两轮实践会话）：
 *  `workflow/PLAN.md` 早就写了"引用位置用标题锚点、不写行号"，但仓库里仍有 50 处 `file:line`，
 *  且 001 的评审已经实测到行号过期（`ROADMAP.md` §0 的 `L926` 早已指向别处）。
 *  散文规则拦不住机械违规——这条是本项目自己的既定立场，所以这里把它变成门禁。
 *
 * 行号为什么会腐烂：文档在提交 A 写下"这行在 lib/index.js:44"，代码在提交 B 移动，
 * 没人回头读文档。锚点（`## 2. 阶段②`）与符号名（`` `autoDetect: true` ``）不会腐烂，
 * 而且**可 grep**——读者能自己找到，不用信任一个数字。
 *
 * 检查项：
 *   1. `workflow/**\/*.md`、`specs/**\/*.md`（不含 `reviews/`）、`ROADMAP.md` 里没有 `文件:行号`；
 *   2. 也没有反引号包起来的裸续写行号（`` `:1189` ``——它和上面那处是同一个引用被切成了两段）；
 *   3. 扫描面本身有效（文件数、检出率）——门禁自己悄悄失效是最坏的假绿，所以文件太少要报红。
 *
 * **不在范围内**（刻意的，见 specs/003-guardrails-and-doc-hygiene/spec.md 非目标）：
 *  - `CHANGELOG.md`：它记录已发布的历史，那时的行号是当时的现场，改它就是篡改历史。
 *  - `specs/**\/reviews/**`：评审报告是"当时看到了什么"的冻结证据，允许其行号随代码漂移。
 *    这正是 `REVIEW-CHECKLIST.md` 里「评审期间冻结工作树」那条规则存在的原因。
 *  - 源码注释里的行号：实现者对自己刚看过的位置的就地批注，腐烂半径小。
 *  - 代码围栏（```）里的内容：那是命令输出或复现记录，`file:line` 在那里是**证据**。
 *
 * **刻意不认的形态**：`L44` / `L1189` 这类不带文件名的裸行号。它和本项目给评审发现起的编号
 * 撞车（`L3-2` 是"Lens 3 的第 2 条发现"，不是行号），认它会制造假红。裸续写 `:1189` 之所以
 * 能认，是因为要求被反引号整段包住——`L3-2` 不在任何一条规则里。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 两种形态，各有各的误报面，所以分开写而不是揉成一个正则：
 *  - `文件:行号` 要求前面是个**带已知扩展名**的路径，`http://127.0.0.1:3080` 这种端口不会命中
 *    （`1` 不在扩展名表里）。
 *  - 裸行号只在**被反引号包住**时才认（`` `:1189` ``）：不包的话，`9:00`、`比例 1:2` 都会中。
 */
const REF_PATTERNS = [
  { label: '文件:行号', re: /\b[\w./-]+\.(?:md|mjs|cjs|js|json|yml|yaml|sh|ps1|css|html|jsonc|txt):\d+(?:-\d+)?/g },
  { label: '裸行号续写', re: /`:\d+(?:-\d+)?`/g },
]

/**
 * 纯函数：从一个 Markdown 文本里找出所有行号引用。**不碰文件系统**，所以可被测试直接调用。
 * @param {string} text Markdown 原文
 * @returns {{label: string, match: string}[]} 命中项（去重后按出现顺序）
 */
export function findLineRefs(text) {
  // 只剥代码围栏，**不剥行内代码**——被禁的引用绝大多数恰恰写在反引号里（`` `lib/index.js:44` ``）。
  const stripped = text.replace(/```[\s\S]*?```/g, ' ')
  const seen = new Set()
  const out = []
  for (const { label, re } of REF_PATTERNS) {
    for (const match of stripped.matchAll(re)) {
      const key = `${label}\u0000${match[0]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ label, match: match[0] })
    }
  }
  return out
}

/** 范围内的文件：显式列举顶层文件 + 递归两个目录，排除 reviews/。 */
function inScopeFiles() {
  const files = ['ROADMAP.md'].filter(existsSync)
  for (const dir of ['workflow', 'specs']) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const rel of readdirSync(abs, { recursive: true })) {
      // 路径分隔符在 Windows 上是 `\`，统一成 `/` 再做排除判断。
      const normalized = String(rel).replace(/\\/g, '/')
      if (!normalized.endsWith('.md')) continue
      if (normalized.startsWith('reviews/') || normalized.includes('/reviews/')) continue
      // 一律用 `/` 拼进报告：同一处违规在 Windows 与 Linux 上要长得一样，否则 CI 的注解
      // 和本地的输出对不上，人还得在脑子里换算一次分隔符。
      files.push(`${dir}/${normalized}`)
    }
  }
  return files
}

function main() {
  const problems = []
  const files = inScopeFiles()
  // 门禁自己失效（目录改名 / 递归 API 变了 / 排除规则写宽了）时必须报红，而不是"零违规通过"。
  if (files.length < 8) {
    problems.push(`范围内只找到 ${files.length} 个 Markdown 文件，扫描面像失效了（预期 >= 8）：${files.join(', ')}`)
  }
  for (const file of files) {
    for (const { label, match } of findLineRefs(readFileSync(join(root, file), 'utf8'))) {
      problems.push(`${file} 出现${label}引用：${match}（改用标题锚点或可 grep 的符号名）`)
    }
  }

  if (problems.length > 0) {
    console.error('check-refs: 不通过')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`check-refs: OK（${files.length} 个活文档，无行号引用）`)
  }
}

// 被 import 时只暴露 findLineRefs，不产生副作用（测试要能单独调用它）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}