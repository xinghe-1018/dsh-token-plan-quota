# 021 实现计划（plan）

## 1 结论先写

在 Badge 面板的 `.tpq-body` 里，把底部的「更新于」`.tpq-updated` 与「用量统计」`.tpq-usage-entry` 包进新的 `div.tpq-panel-foot`，用 `position:sticky;bottom:0` 粘在滚动容器可视底边，负外边距抵消 `.tpq-body` 的 `padding:12px 14px` 铺满整宽，背景取面板同一个主题变量，与内容之间由 `.tpq-updated` 自带的上描边分界。两按钮永远完整可见，内容在它们上方滚动。零新路由、零配置键、零依赖、零出站主机、零 COPY 键变化。

## 2 非目标

- 不改面板锚定几何（`spaceAbove`/`bodyMax`/52vh,460 上限）与拖拽/缩放逻辑。
- 不改 `PANEL_MIN_W/H`、不改 localStorage 里悬浮矩形的格式与键名。
- 不把底栏移出 `.tpq-body`（两段式方案，见方案 B）。
- 不新增按钮、不改按钮点击行为、不改 "更新于" 时间格式。
- 不改 `.tpq-usage-entry` 的显示条件（仍只在 `usageStats !== false` 且宿主有 `onOpenUsage` 时出现）。
- 不新增/删除 COPY 文案键。

## 3 前提核验

| # | 前提 | 核验 | 证据 |
|---|---|---|---|
| 1 | `.tpq-body` 是面板里唯一的滚动容器 | ✅ | `.tpq-body{max-height:min(52vh,460px);overflow:auto;padding:12px 14px}`；悬浮态 `.tpq-panel[data-float=1] .tpq-body{max-height:none;height:100%}` |
| 2 | 两按钮目前是 `.tpq-body` 最后两个子元素，随内容滚动 | ✅ | Badge 的 children：title → ThroughputBlock? → CardDetail × N → `button.tpq-updated` → `button.tpq-usage-entry`? |
| 3 | 半截/被裁问题可复现 | ✅ | `evidence/panel-before.json` 锚定态：entry `visiblePx=0`、`overflowBottomPx=32`；悬浮最小高度态：updated 露 20.9/26、entry 全裁 |
| 4 | 缩放手柄在面板上、不在 body 里 | ✅ | `.tpq-resize{position:absolute;right:0;bottom:0;width:18px;height:18px}`，是 panelEl 的直接子元素（body 之后） |
| 5 | 面板底色是主题变量，深浅主题共用 | ✅ | `.tpq-panel{background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e))}` |
| 6 | 悬浮矩形跨刷新保留，半截状态会被"记住" | ✅ | `FLOAT_KEY="dsh-token-plan-quota.panel"`，`loadFloatBox/saveFloatBox` |
| 7 | sticky 在滚动容器内可用，且不被内容的 margin 折叠破坏 | ✅ | `.tpq-body` 不是 flex/grid，sticky 相对 scrollport；foot 用负外边距抵消 padding |

## 4 方案取舍

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| A `sticky` 底栏（foot 留在 body 内） | JSX 包一层 + 一段 CSS | 结构与 CSS 变化最小；沿用 body 现有滚动与悬浮态 `height:100%`；无需重算高度 | **采纳** |
| B 两段式：footer 移出 `.tpq-body`，body 只滚内容 | 结构更"干净" | 悬浮态 `height:100%` 要改成 flex 列；`.tpq-body` 的 padding/圆角/滚动条全要重对齐；resize 命中区与锚定几何回归面大 | 否决 |
| C 只把 `bodyMax` 减去底栏高度 | 不动结构 | 高度由 JS 按 `spaceAbove` 算，三情形（锚定/悬浮/长内容）混算，任何一处漏减都会重现半截；且悬浮最小高度 160px 下减完可能无内容区 | 否决 |
| D 绝对定位 footer + body padding-bottom 占位 | 视觉可控 | 要同步知到底栏高度写死占位，中英文/主题下按钮高度会变，占位值迟早漂 | 否决 |

Chosen：A。

## 5 设计

