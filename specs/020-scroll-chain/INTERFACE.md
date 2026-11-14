# 020 INTERFACE（实现唯一真值）

范围：只改 `lib/client.js` 的两条 CSS 声明与 `test/client.mjs`、`test/guards.mjs` 的对应断言；零新路由、零新配置键（DEFAULTS 仍 26）、零新出站主机（仍 8）、零第三方依赖、零 COPY 键变化。

## 1 客户端契约

### 1.1 改动（逐字）

`.tpq-usage-credits-models`（用量屏 Credits 按模型块）：

前：`max-height:252px;overflow-y:auto;overscroll-behavior:contain;`
后：`max-height:252px;overflow-y:auto;overscroll-behavior:auto;`

`.tpq-usage-models`（用量屏「按模型用量」排行卡，012 遗留）：

前：`...max-height:252px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;...`
后：`...max-height:252px;overflow-y:auto;overscroll-behavior:auto;scrollbar-width:thin;...`

### 1.2 保留项（逐字，任何一项变化都算回归）

- `.tpq-usage-viewport{...;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,rgba(128,128,128,.4)) transparent}`
- `.tpq-usage-scroll{overflow-x:auto;overflow-y:hidden;max-width:100%;padding-bottom:2px;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}`
- 两个内层的 `max-height:252px`、`scrollbar-width:thin`、`scrollbar-color`、`::-webkit-scrollbar{width:8px}`、`:focus-visible` 品牌色 2px、`padding-right:4px`（Credits 块）。
- JSX：`.tpq-usage-credits-models` 的 `data-usage-credits-models="1"`/`tabIndex:0`/`role:"group"`；`.tpq-usage-models` 的 `data-usage-models-scroll="1"`/`tabIndex:0`/`role:"group"`。

### 1.3 滚动链语义（可证伪描述）

给定内层滚动容器 S 与外层视口 V：当 S.scrollTop == S.max 且继续向下时，浏览器把剩余 delta 交给 V，V.scrollTop 严格递增；反之 V 向上滚。V 到自身边界后，`overscroll-behavior:contain` 阻止宿主页面滚动。

## 2 测试契约

### 2.1 test/client.mjs

- T012 区块（.tpq-usage-models）：断言从 `overscroll-behavior:contain` 改为 `overscroll-behavior:auto`，并显式断言 `!includes('overscroll-behavior:contain')`；细滚动条、焦点环、行数断言不变。
- T102 区块（.tpq-usage-viewport）：六件套断言**不变**（仍含 contain），新增一条：内层两个列表规则不含 `overscroll-behavior:contain`。
- 断言标题文案同步改为"链式滚动"语义，不保留"contain"旧标题。

### 2.2 test/guards.mjs

- 013 小节：原「模型排行卡内滚动仍在（252px + thin + contain）」改成「内层链式滚动仍在（252px + thin + auto）」，同时**新增反向断言**：外层 viewport 必须仍含 `overscroll-behavior:contain`（放行一半：谁把外层也改成 auto 这条就红）。
- 015 小节：`.tpq-usage-credits-models` 同理——断言 `auto` 且不含 `contain`；252px/thin/焦点环不变。

### 2.3 计数

新增/修改断言后实跑三套件，按实际数字同步 README.md（三行 + 正文）、README.en.md（两处）与 CHANGELOG。

## 3 证据契约

- 修复前：`~/.dsh/tmp/shots-020/evidence/wheel-before.json`（已存在，inner/outer computed 值 + 15 步序列）。
- 修复后：`~/.dsh/tmp/shots-020/evidence/wheel-after.json`，必须带：
  - `prerequisites.inner.overscrollBehaviorY == "auto"`、`outer.overscrollBehaviorY == "contain"`
  - `series`：至少一个点满足 `innerTop == innerMax` 且 `outerTop` 比上一个点严格增大
  - 反向序列：`outerTop` 严格递减
  - `windowScrollY` 全程为 0
- 附加：中文界面一轮、2D 与 3D 视图各一轮；截图存同目录。

## 4 文档契约

- CHANGELOG：在 0.5.x 段落下新增 020 小节，写明"内层列表改为可链式滚动、外层仍防穿透"与测试计数变化。
- README.md / README.en.md：只改测试计数，不新增功能描述段落（行为修正属于修复）。
- specs/020-scroll-chain/：plan/INTERFACE 落地后补"实施记录"。

## 5 不做的事

- 不做 wheel 监听、不改 `.tpq-usage-viewport` 的 contain、不改 252px 定高与滚动条、不动横向容器、不改键盘/焦点、不新增 COPY 键、不改配置键与出站主机。

## 6 实施记录（落地后补写）

- 符号定位（用符号名，不用行号）：
  - `lib/client.js` 的 `tpqCss` 模板串里，`.tpq-usage-models` 规则的 `overscroll-behavior` 值；
  - 同串 `.tpq-usage-credits-models` 规则的同一属性；
  - 外层 `.tpq-usage-viewport` 的 `overscroll-behavior:contain` **未动**；横向容器 `.tpq-usage-scroll` 的 `overscroll-behavior-x:contain` **未动**。
- 两处都**显式写 `auto`**，没有删声明：删掉是隐式默认值，静态守卫无法断言"这里刻意放行滚动链"，将来有人加回 `contain` 也看不出意图差异。
- 012 遗留列表 `.tpq-usage-models` 确认**仍在渲染路径**（用量屏「模型排行」卡，`data-usage-models-scroll="1"`），所以一并改；它的固定 252px 定高与 `tabIndex=0` 保留。
- 断言计数变化：host 1037（不变）、client 1346 → **1358**（T012 改成成对断言并加 1 条外层 contain；T015 改 1 条；新增 021 的结构、CSS 与悬浮态选择器断言）、guards 592 → **603**（013/015 改成成对断言；新增第 20 节 4 条 + 第 21 节 7 条）。
- 偏差与裁量：
  - 没有采用备选的 wheel 监听（与原生惯性/滚动条拖动打架）；
  - 测试里把"内层 `auto`"与"外层 `contain`"写成**同一处成对断言**——这是本条最容易改一半的地方（内层放开了、外层也被顺手放开就会穿透宿主）；
  - `test/guards.mjs` 的汇总 `console.log` 原本在 `process.exitCode` 之前，把新增小节追加在文件末尾会跑到汇总之后、计数不计入，已把汇总行移到文件最后；
  - 证据脚本只做读操作（CDP `Input.dispatchMouseEvent` 发 wheel），不改页面状态、不注入假数据到写入路径。
- 修复后 CDP 验收（隔离实例 3099，1280×680，新代码已生效）：`evidence/wheel-after.json` 的 `verdict=chain-ok`。
  内层 `.tpq-usage-credits-models` 的 `overscrollBehaviorY=auto`、外层视口 `contain`、012 遗留列表 `auto`；rescoped 几何
  inner 252/648/max396、outer 680/2206/max1526、起始 `outerTop=1302`（headroom 224）。正向滚轮 4 步内层到 396 后，
  外层 1302 → 1526 同向续滚（+224），空白处对照组 `outerDelta≈226`；反向从双底位起内层 396 → 0，随后外层 1406 → 0；
  两种方向 `window.scrollY` 恒 0（不穿透宿主）。截图 `evidence/usage-after.png`。
- 反向判定的初版断言写反了（要求外层先归零、内层再递减），把真实通过误判成 `chain-partial`；改成
  「终点 inner==0 且 outer==0、inner 归零后 outer 仍单调递减、window 不滚、任何一段不增长」后才与机制一致。
