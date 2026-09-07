# 上游额度端点契约（逐条带出处与实测日期）

本文件记的是**逆向/核对结论**，不是使用手册（用法看 README）。规则表与预设的字段名都以此为准；
每次改动都请更新对应行的"验证到什么程度"与日期。

- **A** ＝ 同一把 API Key 就能查额度（零配置友好）
- **B** ＝ 需要额外凭据形态（Admin/Management key、Cookie、OAuth 本地登录态）
- **C** ＝ 官方没有额度接口（只能走本实例实测窗口）

## 一览表

| 平台 | 档 | 端点 | 鉴权 | 关键字段（含信封路径） | 验证到什么程度 |
|---|---|---|---|---|---|
| DeepSeek | A | `GET https://api.deepseek.com/user/balance` | Bearer `DEEPSEEK_API_KEY` | `balance_infos[]`：`total_balance` / `granted_balance` / `topped_up_balance`，多币种优先 CNY | ✅ 真实 Key 实测（本机长期在跳数） |
| 千问 Token Plan | B | `POST https://cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway`（内层 `tokenplan/personal/api/v2` 的 `usage` / `quota-config` / `subscription`） | 登录 Cookie 会话；`sec_token` 由 `GET https://platform-home.qianwenai.com/tool/user/info.json` 自动取 | `usage.per1WeekPercentage` / `per1WeekResetTime`（**个人版 standard 只回这两个**）；`quota-config[specCode].weekly` / `five_hour`；`subscription.specCode` / `remainingDays` / `endTime` | ✅ 真账号实测（2026-09-06）。契约按其前端包 `shared.js` 逆向 |
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
| **配置 ≠ 额度** | 千问 `quota-config` 给每个档位都躺着 `five_hour=3000`，但个人版 `usage` 只回 `per1Week*` | **一条计量只在该窗口真回读数时才存在**；孤立配置值只记 `extra.fiveHourConfiguredNoReading` |
| 别拿宿主 DOM 属性做交互判定 | `InputBar.tsx` 源码里的 `data-composer-card` 在**线上产物里不存在** | 交互语义自己定（明细=常驻小窗，不做点外面关闭），不依赖宿主实现细节 |

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
- `consoleSite=QIANWENAI`（百炼控制台是 `BAILIAN_ALIYUN`）；
- 剩余 ＝ `quota[specCode].weekly × (1 − per1WeekPercentage)`，与订阅页「剩余量/总额度」同源；
- Cookie 一般能用几周（响应里有 `sessionExpireTimeStamp`），过期后该源报错、自动退回实测卡；
- **Cookie 只从本地解析，绝不进任何路由响应**。非官方接口、可能违反上游服务条款、随时可能失效——
  详见 [`../SECURITY.md`](../SECURITY.md)。
