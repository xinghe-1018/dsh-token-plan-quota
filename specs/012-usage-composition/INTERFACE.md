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

## 11. 复核记录（012 复核，2026-11-14）

工具：本机 `ocr`（OpenCodeReview v1.12.7，provider `dashscope-tokenplan` / `qwen3.8-flash`），
`ocr review --from b49c258 --to HEAD --format json --audience agent --effort medium --max-tools 40
--exclude test/**,scripts/**,specs/**,docs/**`，只审产品代码。耗时 16m49s、1.9M tokens、59 次工具调用
（stdout 报 status failed 是收尾写会话文件 Access is denied，落盘 JSON 实为 complete、10 条 comments；
以 JSON 为准）。10 条**全部落在 `lib/client.js`**，按严重度处置如下。

| # | 级别 / 类别 | 结论 | 处置 |
|---|---|---|---|
| 1 | medium / bug | `weekly` 仍在 `data` 可能为 null 时解引用 | 改 `data !== null && data !== undefined && data.granularity === "week"` |
| 2 | medium / maintainability | 总量卡手抄了 `usageHitRateText` 内部的三次有限数归一 | 抽 `usageHitRateBase(totals)`，两处共用并导出 `__internals` |
| 3 | medium / bug | 内联浮层用 SVG 用户坐标定位，未补 svg 居中与滚动位移 | 新增 `usageTipInlineOffsetX(scrollElement)`，`x: localCenter + offsetX` |
| 4 | low / style | 浮层锚定坐标是嵌套三元，混了「是否指针」与「坐标可用」 | 抽 `usageTipAnchorOf(value, fallback)`，三个锚点各取一次 |
| 5 | low / performance | 每根柱 `pointermove` 都新建 hover 对象 → 90 桶时每次移动重建约 540 个闭包 | 柱子树整体 `React.useMemo`，依赖只放 `tipIndex`（跨柱才重建） |
| 6 | medium / bug | 浮层 `var(--tpq-font)` 在 portal 到 `body` 后失效 | `.tpq-usage-tip` 规则自带 `--tpq-font` |
| 7 | medium / bug | 透明命中 rect 作为数组子节点缺 `key` | 加 `key: "hit"` |
| 8 | medium / bug | 外层 `<svg role="img">` 是 Children-Presentational，剪掉每柱 `tabIndex`/`aria-label` | svg 改 `role="group"`（浮层 id / `aria-describedby` 那半在第二轮被撤回，见 §12） |
| 9 | low / bug | 3D 命中区往右扩（`barWidth + ISO_DEPTH`），左侧可见面反而不接指针 | 改 `x - barWidth/2`、`width: barWidth*1.5`、高度补 `ISO_DEPTH` |
| 10 | low / bug | 占比 0 只有 cacheWrite 单点判断，其余三类印「占 0%」 | 0 值守卫收进 `usageShareText` / `usagePercentSuffix` |

> §11 的计数（client 875 / guards 377）是**第一轮**的终态；第二轮又修了 7 条，终态见 §12（client 884 / guards 384）。

**不改的两条**（复核已判定为 011 记录的既有偏差，本次不动）：`canPortal` 在图表内重算（011 §7 偏差 #4）、
`USAGE_TIP_W/H` 保守估计（011 §7 偏差）。另发现既有 CSS 约 20 处 `font-variant-numeric` 用逗号分隔（无效声明，
计算值回落 `normal`）——本次新增规则用的是空格写法，**旧规则未批量修**：改动会重拍 13 张历史截图，
收益只是数字略等宽，留作后续单独一次改动。

唯一对外可见的行为变化：占比子行在值 ≤ 0 时不再出现（与规格「>0 才显」一致）。

门禁（复核修复后，同一套命令）：host **855**（不变）／client **875**（856→875，T013 段 15 条）／
guards **377**（360→377，第 13 节 17 条），全 0 failed；check-manifest OK（0.5.0、出站 8）、
check-docs OK（配置键 25、数据源 8、计数一致）、check-refs OK（69 活文档）、check-submission OK（category=usage）。

截图复验：`--tpq-font` 落进浮层规则后字高有变化（浮层 154→151 px），011/012 那两张悬停图与代码不再一致，
已按 ⑭ 场景重拍中英各一张（`docs/images/usage-tooltip-2d.png` 114,564→117,010 B、
`docs/images/en/usage-tooltip-2d.png` 106,455→108,351 B，1280×860 DPR 1；锚柱 2026-10-22 / 1,403,000 tokens，
浮层 rect [948,486]–[1096,637]，四边在视口 8px 夹紧内，⑭ 的 DOM 断言全部照旧通过）。
本机补充：本次会话工作区是 `~/.dsh` 本身，Chromium 沙箱在带 DSH 保护标记 ACL 的目录下起子进程会
`Target crashed`（连 `data:` 页也起不来），临时注入 `--no-sandbox` 才拍成；该注入未进仓库，出图后即回滚。

