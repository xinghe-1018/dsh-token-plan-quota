# Plan: ROADMAP 与代码事实对账

**Branch**: `001-roadmap-reconcile` · **Spec**: `spec.md` · **Created**: 2026-09-18

## 1. Problem

`ROADMAP.md` 写于 v0.2，其"阶段状态"与"版本计划"已与代码和发布事实脱节：

- ②阶段（自动检测）标为待做，实际已是默认行为；
- ①阶段要"适配更多平台"，实际 A 档两家已落地、B/C 档按决策不做，文档没体现这个二分；
- 顶部版本计划写 `0.3.0 → 0.4.0 → 1.0.0`，实际已在 **0.4.8** 并打了 `v0.4.8` tag。

后果不是"文档旧"，而是**读者会据此做错决定**（重做一个已完成的能力，或误判项目停滞）。

## 2. Non-goals

- 本次**不会**改任何代码（`lib/`、`test/`、`scripts/` 一行不动）。
- 本次**不会**改 `README.md` / `README.en.md` / `CHANGELOG.md` / `package.json` / 版本号。
- 本次**不会**补齐任何未实现能力（B/C 档平台仍按"明确不做的三类"不做）。
- 本次**不会**重写 ROADMAP 的历史推理段（§0.1、§1.1 端点表、§1.1.1 陷阱表、§4 决策记录——那是本项目最贵的资产）。
- 本次**不会**动 `.specify/`（Spec Kit 自己的模板与管理文件）。
- 本次**不会**改变 npm 包内容（ROADMAP 不在 `files` 里，已核验）。

## 3. Premises

| # | 前提 | 怎么核 | 结论 |
|---|---|---|---|
| 1 | ②阶段已落地 | grep `autoDetect` → 11 处；`autoDetect: true` @`lib/index.js:44`；`applyAutoDetect()` @`:1189`；调用 @`:2245` | ✅ |
| 2 | ①阶段 A 档已落地 | 列出 `PRESETS` 得 8 个键，含 `moonshot-balance`、`openrouter-credits`（§0 原记 6 个） | ✅ |
| 3 | 版本计划与事实冲突 | `package.json` = `0.4.8`；`git tag` 到 `v0.4.8`；CHANGELOG 有 `[0.4.8]` 与 `[Unreleased]`；文档写 0.3/0.4/1.0 | ✅（冲突成立） |
| 4 | `ROADMAP.md` 不在发布白名单 | `package.json#files` 里没有 ROADMAP | ✅ |
| 5 | ~~门禁不看 ROADMAP 内容~~ | ❌ **修正**：`check-docs.mjs:222` 把 `ROADMAP.md` 纳入**编码护栏**（BOM / U+FFFD / GBK 私用区）→ 改动必须 UTF-8 无 BOM，且必须复跑 `npm run check` | ❌ → 已改设计 |
| 6 | 改 ROADMAP 不影响 README | README.md:48 / README.en.md:52 是**链接引用**；`check-docs` 第 4 项只查链接目标存在，本次不动链接行 | ✅（实现后复验） |
| 7 | C/B 档"不做"的记录位置 | README「明确不做的三类」（L344 起） | ✅ |
| 8 | `specs/` 不进包 | `files` 里没有 `specs` | ✅ |

**前提 5 是本轮核验的主要产出**：原假设"门禁不看 ROADMAP"为假，它被编码护栏覆盖；
于是实现步骤里多了一条硬要求（保持 UTF-8 无 BOM）与一条验收（复跑门禁）。

## 4. Approach

### Considered alternatives

| 方案 | 代价 | 结论 |
|---|---|---|
| A. 全文重写 ROADMAP，只留未做项 | 丢掉历史推理与决策记录（本项目最贵的资产）；大 diff 难评审 | 不选 |
| B. **就地加状态标记 + 顶部状态指针**（保留全部历史，只补事实） | diff 小；但"历史文本 + 新状态行"并存，需要读者注意状态行优先 | **选它** |
| C. 只加一行"进度以 CHANGELOG 为准" | 没解决核心问题：读者仍要自己翻 CHANGELOG 才能判断①②状态 | 不选 |

