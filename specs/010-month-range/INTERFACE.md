# INTERFACE — 010 按月份查用量（实现唯一接口真值）

> 与 006 / 007 的 `INTERFACE.md` 叠加：本文件只定义"按 `month` 查询"的增量，冲突以本文件为准。
> 现有 `days` / `range` / `from`+`to` 的行为一字不改。

## 1. 纯函数层（`lib/usage-stats.js`）

### 1.1 `resolveMonthRange({ now, month })`

- `month`：`YYYY-MM` 本地月份字符串（原样来自查询参数）。
- 返回 `{ month, from, to, days }` 或 `{ error }`：
  - `{ error: "usage-bad-month" }`：格式非法（`^\d{4}-(0[1-9]|1[0-2])$` 不匹配）/ 不是真实月份 /
    月份晚于当前月；
  - 成功：`from = YYYY-MM-01`；`to = 该月最后一天`，若晚于今天则**夹到今天**；`days` = 夹紧后闭区间天数。
- 校验顺序：trim → 格式 → 真实月份（`new Date(y, m-1, 1)` 回读年月，防 `0000-01` / `0099-01` 这类滚年）
  → 月份晚于当前月（比较 `month > today.slice(0,7)`）→ 夹 `to` → 算 `days`。
- **不套用** `usageBackfillDays` 上界：自然月最多 31 天，不受 365 天跨度限制影响；
  更早的月份按索引实际覆盖返回 0 桶（不伪造、不报错）。

### 1.2 `aggregateUsageRange(index, { now, days, from, to, month })`

- `month` 出现且经 1.1 校验通过 → 走"整月"分支：
  - `range = { kind: "month", month, days, from, to }`（`from/to/days` 用 1.1 的夹紧真值）；
  - `granularity = "day"`（31 天必 ≤ 62）；
  - 桶与 007 的 from/to 分支**完全同源**：恰好铺满 `[from, to]`，一天一桶，缺失日给 0 桶。
- 优先级：`month` > `from/to` > `days`。`month` 非法（1.1 返回 error）时**忽略该参数**，
  退回 `from/to` / `days` 分支（宿主已先校验，纯函数保持全函数）。
- `month` 未传时行为与 007 完全一致。

## 2. 宿主路由（`lib/index.js`）

### 2.1 参数解析

新增 `resolveUsageMonth(config, query)`：

| 情形 | 行为 |
|---|---|
| `month` 不在（`undefined`/空串） | 返回 `null`，维持 007/006 的 from+to / days 分支 |
| `month` 在，且 `from` 或 `to` 任一在 | 400 `{ "error": "usage-bad-range" }` |
| `month` 在，其余参数在（`days`/`range`） | 忽略它们，按月份查询 |
| 1.1 校验失败 | 400 `{ "error": "usage-bad-month" }` |
| 成功 | 200，`range.kind = "month"`，其余字段形状同 006 |

- `GET /token-plan-quota/usage` 与 `GET /token-plan-quota/usage-official` 用**同一份**解析
  （`buildUsageSnapshot` / `resolveOfficialRange` 都先走 2.1），两边区间必然一致。
- 仍然只放行 GET、仍然 `sameOriginOnly`；异常仍收口成 `usage-unavailable`。
- 官方侧 200 的 `range` 同样回 `kind: "month"` **与 `month`** 以及夹紧后的 `from/to/days`（切片夹紧仍由 008 处理，
  `coverage.clampedFrom` 语义不变）。
  实现加固（010 落地时补，规格原文未写）：官方快照的缓存只按 `from|to` 命中，而月份区间与等价的
  `from`/`to` 区间 `from|to` 可以完全同值 —— 所以缓存命中与 fresh 两条路径都**按本次请求**重建
  `range` 的 `kind`（month 分支多带 `month`），不能复用缓存里的 `kind`，否则同一段日期会串成另一种口径。

### 2.2 工具 `token_plan_quota`

- `action=usage` / `usage-official` 新增可选参数 `month`（`YYYY-MM`），语义与路由一致；
  与 `from`/`to` 混用按 `usage-bad-range` 处理（`ok:false`）。
- 工具摘要（`summarizeUsageText`）对 `range.kind="month"` 说「YYYY 年 M 月（N 天）」。

### 2.3 错误码

