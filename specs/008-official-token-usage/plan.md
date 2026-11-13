# PLAN — 008 官方账号侧 token 用量

## 1. 现状

- `/usage`（006/007）只折 `~/.dsh/sessions`，口径写死 `session-index / measured`。
- 控制台网关 `callConsoleGateway` 把 `apiName` 拼在 `apiPrefix = zeldaHttp.apikeyMgr./tokenplan/personal/api/v2`
  后面，只能打 `usage / quota-config / subscription / addon/list` 四个接口；官方「用量明细」
  走的是另一套 `zeldaEasy.bailian-telemetry.*` Api 路径，现有拼法够不到。
- 官方页面（`/home/analytics/token-plan/individual` → Usage Details）默认单位就是 tokens，
  单次区间上限 **30 天**（页面写 31，网关实测拒 31 天整月），最早可查「当前月往前 5 个月的 1 号」。

## 2. 改动面

| 文件 | 改动 |
| --- | --- |
| `lib/official-usage.js`（新） | 纯函数：切片、响应解析、逐日桶补齐、汇总、差额 |
| `lib/index.js` | 网关支持完整 Api 路径；`fetchOfficialUsage` / `buildOfficialUsageSnapshot` + 缓存；路由 `usage-official`；预设加 telemetry 字段；DEFAULTS 加 2 键 |
| `lib/client.js` | 对照条 + i18n + 错误态/重试 |
| `test/host.mjs` | 切片/解析/缓存/错误码/无 Cookie/夹具 |
| `test/client.mjs` | 对照条渲染、差额、错误态、切区间重取 |
| `scripts/shots/fixture.mjs` `make-shots.mjs` | 官方 fixture + 场景（截图脚本） |
| README / README.en / CHANGELOG / docs/upstream-contracts.md / check-docs | 口径与契约文档 |

## 3. 关键设计

### 3.1 网关放行完整 Api（不新增出站主机）

`callConsoleGateway(config, source, cookie, apiName, secToken, secProbe, options)` 加可选
`options.apiPath`：给了就**原样**当 `Api`（同时用于 query 的 `api=` 与 body 里的 `params.Api`），
不给仍按 `apiPrefix/apiName` 拼。主机、Cookie、sec_token、UA、throttle 全部复用。
→ `dshhub.permissions.network` 不动（仍 8 个主机），宪法 V 的不变量不被这条改动打破。

### 3.2 切片

`sliceOfficialRange({from,to,chunkDays:30})` 按**闭区间天数**切；`startTime` = 该片首日本地零点，
`endTime` = 末日本地零点 + 1 天（官方 `mR` 判据 `end-start <= 31*86400000`，但**网关实测只放行 30 天**：
2026-11-13 实测 2026-10-01..10-31 回 `ConsoleApiError: time range cannot be longer than 30 days`）。
片与片之间用 `throttle(minIntervalMs)`（沿用全局节流，默认 1200ms；一次 74 天 = 3 片 ≈ 2.4s）。

### 3.3 解析

响应信封里可能嵌多层 `data`；找到同时含 `originData`（数组）或 `dataDownloadUrl`（字符串）的那层。
series 元素：`{ aggMethod, metricName, step, labels: { usage_type, unit? }, points: [{ timestamp, value }] }`，
**point.timestamp 是桶的右端点**（官方 UI 也做 `timestamp - step*1000`），所以
`bucketStart = timestamp - (series.step ?? step) * 1000`，再按本地 `dayKey()` 归日。

### 3.4 口径

- 官方 `total_tokens` 与本机 `input + cacheRead + output + cacheWrite` 都是「token 总量」，
  但两侧对缓存命中的记账方式不同（官方 `input_tokens` 含 cached，本机分开计），
  所以对照条只比**总量**，细分只展示官方自己的四项，不做交叉折算、不给百分比。
- 差额 = 官方 − 本机；负数照原样显示（可能来自官方延迟落账或区间边界差异），不取绝对值、不夹到 0。

### 3.5 错误码（固定，客户端据此本地化）

`official-disabled` / `official-no-credentials` / `official-login-expired` /
`official-download-url` / `official-timeout` / `official-upstream` / `official-bad-response`。
参数错误沿用 `/usage` 的 `usage-bad-range` / `usage-range-too-long`（400）。

## 4. 兼容

- `/usage` 与工具 `token_plan_quota` 的存量行为一字不改（新路由 + 新工具 action 才走官方）。
- 老配置无新键 ⇒ 走 DEFAULTS（官方开启、缓存 5 分钟）。
- 官方关掉（`officialUsage: false`）时路由回 `official-disabled`，客户端显示「已关闭」，不发网络请求。

## 5. 失败模式

1. **Cookie 过期** → 200 `official-login-expired` + 「重新登录订阅页后再抄一条 Cookie」；
   不要把「登录过期」写成「没有凭据」。
2. **网关 429/5xx** → `official-upstream`，不重试超过 1 次（避免把控制台打进限流）。
3. **只回 dataDownloadUrl** → `official-download-url`，hint 写明「官方这次把明细放到了对象存储，
   本插件不跟随未声明的出站主机」。
4. **series 缺 total_tokens** → 用 input+output 兜底并在 coverage 标 `totalDerived`。
5. **区间早于官方允许的最早日期** → 夹紧 + `coverage.clampedFrom`，不报错（用户要的是能看的数）。
6. **官方比本机小**（延迟落账）→ 差额照原样显示负数，不夹 0。

## 6. 验收

离线：`node test/host.mjs`（切片、解析、缓存、错误码、无 Cookie、夹具往返）、`node test/client.mjs`、
`node test/guards.mjs`（静态矩阵 + 无第三方依赖 + 声明主机集合不变）、`npm run check` 全绿。
在线（需重启桌面应用）：`GET /token-plan-quota/usage-official?from=2026-10-01&to=2026-10-31`（= 30+1 两片）
拿到官方 tokens；再取本机同区间，核对差额与屏上一致。

## 7. 提交计划

1. `feat(usage): 官方账号侧 token 用量（宿主与纯函数层）`
2. `feat(usage): 屏内官方口径对照条`
3. `test(usage): 官方口径的切片、缓存与错误码断言`
4. `docs(usage): 官方口径说明与截图`
