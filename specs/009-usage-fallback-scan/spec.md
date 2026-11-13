# 009 — 用量兜底目录扫描 + 重启即可见

## 1. 用户故事

用户报了两件事（2026-11-13 22:42）：

1. **补一次兜底扫描**：本机用量索引只折宿主 `sessionPersistence.list()` 返回的会话。实测 217 个会话目录里有 2 个被 `list()` 隐藏
   （`session-373f78cb…` 137 次调用 / 8,535,136 tokens、`session-73bbb3d1…` 314 次调用 / 56,700,666 tokens），
   它们一直在磁盘上、目录与 header 都正常，却从没进过索引 —— 屏上少约 6,500 万 tokens（多数落在 9 月，其中 10 月约 640 万）。
2. **重启 DSH 后不对话就看不到用量**：`buildUsageSnapshot` 只读内存索引，而内存索引要等首轮定时同步（启动后 20 秒）才从盘上加载。
   重启后立刻打开用量屏 → `totals` 全 0、显示「这个区间没有记录到调用」，其实盘上索引好好地躺着 215 个会话。

## 2. 功能需求

- FR-001 宿主同步（`syncUsageIndex`）在折叠完 persistence 之后，再扫一遍会话日志目录
  （默认 `$DSH_HOME/sessions`）：对**不在本轮 persistence 列表里、也没进过索引**的会话目录，直接读日志文件折叠进索引。
  被 `list()` 隐藏但文件还在的会话因此能补回来。
- FR-002 日志是**多帧 zstd**（242 份日志里 237 份是多帧；整份 buffer 直接解只出第一帧）。必须按 zstd magic
  `0x28 0xB5 0x2F 0xFD` 切帧后逐帧解压再拼文本；zlib 的 zstd 能力不可用（Node < 22.15）时整块降级、不抛。
- FR-003 幂等 + 增量：每个兜底会话在索引里记 `revision = "file:<bytes>:<mtimeMs>"`（仍是字符串，schema 不变）；
  签名没变就整份跳过、不读文件；文件变长（追加）只折 `seq > lastSeq` 的事件；文件变短（被重写/压缩）不猜，跳过并计入失败。
- FR-004 fork/继承会话不能重复计父前缀：日志里 `session/end-seed` 且 `data.inherited === true` 是继承前缀的结束标记，
  `cut = 该事件位置 + 1`；`isSeeded !== true` 时 `cut = 0`。缺这层判断会把父会话的调用再折一遍（实测本机有 3 个这类日志）。
- FR-005 同一会话目录可能有 v4 / v3 / 无版本三份日志（本机 242 份对应 217 个目录），只读**版本最高的一份**，
  否则同一批调用会被折 2–3 次。
- FR-006 单轮扫描有字节预算（默认 64 MB）：超过就停，剩下的下一轮（5 分钟后）继续 —— 正常情况本机只需扫 2 个目录
  （1.3 MB），只有 persistence 整体不可用、要全量重建时才会触到预算（实测全量解码 132 份 / 195 MB 需 18.4 秒）。
- FR-007 重启即可见：`/usage`（与 `token_plan_quota` 工具）在内存索引为 `null` 时**先同步读盘**再算快照，
  不再等首轮 20 秒同步；没有本轮同步结果时 `coverage.sessions` 回落到索引里的会话数（不写 0）。
- FR-008 透明：`coverage` 增加 `scanned` / `rescued` / `scanFailed` / `scanDeferred`；客户端在 `rescued > 0` 时
  脚注追加一行「另有 N 个会话不在宿主的会话列表里，已按日志目录补扫」（中英双语）。
- FR-009 配置新增两键：`usageScanFallback`（默认 `true`，关掉 = 不扫目录）与 `usageScanPath`（默认 `$DSH_HOME/sessions`）。

## 3. 非目标

- 不改宿主 `sessionPersistence`（那是 DSH 本体的事，插件只做兜底读取）。
- 不把日志原文 / 消息文本 / 请求头写进索引或响应（索引 schema 白名单不变，只多一个字符串 revision 前缀）。
- 不做「按会话还原原始顺序」或「逐会话明细展示」；索引仍是按本地日 × 模型的计数账。
- 不新增任何出站主机（`dshhub.permissions.network` 仍 8 条）。
- 不重拍截图：兜底补扫在 fixture 里 `rescued = 0`，屏上像素不变（FR-008 只在真出现被隐藏会话时才多一行）。

## 4. 成功判据

- SC-001 用预置索引文件 + `hardResetUsage()`（模拟重启）+ 空 persistence 列表调 `buildUsageSnapshot`，
  不做任何同步就能拿到非零 `totals`，且 `source.kind === "session-index"`、`coverage.sessions > 0`。
- SC-002 造一个「persistence 列表里没有、磁盘上有」的会话目录，同步一轮后 `rescued >= 1`、`totals.calls` 增加；
  第二轮同签名 → `rescued === 0` 且数字不变（幂等）。
- SC-003 多帧 zstd 合成样本（N 帧）解码后所有事件都在、顺序不变；单帧老格式同样能解。
- SC-004 `session/end-seed {inherited:true}` 之前的调用不计、之后的计（合成样本抽查）。
- SC-005 同一目录放 v4 + v3 两份 → 只按 v4 折一次。
- SC-006 目录不存在、zstd 不可用、日志坏帧、文件变短四类降级都不抛，失败只进 `scanFailed` / `scanDeferred`，其余会话照常折。
- SC-007 `npm run check` 在最后一次编辑之后全绿（host / client / guards / manifest / docs / refs / submission）。
