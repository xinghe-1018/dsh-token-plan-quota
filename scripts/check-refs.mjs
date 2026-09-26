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
 *  - **任何层级的 `reviews/` 目录**（现行是 `specs/<编号>-<slug>/reviews/`）：评审报告是"当时
 *    看到了什么"的冻结证据，允许其行号随代码漂移。这正是 `REVIEW-CHECKLIST.md` 里
 *    「评审期间冻结工作树」那条规则存在的原因。
 *  - 源码注释里的行号：实现者对自己刚看过的位置的就地批注，腐烂半径小。
 *  - 代码围栏（```）里的内容：那是命令输出或复现记录，`file:line` 在那里是**证据**。
 *
 * **刻意不认的形态**：`L44` / `L1189` 这类不带文件名的裸行号。它和本项目给评审发现起的编号
 * 撞车（`L3-2` 是"Lens 3 的第 2 条发现"，不是行号），认它会制造假红。裸续写 `:1189` 之所以
 * 能认，是因为要求被反引号整段包住——`L3-2` 不在任何一条规则里。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripFences } from './markdown-strip.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 两种形态，各有各的误报面：
 *  - `文件:行号` 要求前面是个**带已知扩展名**的路径，`http://127.0.0.1:3080` 这种端口不会命中
 *    （`1` 不在扩展名表里）。
 *  - 裸行号只在**被反引号包住**时才认（`` `:1189` ``）：不包的话，`9:00`、`比例 1:2` 都会中。
 *
 * `文件:行号` **刻意不用一条** `\b[\w./-]+\.(ext):\d+` 的正则：那个字符类本身含 `.`、后面又紧跟
 * 字面 `\.`，在"长点号串"上每个起点都要回退重扫，是 Θ(n²)——003 的 Lens 2 实测 `'a.' × 40000`
 * （80 KB）要 **7.8 秒**，而真 README 只要 0.21 ms。对一道挂在 pre-commit 上的门禁来说，
 * 这是文档内容就能触发的自我 DoS。
 * 改成两步：先用线性正则定位 `.<ext>:<digits>`，再从那个点**向左**走回收路径前缀——单次回退
 * 只与那一处前缀的长度有关，整体线性（80 KB 实测 0 ms，且对全部活文档的检出集合逐项不变）。
 */
const REF_TAIL = /\.(?:md|markdown|mjs|cjs|js|jsx|ts|tsx|json|jsonc|yml|yaml|toml|sh|bash|ps1|psm1|css|scss|html|vue|svelte|txt|cfg|ini|py|go|rs|java|kt|cs|rb|php|c|h|cpp|hpp):\d+(?:-\d+)?/g
const HASH_TAIL = /#L\d+(?:-L\d+)?/g
const BARE_REF = /`:\d+(?:-\d+)?`/g
const PATH_CHAR = /[\w./-]/

/**
 * 从一个"尾部标记"（`.<ext>:<digits>` 或 `#L<digits>`）出发，向**左**走收回文件路径部分。
 * 这样整体线性：每个标记只回退它自己前缀的长度（见下面 `findLineRefs` 的注释）。
 * @param {string} stripped 已剥围栏的文本
 * @param {RegExp} tailRe 带 `g` 的尾部正则
 * @returns {string[]} 完整的引用片段
 */
function refsByTail(stripped, tailRe) {
  const out = []
  for (const m of stripped.matchAll(tailRe)) {
    let start = m.index
    while (start > 0 && PATH_CHAR.test(stripped[start - 1])) start -= 1
    // 与旧 `\b[\w./-]+` 对齐：起点不落在 `/` / `.` 上（旧正则的 `\b` 在那儿不成立）。
    while (start < m.index && (stripped[start] === '/' || stripped[start] === '.')) start += 1
    if (start === m.index) continue     // 没有文件路径部分（裸 `.md:44` / 裸 `#L44`）→ 不算引用
    out.push(stripped.slice(start, m.index + m[0].length))
  }
  return out
}

/**
 * 纯函数：从一个 Markdown 文本里找出所有行号引用。**不碰文件系统**，所以可被测试直接调用。
 * @param {string} text Markdown 原文
 * @returns {{label: string, match: string}[]} 命中项（去重后按出现顺序）
 */