守卫可失败性实证（临时副本 `~/.dsh/tmp/proof-013b`，逐条改回旧写法、每改一次复原后基线 875／377 全绿）：
把 3D 命中区 `x` 改回 `x` → client T013 1 条红 + guards 第 13 节 1 条红；去掉 `"aria-describedby"` → 各 1 条红；
`usageShareText` 去掉 `value <= 0` → client 6 条红（0／负数／NaN／字符串四个直测 + 模型行 + 总量卡）与 guards 1 条红；
把浮层规则里的 `--tpq-font` 改名 → client 与 guards 各 1 条红。四处都证明新断言不是空转。

## 12. 复核第二轮（2026-11-14，对修复提交再跑一遍）

工具同 §11，只是把范围收窄到修复提交本身：
`ocr review --commit 64610e6 --format json --audience agent --effort medium --max-tools 50
--exclude test/**,scripts/**,specs/**,docs/**,*.md`。耗时 16m22s、2.3M tokens、66 次工具调用
（stdout 又是 `status failed` + 会话文件 `Access is denied`，落盘 JSON 为 complete、7 条 comments，
以 JSON 为准——两次都这样，是本机 ocr 收尾写会话目录的偶发权限问题，与评审结果无关）。
7 条**全部落在 `lib/client.js`**，全部处理：

| # | 级别 / 类别 | 结论 | 处置 |
|---|---|---|---|
| 1 | **high** / bug | 内联浮层补偿读 `svgElement.offsetLeft`，而 `.tpq-usage-scroll` 的子节点是 `SVGSVGElement`（不实现 offsetLeft）→ 真机恒 `undefined`，居中补偿永远是 0 | 改两份 `getBoundingClientRect().left` 相减（差已含居中留白与滚动位移），并对容器与矩形都做函数存在性检查，非数回 0 |
| 2 | medium / bug | 上一轮加的 `aria-describedby` 与柱子 `aria-label` 内容重复，读屏把同一桶念两遍 | 浮层改 `aria-hidden="true"` 纯视觉；删 `USAGE_TIP_ID` 与 `aria-describedby`，`aria-label` 是唯一数字来源 |
| 3 | medium / test | 导出的三个纯函数（`usageTipAnchorOf` / `usageTipInlineOffsetX` / `usageHitRateBase`）没有测试 | T013 补 9 条：null / 空串 / 数组 / 布尔 / 非数矩形 → 兜底不返 NaN；SVG 与容器矩形相减；`usageFiniteToken` 边界 |
| 4 | low / maintainability | 「number 且有限否则 0」的归一化出现三份手抄 | 收成模块级 `usageFiniteToken(value)`，占比 / 后缀 / 命中率分子与分母都调它（并导出到 `__internals`） |
| 5 | low / bug | `usageTipAnchorOf` 用 `Number()` 强转，`Number(null)` / `Number("")` 都是 0 且通过 `isFinite` | 只认 `typeof value === "number"`，其余（含数字字符串）一律回兜底 |
| 6 | low / bug | `role="group"` 会把轴标与峰值标签也交给读屏（与柱子 `aria-label` 重复） | 两处 `<text>` 标 `aria-hidden="true"` |
| 7 | low / bug | 模型行 key 退成纯序号，降序重排时整列重挂载；空 id 行仍挂空 `title` | key 有 id 用 `"model-" + id`、缺 id 才 `"model-#" + index`；`title` 空时给 `undefined` |

顺带（由 #2 派生）：`tipIndex` 从柱子树 `useMemo` 依赖里去掉——浮层不再进无障碍树后，
指针移动只重画浮层，柱子连重建都不需要。

对外行为与截图均无变化（改的是无障碍树与内联定位正确性）。门禁：host **855**（不变）/ client **884**
（875→884）/ guards **384**（377→384），全 0 failed；check-manifest OK（0.5.0、出站 8）、
check-docs OK（配置键 25、数据源 8、计数一致）、check-refs OK（69 活文档）、check-submission OK（category=usage）。

第二轮可失败性实证：把 `usageTipInlineOffsetX` 改回读 `offsetLeft`、把 `usageTipAnchorOf` 改回 `Number(value)`、
去掉两个 `aria-hidden`、把 rowKey 改回纯序号——四处改动各自都会让 client 或 guards 至少 1 条变红。

