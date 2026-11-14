# 015 任务

- [x] T001 宿主纯函数：`creditsClassRatios` / `creditsModelRatios`（lib/index.js，`__internals` 导出）
- [x] T002 宿主组合：`composeCreditsToken` 加 `ratio.classes` / `ratio.models` / `ratio.modelsBasis`，`buildCreditsTokenSnapshot` 透传本机 models
- [x] T003 宿主测试：test/host.mjs（三类数值、求和等于官方 tokens、cacheRead>input 夹 0、模型过滤与降序、本机缺失）
- [x] T004 客户端分项行：`usageCreditsClassesLine` + COPY `usageCreditsClasses` / `usageCreditsClassUncached`
- [x] T005 客户端模型块：`usageCreditsModelsBlock` + COPY `usageCreditsModelsTitle` / `usageCreditsModelsNote` + CSS 内滚动
- [x] T006 客户端测试：test/client.mjs（分项行数值、模型行结构与顺序、降级无 classes/models、双语、滚动块无障碍）
- [x] T007 guards 第 15 节：静态矩阵（函数、字段、钩子、COPY 计数、无新路由/配置键）
- [x] T008 文档与截图：README*、CHANGELOG、场景 ⑯ 扩展并重拍中英两图
- [x] T009 门禁：`npm run check` 七步全绿（最后一次编辑之后）

## 收尾

- 015 实现完成：宿主 928→954、客户端 1012→1080、guards 459→497，`npm run check` 七步全绿（最后一次编辑之后跑）。
- T008 的截图由 shots-docs 出（场景 ⑯ 扩展后重拍中英 `usage-credits-2d.png`），文档口径由 Lead 回填。
- 实现记录见 `INTERFACE.md` §6。
