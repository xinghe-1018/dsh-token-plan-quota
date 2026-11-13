# TASKS — 007

| # | 任务 | 面 | 依赖 | 状态 |
|---|---|---|---|---|
| T001 | `aggregateUsageRange` 支持 `from/to` + `resolveCustomRange` 校验与周桶铺满 | lib/usage-stats.js | — | ✅ 完成 |
| T002 | `/usage` 解析 `from/to`、400 固定码、`to` 夹到今天 | lib/index.js | T001 | ✅ 完成 |
| T003 | 宿主测试：SC-001/002/003 + 优先级 + 未来端点 | test/host.mjs | T002 | ✅ 完成（665 项） |
| T004 | 自定义区间 UI（日期框 + 查询 + 行内提示 + 标题分支 + 仅统计本机脚注） | lib/client.js | T002 | ✅ 完成 |
| T005 | 客户端测试：SC-004/005 + 标题与请求 URL + 切区间降级 | test/client.mjs | T004 | ✅ 完成（481 项） |
| T006 | 文档：两版 README、CHANGELOG、upstream-contracts | 文档 | T002,T004 | ✅ 完成（upstream-contracts 无新增上游契约，未改） |
| T007 | 截图：自定义区间中英各一张 + check-docs 清单 | scripts/shots | T004 | 🚧 出图中（清单已加） |

## 提交计划（一个提交一件事）

1. `feat(usage): 支持按起止日期查询用量（宿主与纯函数层）`
2. `feat(usage): 屏内自定义日期区间`
3. `test(usage): 自定义区间的边界与同源断言`
4. `docs(usage): 自定义区间说明与截图`
