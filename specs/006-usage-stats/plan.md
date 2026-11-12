# 006 — 最近用量统计（tokens）· 实施计划

对应规格：`specs/006-usage-stats/spec.md`。口径由宪法原则 I 锁定：本功能所有数字都是「本实例实测」，
只报 token 计数，不派生百分比、不折算 Credits、不画余量条。

## 1. Problem

额度徽标能答「官方还剩多少」，答不了「最近用了多少」。用户明确要后者，且要 token 而不是千问 Credits。
现有本地月账本（`lib/index.js` 的「usageLedger」段与 `recordUsage`）只按自然月累加，没有按天桶，
所以今天/近 7 天/近 30 天都无从算起；而宿主会话事件流里本来就有每次调用的真实 usage，只是没人把它折叠成天。
本计划解决的就是：把会话事件流折叠成一份**按天、按模型**的索引，并给前端一块**独立的大屏**读它。

## 2. Non-goals

- 不做成本/金额估算（不乘单价、不出 ¥/$），不折算 Credits。
- 不读供应商额度接口、不被官方卡的比例影响；官方卡维持现状。
- 不改月账本文件（`token-plan-quota.usage.json`）的结构、reset 语义与「本实例实测用量」月卡。
- 不做跨机器/跨 CLI 汇总，不读取其它 CLI 的登录态或用量文件。
- 不展示或存储任何消息文本、请求体、请求头、工具输出；索引里没有这些字段。
- 不新增第三方依赖、不引入构建步骤、不新增出站主机（原则 IV / V）。
- 不改 `docs/images/` 既有 13 张截图，不重做 004 的架构图。

## 3. Premises（逐条核过，✅/❌）

| # | 前提 | 怎么核 | 结论 |
|---|------|--------|------|
| 1 | 宿主以 `sessionPersistence` 服务暴露会话快照与事件，方法为 `list()` 与 `open(id, "read")` | 读安装包 asar 内 `@deepseek-ai/dsh-session-persistence` 与 `-jsonl` 后端源码；另核 `@linxin666/dsh-agents` 的真实调用点 | ✅ 无 `listSnapshots` / `readFrom`；`list()` 返回 `{header, revision, sizeBytes}`，`handle.read(offset)` 返回 `{eventState, events}` |
| 2 | 每次调用都带真实 usage，字段为 `inputTokens` / `outputTokens` / `cacheReadTokens` | 抽样 16 份真日志 108/108 条 `assistant/message` 带 usage；全库 32,380 条带 usage | ✅ `cacheWriteTokens` 本机 0 命中（字段不存在时按 0 处理） |
| 3 | 继承会话（isSeeded）的日志含父会话事件前缀，不能重复计数 | 实测 `session-a795dde7`：cut 前 218 条 usage、cut 后 92 条 | ✅ cut 只能从 `handle.inheritedEventCount` 取，header 里没有 |
| 4 | `event.time` 是毫秒；`event.seq` 连续且等于数组下标 | 抽查 seq 逐条 +1；时间戳换算与本地日志一致 | ✅ 按下标做增量起点成立 |
| 5 | 读取成本可接受：30 天约 4.2s，全库约 19s | 本机 `~/.dsh/sessions`：238 份 / 248MB（30 天内 119 份 / 125MB），逐帧解压 + JSON.parse 实跑 | ✅ 但必须在后台分片跑，不能阻塞首个请求 |
| 6 | 快照没有 mtime，`header.createdAt` 不等于最近活动时间 | 读 jsonl 后端的 snapshot 构造；本机存在「创建于 40 天前、今天仍在用」的长会话 | ✅ 首轮不按 createdAt 过滤会话，只按 `event.time` 裁剪保留的日桶 |
| 7 | 现有路由 prefix handler 可加一个 GET 子路由，且已有同源校验 | 读 `lib/index.js`「路由注册」段的 `server.register({kind:"prefix"})` 与 `sameOriginOnly` | ✅ 新增 `usage` 子路由即可，不新增主机 |
| 8 | 现有测试是离线脚本 + 假 React / 假 slots，可注入假 persistence | 读 `test/host.mjs` 与 `test/client.mjs` 头部的假对象构造 | ✅ 新逻辑写成可注入依赖的纯函数 + 收集器即可离线断言 |
| 9 | `check-docs` 会核对 DEFAULTS 键数、配置表行数、截图清单、三套测试项数 | 读 `scripts/check-docs.mjs` 第 1/5/6/8/10 项 | ✅ 新增配置键与新截图必须同轮改 README 两版与硬编码清单 |
| 10 | 客户端有官方整页座位 `main`（keyed / scope root），入口是 `sidebar.panellist`，切换用 `ctx.layout.selectPanel(id)` | 读 asar 内 `@deepseek-ai/dsh-client-ui-layout/lib/client.js` 的 root 声明（`main: {kind:"keyed",scope:"root"}`）、`renderSlot("main", {}, {entryKey: panelId ?? "conversation"})`、`selectPanel` 的「未注册即抛错」；读 `dsh-client-ui-sidebar` 的 panellist 行点击（调宿主 `ctx.layout.selectPanel(id)`）；对照 `dsh-client-ui-plugin-manager` 的整页实现 | ✅ 三层齐备：`slots.register({name:"main", key, store, inject})` + `sidebar.panellist`（`id` 同名）+ `selectPanel(KEY)`；回会话 `selectPanel(null)`；`layout` 必须写进 `exports.inject` |
| 11 | 3D 柱状图不需要第三方三维库 | 核运行时：客户端半边零依赖、只有 React 与手写 bundle；3D 用 SVG 等轴投影（顶面菱形 + 正面 + 侧面共 3 个 polygon/桶）即可 | ✅ 固定角度、线性高度、无透视；两模式共用同一组桶与同一比例函数，不新增依赖、不引 canvas/WebGL |

