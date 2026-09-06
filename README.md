# dsh-token-plan-quota

在 DeepSeek Harness 网页界面里显示额度：**官方接口真值优先，没有官方接口的供应商
用明确标注「实测」的本实例消耗窗口卡顶上**——绝不折算 Credits、不估算官方余量。

徽标是工具行里的一个幽灵小控件（无边框、彩色圆点表状态），**跟随当前会话模型的供应商
切换**：DeepSeek 模型显示 DeepSeek 官方余额，千问 Token Plan 模型显示实测 7 天窗口，
切到没有额度源的供应商（如 MiniMax）则整个隐藏。点徽标展开全部数据源的明细面板。

```
┌ 输入框工具行 ─────────────────────────────────────────────┐
│ ● Token Plan 12.3万 tok ⚡42 tok/s 实测 剩5d   ← 点开看明细 │
└────────────────────────────────────────────────────────────┘
```

## 哪些供应商有官方额度接口（2026-09 实测核对）

| 供应商 | 官方 Key 化额度接口 | 徽标 | 证据 |
|---|---|---|---|
| DeepSeek | ✅ `GET https://api.deepseek.com/user/balance`（Bearer Key） | 余额/赠款/充值（真值） | 官方文档；真实 Key 实测返回 `balance_infos` |
| 阿里云费用中心 | ✅ BssOpenApi + AK/SK（需 AliyunBSSReadOnlyAccess） | 账户余额 / 资源包余量（真值） | 官方 OpenAPI 元数据逐字段核对 |
| 千问 Token Plan | ⚠️ 无 Key 化接口；**控制台网关可用**（Cookie 会话） | `token-plan-console` 官方余量卡（65% + 进度条 + 5h/7d 双窗口）；Cookie 没配时自动退回 `token-plan-window` 实测卡 | 套餐 Key 实测网关候选路径全部 404、无额度头；订阅页数据来自千问AI平台数据网关 `cs-data.qianwenai.com`（`BroadScopeAspnGateway` · `tokenplan/personal/api/v2` 的 usage/subscription/quota-config），契约按其前端包逆向 + 真实账号实测验证 |
| MiniMax | ❌ 无 | 不显示（明细里看本实例实测用量） | 官方文档未提供；实测常见路径全部返回 SPA HTML |

**「不估算」仍是硬约束**：没有 Credits 折算、没有抵扣率。`token-plan-console` 报的是
**网关原样返回的已用比例 × 总额度**（与订阅页同源）；`token-plan-window` 只统计
**经过本实例**的真实调用（token/次数），永远带「实测」角标；控制台额度重置后可用
`token_plan_quota` 工具（`reset`）让实测窗口重新起算。

### 看到真实 Token Plan 余量（「剩余量 65.1% / 总额度 10,000」那种）

套餐 API Key（`sk-sp-…`）拿不到 Credits 余量——这是产品边界。但订阅页背后的
**控制台数据网关**可以，用登录 Cookie 鉴权，已内置为 `token-plan-console` 源：

