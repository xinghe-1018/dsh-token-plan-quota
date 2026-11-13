# 上游额度端点契约（逐条带出处与实测日期）

本文件记的是**逆向/核对结论**，不是使用手册（用法看 README）。规则表与预设的字段名都以此为准；
每次改动都请更新对应行的"验证到什么程度"与日期。

末尾另有一节「会话事件 → 用量」：那一条不是上游接口，而是把宿主自己的会话事件折成本实例实测 token 的契约。

- **A** ＝ 同一把 API Key 就能查额度（零配置友好）
- **B** ＝ 需要额外凭据形态（Admin/Management key、Cookie、OAuth 本地登录态）
- **C** ＝ 官方没有额度接口（只能走本实例实测窗口）

## 一览表

| 平台 | 档 | 端点 | 鉴权 | 关键字段（含信封路径） | 验证到什么程度 |
|---|---|---|---|---|---|
| DeepSeek | A | `GET https://api.deepseek.com/user/balance` | Bearer `DEEPSEEK_API_KEY` | `balance_infos[]`：`total_balance` / `granted_balance` / `topped_up_balance`，多币种优先 CNY | ✅ 真实 Key 实测（本机长期在跳数） |
| 千问 Token Plan | B | `POST https://cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway`（内层 `tokenplan/personal/api/v2` 的 `usage` / `quota-config` / `subscription`） | 登录 Cookie 会话；`sec_token` 由 `GET https://platform-home.qianwenai.com/tool/user/info.json` 自动取 | `usage.per1MonthPercentage` / `per1MonthResetTime`（**2026-09-23 实测：账期已改成按月，只回这两个**；旧套餐回 `per1WeekPercentage` / `per1WeekResetTime`，两条都读）；`quota-config[specCode].monthly` / `weekly` / `five_hour`，另有 `addon_quota.extrabundle`；`subscription.specCode`（lite/standard/pro/essential）/ `remainingDays` / `endTime` | ✅ 真账号实测（2026-09-06 周度形态、2026-09-23 月度形态，均由 `probe`/debug 核对字段集）。契约按其前端包 `shared.js` 逆向 |
| 千问 Token Plan（用量明细） | B | `POST https://cs-data.qianwenai.com/data/api.json?action=…` 内层 Api `zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss`（见下方专节） | 同上（平台登录 Cookie） | 信封向下找 `originData[]`（数组）或 `dataDownloadUrl`（非空字符串）；series 元素 `{aggMethod, metricName, step, labels.usage_type, points[{timestamp, value}]}`，`timestamp` 是**桶右端点**、`usage_type` ∈ `total_tokens` / `input_tokens` / `cached_tokens` / `output_tokens` | ⚠️ 前端 bundle `analytics.js` 逆向 + 2026-11-13 实测；**单次区间 ≤ 30 天**（页面传 31，网关实测拒 31 天整月）。用于 `/usage-official` 的官方口径 |
| Moonshot / Kimi 开放平台 | A | `GET https://api.moonshot.cn/v1/users/me/balance`（大陆，CNY）<br>`GET https://api.moonshot.ai/v1/users/me/balance`（国际，USD） | Bearer | 信封 `{code, status, data}`，**先判 `code==0 && status==true`**；`data.available_balance` / `cash_balance`（可负＝欠款）/ `voucher_balance` | ⚠️ 端点存在性实测（2026-09-06 两区均回 `401 invalid_authentication_error`）；字段名有官方文档与第三方实现背书，**未用真 Key 核对** |
| OpenRouter | A | `GET https://openrouter.ai/api/v1/credits` | Bearer `sk-or-v1-…` | `data.total_credits` / `data.total_usage`，**余额＝差额**（两版信封都见过：`data.*` 与裸顶层） | ⚠️ 同上：存在性实测（`401 {"error":{"message":"User not found."}}`），未用真 Key 核对 |
| OpenRouter（key 级限额） | A | `GET https://openrouter.ai/api/v1/key` | 同上 | `data.limit` / `limit_remaining` / `usage_daily\|_weekly\|_monthly` / `limit_reset` / `rate_limit.{requests,interval}` | 未接入：需要"一源第二次请求"这个架构件（见 ROADMAP T1.4b） |
| 阿里云费用中心 | A（AK/SK） | `QueryAccountBalance`(2017-12-14) / `DescribeFrInstances`(2023-09-30) / `QueryResourcePackageInstances`(2017-12-14) | AK/SK RPC 签名（HMAC-SHA1） | 见 `lib/index.js` 预设的 `extract`/`item` 候选路径 | ✅ 逐字段对过官方 OpenAPI 元数据。`QueryTokenPackageList` / `QueryFreeQuotaInstance` / `QueryBalance` / `GetSubscriptionSummary` 在这些版本里**不存在**，别配 |
| 智谱 z.ai / GLM Coding Plan | A（个人）/ B（团队） | `GET https://api.z.ai/api/monitor/usage/quota/limit`<br>`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | Bearer（大陆也接受裸 Key） | 信封 `{code:200, success, data.limits[]}`；每条 `type`(`TOKENS_LIMIT`/`CREDIT_LIMIT`/`TIME_LIMIT`)、**`unit` 是枚举：3=5h、6=周、1=天、5=分钟**、`number`、`percentage`(已用)、`currentValue`、`remaining`、`nextResetTime`(epoch ms) | 未实现（唯一还需要新 builder 的一家）。团队模式要 `Bigmodel-Organization` + `Bigmodel-Project` + `?type=2` → **明确不做** |
| MiniMax | C | 无 Key 化端点 | — | — | ✅ 实测过常见路径全部返回 SPA HTML；本机走 `window:minimax-cn` |
| OpenAI | B/C | 普通 `sk-` **无余额端点**；`/v1/dashboard/billing/credit_grants` 已弃用（仅遗留 user key）；`/v1/organization/costs` 要 **Admin key** | Bearer(Admin) | `data[].results[].amount.value` ＝ **花费**，不是剩余额度 | 未实现；普通 Key 场景按 C 处理 |
| Google Gemini | C（API Key）/ B（OAuth） | API Key 无额度端点（仅 429 带 `x-ratelimit-*`，超额 `RESOURCE_EXHAUSTED`）；Code Assist `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | OAuth | `buckets[].remainingFraction`（**剩余**比例）、`resetTime`、`modelId` | 未实现；个人版 Code Assist 已被 Google 停服（且"不支持"以 HTTP 200 返回） |
| xAI / Grok | B | `GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance` | **Management key** ＋ team id | `total.val` 是**取负的整数分**：余额＝`-Number(val)/100` | 不做（两个额外凭据＋反向单位）。**其探活会产生计费对话，禁止实现** |
| Anthropic | B/C | 普通 `sk-ant-` 无余额端点；`/v1/organizations/cost_report` 要 Admin key | Admin key / Claude OAuth | OAuth 侧 `five_hour`/`seven_day*` 的 `utilization` ＝ **已用**百分比 | 不做 |