## 4. Approach

### Considered alternatives

- **A. 只把现有月账本按时间戳重算**：月账本没有逐次时间戳，只有月桶；补齐需要改变既有账本结构与 reset 语义，
  而且装插件之前的调用根本没有记录。否决。
- **B. 只从启用后开始记新调用**：实现最轻，但用户明确要「最近用量」，刚装上看不到昨天以前的数。否决（用户选 A：回填 30 天）。
- **C. 读会话事件流建按天索引（选中）**：数据已经在盘上，宿主提供只读接口；能立刻回填，且天然是「本实例实测」。
  代价是首轮 I/O 与 CPU（见前提 5），用后台分片 + revision 跳过消化。
- **D. 复用 dsh-service 的 `dsh-service-usage-index.json`**：那份索引已停更（11-02 后无写入），且属于已禁用插件，
  版本与语义都不受本仓库控制。否决，只作为事件契约的参考实现。

UI 形态备选：现有小窗放大（否决：内容密度与层级都会失控）、宿主侧独立路由页面（否决：等于新开一个 HTML 产物，
与手写 bundle 的客户端半边重复维护）、设置页区块（否决：用户要的是「点开另开一屏」，设置分区不是独立屏）、
会话内 `conversation.view`（否决：只在本会话内、还要第二套注册，切会话就没了）、右栏 tab（否决：右栏窄，曲线读不了）、
**`main` 整页座位 + `sidebar.panellist` 入口（选中）**。portal 覆盖层降级为「宿主没有 `main` 座位」时的回退。

### Chosen approach and why

宿主半边新增一个**独立的用量索引模块**（`lib/usage-stats.js`）：纯函数负责折叠与聚合，收集器负责读会话；
索引写独立文件，与月账本互不影响；路由 `GET /token-plan-quota/usage` 读索引出快照；
浏览器半边新增 `UsageScreen`，注册进宿主官方 `main` 整页座位，另挂 `sidebar.panellist` 常驻入口，
现有徽标小窗底部加一行按钮作为快捷入口；关闭走 `ctx.layout.selectPanel(null)` 回会话。
选它是因为四件事同时成立：数据源只读且已存在（不需要新接口）、索引可离线测试（假 persistence）、
挂载面是官方座位且有官方整页先例（插件管理页）、3D 只靠 SVG 就能画（不引三维库、不破坏零依赖与手写 bundle）。

## 5. Design

### 5.1 事件 → 计数（契约）

- 信封：`event.type === "assistant/message"` 且 `event.data.usage` 存在。
- 字段与单位：`data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`，单位 tokens，方向为「本次调用消耗」；
  缺字段按 0；`event.time` 为毫秒，按**本地日**分桶。
