# 006 实现接口契约（Lead 定稿，2026-11-13）

> 本文件是实现期的**唯一接口真值**。spec/plan/tasks 里与此冲突的行，以本文件为准；收尾时回写 plan。
> 仓库根：`C:/Users/OMEN/.dsh/plugins/dsh-token-plan-quota`（下称 repo）。
> 零第三方依赖、无构建步骤；提交由 Lead 统一做，teammate **不要 git add/commit**。

## 0. 文件所有权（写作用域，别的文件别动）

| 归属 | 文件 |
|---|---|
| A（宿主） | `lib/usage-stats.js`（新建）、`lib/index.js`、`test/host.mjs`、`test/guards.mjs` |
| B（客户端） | `lib/client.js`、`test/client.mjs` |
| C（文档门禁，A/B 之后） | `README.md`、`README.en.md`、`CHANGELOG.md`、`docs/upstream-contracts.md`、`scripts/shots/**`、`scripts/check-docs.mjs`、`docs/images/**`、`package.json`（仅版本号，若需要） |
| Lead | `specs/006-usage-stats/**`、最终 `npm run check`、QA、提交 |

A 与 B 可并行：B 只依赖本文件定义的 HTTP 形状，**不要等 A 的代码**；本地联调时 B 用假快照。

## 1. 索引模块 `lib/usage-stats.js`（A）

纯函数 + 一个收集器，只依赖 node 内建（fs/path）。ESM 导出：

```js
export const USAGE_INDEX_VERSION = 1
export const MAX_BACKFILL_DAYS = 365
export const DAY_MS = 86_400_000

/** 本地日 YYYY-MM-DD（用 getFullYear/getMonth/getDate，不用 toISOString）。 */
export function dayKey(ms) {}

/** 空索引：{ version, updatedAt: 0, sessions: {}, days: {} } */
export function emptyUsageIndex() {}

/**
 * 把 events 折叠进 index（就地修改），返回本批增量计数。
 * @param index  索引对象
 * @param events [{ seq?, type, time, data }]（seq 缺省时用 startSeq + i）
 * @param startSeq 第一条事件的 seq（含）
 * @param cut    继承前缀条数：seq < cut 的事件跳过
 * @param opts   { retentionDays, now, modelDefaults? }
 * @returns { added: {input,output,cacheRead,cacheWrite,calls}, unknownModel, skippedOld }
 */
export function foldUsageEvents(index, events, startSeq, cut, opts = {}) {}

/** 唯一聚合入口：返回 HTTP 响应里除 generatedAt/refreshing/emptyReason 外的全部字段。 */
export function aggregateUsageRange(index, { days, now = Date.now() }) {}

/** 读盘。文件不存在 → emptyUsageIndex()；JSON 坏/schema 坏 → 备份为 <path>.bad-<ms> 后返回空索引。 */
export function loadUsageIndex(filePath, opts = {}) {}

/** 原子写：同目录 <basename>.tmp-<pid>-<rand> 写入后 rename；失败抛出，调用方记诊断。 */
export function saveUsageIndex(filePath, index) {}

/** 丢弃早于 now - retentionDays 的日桶；就地修改并返回 index。 */
export function trimUsageIndex(index, retentionDays, now = Date.now()) {}
```

收集器（同一个模块导出，但通过参数拿 ctx，不 import 插件本体，避免环）：

```js
/**
 * @param deps { persistence, index, config, now?, onProgress? }
 *   persistence: 宿主 sessionPersistence 服务（含 list/listSnapshots 与 open/read 之一）
 * @returns { ok, skipped?, sessions, indexed, failed, unknownModel, skippedOld, durationMs }
 */
export async function syncUsageIndex(deps) {}
```

### 索引 schema（落盘，白名单）

```json
{
  "version": 1,
  "updatedAt": 1790000000000,
  "sessions": {
    "<id>": { "revision": "dev:ino:size:mtimeNs:ctimeNs", "lastSeq": 1234, "cut": 0 }
  },
  "days": {
    "2026-11-12": {
      "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0,
      "models": {
        "qwen-token-plan-cn/qwen3.8-flash": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0 }
      }
    }
  }
}
```

- 只允许以上键；guards 断言 schema 白名单（递归键名集合），出现 message/text/body/headers/cookie 等即失败。
- `cut`：该会话继承前缀事件数（打开 handle 时得到），用于跳过 seq < cut。
- 模型归属：最近一次 `event.type === "request/header"` 的 `event.data.header.config.{provider,model}`；
  没有 header 时记 `unknown/unknown`，每个事件计入 `unknownModel` 计数（不丢）。