## 单位与语义陷阱（每接一家先过这张表）

| 陷阱 | 事实 | 本插件的处理 |
|---|---|---|
| 百分比方向不一致 | 智谱 `percentage`、Claude `utilization`＝已用；Gemini `remainingFraction`＝剩余 | 预设要显式声明语义，**绝不用启发式猜 0–1 还是 0–100** |
| 金额是最小单位分、且是字符串 | Anthropic `amount`、xAI `total.val` | 声明 `unitScale: 'cents'`；`remaining` 允许负值（欠款不粉饰） |
| 枚举当数字 | 智谱 `unit` 3/6/1/5 | 声明 `unitEnum` 映射表，未识别的值**不猜**，落进 debug 骨架 |
| 信封先判再取 | Moonshot `code==0 && status==true`；智谱 `code:200, success`；OpenRouter `error.message` | 复用 `parseEnvelope` + `httpEnvelopeOk`；4xx 额外捞 `error.message` 进卡片 |
| 数字可能是字符串 | Codex `individual_limit.*`、各家 `0` | `toNumber` 剥逗号/空白；**`0` 是真值不是缺失**（有单测锁） |
| **配置 ≠ 额度** | 千问 `quota-config` 给每个档位都躺着 `five_hour=3000`，但账号的 `usage` 只回当前账期那一个比例（2026-09-06 是 `per1Week*`，2026-09-23 起是 `per1Month*`） | **一条计量只在该窗口真回读数时才存在**；孤立配置值只记 `extra.fiveHourConfiguredNoReading` |
| 别拿宿主 DOM 属性做交互判定 | `InputBar.tsx` 源码里的 `data-composer-card` 在**线上产物里不存在** | 交互语义自己定（明细=常驻小窗，不做点外面关闭），不依赖宿主实现细节 |

