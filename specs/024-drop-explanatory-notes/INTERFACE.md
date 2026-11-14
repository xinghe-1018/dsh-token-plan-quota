# 024 INTERFACE（实现唯一真值）

## 1. 宿主

无改动。`ratio.classes[].perCredit` / `ratio.models[].capacity|estimate` / `ratio.basis` / `ratio.priceBasis` 全部保持原契约。

## 2. 客户端删除清单

COPY（中英各一份，共 12 行）：

| key | 删除前用途 |
|---|---|
| `usageCreditsNote` | 换算卡脚注（比值 = 官方 tokens ÷ 已用 Credits…不是固定兑换率） |
| `usageCreditsModelsNote` | 模型块脚注（贡献口径 / 各行相加约等于本机总量） |
| `usageRatioNote` | 占比与命中率公式脚注（不是配额比例） |
| `usageNoteDelay` | 会话记录最长滞后 5 分钟 |
| `usageNoteCacheWrite` | 当前宿主大多不上报 cacheWrite |
| `usageNoteNoCredits` | 不折算 Credits，也不估算余量 |

DOM：

- `usageCreditsModelsBlock`：`children = [...].concat(rows)`，不再追加 `p.tpq-usage-credits-models-note`。
- `usageCreditsSection`：不再 push `p.tpq-usage-credits-note`。
- 官方对照条：删除 `p.tpq-usage-official-split[data-usage-official-split="1"]`（输入 / 缓存命中 / 输出那一行）。
- 整页脚注：删除 `usageRatioNote` 与「延迟 / cacheWrite / noCredits」三行；建块条件由「有 snapshot 就建」改为
  `if (noteLines.length > 0) { blocks.push(<div class="tpq-usage-notes">…) }`，此时 noteLines 只剩
  sourceNote / usageRangeLocalOnly / rescued 三类。

CSS：

- 删除 `.tpq-usage-credits-note{…}`、`.tpq-usage-credits-models-note{…}`；
- 选择器组 `.tpq-usage-official-split,\n.tpq-usage-official-note,…` 去掉首行，保留其余。

## 3. COPY 契约

键数 152 / 152（023 的 158 − 6）。保留：`usageCreditsClasses` / `usageCreditsClassesUnit` / `usageCreditsDaily` /
`usageCreditsModelPickTitle` / `usageCreditsModelPickCard` / `usageCreditsModelPickEstimate` /
`usageSplitInput` / `usageSplitCacheRead` / `usageSplitOutput`（后三键仍用于其它块）、来源与补扫提示。

## 4. 测试契约

- client：COPY 计数 152；`tpq-usage-official-split` 不存在；两条脚注类名不存在；整页脚注行数按剩余 3 / 2 计；
  012 的 SC-007 断言改为「两条公式都不再上屏」。
- guards：六处 COPY 计数 152；012 / 014 / 015 / 016 的脚注断言改为「已删」；第 24 节校验六键删除、split 行不渲染、
  `if (noteLines.length > 0)`、三条 CSS 删除、COPY 152、specs/024 四件、README/CHANGELOG 含 024、零新配置键/出站/依赖。

## 5. 文档契约

README.md / README.en.md 在对应段落写明 024 撤掉了这些脚注、口径说明只留在文档里；CHANGELOG 在 Unreleased/Added
新增 024 条目；本目录 spec / plan / INTERFACE / tasks 四件齐全。
