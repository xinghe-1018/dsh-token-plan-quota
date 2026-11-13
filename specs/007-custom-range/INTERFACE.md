# INTERFACE — 007 自定义日期区间（实现唯一接口真值）

> 与 006 的 `INTERFACE.md` 叠加：006 定义屏与快照的整体形状，本文件只定义"按 from/to 查询"的增量。
> 冲突时以本文件为准。

## 1. 纯函数层（`lib/usage-stats.js`）

### 1.1 `resolveCustomRange({ now, from, to, maxDays })`

- `from` / `to`：`YYYY-MM-DD` 本地日键字符串（原样来自查询参数）。
- `maxDays`：上界，宿主传 `usageBackfillDays`（默认 365）。
- 返回 `{ from, to, days }` 或 `{ error }`：
  - `{ error: "usage-bad-range" }`：格式非法 / 不是真实日历日（如 `2026-02-30`）/ `from > to` / `from` 晚于今天；
  - `{ error: "usage-range-too-long", maxDays }`：闭区间天数 > `maxDays`；
  - 成功时 `to` 已**夹到今天**（原值晚于今天 → 回今天），`days` = 夹紧后闭区间天数。
- 校验顺序：格式 → 真实日期 → `from > to` → `from` 未来 → 夹 `to` → 跨度。

### 1.2 `aggregateUsageRange(index, { now, days, from, to })`

- 传了 `from` + `to`（已由 1.1 校验过）时走自定义分支：
  - `range = { kind: "custom", days, from, to }`；
  - `granularity = days <= 62 ? "day" : "week"`；
  - **桶恰好铺满 `[from, to]`**：日桶一天一个；周桶首桶 `from = 区间 from`（不往前补到周一）、
    末桶 `to = 区间 to`，中间桶按本地周一为界，互不重叠、连续、无空隙；
  - 区间内没有记录的日/周照样出 0 桶（不跳桶）。
- 未传 `from`/`to` 时行为与 006 完全一致（kind = `today` 或 `<days>d`）。

## 2. 宿主路由（`lib/index.js`，`GET /token-plan-quota/usage`）

| 情形 | 行为 |
|---|---|
| `from` 与 `to` 都不在 | 维持 006 的 `range`/`days` 分支 |
| `from` 与 `to` 都在 | 自定义分支；`range`/`days` 一并出现时**忽略它们** |
| 只有其中一个 | 400 `{ "error": "usage-bad-range" }` |
| 校验失败（1.1 任一） | 400 `{ "error": "usage-bad-range" }` |
| 跨度超 `usageBackfillDays` | 400 `{ "error": "usage-range-too-long", "maxDays": N }` |
| 成功 | 200，`range.kind = "custom"`，其余字段形状不变 |

- 仍然只放行 GET、仍然 `sameOriginOnly`；异常仍收口成 `usage-unavailable`（006 §2）。
- `coverage` / `source` / `enabled` / `refreshing` 语义不变。
- `to` 被夹到今天时，响应里的 `range.to` 必须是夹紧后的真值（客户端标题以它为准）。

## 3. 客户端（`lib/client.js`）

### 3.1 查询状态

`usageStore` 内保存 `{ rangeMode: "days" | "custom", days, from, to }`（重新打开屏时恢复）：

- 初始：`rangeMode = "days"`，`days = 7`。
- 切到自定义：`rangeMode = "custom"`，`from`/`to` 预填当前快照的 `range.from` / `range.to`
  （没有快照时预填 "今天-6 天" 至今天，用现有的本地日工具算），并立即按预填区间取数一次。
- 点任一预设（今日/7/30/90）：`rangeMode = "days"`，隐藏日期行，按 `days` 发请求。

> 实现注记（2026-11-13）：键名用 `rangeMode` 而非 `mode` —— `mode` 已被 006 的 2D/3D 视图状态占用
> （初值 `"2d"` 且被测试钉死），复用同一键会把切 3D 写成查询模式 `"3d"`。字段形状与语义不变。

### 3.2 界面契约

- 天数预设之后新增一个 chip「自定义」(英文 "Custom")，属性 `data-usage-preset="custom"`。
- 自定义行（`data-usage-custom`）：两个 `<input type="date">`（`data-usage-from` / `data-usage-to`）+
  按钮「查询」(`data-usage-apply`)。行内错误提示 `data-usage-range-error`（`role="alert"`）。
- 应用时**先本地校验**（省一次请求）：两端非空、`^\d{4}-\d{2}-\d{2}$`、`from <= to`、
  `from <= 今天`、闭区间天数 `<= 365`；任一不满足 → 显示提示、**不发请求**（用 fetch 计数断言）。
- 请求：`GET /token-plan-quota/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`（不带 days/range）。
- 标题（全部取自 `snapshot.range`，006 的"标题与数据同源"约定不破）：
  - `kind === "custom"` 且 `from === to` → 「2026-09-15 当天」/ "2026-09-15 (one day)"；
  - `kind === "custom"` 且多天 → 「2026-09-01 至 2026-09-30 · 30 天」/ "2026-09-01 to 2026-09-30 · 30 days"；
  - 其余 kind 维持 006 文案。
- 数据卡降级条件扩成：`snapshot` 的 `(kind, days, from, to)` 与**当前请求的查询**不一致 → `data-stale="1"`。
- 脚注：`source.kind === "session-index"` 时额外一行「仅统计本机 DSH 发出的调用；其他设备的用量不在此列。」
  / en "Only calls made by this DSH instance are counted; usage from other devices is not included."
- 400 映射：`usage-bad-range` → 本地「起止日期不合法」；`usage-range-too-long` → 本地
  「最多查 {maxDays} 天」；两者都带重试按钮，不回显宿主原文。

### 3.3 i18n 键（zh/en 同步，数量以测试断言为准）

`usageRangeCustom` / `usageRangeFrom` / `usageRangeTo` / `usageRangeApply` / `usageRangeBad` /
`usageRangeTooLong`（含 `{maxDays}`）/ `usageRangeDayOne` / `usageRangeLocalOnly` /
`usageRangeCustomTitle`（多天标题，含 `{from}` / `{to}` / `{n}`；§3.2 的多天文案需要独立模板，
实现中追加的第 9 个键，总数 109 → 118，以测试断言为准）。

## 4. 门禁

- `test/guards.mjs` 的客户端用量面矩阵（006 §3）必须继续通过：自定义区间文案里**不得**出现 `%` 或 `Credits`。
- `scripts/check-docs.mjs` 的 SCREENSHOTS 清单需与新增截图同步（`usage-range-2d.png`、`en/usage-range-2d.png`）。