## 会话事件 → 用量（本实例实测，不是上游接口）

这一节与上面几家不是一回事：那些是**供应商的额度**，这里是把宿主自己的会话事件折成**按天的 token 用量**。
它不发任何网络请求，只读宿主 `sessionPersistence` 提供的快照与事件流；数字的口径永远是「经过本实例」的实测，
不折算 Credits、不估余量、不派生百分比。

| 环节 | 事实 | 本插件的处理 |
|---|---|---|
| 快照形状因宿主版本而变 | 0.1.1-rc.2 ~ 0.1.2-rc.1 上 `listSnapshots()` 与 `list()` **同时在位**：前者给 `{header, revision}`，后者只给裸 header；0.1.3-alpha.2 起反过来（`listSnapshots` 移除，`list` 升级为 `{header, revision, sizeBytes}`） | 按**语义正确者优先**探测：先 `listSnapshots()`、再 `list()`，与版本号无关（这条与 `@gehennawu/dsh-service` 的 seam 做法一致） |
| revision 类型不固定 | 有的宿主给字符串，有的给对象（如 `dev:ino:size:mtimeNs:ctimeNs` 之外的复合键） | 归一成字符串：`typeof revision === "string" ? revision : JSON.stringify(revision)`；只存归一化后的键 |
| fork 会话有继承前缀 | 前缀事件的 `seq < inheritedEventCount`；该值在 alpha.4 起挪到读片结果里，旧版放在 `read.meta.seedLength` / `header.seedLength` | 三级兜底取 cut（读片 → `meta.seedLength` → `header.seedLength` → 0），**seq < cut 一律跳过**——不跳会把继承来的历史再算一遍，数字直接翻倍 |
| 读片入口不统一 | 新宿主 `open(id, "read")` → `handle.read(fromSeq)`；旧宿主只有 `readFrom(id, fromSeq)` | 两种都走，且**都要传起点**；读不到就从 0 读，再用 cut 跳前缀 |
| 计量点只有一处 | `assistant/message` 且 `data.usage` 存在才算一次调用；四个字段 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`，缺省按 0 | 一次调用计 `calls += 1`（`steps` 与之同值，不另设字段）；没有 usage 的步骤不计 |
| 模型归属靠上一条请求头 | 最近一次 `request/header` 的 `data.header.config.{provider, model}`；有些事件流没有它 | 记 `unknown/unknown` 并累进 `stats.unknownModel` 诊断，**不丢计数** |
| 增量靠 revision + lastSeq | revision 未变说明没有新事件 | revision 未变的会话不 open、不读；变了从 `lastSeq + 1` 读新片；单份读坏只记失败，下一轮重试，不中断整轮 |
| 日界是本地日 | `toISOString()` 是 UTC，跨时区会把一天切错 | 桶键用 `getFullYear/getMonth/getDate` 拼 `YYYY-MM-DD`；保留期按本地日修剪 |
| 长区间的柱状图读不出来 | 365 根日柱既画不下也看不出趋势 | 超过 62 天改用**本地周一为界**的周桶；首末桶可以不足 7 天 |

落盘是 `$DSH_HOME/token-plan-quota.usage-index.json`（`usageIndexPath` 可改），JSON **白名单**只含：
`version` / `updatedAt` / `stats{unknownModel, skippedOld}` / `sessions{id, revision, lastSeq, cut}` /
`days{YYYY-MM-DD → 四类 token + calls + models}`。**没有消息文本、没有请求头、没有 Cookie、没有文件路径**；
坏文件（手改坏、截断）在读取时备份成 `<path>.bad-<毫秒>` 再重建，不让一份脏缓存顶掉整个统计。

口径一句话：`tokens = input + output + cacheRead + cacheWrite`（纯求和），`steps = calls`；
区间合计 == 各桶之和 == 各模型之和（三条恒等式由测试逐字段锁住）。
缓存写入这一类当前宿主多数不上报，所以 `cacheWrite` 常年接近 0——是上游没报，不是插件漏计。

## Token Plan 用量明细（bailian-telemetry）

这一节与上一节是**互补的两把尺子**：上一节只数「经过本实例」的调用，这一节是**官方账号侧**的按天明细——
同一把 Key 在其它设备、其它客户端、网页里用掉的量都在里面。两者相减（官方 − 本机）就是「官方比本机多出来的那部分」，
官方小于本机时差额为负，照原样显示、不夹 0（前端对照条里的「差额」＝ 官方 − 本机）。

| # | 项 | 事实 | 用于什么 |
|---|---|---|---|
| 1 | 完整 Api | `zeldaEasy.bailian-telemetry.platform-model.getModelMonitorDataWithOss`（挂在平台数据网关 `POST https://cs-data.qianwenai.com/data/api.json?action=…` 的 `Data` 里，与上面额度查询同一族网关） | 目前唯一能给出「官方账号侧按天 token 明细」的接口；额度接口只给百分比，不给绝对量 |
| 2 | 鉴权 | **平台登录 Cookie**，与上面「千问 Token Plan」一行同源（`sec_token` 仍从 `GET https://platform-home.qianwenai.com/tool/user/info.json` 自动取） | 不需要 API Key、不需要 Admin/Management key；Cookie 过期就是 `official-login-expired` |
| 3 | 请求体 | `Data.reqDTO = { productMode: "TokenPlanPersonal", startTime, endTime, step: 86400, metricFilters: [{ aggMethod: "sum", metricName: "model_usage" }] }` | 参数只走 `reqDTO`；`step` 固定 86400（天），本插件不做小时级 |
| 4 | 时间窗 | `startTime` = 起日**本地零点**，`endTime` = 止日**本地零点 + 1 天**（右开区间，不是止日 23:59） | 按本地日切窗，跨时区/跨日边界不会漏掉最后一天；与宿主统计用的本地日界一致 |
| 5 | 单次区间上限 | 前端传 `maxDayRangeDays: 31`，但**网关按 30 天卡**：2026-11-13 实测 2026-10-01..10-31 回 `ConsoleApiError: time range cannot be longer than 30 days`，改成 10-01..10-30 成功；再长官方改走导出任务（见第 12 条） | 宿主按 **30 天**切 chunk 查询再合并，`coverage.chunks` 记实际块数、`step: "day"` 记粒度 |
| 6 | 最早可查 | 只能查到「**当前月往前 5 个月**的 1 号」（`officialEarliestDayKey({ now, monthsBack: 5 })`），更早的请求官方拒绝或回空 | 宿主先夹紧到该日，并把被夹过的起点如实写进 `coverage.clampedFrom`（只在夹紧时出现） |
| 7 | 响应信封 | **别按固定层级取**：从响应树向下找同时含 `originData`（数组）或 `dataDownloadUrl`（非空字符串）的那一层（`parseOfficialEnvelope`） | 网关外面套着 `{success, data, result}` 若干层且随 action 变；写死 `data.data.originData` 会在网关换皮时静默变空 |
| 8 | series 形状 | 每个 series 是 `{ aggMethod, metricName, step, labels: { usage_type }, points: [{ timestamp, value }] }` | 只认 `aggMethod === "sum"` 且 `metricName === "model_usage"` 的 series（`foldOfficialSeries`），别的聚合口径不猜 |
| 9 | `timestamp` 是桶的**右端点** | 归桶要 `bucketStart = timestamp − (step ?? 86400) × 1000`，再按本地日落到 `YYYY-MM-DD`；官方控制台自己的图表也做同样的减 | 忘记减会让整段数字整体错后一天，而总量看着仍然「差不多」，是最难靠肉眼发现的一处 |
| 10 | `usage_type` 四个值 | `total_tokens` / `input_tokens` / `cached_tokens` / `output_tokens` | 直接映射到 totals 的 `tokens` / `input` / `cacheRead` / `output`；未识别的值丢弃，不猜 |
| 11 | input **含**缓存命中 | `cacheHitRate = cached_tokens / input_tokens`，即 `input_tokens` 里已经包含 `cached_tokens` | 只有缺 `total_tokens` 时才兜底 `input + output`（`coverage.totalDerived: true`），**绝不再加 cached**（会翻倍）；展示时 cached 单列成 cacheRead |
| 12 | 只回下载链接 | 响应可能只有一个 `dataDownloadUrl`，指向对象存储上的导出文件（前端再去拉 CSV/JSON） | 本插件**不跟随该主机**（对象存储域名未在 `dshhub.permissions.network` 声明，`DECLARED_HOSTS` 保持 8 条不变），按 `official-download-url` 报错并提示去控制台看 |
| 13 | 超长区间的导出任务 | 官方对超长区间走 `SubmitTokenPlanUsageExportTask` / `GetTokenPlanUsageExportTask` 生成导出文件 | 本插件**不用**（30 天切块已经够），也不声明导出主机；`official-download-url` 的提示里不提这两条任务 |
| 14 | 失败口径 | HTTP 200 里的失败体是 `{ error: "official-unavailable", code, hint }`，`code` 是固定枚举：`official-disabled` / `official-no-credentials` / `official-login-expired` / `official-download-url` / `official-timeout` / `official-upstream` / `official-bad-response` | 客户端按 `code` 出可操作提示（例如「去控制台登录」）；**网络失败不等于 0 用量**，绝不渲染成一张全 0 的图 |
| 15 | 与「本机实测」的关系 | 官方口径含同一账号在其它设备/其它客户端的用量，所以通常 ≥ 本机实测；两者窗口都按本地日切 | 差额 = 官方 − 本机（可为负，负数照原样），前端把它标成「差额」而不是「误差」——这是两把尺子的差，不是任何一方算错 |

