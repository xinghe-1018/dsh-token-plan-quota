# 022 INTERFACE（实现唯一真值）

范围：只改 `lib/index.js`、`lib/client.js` 与其测试；零新路由、零新配置键（DEFAULTS 仍 26）、零新出站主机（仍 8）、零第三方依赖。

## 1 宿主契约

### 1.1 常量

```js
// 人民币 / 百万 tokens，忙时标准价，取价日 2026-11-15。
// 来源：https://www.qianwenai.com/models/qwen3.8-flash
//       https://www.qianwenai.com/models/deepseek-v4.1-flash-1017（闲时 ¥1/¥0.02/¥4；忙时 ¥2/¥0.04/¥8）
const MODEL_PRICE_PER_MTOKENS = {
  'qwen3.8-flash': { input: 0.8, cacheRead: 0.1, output: 2.7 },
  'deepseek-v4.1-flash-1017': { input: 2, cacheRead: 0.04, output: 8 },
  'deepseek-v4.1-flash': { input: 2, cacheRead: 0.04, output: 8 },
}
const MODEL_PRICE_VERIFIED_AT = '2026-11-15'
```

`qwen4-max-preview` 及任何未列出的模型都**没有价目**：不产估算，不猜价。

### 1.2 纯函数

```js
/** 按模型名精确查价目；未知/非字符串/缺键 → null。 */
function modelPriceOf(model)

/** 按四类 tokens 占比把 estimate.tokens 分配到 classes；合计严格相等，cacheWrite 为 0 不参与分配。 */
function splitEstimateClasses(estimated, tokens)

/**
 * 给每模型比值补 estimate：把「本账期全部额度只花在该模型上」按官方价目估算的 tokens。
 * 不原地改入参；used / total 非有限或 <= 0、无任何可定价模型时返回不带 estimate 的浅拷贝数组。
 * @param {Array} models  019 形状（含 model / tokens / classes[key].tokens）
 * @param {number} used   本账期已用 Credits（effectiveUsed）
 * @param {number} total  本账期额度总量（cycle.total）
 */
function modelsWithPriceEstimate(models, used, total)
```

规则：

- `!Array.isArray(models)` → `[]`；`item` 非普通对象 → 输出空对象（与 019 `modelsWithCapacity` 同规矩）。
- `used` / `total` 只认 number：`'40296'` 这类字符串按非有限处理。
- 每行 `tokens = input + cacheRead + output + cacheWrite`（取 `classes[key].tokens`，缺/非有限/负数按 0）；
  `tokens <= 0` 或查不到价目 → 跳过。
- `costOfRow = input×p.input + cacheRead×p.cacheRead + output×p.output`（cacheWrite 暂无公开单价，按 0 计，
  本机实测恒为 0）；`priceMix = costOfRow / tokens`；`cost = Σ costOfRow`；`ypc = cost / used`。
- `estimate.tokens = Math.round(total × ypc / priceMix)`；非有限或 < 0 时不写。
- `estimate.classes` 四键固定顺序 `input, cacheRead, output, cacheWrite`；各类 = `floor(estimate.tokens × 该类 tokens / tokens)`，
  差额（0..3）补到小数部分最大的类，保证四类之和 === `estimate.tokens`；`cacheWrite === 0` 时该格恒为 0。
- 输出 `{ ...item, estimate: { tokens, classes } }`；**不删除** 019 的 `capacity`。

### 1.3 接线（composeCreditsToken）

```js
models: modelsWithPriceEstimate(
  modelsWithCapacity(creditsModelRatios(localTotals?.models, effectiveUsed), cycle.total),
  effectiveUsed, cycle.total),
```

- 至少一项有 `estimate` 时，给 `ratio` 补：
  `priceBasis = { kind: 'list-price', verifiedAt: MODEL_PRICE_VERIFIED_AT, unit: 'CNY per million tokens' }`。
- 无估算时不写 `priceBasis`（旧响应逐字段不变，除 `models[].estimate` 缺席）。
- `effectiveUsed` 与 019 同源（有 daily 快照时是快照里的 `creditsUsed`）。

### 1.4 导出

`__internals` 增加 `modelPriceOf`、`modelsWithPriceEstimate`（紧跟 `modelsWithCapacity` 之后）。

### 1.5 响应增量示例

```json
{ "ratio": {
  "modelsBasis": "local",
  "priceBasis": { "kind": "list-price", "verifiedAt": "2026-11-15", "unit": "CNY per million tokens" },
  "models": [{
    "id": "qwen-token-plan-cn/qwen3.8-flash", "model": "qwen3.8-flash", "tokens": 1331249952,
    "classes": { "input": {"tokens":51349067,"perCredit":1274.29}, "cacheRead": {"tokens":1274817792,"perCredit":31636.4},
                 "output": {"tokens":5083093,"perCredit":126.14}, "cacheWrite": {"tokens":0,"perCredit":0} },
    "capacity": { "tokens": 2643000000, "classes": { "input": 102000000, "cacheRead": 2531000000, "output": 10000000, "cacheWrite": 0 } },
    "estimate": { "tokens": 4827000000, "classes": { "input": 186100000, "cacheRead": 4623000000, "output": 18400000, "cacheWrite": 0 } }
  }]
} }
```

所有 capacity / estimate 都是整数；`estimate.classes` 之和 === `estimate.tokens`。

## 2 客户端契约

### 2.1 纯函数（导出到 `__internals`）

