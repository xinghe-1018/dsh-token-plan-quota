# 022 按官方价目的单模型估算（plan）

## 问题重述

019 的 `capacity` 是**占比折算**：`capacity_i = Math.round(perCredit_i × total)`，
`perCredit_i = tokens_i / used`。因为 `Σ tokens_i ≈ used × 表头比值`，所以 `Σ capacity_i ≈ 51 亿 = 表头容量`。
它回答的是「本机该模型占了多少份额」，不是「如果只用它，8 万 Credits 能换多少」。两者在价格差异大时能差一倍。

## 方案比较

- **A. 官方价目 × 账号实测校准（采纳）**
  用公开单价算每个模型的 `priceMix`（每 token 的价目成本），把本账号本次账期的价目总成本除以已用 Credits 得到
  `ypc`（1 Credit 值多少「价目人民币」），再 `estimate_i = total × ypc / priceMix_i`。
  优点：不硬编码套餐价；价目只提供**相对权重**，绝对水平由本账号实测锚定，自动吸收夜间折扣等实际优惠；
  纯函数、可手算、零网络。缺点：假设「Credits 与价目成本成正比」，跨设备/未知价目模型会带来几个百分点偏差。
- **B. 手选中值价（如 ds 1.5 / 0.03 / 6）**：能在 qwen / ds 之间取平均，但 1.5 不是任何官方页面上的数字，
  属于拍脑袋；且换机型就要重拍。否决。
- **C. 只把 019 改名成「占比折算」**：诚实但不回答用户问题（m00879 要的是量级）。否决。

## 实现步骤

1. 宿主 `lib/index.js`：
   - 常量 `MODEL_PRICE_PER_MTOKENS` + `MODEL_PRICE_VERIFIED_AT`（取价日、来源 URL 写注释）；
   - `modelPriceOf(model)`：按模型名精确查表，非普通对象/缺键返回 null（未知模型不出估算）；
   - `splitEstimateClasses(estimated, tokens)`：按四类 tokens 占比分配，最大余数法保证合计 = 估值，cacheWrite 0 不分配；
   - `modelsWithPriceEstimate(models, used, total)`：浅拷贝入参 → 算 priceMix / cost / ypc → 逐项写 `estimate`；
   - `composeCreditsToken` 接线，并在有估算时补 `ratio.priceBasis`；
   - `__internals` 导出两个新函数。
2. 客户端 `lib/client.js`：
   - 新纯函数 `usageModelEstimateOf(item)`（解析 `estimate`，形状与 `usageModelCapacityOf` 对齐）；
   - `UsageCreditsModelPick` 主数字/分项优先 estimate，加 `share` 小字行与 `estimate` 标签；
   - COPY：+2 键（`usageCreditsModelPickEstimate` / `usageCreditsModelPickShare`），改 Hint / Note 文案；
   - CSS：`.tpq-usage-credits-modelpick-share`；`__internals` 导出 `usageModelEstimateOf`。
3. 测试：`test/host.mjs`（数学/取整/退化/接线）、`test/client.mjs`（纯函数 + 渲染 + 回落）、
   `test/guards.mjs`（第 22 节静态矩阵 + 六处 COPY 计数 159 → 161）。
4. 文档：README 两版、CHANGELOG、本目录。
5. 门禁：`npm run check` 全绿后分 feat / test / docs 三次提交。

## 风险与对策

- **偏差来源**：夜间 22:00–08:00 折扣（qwen3.8-flash 4 折、deepseek 5 折）让实际容量高于估算 → 文案明写「未计夜间折扣」。
- **其他设备**：`used` 是账号级、tokens 是本机 → ypc 会被摊薄几个百分点（本机实测约 2.6%），已知且可接受，README 写明口径。
- **未知价目模型**（qwen4-max-preview）：不估算、保留占比折算；Note 说明「没有公开单价的模型不出估算」。
- **取价日会过时**：`MODEL_PRICE_VERIFIED_AT` 进响应与守卫，改价时换常量并同步 spec，不静默漂移。
- **旧宿主**：客户端解析不到 `estimate` 就回落到 019 的 capacity，不因升级不同步而空白。

## 验收数据（手算，写入测试）

2026-11-01..11-15 本机分模型价目成本（忙时价，元）：

- qwen3.8-flash：`51,349,067×0.8 + 1,274,817,792×0.1 + 5,083,093×2.7 = 182,285,383.9`，
  `priceMix = 182,285,383.9 / 1,331,249,952 = 0.13693`；
- qwen 通道 ds1017：`14,692,780×2 + 614,849,792×0.04 + 4,133,565×8 = 87,048,071.7`，
  `priceMix = 87,048,071.7 / 633,676,137 = 0.13737`；
- modlens 通道 ds1017：`10,762,290×2 + 511,813,888×0.04 + 2,688,627×8 = 63,506,151.5`，
  `priceMix = 63,506,151.5 / 525,264,805 = 0.12090`；
- 三行成本合计 ≈332,839,607；`ypc = 332,839,607 / 40,296.2144 ≈ 8,260`（单位：价目×tokens/M 每 Credit，与 priceMix 同单位、在 estimate 里约掉）。

于是 `estimate = 80,000 × ypc / priceMix`：qwen ≈ 4.827B（48.3 亿）、ds-qwen ≈ 4.812B（48.1 亿）、
modlens ≈ 5.466B（54.7 亿）；ds-v4.1-flash（8 次调用，样本太小）≈ 1.90B，仅作占位。
夜间折扣、其他设备分摊会让真实值更高，量级与用户手算的「50 亿左右」一致。
