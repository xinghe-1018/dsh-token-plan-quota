# 024 撤掉面板上的说明性脚注

状态：进行中（2026-11-15）
关联：006（官方对照条）、012（占比与命中率）、014（Credits 换算）、015（模型行比值）、019 / 022 / 023（单模型估算）

## 背景

面板上积了若干灰色小字：它们解释数字怎么算、口径是哪一档，但用户看的是数，不是算法推导。
用户（m01627）把屏上的几段说明原文粘出来，然后要求：

> 「这两段几文字删掉」

粘贴的内容覆盖四块：

1. 模型行脚注（`usageCreditsModelsNote`）：「模型行 = 本机该模型 tokens ÷ 本账期已用 Credits（官方不按模型拆分，
   这是贡献值）……各行相加约等于本机总量，与账号级官方总量有少量差额。」
2. Credits 换算卡脚注（`usageCreditsNote`）：「比值 = 官方账号 tokens ÷ 已用 Credits；……它是本账期的混合口径均值，
   随模型与缓存命中率变化，不是固定兑换率。」
3. 占比与命中率脚注（`usageRatioNote`）＋其后三句（`usageNoteDelay` / `usageNoteCacheWrite` / `usageNoteNoCredits`）：
   「占比与命中率都是本机实测 tokens 的比值：……它们描述用量构成，不是配额比例。」「会话记录最长滞后 5 分钟……」
   「当前宿主大多不上报 cacheWrite……」「不折算 Credits，也不估算余量。」
4. 官方对照条下方的原始数字行（`p.tpq-usage-official-split`）：「输入 907874264 · 缓存命中 874720512 · 输出 7434105」。

## 目标

- FR-001 删除六个文案键（中英各一份，共 12 行）：`usageCreditsNote`、`usageCreditsModelsNote`、`usageRatioNote`、
  `usageNoteDelay`、`usageNoteCacheWrite`、`usageNoteNoCredits`；COPY 键数 158 → 152。
- FR-002 删除对应 DOM：模型块尾脚注节点、换算卡脚注节点、整页脚注里的 ratioNote 与三句、官方对照条的四项细分数字行。
- FR-003 整页脚注块改为「有内容才建」：只剩来源行 / 本机实测提示 / 补扫说明时仍然渲染，无内容时不出现空容器。
- FR-004 删除三条不再使用的 CSS（`.tpq-usage-credits-note`、`.tpq-usage-credits-models-note`、选择器组里的
  `.tpq-usage-official-split`）。
- FR-005 数据口径与接口零变化：不新增/删除路由、配置键、出站主机、依赖；宿主 `lib/index.js` 不动。
- FR-006 同步测试与守卫：client 断言改为「这些字不存在」，guards 更新 COPY 计数并新增第 24 节。

## 非目标

- 不动 019 / 022 / 023 的数字与卡片结构（只撤说明文字）。
- 不改 README 的技术口径说明（文档里继续写清楚怎么算，只是不上屏）。
- 不重拍 docs 截图（读图通道仍不可用，022 已写明）。

## 决定与取代

- 取代 012 的 SC-007（「两个公式必须上屏」）：用户明确要求删除，口径说明改由 README / 规格承载。
- 取代 006 的「官方对照条下方给四项细分明细」：该行删除，官方对照只留三格（官方 / 本机 / 差额）。

## 验收标准

- SC-001 面板 DOM 中不存在六个 COPY 键对应的文案，也不存在 `data-usage-official-split` 与两条脚注类名。
- SC-002 整页脚注只剩来源 / 本机 / 补扫三类内容；三者都没有时不渲染脚注块。
- SC-003 COPY 键数 152 / 152；client 测试与 guards 全绿，宿主机测试数不变。
- SC-004 零新配置键（DEFAULTS 26）、零新出站主机（8）、零第三方依赖。