- 模型归属：最近的 `event.type === "request/header"` 的 `data.header.config.{provider, model}`；模型键拼 `provider/model`；
  之前没有 header 时记 `unknown/unknown`，并在快照 `coverage.unknownModel` 计数（不静默丢）。
- 继承前缀：`seq < handle.inheritedEventCount` 的事件一律跳过；增量起点 = `max(cut, lastSeq + 1)`。
- 一条带 usage 的 `assistant/message` 计 1 次调用与 1 个 step（与月账本 `calls` 语义一致）。

### 5.2 索引文件

默认 `$DSH_HOME/token-plan-quota.usage-index.json`（新增 `usageIndexPath`）：

```json
{
  "version": 1,
  "updatedAt": 1790000000000,
  "sessions": { "<id>": { "revision": "dev:ino:size:mtimeNs:ctimeNs", "lastSeq": 1234, "cut": 0 } },
  "days": {
    "2026-11-12": {
      "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0,
      "models": { "qwen-token-plan-cn/qwen3.8-flash": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0 } }
    }
  }
}
```

只保留 `usageBackfillDays`（默认 365，1..365）以内的日桶；更早的在折叠时跳过、并在加载时修剪。
写盘用「临时文件 + rename」原子替换，2 秒防抖（与月账本同一节奏，但**不同文件**，避免互相覆盖）。

### 5.3 同步（回填 + 增量）

- 单飞保护：同一时刻只跑一轮；触发点三处：插件 apply 后 20s 首次、之后每 5 分钟、`GET /usage` 发现 `updatedAt` 超过 60s 时补跑一轮（不阻塞该请求，返回 `refreshing: true`）。
- 逐份会话串行：先 `persistence.list()`；`revision` 未变的会话直接跳过（**唯一省 CPU 的点**）；变更的才 `open(id,"read")`。
- 每 10 份会话 `await new Promise(r => setImmediate(r))` 让出主线程；单会话 try/catch，失败记 `sessions[id].failed`，下一轮重试，不中断整轮。
- 完全不支持时（`ctx.get("sessionPersistence", false)` 为 undefined）返回 `{skipped:"no-sessionPersistence"}`，路由快照带 `emptyReason` 与 `hint`，不假装 0。

### 5.4 聚合与接口

`GET /token-plan-quota/usage?range=today|7d|30d|90d&days=N`（`days` 优先，夹到 `1..usageBackfillDays`；`granularity = days>62 ? "week" : "day"`）：

```json
{
  "generatedAt": 1790000000000,
  "range": { "kind": "30d", "days": 30, "from": "2026-10-14", "to": "2026-11-12" },
  "granularity": "day",
  "totals": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "tokens": 0 },
  "buckets": [{ "from": "2026-10-14", "to": "2026-10-14", "label": "10-14", "totals": { }, "models": { } }],
  "models": [{ "id": "qwen-token-plan-cn/qwen3.8-flash", "provider": "qwen-token-plan-cn", "model": "qwen3.8-flash", "totals": { } }],
  "source": { "kind": "session-index", "veracity": "measured", "label": "本实例实测（来自本地会话记录）" },
  "coverage": { "sessions": 0, "indexed": 0, "failed": 0, "unknownModel": 0, "skippedOld": 0 },
  "refreshing": false
}
```

`buckets` 按时间升序、缺失日补 0（周桶同样补 0，不跳格）；`tokens = input + output + cacheRead + cacheWrite`（合计字段是**求和**，不是估算）。
`sameOriginOnly` 沿用；非 GET 回 405；响应不含任何消息文本或凭据。

### 5.5 前端独立屏

**挂载面（已核）**：`PANEL_ID = "token-plan-quota.usage"`。

- 整页：`ctx.slots.inject("main", function* () { … yield ctx.slots.register({ name:"main", key:PANEL_ID, store, inject:() => ({ close }) }, UsageScreen); … })`。
  `store` 必须形如 `{ ...handle, create: () => instance }`（layout 的 `main` 是 keyed/root 座位，root 声明就是这么构造 store 的，插件管理页同款）；
  没有它，keyed 座位的 hooks/面板信息取不到。
