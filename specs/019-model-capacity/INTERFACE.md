# 019 INTERFACE（实现唯一真值）

范围：只改 `lib/index.js`、`lib/client.js` 与其测试；零新路由、零新配置键（DEFAULTS 仍 26）、零新出站主机（仍 8）、零第三方依赖。

## 1 宿主契约

### 1.1 新增纯函数

```js
/**
 * 给每模型比值补 capacity：把「全部额度只花在该模型上」可折合的 tokens 算出来。
 * 四类各自 Math.round(perCredit * total)，capacity.tokens = 四类取整值之和（卡片自洽）。
 * 不原地改入参；total 非有限或不大于 0 时返回不带 capacity 的浅拷贝数组（旧形状）。
 */
function modelsWithCapacity(models, total)
```

规则：

- `!Array.isArray(models)` → `[]`。
- `total = finiteCount(total)`；`undefined`（缺/非有限/非数字）或 `<= 0` → 逐项返回 `{ ...item }`（不带 `capacity`），保持顺序与长度；`"80000"` 这类字符串数字按非有限处理，不做隐式转换。
- 每项 `capacity.classes[key] = Math.round(Math.max(0, perCredit) * total)`，`perCredit` 取 `item.classes[key].perCredit`，缺字段/非有限/负数按 0。
- `capacity.classes` 四键固定顺序 `input, cacheRead, output, cacheWrite`。
- `capacity.tokens = input + cacheRead + output + cacheWrite`（整数相加，不再二次取整）。
- 每项返回 `{ ...item, capacity: { tokens, classes } }`；`item` 不是普通对象时按空项处理（不抛错、不补 capacity）。

### 1.2 接线（composeCreditsToken）

当前：`models: creditsModelRatios(localTotals?.models, effectiveUsed),`

改为：`models: modelsWithCapacity(creditsModelRatios(localTotals?.models, effectiveUsed), cycle.total),`

- `cycle.total` 在 `cycle.ok === true` 时一定是有限正数（既有保证），有/无 daily 都一样用 `cycle.total`（daily 只影响分母 `creditsUsed`，不影响额度总量）。
- 无 local 数据时 `creditsModelRatios` 返回 `[]`，`modelsWithCapacity([], ...)` 仍是 `[]`。

### 1.3 导出

`__internals` 增加 `modelsWithCapacity`（放在 `creditsModelRatios` 条目之后，保持既有逗号分隔风格）。

### 1.4 响应增量示例

```json
{ "ratio": { "modelsBasis": "local", "models": [
  { "id": "qwen-token-plan-cn/qwen3.8-flash", "tokens": 1331249952, "tokensPerCredit": 33718.34,
    "classes": { "input": {"tokens":1,"perCredit":0.28}, "cacheRead": {"tokens":2,"perCredit":0.7},
                 "output": {"tokens":3,"perCredit":0.05}, "cacheWrite": {"tokens":4,"perCredit":0} },
    "capacity": { "tokens": 81000, "classes": { "input": 22000, "cacheRead": 56000, "output": 3000, "cacheWrite": 0 } } } ] } }
```

`capacity.*` 全部是整数；某类为 0 时照实为 0。

## 2 客户端契约

### 2.1 纯函数（导出到 `__internals`）

```js
function usageModelCapacityOf(item, total)
// 单个模型的可用容量：优先用宿主 capacity，没有就用 tokensPerCredit × total 现算（与总折算同一条兜底）。
// 返回 { tokens, classes } | null：classes 只在四类都能算成有限数时给对象，否则 null（总量仍可显示）。
// 任一路径都拿不到有限正数总量时返回 null。

function usageModelPickLabel(item, models)
// chip 标签：模型名不重复时用 model，重名（同一 model 多个 provider）时用 provider + "/" + model。
```

`usageModelCapacityOf` 细则：

- `item` 非普通对象 → null。
- `tokens`：`Number(item.capacity?.tokens)` 有限 → 用它；否则 `Number(item.tokensPerCredit) * Number(total)` 有限 → 用它；否则 null。兜底值不取整（展示层 `formatTokens` 处理），宿主正常路径都是整数。
- `classes`：优先 `item.capacity?.classes`；没有就逐类 `Number(item.classes?.[key]?.perCredit) * total`；四类都有限 → 返回四键对象；`capacity.classes` 存在但四键里有非有限 → classes 为 null（不印假 0）。
- 负数、NaN、null、undefined 按「非有限/缺失」处理（`Number(null)` 先拦，与 016/017 同规矩）。