```js
/**
 * 解析宿主 estimate：{ tokens, classes } | null。
 * tokens 取 estimate.tokens；classes 四键都必须是有限数（接受数字或 {tokens} 对象），否则 classes = null。
 * estimate 缺失/非对象/tokens 非有限 → null（回落 019 的 capacity）。
 */
function usageModelEstimateOf(item)
```

### 2.2 组件 `UsageCreditsModelPick`

- 可用性判定仍走 `usageModelPickUsable`（019 的 capacity 是闸门，保证旧宿主也有数）。
- 选中项后：`const estimate = usageModelEstimateOf(selected.item)`。
  - `estimate !== null` → 主数字 = `formatTokens(estimate.tokens)`，分项用 `estimate.classes`，
    标签 = `copy.usageCreditsModelPickEstimate`；
    卡片底部追加 `p.tpq-usage-credits-modelpick-share` = `copy.usageCreditsModelPickShare`
    （`{tokens}` 换成 `formatTokens(selected.capacity.tokens)`，capacity.tokens 有限时才追加）。
  - `estimate === null` → 逐字段保持 019（`usageCreditsModelPickCard` + capacity）。
- 分项格规则不变：input / cacheRead / output 三格，`cacheWrite > 0` 才追加第四格。
- 不新增 DOM 钩子；`data-usage-credits-modelpick-card` 不变。

### 2.3 COPY（zh / en 各 +2，计数 159 → 161）

| 键 | zh | en |
|---|---|---|
| `usageCreditsModelPickEstimate` | 按官方价目估算 tokens | Estimated from list prices |
| `usageCreditsModelPickShare` | 按实测占比折算 {tokens} tokens（贡献份额，不可相加） | Share-derived {tokens} tokens (contribution only, not additive) |

同时改两条既有文案（不增键）：

- `usageCreditsModelPickHint`：zh「把本账期全部 {total} Credits 都花在 {model} 上能换多少 tokens（折算参考，非官方口径）」；
  en「How many tokens {total} credits would buy if this cycle spent all of them on {model} (derived, not official)」。
- `usageCreditsModelPickNote`：zh「「按官方价目估算」用官方公开的忙时单价与本账号实测比值校准，未计 22:00–08:00
  夜间折扣与没有公开单价的模型；占比折算仍是本机该模型 tokens ÷ 账号级已用 Credits。四类分项各自取整后相加等于上方总量。」；
  en「"Estimated from list prices" calibrates published standard (busy-hour) prices against this account's measured
  ratio; it excludes the 22:00-08:00 night discount and models without a published price. The share figure is local
  tokens for that model over account-level used credits. The class cells are rounded separately and add up to the
  total above.」

### 2.4 CSS（接在 `.tpq-usage-credits-modelpick-note` 之后）

```css
.tpq-usage-credits-modelpick-share{margin:0;font-size:10.5px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}
```

## 3 测试契约

### 3.1 宿主（test/host.mjs）

- `__internals.modelPriceOf` / `modelsWithPriceEstimate` 是函数。
- 已知价目：手造 qwen3.8-flash 行（tokens 1,000,000；input 200,000 / cacheRead 700,000 / output 100,000），
  `used = 1000`、`total = 80000`：手算 priceMix = (200000×0.8 + 700000×0.1 + 100000×2.7)/1,000,000 = 0.5，
  cost = 500,000（价目×tokens/M 单位），ypc = 500；单模型时价目在 estimate 里约掉，
  estimate = 80000×1000000/1000 = 80,000,000 → `classes` 应为 16,000,000 / 56,000,000 / 8,000,000 / 0。
- 两行不同模型（qwen + ds）时各自 estimate 与手算一致，且 `classes` 之和 === tokens。
- 未知模型（`qwen4-max-preview`）行只有 capacity、无 estimate。
- `used = 0` / `NaN` / `'1000'` / `total = 0` / 负数 → 全部行无 estimate，长度与顺序不变，入参未被修改。
- 行 tokens 为 0 或 classes 缺失 → 跳过该行（其余行照算）。
- `composeCreditsToken`：`ratio.priceBasis` 存在且 `verifiedAt === '2026-11-15'`；模型行 estimate 与直接调用一致；
  无价目模型时 `priceBasis` 缺席。

### 3.2 客户端（test/client.mjs）

- `usageModelEstimateOf`：正常解析；缺 estimate / tokens 非有限 / classes 缺一类 → null 或 classes = null；
  `{tokens}` 对象形状兼容。
- 渲染（有 estimate）：卡片标签为 `usageCreditsModelPickEstimate`、总值 = estimate.tokens、四格值来自 estimate.classes、
  出现 `tpq-usage-credits-modelpick-share` 且文本含占比 capacity；不出现百分比。
- 渲染（无 estimate）：标签为 `usageCreditsModelPickCard`、无 share 行（019 行为）。
- 切换 chip 后主数字随之变化。

### 3.3 guards（test/guards.mjs）

第 22 节（约 12 条）+ 六处 COPY 计数 159 → 161（011/012/015/016/017/019 各块条件与注释）。

## 4 文档契约

- README.md / README.en.md 的单模型段：说明「按官方价目估算」与「占比折算」两种口径、价目取价日、未计夜间折扣。
- CHANGELOG `[Unreleased]/Added` 顶部加 022 条目（字段、口径、断言计数、specs 路径）。
- 截图：本轮不新增/不重拍（本机读图通道失效），沿用 019 的 `usage-credits-model.png`；文字描述为准。

## 5 不做的事

- 不新增路由参数、不做横向对比表、不把估算写回缓存或账本。
- 不猜 `qwen4-max-preview` 的单价：宁可不出估算，也不给假数字。
- 不改 019 的 `capacity` 语义与 `modelsBasis` 口径。
