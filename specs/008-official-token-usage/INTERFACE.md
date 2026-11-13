# INTERFACE — 008 官方账号侧 token 用量（实现唯一接口真值）

冲突时以本文件为准。

## 1. 纯函数层（`lib/official-usage.js`，零依赖、无 IO、不联网）

### 1.1 `sliceOfficialRange({ from, to, chunkDays = 30, earliest })`

- 入参 `from` / `to` 是 `YYYY-MM-DD` 本地日键，闭区间。
- `earliest` 可选日键；`from < earliest` 时把 `from` 夹到 `earliest`，并回 `clampedFrom` = **被夹掉的原始起点**（不是夹紧后的值）——UI 靠它解释"你查得更早，官方只给到这里"。
- 返回 `{ from, to, days, clampedFrom?, chunks: [{ from, to, days }] }`；`chunks` 按顺序覆盖整个区间，
  每片 `days <= chunkDays`，片间不重叠、不留空隙；`from > to`（夹紧后）返回 `{ error: "official-empty-range" }`。

### 1.2 `officialEarliestDayKey({ now = Date.now(), monthsBack = 5 })`

返回「当前月往前 `monthsBack` 个月的 1 号」本地日键（与官方页面 `fR` 判据一致）。

### 1.3 `parseOfficialEnvelope(payload)`

在响应对象里向下找同时含 `originData`（数组）或 `dataDownloadUrl`（非空字符串）的那层。
返回 `{ series: [...] }` 或 `{ downloadUrl: "..." }` 或 `{ error: "official-bad-response" }`。

### 1.4 `foldOfficialSeries(series, { dayStart, dayEnd })`

- 只认 `aggMethod === "sum"` 且 `labels.usage_type` ∈ `total_tokens|input_tokens|cached_tokens|output_tokens`。
- `bucketStart = point.timestamp - (series.step ?? 86400) * 1000`，按本地日归一 `dayKey`。
- 返回 `{ days: { "YYYY-MM-DD": { tokens, input, cacheRead, output, totalDerived } }, totalDerived }`；
  区间里没有记录的日**不在这里造**（由 `buildOfficialUsage` 补齐）。
- `totalDerived = true` 当且仅当该区间没有任何 `total_tokens` 读数且用 `input + output` 兜底。

### 1.5 `buildOfficialUsage({ days, from, to, granularity })`

输出 §2.1 的 `totals` 与 `buckets`：桶数 = 区间天数（`granularity: "day"`），缺日 0 桶。

## 2. 宿主（`lib/index.js`）

### 2.1 `GET /token-plan-quota/usage-official?days=&range=&from=&to=&fresh=1`

参数解析与 400 语义**复用** `/usage`（`usage-bad-range` / `usage-range-too-long` + `maxDays`）。

200 成功体：

```json
{
  "generatedAt": 1763000000000,
  "range": { "kind": "custom", "days": 31, "from": "2026-10-01", "to": "2026-10-31" },
  "granularity": "day",
  "totals": { "tokens": 2000000000, "input": 120000000, "cacheRead": 1800000000, "output": 80000000 },
  "buckets": [ { "from": "2026-10-01", "to": "2026-10-01", "tokens": 0, "input": 0, "cacheRead": 0, "output": 0 } ],
  "source": { "kind": "official-console", "veracity": "verified", "label": "官方账号侧（Token Plan 用量明细）" },
  "coverage": {
    "api": "zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss",
    "chunks": 1, "step": "day", "cached": false,
    "totalDerived": false, "clampedFrom": "2026-06-01"
  }
}
```

- `coverage.cached`：本次是否命中缓存。`coverage.clampedFrom` 只在被夹紧时出现。
- **官方口径**：`totals.tokens = input + output`，而 `input` **已包含** `cacheRead`（官方 `input_tokens` 含缓存命中；
  `total_tokens` 就是 input+output）。所以对照本机时：本机 `tokens = input + cacheRead + cacheWrite + output`
  与官方 `tokens` 是同一含义，**不要再把 cacheRead 加到官方 tokens 上**（会重复计）。
