# 021 INTERFACE（实现唯一真值）

范围：只改 `lib/client.js` 的面板 JSX 结构与一段 CSS，以及 `test/client.mjs`、`test/guards.mjs`；零新路由、零配置键（仍 26）、零出站主机（仍 8）、零依赖、零 COPY 键变化。

## 1 DOM 契约

面板结构（`children` 数组，顺序固定）：

    div.tpq-panel[role="dialog"][data-float?]
      div.tpq-body[style=bodyStyle]
        div.tpq-title
        ThroughputBlock?                    (可选)
        div.tpq-card × N                    (每张额度卡)
        div.tpq-panel-foot                  ← 新增，必须是 body 的最后一个子元素
          button.tpq-updated[type=button]
          button.tpq-usage-entry[type=button]   (仅 onOpenUsage && usageStats!==false)
      div.tpq-resize                        ← 仍是 panelEl 直接子元素，不进 foot

- foot 用 `React.createElement("div", { className: "tpq-panel-foot" }, updatedButton, entryButtonOrNull)` 一次建出；`updatedButton` 与 `entryButtonOrNull` 保持现有 props（disabled/title/onClick/文案）逐字不变。
- 不新增 data-* 钩子，不加 `role`：这层是纯布局容器。
- 既有测试锚点必须继续成立：`className: "tpq-body", style: bodyStyle` 的源码形状不变。

## 2 CSS 契约（全量新增）

    .tpq-panel-foot{position:sticky;bottom:0;z-index:1;margin:8px -14px -12px;padding:0 14px 8px;
     background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e))}
    .tpq-panel-foot>.tpq-updated{margin-top:0}
    .tpq-panel-foot>.tpq-usage-entry{margin-top:4px}
    .tpq-panel-foot>.tpq-updated:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);
     outline-offset:2px}

规则定位：紧接 `.tpq-usage-entry:focus-visible` 之后，仍属于面板 CSS 区（这段在 JS 模板字符串里，**新规则与注释里不能出现反引号与美元大括号**）。

保留（逐字不动）：

- `.tpq-body{max-height:min(52vh,460px);overflow:auto;padding:12px 14px}`
- `.tpq-panel[data-float=1] .tpq-body{max-height:none;height:100%}`
- `.tpq-updated{...margin-top:8px;padding:6px 18px 2px 0;border-top:1px solid var(--dsw-alias-border-l2,...);...}`（只被 foot 子选择器覆写 margin-top）
- `.tpq-usage-entry{...margin-top:6px;padding:6px 18px 2px 0;...color:var(--dsw-alias-brand-primary,#4176e6)}` 与 `:focus-visible`
- `.tpq-resize` 全部规则与 DOM 位置。

## 3 断言契约

### 3.1 test/client.mjs

- 结构：`findNodes(tree, "tpq-panel-foot")` 恰好 1 个；其直接子节点 className 依次为 `tpq-updated`、`tpq-usage-entry`（usageStats 默认真时）；`usageStats:false` 时只有 `tpq-updated`。
- body 最后子元素是 `tpq-panel-foot`（不是 updated/entry 直接挂 body）。
- `.tpq-resize` 仍是 panel 的直接子元素（不是 foot 子节点）。
- CSS：foot 规则切片含 `position:sticky`、`bottom:0`、`var(--dsw-alias-bg-overlay`，不含 `position:absolute`、不含 `#fff`、不含 `#1e1e1e`；`margin:8px -14px -12px` 与 `padding:0 14px 8px` 存在。
- focus：foot 内 updated 的 `:focus-visible` 品牌色 2px 存在；entry 既有规则不变。
- 既有入口行为断言（点 entry → 收起面板 + selectPanel）继续通过，不改预期。

### 3.2 test/guards.mjs（新增第 21 节）

- foot 结构 + sticky 底栏 + 主题变量背景（不硬编码）；
- 两按钮仍在 foot 内、entry 条件渲染条件未变；
- resize 手柄仍在 panel 上、foot 未上移层级取代表达式（不断言具体 z-index 数值，只断言 foot 规则不出现 `position:absolute`且手柄规则仍 `position:absolute`）；
- COPY 键数不变（沿用既有计数断言）；
- 标题文案用中文，说明为什么（贴边裁切 → 用户看不到入口）。

### 3.3 计数

实跑三套件后同步 README.md（三行 + 正文）、README.en.md（两处）与 CHANGELOG。

## 4 视觉/行为验收契约

证据文件 `~/.dsh/tmp/shots-020/evidence/panel-after.json`，states 至少 `anchored`、`floatMin`、`longContent`，每个 state 断言：

- `entry.fullyVisible === true` 且 `entry.visiblePx === entry.height`（浮点容差 0.5）；
- `entry.overflowBottomPx <= 0`、`updated.fullyVisible === true`；
- `foot.bottom <= body.bottom + 0.5`（底栏贴住可视底边，不悬空）；
- `body.scrollWidth <= body.clientWidth`（无横向溢出）；
- `document.elementFromPoint(resizeCenter) === resize 元素`（手柄仍可点）；
- 中英各一轮、深浅主题各一轮；截图存同目录。

