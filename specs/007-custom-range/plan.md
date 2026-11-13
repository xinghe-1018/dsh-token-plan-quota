# PLAN — 007 按日期区间查用量

## 1. 现状

`aggregateUsageRange(index, { now, days })` 只接受"先算终点=今天、再往前数 N 天"；
宿主路由把 `?range`/`?days` 归一成 `days` 后调用它；客户端只维护 `days` 一个状态。

## 2. 改动面

| 层 | 文件 | 改动 |
|---|---|---|
| 纯函数 | `lib/usage-stats.js` | `aggregateUsageRange` 支持传入 `from`/`to` 日键；新增导出 `resolveCustomRange(opts)` 做格式与边界校验（返回 `{from,to,days}` 或 `{error}`）；周桶首桶起点夹到 `from` |
| 宿主 | `lib/index.js` | `/usage` 解析 `from`/`to`：两端齐全优先，校验失败回 400 固定码；`to` 夹到今天；错误码写进 `buildUsageSnapshot` 返回 |
| 客户端 | `lib/client.js` | `usageQuery` 状态从 `{days}` 扩成 `{mode,days,from,to}`；「自定义」入口 + 两个日期框 + 查询；请求拼 `?from=&to=`；标题按 `snapshot.range.kind` 分支；脚注补"仅统计本机"键 |
| 测试 | `test/host.mjs`、`test/client.mjs` | SC-001..SC-005 全量断言 |
| 文档 | 两版 README、CHANGELOG、`docs/upstream-contracts.md` | 路由参数、界面说明、边界 |
| 截图 | `scripts/shots/*`、`docs/images/usage-range-*.png` | 造图机新增一张自定义区间取景（中英各一） |

## 3. 关键设计

### 3.1 两端闭区间与"夹到今天"

`to` 晚于今天时夹到今天：用户手选了"明天"不该看到一条 400，也不该看到一串未来空桶。
夹紧后 `range.to` 回写真实终点，客户端标题以响应为准（006 已建立的"标题与数据同源"约定）。

### 3.2 周桶必须铺满区间

006 的周桶以"周一起界"画整周；对自定义区间，首桶从 `from`（可能不是周一）起、末桶到 `to` 止。
否则会出现"用户只要 09-03 起，图上却从 08-31 开始"的错觉——这也是桶序与总和的自洽要求。

### 3.3 错误码只在宿主定一次

客户端不重复实现边界规则：它只做**即时**的形态校验（空值、起点晚于终点、跨度超限、未来起点）
用来省一次请求；真正的判定仍以宿主的 400 为准，客户端把 `usage-bad-range` / `usage-range-too-long`
映射成本地化文案。两边规则一致，但只有一处是权威。

### 3.4 兼容

`?days=N` 与 `?range=` 的行为一字不改；`from`/`to` 是新增分支，老客户端不受影响。

## 4. 失败模式

- 用户跨年选（2025-12-01 → 2026-01-15）：跨年由 `dayKeyToDate` 的本地日历换算处理，不手写月份加法。
- 区间落在索引修剪之外（超出 `usageBackfillDays`）：跨度校验先拦；若历史被修剪过，日桶为 0 但
  不伪造数字——脚注与 coverage 仍如实说"已索引 N 个会话"。
- 日期框在本机浏览器给的是空串：按"未填写"处理，不发请求、提示"请选择起止日期"。
- 起止相同：一个日桶，标题写"当天"。

## 5. 验收

`npm run check` 七步全绿；真机打 `?from=&to=` 与等价 `?days=` 对比逐桶相等；
截图中英各一张、fixture 白名单照旧禁 % / Credits / 真实痕迹。
