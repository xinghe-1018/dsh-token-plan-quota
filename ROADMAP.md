# ROADMAP — dsh-token-plan-quota

三阶段：**① 适配更多平台 → ② 零配置自动检测（模型 ↔ 余量源自动绑定）→ ③ 重写 README，开源发布**。
顺序有依赖：②的匹配规则表要覆盖①新增的平台，③要把①②的成果写成对外文档。

版本计划：① → `0.3.0`，② → `0.4.0`，③ → `1.0.0`（首个对外版本）。
每阶段收尾都要 `node test/host.mjs && node test/client.mjs` 全绿，且新增用例覆盖新分支。

---

## 0. 现状盘点（v0.2，代码事实）

| 位置 | 现状 | 对后续的影响 |
|---|---|---|
| `PRESETS`（`lib/index.js` ~L678） | 6 个预设：`deepseek-balance`、`token-plan-window`、`token-plan-console`、`account-balance`、`fr-instances`、`resource-package` | 新平台＝新预设条目，形状已够用（`kind: single/list/window`） |
| `normalizeSources()`（L926） | 只认 `sources` 数组里的字符串名或 `{id,...覆盖}`；**没有任何"从宿主供应商列表推导"的路径** | ②的插入点就在这里之后 |
| `source.providers` | 手填的供应商 id 列表 → `bindProviders` 透传给前端（L1608） | ②要用自动匹配结果填这个字段 |
| 前端 `lib/client.js` L889-911 | **徽标跟随当前模型 provider 已实现**（`sessions.list` → `modelDirectories`，`bindOf(card).includes(provider)` 精确匹配） | ②基本不用动前端；只做"无绑定源时的兜底显示" |
| `resolveSecret()`（L961） | 凭据解析链：DSH 凭据服务 → env → `.credentials.yaml` → `.env` | ②的"有凭据才启用"直接复用 |
| `DEFAULTS.sources`（L41） | 硬编码 `['deepseek-balance','token-plan-window']` | ②落地后改成 `autoDetect: true` 的推导结果 |

### 0.1 已验证的漂移：手填 `providers` 与宿主真实路由不匹配（本机实测）

`GET /token-plan-quota/summary` 与 `~/.dsh/settings.yaml` 的一次真实对账（2026-09-06；
**余额与用量数字一律不记**，它们属于个人账号，且对结论没有任何加成）：

| 事实 | 来源 |
|---|---|
| 这台实例**在用的供应商路由只有两条**：`qwen-token-plan-cn`、`minimax-cn`（`deepseek-v3.2/v4` 只是 Token Plan 网关上的模型名） | `settings.yaml` → `llm-pi-ai.providers` |
| 四条凭据引用都在，且命名跟着路由走：`QWEN_TOKEN_PLAN_CN_API_KEY`、`MINIMAX_CN_API_KEY`、`DEEPSEEK_API_KEY`、`BAILIAN_CONSOLE_COOKIE` | `~/.dsh/.credentials.yaml`（只看键名，未取值） |
| `deepseek-balance` 每 10 分钟真打一次 `api.deepseek.com` 并**拿到过非空余额**，但它的 `bindProviders=['deepseek']` **没有任何在用路由对得上 → 这张卡在徽标和明细面板里都不可见**（`panelScope: current`） | summary 响应 `cards[].bindProviders` |
| `minimax-cn` 有路由、有 Key，却**没有任何数据源绑定** → 切到 MiniMax 模型时整枚徽标消失（README「已知边界」里那条，实为可改进项） | 同上 |

结论：这不是"某个别名写错"，而是**数据源清单与实际供应商拓扑各写各的、必然漂移**——
①阶段先临时加别名 `['deepseek','deepseek-official']`（DSH 出厂适配器注册的 id 是
`deepseek-official`，见 `packages/llm/llm-deepseek/src/index.ts` L81）止住不可见，
②阶段做完后这类手填整体消失。附带收益：省掉一次**用户根本看不到的**上游请求（每 10 分钟一次）。

### 0.2 其他先修项（开工①之前，一次小提交）

- `package.json` 的 `version` 还是 `0.1.0`，但 git 已提交 `v0.2`；顺手补 `0.2.x` 与 `v0.2` tag。
- `dshhub.permissions.network` 只声明了 `business.aliyuncs.com`，实际出站主机还有
  `api.deepseek.com` / `cs-data.qianwenai.com` / `platform-home.qianwenai.com`。声明不全＝对外审查时
  第一个被抓的问题（③之前补齐，随每个新平台增量维护）。

---

## 1. 阶段①：适配更多平台

### 1.1 端点核实结论（2026-09，全部带出处）

分三档：**A＝同一把 Bearer Key 就能查额度（零配置友好）**；**B＝需要额外凭据形态**（Cookie /
OAuth 文件 / Admin key）；**C＝官方没有额度接口**（只能走本实例实测窗口）。

