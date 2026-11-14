# 014 任务

- [x] T001 宿主纯函数：`creditsCycleOf` / `creditsTokenRatioOf` / `composeCreditsToken`（lib/index.js，__internals 导出）
- [x] T002 宿主路由：`GET /token-plan-quota/usage-credits`（只读，fresh=1）+ `buildCreditsTokenSnapshot` + 404 路由表
- [x] T003 宿主测试：test/host.mjs（账期推导、比值、六种不可用原因、组合响应）
- [x] T004 客户端取数：`USAGE_CREDITS` + `fetchCredits`（独立状态槽，不随区间重取）
- [x] T005 客户端渲染：`usageCreditsSection` + 9 个 COPY 键 + CSS
- [x] T006 客户端测试：test/client.mjs（就绪/加载/不可用/错误、双语、数字格式、重试）
- [x] T007 guards 第 14 节：静态矩阵（路由、函数、钩子、COPY 计数、无新配置键/主机）
- [x] T008 文档与截图：README*、CHANGELOG、check-docs、场景 ⑯ 中英两图
- [x] T009 门禁：`npm run check` 七步全绿（最后一次编辑之后）
## 收尾

全部任务 ✅。实现记录见 `INTERFACE.md` §6（计数、实测值、7 条偏差）。门禁在最后一次编辑之后实跑：host 928 / client 1012 / guards 459，全 0 failed。