- 入口两处 + 快捷一处：① 侧栏 `sidebar.panellist`（`id: PANEL_ID`，宿主行点击自己调 `ctx.layout.selectPanel(id)`）；
  ② 徽标小窗底部按钮「用量统计」→ `ctx.layout.selectPanel(PANEL_ID)`；③ 屏头关闭与 Esc → `ctx.layout.selectPanel(null)` 回会话。
- `exports.inject` 追加 `"layout"`（硬依赖，缺它插件不激活；与现有「缺 slots/sessions 就不出徽标」同一取舍，README 依赖说明里写清）。
  注册前用 `ctx.slots.spec("main")` 探测座位：不存在就**只保留徽标**、记 warn、不注册坏 key（否则 `selectPanel` 会抛未注册）。
- 单实例闩锁：沿用徽标座位那套「同一时刻只挂一个 + disposer 归位 + 失败留痕」，避免 live reload / 双 fiber 时两个整页抢同一个 key。

**屏内容**：

- 头部：标题「Token 计划用量」（避开第三方 `@linxin666/dsh-usage` 已占的「使用统计」名）、关闭按钮、
  **天数选择**（预设今日 / 7 / 30 / 90 天 + `<input type="number">` 1..365，失焦夹紧并回填实际值，非法值不发请求；默认近 7 天）、
  **图形切换**「2D / 3D」（分段按钮，默认 2D，仅存组件状态不落盘）。
- 总分卡（区间四类 token + 调用次数 + 「本实例实测」标注）、图表、按模型列表、数据源脚注（含 `cacheWriteTokens` 当前不上报的说明）。
- 图表共用层：同一组桶、同一线性刻度 `0 → 区间最大值`、同一格式化函数（1.2K / 3.4M）；柱高比例只由 tokens 决定；
  0/50/100% 三条网格线带绝对数值刻度；每个桶带 `<title>` 全量数字（原生 tooltip，零 JS）。
- 2D：SVG 矩形柱，仅「最大值桶」标数值，避免拥挤。
- 3D：SVG 等轴柱 = 顶面菱形 + 正面矩形 + 侧面平行四边形，投影 `(x + (dx-dy)·cos30, y + (dx+dy)·sin30 - h)`；
  固定角度、**无透视缩短、无近大远小**；三面用主色 + 两档明度（色值取自现有 CSS 变量，不引色板）。
  **零依赖**：不引 three.js / canvas / WebGL，也不引任何图表库；两模式同一比例函数，测试断言逐桶等比。
- 桶粒度（服务端出桶，客户端照画）：`days ≤ 62` 按日；`> 62` 按周（周一为界，末桶可不足 7 天），轴标「每 7 天」。
- 模型列表：按 tokens 降序，绝对数与四类拆分，不写占比百分数。
- 四种状态：加载中（骨架）、首次回填中（进度 N/M 会话，不挡图表）、空（emptyReason 人话 + 下一步）、错误（重试按钮）。

### 5.6 配置（DEFAULTS 新增 3 键）

| 键 | 默认 | 含义 |
|----|------|------|
| `usageStats` | `true` | 是否启用用量统计（关掉 = 不同步，统计屏入口保留、屏内显示「已关闭」与配置提示） |
| `usageIndexPath` | `$DSH_HOME/token-plan-quota.usage-index.json` | 索引落盘位置 |
| `usageBackfillDays` | `365` | 保留的日桶天数（1..365），同时是天数选择的上界 |

### 5.7 模型工具

`token_plan_quota` 的 `action` 枚举加 `usage`，可选 `days`；输出文本形如
「近 7 天本实例实测：input X / output Y / cacheRead Z tokens，共 N 次调用（覆盖 M 个会话）」，同时回结构化 totals。

## 6. Failure modes