1. 浏览器登录打开 [千问AI平台订阅页](https://platform-home.qianwenai.com/analytics/token-plan/individual)；
2. F12 → Network → 任意请求 → 复制**请求标头里整行 `Cookie:`**；
3. 存进 `~/.dsh/.credentials.yaml`：`BAILIAN_CONSOLE_COOKIE: <粘贴内容>`（一行，别换行）；
4. 点面板底部「更新于」时间戳强制刷新——千问徽标自动从「实测」升级为「Token Plan 余量 58%」（带进度条）。

契约要点（按其前端包 `shared.js` 逆向核对，全部实测验证）：

- 数据网关 `POST https://cs-data.qianwenai.com/data/api.json?action=BroadScopeAspnGateway`，
  表单 `product/action/sec_token/region/params(JSON: Api+V+Data.cornerstoneParam)`；
  `consoleSite=QIANWENAI`（百炼控制台是 `BAILIAN_ALIYUN`）；
- **sec_token 全自动**：`GET https://platform-home.qianwenai.com/tool/user/info.json`
  （登录 Cookie）→ `data.secToken`。手配 `BAILIAN_CONSOLE_SECTOKEN` 仅作兜底覆盖；
- 三个内层 API：`usage`（per1Week/per5Hour 已用比例+重置时刻）、
  `subscription`（specCode/剩余天数/到期）、`quota-config`（**按档位**的 weekly/five_hour
  + `addon_quota.extrabundle` 用量包）。剩余 = `quota[specCode].weekly × (1 − 已用比例)`；
- 网关的人机校验会拒自定义 User-Agent（报 `PostonlyOrTokenError`），请求必须用浏览器 UA；
- Cookie 一般能用几周（`sessionExpireTimeStamp` 可见），过期后卡片报错并退回实测卡，重贴即恢复。
  Cookie 只从本地解析，绝不进任何路由响应。

另一条官方路是 AK/SK 费用中心（`fr-instances`，需建只读 RAM AccessKey），Token Plan
是否出现取决于计费侧建模，用 `GET /token-plan-quota/probe?source=fr-instances` 验证。

徽标优先级：有数字的官方卡 > 有数字的实测卡 > 报错的官方卡（提示去配 Cookie）。

## 明细面板范围（panelScope）

默认 `current`：面板只列**当前模型供应商**的卡 + 本实例实测用量，切到千问时不会再挂着
DeepSeek 余额；想全看把 `panelScope` 设为 `"all"`（改 `~/.dsh/token-plan-quota.json`
即热生效，不用重启）。

面板为极简版：只列**当前模型供应商绑定的卡**（官方余量 + 实测窗口），本实例月度用量卡、
隐藏提示、AK/SK 灰条、回源/清账按钮全部移除。每张卡是一枚圆角小卡片：标题带「官方」
（蓝渐变药丸）/「实测」（灰药丸）标签，大号数值 + 绿→蓝渐变余量条（宽度带 0.45s 过渡，
不硬跳），来源与口径长句收进 tooltip；吞吐压成一行（速度蓝色定宽，不随位数抖动）；
模型明细最多 6 行；底部只有一个低调的「更新于 hh:mm:ss」——点它强制刷新官方源。
轮询时徽标圆点做呼吸动画代替文字占位，宽度零抖动。面板宽度 380px、高度上限 52vh。
余量状态色：正常=绿蓝渐变，已用 ≥90% 才琥珀点，耗尽才红点。
强制刷新/清账的编程入口仍在：`POST /token-plan-quota/refresh`、`POST /token-plan-quota/reset`、
或 `token_plan_quota` 工具（`refresh`/`reset`）。

## 安装

```powershell
dsh plugin --profile web add <这个目录的路径>
```

装完**重启一次 `dsh web`**（bundle 与客户端入口在启动时组装）。零第三方依赖。

## 配置

主配置 `~/.dsh/token-plan-quota.json`（宿主每次查询前重读，改完不用重启；
也可写在插件行 `config`，JSON 优先级更高）：

```json
{
  "sources": ["deepseek-balance", "token-plan-console", "token-plan-window"],
  "refreshMinutes": 10,
  "pollSeconds": 10,
  "showInstanceWindow": true,
  "debug": false
}
```

| 键 | 含义 |
|---|---|
| `sources` | 数据源：`deepseek-balance`（官方真值）、`token-plan-window`（千问实测窗口，默认开）、`account-balance`、`fr-instances`、`resource-package`（需 AK/SK） |
| `showInstanceWindow` | 明细面板是否带「本实例实测用量 + 限流重试观测」块 |
| `panelScope` | 明细面板范围：`current`（默认，只列当前模型供应商的卡 + 本实例实测，DeepSeek 卡不再常驻）/ `all`（全部数据源） |
| `pollSeconds` | 前端轮询秒数（吞吐/实测每次实时重算；调小让徽标速度更跟手） |
| `debug` | 明细里回显上游响应字段骨架（值打码），核对字段名用 |

## 吞吐速度（实测，不估算）

宿主包一层 `llm/stream`：记录**首分片到 usage 分片**的活跃时长。两个口径严格分开：

- **速度（生成/解码）**：`lastTps = 输出 tokens ÷ 活跃秒`；`genTps` = 近 5 分钟
  Σ输出 ÷ Σ活跃秒（活跃总时长 <1 秒不出数，防超短流外推）。缓存读不计入分子——
  否则一次 36 万缓存命中的调用会把速度吹成几万 tok/s；
- **吞吐（量）**：`tpm60 / tokens300` = 全部 tokens（含缓存读），计费/搬运视角；
  `outTps60` 是近 60 秒输出均速。

快照顶层 `throughput` 块每次请求实时重算，且**滑动窗口随账本落盘**（`recent` 键）——
宿主重启后最近 5 分钟的实测还能带回。徽标 `⚡NN tok/s` 只取当前模型供应商的行，
优先级：最近单流（90 秒内新鲜）→ 近 60 秒输出均速 → 近 5 分钟生成速度；无新鲜活动不显示。
明细面板的「吞吐」行常驻（无流量显示 `—`）；`token_plan_quota` 工具摘要同口径。

### 实测窗口源（token-plan-window）

```json
{ "id": "token-plan-window", "kind": "window", "providers": ["qwen-token-plan-cn"], "windowDays": 7 }
```

- `providers`：绑定哪些供应商（徽标按**当前模型的 provider** 选卡，不是按模型名前缀——
  Token Plan 网关上的 deepseek-* 模型照样算 Token Plan 消耗）。
- `windowDays`：滚动窗口天数，对齐官方「每 7 天限额」规则；窗口起点 = 经过本实例的
  第一次调用，到期后下一次调用自动开新窗。
- 自定义窗口源（给别的订阅制供应商用）：照抄上面形状、换 `id`/`providers` 即可。

### 凭据

密钥按顺序解析：DSH 凭据服务 → 环境变量 → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`。
DeepSeek 用 `DEEPSEEK_API_KEY`；Key 引用名可在 sources 条目里覆盖（`bearerRef`）。
阿里云源另需 `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`。
每次查询重新解析，换 Key 不用重启。

已按官方元数据核对的字段：`QueryAccountBalance`(2017-12-14)、`DescribeFrInstances`(2023-09-30)、
`QueryResourcePackageInstances`(2017-12-14)。`QueryTokenPackageList`/`QueryFreeQuotaInstance`/
`QueryBalance`/`GetSubscriptionSummary` 在这些版本里不存在，别配。

### 自定义源（把官方网页/网关接口接进来）

如果哪家日后开放了 Key 化接口（百炼业务空间网关已有 `GET /api/v1/models/limits`
查**限流配置**，Bearer Key，但那是 workspace 域名、不含剩余额度），或你想把控制台
内部接口（cookie 会话）配进来：

```json
{
  "sources": [{
    "id": "my-quota", "label": "我的额度", "kind": "list",
    "url": "https://example.com/api/quota", "method": "GET",
    "cookieRef": "MY_CONSOLE_COOKIE",
    "list": ["data.items"],
    "item": { "name": ["name"], "remaining": ["left"], "total": ["total"], "unit": ["unit"], "expiresAt": ["expireAt"] },
    "providers": ["my-provider"],
    "keywords": []
  }]
}
```

## 徽标如何跟随模型

浏览器半边订阅两份现成的客户端运行时 store：`sessions.list`（当前会话 id）→
`modelDirectories.directoryFor(id).store`（宿主报的当前 provider/model）。模型一切换，
宿主 `selectModel` 的 echo 立刻推给徽标——不轮询、不打网络。拿不到这两个服务（老外壳）
时退回「官方卡全量显示」。

## 只读路由与模型工具

| 端点 | 作用 |
|---|---|
| `GET /token-plan-quota/summary` | 快照（官方源吃 TTL；`?fresh=1` 强制回源） |
| `POST /token-plan-quota/refresh` | 官方源回源 |
| `POST /token-plan-quota/reset` | 清零本实例实测用量统计（含窗口锚点） |
| `GET /token-plan-quota/probe?source=<id>` | 上游响应字段骨架（排查用） |

只接受同源请求，永不回传密钥。模型侧有 `token_plan_quota` 工具（`status`/`refresh`/`reset`）。

## 配合 429 自动重试

`~/.dsh/settings.yaml` 给 qwen-token-plan-cn 配 `retryPolicy`：`QUOTA` 纳入 retryableCodes，
`initialDelayMs == maxDelayMs` + `jitterRatio: 0` 把退避压成固定 60 秒（10 次上限）。
徽标明细的「自动重试观测」会显示真实发生的重试次数、等待秒数与生效策略（读取 llm/retry
持久事件的 policyKey，不估算）。

## 已知边界

- 千问 Token Plan 的实测窗口只含**经过本 DSH 实例**的调用：别的设备/工具消耗的 Credits
  不在内，官方 Credits 折算率也不公开——所以它只报 token/次数，不报「剩余额度」。
- 控制台做过「额度重置」后，本实例窗口不会自动感知，用 `token_plan_quota` 工具（`reset`）重新起算。
- 观测计数是本次进程启动以来的；持久事实仍在会话日志里。
- 座位退化：外壳没声明 `conversation.input.left` 时退到 `conversation.input.dock`。
- 当前模型供应商没有绑定任何数据源时徽标隐藏（明细从有徽标的模型切过去前先看）。

## 开发与验证

```powershell
node test/host.mjs     # 165 项：签名对照官方 SDK、官方字段抽取、窗口账本滚动与基线、吞吐速度数学、控制台网关回环（sec_token 自动获取+三接口）、panelScope、Bearer 回环链路、并发与 TTL、观测解析
node test/client.mjs   # 56 项：座位注册、徽标跟随模型切换、panelScope 过滤与 all 回退、速度标签新鲜度、紧凑面板（一行摘要/一行吞吐/每供应商一行重试）、无绑定隐藏、缺服务退回全量
```
