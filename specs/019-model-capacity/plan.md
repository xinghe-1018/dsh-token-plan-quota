# 019 实现计划（plan）

## 1 结论先写

宿主加一个纯函数把每模型四类 perCredit 乘成容量（一个字段），客户端加一个带 `useState` 的小组件（选择器 + 结果卡），插入到折算行之后、模型列表之前。零新路由、零配置键、零依赖、零出站主机。

## 2 备选方案与否决理由

- **A（否决）只在客户端现算，宿主不动**：`perCredit × total` 客户端完全算得出，改动最小。否决理由：与 017 的 `capacity` 字段口径分裂（一个宿主算、一个客户端算），静态守卫无法断言「分项之和 = 总量」这类不变量，且将来若改取整规则要改两处。
- **B（否决）宿主只给 blended 容量 `round(tokensPerCredit × total)`**：与用户想看的「输入/缓存命中/输出各多少」不匹配，且分项相加与总量不等会让人怀疑数字错。
- **C（采纳）宿主给四类取整后相加**：卡片自洽、守卫可断言、客户端只做展示与兜底。
- **D（否决）把选择器做成原生 `<select>`**：样式与主题变量难对齐，下拉展开态在宿主的 main 座位里可能被裁切（座位 overflow:hidden），chip 按钮更稳且可键盘操作。
- **E（否决）让模型列表的每行变成选中项**：模型列表要求定高内滚（012/016 的形状），混入选中态会让列表语义与可测性变复杂；独立卡片更直白。

## 3 宿主改动面（lib/index.js）

- 新增纯函数 `modelsWithCapacity(models, total)`：入参是 `creditsModelRatios` 的结果数组与 `cycle.total`；返回新数组（不原地改），每项加 `capacity: { tokens, classes: { input, cacheRead, output, cacheWrite } }`。`capacity.tokens` 取四类之和。
- `composeCreditsToken` 里把 `models: creditsModelRatios(...)` 改成 `models: modelsWithCapacity(creditsModelRatios(...), cycle.total)`。
- `creditsModelRatios` 本体不动（保持 016 契约，既有 100+ 条断言不变）。
- `__internals` 导出 `modelsWithCapacity`。

## 4 客户端改动面（lib/client.js）

- 新组件 `UsageCreditsModelPick({ copy, models, total })`（函数组件，用 `React.useState` 存选中的 `id`；无选中或选中项已消失时回落到第一个可用项，**渲染期只读不 setState**）。
- 新纯函数 `usageCreditsModelPicks(copy, models, total)`？不必：可用性判定写在组件里的一个小 helper `usableModelOf(item, total)`，纯逻辑易测（导进 `__internals`）。决定：导出 `usageModelCapacityOf(item, total)`（返回 `{tokens, classes}|null`）与 `usageModelPickLabel(item, models)`（重名时带 provider 前缀）。
- 插入位置：`estimate` 之后、`dailyLine` 之后、`modelsBlock` 之前（读者路径：总折算 → 单模型假设 → 各模型明细）。
- 文案 4 键；单位复用 `usageCreditsClassesUnit`；分项标签复用 `usageSplitInput` / `usageSplitCacheRead` / `usageSplitOutput` / `usageSplitCacheWrite`（不新增重复标签）。

## 5 视觉与交互

- 块本身 `display:flex;flex-direction:column;gap:8px`，不加 margin（父容器已有 `gap`，017 已踩过叠成 16px 的坑）。
- 卡片沿用 017 的 token：`background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.10))`、`border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18))`、圆角 10、padding 10/12。
- 选中 chip：`background: var(--dsw-alias-bg-layer-3, rgba(128,128,128,.18))` + `border-color: var(--dsw-alias-label-primary, inherit)` + `color: var(--dsw-alias-label-primary, inherit)`。**不许用 brand-primary 当底色**（深色主题下它是 ink #f9fafb，白字会消失）。
- 大数字 22px/600，分项 14px/600，标签 11px，单位 10.5px；`tabular-nums`；≤520px 时三列变两列。
- chip 是 `<button type="button">`，`aria-pressed`，键盘 Enter/Space 天然可用；`role="group"` + `aria-label` 给选择器整体命名；`title` 放完整 `provider/model` id。

## 6 失败模式与兜底

- 旧宿主（无 `capacity`）→ 客户端 `tokensPerCredit × total` 兜底；`total` 也非有限 → 整块不渲染。
- `credits.total` 为 0/NaN → 宿主不写 `capacity`；客户端整块不渲染（不印 0 或 —）。
- 模型重名（同一 `model` 两个 provider）→ chip 标签自动带 provider 前缀，避免选中混淆。
- 写盘/官方读数失败（比值的既有失败态）→ 整块随 ratio 缺失自然不出现，无需额外分支。
- 数字过大：`formatTokens` 走万/亿与 K/M/B，不产生科学计数法；卡片 `overflow-wrap:anywhere` 防溢出。

## 7 测试计划

- 宿主：`modelsWithCapacity` 的四类乘积、取整、和自洽、`total` 非有限时无字段、空数组/脏数组、不改原数组；`composeCreditsToken` 有/无 daily 时都用 `cycle.total`；`__internals` 暴露。
- 客户端：`usageModelCapacityOf`（capacity 优先、兜底、null/NaN/负数）、`usageModelPickLabel`（重名带 provider）、组件 DOM（section 钩子、chip 数量与 `data-selected`/`aria-pressed`、默认选中第一项、点击第二项后数字变化、三格/四格规则、单位、无 `%`/`Credits`、插入顺序）、旧宿主兜底渲染。
- guards：静态矩阵（宿主函数与字段、compose 调用点、客户端纯函数与 DOM 钩子、选中态不写死 color/white、COPY 计数与逐字、README 与 CHANGELOG 断言、specs 四件存在）。
- 截图：新场景 ⑱ 在 Credits 区点击第二个模型 chip，断言卡片数字逐位等于 fixture 推导值，出中英两张图。

## 8 风险

- 数字观感：单模型容量的量级与总容量差很多（缓存命中占比高的模型容量极大），文案必须写清「折算参考」，否则会被误读成官方额度。
- 用户已连续两轮对卡片视觉提意见（017 太突兀、019 之前 018 出框），本块的选中 chip 要克制，不加阴影、不加渐变。