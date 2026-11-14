# TASKS — 010

| # | 任务 | 面 | 依赖 | 状态 |
|---|---|---|---|---|
| T001 | `resolveMonthRange` + `aggregateUsageRange` 月份分支 | lib/usage-stats.js | — | ✅ |
| T002 | `/usage` 与 `/usage-official` 解析 `month`、400 固定码、工具入参 | lib/index.js | T001 | ✅ |
| T003 | 宿主测试：SC-001/002/003/006 + 月份校验矩阵 | test/host.mjs | T002 | ✅ |
| T004 | 月份 UI（chip + 月份框 + 查询 + 行内提示 + 标题 + store） | lib/client.js | T002 | ✅ |
| T005 | 客户端测试：SC-004/005 + 请求 URL + 标题 + 降级 | test/client.mjs | T004 | ✅ |
| T006 | 文档：两版 README、CHANGELOG、check-docs 截图清单 | 文档 | T002,T004 | ✅ |
| T007 | 截图：月度中英各一张 + 造图机夹具 | scripts/shots | T004 | ✅ |
| T008 | 静态门禁：guards 月份矩阵、路由/文案无 % 与 Credits | test/guards.mjs | T002,T004 | ✅ |

## 提交计划（一个提交一件事）

1. `feat(usage): 支持按自然月查询用量（宿主与纯函数层）`
2. `feat(usage): 屏内按月份查询`
3. `test(usage): 月份查询的边界与同源断言`
4. `docs(usage): 月份查询说明与截图`
