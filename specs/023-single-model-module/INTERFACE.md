# 023 INTERFACE（实现唯一真值）

## 1. 宿主

无改动。`ratio.models[].estimate = { tokens, classes }` 与 `ratio.priceBasis` 保持 022 契约。

## 2. 客户端 DOM

```
section.tpq-usage-single-model[data-usage-single-model="1"][data-stale="0|1"]
  h3.tpq-usage-single-model-title            → copy.usageCreditsModelPickTitle
  div.tpq-usage-credits-modelpick[data-usage-credits-modelpick="1"]
    div.tpq-usage-credits-modelpick-chips[role=group][aria-label=标题]
      button.tpq-usage-credits-modelpick-chip[data-model][data-selected][aria-pressed]
    div.tpq-usage-credits-modelpick-card[data-usage-credits-modelpick-card="1"]
      p.tpq-usage-credits-modelpick-card-label  → estimate ? usageCreditsModelPickEstimate : usageCreditsModelPickCard
      div.tpq-usage-credits-modelpick-total → span.value + span.unit
      div.tpq-usage-credits-modelpick-grid → cell×3(或4)
```

- 模块内**不得**出现 `modelpick-title` / `-hint` / `-share` / `-note` 节点。
- 换算卡（`section.tpq-usage-credits`）内**不得**再出现 `data-usage-credits-modelpick`。
- 模块位置：`usageCreditsSection` 之后、整页脚注之前；同 `snapshot !== null && disabled !== true` 条件。
- 不渲染条件：credits 非 ready、`usageModelPickUsable(ratio.models, Number(creditsData.total))` 为空。

## 3. COPY

删除键：`usageCreditsModelPickHint` / `usageCreditsModelPickShare` / `usageCreditsModelPickNote`（中英各一份）。
保留：`usageCreditsModelPickTitle`（zh「如果只用单个模型」/ en「If you used a single model」）、
`usageCreditsModelPickCard`、`usageCreditsModelPickEstimate`。
键数契约：158 / 158。

## 4. CSS

删除：`.tpq-usage-credits-modelpick-title`、`-hint`、`-share`、`-note`。
新增：`.tpq-usage-single-model`（卡片视觉 + `display:flex;flex-direction:column;gap:8px;margin-top:12px`）、
`.tpq-usage-single-model[data-stale="1"]{opacity:.55}`、`.tpq-usage-single-model-title{margin:0;font-size:14px;font-weight:600;line-height:1.35}`。
复用：`.tpq-usage-credits-modelpick-*` 其余规则不变。

## 5. 测试契约

- client T023：模块独立出现且位于换算卡之后；标题文案；无 hint/share/note；无价目模型只有 capacity 且标签为 Card；
  没有可用模型时模块整体不渲染；chip 切换数字变化。
- guards 第 23 节：COPY 158、标题文案、`usageSingleModelSection` 存在且接线、换算卡不再 push modelPick、
  模块类与 stale 规则存在、无 hint/share/note 字符串、specs/023 四件、README/CHANGELOG 含 023。
