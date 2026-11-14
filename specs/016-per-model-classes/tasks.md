# 016 任务

- [x] T001 宿主：`creditsModelRatios` 每行加 `classes`（input/cacheRead/output/cacheWrite 各 `{tokens, perCredit}`）
- [x] T002 宿主测试：恒等（四类相加 = tokens）、0 兜底、非法行过滤、缺字段、不取整
- [x] T003 客户端：COPY +1 键（`usageCreditsModelClasses`）、模型行第二行、`data-usage-credits-model-classes` 钩子
- [x] T004 客户端：CSS（行内换行 + 第二行字号/颜色）、脚注补分母口径句
- [x] T005 客户端测试：三类渲染、cacheWrite 追加条件、缺 classes 不渲染第二行、无 %、中英逐字
- [x] T006 静态守卫第 16 节（宿主/DOM/CSS/COPY/文档矩阵）
- [x] T007 截图：fixture 扩 classes、场景 ⑯ 断言、重拍 zh/en 两张
- [x] T008 文档：README 中英各一条、CHANGELOG、INTERFACE §6 实施记录、tasks 置 ✅
- [x] T009 提交与门禁：feat/test/docs 三个提交，提交后七步全绿