- 一条 `assistant/message` 且 `event.data.usage` 存在 = 1 次调用（`calls += 1`）。响应里的 `steps` 直接等于 calls
  （口径注释写明：计入的每次调用计一步，不另设字段）。
- 字段缺省按 0；负数/NaN 归 0；只认毫秒时间戳（`event.time`），非法时间跳过并计入 skippedOld？**不**：非法时间按 now 归属并计 1 个 diagnostic，不静默丢。简单实现：`Number.isFinite(event.time)` 否则用 now。

### 聚合规则 `aggregateUsageRange`

- `days` 已由调用方夹到 `1..usageBackfillDays`（服务端夹紧；非数字/缺失 → 默认 7）。
- 区间：`to = 今天`，`from = to - (days - 1)` 天（本地日，含首尾）。
- `granularity = days > 62 ? "week" : "day"`。
- day 桶：区间内每一天一个桶，缺数据补 0，升序。`from = to = "YYYY-MM-DD"`，`label = "MM-DD"`。
- week 桶：以**本地周一**为界（区间首桶可从 from 起、末桶可到 to 止，但桶边界必须是周一）；
  `from = 桶起始日本地日`，`to = min(桶起始+6天, 区间 to)`，`label = "MM-DD"`（桶起始）。桶之间不重叠不留缝。
  例：now=2026-11-12（周四），days=63 → 首桶 2026-09-07（周一）~09-13，末桶 11-09~11-12，共 **10** 桶；
  days=365 → **53** 桶（首桶 2025-11-10）。测试固定 now=2026-11-12 断言这两个数。
- 每个桶 `models`：对象 map（key = "provider/model"），值为该桶内同模型合计（不含派生 tokens）。
- `totals` / `models[].totals` 形状：`{input, output, cacheRead, cacheWrite, calls, steps, tokens}`；
  `tokens = input + output + cacheRead + cacheWrite`（纯求和）；`steps = calls`。
- `models`（顶层数组）按 tokens 降序，同值按 id 升序；id = "provider/model"，另带 provider、model 两个字段。
- 三条恒等式必须成立：区间 totals == 桶 totals 之和 == 顶层 models totals 之和（逐字段）。

## 2. 宿主接线 `lib/index.js`（A）

### DEFAULTS（新增 3 键，按现有风格加注释）

```js
usageStats: true,                 // 是否启用用量统计（关掉 = 不同步；屏内显示已关闭，入口保留）
usageIndexPath: '$DSH_HOME/token-plan-quota.usage-index.json',
usageBackfillDays: 365,           // 1..365，索引保留天数 + 天数选择上界
```

### 状态与生命周期

- 模块级（沿用现有 `state` 对象风格）：`usageIndex`（内存索引，null 表示未加载）、`usageSync`（单飞 promise）、
  `usageSaveTimer`、`usageLastSyncAt`、`usageSyncResult`、`liveUsageDays`（本进程内实时日桶，Map）。
- `effectiveConfig` 里若 `usageBackfillDays` 非 1..365 的整数 → 夹紧（Math.round 后 clamp）。
- apply 内（webServer 上下文）：`ctx.effect(() => { 启动定时器; return () => 清理; })`
  - 首跑 `setTimeout(20_000)` 后 `runUsageSync(ctx)`；
  - 之后 `setInterval(5 * 60_000)`；
  - 两个 timer 都 `unref?.()`；dispose 时 clearTimeout/clearInterval。
  - `usageStats === false` 时仍清定时器、不启动同步。
- `runUsageSync(ctx, config)`：单飞（已有 in-flight 直接复用）；`persistence = ctx.get("sessionPersistence", false)`；
  无则记录 `{skipped:"no-session-persistence"}` 并返回；有则 load → `syncUsageIndex` → 2s 防抖 `saveUsageIndex`（写盘失败只记诊断，
  路线仍可读内存）→ 记 `usageLastSyncAt` 与结果。
- `recordUsage(...)` 末尾同时更新 `liveUsageDays`（本地日、provider/model、四类 token、calls），
  只在“无 sessionPersistence 降级态”被读取（避免与索引重复计数）。实时日桶同样按 `usageBackfillDays` 修剪，上限 400 个日键。