| 失败 | 表现 | 处理 |
|------|------|------|
| 宿主无 `sessionPersistence` | 永远空 | 快照 `emptyReason: "no-session-persistence"` + `hint`，屏上明说；不静默 0 |
| 单份会话格式不支持/半写 | 抛 `SessionFormatUnsupportedError` | per-session try/catch，记 `failed`，下一轮再试；`coverage.failed` 显示条数 |
| 继承前缀重复 | 数字偏大（实测可达 2.4 倍） | 按 `inheritedEventCount` 截断，单测覆盖 |
| 时间单位误判 | 日桶落到 1970 | 只认毫秒；单测固定时间戳断言本地日 |
| 首轮回填卡住宿主 | 界面卡顿 | 串行 + 每 10 份让出主线程 + 20s 延迟启动；不阻塞路由 |
| 索引写坏/截断 | 加载失败 | 读时 schema 校验失败即重建（保留旧文件为 `.bad-<时间>`），不静默清空 |
| 磁盘满/权限 | 写失败 | 记诊断、屏上提示「索引不可写」，统计仍可读内存 |
| 会话被删除 | `sessions` 里留孤儿 | 下一轮 list 里不存在的标记 `detached`，保留已计入的日桶（不追溯扣减） |
| 跨时区/跨日 | 同一事件归错日 | 统一本地日 `getFullYear/getMonth/getDate`；单测覆盖 23:59 边界 |
| 宿主无 `main` 座位 / 无 `layout` 服务 | 整页挂不上 | 注册前 `ctx.slots.spec("main")` 探测；不存在就只留徽标并 warn，不注册坏 key（`selectPanel` 会抛） |
| `main` key 重复注册 | 双面板或注册抛错 | 单实例闩锁 + disposer 归位 + 失败留痕（沿用徽标座位那套） |
| 天数输入越界 / 非数字 | 请求窗口过大或无意义上屏 | 服务端夹到 `1..usageBackfillDays`；客户端非法值不发请求，失焦回填实际使用天数 |
| 3D 视觉夸大（透视/近大远小） | 读者误读柱高 | 固定等轴、线性高度、无透视；两模式共用同一比例函数，脚注写明「2D/3D 同一线性刻度」 |
| 桶粒度切换边界（62/63 天） | 出桶突变或轴标签错误 | 服务端按 `days>62` 出周桶；单测覆盖 62/63/90 天的桶数、首末桶与 label |

### 已知盲点

- 首轮必须扫完全部会话才能找到 30 天内的数据（快照无 mtime），全库约 19s；已用后台分片消化，但**首次打开仍可能看到「回填中」**。
- `cacheWriteTokens` 本机始终为 0，展示时保留字段但会在脚注说明「当前宿主不上报」——避免读者以为是本插件漏算。
- 会话被删除或修订（revision 不可比对）时，已计入的日桶不会回滚；这是「账单式」取舍，写进像素脚注。
- 实时新调用由下一轮同步摄入（最长 5 分钟延迟）；`llm/stream` 的月账本仍实时，两者延迟不同，文档要写明。

## 7. UI states

| 状态 | 触发 | 界面 |
|------|------|------|
| 成功 | 索引就绪 | 总分卡 + 每日柱状 + 模型列表 + 「更新于 HH:MM」 |
| 加载中 | 首次拉快照 | 骨架条 3 行，不闪空态 |
| 回填中 | `refreshing` 或 `coverage.indexed < coverage.sessions` | 顶部细进度条 + 「正在回填历史（N/M 会话）」 |
| 空 | 无 usage 事件或服务缺失 | 居中说明 + `emptyReason` 的人话 + 提示下一步（先在本实例调用一次模型） |
| 错误 | 请求失败 | 错误行 + 重试按钮（复用 `reload(true)` 语义） |
| 窄视口 375px | 手机宽度 | 单列；天数与图形切换按钮换行；无横向溢出 |
| 3D 模式 | 点击「3D」 | 同一组桶换成等轴柱；网格线/刻度/标题不变；再点「2D」逐桶柱高比例不变 |
| 自定义天数 | 预设外的数字（1..365） | 请求 `?days=N`；非法值提示且不发请求；>62 天轴标「每 7 天」 |
| 窄视口 768px | 平板 | 两列（总分卡 + 模型列表并排），柱状图全宽 |
| 窄视口 375px（图表） | 手机宽度 | SVG 保最小柱宽并允许容器横向滚动；天数/图形切换按钮换行不溢出 |

## 8. Test plan

行为矩阵（每条都写「应当发生 / 应当不发生」两端，能证伪）：

1. fold：给定 3 条 usage 事件（不同模型、不同日）→ 日桶与模型桶合计相等；缺 usage 的事件不计数；
   `seq < cut` 的事件被跳过（用含继承前缀的 fixture 断言「不重复」）。