- **DOM**：`.tpq-body` 的 children 末尾变成单个 `div.tpq-panel-foot`，里面依次是 `button.tpq-updated`、`button.tpq-usage-entry`（后者条件不变）。`.tpq-resize` 仍是 panelEl 的直接子元素（不进入 foot）。
- **CSS**（新增一段，接在 `.tpq-usage-entry` 规则之后）：

      .tpq-panel-foot{position:sticky;bottom:0;z-index:1;margin:8px -14px -12px;padding:0 14px 8px;
       background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e))}
      .tpq-panel-foot>.tpq-updated{margin-top:0}
      .tpq-panel-foot>.tpq-usage-entry{margin-top:4px}
      .tpq-panel-foot>.tpq-updated:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);
       outline-offset:2px}

- **视觉分界**：底栏自身不画上边框，由 `.tpq-updated` 既有的 `border-top` 充当（保持既有 2.0 视觉节奏，不出现双线）。
- **不透明度**：背景必须是面板同一变量（不透明色），否则滚动内容会从底栏后面透出来；不写 `#fff`/`#1e1e1e` 字面量。
- **缩放角**：底栏不设高于 `.tpq-resize` 的层级（`.tpq-resize` 在 panel 上、后绘制），右下 18×18 仍可命中；foot 的右 padding 14 已让按钮右缘离面板边 14px，仅底栏右下角与手柄有 4px 内缩重叠，不影响手柄点击。
- **键盘**：两按钮仍是原生 `button`，Tab 顺序不变；`.tpq-usage-entry` 既有 `:focus-visible` 品牌色 2px 保留，新增 `.tpq-updated:focus-visible` 同一口径。

## 6 失败模式与兜底

- **悬浮态 `height:100%` 下 sticky 失效**：`.tpq-body` 固定高度且内容更高时 sticky 生效；内容更矮时底栏自然排在内容后，仍完整可见（此时不需要粘底）。
- **内容很短（无滚动）**：foot 处于静态位置，`margin:8px -14px -12px` 仍会铺满并贴住 body 底，不产生额外空白；负下外边距被 body 的 12px padding 吸收。
- **横向溢出**：负外边距正好抵消 14px 左右 padding，`scrollWidth` 不应大于 `clientWidth`；验收里断无横向滚动。
- **底栏与 resize 手柄相撞**：手柄 DOM 顺序在 panel 末尾，绘制在上；验收里用 `elementFromPoint` 断言还是 `.tpq-resize`。
- **老宿主 / 无 portal 路径**：结构变化不依赖 portal，两种路径都渲染同一棵树。
- **已知盲点**：sticky 的贴边位置依赖 `.tpq-body` 的 padding 与 scrollport 定义，不同浏览器可能差 1–2px；判据用"按钮完整可见（visiblePx == 高度）"而不是像素级贴边值。

## 7 UI 状态表

| 状态 | 期望 |
|---|---|
| 默认锚定态（含吞吐块/多卡，内容被 52vh 上限夹） | 底栏贴在面板底部，两按钮完整；内容在其上方滚动 |
| 悬浮态、拖到最小高度（160px） | 底栏完整可见，其余内容滚 |
| 多卡 + 吞吐块的超长内容 | 底栏不动，内容滚，滚动条仍在 |
| `usageStats:false` 或无 `onOpenUsage` | foot 里只有「更新于」，底栏仍粘底 |
| 中/英界面 | 文案变化不影响粘底与完整性 |
| 深/浅主题 | 底栏背景与面板一致，无白条/黑条 |
| 鼠标在右下角 | 命中的仍是 `.tpq-resize`，可拖拽缩放 |

## 8 测试计划

- **client 静态/DOM**：foot 存在且是 body 最后一个子元素；foot 直接子元素是 updated（+ 可选 entry）；entry 条件渲染不变；`.tpq-resize` 仍是 panel 直接子元素。
- **client CSS**：foot 规则含 `position:sticky`、`bottom:0`、背景走 `var(--dsw-alias-bg-overlay`，不含 `position:absolute`、不含 `#fff`/`#1e1e1e` 字面量；updated/entry 的 margin 覆写存在；updated 的 `:focus-visible` 品牌色 2px 存在。
- **guards 静态矩阵（第 21 节）**：同上再加"底栏不抢 resize 层级"（foot 无 `z-index` 高于手柄 / 手柄仍在 panel 上）、"COPY 键数不变"。
- **行为/视觉（CDP）**：三情形各量一次 rect——`entry.bottom <= body.bottom`、`visiblePx == height`、`overflowBottomPx <= 0`；`body.scrollWidth <= body.clientWidth`；`elementFromPoint(手柄中心).className == "tpq-resize"`；中英各一轮，深浅主题各一轮，截图入 `~/.dsh/tmp/shots-020/evidence/`。

