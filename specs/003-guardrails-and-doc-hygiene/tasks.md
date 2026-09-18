# 003 — 任务

> 每步一个 commit；每步结束后工作树必须干净。引用位置一律用锚点或符号名，不写行号（本规格 FR-003 自我适用）。

- [ ] **T001** FR-001 误报消除：`scripts/shots/fixture.mjs` 的痕迹守卫改逐叶扫描 + 时钟整数豁免。
  同 commit 附行为矩阵实测输出（T1 的 7 个用例）与可证伪证据（`HEAD` 版本在冲突时刻必抛错）。
- [ ] **T002** FR-001 回归隔离：证明固定 `now` 下 `makeSnapshot()` 输出逐字节未变（T6）。
  （可与 T001 同 commit——它是同一改动的证据，不是独立改动。）
- [ ] **T003** FR-002 单源化：`scripts/check-docs.mjs` 抽出 `extractLinkTargets()`，第 4 项与 4b 共用；
  行为矩阵 T2 的 6 行 × 2 消费者。
- [ ] **T004** FR-003 新门禁：`scripts/check-refs.mjs`（行号引用），带 T3 的行为矩阵与可证伪证据。
- [ ] **T005** FR-003 接线：`package.json#scripts.check` **与** `.github/workflows/ci.yml` 同时加进去
  （只接一处 = 未接线的检查，retro 明确算发现）。
- [ ] **T006** FR-003 存量：修门禁范围内的引用形态（`ROADMAP.md`、`specs/001-…/plan|qa-report|tasks.md`）。
  只换形态不改结论。**不碰** `reviews/` 与 `CHANGELOG.md`。
- [ ] **T007** FR-004 提交门禁：`.githooks/pre-commit` + `CONTRIBUTING.md` 启用说明（默认不启用）。
- [ ] **T008** FR-005 规则单源化：删 `AGENTS.md` 里的机械检查规则副本；确认 `AGENTS.md` 仍在一页以内。
- [ ] **T009** FR-006 环境事实：新增 `workflow/ENVIRONMENT.md`；`workflow/README.md` 指向它；
  全局 `$DSH_HOME/AGENTS.md` 补两条本机事实（PowerShell 引号、GitHub 取数通道）。
- [ ] **T010** 验证与收口：T1–T7 跑齐（含 `npm run check` 连跑 30 次无假红）→ 三 lens 评审 → QA 报告 → 汇报。

## 备注

- **接线必须在同一批**：T004 的门禁若只进 `npm run check` 而不进 `ci.yml`，等同于没接线。
- **merge 顺序不再受限**：001→002 的顺序约束来自"002 由 001 切出"。本规格由 002 切出，
  三条分支都还没 push，因此按一个 PR 从本分支尖端合入时该约束自动消解（原记录留在 `specs/002/tasks.md`）。