**证据来源**：从 `platform.qianwenai.com` 前端 bundle（`analytics.js`）逆向 + 2026-11-13 实测；**不是官方公开文档**，
官方没有把这套 Api 写进 API 文档，字段与边界以本表的实测为准；实现侧的响应形状见 `specs/008-official-token-usage/INTERFACE.md`。

## 会话日志文件（多帧 zstd，兜底扫描）

宿主给的会话列表**不保证全**：本机 2026-11-13 实测 217 个会话目录里有 **2 个不在 `list()` 的返回里**
（`session-373f78cb-…` 137 calls / 8,535,136 tokens、`session-73bbb3d1-…` 314 calls / 56,700,666 tokens），
目录与 header 都正常，只是列表里没有。所以同步末尾会按下面的契约直接读日志文件补扫——这一节记的就是这些事实。

| # | 项 | 事实 | 本插件的处理 |
|---|---|---|---|
| 1 | 目录结构 | `<sessions>/<项目目录>/<会话目录>/<日志文件>`，本机 24 个项目目录、217 个会话目录 | 只扫**两级**（项目/会话），不递归更深；根目录由 `usageScanPath` 给（默认 `$DSH_HOME/sessions`） |
| 2 | 目录名就是会话 id | 两种形态并存：132 个 `session-<uuid>` + 85 个裸 `<uuid>`，索引键同样是 130 前缀 + 85 裸 | **不剥 `session-` 前缀**，目录名原样当 id；剥了会对不上已有索引、把同一会话算两遍 |
| 3 | 一个会话可能有多个版本的日志 | 本机 242 份日志对应 217 个目录，同时存在 `session.v4.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.jsonl.zstd` 的目录不少 | 只读**版本最高**的一份（v4 > v3 > v2 > 无版本），否则同一份事件被折两次 |
| 4 | 日志是**多帧** zstd | 242 份里 237 份是多帧；整份 buffer 直接 `zlib.zstdDecompressSync` 只出第一帧（实测 451 KB 的文件只解出 271 字节的 header） | 按 magic `28 B5 2F FD` 切帧、逐帧解压再拼文本；坏帧延展到下一个 magic 重试（最多 8 次），全失败计 `scanFailed` 不猜内容 |
| 5 | 解压 API 有版本门槛 | `zlib.zstdDecompressSync` 在 Node 24 有，但本包声明 `engines.node >= 20` | 能力守卫：没有该 API 时跳过兜底扫描（`reason: "no-zstd"`），不影响主路径 |
| 6 | 每行一个 JSON 事件 | 与读片拿到的事件同构：`{ seq, type, time, data }`；`request/header` 与 `assistant/message`+`usage` 才计量 | 复用读书片同一个折叠函数（`foldUsageEvents`），**不另写一套计数逻辑**，口径不会漂 |
| 7 | fork 会话有继承前缀 | 3 份日志 `header.isSeeded: true`；前缀结束标记是 `type === "session/end-seed"` 且 `data.inherited === true`（本机例：seq 6 / 622 / 2090） | 有该标记时 cut = 位置 + 1，`seq < cut` 跳过；`isSeeded` 不为真时 cut = 0。**缺这层会把父会话的历史再算一遍** |
| 8 | 增量靠文件签名 | 日志只追加，没有可比的 revision | 签名 = `file:<bytes>:<mtimeMs 取整>` 写进 `index.sessions[id].revision`；签名没变直接跳过，不重复读 |
| 9 | 文件可能变短（归档/被重写） | 变短意味着 `maxSeq < previous.lastSeq`，此时继续往后追加会漏一段 | 变短**不折**（保留旧条目）并计 `scanFailed`，等下次完整重扫 |
| 10 | 全量解码很贵 | 132 份 / 195 MB / 334,571 事件 → 23,742 calls / 6,365,369,524 tokens，耗时 18.4 秒 | 每轮 64 MB 预算（`FALLBACK_SCAN_BUDGET`），超了记 `scanDeferred`、下一轮接着扫；逐文件 `setImmediate` 让出，不卡事件循环 |
| 11 | 正常只扫几个 | 补集就是列表缺的那几个目录（本机 2 个，约 1.3 MB） | 候选 = 「不在宿主列表里」且「索引里没有成功条目或签名变了」，所以稳态每轮只碰这几个文件 |
| 12 | 口径 | 与读片完全相同：只认 `assistant/message` 的 `usage` 四字段，日界是本地日，`tokens = input + output + cacheRead + cacheWrite` | 屏上不区分来源，只在脚注写「另有 N 个会话不在宿主的会话列表里，已按日志目录补扫」（`coverage.rescued`）；本机实测这段历史共约 6,500 万 tokens，多数落在 9 月（10 月约 640 万） |

