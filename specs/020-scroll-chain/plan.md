# 020 实现计划（plan）

## 1 结论先写

把 `lib/client.js` 里两个**内层**模型列表滚动容器的 `overscroll-behavior:contain` 改成 `auto`（显式写 auto，不删声明，守卫可以断言语义）；外层 `.tpq-usage-viewport` 的 `contain` 原样保留。零新路由、零配置键、零依赖、零出站主机、零 COPY 改动。

## 2 非目标

- 不改外层视口的 `overscroll-behavior:contain`（013 的防穿透决策，宿主 main 座位之外还有两圈 `overflow:hidden`）。
- 不改内层 252px 定高、8px 细滚动条、滚动条配色与 `:focus-visible` 焦点环。
- 不用 JS `wheel` 监听手动转发滚动（与惯性、滚动条拖动、键盘冲突，且要处理 deltaMode 与嵌套）。
- 不动横向滚动容器：`.tpq-usage-scroll` / `.tpq-usage-chart-wrap` 的 `overscroll-behavior-x:contain` 是横向语义，与本次纵向滚动链无关。
- 不改键盘滚动行为（列表仍 `tabIndex=0` + `role=group`，方向键/PageDown 照旧滚列表）。
- 不新增或修改任何 COPY 文案键。

## 3 前提核验

| # | 前提 | 核验 | 证据 |
|---|---|---|---|
| 1 | 内层 `.tpq-usage-credits-models` 用 `overscroll-behavior:contain` 阻断滚动链 | ✅ | 源码规则含 `max-height:252px;overflow-y:auto;overscroll-behavior:contain`；CDP 读到 computed `overscrollBehaviorY="contain"` |
| 2 | 症状可复现：内层到底后外层不动 | ✅ | `evidence/wheel-before.json`：15 次真实 wheel 后 innerTop 到 396（=innerMax），outerTop 恒 1302（outerMax 1526） |
| 3 | 012 遗留的 `.tpq-usage-models` 仍在渲染路径 | ✅ | 用量屏「按模型用量」section 渲染 `.tpq-usage-models[data-usage-models-scroll][tabIndex=0]`；同一证据里 alsoModels.overscrollBehaviorY="contain" |
| 4 | 外层的 contain 是故意保留 | ✅ | 013 守卫与源码注释：防止滚动穿透到宿主页面；main 座位外两圈 `overflow:hidden` |
| 5 | 浏览器原生滚动链（scroll chaining）足以修复，无需 JS | ✅ | Chromium/Gecko 默认把内层到边界后的剩余 delta 交给最近的可滚祖先；`auto` 即默认值 |
| 6 | 键盘可达性不依赖 `overscroll-behavior` | ✅ | 列表的可聚焦与滚动由 `tabIndex`/`role` 提供，CSS 只影响链式越界行为 |

## 4 方案取舍

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A 内层 `contain` → `auto` | 改两处声明，其余不动 | 无 JS、无结构变化；依赖浏览器原生 chaining | **采纳** |
| B 删除 `overscroll-behavior` 声明 | 等价于 auto（默认值） | 语义隐式，守卫只能断言"不存在"，将来有人加回来毫无阻力 | 否决（不如显式 auto 可断言） |
| C JS `wheel` 监听，内层到底后 `outer.scrollTop += deltaY` | 完全可控 | 与惯性滚动、滚动条拖动、触控板、键盘重复触发冲突；要处理 deltaMode/嵌套滚动；无障碍与性能都变差 | 否决 |
| D 去掉内层滚动容器，让整页一个长列表 | 结构最简单 | 推翻 012/016 的"定高内滚"形状（图标高度、吸顶、行数断言全变），回归面远超收益 | 否决 |

Chosen：A，显式写 `overscroll-behavior:auto`。

## 5 设计

改动表（逐字）：

| 选择器 | 位置 | 前 | 后 |
|---|---|---|---|
| `.tpq-usage-credits-models` | lib/client.js 面板外用量屏 CSS 区 | `overscroll-behavior:contain;` | `overscroll-behavior:auto;` |
| `.tpq-usage-models` | lib/client.js 模型排行卡 CSS | `overscroll-behavior:contain;` | `overscroll-behavior:auto;` |

明确保留（不动）：

- `.tpq-usage-viewport{... overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin; ...}`
- `.tpq-usage-scroll{... overscroll-behavior-x:contain; ...}`
- 两个内层的 `max-height:252px`、`scrollbar-width:thin`、`scrollbar-color`、`:focus-visible` 焦点环、`::-webkit-scrollbar` 8px。

链式语义：内层滚到底后，剩余纵向 delta 交给最近的祖先滚动容器 `.tpq-usage-viewport`，外层同向续滚；反向到顶后反向续滚；外层到自身边界后仍被 `contain` 挡住，宿主页面不滚动。