`usageModelPickLabel` 细则：`item.model` 非字符串或空 → 回落到 `item.id`；统计 `models` 里 `model` 相同的条数，`> 1` 时返回 `provider + "/" + model`（provider 缺失用 `unknown`）。

### 2.2 组件 `UsageCreditsModelPick`

函数组件，`React.useState(null)` 存选中的 `id`（字符串）。渲染流程：

1. `models` 不是非空数组 → `return null`。
2. 逐项算 `usageModelCapacityOf(item, total)`，只保留结果非 null 的项（usable）；`usable.length === 0` → `return null`。
3. 选中项：`usable.find(item => item.id === selectedId)`，找不到就 `usable[0]`（渲染期只读，不在渲染里 setState）。
4. 结构（顺序固定）：

```
section.tpq-usage-credits-modelpick[data-usage-credits-modelpick="1"]
  p.tpq-usage-credits-modelpick-title                     ← copy.usageCreditsModelPickTitle
  p.tpq-usage-credits-modelpick-hint                      ← copy.usageCreditsModelPickHint（{model} {total}）
  div.tpq-usage-credits-modelpick-chips[role="group"][aria-label=<title>]
    button.tpq-usage-credits-modelpick-chip × usable.length
      [data-usage-credits-modelpick-chip="1"] [data-model=<id>] [data-selected="1"|"0"]
      [aria-pressed="true"|"false"] [type="button"] [title=<id>]，文字 = usageModelPickLabel(item, usable)
  div.tpq-usage-credits-modelpick-card[data-usage-credits-modelpick-card="1"]
    p.tpq-usage-credits-modelpick-card-label              ← copy.usageCreditsModelPickCard
    div.tpq-usage-credits-modelpick-total
      span.tpq-usage-credits-modelpick-value   ← formatTokens(capacity.tokens)
      span.tpq-usage-credits-modelpick-unit    ← copy.usageCreditsClassesUnit（"tokens"）
    div.tpq-usage-credits-modelpick-grid       ← 仅当 capacity.classes 非 null
      div.tpq-usage-credits-modelpick-cell × 3 或 4
        [data-usage-credits-modelpick-class="input"|"cacheRead"|"output"|"cacheWrite"]
        span.-modelpick-cell-label / span.-modelpick-cell-value / span.-modelpick-cell-unit
  p.tpq-usage-credits-modelpick-note                      ← copy.usageCreditsModelPickNote
```

3 格固定为 `input` / `cacheRead` / `output`；`cacheWrite` 仅当该值有限且 `> 0` 才追加（与 016 第四段规则一致；0 不占位）。

点击 chip：`onClick: () => setSelectedId(item.id)`。鼠标与键盘（Enter/Space）都由原生 button 提供，不加 `tabIndex`、不加 `role`。

### 2.3 插入位置

`usageCreditsSection` 的 ready 分支顺序：detail → classesCard(017) → estimate → dailyLine(017，可选) → **modelPick(019，可选)** → modelsBlock(015/016，可选) → note。

`total` 传 `Number(creditsData.total)` 的原始值，不是格式化文本。组件元素必须有稳定 key。

### 2.4 COPY（zh / en 各 +4，计数 155 → 159）

| 键 | zh | en |
|---|---|---|
| `usageCreditsModelPickTitle` | 如果只用这一个模型 | If you used only this model |
| `usageCreditsModelPickHint` | 按 {model} 本账期实测比值，把全部 {total} Credits 都花在它上面（折算参考，非官方口径） | Using the measured ratio of {model} for this cycle and spending all {total} credits on it (derived, not official) |
| `usageCreditsModelPickCard` | 折算可用 tokens | Derived capacity |
| `usageCreditsModelPickNote` | 该模型的比值分子是本机用量、分母是账号级已用 Credits；四类分项各自取整后相加等于上方总量。 | The ratio uses local tokens over the account-level used credits; the four class figures are rounded separately and add up to the total above. |

