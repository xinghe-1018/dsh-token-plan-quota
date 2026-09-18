# Tasks: 发布面链接一致性

**Input**: `plan.md` · **Spec**: `spec.md` · **Branch**: `002-publish-surface-links`

## Phase 1 — 修链接

- [x] **T001** 从 `package.json.repository` 取仓库 URL（不手打），把 `README.md` 与 `README.en.md` 里
      5 个目标的相对链接改为绝对 `https://github.com/<owner>/<repo>/blob/main/<path>`：
      `ROADMAP.md`、`scripts/shots/README.md`、`SECURITY.md`、`CONTRIBUTING.md`、`RELEASE.md`
- [x] **T002** 复核：两份 README 的违规相对链接数 = 0（SC-001）；同义链接形态一致（FR-005）

## Phase 2 — 加防线

- [x] **T003** `scripts/check-docs.mjs` 新增检查：README（中英两份）的每个**相对链接**，其目标必须被
      `package.json#files` 覆盖（目录条目展开为其下所有文件）；放行 `^https?:` / `^mailto:` / `^#`；
      排除图片引用（交给第 10 项）；报错格式 `文件 的链接目标不随包发布：<link>`
- [x] **T004** SC-002 证伪：用**修复前的** `files` 组合跑新检查逻辑，必须报红并指名 5 条
      （证明它不是"永远通过"的装饰检查）

## Phase 3 — 验收（可证伪性实测：还原修复前 README 后 check-docs exit=1，逐条指名 10 处违规）

- [x] **T005** `npm run check` 全绿；`npm pack --dry-run` 仍 **24 files**（FR-004 / SC-003）
- [x] **T006** 一个提交：`fix(docs): README 不再链接到不随包发布的文件，并加发布面检查`

## 依赖

`T002` 依赖 `T001`；`T004` 依赖 `T003`；`T005` 依赖 `T001`–`T004`；`T006` 依赖 `T005` 全绿。

## 实现策略

两个文件、一个提交，不并行。**不新增 host/client 用例**（不涉及插件运行时行为），
但 T004 是硬要求——新增的检查必须被证明**能失败**。

## 备注

- 新装技能在本轮的适用性（实测记录）：
  - `verification-before-completion` → **直接适用**：本轮完成声称前用它核"证据是否来自最后一次编辑之后"。
  - `constraint-driven-development` → **部分适用**：它的"盯 diff 是否偷偷降低质量底线"这一半适用
    （本项目的质量底线已写在宪法与 `workflow/REVIEW-CHECKLIST.md`，不需要再造 CONSTRAINTS.md）。
  - `dependency-verification` → **不适用**：本轮不新增依赖（顺带确认：`package.json` 仍无 `dependencies`）。
  - `retro` → **模型侧不可调用**（`disable-model-invocation: true`），只能用户敲 `/retro`。
- 引用位置一律用章节锚点/文件名，不写行号（上一轮的教训）。

## Phase 4 — 评审发现的修正（2026-09-18）

- [x] **T007** 重写 4b 检查（Lens 1 的 8 条 + Lens 2 的 F1/F2）：覆盖 title / 引用式 / HTML / 图片；剥代码围栏与行内代码；posix 归一；按 npm 实际发布面判定；缺失或含否定项时出声跳过
- [x] **T008** 行为矩阵 13/13 符合预期（含两条 lens 各自点名的反例）
- [x] **T009** 可证伪性再验：还原 `5921a07^` → 10 条红 / EXIT=1；还原后门禁全绿
- [x] **T010** 修正计划里那句不实描述（「沿用第 4 项正则」）
