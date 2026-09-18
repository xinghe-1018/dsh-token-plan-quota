# workflow — 本项目的工程循环

这一层来自 [clarity-digital-development/tworkflow](https://github.com/clarity-digital-development/tworkflow)（MIT，
"Structured Agentic Development"）：**Context → Plan → Implement → Review → QA → Ship → Retro**。

它**不替代** `.specify/`（Spec Kit），两者分工：

| | 负责 | 落点 |
|---|---|---|
| Spec Kit（`.specify/`） | 把需求变规格、规格变计划、计划变任务、任务变代码 | `specs/<编号>-<slug>/`、`.specify/memory/constitution.md` |
| workflow（本目录） | Spec Kit **没有**的三件事：三 lens 评审清单、视觉 QA、Retro 回写；以及贯穿全程的上下文预算 | `workflow/*.md` |

`AGENTS.md` 是驱动文件（DSH 每个会话自动加载），本目录是被它引用的工件模板。

## 一、相位与工件

每个相位的契约都一样：**消费上一相位写下的工件 → 产出下一相位的工件 → 人读过才进下一步**。
没有工件 = 那一步没发生（"我审过了"而没有写下来，不算审）。

| 相位 | 谁做 | 工件 | 门（人做什么） |
|---|---|---|---|
| **Context** | 已经就位 | `AGENTS.md`（一页）+ `.specify/memory/constitution.md` | 行为变了就同 PR 改 |
| **Plan** | `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` | `specs/<编号>-<slug>/{spec,plan,tasks}.md`，结构见 `PLAN.md` | **读一遍**；非目标 / 前提 / 选型三处必须自己看 |
| **Implement** | `/speckit-implement` | 每计划步骤一个 commit | 看 diff 的**文件清单**再看内容 |
| **Review** | `/speckit-analyze` + `REVIEW-CHECKLIST.md` 三 lens | 三份独立报告 | 人读报告；无场景的发现降级 |
| **QA** | 功能 QA + 视觉 QA（造图机） | `QA-REPORT.md` 填好 | 看截图；口径错了打回 |
| **Ship** | `scripts/release.mjs` / RELEASE.md | PR（链接 plan / review / QA） | 确认后再 push |
| **Retro** | 发货后五分钟 | 计划文档的 Retro 段 | 决定落 `AGENTS.md` 还是 `workflow/PLAN.md` |

分档（Spec Kit 的完整流程对小改动是负担，本项目沿用 tworkflow 的判断）：

- **错别字 / 文案 / 依赖升级** → 不走流程。
- **单文件修复** → 提示词里一段话计划：改什么、什么能证明它 work。
- **多文件 / 行为变更 / 新功能 / 数据迁移** → 完整流程。
- **分不清属于哪档时，这份不确定本身就是信号**：按重的那档走。

## 二、两条横切

### 1. 上下文预算（40% 规则）

窗口在**填满之前很久**质量就开始退化——忘记一小时前说过的约束、重读已读文件、和自己先前的决定矛盾，而且**没有错误提示**。
规则：**占用过 40% 就在下一个干净边界（计划步骤结束 / 相位结束 / 提交之后）主动重置**，别等工具逼你压缩。

- 重置前先写 `SESSION-HANDOFF.md`（30 秒：当前步骤、本会话做的决定、下一步、未解问题）。
- 判据：**如果计划文档 + handoff 写清了值得保留的一切，就开新会话**（用工件重新播种优于就地压缩，因为摘要会静默丢约束）。
- 症状驱动、不看百分比：重读已读文件 / 重复问已回答的问题 / 与同会话早先决定矛盾 / 忘掉 `AGENTS.md` 里的约束 / 下一步偏离计划文档——**短时间内出现两条就该重置**。
- 省着花：探索类问题丢给 `subagent`（它烧自己的上下文，只回一行答案）；读文件指到函数不指到整个目录；能引用就别粘贴。

### 2. 失败模式（agent 的固定翻车方式 → 本项目的接住机制）

| 失败模式 | 长什么样 | 本项目接住它的机制 |
|---|---|---|
| 范围蔓延 | "顺手也重构了…" | 计划里的**非目标**段 + 看 diff 文件清单 |
| 错误前提 | 计划假设上游返回了某个字段 | `PLAN.md` 的**前提逐条核验（✅/❌）**；本项目的前提包含信封路径 / 单位 / 方向 |
| 幻觉 API / 包名 | 调用不存在的方法，或装了拼写相似的假包（slopsquatting） | `npm run check` + **零依赖是宪法级**（要加依赖先改宪法）；上游字段以 `docs/upstream-contracts.md` 为准 |
| 测试作弊 | 断言被弱化、测试被跳过、"修好了测试" | Lens 1 的**测试完整性**项：diff 测试本身 + "功能坏了它还会过吗" |
| 自我评审偏见 | 实现者给自己签字 | 三 lens 各自**新鲜上下文**（`subagent`）、只读、只产报告 |
| 过度自信的"完成" | "测试通过"但没跑过 | 完成定义要求**最后一次编辑之后**的输出；没有证据就"跑一遍给我看" |
| 上下文腐烂 | 忘了约束、重读文件 | 40% 规则 + handoff |
| 重复代码 | 新 helper 其实三处之外早就有 | Lens 3 的 **reuse check** |
| 失控会话 | 三次失败叠成第四次 | 同一步骤三次失败就停：回滚到最后好的 commit，带学到的东西重新提示 |
| 权限脚枪 | 自动批准进了凭据或破坏性命令 | 本仓库 `.env*` / 凭据是 **Do not touch**（宪法 II） |

## 三、为什么不放在 `docs/` 下

`package.json#files` 显式列了 `docs`，**显式 allowlist 会压过 `.gitignore`**——放进 `docs/` 就会把内部工程模板和中间产物一起打进 npm 包。
本目录不在 `files` 里，所以 **`npm pack` 的文件表与本目录的存在无关**（可自行 `npm pack --dry-run` 核对）。

## 四、维护

- 本目录与 `AGENTS.md` 同一次改动里更新——它们描述的行为变了却不改，评审 Lens 3 会当发现处理。
- Retro 的结论只落两个地方：反复出现的**误解** → `AGENTS.md` 加一行；反复出现的**盲点** → `PLAN.md` 加一行。
- 本机 / 本仓库的**环境事实**（远端 SSH 别名、tag 与浅克隆、出图机前置、pwsh 写文件会加 BOM）记在
  [`ENVIRONMENT.md`](ENVIRONMENT.md)，不往 `AGENTS.md` 里堆——后者每个会话都占上下文，而这类事实只在
  「取远端 / 出图 / 写文件」几个分支上才需要。
- 想把这套变成宪法级约束（让"必须核验前提""必须三 lens"不可绕过）需要 bump `.specify/memory/constitution.md` 的版本——目前没做，说了再做。