`usageCreditsModelPickHint` 的 `{total}` 传 `usageCount(total)`，`{model}` 传选中项的 `model`（实现用 `usageModelPickLabel`，同名模型会带 provider 前缀）。本仓库 `usageCount` **不带千分位**，屏上是「全部 80000 Credits」，与既有折算行同一口径。

## 3 CSS（接在 `.tpq-usage-credits-daily` 之后）

```css
.tpq-usage-credits-modelpick{display:flex;flex-direction:column;gap:8px;min-width:0}
.tpq-usage-credits-modelpick-title{font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.tpq-usage-credits-modelpick-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-credits-modelpick-chips{display:flex;flex-wrap:wrap;gap:6px}
.tpq-usage-credits-modelpick-chip{font:inherit;font-size:11px;line-height:1.4;padding:3px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:transparent;color:var(--dsw-alias-label-secondary,inherit)}
.tpq-usage-credits-modelpick-chip[data-selected="1"]{background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,.18));border-color:var(--dsw-alias-label-primary,inherit);color:var(--dsw-alias-label-primary,inherit)}
.tpq-usage-credits-modelpick-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:2px}
.tpq-usage-credits-modelpick-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.tpq-usage-credits-modelpick-card-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-credits-modelpick-total{display:flex;align-items:baseline;gap:6px}
.tpq-usage-credits-modelpick-value{font-size:22px;font-weight:600;line-height:1.2;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:lining-nums tabular-nums}
.tpq-usage-credits-modelpick-unit{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-credits-modelpick-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.tpq-usage-credits-modelpick-cell{display:flex;flex-direction:column;gap:2px;min-width:0}
.tpq-usage-credits-modelpick-cell-label{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.tpq-usage-credits-modelpick-cell-value{font-size:14px;font-weight:600;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:lining-nums tabular-nums}
.tpq-usage-credits-modelpick-cell-unit{font-size:10.5px;color:var(--dsw-alias-label-tertiary,inherit)}
@media(max-width:520px){.tpq-usage-credits-modelpick-grid{grid-template-columns:1fr 1fr}}
```

硬规则：不许出现 `background:#fff`、`#e6e9ef`、`color:#1f232b`；选中态用 `bg-layer-3` + `label-primary`，不用 `brand-primary` 当底色（018 教训：深色下它是 ink 白）。

## 4 测试契约

### 4.1 宿主（test/host.mjs）

- `modelsWithCapacity` 在 `__internals` 里是 function。
- 手造两模型数组 + `total = 80000`：四类乘积取整、`capacity.tokens === 四类之和`、原数组未被修改（深比较前后）。
- `total` 为 `0` / `NaN` / `undefined` / `"80000"` → 无 `capacity` 字段；长度与顺序不变。
- `models` 非数组 → `[]`；元素为 `null` / 字符串 → 不抛错且不产出 `capacity`。
- `perCredit` 为负数 / `NaN` / 缺失 → 该类按 0，总和仍等于四类之和。
- `composeCreditsToken` 的 `models[0].capacity.tokens` 与手算一致；有 daily（`creditsUsed` ≠ `credits.total`）时 `capacity` 用 `cycle.total`。

### 4.2 客户端（test/client.mjs）

- `usageModelCapacityOf`：capacity 优先；无 capacity 时 `tokensPerCredit × total`；total 非有限 → null；`capacity.tokens` 为 0 返回 0；classes 缺一类 → classes null 但 tokens 仍在。
- `usageModelPickLabel`：不重名 → model；重名 → provider/model；model 空 → id。
- 组件渲染（假 DOM）：`data-usage-credits-modelpick` 存在；chip 数 = 可用模型数；默认第一项 `data-selected="1"` 且 `aria-pressed="true"`，其余 `"0"`/`"false"`；点击第二项后卡片数字变化。
- 卡片：三格顺序 input → cacheRead → output；cacheWrite 为 0 时不出现第 4 格、> 0 时出现；总值 = 四格之和；不出现 `%`；卡片子树文本不含 `Credits`。
- 旧宿主：无 `capacity` 但有 `tokensPerCredit` + 有限 total → 仍渲染，数字等于乘积。
- 退化：`models: []` / 全部 `tokensPerCredit` 非有限 / total 非有限且无 capacity → 组件返回 null。
- 插入顺序：estimate < modelpick < models。

