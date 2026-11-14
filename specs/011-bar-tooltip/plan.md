# PLAN — 011 柱子悬停看当时的 tokens

## 1. 落点

| 面 | 文件 | 说明 |
|---|---|---|
| 客户端 | `lib/client.js` | 唯一的实现改动：UsageChart 的柱组 + 浮层组件 |
| 客户端测试 | `test/client.mjs` | 新增 T011（+~45 断言） |
| 静态门禁 | `test/guards.mjs` | 新增第 11 节静态矩阵（+~18） |
| 截图 | `scripts/shots/{fixture,make-shots}.mjs`、`scripts/shots/README.md` | 场景 ⑭ 悬停取景 |
| 文档 | `README.md`、`README.en.md`、`CHANGELOG.md`、`scripts/check-docs.mjs` | 用法 + 两张图 + 计数 |
| 规格 | `specs/011-bar-tooltip/` | 本目录四件 |

宿主 `lib/index.js` / `lib/usage-stats.js` / `test/host.mjs` **不动**：`buckets` 已带 `from/to/label/totals`。

## 2. 实现要点

1. `UsageChart` 增加两个 hook 状态：`hoverIndex`（-1 = 无）与 `pointer`（`{x,y}` 视口坐标 + 来源 pointer/focus）。
2. 柱组 `<g>`：`className` 保留既有 `tpq-usage-bar2d/3d`（CSS 的 hover 透明度不变），新增
   `data-usage-bar`、`data-usage-bar-index`、`data-usage-bar-from/to`、`tabIndex`、`role="img"`、`aria-label`；
   事件 `onPointerEnter / onPointerMove / onPointerLeave / onPointerDown / onFocus / onBlur`。
   **删除** `<title>`（原生提示会和浮层打架）。
3. 浮层组件 `UsageTip`：`role="tooltip"`、`data-usage-tip="1"`，子节点带
   `data-usage-tip-range/-tokens/-input/-output/-cache-read/-cache-write/-calls`；
   位置用 `position:fixed` + `portal`（复用文件里既有的 `createPortal` / `canPortal` 判定），
   effect 里按 ref 量到尺寸后夹紧到视口（8px 边距，右下空间不足时翻到指针左/上侧）。
   无 react-dom 时退回容器内 `position:absolute` 锚到柱中心上方（同样夹紧容器宽）。
4. 关闭通路：`document` 级 `pointerdown`（捕获、点别处）、`scroll`（捕获，图表横向滚动）、`keydown` Esc、
   `window` blur；`useEffect` 注册、清理时移除。切 2D/3D、切区间（data 变化）时把 hover 清空。
5. 文案复用既有键：`usageSplitTotal/Input/Output/CacheRead/CacheWrite`、`usageCalls`、`usageTokensUnit`；
   `usageBucketTitle` 已有的拼法可以复用/改造成「多行」版本，保持 2D/3D 同源。
6. 样式：`.tpq-usage-tip`（深色浮层、11.5–12px、圆角 8、阴影、`pointer-events:none`、`z-index` 高于卡片），
   数字行左标签右值；不引入新字体、不写死主题色以外的颜色（沿用 CSS 变量，暗色主题可读）。

## 3. 失败模式与对策

| 失败模式 | 后果 | 对策 |
|---|---|---|
| 保留原生 `<title>` | 悬停 1 秒后系统提示框与浮层重叠 | 删 `<title>`，读屏靠 `aria-label` |
| 浮层被 `.tpq-usage-scroll` 裁切 | 只有指针在左半边才看得见 | `createPortal` 到 body + fixed；无 portal 时退回图表容器内 |
| 浮层越出视口 | 贴边柱子看不到数字 | ref 量尺寸 + 8px 夹紧 + 右下翻转 |
| 触屏 `pointerdown` 抢滚动 | 手机上滑不动图 | 只显示不 `preventDefault`，不改 touch-action |
| 浮层文本与总量卡口径漂移 | 两处数字对不上（如一处四舍五入） | 全部走 `formatTokens`，测试逐字比对 |
| 3D 只命中正面 | 顶面/侧面悬停无反应 | 事件挂在 `<g>` 上，三个 polygon 都冒泡 |

## 4. 测试计划

- `test/client.mjs` T011：静态钩子/aria、悬停显示与内容逐字、2D↔3D 同源、周桶区间、位置夹紧（mock 视口）、
  Esc/滚动/移出关闭、focus/blur、tokens=0、切模式清空、中英文案无 %/Credits、portal 与内联两条路径。
- `test/guards.mjs` 第 11 节：`data-usage-tip` 钩子存在；源码里不再有 `createElement("title"`（原生提示已删）；
  COPY 键数不变（zh/en 各 134）；浮层文案不含 %/Credits；`aria-label` 使用 `usageBucketTitle`；
  出站主机仍 8 条；无新配置键。
- `test/host.mjs` 零新增（宿主未改）。

## 5. 截图

场景 ⑭（zh/en）：`--shots 14`，在 2026-10 月度视图上 `mouse.move` 到某根非零柱中心
（fixture 里挑一个 tokens > 0 的日子，比如 10-22），等 `[data-usage-tip]` 出现且
`[data-usage-tip-tokens]` 等于该桶 fixture 值，断言无 %/Credits 后拍
`docs/images/usage-tooltip-2d.png`（1280×860、DPR1、整视口）。图里必须同时看到柱图与浮层。

## 6. 提交计划

1. `feat(usage): 柱状图悬停查看当日 tokens`（lib/client.js）
2. `test(usage): 悬停浮层的命中、夹紧与无障碍断言`（test/*、scripts/shots/fixture.mjs）
3. `docs(usage): 悬停提示说明与截图`（README*、CHANGELOG、check-docs、scripts/shots/make-shots.mjs、docs/images、specs/011）