2. 幂等：同一批事件折叠两次 → totals 不变（第二次从 `lastSeq+1` 开始读，不重复计）。
3. 增量：revision 未变 → 不打开 handle；revision 变 → 只读新增切片。
4. 聚合：近 7 天 totals == 7 个日桶之和 == 模型桶之和；缺失日补 0；`days=N` 越界夹到 1..backfillDays。
5. 路由：`GET /usage` 200 形状；非 GET 405；跨源 403；无 persistence 时 `emptyReason`；响应内无 `%`、无消息文本。
6. 降级：假 persistence 抛错 → `coverage.failed` 计数且不 500。
7. 前端：`UsageScreen` 四状态渲染断言；文本不含 `%` 与 `Credits`（除脚注「不折算 Credits」白名单）；
   375px 类名断言；点击范围切换触发对应请求。
8. 门禁：`check-docs` 的 DEFAULTS 键数/配置表行数/截图清单/三套测试项数与新状态一致；
   `guards` 增加索引 schema 白名单断言（写进第 4 项的同一矩阵）与「无百分比」静态断言。
9. 图形模式：切到 3D 后每桶渲染 3 个 `<polygon>`（顶/正/侧），柱高与 2D 用同一比例函数（逐桶断言相等）；
   两模式的刻度文本相同；渲染文本仍不含 `%`。
10. 天数与桶：预设/自定义触发对应 `?days=N`；`0/366/abc` 不发请求或夹紧；62 天 = 62 个日桶；周桶以**本地周一**为界（首末桶可不足 7 天），固定 now=2026-11-12 时 63 天 = 10 个周桶、365 天 = 53 个周桶（见 INTERFACE.md §1）。
11. 座位：假 slots 记录注册参数——`main` 的 `key` 与 `sidebar.panellist` 的 `id` 相等、store 形如 `{create}`、
   `close()` 调 `selectPanel(null)`；`spec("main")` 缺失时不注册且不抛、不留脏 key。

离线要求（原则 VI）：全部用例不联网、`DSH_HOME` 指临时目录、不读真实会话。

## 9. Steps

1. **T001** 新增 `lib/usage-stats.js`：`dayKey` / `foldUsageEvents` / `aggregateRange` / `loadIndex` / `saveIndex`（原子写、schema 校验、修剪）。
2. **T002** 收集器 `syncUsageIndex(ctx, config)`：list → revision 跳过 → open/read → cut 截断 → fold → 分片让出 → 单飞与失败计数。
3. **T003** 宿主接线（`lib/index.js`）：DEFAULTS 3 键、`__internals` 导出、apply 内调度（20s 首跑 + 5 分钟定时）、
   路由 `usage` 子路由、工具 `action:"usage"`、`reset` 是否清索引（**决定：不清**，reset 只清月账本与窗口锚点，文档写明）。
4. **T004** `lib/client.js`：`UsageScreen`（注册进 `main` 整页座位 + `sidebar.panellist` 入口 + 徽标小窗按钮）+ 天数选择 + 2D/3D 图表 + 四状态
   + 单实例闩锁 + `exports.inject` 追加 `layout`；样式复用现有变量与字体（含 3D 三面明度）。
5. **T005** 测试：`test/host.mjs` 加 fold/幂等/增量/聚合/桶粒度/路由/降级；`test/client.mjs` 加四状态、2D·3D 逐桶等比、天数参数、座位断言；
   `test/guards.mjs` 加索引 schema 与「无百分比」矩阵。
6. **T006** 文档与门禁：README 中英（功能段、配置表 +3 行、路由表 +1 行、DEFAULTS 计数、三套测试项数）、
   `CHANGELOG.md`、`docs/upstream-contracts.md`（新增「会话事件 → 用量」契约段，标注属本实例实测）、
   `scripts/shots/make-shots.mjs` 增统计屏截图（zh/en；2D 与 3D 各一张）+ `check-docs.mjs` SCREENSHOTS 硬编码清单 + requiredImageRefs。
7. **T007** QA：实跑一次首轮回填并记录耗时（对照 SC-003）；Edge 截图核对 375/768/1440；`npm run check` 七步全绿。

## 10. Retro

（实现与评审完成后回填：只写「反复出现的误解」进 AGENTS.md、「反复出现的盲点」进 workflow/PLAN.md。）