## 9 步骤（每步一 commit）

1. `fix(panel)`：Badge children 包 `.tpq-panel-foot` + 新增 CSS（sticky 底栏、focus ring）。
2. `test(panel)`：结构、CSS、条件渲染与 resize 命中断言。
3. `docs(panel)`：README 中英计数、CHANGELOG、本 spec 记录与证据路径。

## 10 Retro（提交后补写）

- **实际 diff 与计划一致**：Badge children 加一层 `div.tpq-panel-foot`（两按钮原样搬进去），CSS 新增 4 条规则（底栏 + 两个子选择器间距 + updated 焦点环）。没有新增文案键、配置键、路由、出站主机、依赖；没有改锚定几何、拖拽/缩放、localStorage 格式、面板最小尺寸。
- **断言计数**：client 1346 → 1358，guards 592 → 603，host 1037 不变。
- **计划外发现（重要）**：初稿给底栏写了 `z-index:1`，想着"必须盖住滚动内容"。实际上 sticky 元素本身就是定位元素，不设 z-index 也画在普通流内容之上；而 `z-index:1` 会形成层叠上下文，压过面板里 `z-index:auto` 的绝对定位 `.tpq-resize` 手柄，右下角 18×18 的拖拽区变成点不到。是"手柄仍可点 + `elementFromPoint` 命中 `tpq-resize`"这条验收把它拦下来的——纯静态断言（含"不用 position:absolute"）都放过了它。教训：**绘制层的断言不能只看 position，还要看 z-index 会不会把后画的兄弟节点压住**。
- **证据可证伪性**：修复前锚定态 entry `visiblePx=0 / overflowBottomPx=32`、悬浮最小高度态连 updated 都被切 5px；修复后要求三情形（锚定 / 悬浮最小 / 长内容）都满足 `entry.visiblePx == height`、`overflowBottomPx <= 0`、`foot.bottom <= body.bottom + 0.5`、`body.scrollWidth <= clientWidth`、手柄命中、底栏背景不透明、两按钮焦点环 2px 品牌色；中英两界面、深浅两主题各跑一轮。证据落 `~/.dsh/tmp/shots-020/evidence/`（panel-before.json / panel-after.json，不入库）。
- **半截状态为何跨刷新保留**：悬浮面板的矩形存在 `localStorage` 的 `dsh-token-plan-quota.panel` 里（`loadFloatBox`/`saveFloatBox`），所以旧代码拖小过一次就一直是半截。本次不改这个格式，只让底栏不受高度影响。
- **验收结论（CDP）**：`panel-after.json` 的 `verdict=pinned-ok`——锚定态 entry 370..396 全可见（`overflowBottom=-20`）、
  悬浮 280×160 下 body 182/514 可滚且 updated/entry 各 26px 全可见、160→420 十一档 sweep 全 `entryFullyVisible`、
  `elementFromPoint` 命中 `.tpq-resize`。
- **验收揪出的真回归**：悬浮态 `height:100%` 那条规则写的是 `.tpq-panel[data-float=1]`，属性值不带引号 ⇒
  **无效选择器**（值不能以数字开头），整条被浏览器丢弃：悬浮态 `height:100%` 与 `box-shadow` 一直是死规则。
  首轮验收只按 body 相对可见性判定，把「body 被面板裁掉」误判成「可见」；改成以真正裁切祖先（`clipBy=tpq-body`）
  为准才暴露。教训：**验收要量真正裁切元素与可见像素，不要量被裁元素自身 rect**。
- **遗留观察（非本次引入）**：锚定态面板 `y=-18`、顶部约 17px 出视口（`spaceAbove=409` 而 panel 435），
  是 017 锚定几何里 content-box padding 累加的口径问题；不属于 021 范围，记录待单独处理。