| 平台 | 档 | 端点 | 鉴权 | 关键字段（**含信封路径**） | 备注 |
|---|---|---|---|---|---|
| Moonshot / Kimi 开放平台 | A | `GET https://api.moonshot.ai/v1/users/me/balance`（国际，USD）<br>`GET https://api.moonshot.cn/v1/users/me/balance`（大陆，CNY） | `Authorization: Bearer` + `Accept: application/json` | **信封 `{code, status, data}`：先判 `code==0 && status==true`**，再取 `data.available_balance` / `data.cash_balance` / `data.voucher_balance` | 路径是 `/v1/users/me/balance`，**不是** `/v1/users/balance`（后者只 401 存在、非额度用途）。无窗口概念；`cash_balance` 可为负＝欠款。[官方](https://platform.kimi.ai/docs/api/balance.md) |
| OpenRouter | A | `GET https://openrouter.ai/api/v1/credits`；补强 `GET /api/v1/key` | Bearer `sk-or-v1-…` | `/credits` → `data.total_credits`、`data.total_usage`（**余额＝差额**）<br>`/key` → `data.limit`、`data.limit_remaining`、`data.usage`、`data.usage_daily/_weekly/_monthly`、`data.limit_reset`(`daily`/`weekly`/`monthly`)、`data.rate_limit.{requests,interval}` | `/api/v1/auth/key` 是 `/key` 的遗留别名；`/api/v1/activity` **要 Management key**（另一种凭据）→ 不做。[官方](https://openrouter.ai/docs/api-reference/limits) |
| 智谱 z.ai / GLM Coding Plan | A（个人）/ B（团队） | `GET https://api.z.ai/api/monitor/usage/quota/limit`（全球）<br>`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（大陆） | Bearer；大陆也接受裸 Key | 信封 `{code:200, success, data.limits[]}`；每条 `limits[i]`：`type`(`TOKENS_LIMIT`/`CREDIT_LIMIT`/`TIME_LIMIT`)、**`unit` 是枚举不是分钟：3=5 小时、6=周、1=天、5=分钟**、`number`、`percentage`、`currentValue`、`remaining`、`nextResetTime`(epoch ms)、`usageDetails[]` | **多计量条**正主：一次响应给 5h/周/日多窗口。**团队模式要 `Bigmodel-Organization` + `Bigmodel-Project` 头 + `?type=2` → 按决策不做**。现金余额另有一家用控制台端点 `GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report` → `data.availableBalance`（**非 open 域、非官方公开 API**，谨慎）。[CodexBar docs/zai.md](https://github.com/steipete/CodexBar/blob/main/docs/zai.md) |
| Kimi Code（`kimi.com/code` 订阅） | B | `GET https://api.kimi.com/coding/v1/usages` | API Key（`KIMI_CODE_API_KEY`）或 Cookie 或复用 `~/.kimi-code/credentials/kimi-code.json` | 周请求配额、5 小时限流、membership | 与开放平台是**两套不同东西**，别混；Cookie/CLI 凭据形态按决策不做。[docs/kimi.md](https://github.com/steipete/CodexBar/blob/main/docs/kimi.md) |
| OpenAI | B/C | 普通 `sk-` **无任何余额端点**（`/v1/dashboard/billing/credit_grants` 已弃用，仅遗留 user key 可用：`total_granted`/`total_used`/`total_available`）；`GET /v1/organization/costs?start_time=&end_time=&bucket_width=1d` 要 **Admin key**（普通 key 403） | Bearer（Admin）/ OAuth | `data[].results[].amount.value`＝**花费**（USD），不是剩余额度 | Codex 订阅是 OAuth：`GET https://chatgpt.com/backend-api/wham/usage` + `ChatGPT-Account-Id` 头，token 在 `~/.codex/auth.json` → 按决策不做。普通 Key 场景＝C 档实测窗口 |
| Google Gemini / AI Studio | C（API Key）/ B（OAuth） | `generativelanguage.googleapis.com` **无额度端点**（仅 429 响应带 `x-ratelimit-*` 头、超额报 `RESOURCE_EXHAUSTED`）；Code Assist 走私有 `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`（`buckets[].{modelId,tokenType,remainingFraction,resetTime}`，`remainingFraction` 是**剩余**比例） | OAuth（`~/.gemini/oauth_creds.json`）＋ project id（`loadCodeAssist`）；刷新还要 gemini-cli bundle 里的 client_id/secret | — | 消费版 Code Assist 已被 Google [停服](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)（且"不支持"信号以 **HTTP 200** 返回）。→ 只做实测窗口 |
| xAI / Grok | B | `GET https://management-api.x.ai/v1/billing/teams/{team_id}/prepaid/balance` | **Management key**（推理 Key 被拒）＋ team id | `total.val` 是**取负的整数分**：余额＝`-Number(val)/100` | 两个额外凭据＋反向单位，性价比极低。[官方](https://docs.x.ai/developers/rest-api-reference/management/billing) |
| Anthropic | B/C | 普通 `sk-ant-` 无余额端点；`GET /v1/organizations/cost_report` 要 **Admin key**（`x-api-key` + `anthropic-version`），金额字段是**最小单位分、字符串** | Admin key / Claude OAuth（`api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20`） | OAuth 侧窗口 `five_hour`/`seven_day*` 的 `utilization` ＝**已用**百分比 | 与 Gemini 的 `remainingFraction`（剩余）**方向相反** |
| MiniMax | C | 无 Key 化端点（此前实测：常见路径全返回 SPA HTML）；CodexBar 靠控制台页面/Cookie | — | — | 只做实测窗口。[docs/minimax.md](https://github.com/steipete/CodexBar/blob/main/docs/minimax.md) |
| 阿里云百炼 Coding Plan / Qwen Cloud | A/B | 见 CodexBar `alibaba-coding-plan.md` / `qwen-cloud.md` | AK/SK 或 Cookie | — | 我们已有 Token Plan 控制台契约，可复用同一套 Cookie 机制 |
| 长尾（SiliconFlow / CommandCode / SCNet / 火山方舟 / stepfun / mimo / longcat / doubao / groq / mistral …） | 视各家 | — | — | — | **不预设**：现有 `kind: http/single + extract` 已允许用户自己在 JSON 里配；`dsh-cost-meter` 已覆盖其中九家，优先做差异化而非重复 |

### 1.1.1 单位与语义陷阱（每接一家先过这张表，接错方向＝仪表反向）

| 陷阱 | 事实 | 我们怎么防 |
|---|---|---|
| **百分比方向不一致** | 智谱 `percentage`、Claude `utilization`＝**已用**；Gemini `remainingFraction`＝**剩余** | 预设里强制声明 `percentSemantics: 'used' | 'remaining'`，`buildSingleCard`/`meters` 归一时按声明转，**绝不用启发式猜 0–1 还是 0–100**（`dsh-cost-meter` 的 `gateway-quota-adapters.js` 注释也专门警告过这点） |
| **金额单位是最小单位分、且是字符串** | Anthropic `amount`、xAI `total.val` | 预设声明 `unitScale: 'cents'`＋`toNumber` 后再除；`remaining` 为负值要能显示（Moonshot 欠款场景） |
| **枚举当数字** | 智谱 `unit`：3=5 小时、6=周、1=天、5=分钟 | 预设声明 `unitEnum` 映射表，未识别的枚举值**不猜**，落到 `debug` 骨架里 |
| **信封先判再取** | Moonshot `code==0 && status==true`；智谱 `code:200, success` | 已有 `envelopeOk` 机制（`httpEnvelopeOk` L1353），新家用 `okWhen` 声明，别新写一套 |
| **数字可能是字符串** | Codex `individual_limit.{limit,used,remaining_percent}` | `toNumber` 已剥逗号/空白，够用；加一条单测锁住 |
| **配置 ≠ 额度** | 千问 `quota-config` 给**每个档位都躺着**一个 `five_hour` 上限，但 `usage` 只回 `per1Week*`——**这个套餐根本没有 5 小时窗口**。拿配置去拼一行「额度上限 <那个配置值>」就是把噪声当额度（2026-09-06 用户实拍打回；具体数值属于个人账号，不记） | **一条计量只在该窗口真回了读数时才存在**；档位配了却无读数只记 `extra.fiveHourConfiguredNoReading` 供 debug，前端再把"没有任何可说数字"的次级计量整行丢弃。接 GLM 多窗口家时同规则：`limits[]` 里没出现的 type/unit 组合不出条 |
| **别拿宿主 DOM 属性做交互判定** | `InputBar.tsx` 源码里有 `data-composer-card`/`data-input-scroll`，但**浏览器真正加载的产物里没有**（抓 `/assets/index-*.js` 直接 grep 验证过）→ 用"点哪里算宿主输入区"来豁免关面板必然漏 | 交互语义自己定，不依赖宿主实现细节：明细面板改成**常驻小窗**（取消「点外面就关」，只留徽标 toggle + Esc），从此不需要认识宿主输入区 |
| **探测会产生费用** | xAI 探活会补一条真实对话消息 | **本插件永不做"猜测式探活"**；只用只读端点，`probe` 路由也只打配置好的源 |

### 1.2 阶段①需要先做的 4 个架构改动（否则每加一家都在硬塞）

1. **多计量条卡（P1 关键）**：现在一张卡只有 `remaining/total/usedPercent` 一组标量，第二组塞在
   `extra.fiveHour*` 里（`buildConsoleCard` L1274）。把卡的形状升级为 `meters: [{key,label,used,total,
   unit,resetAt}]`，`extra` 保留兼容；前端 `renderCard` 改成遍历 `meters`（千问卡片迁移到同一形状，
   顺便去掉 `fiveHour*` 特殊字段）。没有这一步，GLM/Kimi Code/OpenRouter 三家都表达不了。
2. **派生表达式**：OpenRouter 余额＝`total_credits − total_usage`。在 `extract` 之外加
   `derive: { remaining: 'a-b', used: 'b', total: 'a' }`（只支持加减，不做表达式引擎），
   在 `buildSingleCard`（L1523）里应用。
3. **区域/端点变体**：Moonshot（.ai/.cn）、GLM（api.z.ai/open.bigmodel.cn）都要"同一家两个 host"。
   预设加 `regions: { international: {...}, 'china-mainland': {...} }` + 配置项 `moonshotRegion`
   /`glmRegion`（默认按 Key 前缀/币种猜一次、错了日志说清楚），**不做自动探测 region**（探测＝多打一次网络）。
4. **鉴权形态收口**：`auth: 'bearer' | 'ak-sk' | 'cookie' | 'oauth-local-cli'`。①只实现前三种，
   `oauth-local-cli`（读 `~/.codex/auth.json`、`~/.kimi-code/…`）**明确划到①范围外**：
   读别的 CLI 的登录态属于 B 类强侵入，开源后要单独一轮评审（含"只读不回传"的边界与 README 警告）。

### 1.3 阶段①任务清单（按可独立提交的顺序）

- [x] T1.0 修 §0.1 的别名止漏 + §0.2 两个元数据问题（`deepseek-official` 别名进预设与前端兜底表；
      `version` → 0.2.0；`dshhub.permissions.network` 补 `api.deepseek.com`/`cs-data.qianwenai.com`/
      `platform-home.qianwenai.com`/`cdn.jsdelivr.net`；补 `repository`/`homepage`）
- [x] T1.1 卡形状升级 `meters[]` + 前端渲染改造 + 千问卡迁移（宿主 `finalizeMeter` 统一派生百分比、
      **无官方分母即无百分比**；前端 `MeterRows` 只渲染 `meters.slice(1)`、实测卡强制不出条不出百分比、
      `cardValueText` 对实测卡只报 tokens；host 179 / client 82 全绿）
- [x] T1.2 `derive` 支持 + 单测 → **改期到 T1.4 一起做**（OpenRouter 的差额计算跟着它才有被测的对象）
- [x] T1.3 预设：`moonshot-balance`（含 region）→ 首个新平台，跑通"新增一家"的全流程模板
      （模板五件套＝预设 + `regions` + `SOURCE_META` + 源级 `errorHints` + 回环单测；见 `lib/index.js`
      里 `moonshot-balance` 的注释）。顺带长出三个可复用件：`regions`（区→host+币种成对切换，
      优先级 条目 region > 全局配置键 > 预设默认，认不出退回默认并 warn）、`buildSingleCard` 支持
      静态 `unit`（Moonshot 这类端点不回币种）、`hintFor(code, source.errorHints)`（同一个 401
      在不同家给不同人话），另外 4xx 现在会捞 `error.message` 进卡片（不再只写 `HTTP 401`）。
      **待办**：本机没有 Moonshot Key，`available_balance` 等字段名只有官方文档 + 第三方实现背书；
      真实 Key 的核对归 T1.8（已实测两区端点存在：无效 Key 回 401 `invalid_authentication_error`）。
- [x] T1.4 预设：`openrouter-credits` + **`derive` 落地**（`evalDerive`：只认「一个 `+`/`-`、
      两侧是引用名或数字」，操作数取不到就整条空——宁缺勿猜；不做乘除/括号/连算，真需要就写专用
      builder）。余额＝`totalCredits - totalUsage`，两版信封（`data.*` 与裸顶层）都给候选路径。
      实测两路径存在：无效 Key 回 `401 {"error":{"message":"User not found."}}`（正好是新的 4xx
      人话提取吃的形状）。**待办**：真实 Key 的字段核对归 T1.8。
- [ ] T1.4b 一源多请求（`/api/v1/key` 的 key 级 `usage_limit` 与日/周/月花费进同一张卡的第二条
      meter）。这是**新的架构件**（现在一个 source 一次请求），别为了塞 OpenRouter 的第二条窗口
      去 hack 一个假 meter；等 GLM 那种"一次请求多窗口"验证完 meters 形状后再做，顺序更稳。
- [ ] T1.5 预设：`glm-quota`（多计量条真落地，含 CN region）→ **主动推迟**（2026-09-06）：
      它是唯一还需要**新 builder** 的一家（`data.limits[]` 一次回多窗口，还要 `unitEnum` 3=5h/6=周/1=天
      与 `percentSemantics` 已用/剩余方向），而本机没有任何可核实的 GLM Key。盲写一份字段映射并在 README
      里列为"支持"，正好撞进 §5.1 那条**描述必须属实**（评审会拿代码核数）。
      等 ② 落地、且能真跑一次 `probe` 再做；届时 meters 形状也已被千问卡验证过。
- [x] T1.6 通用实测窗口源去千问化：**已验证账本本来就是按 provider 分的**（`usageLedger.windows[provider]`
      ＋ `touchWindow` 按各家窗口天数滚窗），所以缺的不是引擎、是写法 → 加内置简写
      **`"window:<provider>"`**（自动展开成 `kind:'window'` + `providers:[<provider>]` + 标签；
      `providers`/`windowDays`/`label` 仍可显式覆盖，条目写过的不被简写盖掉）。
      口径措辞定死：卡上写「未接入可核实的官方额度源」而**不是**「官方没有额度接口」——
      这条兜底也可能用在"其实有接口、只是用户没配凭据"的家身上，后者那句话我们证明不了。
      本机已现场生效：给 `minimax-cn` 挂了 `minimax-window`（宿主每次查询前重读 JSON，没重启），
      卡出来时 `estimated=True / veracity=local / 无 total / 无百分比`，正是决策 1 的形状。
      ②做完后这条由 detect 自动挂，用户不用写。
- [x] T1.7 `SOURCE_META` / 报错说明为每家补齐：`moonshot-balance`、`openrouter-credits` 都带
      `veracity` + 口径 `sourceNote` + **源级 `errorHints`**（同一个 401 在不同家说不同的话：
      Moonshot 指切区、OpenRouter 指"要它自己的 Key"、402 指欠费）。这条已固化进
      `docs/adding-a-provider.md` 的第 3 步，不再需要单独记任务
- [ ] T1.8 手工验收：真实 Key 逐家跑 `GET /token-plan-quota/probe?source=<id>` 核对字段名，
      把核对结论写回本文件 §1.1（表格即证据链）

### 1.4 生态已有相邻实现：先复用契约，再把差异化说清楚（重要）

`awesome-dsh-plugin.com` 的 **Usage & Billing** 分类下已有 182 个插件（2026-09-07 数 `data/plugins/*.yml`
的 `category: usage`），其中两家与本插件定位重叠：

| 邻居 | 它做了什么 | 对①②③的影响 |
|---|---|---|
| [`dsh-cost-meter`](https://github.com/Han-1413141/dsh-cost-meter)（MIT，已发 npm，v1.7.10，双语 README + docs/） | **Coding Plan 额度九家**：Anthropic / Z.ai·智谱 / MiniMax / Kimi / OpenRouter / SiliconFlow / CommandCode / SCNet / 火山方舟（含 Ark AK/SK 签名）；外加 90+ 模型价格目录、Plan/API 双轨计费、"每 1% 额度"估算 | ①的端点契约**它已经逐家验证过**（`lib/gateway-quota-adapters.js` 注释写明各家 percent 语义、reset 归一、且**故意不实现会产生计费副作用的 xAI 探活**）→ 照抄契约、注明出处，比我们自己摸快得多；但它是"费用仪表盘"，我们是"只报真值的徽标"，**立场不同：我们不做 Credits 折算与任何估算** |
| `lycier/dsh-token-monitor`、`Mu-scorpio/token-usage-counter`、`yokesky/dsh-usage-lens` | 请求级 token/成本统计、热图、Header 额度徽标 | 明细面板要与它们明显区分：我们的差异化在**跟随当前模型供应商**＋**千问 Token Plan 控制台真值**（它们没有这条） |

→ 三条行动：①按 MIT 许可引用 `dsh-cost-meter` 的已验证契约并在 `docs/upstream-contracts.md` 署名出处；
②README 增加"与相邻插件的区别"一节（回答评审必问的"为什么不直接用 dsh-cost-meter"）；
③把**千问 Token Plan 官方余量（控制台网关）**确立为本插件的第一卖点——这是邻居里没有的能力。

**阶段①不做（已定）**：自动检测、README 重写、以及三类侵入更强的凭据形态——
**GLM 团队模式（org/project id）、Kimi Code Cookie、Codex/ChatGPT OAuth（读 `~/.codex/auth.json`）**。
这三类因权限与账号风险不在本插件射程内，**README「不做什么」一节明确写死：需要的人自己按
「自定义源」章节配 HTTP 端点**，插件不为它们引入任何读本地登录态的代码。

---

## 2. 阶段②：零配置自动检测（"用哪个模型 → 自动看哪份余量"）

**要解决的痛点**：现在用户必须自己写 `sources: [...]` 并且手填每个源的 `providers`，
且填错一个字母徽标就静默不显示（§0.1 就是活例）。目标是**装完就开箱可用**。

### 2.1 设计

新增 `lib/detect.js`（纯函数，可离线测），在 `effectiveConfig()` 里 `normalizeSources()` **之后**跑：

```
宿主供应商路由 ──┐
                 ├─→ 匹配规则表（PLATFORM_RULES）─→ 命中的预设 + 自动填 providers
profile.baseURL ─┘                                  ↓
profile.apiKeyEnv → resolveSecret() 有值？──否──→ 跳过该源（不报错、不占位）
                                                  是──→ 启用该源，veracity 保持
无任何规则命中的在用供应商 ──→ 自动挂一个 window:<provider> 实测源（7 天窗口）
```

数据来源（宿主已有、无需新 API）：

- `ctx.llm.listProviders()` → `{id,name}` 在用路由；
- `ctx.llm.listConfigurableProviders()` → `{provider, displayName, settingsNs, settingsPath, declared}`
  告诉你这家**的配置落在哪个 settings 分节的哪条路径**；
- `ctx.settings.get(<settingsNs>)` + `settingsPath` → 该路由 profile 的 `baseURL` 与 `apiKeyEnv`
  （`packages/llm/llm-pi-ai/src/config.ts` L307-335 的 profile 形状；`apiKeyEnv` 带
  `role('credential-ref')`，正是我们解析凭据要的名字）；
  本机 `settings.yaml` 已核对：`providers.qwen-token-plan-cn.apiKeyEnv = QWEN_TOKEN_PLAN_CN_API_KEY`、
  `baseURL = https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`——
  **凭据引用名由 profile 点名，不用猜 `<PROVIDER>_API_KEY` 约定**。
- 事件 `llm/adapters-updated`（payload-free）→ 拓扑变了就重算，另配 TTL/惰性重算。

匹配规则（`PLATFORM_RULES`，按优先级）：

1. `baseURL` host 精确匹配（`api.moonshot.cn` → moonshot；`openrouter.ai` → openrouter；
   `api.z.ai`/`open.bigmodel.cn` → glm；`token-plan.cn-beijing.maas.aliyuncs.com` → 千问 Token Plan）——**最可信**；
2. 路由 id / displayName 关键词（`moonshot|kimi`、`glm|zhipu|z.ai`、`openrouter`…）；
3. Key 前缀兜底（`sk-or-v1-`、`sk-sp-`…）；
4. 都不中 → 实测窗口。

### 2.2 语义与开关

- 新配置 `autoDetect: true`（**已实现即为默认**）；
- **用户手写的 `sources` 永远赢**：实现语义是「按**路由**判覆盖」——用户配置里的源已经覆盖的
  路由，检测一概不再追加（比"同名源"更准：一条路由被任意一个源接住就不再重复接）。
  原计划的 `"fill-gaps" | true | false` 三态**收敛成布尔**：三态里 "fill-gaps" 与 `true` 的实际行为
  在按路由判覆盖之后已经重合，留着只是多一个要解释的旋钮；
- 每张卡带 `detected: {by:'baseURL'|'routeId'|'keyPrefix'|'fallback-window', rule, host}`，
  前端 tooltip 写「按 `api.moonshot.ai` 自动识别 · 区 international」——**可解释**是这阶段的验收重点；
- 凭据缺失的源：整个不开、不报错、不占位；跳过记录进快照 `detection.skipped`（含试过的引用名）；
- 老宿主兼容：拿不到 `llm` / `settings` → 静默退回配置语义，不抛；原因留在 `detection.reason`，
  只有 `debug: true` 时才 additionally 冒一条 notice（否则每次快照都提示一句是噪声）。

### 2.3 任务清单

- [x] T2.1 抽 `lib/detect.js`：**纯函数层**（不打网络、不读文件、不碰 cordis，宿主信息全注入），
      `detectSources({routes, profiles, coveredRoutes, hasCredential, rules})` → `{sources, skipped, uncovered}`
      ＋规则表 `PLATFORM_RULES`。凭据探测留在异步侧（`resolveSecret` 是异步的，纯函数不碰）
- [x] T2.2 `applyAutoDetect(config, ctx)` 接在 `computeStatus` 里（不是 `effectiveConfig`——那里是同步的，
      而凭据解析是异步的）。`settingsNs + settingsPath` 挖 profile 的 `baseURL`/`apiKeyEnv`；
      **凭据引用优先用 profile 点名的那个**（`MOONSHOT_CN_API_KEY`），其次才是预设通用名，
      Cookie 型源不认路由 Key
- [x] T2.3 拓扑事件 → **不需要了**：检测每次 build 现算（纯本地解析，无缓存可失效），
      比"缓存 + 订阅 `llm/adapters-updated` 失效"少一类不一致。加测了幂等（重复跑不叠加源）
- [x] T2.4 快照加 `detection` 块：`{enabled, reason, routes[], added[], skipped[], uncovered[]}`；
      `routes` 里带解析出的 host（`minimax-cn → api.minimaxi.cn`），跳过项带试过的引用名。
      默认就把这块发出去（不大，且"为什么没显示"是首要排查问题）；`reason` 才受 `debug` 门控
- [x] T2.5 前端 tooltip 交代识别依据与区；C 档徽标由 `window:<provider>` 顶上（不再整枚消失）。
      措辞分开：命中规则写「按 api.moonshot.ai 自动识别」，兜底写「没匹配到官方额度接口，
      按本实例实测显示」——**不把兜底说成识别成功**
- [x] T2.6 配置迁移：用户没写 `sources` 且 autoDetect 开着时，**不再套用硬编码的
      `DEFAULTS.sources`**（那两条正是漂移源头）；`autoDetect: false` 时照旧用它们
- [x] T2.7 测试：纯函数层 15 组（优先级、区映射、反例不许认错）＋接线层 13 组（假宿主三服务、
      幂等、凭据门控、用户覆盖优先、Cookie 掉线只留实测、老宿主静默退回、快照带 detected）
- [x] T2.8 现场验收（2026-09-06 通过；**余额数字不记**）：`~/.dsh/token-plan-quota.json` 删掉 `sources` 后，
      活路由 `detection` 显示 5 条在用路由全部有归属——`qwen-token-plan-cn` 按 host 开出官方余量卡（有数）
      ＋实测兜底（有数时前端收起）、`minimax-cn` 落 `uncovered` → `window:minimax-cn` 实测卡、
      `deepseek-official` 按路由名开出余额卡。
      顺带在这次验收里抓出并修掉两个真 bug：Cookie 源被写入 `bearerRef`（→ 官方卡误报"未配置凭据"）、
      代理路由按名字冒充别家（→ 同名两张卡且缓存互覆盖）。

### 2.4 ②的验收基线（把 §0.1 的三个漂移当回归用例）

零配置（删掉 `~/.dsh/token-plan-quota.json` 里的 `sources`）之后，这样一台实例应当看到：

| 当前模型 | 期望徽标 | 判定依据 |
|---|---|---|
| `qwen3.8-flash`（route `qwen-token-plan-cn`，baseURL `token-plan.cn-beijing.maas.aliyuncs.com`） | Token Plan 余量（有 Cookie 走 `token-plan-console`，无 Cookie 退实测窗口） | baseURL host 命中千问 Token Plan 规则 |
| `MiniMax-M2.5`（route `minimax-cn`，凭据 `MINIMAX_CN_API_KEY` 在） | **实测** 7 天窗口卡（C 档，官方无端点） | 路由在用 + 有凭据，但无官方端点 → 自动挂 `window:minimax-cn`。（修之前这里是整枚徽标消失，见 §0.1） |
| 若加 `deepseek-official` 路由 | DeepSeek 官方余额 | 规则命中，且**只有真正有路由时才打 `api.deepseek.com`**——修之前是无路由也照打、结果还看不见 |

---

## 3. 阶段③：重写 README ＋ 开源准备

### 3.1 现在阻碍公开的硬问题

| 问题 | 位置 | 处置 |
|---|---|---|
| **没有 LICENSE 文件**（`package.json` 写了 MIT） | 仓库根 | 补 `LICENSE`（MIT）+ 版权行 |
| **测试写死 `C:\test-dsh-home`**，Linux/macOS 直接跑不了 | `test/host.mjs` L48/53/57/174/242 | 换 `join(os.tmpdir(),'dsh-quota-test-<pid>')`，断言别拼反斜杠 |
| 版本号与 git 历史不一致、无 tag、无 CHANGELOG | `package.json` | 对齐版本 + `CHANGELOG.md`（Keep a Change）+ `v*` tag |
| README 224 行高密度中文、**无英文版**、无截图、把内部逆向细节与使用手册混在一起 | `README.md` | 见 3.2：整篇 `README.en.md`（社区惯例，`dsh-cost-meter` 就是 `README.md` + `README.en.md`） |
| **与 `dsh-cost-meter` / `dsh-token-monitor` 定位重叠却未声明**（评审必问"为什么不直接用那个"） | — | README 加「与相邻插件的区别」一节（立场：只报真值、不折算不估算、跟随模型供应商、千问 Token Plan 官方余量）；契约引用处署名出处 |
| 逆向/Cookie 契约的对外风险未声明（千问控制台网关） | — | 明确 disclaimer：**非官方接口、Cookie 只读本地、可能违反上游服务条款、随时失效**；Cookie 源改成**显式开启才生效**（默认不启用），避开生态里 `dsh-sentinel-scanner`/`dsh-score` 类自动审计把"读本地 Cookie 发往第三方域名"判成凭据外泄 |
| 权限声明缺主机 | `package.json` `dshhub.permissions.network` | 列全所有出站 host（`dsh-cost-meter` 列了 18 个，对照自查）；新增平台时随 PR 更新（①就补） |
| 无 CI、无贡献指南 | `.github/` | `ci.yml`：`node 20/22 × ubuntu/windows` 跑两个测试文件；`CONTRIBUTING.md` 写清"如何新增一家"（照 T1.3 模板）；`SECURITY.md` 写凭据处理边界 |
| `.scratch/` 探测脚本 | 已被 `.gitignore` 忽略 ✅ | 发布前 `git ls-files` 再确认一遍，别把带真实 Key 的输出提交上去 |

### 3.2 README 新结构（对外优先，逆向细节挪走）

1. 一句话＋GIF/截图（徽标跟随模型切换、明细面板悬浮拖拽）
2. 亮点与**不做什么**（不折算 Credits、不估算官方余量——这是产品立场，放最前面）
3. 安装（三种写法都给：npm 包名 / `github:user/repo` / 本地目录；`dsh plugin` 是 pnpm 直传到 profile 目录，
   装完**重启一次 `dsh web`**；本插件无构建步骤，不会撞上 pnpm ≥10 的 `prepare` 脚本白名单，这句要写进去）
4. 支持的平台表（①结束时生成，A/B/C 三档，附**上游文档链接**与"实测/官方"标记）
5. **与相邻插件的区别**（`dsh-cost-meter`＝费用仪表盘＋九家 Coding Plan＋估算；`dsh-token-monitor`
   ＝请求级成本统计；本插件＝**只报真值、跟随当前模型供应商的徽标＋千问 Token Plan 官方余量**）
6. 零配置说明（②成果：装完就能看到什么、按什么规则识别、怎么关掉）
7. 配置全表（键 / 类型 / 默认 / 影响）
8. 凭据与安全（解析顺序、Cookie 边界、**绝不进任何路由响应**、Cookie 源需显式开启）
9. 吞吐口径（速度 vs 吞吐，缓存读不计分子）
10. 只读端点与 `token_plan_quota` 工具
11. 已知边界（把 §0.1、C 档平台、重启后账本、座位退化等收在这一点）
12. 开发（测试命令、跨平台要求、如何新增一家 → 链到 `docs/adding-a-provider.md`）
13. 非官方接口免责声明 ＋ **明确列出不支持的三类强侵入形态**（GLM 团队模式 / Kimi Cookie / Codex OAuth，
    因权限与账号风险不做，需要的人照「自定义源」自己配）
14. 许可

`README.md`（中）与 `README.en.md`（英）**整篇对齐**，逆向契约表进 `docs/upstream-contracts.md`
（保留 §1.1 那张证据链，含出处 URL 与实测日期）。

### 3.3 任务清单

- [x] T3.1 跨平台测试修复：`test/host.mjs` 改用每进程唯一的 `join(os.tmpdir(), 'dsh-quota-test-<pid>')`，
      收尾 `rmSync` 清目录；仓库内已无写死平台路径（`grep 'C:\\test'` = 0）
- [x] T3.2 `LICENSE`（MIT，版权行暂写 "dsh-token-plan-quota contributors"，发布前可换成你的名字）、
      `CHANGELOG.md`（Keep a Changelog，按提交历史回填 0.1.0→0.4.0）、`version` → **0.4.0**
- [x] T3.3 `docs/adding-a-provider.md`：清单化（先核实端点三档证据 → 预设 → 三处元数据 → 规则表 →
      测试 → 回填文档），并写死"不要做的事"（假 meter、读 CLI 登录态、patch 里 pin sources、估算）
- [x] T3.4 `docs/upstream-contracts.md`：逆向契约搬家，逐条带**验证到什么程度**与实测日期；
      千问 Cookie 细节与陷阱表（含"配置 ≠ 额度"、"别拿宿主 DOM 属性做交互判定"）都收在这里
- [x] T3.5 README 重写完成（中英各一份，逐节对齐）：中文 311 → 约 210 行，改成可扫读的
      「不做什么 → 安装 → 支持表 → 零配置 → 界面 → 配置全表 → 吞吐 → 端点 → 边界 → 不做的三类 → 免责 → 开发」；
      逆向细节全部搬进 `docs/upstream-contracts.md`，README 只留结论与出处链接。
      **配置表从 6 键补到 17 键**（原先漏了 `refreshMinutes`/`usagePath`/`configPath`/`exposeTool`/
      `endpoint`/`accessKey*Ref`/`minIntervalMs`/`timeoutMs`/`regionId`）。
      新增 `scripts/check-docs.mjs`：把 README 里的**可核实声明**（DEFAULTS 17 个键、配置表 18 行、8 个数据源、
      声明 8 个出站主机、测试 350/102 项、相对链接目标、CHANGELOG 的 tag 死链、条目键表是否真被 `source.<key>` 读到、文本有无被错误码页读写过）拿去和代码与实跑结果对，漂了就 CI 红；
      七种损坏逐一注入验证可捕获，并带一个"还原后必须绿"的对照组（`.scratch/negative-checks.cjs`，在 gitignore 内）。
      **仍缺**：4 张截图/GIF（我没有截屏能力）——README 里留了占位与拍摄清单。
- [x] T3.8 发布前自查（可自动化的部分全部做完）：`git ls-files` 复核（18 个跟踪文件，`.scratch/` 与探针脚本
      未入库）；明文密钥扫描无命中；`npm pack` → 解 tar → `import lib/index.js` 加载成功（9 个文件，
      含 LICENSE/CHANGELOG/双 README）；CI 里每条命令都在本机跑过一遍——**其中包括我自己写错的那条
      `npm pack --destination`，本地失败后才改成可用形式**（不给 CI 留没跑过的命令）。
      仍待：真·干净 profile 的 `dsh plugin add` 冒烟（要装到临时 profile，等发布后按 npm 名做一次）
- [x] T3.6 `.github/workflows/ci.yml`（node 20/22 × ubuntu/windows/macos 跑两个离线自测 ＋ 清单自检 job）、
      `CONTRIBUTING.md`（含产品口径六条与"描述必须属实"）、`SECURITY.md`（凭据边界、Cookie 风险声明、
      明确不做的三类形态）、`.github/ISSUE_TEMPLATE/`（识别不对＝必填 `detection` 块；请求新供应商＝必填端点证据）
- [x] T3.7 `dshhub` 元数据校对：`summary` 收成事实描述（去营销词）、补 `bugs` 与 `files`
      （`README.en.md`/`CHANGELOG.md`/`LICENSE`）、`keywords` 补 moonshot/kimi/openrouter；
      新增 `scripts/check-manifest.mjs` 把这些承诺变成可执行的 CI 检查（安装性、出站主机、许可证、零依赖）
- [x] T3.9 发布渠道（见 §5）：GitHub 已加 `dsh-plugin` topic；npm 已发 `dsh-token-plan-quota@0.4.2`
      （registry 复核过包内 8 张图齐全）；awesome-dsh-plugin 已提 **PR #4581**（1 文件 +6 行，待维护者批准工作流）
      → 本地自测 `dsh-sentinel-scanner` / `dsh-score` 类审计不报高危

---

## 4. 决策记录（2026-09-06 已拍板）

| # | 决定 | 落在哪 |
|---|---|---|
| 1 | **C 档平台显示"实测"徽标**（不再整枚消失）。配套硬规则写死进实现与文档：实测卡**永不画余量条、永不显示百分比**（无官方分母＝无进度概念），tooltip 首行必须说"官方无额度接口，此为本实例实测" | §2.4、T1.6、T2.5；README「不做什么」一节同步 |
| 2 | **GLM 团队模式 / Kimi Code Cookie / Codex·ChatGPT OAuth 三类不做**——因权限与账号风险超出本插件射程；**README 显式写死**"需要的人自己按自定义源配" | §1.2 第 4 条、§3.2 第 13 节；不写任何读本地登录态的代码 |
| 3 | **英文整篇 `README.en.md`**（不是摘要），与中文版逐节对齐 | §3.2、T3.5；顺带要求 `lib/client.js` 的文案上双语（否则英文 README 配中文徽标） |
| 4 | 走 **DSH 生态的公开渠道**（见 §5），不是往 `deepseek-harness` 主仓提 PR——**主仓不接受外部 PR**，官方认可的插件贡献方式就是"自己发仓库 + 打 `dsh-plugin` topic"（`CONTRIBUTING.md` L13-15） | §5 全节 |
| 5 | **一家只展示一张额度卡，但收合放在显示层**（2026-09-06 实机纠正）：官方卡**有数字**时才收起自动检测挂的实测兜底卡；官方卡是错误卡/没数字时兜底必须回来。原方案在规划期砍兜底，Cookie 一过期徽标直接空白——**规划期看不见数据，就不该在那儿决定显示**。用户手写的实测源没有 `detected.fallback` 标记，永不代藏 | `detect.js` `fallbackPresets` ＋ `client.js dropShadowedMeasured`（含"不许自己 shade 自己"）＋ `summarizeText` 同规则 |
| 6 | **开源前跑盲测**：中英文档各交两名只准读 README、不许读代码/上网的子代理，问同一组配置题（2026-09-07 两轮）。第一轮两名读者**独立**打出四个洞：① `token-plan-window` 只被列名、无说明，读者认定它是"自建固定额度窗口"预设（实际是千问本地账本）；② 文档写"多窗口家用 `card.meters`"，而那是**卡形状、手写无效**；③ 配置表合并行让"17 个键"没法核对（有人数出 16，有人数出 18）；④ **"我就想关掉某一张卡"这个最高频诉求，全篇没有正面答案**。结论：文档不是说明书的替代品，是**唯一一份能被外人执行的契约** | §3 文档要求；两张键表进 `check-docs` 第 8 条检查 |
| 7 | 针对 ④ 补**实现**而不是补一段"做不到"：`enabled: false` 语义定为「关**这一条源**」——手写条目与自动检测同受约束（检测不再补回来，诊断记 `disabled-by-config`），但**不牵连**同路由的实测兜底窗口（关一条源 ≠ 关这个供应商；连兜底也不要就点名 `{"id":"window:<路由>","enabled":false}`）。不新增顶层黑名单键：**一个诉求只留一种写法** | `normalizeSources` 的 `disabledSources` ＋ `detect.js` `disabledPresets` ＋ `host.mjs` 三组带对照的测试 |
| 8 | 仓库内**禁止用 Windows PowerShell 5.1 做文本往返**（`Get-Content`/`Set-Content`）：5.1 的 `Get-Content` 按 ANSI(GBK) 读 UTF-8，一次往返把中文变成乱码 + GBK 私用区字符并加 BOM，且**不可逆**（私用区无反向映射，本轮真的毁过一次 README，靠 `git checkout` 回滚重放）。改为：文本一律走文件工具或 Node | `check-docs` 第 9 条：BOM / U+FFFD / 「CJK + 私用区共存」三条码位护栏（码位判断，不用字面量——不然检查自身就是残骸） |
| 9 | **`providers` 落空必须说出来**（2026-09-07 第三轮盲测撞出）：面板按 `bindProviders.includes(当前路由 id)` 过滤，而预设自带的名字是 `moonshot`/`deepseek-official` 这类通用串，不含用户真实路由 id——照文档"强制开一张卡"写出来的配置会**查得到却不露面**。文档改到位之后仍要加一条 warn：这类坑的表征与根因隔了三层，光靠文字让人自查不现实 | `warnUnboundSources`（去重、按归一化比较、不写 `providers` 的源保持安静）＋ 5 项测试；同轮把「`panelScope: current` 下阿里云三条永远不可见」第一次写进配置表 |
| 10 | **README 的截图一律由合成数据生成**：真实余额不能进公开仓库（git 历史删不干净），所以 `scripts/shots/` 用 CDP 把同源 `/token-plan-quota/summary` 与 `/refresh` 换成 `fixture.mjs` 造的对象，再用宿主自带的 `?fixture` 模式（内存假宿主，自带种子会话与默认模型）拿到"有活会话"这个徽标挂载前提。**为什么不造假上游**：那需要模拟千问控制台网关的 Cookie/secToken 全套语义，是最容易写错、且一旦写进文档就会与真实上游长期不一致的部分；拦响应让真实数字根本进不到浏览器，跑图实例也不需要任何凭据。代价是依赖 summary 形状——已用 `publicCard()` 白名单在运行时比对锁死 | `cdp.mjs`/`fixture.mjs`/`make-shots.mjs` + 中文 7 张 / 英文 6 张图；`check-docs` 规则 10 守住"图存在且非零、占位串已消失、合成 payload 仍符合产品口径"（7 条破坏注入均已验证会红：4 条旧守卫 + 3 条新增）。**顺带记录两处真实 i18n 缺口**：① `formatTokens` 把「万/亿」写死，英文界面会显示 `84.7万 tok`；② 零记录实测卡那句说明（`lib/index.js:376`）只有中文，英文界面同样吐中文——所以英文套**主动少一张图**，`assertFixture` 现在会拦"英文套出现只有中文的卡字段"（宿主自带 `xxxEn` 双语字段的除外）。 |
| 11 | 缺口 ① 在 0.4.4 修掉了，但**修法值得记一笔**：`formatTokens` 有 14 个调用点，给它加 `copy` 参数意味着漏一个就是同一屏两种单位并存，所以改成 `pickLocale()` 里记一次语言风格（模块内变量，与 `copy` 同生命周期）。同一轮还修了 `pickLocale()` 本身：原来是"浏览器语言与 `<html lang>` 里任一说 zh 就算 zh"，于是**中文系统 + 英文界面**的用户会看到中文徽标——现在以宿主写的 `<html lang>` 为准，拿不到才退回浏览器语言。回归锁：`test/client.mjs` 用 23400 这个数断言中英各是 `23K` / `2.3万`（不去查"整屏有没有汉字"，测试 payload 的 sourceNote 本来就是中文，那样必误判）。 | 缺口 ② 仍未修：那是服务端文案，服务端不知道浏览器语言。正经修法是让它发**原因码**（`emptyReasonCode`）由前端本地化，代价是公开 payload 多一个字段。 |

---

## 5. 发布渠道与准入（对应决策 4）

DSH 生态的"插件存放处"是**三层**，本插件三层都要过：

| 层 | 是什么 | 我们要做的 |
|---|---|---|
| GitHub topic | 官方 `CONTRIBUTING.md` 认可的发现机制：[topics/dsh-plugin](https://github.com/topics/dsh-plugin) | 给 `xinghe-1018/dsh-token-plan-quota` 加 `dsh-plugin` topic（一行设置） |
| npm | `dsh plugin add` 是 **pnpm 直传**到 profile 目录（`apps/cli/src/plugin.ts` L120-157），所以发布到 npm 后 `dsh plugin --profile web add dsh-token-plan-quota` 就能装 | **包名 `dsh-token-plan-quota` 当前未被占用**（registry 404，已核）→ `npm publish`；本插件零构建，不会触发 pnpm ≥10 的 `prepare` 白名单拦截（对比：git 安装带构建步骤的插件会撞） |
| Awesome DSH Plugin | [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)（3304 条，含 `dsh-market` 一键装） | 提 PR 加**一个文件** `data/plugins/xinghe-1018__dsh-token-plan-quota.yml`（已提 [#4581](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/4581)） |

### 5.1 awesome-dsh-plugin 的硬性准入（已读 `contributing.md` 核对）

- 提交格式（**只有 `description.en` 必填**，`zh` 缺了维护者会补；含 `: ` 的值必须加引号）：

  投稿文本**不在这里复制**（抄一份就会漂）：权威版本是 `RELEASE.md` §4 的那段 YAML，
  条目文件名为 `data/plugins/<owner>__<repo>.yml`，目录站默认分支 `main`。

- ✅ **已满足**：`package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`（**最常见的被拒原因是只写
  `dsh.client`**，我们两者都有）；有真实代码；仓库早已满 1 天。
- ⚠️ **需要注意**：
  1. **描述必须与代码逐字对得上**（评审会拿代码核数）→ "following the active model's provider"
     成立（v0.2 已实现）；早期草稿那句"showing official balances where an API exists"**只对
     DeepSeek / 千问 / 阿里云成立**，Moonshot 与 OpenRouter 的字段名还没用真 Key 核对（T1.8 未做）。
     2026-09-07 投稿时按决策**收窄措辞**：把已核实的三家点名，另两家明写"接了官方端点但未用真 Key 核对"，
     不靠模糊说法蒙过评审（§4 决策 1 的口径反过来约束自己）；
  2. **评审第 4 条明说"两个插件做同一件事，先来者留位"** → `dsh-cost-meter`（九家 Coding Plan）已在榜，
     **不提"与邻居的区别"就直接投稿，大概率被判重复**。§1.4 那节不是可选项，是投稿前置条件；
  3. 评审第 5 条看"凭据外传"→ 千问 Cookie 走非官方网关这条要在 README 安全节里**主动交代清楚**
     （只从本地解析、绝不进任何路由响应、Cookie 源需显式开启），别等维护者去代码里翻；
  4. CI 只查形式（manifest / 仓库年龄 / 格式 / README 可重生成），绿了不等于收。

### 5.2 投稿前顺序建议

①做完（多家）→ ②做完（零配置，卖点成型）→ §1.4 差异化写完 → README 中英双份 → npm 发版 →
最后提 awesome（拿到 `Install ▾ via dsh-market` 那一行，才算"开源完成"）。
