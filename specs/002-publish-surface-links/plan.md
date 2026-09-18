# Plan: 发布面链接一致性

**Branch**: `002-publish-surface-links` · **Spec**: `spec.md` · **Created**: 2026-09-18

## 1. Problem

README 里有 5 个相对链接指向**不随包发布**的文件。仓库里读没问题、GitHub 上读没问题、
**npm 包页上全 404**——本地完全看不出来的那类坑。而且现有门禁结构性地管不到它：
`check-docs.mjs` 第 4 项只断言"链接目标在仓库内存在"（第 4 项里 `existsSync(join(root, link))` 那一段），
对"是否随包发布"零校验。

## 2. Non-goals

- 本次**不会**把这 5 个文件加进 `package.json#files`（见 §4 取舍）。
- 本次**不会**改 `README.md` / `README.en.md` 的正文、章节结构或任何已发布文件的内容（只改链接写法）。
- 本次**不会**动 `docs/`、`lib/`、`test/`、`scripts/shots/`、`.specify/`。
- 本次**不会**把检查扩成"全仓 markdown 链接巡检"（只覆盖 README 中英两份——那才是 npm 会渲染的面）。
- 本次**不会**改版本号或 CHANGELOG（非发布动作）。

## 3. Premises

| # | 前提 | 怎么核 | 结论 |
|---|---|---|---|
| 1 | README 存在指向非发布文件的相对链接 | node 脚本：抽 `](…)` 相对链接 vs `files` 求差集 | ✅ **5 个**：`ROADMAP.md`、`scripts/shots/README.md`、`SECURITY.md`、`CONTRIBUTING.md`、`RELEASE.md` |
| 2 | 这 5 个文件在仓库内**存在**（所以第 4 项检查放行） | 同一脚本 `existsSync` 全为 true | ✅ |
| 3 | 现有检查**不查发布面** | 读 `check-docs.mjs` 第 4 项：只有 `existsSync(join(root, link))` | ✅（结构性盲区成立） |
| 4 | 当前包内容 = 24 files，且不含这 5 个 | `npm pack --dry-run` | ✅ 24 files |
| 5 | README 相对链接去重后共 23 个 | 同一脚本 | ✅ |
| 6 | 相对链接与图片引用是两条独立检查路径（且都不查发布面） | 第 4 项只查链接存在、图片断言只查存在/张数 | ✅ |
| 7 | 中英 README 都要处理 | `check-docs` 对两份都做一致性校验 | ✅ |

## 4. Approach

### Considered alternatives

| 方案 | 代价 | 结论 |
|---|---|---|
| A. 把 5 个文件都加进 `files` | 包从 24 → 29 files；把**开发者向**文档（发布流程、截图流水线说明）发给 npm 读者；将来每加一篇内部文档都要重复决策 | 不选 |
| B. **非发布目标改绝对 GitHub 链接** + 新增"相对链接必须随包发布"的检查 | 硬编码仓库 URL（若仓库迁移需改）；换来包不增重、两个渲染面都可点通、且该类问题从此有门禁 | **选它** |
| C. 只加检查不改链接 | 检查立刻报红，等于没修 | 不选 |

### Chosen approach and why

选 B。判据是**读者面**：npm 读者需要的是"能点开"，而不是"包里多一份贡献指南"。
链接改绝对后，GitHub 面与 npm 面同时可点，包保持 24 files；新增的检查让这一类
"仓库内存在但不随包发布"的链接**不可能再悄悄上线**。

## 5. Design

| 文件 | 改动 |
|---|---|
| `README.md` / `README.en.md` | 5 个目标的相对链接 → 绝对 `https://github.com/xinghe-1018/dsh-token-plan-quota/blob/main/<path>` |
| `scripts/check-docs.mjs` | 新增一项：抽 README 相对链接 → 断言被 `package.json#files` 覆盖（目录条目按其下所有文件展开）；报错格式 `文件 的链接目标不随包发布：<link>` |

复用：`files` 的读取本次新写（现有脚本没有发布面概念）；发布面按 **npm 实际会带的文件**算（`files` ∪ package.json / README* / LICENSE* / main），不是 `files` 字面值。
**实现修正（评审驱动，2026-09-18）**：初版计划写的是「链接抽取沿用第 4 项的正则」，实际写成了另一条更严的正则，而且两者都漏掉带 title 的链接、引用式链接、HTML `<a href>`——Lens 1/2 各自实测这三种在初版下 CI 全绿。另有 6 处误报/漏报：`package.json` 其实随包发布（假红）、`docs/../x` 绕过目录前缀、`?query` 与 `<x>` 报出脏目标名、代码围栏里的示例被误报、未发布图片漏检、`files` 缺失时一边「跳过」一边报红。现版本：覆盖四种写法 + 剥代码围栏与行内代码 + posix 归一 + 按 npm 实际发布面判定 + 缺失/否定项出声跳过；13 种写法的行为矩阵全过，可证伪性在还原 `5921a07^` 时给出 10 条红 / EXIT=1。

