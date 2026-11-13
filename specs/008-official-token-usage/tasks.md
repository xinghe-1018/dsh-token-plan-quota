# TASKS — 008 官方账号侧 token 用量

- T001 纯函数模块 `lib/official-usage.js`：`sliceOfficialRange` / `parseOfficialEnvelope` /
  `foldOfficialSeries` / `buildOfficialUsage`（含 0 桶补齐、最早日期夹紧、totalDerived 兜底）。
- T002 宿主：`callConsoleGateway` 支持 `options.apiPath`；`fetchOfficialUsage`（切片 + 节流 + 缓存 +
  固定错误码）；`buildOfficialUsageSnapshot`；路由 `GET /token-plan-quota/usage-official`；
  预设加 `telemetryApi` / `telemetryStepSeconds` / `telemetryChunkDays` / `telemetryEarliestMonths`；
  DEFAULTS 加 `officialUsage` / `officialUsageMinutes`。
- T003 宿主测试（`test/host.mjs`）：切片边界、逐日合计、0 桶、缺 total 兜底、缓存命中/过期、
  `fresh=1`、无 Cookie 码、上游 500 码、响应不含 Cookie、声明主机集合不变。
- T004 客户端（`lib/client.js`）：`usage-official` 取数（与本机快照同区间、stale 保护、请求序号）、
  对照条三格 + 细分行 + 错误态 + 重试；i18n zh/en 8 键。
- T005 客户端测试（`test/client.mjs`）：DOM 断言 + 差额计算 + 错误态不渲染数字 + 切区间重取。
- T006 文档：README / README.en 用量统计节与配置表、CHANGELOG、`docs/upstream-contracts.md`
  新增 telemetry 契约（请求体、series 形状、**30 天**上限——页面写 31 但网关实测拒、最早日期、下载链接不跟随）、
  `scripts/check-docs.mjs` 截图清单与计数。
- T007 截图与门禁：`scripts/shots` 加官方 fixture 与场景，出 `usage-official-2d.png`（zh/en）；
  `npm run check` 全绿；重启后在线验收 10 月官方 tokens。
