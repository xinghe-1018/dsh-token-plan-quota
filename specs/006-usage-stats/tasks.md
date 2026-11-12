# 006 — 任务

对应 `spec.md`（需求）与 `plan.md`（做法）。约定：每个任务一个 commit、提交信息中文 Conventional Commits、正文写为什么；
引用位置用标题锚点，不写行号；交付前把勾选状态与 `npm run check` 输出对齐（宪法 VI）。

## 实现

- [x] **T001** FR-001/FR-002：新增 `lib/usage-stats.js` 纯函数层——`dayKey(ms)`（本地日）、`foldUsageEvents(state, events, cut, modelResolver)`、
  `aggregateRange(index, {range, days, now})`、`loadIndex(path)` / `saveIndex(path, index)`（临时文件 + rename 原子写、schema 校验、按 `usageBackfillDays` 修剪）。
  验收：`node -e` 或 host 测试直接调用，三条恒等式（日合计 = 区间合计 = 模型合计）成立；坏 JSON 触发重建而不是抛错。

- [x] **T002** FR-002/FR-011：收集器 `syncUsageIndex(ctx, config)`——`ctx.get("sessionPersistence", false)`；`list()` 逐份、revision 未变跳过、
  变更才 `open(id,"read")`；`cut = handle.inheritedEventCount`，起点 `max(cut, lastSeq+1)`；每 10 份 `setImmediate` 让出；单会话 try/catch 记 `failed`；
  单飞保护与 `updatedAt`。验收：假 persistence 测试覆盖「未变不读、变更只读新片、坏会话不中断、无服务降级」。

- [x] **T003** FR-004/FR-008/FR-009：宿主接线（`lib/index.js`）——DEFAULTS 加 `usageStats` / `usageIndexPath` / `usageBackfillDays`；
  导出 `__internals` 新符号；apply 内 20s 首跑 + 5 分钟定时（timer 需 unref/清理）；路由加 `usage` 子路由（沿用 prefix + `sameOriginOnly`）；
  工具 `action` 枚举加 `usage` 并支持 `days`；`reset` **不清索引**（文档写明边界）。验收：路由形状断言；工具 enum 与文本断言。

- [x] **T004** FR-005/FR-006：`lib/client.js` 新增 `UsageScreen`——注册进宿主 `main` 整页座位（key = `sidebar.panellist` 的 id），
  单实例闩锁 + `ctx.slots.spec("main")` 探测；`exports.inject` 追加 `layout`；
  头部（标题 / 天数选择 预设+自定义 1..365 / 2D·3D 切换 / 关闭）、总分卡、图表（SVG；2D 矩形柱、3D 等轴三面、共用同一比例函数）、
  模型列表（绝对 token，无百分数）、数据源脚注；四状态（加载/回填中/空/错误）；徽标小窗底部快捷入口。
  验收：client 测试断言四状态、两模式逐桶等比、天数参数、`close → selectPanel(null)`、无 `%` 与 `Credits`（脚注白名单除外）。

- [x] **T005** FR-011：测试补齐——`test/host.mjs`（fold/幂等/增量/聚合/路由/降级/时区边界）、`test/client.mjs`（四状态/文案/切换请求）、
  `test/guards.mjs`（索引 schema 白名单 + 无百分比静态矩阵，两端都断言）；另加座位断言（main key == panellist id、store 形状、缺座位不注册）与桶粒度边界（62/63/365）。验收：三套件项数更新并全绿。

- [x] **T006** FR-010：文档与门禁同轮——README 中英（功能段、配置表 +3 行、路由表 +1 行、DEFAULTS 计数、三套测试项数）、`CHANGELOG.md`、
  `docs/upstream-contracts.md` 新增「会话事件 → 用量」契约（标注属本实例实测、非上游接口）、`scripts/shots/make-shots.mjs` 生成统计屏截图（zh/en；2D 与 3D 各一张）、
  `check-docs.mjs` 的 SCREENSHOTS 硬编码清单与 requiredImageRefs 同步。验收：check-docs 全绿；删掉新截图必红（可证伪）。

- [x] **T007** QA——本机实跑首轮回填记录耗时（对照 SC-003）、Edge 无头截图核对 375/768/1440 三档、
  逐条走 `workflow/QA-REPORT.md`（功能段 + 视觉段）；最后一次编辑后跑 `npm run check` 并贴输出。

### 提交对账

| 提交 | 覆盖任务 | 状态 |
|------|----------|------|
| `feat(usage): 折叠会话事件为按天 token 索引` | T001 T002 | 已做（见下） |
| `feat(usage): 新增用量统计路由与工具动作` | T003 | 已做（见下） |
| `feat(usage): 新增用量统计独立屏` | T004 | 已做（见下） |
| `test(usage): 覆盖折叠、增量与四状态` | T005 | 已做（见下） |
| `docs(usage): 同步 README、契约与截图` | T006 | 已做（见下） |

## 备注

- 依赖顺序：T001 → T002 → T003 → T004 → T005 → T006 → T007；T004 可在 T003 之后并行（前端只依赖接口形状）。
- 评审：`/speckit-analyze` + `workflow/REVIEW-CHECKLIST.md` 三条 lens 分开跑、只读、各出报告；原则 I/II 各核一次（不派生、不落消息内容）。
- 挂载面已核（plan 前提 10）：`main` 整页 + `sidebar.panellist` + `ctx.layout.selectPanel`；`layout` 进 `exports.inject` 是唯一新增硬依赖，README 要写明代价。
- 3D 不引任何三维库：SVG 等轴三面（顶/正/侧），与 2D 共用同一比例函数；测试逐桶断言两模式柱高比例相等，防止视觉夸大。