export function findLineRefs(text) {
  // 只剥代码围栏，**不剥行内代码**——被禁的引用绝大多数恰恰写在反引号里（`` `lib/index.js:44` ``）。
  const stripped = stripFences(text)
  const seen = new Set()
  const out = []
  const push = (label, match) => {
    const key = `${label}\u0000${match}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ label, match })
  }
  for (const match of refsByTail(stripped, REF_TAIL)) push('文件:行号', match)
  for (const match of refsByTail(stripped, HASH_TAIL)) push('文件#L行锚', match)
  for (const m of stripped.matchAll(BARE_REF)) push('裸行号续写', m[0])
  return out
}

/**
 * 手工递归枚举 `.md`。**刻意不用** `readdirSync(dir, { recursive: true })`：它会跟随 symlink
 * 与 Windows junction——003 的 Lens 2 在 TEMP 实测，junction 自指会把枚举放大到 192 条并下钻到
 * 路径长度上限，而指向仓库外的 `.md` 会被真读进来。那等于给这道新门禁加了一个"读仓库外文件"的面。
 * 遇到 `isSymbolicLink()` 直接跳过：实测 junction 与文件 symlink 都会报 true，一条挡住"环"与"越界"。
 */
/** 递归时跳过的目录：`.git` 里没有活文档（而且量极大）、node_modules 与截图中间产物同理。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.shots-work'])

function walkMarkdown(absDir, rel, out) {
  for (const dirent of readdirSync(absDir, { withFileTypes: true })) {
    const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
    if (dirent.isSymbolicLink()) continue
    if (dirent.isDirectory()) {
      if (!SKIP_DIRS.has(dirent.name)) walkMarkdown(join(absDir, dirent.name), childRel, out)
    } else if (dirent.name.endsWith('.md')) out.push(childRel)
  }
}

/**
 * 范围内的文件：**仓库里所有 .md**，只有两类豁免（理由见文件头）——
 *  - `CHANGELOG.md`：记录已发布的历史，那时的行号是当时的现场；
 *  - 任何层级的 `reviews/` 目录：冻结的评审证据。
 *
 * 旧实现是"显式列举顶层 + 只递归 workflow/ 与 specs/"：于是 `scripts/shots/README.md`
 * （活文档）里的 5 处 `file:line` 永不被捕获，而门禁的日志还宣称"19 个活文档无行号引用"——
 * 宣称的覆盖面大于实际覆盖面，比明说"只管这几个目录"更坏。
 */
function inScopeFiles() {
  const all = []
  walkMarkdown(root, '', all)
  return all.filter(rel => rel !== 'CHANGELOG.md' && !rel.startsWith('reviews/') && !rel.includes('/reviews/'))
}

function main() {
  const problems = []
  const files = inScopeFiles()
  // 门禁自己失效（目录改名 / 递归 API 变了 / 排除规则写宽了）时必须报红，而不是"零违规通过"。
  if (files.length < 15) {
    problems.push(`范围内只找到 ${files.length} 个 Markdown 文件，扫描面像失效了（全仓 .md 减去 CHANGELOG 与 reviews/ 应有 15 个以上）：${files.join(', ')}`)
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

/**
 * 是否在**直接运行**本文件（而不是被 import）。
 *
 * 不能直接比字符串：Node 的 ESM 加载器把入口模块解析成 **realpath**，而 `process.argv[1]`
 * 保留调用时的路径。工作目录是符号链接 / junction 时（Windows junction、macOS `/tmp` →
 * `/private/tmp`、Linux 软链工作区）两者**不等** → `main()` 被静默跳过 → **无输出、退出码 0**，
 * 于是 `npm run check` / pre-commit / CI 全绿，而这道门禁一次都没跑——正是本文件开头写的
 * 「门禁自己悄悄失效是最坏的假绿」。评审 Lens 1 用 junction 实测复现过。
 * 用 realpath 归一后再比；取不到 realpath 时按"不是入口"处理（宁可静默也不抛）。
 * @returns {boolean}
 */
function isEntryPoint() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// 被 import 时只暴露 findLineRefs，不产生副作用（测试要能单独调用它）。
if (isEntryPoint()) main()