- `buckets[i]` 形状固定 `{ from, to, tokens, input, cacheRead, output }`（没有 `total` 字段）。
- `range.from` / `range.to` 必须是**实际查询**（夹紧后）的真值。

200 失败体（**不阻塞本机口径**，客户端据此显示一行原因）：

```json
{ "error": "official-unavailable", "code": "official-no-credentials", "hint": "…中文可操作提示…" }
```

`code` 固定枚举：`official-disabled` / `official-no-credentials` / `official-login-expired` /
`official-download-url` / `official-timeout` / `official-upstream` / `official-bad-response`。
`hint` 里**禁止**出现 Cookie 值、上游 message 原文、主机内网地址。

### 2.2 配置键（`DEFAULTS`，两版 README 配置表各加一行）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `officialUsage` | `true` | 是否调用官方用量明细接口（关掉后路由回 `official-disabled`，零出站） |
| `officialUsageMinutes` | `5` | 同一区间的官方结果缓存分钟数 |

### 2.3 预设（`PRESETS["token-plan-console"]` 新增字段）

`telemetryApi`（完整 Api 路径）、`telemetryStepSeconds: 86400`、`telemetryChunkDays: 30`（网关实测上限）、
`telemetryEarliestMonths: 5`。宿主只从 `builder === "token-plan-console"` 的源上取这些字段与凭据。

### 2.4 网关

`callConsoleGateway(config, source, cookie, apiName, secToken, secProbe, options)`：
`options.apiPath` 存在时**原样**作为 `Api`（query 的 `api=` 与 body `params.Api` 都用它），
否则维持 `apiPrefix + "/" + apiName`。

## 3. 客户端（`lib/client.js`）

### 3.1 取数

- 常量 `USAGE_OFFICIAL = "/token-plan-quota/usage-official"`。
- 时机：本机快照成功后可取；查询参数与本次本机查询**完全一致**（自定义区间用 `from`+`to`，
  预设用 `days`）。切区间 / 点重试时重取；只有重试与显式刷新带 `fresh=1`。
- 防串：每次请求带自增序号与 `AbortController`，只接受最后一次的响应。

### 3.2 渲染（柱状图卡片之后）

```html
<section class="tpq-usage-official" data-usage-official>
  <h3>…copy.usageOfficialTitle…</h3>
  <div class="tpq-usage-official-grid">
    <div data-usage-official-official>官方数值</div>
    <div data-usage-official-local>本机数值</div>
    <div data-usage-official-gap>差额（带正负）</div>
  </div>
  <p data-usage-official-split>input … / cacheRead … / output …</p>
  <p>…copy.usageOfficialNote…</p>
</section>
```

- `status === "error"`：整块换成一行 `<p data-usage-official-error role="status">`（copy.usageOfficialError + hint）
  ＋按钮 `data-usage-official-retry`；**不渲染任何数字**。
- `status === "loading"`：`<p class="tpq-usage-official-loading">`（copy.usageOfficialLoading）。
- 数值格式：复用现有 `usageCount`；差额正数带 `+`，负数带 `-`，0 显示 0。
- 只有在 `data.range.from/to/days` 与当前查询一致时才认为 ready（stale 保护）。

### 3.3 i18n（zh/en 同步，逐键断言；文案禁 `%` 与 Credits）

契约 8 键：`usageOfficialTitle` / `usageOfficialLocal` / `usageOfficialGap` / `usageOfficialLoading` /
`usageOfficialError` / `usageOfficialRetry` / `usageOfficialNote` / `usageOfficialEmpty`；
实现另加 2 键（撑住"官方"格标签与 clampedFrom 提示）：`usageOfficialOfficial` / `usageOfficialClamped`。
共 10 键，zh/en 同步。

## 4. 门禁

- `test/host.mjs`、`test/client.mjs`、`test/guards.mjs` 全绿；`npm run check` 七步全绿。
- `DECLARED_HOSTS` 保持 8 条（本特性复用 `cs-data.qianwenai.com`）。
- 两版 README 的配置键数 / 表行数 / 测试计数在**同一次改动**里同步。
