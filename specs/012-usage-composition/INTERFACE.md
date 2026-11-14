# INTERFACE — 012 按模型用量的中文标签、占比与缓存命中（实现唯一真值）

> 只改 `lib/client.js`（外加测试/文档）。宿主、路由、配置键、工具入参、出站主机一律不动；
> 011 的悬停浮层内容与行为一字不改。

## 1. COPY（zh / en 各 +4 键，134 → 138）

改值（键名不变）：

| 键 | zh（新） | en（新） |
|---|---|---|
| usageSplitInput | 输入 | input |
| usageSplitOutput | 输出 | output |
| usageSplitCacheRead | 缓存命中 | cache hit |
| usageSplitCacheWrite | 缓存写入 | cache write |

新增：

| 键 | zh | en |
|---|---|---|
| usageShareOf | 占 {percent} | {percent} of total |
| usageHitRateLabel | 缓存命中率 | cache hit rate |
| usageHitRate | 命中率 {percent} | hit rate {percent} |
| usageRatioNote | 占比与命中率都是本机实测 tokens 的比值：缓存命中率 = 缓存命中 ÷ (输入 + 缓存命中 + 缓存写入)；输入 / 输出 / 缓存命中 / 缓存写入的占比 = 各自 ÷ 区间 tokens 总量。它们描述用量构成，不是配额比例。 | Shares and hit rate are ratios of measured tokens: cache hit rate = cache hit ÷ (input + cache hit + cache write); the shares of input / output / cache hit / cache write = each ÷ total tokens in the range. They describe composition, not quota. |

`usageSplitTotal` / `usageTokensUnit` / `usageModelsTitle` 等其余键不动。

## 2. 纯函数（新，导出到 `__internals`，位于**比例白名单段**）

```js
/* 012 比例白名单段：本产品唯一允许出现百分号的地方（实测 token 的构成比与命中率）。 */
function usagePercentText(value, base)        // → "57.1%" | "<0.1%" | "100%" | null
function usageShareText(copy, value, base)    // → "占 57.1%"（null → ""）
function usagePercentSuffix(value, base)      // → " (57.1%)"（null → ""）
function usageHitRateText(copy, totals)       // → "命中率 14.3%"（分母 0 → ""）
/* 012 比例白名单段结束 */
```

规则：

- `usagePercentText`：`value` / `base` 任一非有限数或 `base <= 0` → `null`；`value < 0` → `null`（不印负占比）。
  `pct = value / base * 100`；`0 < pct < 0.1` → `"<0.1%"`；其余 `Math.round(pct * 10) / 10`，
  整数写 `"57%"`，否则一位小数 `"57.1%"`（100 → `"100%"`，0 → `"0%"`）。
- `usageShareText`：模板 `copy.usageShareOf` 用 `{percent}` 占位。
- `usagePercentSuffix`：ASCII 括号 + 前导空格，供模型行拼接。
- `usageHitRateText`：`cacheRead ÷ (input + cacheRead + cacheWrite)`；三项都按 0 兜底。

## 3. 总量卡

`.tpq-usage-splits` 从 5 格变 6 格，顺序：

1. 输入：数值 + 占比子行（`usageShareText(copy, input, tokens)`）
2. 输出：数值 + 占比子行
3. 缓存命中：数值 + 占比子行
4. 缓存写入：数值 + 占比子行（值为 0 时不显示占比子行）
5. 缓存命中率（`usageHitRateLabel`）：值 = `usagePercentText(cacheRead, input + cacheRead + cacheWrite)`，null → `"—"`；无占比子行
6. 调用次数：无占比子行

`usageSplitCell(label, value, shareText)`：第三参可选；有则渲染 `.tpq-usage-split-share`。
占比只在本卡和模型行出现，悬停浮层不加。

## 4. 模型行

`usageModelRow(model, copy)`：

- 第一行：`model.id` + `formatTokens(totals.tokens)`（不变）。
- 第二行（`.tpq-usage-model-splits`）：四段以 `" · "` 连接，再追加命中率：
  `输入 40.0万 (61.5%) · 输出 20.0万 (30.8%) · 缓存命中 5.0万 (7.7%) · 缓存写入 0 · 命中率 11.1%`
  - 占比分母 = `totals.tokens`（006 契约：tokens = 四项纯求和）。
  - `value === 0` 时省略占比后缀（`缓存写入 0`）。
  - 命中率分母为 0 时整段省略（不写 `命中率 —`）。
  - 数值仍走 `formatTokens`（中英各自量纲）。

## 5. 模型列表滚动

容器元素：

```js
React.createElement("div", {
  className: "tpq-usage-models",
  "data-usage-models-scroll": "1",
  tabIndex: 0,
  role: "group",
  "aria-label": copy.usageModelsTitle,
}, ...)
```

CSS：

