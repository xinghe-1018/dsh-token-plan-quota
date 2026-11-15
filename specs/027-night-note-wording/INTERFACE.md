# 027 接口

## 文案键（不变名）

`COPY.zh.usageSingleModelNightNote` / `COPY.en.usageSingleModelNightNote`：

    zh: 按本账期实测用量折算；22:00–08:00 夜间折扣已体现在官方已用 Credits 中，不重复计入。
    en: Derived from this cycle's measured usage; the 22:00-08:00 discount is already reflected in the used credits and is not added again.

## 渲染契约（不变）

    estimate !== null
      ? React.createElement("p", { key: "night", className: "tpq-usage-single-model-note" }, copy.usageSingleModelNightNote)
      : null

- 位置：结果卡 grid 之后、模块末尾。
- CSS：`.tpq-usage-single-model-note{margin:0;font-size:11px;line-height:1.6; color:var(--dsw-alias-label-tertiary,inherit);overflow-wrap:anywhere}`（未改）。
- 只在 022 `estimate` 口径渲染；回落 019 `capacity` 时不出现。

## 计数

- COPY 键 153 / 153（025 之后未变）。
- 依赖、路由、配置键、出站主机均不变。