| 码 | 触发 | 路由 |
|---|---|---|
| `usage-bad-month` | 月份格式非法 / 月份晚于当前月 | 400 |
| `usage-bad-range` | `month` 与 `from/to` 混用 | 400 |

## 3. 客户端（`lib/client.js`）

### 3.1 查询状态

`usageStore` 内 `{ rangeMode: "days" | "custom" | "month", days, from, to, month }`：

- 初始 `rangeMode = "days"`、`days = 7`；`month` 为空串。
- 切「按月」：`rangeMode = "month"`，`month` 预填当前快照的 `range.month`（没有就用本机当前月），
  立即按该月取数一次。
- 点任一预设（今日/7/30/90）：「自定义」与「按月」都收起，`rangeMode = "days"`。
- 恢复（重开屏）：`rangeMode = "month"` 且 `month` 仍合法（格式 + 不晚于当前月）时按月份恢复；
  否则回落 `days`。

### 3.2 纯函数契约（`__internals` 导出）

- `validateUsageMonth(month, today)` → `{ ok: true, month }` | `{ ok: false, error: { code: "usage-bad-month" } }`；
  校验：非空、`^\d{4}-(0[1-9]|1[0-2])$`、真实月份、`month <= today.slice(0,7)`。
- `usageQueryOf(rangeMode, days, from, to, month)`：月份态返回 `{ mode: "month", month }`（参数顺序追加在末尾）。
- `usageQueryPath(target)`：月份态 → `"?month=YYYY-MM"`；非法返回 `null`（零请求）。
- `officialQueryKeyOf(query)`：月份态 → `"month:YYYY-MM"`。
- `usageSnapshotMatchesQuery(snapshot, query)`：月份态要求 `range.kind === "month"` 且 `range.month === query.month`。
- `usageRangeText(copy, snapshot, days)`：`kind === "month"` → 用 `usageRangeMonthTitle` 以
  `{y}` / `{m}`（不补零，zh 用）/ `{mm}`（两位零填充，en 用）/ `{n}` 渲染；`month` 缺失时从
  `range.from.slice(0,7)` 兜底。两个月份占位只是同一个 `range.month` 的两种读法：zh 读「2026 年 9 月」、
  en 读 ISO 的「2026-09」，不引入第二个数据源。

### 3.3 界面契约

- 预设 chips 之后（「自定义」之后）新增「按月」chip，属性 `data-usage-preset="month"`。
- 月份行 `data-usage-month`：`<input type="month" data-usage-month-input>` + 按钮「查询」
  `data-usage-month-apply` + 行内提示 `data-usage-month-error`（`role="alert"`）。
- 点「查询」**先本地校验**（3.2），不通过只显示提示、**零请求**；通过才发
  `GET /token-plan-quota/usage?month=YYYY-MM`（不带 days/range/from/to）。
- 同一月份重复点「查询」= 用户要重新取数，直接再发一次（effect 的 key 没变）。
- 标题（全部取自 `snapshot.range`）：`kind === "month"` → zh「2026 年 9 月 · 30 天」；
  en「2026-09 · 30 days」。
- 数据卡降级条件扩成 `(kind, days, from, to, month)` 与当前查询不一致 → `data-stale="1"`。
- 400 映射：`usage-bad-month` → zh「月份不合法」/ en "Invalid month"（`usageMonthBad`），带重试按钮；
  `usage-bad-range` 沿用 007 文案。

### 3.4 i18n 键（zh/en 同步，数量以测试断言为准）

新增 5 键：`usageMonthPreset`（「按月」/"Month"）、`usageMonthLabel`（「月份」/"Month"）、
`usageMonthApply`（「查询」/"Apply"）、`usageMonthBad`（「月份不合法」/"Invalid month"）、
`usageRangeMonthTitle`（zh 含 `{y}` / `{m}` / `{n}`，en 含 `{y}` / `{mm}` / `{n}`）。文案禁 `%` 与 `Credits`。

## 4. 门禁

- `test/guards.mjs`：新增月份矩阵（`month=` 路由文档、`data-usage-month` 钩子、错误码、
  中英文案无 `%` / `Credits`、specs/010 目录存在）。
- `scripts/check-docs.mjs` 的 SCREENSHOTS 清单需加 `docs/images/usage-month-2d.png` 与
  `docs/images/en/usage-month-2d.png`；README 两版路由表需有 `?month=` 行。