- 新增路由 `GET /token-plan-quota/usage`（沿用 prefix 路由的 `sameOriginOnly`；非 GET → 405；新增 `/usage` 到 404 routes 列表）。
- `token_plan_quota` 工具：`action` enum 加 `"usage"`，新增可选 `days`（integer 1..365，描述写清）；
  `usage` 不走网络，返回 `{ok:true, text, usage:{range, granularity, totals, models, coverage, source, emptyReason?}}`（`toToolJson` 收口）；
  文本形如「近 7 天本实例实测：input X / output Y / cacheRead Z / cacheWrite W tokens，共 N 次调用（覆盖 M 个会话）」。
  `reset` **不清索引**（月账本与窗口锚点语义不变）。
- `__internals` 追加：`emptyUsageIndex, dayKey, foldUsageEvents, aggregateUsageRange, loadUsageIndex, saveUsageIndex,
  trimUsageIndex, syncUsageIndex, buildUsageSnapshot, runUsageSync, liveUsageDays, usageIndex, usageSyncResult`。
- `GET summary` 的 `snapshot.config` 增加 `usageStats`（boolean，供徽标小窗决定是否显示「用量统计」按钮；
  **不要**把 usageIndexPath/usageBackfillDays 放进 summary）。

### 响应构建 `buildUsageSnapshot(config, ctx, query)`

返回对象（HTTP 200 原样 JSON）：

```json
{
  "generatedAt": 1790000000000,
  "enabled": true,
  "range": { "kind": "7d", "days": 7, "from": "2026-11-06", "to": "2026-11-12" },
  "granularity": "day",
  "totals": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0, "steps": 0, "tokens": 0 },
  "buckets": [{ "from": "2026-11-06", "to": "2026-11-06", "label": "11-06", "totals": {}, "models": {} }],
  "models": [{ "id": "p/m", "provider": "p", "model": "m", "totals": {} }],
  "source": { "kind": "session-index", "veracity": "measured", "label": "本实例实测（来自本地会话记录）" },
  "coverage": { "sessions": 0, "indexed": 0, "failed": 0, "unknownModel": 0, "skippedOld": 0 },
  "refreshing": false,
  "emptyReason": "no-usage-in-range",
  "hint": "先在本实例调用一次模型"
}
```

- `enabled=false`（usageStats 关闭）：totals 全 0、buckets 仍按区间补齐、`emptyReason:"usage-stats-disabled"`、
  `hint:"在插件配置里把 usageStats 设为 true"`、`source.label:"用量统计已关闭"`。
- 无 persistence 且无 live 数据：`emptyReason:"no-session-persistence"`，hint 写「宿主未提供 sessionPersistence」；
- 宿主有 persistence、同步成功但**一份会话都没有**（`sessions===0`）且区间零调用：`emptyReason:"no-sessions"`，hint「本实例还没有会话记录」——与 `no-usage-in-range`（有会话但这段没调用）是两件事，en 界面必须分别本地化，不能都落到「这段没有记录」；
  有 live 数据：`source.kind:"in-process"`、label「本进程启动以来（实测）」、`emptyReason` 省略。
- `query`：`{range?: "today"|"7d"|"30d"|"90d", days?: string|number}`。`days` 优先；非法/缺失时取 range 预设，
  再缺失默认 7。夹紧后今天=1。
- `refreshing = usageSync !== null`（**只表示「同步确实在飞」**，不含「距上次同步多久」——后者会让面板在 4/5 的时间里谎称正在同步，2026-11-13 真机实测抓到的就是这样）。**不阻塞**；`Date.now() - usageLastSyncAt > 60_000` 只用来**决定要不要踢**一轮异步同步（单飞，不堆叠），不影响 `refreshing` 的取值。
- `coverage.sessions` = 最近一次 list 的会话总数；`indexed` = 其中已成功处理（有 revision）的会话数（用索引里 sessions 计数近似，
  A 可存最近一次 sync 结果）；`failed` 来自最近结果；`unknownModel/skippedOld` 来自索引累计值（索引里存 `stats:{unknownModel,skippedOld}`? 不允许新键——
  改为从 sync 结果保留最近一次计数，随索引一起存于 sessions 之外？**决定：索引顶层加 `"stats": { "unknownModel": 0, "skippedOld": 0 }` 白名单键**，
  schema 白名单含该键；聚合时读它）。
- 响应中不得含消息文本、请求头、Cookie、路径（除索引路径诊断字段不允许出现；诊断只进 logger）。

## 3. 客户端 `lib/client.js`（B）

### 挂载（已从 app.asar 0.2.2-rc.1 核实，照抄这个形状）