**证据来源**：2026-11-13 在本机 `$DSH_HOME/sessions` 上全量实测（切帧解码脚本 + 与 `list()` 结果做补集对比），
不是宿主文档；宿主把日志格式改掉时这一节的第 4/6/7 条会先失效，那时兜底扫描应当静默退化为「不补」而不是算错数。

## 参考实现（都是 MIT，引用契约请注明出处）

- [`steipete/CodexBar`](https://github.com/steipete/CodexBar) —— 每家一个 `docs/<provider>.md`，
  含 `alibaba-token-plan.md` / `alibaba-coding-plan.md` / `zai.md` / `openrouter.md` 等；
  其 `gateway-quota-adapters` 注释也警告过"各家百分比语义不同，严禁共用一个 normalize"。
- [`hanmumuHL/check_balance`](https://github.com/hanmumuHL/check_balance) —— 多 provider 余额查询。
- 本仓库对千问控制台网关的契约，按其前端包 `shared.js` 逆向 + 真实账号实测得到；
  网关的人机校验会拒自定义 User-Agent（报 `PostonlyOrTokenError`），请求必须用浏览器 UA。

## 千问 Token Plan 的 Cookie 细节（唯一在用的 Cookie 源）

1. 浏览器登录打开订阅页 → F12 Network → 复制任一请求的**整行 `Cookie:`**；
2. 存进 `~/.dsh/.credentials.yaml`：`BAILIAN_CONSOLE_COOKIE: <内容>`（一行，别换行）；
3. 点面板底部「更新于」强制刷新即可生效（宿主每次查询重读凭据，不用重启）。

- `sec_token` 全自动（`tool/user/info.json` → `data.secToken`），手配 `BAILIAN_CONSOLE_SECTOKEN` 只作兜底；
  **取不到时单独报 `MissingSecToken`** 并带原因（`no-token` / `http-<状态>` / `network:<错误名>`），不把它混进 Cookie 的问题里；
  原因写成 `no-token` 时错误里再附那份响应的**键名骨架**（`jsonKeyShape`：只下探一层、只列名字与类型），
  用来判断 token 是改名、挪层还是会话压根没发——这是 2026-11-03 之后才有的线索，之前只能盲猜重抄；
- 登录票据是 `login_qianwenai_ticket`：网关回 `NotLogined` 时，插件会把**收到的 Cookie 名**与目标主机写进错误里，
  抄错主机（只有 `cna`/`cnaui`/`tfstk` 这类反爬 Cookie）当场看得出来（2026-10-06 实机踩过）；
  三种成因分流到 2026-11-03 才分得开——票据在场而 token 没附上时上游同样回 `NotLogined`，旧文案一律断言"多半抄错了
  主机"，于是重抄 Cookie 永远修不好；现在只有"票据与 token 都在仍被拒"才指向会话过期；
- `consoleSite=QIANWENAI`（百炼控制台是 `BAILIAN_ALIYUN`）；
- 剩余 ＝ `quota[specCode].monthly × (1 − per1MonthPercentage)`，与订阅页「剩余量/总额度」同源；
  **2026-09-23 起账期改成按月**（`usage` 只回 `per1Month*`，档位额度字段从 `weekly` 改名 `monthly`），
  代码同时保留 `weekly` 口径回退，旧套餐不受影响。`addon_quota.extrabundle` **不并进分母**——
  官方没说明它与档位额度的关系，折进去就是估算（原则 I）。
- **`quota-config` 会偶发超时**（2026-09-23 实测：连打 5 次 `?fresh=1`，1 次没拿到分母，那次全程
  19.8 s；单次超时 `timeoutMs=15000`，四次调用之间还有 `minIntervalMs=1200` 串行节流）。这种时候
  `usage` 里的官方比例仍然拿得到：卡片**照报「本周期已用 x%」并照它画条**（条画的是同一个官方比例），但不报绝对剩余量，
  并留 `extra.denominatorFailed=true` 诊断 —— 原则 I（v2.0.0）禁的是**派生**，不是上游直给的官方数；
- Cookie 一般能用几周（响应里有 `sessionExpireTimeStamp`），过期后该源报错、自动退回实测卡；
- **Cookie 只从本地解析，绝不进任何路由响应**。非官方接口、可能违反上游服务条款、随时可能失效——
  详见 [`../SECURITY.md`](../SECURITY.md)。