## 6 失败模式与兜底

- **外层到边界仍穿透宿主**：不成立——viewport 的 `contain` 未改；验收③断 `window.scrollY` 恒为 0。
- **滚动条拖动/惯性被劫持**：本方案零 JS，接管者仍是浏览器原生滚动。
- **旧浏览器不支持 `overscroll-behavior`**（Safari < 16）：该属性无效时等价于默认 chaining，只会更"链"，不会更坏；内层与外层都仍是原生滚动。
- **内层没有可滚空间**（行数少）：浏览器直接把 delta 交给 viewport，符合预期，无需分支。
- **横向容器被误改**：明确不动，验收⑥ 覆盖 2D/3D 图的横向滚动。
- **已知盲点**：CDP 的 `wheel` 与真实触控板惯性不同；证据用 Chromium 原生滚轮事件（`Input.dispatchMouseEvent` type=wheel），并在 JSON 里记录 `wheelEventType`，不拿合成 DOM 事件冒充。

## 7 UI 状态表

| 状态 | 期望 |
|---|---|
| 列表可内滚且未到边界 | 只滚列表，外层 scrollTop 不变 |
| 列表到底继续同向滚 | 外层 scrollTop 严格递增 |
| 列表到顶继续反向滚 | 外层 scrollTop 递减 |
| 外层到边界后继续滚 | 宿主页面 `window.scrollY` 不变（不穿透） |
| 键盘焦点在列表 | 方向键/PageDown 滚列表；Tab 顺序不变；焦点环沿 018 口径 |
| 鼠标悬停滚动条 | 8px 细滚动条与 hover 配色不变 |

## 8 测试计划

- **client 静态断言**：两个内层规则含 `overscroll-behavior:auto`、不含 `contain`；外层 viewport 规则仍含 `overscroll-behavior:contain`；252px/thin/scrollbar-color/焦点环断言不变；两处 data 钩子与 `tabIndex:0` 不变。
- **guards 静态矩阵**：013 小节改成成对断言——内层 auto（应放行的一半）**且** 外层必须仍 contain（应拦住的一半）；015 小节同步 Credits 模型块；配置键仍 26、出站仍 8。
- **行为证据（CDP 真实滚轮）**：正向序列（内层递增→max→外层递增）、反向序列（外层递减、内层递减）；中文界面 + 2D/3D 各一轮；落到 `~/.dsh/tmp/shots-020/evidence/wheel-after.json`。

## 9 步骤（每步一 commit）

1. `fix(usage)`：两个内层列表改链式滚动（含 012 遗留列表）。
2. `test(usage)`：断言从 contain 翻到 auto，并钉住外层仍 contain（放行一半）。
3. `docs(usage)`：README 中英计数、CHANGELOG、本 spec 记录与证据路径。

## 10 Retro（提交后补写）

- **实际 diff 与计划一致**：只改了两条内层 CSS 声明（`contain` → `auto`）、各加一段注释；外层视口与横向容器一字未动。没有新增 COPY 键、配置键、路由、出站主机、依赖。
- **断言计数**：client 1346 → 1358，guards 592 → 603，host 1037 不变。
- **容易改一半的地方**：内层放行、外层必须仍 `contain`。测试与 guards 都写成成对断言（内层 `auto` + 外层 `contain` 同时成立），单独改任一半都会红。
- **证据可证伪性**：修复前 wheel 序列里 15 步中内层 `scrollTop` 到 396（上限）后外层恒为 1302（上限 1526）；修复后同一序列要求"内层到 max → 外层递增 → 到 outerMax 后 windowScrollY 恒 0"，并补了反向序列（外层先回到 0、内层再递减）——正向只证明"能往下链"，反向才能证明"链是双向的、不是被 wheel 监听硬拽"。证据落 `~/.dsh/tmp/shots-020/evidence/`（wheel-before.json / wheel-after.json，不入库）。
- **计划外发现**：012 遗留的 `.tpq-usage-models` 也还带 `contain`，虽然它和 Credits 列表不同时出现在同一屏，但同样是内层列表，一起改掉才不会下一轮再被报一次。
- **验收结论（CDP，新代码生效后）**：`wheel-after.json` 的 `verdict=chain-ok`——内层 `auto`、外层 `contain`、012 列表 `auto`；
  正向 4 步内层到 396 后外层 1302 → 1526（+224，正对 headroom），反向从双底位起内层 396 → 0、随后外层 1406 → 0，
  `window.scrollY` 全程 0。
- **教学（判定脚本也会写错）**：反向断言的初版把方向写反（先要求外层归零、再要求内层递减），机制明明是
  「向上滚先让内层回到顶、再由外层继续」，结果把通过误报成 `chain-partial`。**验收脚本自己的断言也是被测对象**——
  先对照机制推一遍符号方向，再看 verdict；别让脚本的错判当成实现的错。
