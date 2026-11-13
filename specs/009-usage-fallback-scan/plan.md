# PLAN — 009 兜底目录扫描 + 重启即可见

## 1. 前提（先核实，再动手）

| # | 前提 | 证据 |
|---|---|---|
| 1 | 索引里两个「失踪」会话真实存在且数字可复现 | 直接读 `session.v4.jsonl.zstd` 折叠：`session-373f78cb…` 137 calls / 8,535,136 tokens；`session-73bbb3d1…` 314 calls / 56,700,666 tokens —— 与 2026-11-13 早前裸折一致 |
| 2 | 它们不在宿主 `list()` 里 | 索引 215 个 session 键 vs 磁盘 217 个会话目录；补集恰是这两个 |
| 3 | 目录名有两种形态 | 132 个 `session-<uuid>` + 85 个裸 `<uuid>`；索引键同样是 130 + 85（同一个会话两种命名，别剥前缀） |
| 4 | 日志是多帧 zstd | 242 份日志里 237 份多帧；直接 `zstdDecompressSync` 整份 buffer 只出第一帧（451 KB 文件只得 271 字节 header） |
| 5 | fork 会话确实存在继承前缀 | 3 份日志 `isSeeded: true`，且都有 `session/end-seed {inherited: true}` 标记 |
| 6 | 全量解码成本 | 132 份 / 195 MB / 334,571 事件 / 18.4 秒（单进程实测）；正常只扫 2 个缺失目录（约 1.3 MB、几十毫秒） |
| 7 | 重启空屏根因 | `buildUsageSnapshot` 读 `usageIndex`（`null` 直到 `runUsageSync` 的 `loadUsageIndex`）；首轮同步 `USAGE_SYNC_FIRST_DELAY_MS = 20_000` |
| 8 | 索引落盘是增量累积 | `syncUsageIndex` 只 append，不重建 `days`；重启/日志被删都不会让历史变小 |

## 2. 方案

### 2.1 兜底扫描挂在同步末尾（而不是另起一套）

`syncUsageIndex` 已经是「单飞 + 增量 + 有失败计数」的结构，兜底只是**多一个数据来源**：
persistence 列表折完，再把「列表里没有、磁盘上还在」的会话按同一套 `foldUsageEvents` 折进去。
不新建索引文件、不改 schema、不另写定时器 —— 幂等与预算都落在同一处。

### 2.2 用文件签名做幂等（不另造字段）

`index.sessions[id].revision` 本来就是字符串。兜底用 `file:<bytes>:<mtimeMs>` 填充：
签名不变 = 文件没动 = 整份跳过；变了按 `maxSeq` 判断是「追加」还是「被重写」。
新增字段会破坏 schema 白名单（`SESSION_KEYS`），这也是不另造字段的原因。

### 2.3 增量折叠的 cut 语义

`foldUsageEvents` 只认 `cut`（`seq < cut` 跳过），没有「从第 N 条开始」的独立参数。
所以追加场景把 `cut` 取成 `max(继承前缀 cut, previous.lastSeq + 1)`：
继承前缀那条线不能丢（否则父调用重复计），已折过的尾巴也要跳过（否则同一批调用再计一次）。

### 2.4 文件变短 = 不猜

日志被重写/压缩（`maxSeq < previous.lastSeq`）时，索引里已经累计的计数**无法回退**（只存聚合值）。
这时不折、记 `scanFailed`，把不确定性显式暴露，而不是既可能少计又可能翻倍地硬折。

### 2.5 懒加载（FR-007）

`loadUsageIndex` 是同步读 72 KB JSON，成本可忽略；用它替掉「等 20 秒」没有任何副作用：
`buildUsageSnapshot` 首次调用读盘 → 立刻有数；同一轮请求仍会按「距上次同步 > 60s」踢一轮异步同步去补新会话。
`coverage.sessions` 同时回落到索引里的键数，免得客户端把「还没同步」误判成「没有会话」。

## 3. 失败模式与对策

| 失败模式 | 症状 | 对策 |
|---|---|---|
| Node < 22.15 无 `zstdDecompressSync` | 兜底整块不可用 | `decodeSessionLog` 返回 `{ ok:false, reason:"no-zstd" }`，`scanSkipped:"no-zstd"`，其余同步照常 |
| 日志最后一帧写到一半 | 该帧解压失败 | 帧内重试延展 + 跳过坏帧；已解出的前缀照折，签名按读取时字节数记录 |
| 同一目录多版本日志 | 同一批调用折 2–3 次 | 只读版本最高的一份（v4 > v3 > v2 > 无版本） |
| seeded 会话缺 `inherited` 标记 | 父调用重复计 | 只在 `header.isSeeded === true` 时找标记；找不到按 `cut = 0` 但记 `scanFailed`（可观测） |
| 全量重建（persistence 整体不可用） | 一轮 18 秒 CPU | 64 MB/轮预算 + 每文件 `setImmediate` 让出；剩下的下一轮继续 |
| 目录不存在 / 权限不足 | 不应影响主路径 | `fallbackLogsOf` 返回空、`scanSkipped:"no-dir"`，不抛 |
| 会话同时在列表与磁盘、但列表读失败 | 两条路径各折一次 | 列表里的 id 一律不交给兜底（候选集显式排除） |

## 4. 测试矩阵

| 层 | 断言 |
|---|---|
| `decodeSessionLog` | 单帧 / 3 帧合成 / 坏尾帧 / 无 zstd（桩）|
| `parseSessionEvents` | 坏行跳过、空行忽略、事件顺序不变 |
| `fallbackCutOf` | 无标记 0 / 标记在中段 / 标记在末尾 / 非 seeded 恒 0 |
| `fallbackLogsOf` | 两种目录命名 / 多版本只留高版本 / 无日志目录 / 根不存在 |
| `fallbackSignature` | 形状 `file:<bytes>:<ms>`；bytes/mtime 变即变 |
| `syncUsageIndex` | 补扫隐藏会话（rescued=1）→ 二次同步 rescued=0 数字不变；追加文件只折尾巴；文件变短 scanFailed=1；预算不足 scanDeferred>0；persistence 列表失败时全目录兜底 |
| `buildUsageSnapshot` | 预置索引 + `hardResetUsage` + 空列表 → 非零 totals、`coverage.sessions > 0`；`usageScanFallback:false` 时 rescued 恒 0 |
| 客户端 | `rescued>0` 渲染带 `data-usage-rescued` 的一行；缺失/0 不渲染；zh/en 无 `%`/`Credits` |
| guards | `usage-stats.js` 新增段无网络/无凭据/无写入；`index.js` 不新增出站主机；DEFAULTS 两键在位 |

## 5. 落地顺序

1. 纯函数层 + 单测（`lib/usage-stats.js`、`test/host.mjs`）——先证明读得对。
2. 宿主接线（懒加载 + 配置 + coverage + `__internals`）+ 回环测试。
3. 客户端一行脚注 + 断言。
4. guards 静态矩阵。
5. 文档（README 双语、CHANGELOG、`docs/upstream-contracts.md` 加「会话日志文件」契约）。
6. 真实实例验证：重启后首个 `/usage` 立刻有数；补扫后 215 → 217、总账 +约 6,500 万（多属 9 月，10 月约 +640 万）。
7. `npm run check` 全绿后按四个中文 Conventional Commits 提交。
