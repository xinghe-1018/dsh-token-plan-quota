# INTERFACE — 011 悬停浮层（实现唯一真值）

> 冲突时以本文件为准。宿主零改动。

## 1. 范围

- 只改 `lib/client.js`（+ `test/client.mjs`、`test/guards.mjs`、`scripts/shots/*`、文档）。
- 不改 `lib/index.js` / `lib/usage-stats.js` / `test/host.mjs`：`buckets[]` 已含 `from/to/label/totals`。
- 无新配置键、无新路由、无新出站主机、无新 i18n 键（COPY 键数保持 zh/en 各 134）。

## 2. DOM 契约

### 2.1 柱子（命中区）

```js
React.createElement("g", {
  key: "bar-" + index,
  className: threeD ? "tpq-usage-bar3d" : "tpq-usage-bar2d",   // 保留既有 CSS 类
  "data-usage-bar": "1",
  "data-usage-bar-index": String(index),
  "data-usage-bar-from": from,
  "data-usage-bar-to": to,
  tabIndex: 0,
  role: "img",
  "aria-label": usageBucketTitle(bucket, copy),                 // 与浮层同一份文本
  onPointerEnter / onPointerMove / onPointerLeave / onPointerDown: ...,
  onFocus / onBlur: ...,
})
```

- 2D 的 `<rect>`、3D 的三个 `<polygon>` 都在这个 `g` 里，事件冒泡即可命中。
- **不渲染 `<title>`**（原生提示会与浮层同时出现）。

### 2.2 浮层

只在 hover/focus 命中时渲染（未命中时**不渲染节点**，不用 CSS 隐藏）：

```js
React.createElement("div", {
  className: "tpq-usage-tip",
  role: "tooltip",
  "data-usage-tip": "1",
  "data-usage-tip-index": String(index),
  style: { left: px, top: px },        // fixed（portal）或 absolute（回退）
}, [
  div[data-usage-tip-range]  // "2026-10-22" 或 "2026-09-01 – 2026-09-07"
  div[data-usage-tip-tokens] // formatTokens(totals.tokens) + copy.usageTokensUnit
  row[data-usage-tip-input] / -output / -cache-read / -cache-write / -calls   // copy.usageSplit* / copy.usageCalls + formatTokens
])
```

- 同一时刻**最多一个** `[data-usage-tip]`。
- `pointer-events: none`，不挡指针。
- 文案：绝对 tokens；不出现 `%`、`Credits`、估算/余量字样；英文界面不混中文。

## 3. 行为契约

| 事件 | 行为 |
|---|---|
| `pointerenter` / `pointermove`（柱） | 设置 index 与指针坐标；浮层跟随（偏移 12px） |
| `pointerleave`（柱） | 清空 index，浮层消失 |
| `pointerdown`（柱，touch） | 显示并锚到该柱（不 preventDefault，不阻断横向滚动） |
| `focus` / `blur`（柱） | 显示（锚到柱上方居中）/ 隐藏 |
| `keydown` Esc、`document` 捕获 `pointerdown`（别处）、`scroll`（捕获）、`window` blur | 隐藏 |
| `data` 变化（切区间/刷新）、`mode` 切 2D↔3D | 清空 hover 状态（index 越界不渲染） |

位置规则：
- portal + `position: fixed`：`left = clientX + 12`、`top = clientY + 12`；量到浮层尺寸后夹紧到
  `[8, innerWidth - w - 8]` × `[8, innerHeight - h - 8]`；右/下放不下时翻到指针左/上侧。
- 无 react-dom（`canPortal === false`）：`position: absolute` 在图表容器内，锚到柱中心上方，夹紧容器宽度。

## 4. 验收口径（与 spec §SC 对应）

- SC-001 内容与 fixture 逐字相等（首行日期、总量、四类拆分、调用次数）。
- SC-002 2D 与 3D 同一根柱内容一致（同一 `usageBucketTitle` 逻辑）。
- SC-003 周桶首行是 `from – to`（U+2013，两端各一个空格）。
- SC-004 视口夹紧（测试注入 `innerWidth/innerHeight` 与指针坐标后断言四边 ≥8px）。
- SC-005 关闭通路；`[data-usage-tip]` 计数 ≤1。
- SC-006 focus/blur 与 aria-label 同源。
- SC-007 中英无 `%`/Credits、英文不混中文。
- SC-008 柱高/刻度/峰值标签零改动（既有 host/client 断言 + 截图回归）。

