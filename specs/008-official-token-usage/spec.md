# 008 — 官方账号侧 token 用量（Token Plan 用量明细）

## 1. 用户故事

用户在本机屏上看到 2026-10 用量 12.5 亿 tokens，但他记得官方订阅页「用量明细」给出的是 20 亿量级。
本机统计只折本实例的会话日志（别的设备 / 别的客户端走同一张 Token Plan Key 的用量在本地没有痕迹），
所以对不上时**唯一能判定的证据在官方侧**。用户要求：用 tokens 而不是 Credits 看官方口径，
并且屏上能一眼看出「官方账号侧」与「本机实测」差多少。

## 2. 功能需求

- FR-001 宿主新增只读路由 `GET /token-plan-quota/usage-official`，参数语义与 `/usage` 完全一致
  （`days` / `range` / `from`+`to`，同一套夹紧与 400 固定码）。
- FR-002 数据源 = 控制台数据网关（与 `token-plan-console` 同一主机、同一 Cookie / sec_token），
  `Api = zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss`，
  `Data.reqDTO = { productMode: "TokenPlanPersonal", startTime, endTime, step: 86400,
  metricFilters: [{ aggMethod: "sum", metricName: "model_usage" }] }`。
- FR-003 官方单次查询上限 **30 天**（官方前端传 `maxDayRangeDays: 31`，但 2026-11-13 实测网关拒 31 天整月：
  `ConsoleApiError: time range cannot be longer than 30 days`；`endTime` 为闭区间末日次日零点）⇒
  宿主按 ≤30 天切片、逐片请求后合并；桶按**本地日**补齐（缺失日给 0 桶，不丢桶）。
- FR-004 官方只允许查询「当前月往前 5 个月的 1 号」之后的日期 ⇒ 超出部分由宿主夹紧并在
  `coverage.clampedFrom` 里写明，不静默截断。
- FR-005 汇总取 series 的 `labels.usage_type`：`total_tokens` / `input_tokens` / `cached_tokens` /
  `output_tokens`；`total_tokens` 缺失时用 `input_tokens + output_tokens` 兜底并在
  `coverage.totalDerived = true` 标注（官方 `input_tokens` 含缓存命中，故不再加 cached）。
- FR-006 缓存：同一 `(from,to)` 在 `officialUsageMinutes`（默认 5 分钟）内复用；`?fresh=1` 强制回源。
- FR-007 失败不污染本机口径：无 Cookie / 上游错误 / 只回 `dataDownloadUrl` 时返回 200 +
  `{ error, code, hint }`（固定码，不回上游 message 原文），客户端按错误态渲染。
- FR-008 客户端：用量屏在柱状图卡片后加「官方账号侧 / 本机实测 / 差额」对照条；
  官方不可用时只显示一行原因 + 重试，**不显示 0 或占位数字**；中英双语，文案禁 % 与 Credits。

## 3. 非目标

- 不把官方序列画进 2D/3D 柱状图（v1 只做对照数字；柱状图仍为本机实测的逐模型/逐日）。
- 不做官方历史落盘与增量同步（每次按区间现取 + 内存缓存）。
- 不跟随 `dataDownloadUrl` 指向的对象存储主机（未在 `dshhub.permissions.network` 里声明；
  实测若真回下载链接，按 `official-download-url` 报错，见 plan §6）。
- 不做小时粒度（`step: 3600`）与团队/席位口径。

## 4. 成功判据

- SC-001 重启后实测 2026-10-01..10-31 能拿到官方 tokens（按 30+1 两片拼接），并与本机 1,252,681,694 并排显示；
  差额按 `官方 − 本机` 计算（正数＝本机之外的用量）。
- SC-002 74 天区间切片请求数 = 3，逐日合计 = 各片合计之和（离线单测断言）。
- SC-003 无 Cookie / 上游 500 时返回固定 `code` 与中文 hint，响应里不含 Cookie 值或上游原文。
- SC-004 官方序列缺某天 ⇒ 该天 0 桶；桶数与区间天数严格相等。
- SC-005 `npm run check` 在最后一次编辑之后全绿（含 README 双语计数与配置表）。
