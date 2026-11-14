# PLAN — 010 按月份查用量

## 1. 现状

`aggregateUsageRange(index, { now, days })`（006）与 `{ from, to }`（007）已能覆盖任意闭区间；
宿主 `buildUsageSnapshot` 只解析 `days`/`range`/`from`+`to`；客户端 `rangeMode` 只有 `days`/`custom` 两态。
"自然月"虽然可以用 from/to 表达，但需要用户自己知道月末是哪天，且响应里没有 `month` 标识，
界面标题也只能显示成一段日期。

## 2. 改动面

| 层 | 文件 | 改动 |
|---|---|---|
| 纯函数 | `lib/usage-stats.js` | 新增导出 `resolveMonthRange({now, month})`（格式/未来月/夹紧/天数）；`aggregateUsageRange` 接受 `month`，走"整月区间"分支并给 `range.kind="month"` |
| 宿主 | `lib/index.js` | 新增 `resolveUsageMonth`；`buildUsageSnapshot` 与 `resolveOfficialRange` 优先走月份分支；路由与工具接受 `month`；错误码 `usage-bad-month` 回 400；工具摘要补月份文案 |
| 客户端 | `lib/client.js` | `rangeMode` 增 `month` 态；「按月」chip + `<input type="month">` 行；`usageQueryPath` / `officialQueryKeyOf` / `usageSnapshotMatchesQuery` / `usageRangeText` 增月份分支；本地即时校验省请求；store 增 `month` |
| 测试 | `test/host.mjs`、`test/client.mjs`、`test/guards.mjs` | SC-001..SC-006 全量断言 + 静态矩阵 |
| 文档 | 两版 README、CHANGELOG、`scripts/check-docs.mjs`、本目录四件套 | 路由参数、界面说明、截图清单 |
| 截图 | `scripts/shots/*`、`docs/images/usage-month-2d.png`、`docs/images/en/usage-month-2d.png` | 造图机新增一个月度取景（中英各一） |

## 3. 关键设计

### 3.1 月份是"自然月 + 夹到今天"，不是"近 30 天"

`month=2026-11` 在 11-13 这天表示 `2026-11-01 .. 2026-11-13`（13 天），`range.to` 回 **今天**；
`month=2026-10` 表示 10-01..10-31。这样"本月/上月"都不需要额外语义，跨年（2025-12）也只是
`month` 字符串的自然结果。

### 3.2 桶恒为日桶

31 天 < 62 天阈值，天然落在 006 的日桶分支，一根柱一天。不引入"月内按周聚合"的额外粒度，
因为 31 根柱在 2D/3D 下都画得下（006 的 90 天 = 90 根柱已经验证过）。

### 3.3 月份分支与 from/to 共用同一套桶铺满逻辑

`resolveMonthRange` 只负责把 `month` 翻成 `{from, to, days, month}`；聚合层把它当作"已知两端"的
区间，沿用 007 已实现的"桶恰好铺满 `[from,to]`"分支，只是 `range.kind` 写 `month` 并带 `month`。
好处：桶序、0 桶、模型汇总、totals 的自洽性全部复用同一段代码，不会出现"月份查询的柱子算法不一样"。

### 3.4 冲突即 400

`month` 与 `from`/`to` 同时出现时返回 `usage-bad-range`，而不是静默选一个：
静默忽略会让"我以为我在看 9 月、其实在看 8 月"这种错误无法自查。客户端永远只发一种参数。

### 3.5 本地校验与宿主同序

客户端 `validateUsageMonth` 只拦"格式 + 未来月"两件事（月份没有区间跨度问题），
通过后发一次请求；宿主仍做权威判定。两边规则一致，权威只在宿主一处。

## 4. 备选（未采用）

- **把月份做成 `range=m2026-09` 预设**：预设值是无参枚举，月份是用户变量，塞进 `range` 会让
  "预设"与"参数"两种语义混在一个键里；独立 `month` 更清楚，也不破坏既有 `range` 行为。
- **用 `from/to` 在客户端算月末再发请求**：省了宿主改动，但响应就没有 `range.kind="month"`，
  标题、stale 判定、官方对照都要靠客户端自己记状态，反而更难保证"标题与数据同源"。

## 5. 失败模式

- 用户选未来月（如现在是 11 月选了 12 月）：400 `usage-bad-month`，屏内提示「月份不合法」，不夹紧到 1 号。
- 用户选比索引还早的月（如 2026-01）：200 + 全 0 桶；脚注与 coverage 如实反映索引覆盖，不伪造数字。
- 浏览器 `<input type="month">` 给空串：按"未填写"处理，不发请求、提示「请选择月份」。
- 月份框在不同浏览器给 `2026-9`（缺零）：本地校验拦下（格式固定 `YYYY-MM`），不发注定 400 的请求。
- 跨年：`month=2025-12` 的 from/to 由本地日历算，不手写月份加法。
- 官方账号侧对更早月份夹紧（008 的 5 个月窗口）：仍由 008 的切片逻辑处理，`coverage.clampedFrom` 如实回写。

## 6. 验收

`npm run check` 七步全绿；真机打 `?month=YYYY-MM` 与等价 `?from=&to=` 对比逐桶相等；
截图中英各一张、fixture 白名单照旧禁 % / Credits / 真实痕迹；375px 窄屏不横向溢出。