## 5. 测试钩子清单（client T011 与 guards §11 依赖）

`data-usage-bar`、`data-usage-bar-index`、`data-usage-bar-from`、`data-usage-bar-to`、
`data-usage-tip`、`data-usage-tip-index`、`data-usage-tip-range`、`data-usage-tip-tokens`、
`data-usage-tip-input`、`data-usage-tip-output`、`data-usage-tip-cache-read`、
`data-usage-tip-cache-write`、`data-usage-tip-calls`。

## 6. 截图契约

- 场景 ⑭：2026-10 月度视图 → `mouse.move` 到 10-22 柱中心 → 等 `[data-usage-tip]` →
  断言 `[data-usage-tip-tokens]` 含 fixture 该日总量、`[data-usage-tip-range]` 含 `2026-10-22`、
  页面无 `%`/Credits → 拍 `docs/images/usage-tooltip-2d.png`（zh）与 `docs/images/en/usage-tooltip-2d.png`（en）。
- `--shots` 默认集合追加 14。

## 7. 实施记录（T007 回填，2026-11-14）

**计数（`npm run check` 七步实测）**：host 855 / client 793（+98，含旧「每柱带 `<title>`」拆成 2 条的回归）/ guards 330（+31，第 11 节）；
check-manifest / check-docs / check-refs / check-submission 全 OK，`DEFAULTS` 仍 25 键、出站主机仍 8 条、COPY 仍 zh/en 各 134。

**与 §2/§3 的偏离（均为实现需要，已在 `test/client.mjs` 与 `test/guards.mjs` 里各留断言）**：

1. 每根柱额外渲染透明命中 `<rect class="tpq-usage-hit">`：tokens=0 的柱高度为 0，没有命中面积就悬停不到。
2. 浮层 `style` 同时带 `position`（`fixed` / `absolute`）：portal 与内联两条路径共用一份样式。
3. 图表外面多一层 `div.tpq-usage-chart-wrap`：浮层内联回退时需要容器内绝对定位的参照。
4. `canPortal` 在图表内部按 `typeof createPortal === "function"` 重算，而不是复用屏级常量。
5. 数据变化时用「代次 key」(`dataRef` + `hoverGen`) 让旧悬停失效，而不是在渲染期 `setState` 清空（避免 React 警告与多一次渲染）。
6. `Esc` / `blur` 挂 `window`，`pointerdown` / `scroll` 挂 `document` 捕获阶段：整页屏已有 `document` 级 `keydown`（关屏），图表再挂一个会连带关掉面板。
7. `pointermove` 未节流：单柱宽度 ≥ 12px，移动事件量级远低于滚动，节流反而让浮层落后指针。
8. 触屏 `pointerdown` 之后 `pointerleave` 仍关闭（未引入 pinned 状态）：INTERFACE 只要求「显示并锚定、不阻断滚动」。
9. 发现既有 20 处 `font-variant-numeric` 写成逗号分隔（无效值），本节的浮层规则按空格分隔写对；老规则未动（不在 011 范围）。

**截图与场景 ⑭ 的实测**：zh `docs/images/usage-tooltip-2d.png`、en `docs/images/en/usage-tooltip-2d.png`，均 1280×860、DPR1、
2026-10 月度视图、悬停 10-22 柱（1,403,000 tokens；界面 zh「140.3万」/ en「1.40M」），浮层四边 `[948,468]–[1096,622]`
在 `[8, 1272]×[8, 852]` 内。场景 ⑭ 还断言了锚柱的 `data-usage-bar-from/to`、`index=21`、`role=img`、`tabindex=0`、
`aria-label` 含日期与 tokens、浮层 `role=tooltip`、`[data-usage-tip]` 计数为 1、四类拆分与调用次数与 fixture 逐字相等、
页面无 `%`/Credits、`.tpq-usage-notes` 含「仅统计本机」。

**实现期修掉的脚本 bug**：`make-shots.mjs` 的锚柱探针把 selector `JSON.stringify` 了两次，页面 `querySelector`
收到带外层引号的非法选择器（`SyntaxError: not a valid selector`）；改单次 stringify 后通过。
