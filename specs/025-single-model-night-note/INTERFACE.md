# 025 INTERFACE（实现唯一真值）

## 1. 宿主

无改动。`ratio.models[].estimate = { tokens, classes }` 与 `ratio.priceBasis` 契约保持。

## 2. 客户端

COPY 新增两键（各一份，共 2 行）：

| key | 值 |
|---|---|
| `usageSingleModelNightNote`（zh） | `按官方忙时价目估算，未计 22:00–08:00 夜间折扣；实际可用 tokens 会更多。` |
| `usageSingleModelNightNote`（en） | `Estimated from peak-hour list prices; the 22:00-08:00 discount is not included, so the real capacity would be higher.` |

DOM：

- `UsageCreditsModelPick` 的 `div.tpq-usage-credits-modelpick` children 末尾：
  `estimate !== null ? React.createElement("p", { key: "night", className: "tpq-usage-single-model-note" }, copy.usageSingleModelNightNote) : null`
- 插入位置在结果卡 grid 之后；模块内仍是 chips → card → note 三段，不新增容器。

CSS（`.tpq-usage-single-model-title{…}` 之后）：

```css
.tpq-usage-single-model-note{margin:0;font-size:11px;line-height:1.6;
 color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}
```

## 3. COPY 契约

键数 153 / 153（024 的 152 + 1）。除新增键外不改任何既有文案。

## 4. 测试契约

- client：COPY 153；有 estimate 时 note 文案逐字（中英）、位于 chips 与 card 之后；无 estimate 时 note 不存在；
  en 界面无中文残留。
- guards：八处 COPY 计数 153；第 25 节校验 night 键中英字面量、渲染条件与类名、CSS 规则、COPY 153、
  specs/025 四件、README/CHANGELOG 含 025、零新配置键 / 出站 / 依赖。

## 5. 文档契约

README.md / README.en.md 的单模型段落写明「模块内除 chips 与结果卡外还有一行夜间折扣说明」；CHANGELOG 在
Unreleased/Added 新增 025 条目；本目录四件齐全。
