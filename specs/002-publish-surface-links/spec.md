# Feature Specification: 发布面链接一致性

**Feature Branch**: `002-publish-surface-links`

**Created**: 2026-09-18

**Status**: Draft

**Input**: User description: "修复 README 链接到不在发布白名单内的文件，并加一道防复发的检查"

## User Story 1 - npm 包页的 README 链接不再死链 (Priority: P1)

用户从 npm 装这个插件，在包页读 README，点其中的 `CONTRIBUTING.md` / `SECURITY.md` / `RELEASE.md` /
`ROADMAP.md` / `scripts/shots/README.md` 链接——**全部 404**。原因：这些文件不在 `package.json#files`
白名单里，而包页只渲染包内文件。仓库里读同一份 README 一切正常，**本地和 GitHub 都看不出来**。

**Why this priority**: 对外可用性问题，且属于本项目已经踩过并写进 `RELEASE.md` 的同一类坑
（"漏 `docs` 会让包页文档图全断，本地完全看不出来"）。

**Independent Test**: `npm pack --dry-run` 的文件表 与 README 相对链接集合求差集，差集必须为空。

**Acceptance Scenarios**:

1. **Given** 修复后的 README，**When** 取出所有相对链接并对照 `files` 白名单，**Then** 每个相对链接的目标都在包内
2. **Given** 一条指向"仓库内存在但不随包发布"的文件的相对链接，**When** 我把它写回 README，**Then** 新检查报红

### Edge Cases

- 绝对链接（`https://…`）、锚点（`#…`）、`mailto:` 不算相对链接，必须放行。
- 目录型白名单条目（如 `docs`）应覆盖其下所有文件（`docs/x.md` 视为已发布）。
- 图片引用（`![…](docs/images/…)`）由第 4 / 第 10 项各自覆盖，本次不重复处理。
- 中英两份 README 都要处理。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `README.md` 与 `README.en.md` 中，**不随包发布**的目标 MUST 用绝对链接（指向 GitHub）
- **FR-002**: `scripts/check-docs.mjs` MUST 新增机械检查：README 的每个相对链接**与图片目标**必须被 `package.json#files` 覆盖；MUST 覆盖内联、带 title、引用式、HTML 四种写法，并剥除代码围栏与行内代码里的示例；发布面按 npm 实际会带的文件算（`files` ∪ package.json / README* / LICENSE* / main）
- **FR-003**: 新检查 MUST 可证伪——在"修复前的 README + 修复前的 files"组合下必须报红
- **FR-004**: 本次改动 MUST NOT 增加包内容（`npm pack --dry-run` 仍为 24 files）
- **FR-005**: 中英 README 的同义链接 MUST 形态一致
- **FR-006**: 新检查的输出 MUST 指名到 `文件:链接`

### Key Entities

- **发布面（publish surface）**：`package.json#files` 列出（含目录展开）的文件集合。
- **相对链接（relative link）**：README 中不以 `http`/`mailto`/`#` 开头的 markdown 链接目标。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: README（中英）中指向非发布文件的相对链接数 = **0**
- **SC-002**: 把一条违规相对链接写回 README 后，`npm run check` 报红并指名该链接
- **SC-003**: `npm run check` 全绿；`npm pack --dry-run` 仍为 24 files
- **SC-004**: 修复不改变任何已发布文件的内容（只改 README 链接写法 + 新增检查）

## Assumptions

- 这 5 个目标都是**开发者向**文档（贡献指南、发布流程、路线图、截图流水线说明、安全策略），
  对 npm 读者的价值低于"链接可点通"；因此选改绝对链接，而不是把它们都塞进包。
- 若将来某个文档对 npm 读者是必需的，应把它加进 `files`，而不是放宽检查。
- npm 包页只渲染包内文件（`RELEASE.md` 已有同类实证），本次以该机制为前提。