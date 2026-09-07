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
| 都没命中 | 挂 `window:<provider>` 实测源：徽标不空，只报本地 token/次数 |

两条不变量：

- **你写过的永远赢**。`sources` 已覆盖的路由，检测不再追加；凭据解析不到的源整个不开（不挂错误卡占地方）。
  `autoDetect: false` 完全回到手写语义。
- **可解释**。每张自动开出的卡带 `detected: {by, rule, host, fallback}`，标题 tooltip 写
  「按 api.moonshot.ai 自动识别 · 区 international」；快照的 `detection` 块交代在用路由、开了什么、
  谁因何被跳过、谁没被认出——排查"这家怎么不显示"只看这一处。老宿主没有 `llm` 服务时静默退回配置语义。

## 界面

- **徽标跟随模型**：订阅宿主现成的 `sessions.list` → `modelDirectories` 运行时 store，模型一切换立刻改卡，
  不轮询、不打网络。优先级：有数字的官方卡 > 有数字的实测卡 > 报错的官方卡（提示去配 Cookie）。
- **一家只展示一张额度卡**：官方卡有数字时收起自动挂的实测兜底卡；官方卡变错误卡时兜底必须回来。
  收合发生在看得见数据的显示层，不在规划期——否则 Cookie 一过期徽标就空白。
- **一张卡可以有多个窗口**：宿主按主次排进 `card.meters`，`meters[0]` 与顶层数值同源、由标题行与大条表达，
  其余窗口各出一行「标签 · 剩余/总额 · 已用% · 重置日」带自己的细渐变条。
- **明细是常驻小窗**：可拖（按住标题栏）、可缩（右下角握柄）、位置与尺寸记进 `localStorage`、双击标题栏归位。
  **点哪儿都不会关掉它**——关闭只由再点徽标或 `Esc` 决定。不做「点外面就关」：那是下拉菜单的语义，
  而且靠选择器识别宿主输入区必然漏（线上产物里连 `data-composer-card` 都不存在）。
- 视觉：幽灵小控件，无边框、无状态圆点、无表情符号，**余量渐变条即状态**（≥70% 绿、40–70% 蓝、<40% 橙→红）；
  「官方／实测」药丸标档级；字体自成一套（Geist Variable + Noto Sans SC，断网落系统栈），等宽只留给标识串；
  所有动效尊重 `prefers-reduced-motion`。
- `panelScope: current`（默认）只列当前模型供应商的卡；想全看设 `"all"`。

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

| 键 | 默认 | 含义 |
|---|---|---|
| `autoDetect` | `true` | 按宿主在用路由自动补齐数据源；`false` 完全回到手写 `sources` 语义 |
| `sources` | 无（交给检测） | 数据源清单：`deepseek-balance`、`token-plan-console`、`token-plan-window`、`moonshot-balance`、`openrouter-credits`、`account-balance`、`fr-instances`、`resource-package`，或简写 `window:<provider>`，或完全自定义的 `{...}` 对象 |
| `moonshotRegion` | `china-mainland` | Moonshot 区：`china-mainland`（`api.moonshot.cn`，CNY）/ `international`（`api.moonshot.ai`，USD）。**两区 Key 不互通**，选错会 401（卡片会直接提示切区）；host 与币种成对切换，不做自动探测 |
| `refreshMinutes` | `10` | 官方源快照缓存分钟数（下限 15 秒）；点面板「更新于」或 `?fresh=1` 可强制回源 |
| `pollSeconds` | `10` | 前端轮询秒数（实测与吞吐每次实时重算；调小让徽标速度更跟手） |
| `panelScope` | `current` | 明细面板范围：`current` 只列当前模型供应商的卡 + 本实例实测；`all` 列全部源 |
| `showInstanceWindow` | `true` | 明细里是否带「本实例实测用量 + 限流重试观测」块 |
| `exposeTool` | `true` | 是否注册模型可调用工具 `token_plan_quota` |
| `debug` | `false` | 明细里回显上游响应的**字段骨架**（值打码、跳过凭据字段名），核对字段名用 |
| `endpoint` / `regionId` | `business.aliyuncs.com` / 无 | 阿里云 OpenAPI 接入点（国际站要换） |
| `accessKeyIdRef` / `accessKeySecretRef` / `securityTokenRef` | `ALIBABA_CLOUD_ACCESS_KEY_ID` / `..._SECRET` / 无 | 阿里云 AK/SK 的引用名 |
| `configPath` | `$DSH_HOME/token-plan-quota.json` | 外部 JSON 配置位置 |
| `usagePath` | `$DSH_HOME/token-plan-quota.usage.json` | 本实例账本落盘位置 |
| `minIntervalMs` / `timeoutMs` | `1200` / `15000` | 出站最小间隔与单次超时 |

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

`derive` 只认「一个 `+`/`-`、两侧是引用名或数字」；**任何一个操作数取不到就整条空**，绝不猜数补上。
`fields` 每个引用名给多条候选路径是有意为之（同一家 API 版本间 `data` 信封加不加都见过）。
列表型用 `kind: "list"` + `list`/`item`，多窗口家用 `card.meters`，多 host 家用 `regions`；
实测窗口用 `{"kind":"window","providers":[...],"windowDays":30}` 或简写 `window:<provider>`。
完整清单见 [`docs/adding-a-provider.md`](docs/adding-a-provider.md)。

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
node test/host.mjs                 # 324 项，离线
node test/client.mjs               # 102 项，假 React/DOM/fetch
node scripts/check-manifest.mjs    # 清单自检（安装性、出站主机、许可证、零依赖）
node scripts/check-docs.mjs        # README 的可核实声明必须与代码一致
```

`check-docs` 不是装饰：它把「配置表 17 个键、8 个数据源、声明 8 个出站主机、测试 324/102 项」这些写在 README
里的数字拿去和代码与实跑结果对，**数字漂了就 CI 红**（已用反向用例验证它真的会失败）。

测试跨平台（临时目录取 `os.tmpdir()`，不依赖真实 `~/.dsh`），CI 跑 node 20/22 × ubuntu/windows/macos，
外加"解包后能加载"的冒烟（`npm pack` → 解 tar → `import lib/index.js`）。
贡献流程与产品口径见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
