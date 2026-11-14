# 019 单模型容量测算（spec）

## 背景

用户（m06182）：「加一个统计功能，可以选择不同的模型来计算同一个套餐里如果只用这一个模型可以用多少tokens」。

现状：014/015/016 已经给出「1 Credit ≈ N tokens」「每 Credit 的分项」「每个模型各自的比值」，但**都是比值**，没有把「整份额度只喂一个模型能换来多少 tokens」这件事直接算成数字。用户要的是这个数，而且要能换模型看。

## 目标

- 在用量统计屏的 Credits 换算区，新增一块「如果只用这一个模型」：可选模型，显示把本账期**全部 Credits** 都花在该模型上可折合的 tokens（含输入/缓存命中/输出/缓存写入分项）。
- 数字由宿主给出的**每模型分项比值 × 额度总量**得到，口径与既有折算一致（本机实测分子 ÷ 账号级已用 Credits 分母）。
- 保持官方口径不变：不折算 Credits、不估算余量、不派生百分比；卡片明写「折算参考，非官方口径」。

## 非目标

- 不做「按模型分配额度」或预算规划；不写回任何配置。
- 不新增路由、出站主机、第三方依赖。
- 不改动既有折算行、分项卡片、模型比值列表的数值口径与位置（只在它们之间插入新块）。

## 功能需求

- **FR-001 每模型容量（宿主）**：`ratio.models[]` 每项新增 `capacity`，给出该模型在「全部额度只花在它身上」时可用的 tokens：`capacity.tokens` 与 `capacity.classes.{input,cacheRead,output,cacheWrite}`。取整规则：四类各自 `Math.round(perCredit × credits.total)`，`capacity.tokens` = 四类取整值之和（保证卡片上分项相加等于总量；与 `Math.round(tokensPerCredit × total)` 相差不超过 rounding 误差）。
- **FR-002 缺额度总量时不造数**：宿主拿不到有限 `credits.total` 时不写 `capacity` 字段（响应形状退回到 018 之前）。
- **FR-003 选择器**：客户端渲染一块可选模型的区域，默认选中 `ratio.models[0]`（宿主按 tokens 降序，即用量最大的模型），点击/键盘激活其它模型即时切换。
- **FR-004 结果卡片**：选中模型后显示该模型的折算容量大数字（`formatTokens` 口径：中文万/亿，英文 K/M/B）+ 单位 `tokens`，并按三类（输入 / 缓存命中 / 输出）给出分项容量；`cacheWrite > 0` 时追加第四格。
- **FR-005 同源兜底**：旧宿主没有 `capacity` 字段时，客户端用 `perModel.tokensPerCredit × credits.total` 现算（与总折算行同一条兜底规则），不因宿主旧版本而整块消失。
- **FR-006 整块闸门**：没有可用模型（空数组、每项 `tokensPerCredit` 都非有限）、或既无 `capacity.tokens` 又无有限 `credits.total` 时，整块不渲染（页面与 018 逐字段一致）。
- **FR-007 口径与无障碍**：卡片不出现 `%`、不出现 `Credits` 字样；选择器是原生 `button`（可 Tab、Enter/Space 激活），带 `aria-pressed`、`role="group"` 与可读标签；选中态不依赖颜色（同时改边框/底色与字色）。
- **FR-008 文案与文档**：新增 4 个 COPY 键（中英成对），两版 README 与 CHANGELOG 同源更新，配一张中英文截图。

## 成功标准

- **SC-001** 中英文界面都能选模型并看到数字切换；四类分项之和 = 卡片总量（同一模型的四格相加逐字相等）。
- **SC-002** 数字与手算一致：`capacity.tokens === Σ Math.round(perCredit_class × total)`，`0` 是真实值照实显示。
- **SC-003** 静态守卫能锁住：宿主函数与字段存在、客户端三格/四格规则、选择器 DOM 钩子与 `aria-pressed`、选中态不写死白底、COPY 计数、README 与 CHANGELOG 断言。
- **SC-004** 七步门禁在最后一次编辑之后全绿，工作树干净，三个提交分开（feat / test / docs）。

## 证据与依赖

- 运行态口径：`GET /token-plan-quota/usage-credits` 的 `ratio.models[]`（本机实测，2026-11-14 实取 5 个模型）与 `credits.total = 80000`。
- 既有实现：`creditsModelRatios`（每模型 tokens 与四类 perCredit）、`composeCreditsToken`（拼响应）、`usageCreditsClassesCard`（卡片视觉语言）、`usageCreditsModelsBlock`（模型列表）。
- 视觉约束：017 交付后按用户反馈改成主题变量（`--dsw-alias-bg-layer-2` / `--dsw-alias-border-l2` / `label-*`），本功能沿用，不写死 `#fff` / `#e6e9ef`。018 的教训：深色主题里 `--dsw-alias-brand-primary` 解析成 ink（浅 #0f1115 / 深 #f9fafb），选中态不能靠它当底色。