### 4.3 guards（test/guards.mjs，Lead 写）

第 19 节（约 20 条）+ 既有计数同步：COPY 155 → 159（011/012/015/016/017 各块条件与注释）、DEFAULTS 仍 26、出站仍 8。

## 5 文档与截图契约

- README.md / README.en.md 在 Credits 换算节加一段（选择模型 → 数字、折算参考口径），嵌入新图 `docs/images/usage-credits-model.png` / `docs/images/en/usage-credits-model.png`。
- CHANGELOG `[Unreleased]/Added` 顶部加 019 条目（字段、选择器、断言计数、specs 路径）。
- fixture：`buildUsageCreditsModels` 每行补 `capacity`（四类 = round(perCredit × 80000)，`tokens` = 四类和）；至少 2 个模型可选。
- 场景 ⑱：进 Credits 区 → 断言默认选中第一项 → 点第二个 chip → 断言 `data-selected` 迁移、卡片四格数值逐位等于 fixture 推导值、总分项自洽 → 截图（1280×860 DPR1）→ 中英各一张。

## 6 不做的事

- 不新增路由参数（选择是纯前端状态，刷新回默认）。
- 不做模型容量横向对比表：用户要的是「选一个看一个」。
- 不把容量写回缓存/账本：只是展示层折算。
## 7 实施记录（019 落地后补写）

符号定位（不写行号，改代码后用 grep 找）：

| 位置 | 符号 |
| --- | --- |
| lib/index.js | `modelsWithCapacity(models, total)`、`composeCreditsToken` 的 `models:` 参数、`__internals.modelsWithCapacity` |
| lib/client.js | `usageModelCapacityOf`、`usageModelPickLabel`、`usageModelPickUsable`、`UsageCreditsModelPick`、`.tpq-usage-credits-modelpick*` 样式段（含 `@media (max-width:520px)` 两列规约）、`__internals` 导出两条纯函数 |
| test/host.mjs | 019 用例块（手算/取整/自洽/脏输入/不原地改/compose 透传） |
| test/client.mjs | T019 用例块（纯函数边界 + 假 DOM 渲染 + 切换 + 逐字文案 + 退化） |
| test/guards.mjs | 第 19 节静态矩阵（22 条） |

偏差与裁量（实现比契约更严或更松的地方，均已在测试里钉住）：

1. 宿主 `total` 用 `typeof total === "number" && Number.isFinite(total)` 而不是 `finiteCount`：`finiteCount` 会接受数字字符串，契约要求 `"80000"` 按非有限处理。`perCredit` 仍复用 `finiteCount`。
2. 客户端 hint 的 `{total}` 走既有 `usageCount`，本仓库它不带千分位，屏上是「全部 80000 Credits」，与既有折算行同口径（§2.4 已同步改口径）。
3. `usageModelCapacityOf` 的 `capacity.classes` 同时接受数字与 `{ tokens }` 对象两种形状（防御宿主序列化差异）；四类任一非有限则 classes 整组为 null，但 tokens 仍返回。
4. chip 用原生 `button`（自带键盘可达），未额外加 `tabIndex`/`role`；`:focus-visible` 用品牌色描边，选中态底色用 `bg-layer-3`（品牌色在深色主题会解析成 ink，不能当底）。
5. 客户端测试夹具里有个模型的四类 `perCredit` 之和原本与 `tokensPerCredit` 矛盾（6 vs 9411.9），已改成自洽的 3000/4000/2000/411.9，否则会把「总值 ≠ 分项之和」写进断言。
6. 截图取景口径变了：加了单模型块后 Credits 整块 zh 857px / en 874px 已高于 860 视口，⑰ 从「整块进视口」改为以「1 Credit 折合」卡片为锚；⑱ 同样以卡片顶为锚并断言选择器块与卡片四边在视口内。`scripts/shots/README.md` 已写明。
7. 四张 Credits 相关图全部重拍（017 两张 + 019 两张），字节数见 README 图墙与 `scripts/shots/README.md`。

断言计数：host 1016 → 1037（+21）、client 1268 → 1346（+78）、guards 570 → 592（第 19 节 22 条 + 既有 COPY 计数 155 → 159 的五处同步）。