## 5 文档契约

- CHANGELOG：0.5.x 段落下新增 021 小节（固定底栏、三情形验证、测试计数变化）。
- README.md / README.en.md：只同步测试计数与（如需要）一句行为说明；不新增功能键。
- specs/021-badge-footer/：落地后补"实施记录"。

## 6 不做的事

- 不改锚定几何 / 拖拽 / 缩放 / localStorage 格式；不改面板最小尺寸；不把 footer 移出 body；不新增按钮或文案；不改 entry 的显示条件；不改滚动条与横向容器。

## 7 实施记录（落地后补写）

- 符号定位（用符号名，不用行号）：
  - `lib/client.js` 的 Badge 组件里构造 `div.tpq-body` 子节点的那段 `React.createElement` 序列（标题 → 吞吐块 → 各卡片 → 底栏）；
  - `tpqCss` 模板串里 `.tpq-usage-entry:focus-visible` 规则之后新增的 `.tpq-panel-foot` 规则组。
- 落地结构：`panel > [body, resize]`；`body > [title, ThroughputBlock?, CardDetail×N, foot]`；`foot > [updated, entry|null]`。两按钮的 props、文案、`reload(true)`、`setOpen(false) + onOpenUsage()` 与显示条件逐字未变。
- 断言计数变化：client 1346 → **1358**（新增 021 结构断言：foot 唯一且是 body 末子元素、children 顺序、原生 button、resize 不在 foot 里、CSS 四组校验、悬浮态属性选择器有效性、`usageStats:false` 时只剩 updated）；guards 592 → **603**（第 21 节 7 条）。
- 偏差与裁量：
  - 采用首选 sticky 方案，**没有**走"底栏移出 body"的两段式：后者要重新对齐悬浮态 `height:100%` 与 resize 手柄的定位基准，回归面明显更大，而 sticky 只需一段 CSS + 一层 div。
  - **刻意不设 `z-index`**：sticky 是定位元素，本身已画在滚动内容之上；一旦写 `z-index:1` 就会形成层叠上下文并压过 `z-index:auto` 的 `.tpq-resize` 手柄（手柄是面板里更靠后的绝对定位兄弟），右下角那 18×18 会点不到。初稿曾写 `z-index:1`，靠"手柄必须可点"这条验收在取证阶段发现并删掉，注释里写明了原因。
  - 底栏不画自己的上边框，分界沿用 `.tpq-updated` 自带的 `border-top`，避免双线。
  - 背景用 `var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1e1e1e))`（与 `.tpq-panel` 同一个 fallback 链）；测试断言"以 `var(--dsw-alias-bg-overlay` 开头且不出现 `background:#`/`transparent`/`rgba(`"，**不能**简单禁 `#1e1e1e` 字面量——它就是主题变量链里的 fallback。
  - `.tpq-updated` 原先没有 `:focus-visible` 规则，焦点环只在 `.tpq-close` / `.tpq-usage-entry` 上有；本次用 `.tpq-panel-foot>` 子选择器补品牌色 2px，不动全局规则。
- 验收中发现并一并修掉的既有缺陷：悬浮态 `height:100%` 那条规则的选择器旧写法是 `.tpq-panel[data-float=1]`，
  属性值不带引号，按 CSS 语法值不能以数字开头 ⇒ **无效选择器**，浏览器整条丢弃。后果是悬浮态 `height:100%` **从未生效**
  （同一写法还让 `.tpq-panel[data-float=1]{box-shadow:…}` 的悬浮阴影一直不出现）：body 被基础 `max-height:min(52vh,460px)`
  撑高、再被 `.tpq-panel` 的 `overflow:hidden` 裁掉，底栏在悬浮态无处可粘。改为 `[data-float="1"]`，并在 client/guards
  双侧加断言「带引号写法在、不带引号写法不在」。这是本 spec 被验收流程救回来的一处**真回归**，不是纯样式调整。
- 修复后 CDP 验收（隔离实例 3099，1280×860）：`evidence/panel-after.json` 的 `verdict=pinned-ok`。
  - 锚定态：body 433/458（maxHeight 409），updated 340..366、entry 370..396 全可见（`overflowBottom=-20`）；
    foot 340..404、`position:sticky`+`bottom:0`、背景 `rgb(233,236,242)`、children `[tpq-updated, tpq-usage-entry]`；
    `elementFromPoint` 命中 `.tpq-resize`（18×18）；panel children `[tpq-body, tpq-resize]`；`scrollWidth==clientWidth`。
  - 悬浮最小尺寸（localStorage 种 40,120,280×160）：body 182（=160+padding+border）/514，updated 与 entry 各 26px 全可见。
  - 高度 sweep 160→420 十一档全部 `entryFullyVisible=true`、`sweepClipped=0`。
  - 遗留观察（修复前就有、非 021 回归、本次不做）：锚定态面板 `y=-18`（`spaceAbove=409` 而 panel 435），顶部约 17px
    出视口，属 017 锚定几何里 content-box padding 累加的口径问题，已记录待单独处理。