```css
.tpq-usage-models{display:flex;flex-direction:column;max-height:252px;overflow-y:auto;
  overscroll-behavior:contain;scrollbar-width:thin;
  scrollbar-color:var(--dsw-alias-border-l2,rgba(128,128,128,.35)) transparent;padding-right:4px}
.tpq-usage-models:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);
  outline-offset:2px;border-radius:6px}
.tpq-usage-models::-webkit-scrollbar{width:8px}
.tpq-usage-models::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(128,128,128,.35));
  border-radius:4px}
.tpq-usage-split-share{font-size:10.5px;color:var(--dsw-alias-label-tertiary,inherit);
  font-variant-numeric:lining-nums tabular-nums}
```

252px ≈ 4 个两行行高；模型少于此不出现滚动条。移动端同一规则（不改 520px 断点里的列数）。

## 6. 脚注

`UsageScreen` 的 `noteLines` 在已有来源脚注之后追加 `copy.usageRatioNote`
（仅 `snapshot !== null && disabled !== true`）。不新增行首标记；`.tpq-usage-notes` 已有样式。

## 7. 颜色与可达性

- 占比子行/后缀用 `--dsw-alias-label-tertiary`，不抢数值；不用品牌色。
- 滚动容器 `tabIndex=0` + `aria-label` + `:focus-visible` 描边；不用 `aria-live`。
- 深色主题只用既有 CSS 变量，不新增写死颜色（滚动条 thumb 用 border 变量）。

## 8. 明确不改

- 悬停浮层（`usageTipContent` 的行与值）：仍只报绝对 token，不加 %。
- 宿主响应、`buckets`、`models` 排序、`formatTokens` 阶梯。
- 006/007/010/011 的 INTERFACE 文件（历史规格；006 的 FR-006 由 `specs/012/spec.md` 声明收窄）。
- `DEFAULTS` 25 键、`DECLARED_HOSTS` 8 条、路由与工具入参。

## 9. 测试期望值（fixture，`makeUsageSnapshot(7)`）

总量卡：tokens 1,000,000；input 600,000 → 60%；output 300,000 → 30%；cacheRead 100,000 → 10%；
cacheWrite 0（无占比子行）；命中率 = 100,000 ÷ 700,000 = 14.3%；调用次数 30。

首条模型 `qwen/qwen3-max`：tokens 650,000；input 400,000 → 61.5%；output 200,000 → 30.8%；
cacheRead 50,000 → 7.7%；cacheWrite 0；命中率 = 50,000 ÷ 450,000 = 11.1%。

zh 总量卡文本片段：`输入 60.0万 占 60%`、`输出 30.0万 占 30%`、
`缓存命中 10.0万 占 10%`、`缓存写入 0`、`缓存命中率 14.3%`、`调用次数 30`。
zh 模型行：`输入 40.0万 (61.5%) · 输出 20.0万 (30.8%) · 缓存命中 5.0万 (7.7%) · 缓存写入 0 · 命中率 11.1%`。

## 10. 实施记录（2026-11-14）

门禁（`D:/Node/node.exe`，cwd=仓库，TEMP/TMP 指向 `~/.dsh/tmp`）：
host **855**（不变）／client **856**（793→856，第 12 节净增 63 条）／guards **360**（330→360，第 12 节 30 条），
全 0 failed；check-manifest OK（0.5.0、出站 8）、check-docs OK（配置键 25、数据源 8、计数一致）、
check-refs OK（69 活文档）、check-submission OK（category=usage）。

与本文档的偏离（实现时定，均已写进测试/守卫）：

1. **删掉 520px 断点的 `.tpq-usage-split:last-child{grid-column:1/-1}` 补丁** —— 5 格时最后一项跨列，
   6 格偶数两列刚好排满，保留会造成空行。
2. **011 悬停浮层的行标签随 `COPY.usageSplit*` 一起中文化**（浮层值仍只有绝对 token、不加 %）。
   这是共享键的必然结果，属预期内变化。
3. 占比子行字号取 **10.5px**（本文档只说「小一号、由 `label-tertiary` 降级」，未钉字号）。
4. 截图启动参数带 `--hide-scrollbars`（全流水线既有设定），所以 `usage-composition-2d.png` 里
   看不到滚动条像素；内滚动以「第 5 行被裁 15px + `scrollHeight > clientHeight`」断言体现，
   该 caveat 写在 `scripts/shots/README.md` ⑮ 段。

截图实测（1280×860、DPR 1）：`docs/images/usage-composition-2d.png` 116,991 B、
`docs/images/en/usage-composition-2d.png` 95,380 B；模型列表视口 252 / 内容 474；
首行占比 61.5 / 30.8 / 7.7 / 0 与命中率 11.1%；总量卡命中率 27.6%（shots fixture 逐日 57/13/24/6）。

守卫可失败性实证（临时副本，验证后删除）：把 `"data-usage-models-scroll": "1"` 改成 `"0"`、
在 `usageSplitCell` 体内插入 `"%" ` 字面量、把 zh `usageSplitInput` 退回 `"input"`，
三者各触发一次 FAIL（均 359 通过 / 1 失败），证明第 12 节不是空转。

