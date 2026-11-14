# TASKS — 012

| # | 任务 | 面 | 依赖 | 状态 |
|---|---|---|---|---|
| T001 | COPY：四条分项标签中文化 + 四个新键（占比模板 / 命中率模板 / 命中率标签 / 公式脚注），zh/en 各 138 | lib/client.js | — | ✅ |
| T002 | 比例白名单段：`usagePercentText` / `usageShareText` / `usagePercentSuffix` / `usageHitRateText`，导出到 `__internals` | lib/client.js | T001 | ✅ |
| T003 | 总量卡：四项占比子行 + 缓存命中率格；模型行：中文标签 + 占比 + 命中率 | lib/client.js | T002 | ✅ |
| T004 | 模型列表内滚动（约 4 行高、细滚动条、键盘可达）+ 公式脚注 + CSS | lib/client.js | T003 | ✅ |
| T005 | 客户端测试：SC-001..SC-007 + 边界 + 滚动容器；改写旧「整屏无 %」断言 | test/client.mjs | T003,T004 | ✅ |
| T006 | 静态门禁 §12（白名单段、键数、CSS、文档/截图清单）+ §11 计数 134→138 | test/guards.mjs | T003,T004 | ✅ |
| T007 | 截图：fixture 模型补到 8 条、场景 ⑮ 中英各一张、重拍含模型行的旧图 | scripts/shots, docs/images | T004 | ✅ |
| T008 | 文档：两版 README 用量统计节、CHANGELOG、check-docs 截图清单、specs/012 收尾 | 文档 | T005,T007 | ✅ |

## 提交计划（一个提交一件事）

> 2026-11-14 全部任务完成；计数与偏差见 `INTERFACE.md` §10。

1. `feat(usage): 按模型用量改中文并补占比与缓存命中`（lib/client.js）
2. `test(usage): 分项占比、命中率与模型列表滚动的断言`（test/client.mjs、test/guards.mjs）
3. `docs(usage): 用量构成说明与截图`（README*、CHANGELOG、docs/images、scripts/shots、check-docs、specs/012）
