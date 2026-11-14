# 022 按官方价目的单模型估算（tasks）

- [x] 1. 宿主：`MODEL_PRICE_PER_MTOKENS` + `MODEL_PRICE_VERIFIED_AT` + `modelPriceOf`
- [x] 2. 宿主：`splitEstimateClasses` + `modelsWithPriceEstimate`（数学/取整/退化）
- [x] 3. 宿主：`composeCreditsToken` 接线 + `ratio.priceBasis` + `__internals` 导出
- [x] 4. 客户端：`usageModelEstimateOf` + 卡片主数字/分项/share 行 + CSS
- [x] 5. 客户端：COPY 两键新增、Hint/Note 改写、`__internals` 导出
- [x] 6. 测试：host / client 用例（手算与退化矩阵）
- [x] 7. 测试：guards 第 22 节 + COPY 计数 161 六处同步
- [x] 8. 文档：README 两版、CHANGELOG、本目录四件
- [x] 9. 门禁：`npm run check` 全绿
- [x] 10. 提交：feat / test / docs 三次，工作树干净
