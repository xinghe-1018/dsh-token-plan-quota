# Feature Specification: ROADMAP 与代码事实对账

**Feature Branch**: `001-roadmap-reconcile`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "把 ROADMAP.md 与代码事实对账：②阶段已落地、版本计划与实际发布脱节"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 读者不再被过时规划误导 (Priority: P1)

贡献者（或三个月后的维护者）打开 `ROADMAP.md` 想知道"到哪一步了、下一步做什么"。今天他会读到
"②阶段：零配置自动检测（待做）"，而代码里 `autoDetect` 早已是默认行为——他可能据此重做一个
已完成的能力，或判断项目停滞。

**Why this priority**: 这是对外承诺的可信度问题（宪法原则 V：描述与实现的距离就是这个项目的可信度）。
误导性文档的代价是别人的时间。

**Independent Test**: 只读 `ROADMAP.md`、不开代码，能否正确说出①②③三阶段各自的状态。

**Acceptance Scenarios**:

1. **Given** 读者只读 `ROADMAP.md`，**When** 他找"自动检测做完了吗"，**Then** 得到明确结论且文档给出可核验位置（文件 + 函数/字段名）
2. **Given** 读者只读 `ROADMAP.md`，**When** 他找"版本计划"，**Then** 它反映实际发布线（`package.json` / CHANGELOG / git tag），不再写与事实不符的 0.3.0 → 0.4.0 → 1.0.0

### User Story 2 - 阶段状态带可核验依据 (Priority: P2)

文档里每个状态标记都不是"我记得做完了"，而是指向能 grep 到的代码位置或已发布产物。

**Why this priority**: 没有依据的状态标记会再次腐烂；有依据的可以被下一轮对账机械复核。

**Independent Test**: 对文档中每条"已落地"，用文中位置去 grep，全部命中；对每条"未做"，能指出缺失的代码/产物。

**Acceptance Scenarios**:

1. **Given** 文档写着"②阶段已落地"，**When** 按文中位置查 `lib/index.js`，**Then** 找到 `autoDetect: true` 与 `applyAutoDetect()` 定义
2. **Given** 文档写着"①阶段 A 档已落地"，**When** 列出 `PRESETS` 的键，**Then** 找到 `moonshot-balance` 与 `openrouter-credits`

### Edge Cases

- 阶段**部分**完成时（①只做 A 档、B/C 档按决策不做）：文档必须表达"部分完成 + 哪部分不做 + 不做记录在哪"，不能二值化。
- "不做"的决策记录在 README「明确不做的三类」：两处表述必须一致。
- 编码：本文件被 `scripts/check-docs.mjs` 第 9 项编码护栏覆盖（BOM / U+FFFD / GBK 私用区），写入必须 UTF-8 无 BOM。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `ROADMAP.md` 每个阶段（①②③）MUST 带明确状态（已完成 / 部分完成 / 未做）
- **FR-002**: 每条"已完成 / 部分完成"声明 MUST 给出可核验依据（文件 + 可 grep 的标识）
- **FR-003**: 版本计划段 MUST 与 `package.json` 的 `version`、CHANGELOG 的版本段、git tag 一致
- **FR-004**: 与 README「明确不做的三类」相关的不做决策 MUST 两处表述一致
- **FR-005**: 文件 MUST 保持 UTF-8 无 BOM 且无乱码（`check-docs.mjs` 第 9 项）
- **FR-006**: MUST NOT 引入无法核验的断言（如"某能力已完全就绪"而无位置可查）

### Key Entities

- **阶段（Phase）**：①适配更多平台 / ②零配置自动检测 / ③对外发布。属性：状态、依据、未做项及记录位置。
- **依据（Evidence）**：可 grep 的标识（`autoDetect`、`applyAutoDetect`、`moonshot-balance`）或文件位置。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 文档中每条"已落地"声明都能在 30 秒内被 grep 命中（100%）
- **SC-002**: 不了解本仓库的读者只读文档即可正确说出三阶段状态
- **SC-003**: `npm run check` 仍全绿（编码护栏与三项检查不受影响）
- **SC-004**: 版本计划段与 `package.json` / CHANGELOG / tag 零冲突

## Assumptions

- `ROADMAP.md` 不在 `package.json#files` 白名单内（已核验），本次改动不改变 npm 包内容。
- 本次只做文档对账，不补齐任何未实现能力（B/C 档平台按既有决策不做）。
- `specs/` 不进 `package.json#files`（Spec Kit 工件不随包发布）。