## 6. Failure modes

- **检查写成永远通过**（FR-003）：必须用"修复前的 README + 修复前的 files"组合验证它报红。
- **绝对链接写错仓库名/分支**：从 `package.json.repository` 读，不手打。
- **只改了中文 README**：两份都要改，并且新检查对两份都跑（FR-005）。
- **正则把锚点/绝对链接当相对链接**：显式放行 `^https?:`、`^mailto:`、`^#`。
- **误伤图片引用**：图片行 `![…](…)` 也会被 `](…)` 正则命中 → 需排除以 `![` 开头的匹配，或对图片另走第 10 项。
- **包内容意外增长**：改完必须 `npm pack --dry-run` 复验 24 files（FR-004 / SC-003）。

## 7. UI states

本次无 UI 改动 → 本节删除（模板允许）。相关的视觉面只有"README 在 npm 包页的渲染"，属功能 QA 范畴。

## 8. Test plan

| 层次 | 内容 | 命令 |
|---|---|---|
| 可证伪性（SC-002） | 用修复前的 `files` + README 组合跑新检查，必须报红并指名 5 条 | 临时脚本/参数化跑一遍 |
| 机械门（SC-003） | 五项检查 + 用例全绿 | `npm run check` |
| 发布面（FR-004） | 包内容仍 24 files，且 README 不再有违规相对链接 | `npm pack --dry-run`；差集脚本 |
| 一致性（FR-005） | 中英 README 同义链接形态一致 | 差集脚本对两份都跑 |

不新增 host/client 用例（本次不涉及插件运行时行为）；但**必须**证明新检查可失败（SC-002），
否则它只是装饰。

## 9. Steps

1. [ ] 从 `package.json.repository` 取仓库 URL；把 README 中英两份的 5 个目标改成绝对链接
2. [ ] `scripts/check-docs.mjs` 新增"相对链接必须随包发布"检查
3. [ ] SC-002 证伪：用修复前的 files 组合跑新检查，确认报红
4. [ ] `npm run check` 全绿 + `npm pack --dry-run` 仍 24 files
5. [ ] 一个提交

## 10. Retro

<!-- 发货后填。每条结论只落两个地方：AGENTS.md（反复出现的误解）或 workflow/PLAN.md（反复出现的盲点）。 -->

- **错误的前提**：0 条（§3 的 7 条前提全部成立）。但有 **1 条表述不实**：计划写「链接抽取沿用第 4 项的正则」，
  实际写成另一条更严的正则——这不是前提错，而是**计划描述与实现漂移**，已按「计划修正」处理并在 §5 记录。
- **计划里缺的**：
  1. 没预见「**发布面 ≠ `files` 字面值**」：`npm pack` 恒带 package.json / README* / LICENSE* / main，初版因此对 `[a](package.json)` 假红。
  2. 没预见链接有多种写法（带 title、引用式、HTML、徽标式）——初版只认内联 `](x)`，漏检面因此存在。
  3. 没预见「**我写的检查本身也需要被审查**」：把它当成工具，忘了它也会撒谎。
- **agent 反复误解的**：
  1. **把「我用了一个正则」当成「我覆盖了这种语法」**——本轮最贵的误解：初版 13 种写法里 7 种行为错误，
     却给出「CI 全绿」的假安全感。修法不是更小心，而是**给检查本身做行为矩阵 + 证明它能失败**。
  2. 把代码围栏里的示例当成真链接（初版误报）。
- **落点**（已应用）：
  - `workflow/REVIEW-CHECKLIST.md` Lens 1：+1 项——本次是否新增/修改机械检查？若是，给它做行为矩阵并证明其**能失败**。
  - `workflow/PLAN.md` §8：+1 行——新增/修改检查时，测试计划必须含该检查的行为矩阵与可证伪性。
  - `AGENTS.md` Conventions：+1 行——机械检查也是代码，改它要像改代码一样评审。
  - 未落（后续候选，非本次范围）：`check-docs` 第 4 项 `existsSync(join(root, link))` 可探测仓库外路径。
- 计划里缺的：
- agent 反复误解的：
- 落点：