# 016 接口契约（唯一实现真值）

## 1 路由与配置

不变：`GET /token-plan-quota/usage-credits?fresh=1`（同源、只 GET、非 GET 405）。**不新增**路由、查询参数、配置键、出站主机、第三方依赖。

## 2 响应新增字段（仅 `available: true` 时存在）

```js
ratio.models: [{
  id, provider, model, tokens, calls, tokensPerCredit,   // 015 已有，全部不变
  classes: {                                             // 016 新增
    input:      { tokens: number, perCredit: number },   // 本机 totals.input（不含缓存命中）
    cacheRead:  { tokens: number, perCredit: number },   // 本机 totals.cacheRead
    output:     { tokens: number, perCredit: number },   // 本机 totals.output
    cacheWrite: { tokens: number, perCredit: number },   // 本机 totals.cacheWrite
  },
}]
```

- `perCredit = tokens / credits.used`，**不取整、不 toFixed**（与 014/015 一致）。
- 取数：`tokens` 直接取本机 `totals.x`，缺字段 / 非有限 / 负数一律按 0（沿用 `finiteCount` 语义），绝不产出 NaN/Infinity。
- **恒等**：同一行 `input.tokens + cacheRead.tokens + output.tokens + cacheWrite.tokens === tokens`（本机口径定义如此，用例必须断言）。
- 行过滤条件不变（015）：`totals.tokens` 有限且 > 0 才进列表；保序、不 sort、不 reverse。
- `classes` 恒为对象（四键齐全），即使某类为 0；客户端只做展示层省略。
- 旧宿主无此字段；客户端必须能降级（§3.3）。

## 3 客户端契约

### 3.1 COPY：新增 2 键、改 1 键（zh 151→153，en 同步）

zh：

- `usageCreditsModelClasses`: `每 Credit：输入 {input} · 缓存命中 {cacheRead} · 输出 {output}`
- `usageCreditsModelClassWrite`: ` · 缓存写入 {tokens}`
- `usageCreditsModelsNote`（改写）: `模型行 = 本机该模型 tokens ÷ 本账期已用 Credits（官方不按模型拆分，这是贡献值）；每行的输入 / 缓存命中 / 输出各自是「该模型这一类 tokens ÷ 同一个账号级分母」，三者相加等于该行总量。各行相加约等于本机总量，与账号级官方总量有少量差额。`

en：

- `usageCreditsModelClasses`: `Per credit: input {input} · cache hit {cacheRead} · output {output}`
- `usageCreditsModelClassWrite`: ` · cache write {tokens}`
- `usageCreditsModelsNote`: `Model rows = local tokens for that model / credits used this cycle (official data is not split by model, so these are contributions); each row's input / cache hit / output is that class's tokens for the model over the same account-level denominator, and the three add up to the row total. Rows sum to roughly the local total, which differs slightly from the official account total.`

复用键：`usageSplitInput`（zh 输入 / en input）**不用于此处**——模板已内联标签；`usageSplitCacheWrite` 也不用于此处（模板内联「缓存写入」）。en 模板全 ASCII。

### 3.2 模型行结构

每行仍是 `div.tpq-usage-credits-model[data-usage-credits-model][data-model]`，children 从 3 个 span 变成 3 span + 可选第二行：

```
span.tpq-usage-credits-model-name      （015 已有）
span.tpq-usage-credits-model-tokens    （015 已有）
span.tpq-usage-credits-model-ratio     （015 已有）
span.tpq-usage-credits-model-classes   （016 新增，第二行）
  data-usage-credits-model-classes="1"
```

### 3.3 第二行文本与渲染条件

- 文本：`copy.usageCreditsModelClasses` 的 `{input}`/`{cacheRead}`/`{output}` 依次替换成
  `formatTokens(classes.input.perCredit)` / `formatTokens(classes.cacheRead.perCredit)` / `formatTokens(classes.output.perCredit)`；
  当 `classes.cacheWrite.perCredit` 是有限数且 **> 0** 时，追加 `copy.usageCreditsModelClassWrite` 把 `{tokens}` 替换成 `formatTokens(cacheWrite.perCredit)`。
- 渲染条件：`classes` 是对象，且 `input/cacheRead/output` 三个 `perCredit` 都是有限数；否则**该行第二行不渲染**（第一行照旧）。缺 `classes`（旧宿主）走同一分支。
- 0 是真实值：某类 tokens 为 0 时照实渲染 `0`，只有「缺字段 / 非有限」才整行省略。
- 本函数不产出 `%`（012 白名单段之外不得出现百分号字面量）。
- 示例（zh，实际数据，used = 38280.2997）：
  `每 Credit：输入 1,341 · 缓存命中 3.3万 · 输出 133`（formatTokens 的口径：万/亿 + 千分位）。