### Chosen approach and why

选 B。它的最小改动集是**五处插入/替换**：顶部状态指针、顶部版本计划行、①②③三个阶段的标题下各一行状态。
理由：本次的目标是"读者不被误导"，而误导的根源是**状态与版本**两处；历史推理段没有误导性，删它只会损失信息。

## 5. Design

改动全部落在 `ROADMAP.md` 一个文件：

| 位置 | 改动 | 依据（FR-002 要求可 grep） |
|---|---|---|
| L1–L7 顶部 | 插入状态指针段；版本计划行改为与事实一致 | `package.json` 0.4.8 / `git tag v0.4.8` / CHANGELOG |
| §1 标题下（L48） | 一行状态：**部分完成**（A 档已落地，B/C 档按决策不做） | `PRESETS` 含 `moonshot-balance` / `openrouter-credits`；README「明确不做的三类」 |
| §2 标题下（L165） | 一行状态：**已完成** | `lib/index.js:44` `autoDetect: true`、`:1189` `applyAutoDetect()`、`:2245` 调用点 |
| §3 标题下（L257） | 一行状态：**已开源发布**（0.4.8 / tag v0.4.8），本文原定的 `1.0.0` 尚未 | CHANGELOG `[0.4.8]`；`npm pack --dry-run` 24 files |

**复用检查**：README「明确不做的三类」已有该决策的权威表述 → 本次只**引用**，不另写一份，避免两处漂移。

## 6. Failure modes

- **编码损坏**（前提 5）：写入若带 BOM 或乱码 → `check-docs` 第 9 项红灯。对策：改后立刻复跑 `npm run check`。
- **过度声称**：把①写成"已完成"不准确（B/C 档按决策不做）→ 必须写"部分完成"并指向不做记录（FR-004）。
- **不可核验断言**：每条状态都必须带可 grep 的位置（FR-002 / SC-001）。
- **与 README 冲突**：实现时对照 README L344 起的表述逐条对齐。
- **范围蔓延**：只动状态与版本计划两处；历史推理段一行不删。
- **链接破坏**：不动 README 的链接行（前提 6）。

## 7. UI states

本次无 UI 改动 → 本节删除（模板允许）。

## 8. Test plan

| 层次 | 内容 | 命令 |
|---|---|---|
| 机械门 | 编码护栏 + 三项检查全绿 | `npm run check` |
| 可核验性（SC-001） | 文档每条"已落地"按文中位置 grep，要求 100% 命中 | `Select-String lib/index.js -Pattern 'autoDetect'`；列 `PRESETS` |
| 一致性（SC-004） | 文档版本计划 vs `package.json` / CHANGELOG / tag | 三条命令各取一次版本，人工对齐 |
| 不回归 | host/client 用例数不变且全绿（本次不改代码，属旁证） | `npm run check` 内含 |

不新增自动化用例：本次是纯文档改动，没有可断言的代码行为（Spec Kit 要求在计划阶段说明这点）。

## 9. Steps

**一个提交**（本项目 CONTRIBUTING："一个提交只做一件事"；五处插入同属"对账"这一件事，
拆成五个提交会制造五个没有独立意义的中间态。tworkflow 的"每步一提交"针对**代码**步骤，这里不适用）。

1. [ ] 顶部：插入状态指针段，修正版本计划行
2. [ ] §1 标题下加状态行（部分完成 + A 档依据 + 不做记录位置）
3. [ ] §2 标题下加状态行（已完成 + 三处代码位置）
4. [ ] §3 标题下加状态行（已开源发布 + 1.0.0 尚未）
5. [ ] `npm run check` 全绿 + 逐条 grep 复核，然后一个提交

## 10. Retro

<!-- 发货后填。每条结论只落两个地方：AGENTS.md（反复出现的误解）或 workflow/PLAN.md（反复出现的盲点）。 -->

- 错误的前提：
- 计划里缺的：
- agent 反复误解的：
- 落点：