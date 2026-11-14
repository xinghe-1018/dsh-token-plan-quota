# 013 任务清单

| 编号 | 任务 | 负责人 | 写作用域 | 状态 |
| --- | --- | --- | --- | --- |
| T101 | 滚动视口 DOM：helper + 两个 return 点接入 | client-ui | lib/client.js | ✅ |
| T102 | 滚动视口 CSS（细条、focus 环、overscroll、无 gutter） | client-ui | lib/client.js | ✅ |
| T103 | client 断言：钩子/两态渲染/窄屏无横向溢出 | client-ui | test/client.mjs | ✅ |
| T104 | guards 第 13 节静态矩阵 | lead | test/guards.mjs | ✅ |
| T201 | schema v2 + assertUsageIndexShape 两个新键校验 | host-core | lib/usage-stats.js | ✅ |
| T202 | foldUsageEvents 返回 provider/model、modelDefaults 播种 | host-core | lib/usage-stats.js | ✅ |
| T203 | 增量路径与兜底扫描写回 lastProvider/lastModel | host-core | lib/usage-stats.js | ✅ |
| T204 | host 断言 T201–T205（含 v1 迁移备份、空串抛错） | host-core | test/host.mjs | ✅ |
| T301 | 真机滚动探针（860 滚到底、375/320 无横向、内滚仍在） | lead | tmp 探针脚本 | ✅ |
| T302 | 真实日志重建并记录 unknown 前后对比 | lead | 运行态索引 | ✅ |
| T303 | README*/CHANGELOG/006 注记/013 §6 实施记录 | lead | 文档与 specs | ✅ |
| T304 | 三个提交 + 提交后复跑七步门禁 | lead | 仓库 | ✅ |

## 完成定义

- 每个任务的验收标准写在 INTERFACE.md 对应小节（§2/§3/§4/§5），实现与契约冲突先改契约。
- T304 之后贴出七步门禁实跑输出；测试计数与 README 一致。

## 收尾（2026-11-14）

- 门禁：host 887 / client 918 / guards 413，全 0 failed；check-manifest / check-docs / check-refs / check-submission 全 OK。
- T301 探针与 T302 重建数据见 INTERFACE.md §6.2 / §6.3；偏差与可失败性实证见 §6.4 / §6.5。
- 提交：feat(usage) 视口 → fix(usage) 模型归位 → test(usage) 断言 → docs(usage) 说明与计数（未 push）。