### 3.4 CSS

```css
.tpq-usage-credits-model{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;padding:2px 0;font-size:12px}
.tpq-usage-credits-model-classes{flex:0 0 100%;font-size:10.5px;line-height:1.6;overflow-wrap:anywhere;
  color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:lining-nums tabular-nums}
```

- 只加 `flex-wrap`/`gap` 与一条新规则；252px 定高、`overflow-y:auto`、thin、contain、8px thumb、`:focus-visible` 等 015 契约不变。
- 行变成两行后，8 行模型块高度 > 252px，截图里**内滚会真正触发**（scrollHeight > clientHeight 可断言）。

## 4 守卫（test/guards.mjs 第 16 节）

至少覆盖：宿主 `creditsModelRatios` 段含 `classes`、四键名、无 `round/floor/ceil/toFixed`、仍以 `tokens <= 0` 过滤；
客户端含 `"data-usage-credits-model-classes": "1"`、`usageCreditsModelClasses`/`usageCreditsModelClassWrite` 模板替换、
第二行段剥注释后无 `%` 字面量；COPY 计数 153/153 且 zh 有汉字、en 无 CJK；CSS 两条规则；README/CHANGELOG/specs 016 四件。

## 5 降级

| 输入 | 行为 |
|---|---|
| 旧宿主（无 classes） | 模型行第一行照旧，无第二行，不报错 |
| `classes` 缺某键 | 该行第二行不渲染 |
| 某类 tokens = 0 | 照实显示 0（cacheWrite 为 0 时不追加第四段） |
| `models: []` | 整块不渲染（015 不变） |

## 6 实施记录（015 之后补写）

落地位置（按符号名定位，不写行号——行号会漂）：

| 位置 | 内容 |
|---|---|
| `lib/index.js` 的 `creditsModelRatios` | 每行 `classes` 在同一函数内组装：四类 `Math.max(0, finiteCount(item?.totals?.x) ?? 0)`，`perCredit = x / u` |
| `lib/index.js` 的 `__internals` | `creditsModelRatios` 已暴露（守卫可直接打纯函数） |
| `lib/client.js` 的 `usageCreditsModelClassesLine` | 第二行渲染函数（同时进 `__internals`） |
| `lib/client.js` 的 CSS | `.tpq-usage-credits-model` 加 `flex-wrap:wrap;gap:2px 8px`，新增 `.tpq-usage-credits-model-classes` |
| `test/host.mjs` | 016 宿主用例块（恒等 / 0 兜底 / 不取整 / 真实数据 / compose 透传） |
| `test/client.mjs` | 016 客户端用例（+79 条：钩子 / 中文英文逐字 / 降级矩阵 / cacheWrite 条件 / DOM 第二行） |
| `test/guards.mjs` | 第 16 节静态矩阵 29 条；011/012/015 三处 COPY 计数 151→153 |

与契约的偏差（都更严，不放宽）：

1. **真实数据用例的容差不为零**：宿主的真实读数只以两位小数 perCredit 交给我方，因此按它反推整数 tokens，
   三类断言用 `±0.01`、行总量用 `±0.02`（`34776.38` vs 契约示例 `34776.37`，差在两位小数舍入）。
   合成数据用例仍是精确等值（`=== 1 / 3` 这类全精度断言）。
2. **`null` / `undefined` 视为缺字段**：客户端 `perCreditOf` 先拦 `null`/`undefined` 再 `Number()`，
   否则 `Number(null) === 0` 会印出一个假 0；`classes` 为数组时按非对象拒绝（契约只写"是对象"，
   数组是同族误传，防御性拒绝，`route` 上不会出现）。
3. **015 的两条既有断言被改**：T015 的脚注逐字断言（脚注按 §3.1 改写）与 T015 的 CSS 正则
   （`display:flex;gap:8px` → `display:flex;flex-wrap:wrap;gap:2px 8px`）。这是 016 改变契约的必然结果，
   不是放宽：两条都换成了更具体的形状断言。
4. **未覆盖项（如实记）**：SC-002 的「五行模型汇总」只有首行用真实账号数据（qwen3.8-flash），
   其余四行用合成数据；不伪造真实明细。

计数（最后一次编辑之后实跑）：宿主 954→**971**、客户端 1080→**1159**、guards 497→**526**（第 16 节 29 条）。