```js
// 顶部（factory 内）：
const PANEL_ID = "token-plan-quota.usage";
let defineStore = null;
try { defineStore = require("@deepseek-ai/dsh-client-store").defineStore } catch { /* 老宿主：只留徽标 */ }
const USAGE = "/token-plan-quota/usage";

function apply(ctx) {
  ...
  const slots = ctx.get("slots");
  const layout = ctx.get("layout");
  const hasMain = slots !== undefined && layout !== undefined && slots.spec?.("main") !== undefined && defineStore !== null;
  if (hasMain) {
    ctx.effect(() => slots.inject("main", function* () {
      const handle = defineStore({ init: () => ({ days: 7, mode: "2d" }), actions: { setDays(d,v){d.days=v}, setMode(d,v){d.mode=v} } });
      const instance = handle.create();
      const store = { ...handle, create: () => instance };
      yield slots.register({ name: "main", key: PANEL_ID, store, inject: () => ({}) }, UsageScreen);
    }), "dsh-token-plan-quota: usage panel");
    ctx.effect(() => slots.inject("sidebar.panellist", () => slots.register({
      name: "sidebar.panellist", id: PANEL_ID, order: 10, label: () => pickLocale().usageTitle,
    }, UsagePanelIcon)), "dsh-token-plan-quota: usage panellist");
  } else {
    ctx.logger?.warn?.(new Error("token-plan-quota: 宿主无 main 整页座位或 layout 服务，用量统计屏不注册"));
  }
  ...
}
exports.inject = ["slots", "sessions", "modelDirectories", "layout"];
```

- `PANEL_ID` 必须 === sidebar.panellist 的 `id` === main 的 `key`。
- 单实例闩锁：main 注册包 try/catch；失败 `ctx.logger.warn` 并返回空 disposer（沿用徽标座位那套注释风格）。
- 关闭：`ctx.layout.selectPanel(null)`；Esc 监听在组件内（仅当 `ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID` 时生效亦可）。
- 徽标小窗底部加按钮「用量统计」：`onClick = () => { setOpen(false); ctx.layout.selectPanel(PANEL_ID) }`；
  `snapshot.config.usageStats === false` 时不渲染该按钮（徽标组件已拿到 snapshot）。Badge 组件通过 props 接收 `onOpenUsage`。
- 面板数据：fetch `USAGE + "?days=" + days`（days=7 时也可发 ?days=7；服务端懂）。带 `cache:"no-store"`；
  打开时拉一次；面板可见期间每 30s 拉一次；切换天数立即拉；错误后重试按钮再次拉。
- 组件内部状态：`data`、`error`、`loading`（首次）、`days`（来自 props.useStore 或本地 state）。展示「更新于 HH:MM」。

### 屏内容（必须与 COPY 字典同源；英文界面不得漏中文）

1. 头部：标题 `usageTitle`（「Token 计划用量」/ "Token plan usage"）、副标题范围文本、关闭按钮（aria-label）、
   天数选择：四个预设按钮（今日/7/30/90）+ `<input type="number" min=1 max=365 step=1>`；
   输入失焦/回车时：非数字 → 恢复上一次有效值且不发请求；数字 → clamp(1,365) → 发请求并把输入框回填 clamp 后的值。
   2D/3D 分段按钮（默认 2D）。
2. 总分卡：区间 tokens 总数（大字）、四类拆分（input/output/cacheRead/cacheWrite）、调用次数、
   「本实例实测」徽标 + 「2D/3D 同一线性刻度」脚注。
3. 图表：SVG。共用 `barHeight(tokens, max) = max <= 0 ? 0 : Math.max(tokens > 0 ? 1 : 0, Math.round(tokens / max * PLOT_H)) / PLOT_H`
   —— 返回 0..1 的比例；2D 柱高 = 比例 × PLOT_H；3D 同一比例。**导出纯函数供测试**：`exports.__internals = { barRatio, projectBar3D, clampDays, formatTokens, parseDaysInput }`。
   2D：每桶一个 `<rect>`，仅最高桶标数值；3D：每桶 3 个 `<polygon>`（顶面菱形/正面矩形/侧面平行四边形），
   等轴投影 `dx = -(w/2), dy = -h` 固定；三面用同一 CSS 变量主色 + 两档明度（用 `color-mix(in srgb, var(--...) 78%, white)` 或预设明度类，
   不新增依赖、不引色板库）。>62 天时轴标「每 7 天」并显示周桶。
   每个桶 `<title>` 写全量数字（tokens + 四类 + 调用数 + 日期范围）。窄视口：容器 `overflow-x:auto`，最小柱宽 8px。
