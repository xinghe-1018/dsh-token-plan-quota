# 027 · 夜间折扣说明与卡片标签口径统一

## 背景

025 在「如果只用单个模型」模块里加了一行说明，原文是：

> 按官方忙时价目估算，未计 22:00–08:00 夜间折扣；实际可用 tokens 会更多。

026 把结果卡标签改成「按实测用量折算 tokens」/ "Derived from measured usage" 之后，这两句在同一张卡上
给出两种口径：标签说数字来自实测用量，说明说数字来自官方忙时价目。

用户（m02116）要求「都改成一致的说法，更新 npm」。

## 为什么原句不准确

`estimate = total × ypc / priceMix`，其中 `ypc = Σ(行 tokens × 行价目) / used`，`used` 是官方
已用 Credits 读数。夜间 22:00–08:00 的折扣**在计费时就已扣减**：同一批 tokens 夜里用掉更少 Credits，
`used` 更小，估算反而更大。所以「未计夜间折扣」是反的；真正没建模的只有「把 80,000 Credits 全部
挪到夜间使用」这一反事实场景。

## 目标

- 说明文字与卡片标签同口径：数字来自**本账期实测用量**折算，不出现「按官方价目估算」的说法。
- 保留 22:00–08:00 这个具体时段，并说清折扣已在已用 Credits 里（不重复计入）。
- 中英一致；纯文案改动。

## 非目标

- 不改估算公式、数据口径、路由、配置键、出站主机、依赖。
- 不改 025 的历史 CHANGELOG 条目（当时确实是那样写的），由本条说明取代。
- 不重拍截图（本轮读图通道不可用，沿用 022/023/024 先例）。

## 需求

- FR-001 `usageSingleModelNightNote` zh 改为
  「按本账期实测用量折算；22:00–08:00 夜间折扣已体现在官方已用 Credits 中，不重复计入。」
- FR-002 同一键 en 改为
  "Derived from this cycle's measured usage; the 22:00-08:00 discount is already reflected in the used credits and is not added again."
- FR-003 渲染条件、位置、类名 `tpq-usage-single-model-note`、CSS 原样（仍只在 `estimate` 口径出现）。
- FR-004 README 中英、CHANGELOG 同步；COPY 键数不变（153/153）。

## 验收

- SC-001 面板上这一行逐字为 FR-001 / FR-002，旧句「未计 22:00–08:00 夜间折扣」在全仓库零残留。
- SC-002 `node test/client.mjs` 与 `node test/guards.mjs` 全绿，guards 第 27 节覆盖新旧字面量。
- SC-003 README 与 CHANGELOG 各记 027 一次以上，`specs/027-night-note-wording/` 四件齐全。
