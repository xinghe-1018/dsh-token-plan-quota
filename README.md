# dsh-token-plan-quota

[中文](README.md) | [English](README.en.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页界面的输入框工具行里显示**额度**：
官方接口给真值，没有官方接口的供应商显示明确标注「实测」的本实例消耗——**零配置**，装完按你实际在用的
供应商路由自动决定该开哪些源。

```
┌ 输入框工具行 ─────────────────────────────────────────────────┐
│ Token Plan ▓▓▓▓░ 12.3万 tok │ 42 tok/s  实测  剩5d  ← 点开看明细 │
└───────────────────────────────────────────────────────────────┘
```

> 截图位（发布前补 4 张）：① 徽标跟随模型在两家供应商之间切换；② 明细面板（官方余量卡 + 多窗口计量条）；
> ③ 面板拖成悬浮小窗；④ Cookie 掉线时退回「实测」卡的样子。

## 它不做什么

这是本插件的立场，比功能列表更重要：

- **不折算 Credits**，不做抵扣率，不"按历史推算剩余"；
- **没有"我自己填一个额度上限"的窗口**：分母只能来自官方接口，手填的上限就是编数，所以本插件没有任何
  表达"周期 + 上限"的键。`token-plan-window` **不是**自建窗口预设，它是千问 Token Plan 的本地实测账本
  （不打网络，只记经过本实例的调用）；
- **没有官方分母就没有百分比**：实测卡永不画余量条、永不显示百分比，只报「窗口内用了多少 token / 多少次」；
- **档位配置不等于你的额度**：一个窗口只有在这个套餐真回了读数时才存在（上游 `quota-config` 里躺着的
  `five_hour` 上限不代表这个账号有 5 小时窗口）；
- **认不准就不开**：自动检测宁可少一张卡，也不会把别家的余额数字顶在你正在用的模型上；
- **不做会产生计费的探活**；只用只读端点；
- **不读别的 CLI 的登录态**（见[明确不做的三类](#明确不做的三类)）。

## 安装

```bash
dsh plugin --profile web add dsh-token-plan-quota          # npm 包名
dsh plugin --profile web add github:xinghe-1018/dsh-token-plan-quota
dsh plugin --profile web add ./dsh-token-plan-quota        # 本地目录
```

`dsh plugin` 是 pnpm 直传到 profile 目录；本插件**零第三方依赖、无构建步骤**，所以不会撞上 pnpm ≥10 的
`prepare` 脚本白名单。装完**重启一次 `dsh web`**（bundle 与客户端入口在启动时组装）。

运行时唯一的外部资源是三枚 CDN 字体 link，加载失败自动落系统字体栈，不影响功能。

## 支持哪些厂家

| 厂家 | 额度来源 | 徽标上看到什么 | 验证到什么程度 |
|---|---|---|---|
| DeepSeek | ✅ 官方 `/user/balance`（Bearer） | 余额 + 充值 + 赠款（真值） | 真实 Key 实测 |
| 千问 Token Plan | ⚠️ 控制台数据网关（**Cookie 会话**，非公开 API） | 已用 % + 进度条（与订阅页同源）；Cookie 没配/过期 → 退回实测卡 | 真账号实测 |
| Moonshot / Kimi 开放平台 | ✅ 官方 `/v1/users/me/balance`（Bearer，`.cn` CNY / `.ai` USD 两区） | 余额 + 充值 + 赠款（真值） | 端点存在性实测；**字段名未用真 Key 核对** |
| OpenRouter | ✅ 官方 `/api/v1/credits`（Bearer） | 余额（USD）＝累计充值 − 累计花费 | 端点存在性实测；**字段名未用真 Key 核对** |
| 阿里云费用中心 | ✅ BssOpenApi（AK/SK 签名） | 账户余额 / 资源包余量（真值） | 逐字段对过官方 OpenAPI 元数据 |
| MiniMax、普通 Key 的 OpenAI / Gemini 等 | ❌ 官方无 Key 化额度端点 | **实测**卡（只报 token/次数） | 常见路径实测过，均无端点 |

逐条端点、信封字段、单位与百分比方向陷阱见 [`docs/upstream-contracts.md`](docs/upstream-contracts.md)。

**只看 API host，不看控制台域名**：`platform.kimi.com`、`platform.moonshot.cn`、
`bailian.console.aliyun.com` 这类**网页控制台**域名一律不参与识别——插件查的是余额接口，落在路由
`baseURL` 指向的 API host（`api.moonshot.cn` / `api.moonshot.ai`）上。Kimi 开放平台的 Key 与 Moonshot
开放平台是同一套账号与余额体系，所以 Key 配好后要走 `api.moonshot.*`；若你的 `baseURL` 写成别的域名，
检测认不出，会退回实测卡。想强制开官方卡，别只写源名——**要把它绑到你真正的路由 id 上**，否则默认
`panelScope: "current"` 下这张卡查得到却不露面（预设自带的 `providers` 是 `moonshot` 这类通用名，不含你的路由名）：

```json
{ "sources": [{ "id": "moonshot-balance", "providers": ["kimi-open-cn"] }] }
```

（下表最后一列请注意：这一家的字段名还没用真 Key 核对过，强制开出来若数字不对，用 `probe` 对字段名。
`providers` 落空时宿主日志会直接提醒，不至于一边是空白面板、一边让人瞎猜。）

### 与相邻插件的区别

生态里已有做同类事的插件（`dsh-cost-meter` 覆盖九家 Coding Plan 并带费用估算、`dsh-token-monitor` 做请求级
成本统计）。区别在口径：本插件**只报真值或明确标注的实测，不折算不估算**，徽标**跟随当前模型供应商**切换，
并且内置了千问 Token Plan 的控制台余量契约（邻居里没有）。要费用报表请选前者，要"我正在用的这家还剩多少"
选这个。

## 零配置自动检测

宿主在用的供应商路由就是**唯一事实来源**，所以你不用写 `sources`，也不用手填 `providers`——历史上正是这两个
字段各写各的，导致"卡查得到却永远看不见"。识别按可信度排序，命中即停：

| 依据 | 说明 |
|---|---|
| `baseURL` 的 host | 最可信：路由实际打到哪。`api.moonshot.cn` → Moonshot 大陆区，`openrouter.ai` → OpenRouter，Token Plan 网关 → 千问 |
| 路由 id / 名称关键词 | **只在拿不到 host 时**降级使用（出厂的 `deepseek-official` 就靠这条） |
| Key 前缀 | 最后的线索（`sk-or-` → OpenRouter） |
| 都没命中 | 给**每条**认不出的路由各挂一张 `window:<provider>` 实测源：徽标不空，只报本地 token/次数 |

**本文里 `provider`、`路由 id`、`providers` 数组里的字符串是同一个东西**：宿主 `llm.listProviders()` 返回的
`id`（比较时忽略大小写，`.` `_` `/` 一律当 `-`）。所以 `window:minimax-cn` 的实测卡只在路由 id 为
`minimax-cn` 的模型下出现，检测自动挂的兜底卡也叫这个名字（`window:minimax-cn`）——两个写法指同一张卡。

两条不变量：

- **你写过的永远赢，但它是一层叠加，不是替换**。`autoDetect: true`（默认）时，你写的 `sources` 先落地，
  检测再补齐**你没管的部分**——不会因为多写了一条就把它不认识的卡全清掉。"已覆盖"只有三种精确含义：
  ① 你某条源的 `providers` 里含这个路由 id → 该路由不再追加任何源；② 你有一条同名 `id` 的源 → 检测不再开
  同名源（`skipped` 记 `id-taken-by-configured`）；③ 你写了 `{"id":"<源名>","enabled":false}` → 这个名字
  永不再自动开（`skipped` 记 `disabled-by-config`）。此外还有第四种可能：凭据解析不到的源整个不开
  （`skipped` 记 `no-credential`，并列出试过哪些引用名；不挂错误卡占地方）。
  `autoDetect: false` 才是"以你写的为唯一事实"。
- **可解释**。每张自动开出的卡带 `detected: {by, rule, host, fallback}`，标题 tooltip 写
  「按 api.moonshot.ai 自动识别 · 区 international」；快照的 `detection` 块交代在用路由、开了什么、
  谁因何被跳过、谁没被认出——排查"这家怎么不显示"只看这一处（**它只在
  `GET /token-plan-quota/summary` 的返回里，明细面板不显示这一坨**）。老宿主没有 `llm` 服务时静默退回配置语义。

## 界面

- **徽标跟随模型**：订阅宿主现成的 `sessions.list` → `modelDirectories` 运行时 store，模型一切换立刻改卡，
  不轮询、不打网络。优先级：有数字的官方卡 > 有数字的实测卡 > 报错的官方卡（提示去配 Cookie）。
- **一家只展示一张额度卡**：官方卡有数字时收起自动挂的实测兜底卡；官方卡变错误卡时兜底必须回来。
  收合发生在看得见数据的显示层，不在规划期——否则 Cookie 一过期徽标就空白。
- **一张卡可以有多个窗口**：宿主按主次排进 `card.meters`（**这是快照里的卡形状，不是手写条目的配置键**），
  `meters[0]` 与顶层数值同源、由标题行与大条表达，
  其余窗口各出一行「标签 · 剩余/总额 · 已用% · 重置日」带自己的细渐变条。
- **明细是常驻小窗**：可拖（按住标题栏）、可缩（右下角握柄）、位置与尺寸记进 `localStorage`、双击标题栏归位。
  **点哪儿都不会关掉它**——关闭只由再点徽标或 `Esc` 决定。不做「点外面就关」：那是下拉菜单的语义，
  而且靠选择器识别宿主输入区必然漏（线上产物里连 `data-composer-card` 都不存在）。
- 视觉：幽灵小控件，无边框、无状态圆点、无表情符号，**余量渐变条即状态**（≥70% 绿、40–70% 蓝、<40% 橙→红）；
  「官方／实测」药丸标档级；字体自成一套（Geist Variable + Noto Sans SC，断网落系统栈），等宽只留给标识串；
  所有动效尊重 `prefers-reduced-motion`。
- `panelScope: current`（默认）只列当前模型供应商的卡；想全看设 `"all"`。
- **"实测"在本文只有一个意思**：本地账本算出来的数，不是官方余量。它出现在三处——明细里的「本实例实测用量」块
  （`showInstanceWindow` 管这块的显隐）、任意供应商的 `window:<provider>` 卡、以及内置的 `token-plan-window`
  （就是千问那条账本）。三者默认窗口 7 天，`windowDays` 可改；重置时刻由本实例第一次调用起算，
  点「清本周期账本」重新起算。

## 配置

主配置 `~/.dsh/token-plan-quota.json`——宿主每次查询前重读，**改完不用重启**（也可写在插件行 `config`，
JSON 优先级更高）：

```json
{
  "autoDetect": true,
  "refreshMinutes": 10,
  "pollSeconds": 10,
  "panelScope": "current",
  "debug": false
}
```

下表 18 行：17 行是代码里 `DEFAULTS` 的键，另 1 行 `moonshotRegion` 不在 `DEFAULTS` 中——它是 Moonshot 源
通过 `regionConfigKey` 读取的区选择器。**一个键一行，单位都写在键名里**（`Minutes`/`Seconds`/`Ms`）。

| 键 | 默认 | 含义 |
|---|---|---|
| `autoDetect` | `true` | 按宿主在用路由自动补齐数据源。**写 `sources` 不会把它关掉**：你写的是一条叠加层，检测照样补齐你没管的路由，所以 `"sources": []` 只表示"我没额外要求"（与不写等价）。设 `false` 才是"以你写的为唯一事实"：此时什么都不写 → 回落到内置两条 `deepseek-balance` + `token-plan-window`；写 `"sources": []` → **一张卡都没有** |
| `sources` | 无（交给检测） | 数据源清单，按顺序显示。内置源名（8 个）：`deepseek-balance`（DeepSeek 余额）、`token-plan-console`（千问控制台余量，Cookie）、`token-plan-window`（**千问本地实测账本**，非自建窗口）、`moonshot-balance`（Moonshot/Kimi 余额）、`openrouter-credits`（OpenRouter 余额）、`account-balance`（阿里云账户余额）、`fr-instances`（阿里云资源包实例列表）、`resource-package`（阿里云资源包额度列表）；或简写 `window:<provider>`（给任意供应商挂实测窗口）；或完全自定义对象（见[自定义源](#自定义源)） |
| `moonshotRegion` | `china-mainland` | Moonshot 区：`china-mainland`（`api.moonshot.cn`，CNY）/ `international`（`api.moonshot.ai`，USD）。**两区 Key 不互通**，选错会 401（卡片会直接提示切区）；host 与币种成对切换，不做自动探测 |
| `refreshMinutes` | `10` | 官方源的快照缓存分钟数：TTL = 分钟 × 60 秒，**下限 15 秒**，所以 `"refreshMinutes": 3` 就是每 3 分钟回源一次（想比 1 分钟更勤没有意义，秒级刷新请看 `pollSeconds`）。点面板「更新于」或带 `?fresh=1` 可强制回源 |
| `pollSeconds` | `10` | 前端轮询秒数——只管界面多久取一次快照，实测与吞吐每次实时重算；调小让徽标速度更跟手，不会多打上游 |
| `panelScope` | `current` | 明细面板范围：`current` **只列 `providers` 里含当前路由 id 的卡** + 本实例实测；`all` 列全部源。所以 `current` 下**看不到阿里云那三条**——账户余额与资源包没有供应商归属，永远不进按路由过滤的视图，要看它们就设 `"all"` |
| `showInstanceWindow` | `true` | 明细里是否带「本实例实测用量 + 限流重试观测」这一块。它**不是**某个数据源的开关，也不影响 `window:<provider>` 卡 |
| `exposeTool` | `true` | 是否注册模型可调用工具 `token_plan_quota` |
| `debug` | `false` | 明细里常驻回显上游响应的**字段骨架**（值打码、跳过凭据字段名）。与 `GET /token-plan-quota/probe?source=<id>` 输出同一份东西，区别是 debug 常驻、probe 按需单次且不用改配置 |
| `endpoint` | `business.aliyuncs.com` | 仅阿里云费用中心三个源使用：OpenAPI 接入点（国际站要换）。会自动剥掉 `https://` 与末尾斜杠 |
| `regionId` | 无 | 仅阿里云使用：OpenAPI 的 `RegionId` |
| `accessKeyIdRef` | `ALIBABA_CLOUD_ACCESS_KEY_ID` | 仅阿里云使用：AccessKeyId 的凭据引用名 |
| `accessKeySecretRef` | `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 仅阿里云使用：AccessKeySecret 的凭据引用名 |
| `securityTokenRef` | 无 | 仅阿里云使用：STS 临时凭据的引用名（用 AK/SK 长期凭据时留空） |
| `configPath` | `$DSH_HOME/token-plan-quota.json` | 外部 JSON 配置位置（`~/` 落 OS 家目录，`$DSH_HOME/` 落 harness 家目录） |
| `usagePath` | `$DSH_HOME/token-plan-quota.usage.json` | 本实例账本落盘位置 |
| `minIntervalMs` | `1200` | 出站最小间隔（毫秒），全局节流 |
| `timeoutMs` | `15000` | 单次上游请求超时（毫秒，下限 1000） |

### 只想关掉某一张卡

`sources` 的一项既可以写成内置源名（字符串），也可以写成对象——**选项只有对象形式带得上去**，所以想关掉某一张卡，
要把那一项改成对象。**这是一条排除项，不是整张清单的替换**：`autoDetect` 保持 `true`，其余卡照常补齐。

```json
{
  "autoDetect": true,
  "sources": [
    { "id": "deepseek-balance", "enabled": false },
    { "id": "fr-instances", "enabled": false }
  ]
}
```

- **对自动检测开出来的源同样有效**：写了 `{"id":"moonshot-balance","enabled":false}`，检测就不会再把这张卡补
  回来，诊断块的 `skipped` 里留一条 `disabled-by-config`——「没认出来」和「你关掉了」这两种情况得分得开。
- **关的是这一条源，不是这个供应商**——但"这家还剩什么"取决于它在不在规则表里，这一条必须说白：
  - **认得出的厂家**（DeepSeek / Moonshot / OpenRouter）各自只有一条官方源，关掉它**就没有这张卡**：
    实测兜底窗口只挂在**认不出**的路由上，不会因此补上来。
  - **千问是唯一的例外**：它同时有 `token-plan-console`（官方）与 `token-plan-window`（实测）两条预设，
    关掉前者，后者照旧在。
  - **认不出的厂家**（MiniMax 这类）本来就只有一张 `window:<provider>` 卡，要关它就点它的名：
    `{"id":"window:minimax-cn","enabled":false}`（`<provider>` 就是路由 id，见上节）。
- 不想逐张关，就把 `autoDetect` 设 `false` 之后自己列全清单。两种做法都行，**你写过的永远赢**。

### 凭据

按顺序解析：**DSH 凭据服务 → 环境变量 → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`**，每次查询重新解析，
换 Key 不用重启。

| 源 | 引用名 |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY`（须与区配对；自动检测会优先沿用路由 profile 点名的引用名，如 `MOONSHOT_CN_API_KEY`） |
| OpenRouter | `OPENROUTER_API_KEY`（`sk-or-v1-…`） |
| 千问 Token Plan 余量 | `BAILIAN_CONSOLE_COOKIE`（+ 可选 `BAILIAN_CONSOLE_SECTOKEN` 兜底） |
| 阿里云 | `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` |

Key 引用名可在 `sources` 条目里用 `bearerRef` / `cookieRef` 覆盖。

想看到千问的**真实余量**（订阅页那种「剩余量 65.1% / 总额度 10,000」）：登录打开
[订阅页](https://platform-home.qianwenai.com/analytics/token-plan/individual) → F12 Network → 复制任一请求的
**整行 `Cookie:`** → 存成一行 `BAILIAN_CONSOLE_COOKIE: <内容>` → 点面板「更新于」刷新。Cookie 通常能用几周，
过期后该源报错并自动退回实测卡，重贴即恢复。

### 自定义源

上游给了新端点、或你想把某个控制台接口接进来，不用等本插件更新——`kind: "single"` + `fields`/`derive`
就能覆盖"余额是差值"这类形态：

```json
{
  "sources": [{
    "id": "my-balance", "label": "我的余额", "kind": "single", "metric": "money",
    "url": "https://example.com/api/account", "method": "GET", "bearerRef": "MY_API_KEY",
    "unit": "USD",
    "fields": { "credits": ["data.total_credits", "total_credits"], "usage": ["data.total_usage", "total_usage"] },
    "derive": { "total": "credits", "used": "usage", "remaining": "credits - usage" },
    "providers": ["my-provider"]
  }]
}
```

`derive` 只认「一个 `+`/`-`、两侧是 `fields` 里的引用名或数字」；**任何一个操作数取不到就整条空**，绝不猜数补上。
`fields` 的槽位名随你起（`credits`/`usage` 只是示例），它同时也是 `derive` 表达式里能引用的变量名；
每个槽位给多条候选路径是有意为之（同一家 API 版本间 `data` 信封加不加都见过）。

#### 手写条目的全部可用键

**认不出的键不会报错，只是没作用**（条目对象是原样合并进去的），所以键名打错字的表现是"卡片空着"而不是启动失败。
这张表是权威清单：

| 键 | 用在哪 | 说明 |
|---|---|---|
| `id` | 必填 | 源标识，同时是缓存键和 `probe?source=` 的参数。两个条目用同一个 `id` 会共用缓存并叠成两张卡（日志会 warn），第二个请改名 |
| `kind` | 建议写 | `single`（一次读数，不写即此值）/ `list`（多条资源列表）/ `window`（本实例实测窗口，不打网络） |
| `label` / `labelEn` | 标题 | `label` 是卡片标题，不写时回落成该条目的 `id`。`labelEn` 会随快照下发但**当前界面不消费它**（面板标题只读 `label`），留着是为宿主英文化 |
| `url` | `single` / `list` | 端点。写了 `url` 即 HTTP 源；不写 `url`、也不是内置源名，则按阿里云 OpenAPI **RPC** 处理（要 `action` + `version`） |
| `method` | HTTP | 默认 `GET` |
| `headers` | HTTP | 追加请求头，与 `accept: application/json` 合并 |
| `jsonBody` / `formBody` | HTTP（POST 用） | JSON 请求体 / `application/x-www-form-urlencoded` 请求体 |
| `bearerRef` / `cookieRef` | HTTP | 凭据引用名。Bearer 型只认 `bearerRef`，Cookie 会话型只认 `cookieRef`——**不会拿套餐 Key 去顶替 Cookie**（反之亦然），因为那只会得到一张误导性的错误卡 |
| `action` / `version` / `params` | RPC | OpenAPI 的 Action、版本号、查询参数（`params` 会被扁平化）。RPC 型缺 `action` 或 `version` 会直接出错误卡 |
| `paginate` | RPC | `{ "mode": "page", "request": "PageNum", "pageSize": "PageSize", "total": ["TotalCount"] }`，或 `{ "mode": "token", "request": "NextToken", "response": ["NextToken"] }`；`page` 模式最多翻 10 页 |
| `fields` | `single` | 变量名 → 候选路径数组，取到数的才进 `derive` 作用域 |
| `extract` | `single` | 上游直接给值时的路径：`remaining`、`total`、`unit`。它们也能被 `derive` 引用 |
| `derive` | `single` | 只有 `remaining` / `total` / `used` 三个键会被消费；`used` 不写时，`remaining` 与 `total` 都在就自动算差值 |
| `extra` | `single` | 副信息，键名随你起；`toppedUp`/`granted`/`cash`/`credit`/`quotaLimit` 有既定文案 |
| `list` / `item` | `list` | `list` 是数组候选路径；`item` 内可给 `name`/`id`/`remaining`/`total`/`used`/`unit`/`status`/`expiresAt`/`startsAt`/`cycleType`/`capacityType`/`haystack` |
| `metric` | 显示口径 | `money` / `credits` / `count`。默认值按构建器不同：手写 `single` 源是 `money`，`list` 源是 `credits`，`window` 是 `count`——**要按 token/次数显示就显式写** |
| `unit` | 显示 | 上游不给单位时的兜底（如 `USD`）；`metric:"money"` 且上游不给时兜到 `CNY` |
| `providers` | 面板归属 | 这条属于哪些**路由 id**（见上文「provider 就是路由 id」）。`panelScope:"current"` 下，列表里没有当前路由就不显示这张卡；写了却一条都对不上在用路由，宿主日志会提醒（免得对着空白面板瞎猜）；`window:<provider>` 简写会自动填 |
| `windowDays` | `window` | 实测窗口天数，默认 7，最小 1 |
| `regions` / `region` | 多区供应商 | `regions` 是「区名 → 该区的字段覆盖（host 与币种成对换）」，`region` 选哪一区；写错的区会 warn 并退回第一个 |
| `enabled` | 任意 | `false` 停用这一条（临时关源不必删整段） |

**表外的键是内置预设专用，手写别照抄**：`builder`、`apiPrefix`、`consoleSite`、`gatewayAction`、`gatewayProduct`、
`infoUrl`、`secTokenRef`、`dashboardURL`、`regionConfigKey`、`errorHints`、`keywords` 走的是各家特定的签名/CSRF/
信封流程，只对相应预设成立。特别地：面板里的**多行窗口**（「5 小时」+「每周」两行）目前**只有
`token-plan-console` 会产生**，手写条目一条只有一个读数；想显示两个窗口，就写两条源。
实测窗口用 `{"kind":"window","providers":["my-provider"],"label":"我的窗口","windowDays":30}`，
或简写 `window:<provider>`。接入新厂家的完整核对流程见 [`docs/adding-a-provider.md`](docs/adding-a-provider.md)。

#### 卡片空着、又没报错，按这个顺序查

1. `GET /token-plan-quota/probe?source=<id>`（或临时开 `"debug": true`）——先看上游**实际**回了哪些字段名；
2. 对照上面那张权威键表逐字核对键名：**认不出的键不报错、只是没作用**，表现就是卡片空着而不是启动失败；
3. `fields` 的路径是否真命中了这份响应（信封加不加 `data` 见过两种），`derive` 引用的名字是否都取到了数
   ——任一操作数缺失就整条空；
4. 如果这张卡**根本没出现**，那通常不是空卡问题：凭据解析不到的源整个不开（不挂错误卡占地方），
   或者被 `panelScope: current` 挡在视野外。看快照的 `detection` 块，它会写明谁被跳过、为什么。

## 吞吐速度（实测，不估算）

宿主包一层 `llm/stream`，记录**首分片到 usage 分片**的活跃时长。两个口径严格分开：

- **速度（生成/解码）**：`lastTps` = 输出 tokens ÷ 活跃秒；`genTps` = 近 5 分钟 Σ输出 ÷ Σ活跃秒
  （活跃总时长 <1 秒不出数，防超短流外推）。**缓存读不计入分子**——否则一次 36 万缓存命中的调用会把
  速度吹成几万 tok/s；
- **吞吐（量）**：`tpm60` / `tokens300` = 全部 tokens（含缓存读），计费与搬运视角；`outTps60` 是近 60 秒输出均速。

滑动窗口随账本落盘，宿主重启后最近 5 分钟的实测还能带回。徽标速度标签只取当前模型供应商的行，
优先级：最近单流（90 秒内）→ 近 60 秒输出均速 → 近 5 分钟生成速度；无新鲜活动不显示。

## 只读路由与模型工具

| 端点 | 作用 |
|---|---|
| `GET /token-plan-quota/summary` | 快照（官方源吃 TTL；`?fresh=1` 强制回源）；含 `detection` 诊断块 |
| `POST /token-plan-quota/refresh` | 官方源回源 |
| `POST /token-plan-quota/reset` | 清零本实例实测统计（含窗口锚点） |
| `GET /token-plan-quota/probe?source=<id>` | 上游响应字段骨架（排查用） |

只接受同源请求，**永不回传密钥**。模型侧有 `token_plan_quota` 工具（`status` / `refresh` / `reset`）。

配合 429：`settings.yaml` 里给该 provider 配 `retryPolicy`（把 `QUOTA` 纳入 `retryableCodes`，
`initialDelayMs == maxDelayMs` + `jitterRatio: 0` 可把退避压成固定间隔）。明细的「自动重试观测」显示真实
发生的重试次数、等待秒数与生效策略——读 `llm/retry` 持久事件的 `policyKey`，不估算。

## 已知边界

- 实测窗口只含**经过本 DSH 实例**的调用：别的设备/工具消耗的额度不在内，官方折算率也不公开，
  所以它只报 token/次数，不报「剩余额度」。
- 上游控制台做过「额度重置」后，本实例窗口不会自动感知，用 `token_plan_quota`（`reset`）重新起算。
- 观测计数是本次进程启动以来的；持久事实仍在会话日志里。
- 座位退化：外壳没声明 `conversation.input.left` 时退到 `conversation.input.dock`；
  老外壳拿不到 react-dom 时面板退回内联 CSS 锚定，拖拽悬浮禁用。
- Moonshot / OpenRouter 的字段名**尚未用真实 Key 核对**（只有官方文档 + 端点存在性背书）。

## 明确不做的三类

以下形态需要读取其它 CLI 的本地登录态或额外强凭据，因权限与账号风险**不在本插件射程内**，
也不接受相关 PR——需要的人请用上面的「自定义源」自己配：

- 智谱 GLM 团队模式（`Bigmodel-Organization` / `Bigmodel-Project`）
- Kimi Code 的浏览器 Cookie / `~/.kimi-code/credentials/*`
- Codex·ChatGPT / Gemini CLI 的 OAuth token（`~/.codex/auth.json`、`~/.gemini/oauth_creds.json`）

## 免责声明

千问 Token Plan 的余量卡走的是**控制台数据网关（Cookie 会话），不是公开发布的官方 API**：
上游随时可能改动或拒绝；若其服务条款禁止此类访问，请**不要启用**该源（把 `token-plan-console` 从
`sources` 去掉，或关掉 `autoDetect` 后不写它）。Cookie 只从本地解析、只在进程内使用、
**绝不进任何路由响应**——细节见 [`SECURITY.md`](SECURITY.md)。

## 开发

```bash
npm run check                      # 下面四步一次跑完
node test/host.mjs                 # 350 项，离线
node test/client.mjs               # 102 项，假 React/DOM/fetch
node scripts/check-manifest.mjs    # 清单自检（安装性、出站主机、许可证、零依赖）
node scripts/check-docs.mjs        # README 的可核实声明必须与代码一致
```

`check-docs` 不是装饰：它把「DEFAULTS 17 个键、配置表 18 行、8 个数据源、声明 8 个出站主机、测试 350/102 项」这些写在 README
里的数字拿去和代码与实跑结果对，**数字漂了就 CI 红**（已用反向用例验证它真的会失败）。

测试跨平台（临时目录取 `os.tmpdir()`，不依赖真实 `~/.dsh`），CI 跑 node 20/22 × ubuntu/windows/macos，
外加"解包后能加载"的冒烟（`npm pack` → 解 tar → `import lib/index.js`）。
贡献流程与产品口径见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，发版三步（GitHub topic / npm / 插件目录站）见
[`RELEASE.md`](RELEASE.md)。

## 许可

[MIT](LICENSE)