4. 模型列表：按 tokens 降序，每行 model id + tokens + 四类拆分；无百分比。
5. 脚注：数据来源文案**按 `source.kind` 本地化**（`session-index` → 「本实例实测（来自本地会话记录）」/ "measured in this instance (from local session records)"；`in-process` → 「本进程启动以来（实测）」/ "since this process started (measured)"；`disabled` → 不渲染来源脚注，改由 disabled 态说明）——宿主的 `source.label` 是中文固定文案，**只作 `kind` 不可识别时的兜底**，直接渲染会让 en 界面出现中文。脚注还含延迟说明（最长 5 分钟；实时月账不受影响）、
   cacheWrite 当前宿主多不上报的说明、「不折算 Credits / 不估算余量」。
6. 四状态：loading（首次骨架）、backfilling（**只有确实有未索引会话时**：`coverage.sessions > 0 && coverage.indexed < coverage.sessions` → 顶部细进度条 +
   「正在回填历史（N/M 会话）」；`coverage.failed > 0` 时另给「部分会话读取失败，下一轮会重试」。**`refreshing` 不进 backfilling**——它表示「同步中或距上次同步 >60 秒」，空闲后的常规轮询会让满格进度条闪一下；`refreshing` 只做极轻提示（标题行小圆点 / 「正在同步」））、empty（按 emptyReason 给不同人话 + hint）、error（错误行 + 重试按钮）、
   disabled（`enabled === false` 或 emptyReason==="usage-stats-disabled" → 说明 + 配置提示）。error 与其余三态**互斥**：一旦 `error !== null` 就短路数据区，只留错误行 + 重试，不与旧图表并排（否则用户无法判断屏上数字可不可信）。宿主对 `/usage` 的内部异常返回固定 `{error:"usage-unavailable"}`（不把 `error.message` 原样上屏），客户端对它显示本地化的通用文案。
7. 所有文字进 `COPY.zh` / `COPY.en`；渲染文本**不含 `%`**，不含 `Credits`（脚注白名单除外：允许出现「不折算 Credits」这一句，
   测试按白名单过滤）。375px 下按钮换行、无横向溢出（页面容器 padding，图表自己滚动）。

## 4. 测试与门禁

- `test/host.mjs`（A）：在现有 check/ok 风格上追加
  ①fold 三恒等式与缺 usage 不计数；②继承前缀跳过（seq<cut）；③幂等（连续 fold 两次直方图不变）；
  ④revision 未变不 open、变则只读新片（假 persistence 计数 open 调用）；⑤聚合 day：7 天桶数、补 0、区间总分==桶和==模型和；
  ⑥周桶边界：now=2026-11-12 固定，days=63→10 桶、365→53 桶、62→62 桶；⑦路由形状（用现有路由测试法或直接调 buildUsageSnapshot）：
  字段白名单、非 GET 405、无 `%`/无消息文本；⑧降级：无 persistence → emptyReason + hint；坏 JSON → 重建并留 `.bad-*`；
  ⑨工具 usage 的 enum/输出；⑩live fallback：无 persistence 时 recordUsage 后 totals>0 且 source.kind==="in-process"。
- `test/guards.mjs`（A）：索引 schema 白名单（从 usage-stats.js 导出的 `assertUsageIndexShape` 或等价纯函数）；
  "无百分比/无 Credits" 静态矩阵扩展到 client 新代码（白名单行）。
- `test/client.mjs`（B）：假 `__ModuleLoader__`/require 环境（沿用现有 harness）+ 假 slots/layout 记录注册参数：
  ①main key == panellist id == PANEL_ID；②缺 `slots.spec("main")` 时不注册且不抛；③store 有 create 且 create() 返回同一实例；
  ④四状态渲染文本断言；⑤2D/3D 逐桶比例相等（调用 `__internals.barRatio`，并对两组多边形/矩形做像素级断言或纯函数断言）；
  ⑥天数：输入 0/366/abc 不发请求或夹紧；⑦close 调 selectPanel(null)；⑧无 `%`（白名单除外）、无 Credits。
- `check-docs` 与截图归 C；A/B 更新测试项数时**只在测试文件头部注释/README 无关处**，不要动 README/CHANGELOG。
- 运行：`node test/host.mjs`、`node test/client.mjs`、`node test/guards.mjs`（用真 node：`D:/Node/node.exe`）。
  不联网；`DSH_HOME` 指 tmp；不读真实会话（用假 persistence fixture）。

## 5. 验收（Lead 汇总）

`npm run check` 七步全绿（最后一次编辑之后）；真实回填耗时；Edge 截图 375/768/1440；评审三条 lens（原则 I/II/III）。
