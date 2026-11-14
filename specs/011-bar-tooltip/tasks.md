# TASKS — 011

| # | 任务 | 面 | 依赖 | 状态 |
|---|---|---|---|---|
| T001 | 柱组命中区 + 状态 + 浮层组件（含 portal 与回退、夹紧） | lib/client.js | — | ✅ |
| T002 | 关闭通路（离开/Esc/滚动/点别处/blur）与切模式清空 | lib/client.js | T001 | ✅ |
| T003 | 客户端测试 T011（内容/同源/夹紧/关闭/键盘/触屏/双语） | test/client.mjs | T001,T002 | ✅ |
| T004 | 静态门禁第 11 节（钩子、无原生 title、键数不变、无 %/Credits） | test/guards.mjs | T001 | ✅ |
| T005 | 截图场景 ⑭ + 夹具悬停取景 + scripts/shots/README | scripts/shots | T001 | ✅ |
| T006 | 文档：两版 README、CHANGELOG、check-docs 截图清单 | 文档 | T001 | ✅ |
| T007 | 四件套回填（验收结果、计数、偏离） | specs/011-bar-tooltip | all | ✅ |

## 提交计划（一个提交一件事）

1. `feat(usage): 柱状图悬停查看当日 tokens`
2. `test(usage): 悬停浮层的命中、夹紧与无障碍断言`
3. `docs(usage): 悬停提示说明与截图`
