# INTERFACE — 009 兜底目录扫描 + 重启即可见（实现唯一接口真值）

冲突时以本文件为准。

## 1. 纯函数层（`lib/usage-stats.js`，只读文件、不联网、不读凭据）

### 1.1 `decodeSessionLog(buffer)`

- 入参 `Buffer`。返回 `{ ok: true, text, frames }` 或 `{ ok: false, reason }`，`reason` ∈ `"no-zstd" | "no-frames" | "decode-failed"`。
- 切帧：扫描 zstd magic `0x28 0xB5 0x2F 0xFD`；每帧用 `zlib.zstdDecompressSync`；某候选帧解不开就把结束位置延到下一个 magic 重试（最多 8 次），
  仍失败则跳过这一帧继续向后；`text` 是各帧解压结果按顺序拼接后的 utf8 字符串。
- `zlib.zstdDecompressSync` 不存在（Node < 22.15）→ `{ ok: false, reason: "no-zstd" }`（实测本机 Node 24.14 可用）。

### 1.2 `parseSessionEvents(text)`

- 按 `\n` 切行、忽略空行；逐行 `JSON.parse`，非对象或坏行计入 `badLines` 并跳过。
- 返回 `{ events, badLines }`。

### 1.3 `fallbackCutOf(events)`

- `events[0]` 是会话 header（`type === "session"`）；只有 `header.isSeeded === true` 的会话才有继承前缀。
- 扫描 `events`，取**最后一条** `type === "session/end-seed" && data && data.inherited === true` 的事件：
  `cut = (Number.isFinite(Number(event.seq)) ? Number(event.seq) : 下标) + 1`。
- 没有该标记 / 不是 seeded → `0`。返回值是 `foldUsageEvents` 的 `cut`（`seq < cut` 的事件跳过）。

### 1.4 `fallbackLogsOf(sessionsDir)`

- 两级目录：`<sessionsDir>/<project>/<sessionDir>/session[.vN].jsonl.zstd`。
- `sessionDir` 名即会话 id（本机 130 个形如 `session-<uuid>`、85 个是裸 `<uuid>`，两种都要原样当 id，不剥前缀）。
- 同一 `sessionDir` 有多个版本文件时只留**版本最高**的一份：`session.v4.*` > `session.v3.*` > `session.v2.*` > `session.jsonl.zstd`。
- 返回 `{ logs: [{ id, path, bytes, mtimeMs }], dirs }`：`logs` 只含存在日志的会话目录；`dirs` 是枚举到的会话目录数（含没有日志的）。
- `sessionsDir` 不存在 / 读不了 → `{ logs: [], dirs: 0 }`，不抛。

### 1.5 `fallbackSignature(log)`

- 返回 `"file:" + bytes + ":" + Math.round(mtimeMs)`，写进 `index.sessions[id].revision`（schema 仍要求字符串）。

### 1.6 `syncUsageIndex(deps)` 的扩展

新 deps：`sessionsDir`（可选字符串）、`scanFallback`（默认 true）、`scanBudgetBytes`（默认 `FALLBACK_SCAN_BUDGET = 64 * 1024 * 1024`）。

- 顺序：persistence 折叠 →（`scanFallback && sessionsDir`）目录兜底。
- 候选：目录 id **不在**本轮 persistence 列表、且（索引里没有它的成功条目 或 签名变了）。
  列表里的会话即使读失败也不交给兜底（避免同一会话两条路径各折一次）。
- 签名未变的兜底会话：跳过，不读文件。
- 文件变长（追加）：`cut = max(fallbackCut, previous.lastSeq + 1)`，只折新尾巴。
- 文件变短（`maxSeq < previous.lastSeq`）：不折、`scanFailed += 1`（被重写/压缩，增量语义已不可信）。
- 预算：本轮累计读取字节超过 `scanBudgetBytes` 即停，不再读后续文件，`scanDeferred` = 未处理的候选数。
- 每处理一个文件 `await setImmediate` 让出主线程；单文件失败不中断整轮。
- 返回值在原字段（`ok/skipped?/sessions/indexed/failed/unknownModel/skippedOld/durationMs`）后追加：
  `scanned`（枚举到的日志数）、`rescued`（本轮折进的兜底会话数）、`scanFailed`、`scanDeferred`、`scanSkipped?`（`"no-zstd"` / `"no-dir"`）。

## 2. 宿主（`lib/index.js`）

### 2.1 `ensureUsageIndexLoaded(config)`

- `usageIndex !== null` → 直接返回；否则 `usageIndexFile = usageIndexFileOf(config)`、
  `usageIndex = loadUsageIndex(file, { retentionDays: clampBackfillDays(config?.usageBackfillDays) })`。
- `buildUsageSnapshot` 在 `enabled && !liveOnly` 时、算 `base` 之前调用它；`runUsageSync` 原有加载分支保留（幂等）。
- 语义：重启后首个 `/usage` 直接读盘出数，**不依赖**首轮 20 秒定时同步；`refreshing` 仍只表示真有一轮同步在飞。

### 2.2 `buildUsageSnapshot` 的 `coverage`

```json
{ "sessions": 217, "indexed": 217, "failed": 0, "unknownModel": 0, "skippedOld": 0,
  "scanned": 217, "rescued": 2, "scanFailed": 0, "scanDeferred": 0 }
```

- `sessions`：有本轮结果取 `result.sessions`；没有则回落 `Object.keys(usageIndex.sessions).length`（**不再写 0**）。
- 新四键取 `usageSyncResult`，缺省 0；不出现 `scanSkipped`（那是内部诊断）。
- 键序：既有 5 键在前，新 4 键追加在后。

### 2.3 配置（DEFAULTS）

- `usageScanFallback: true` —— 关掉 = 不做目录兜底扫描（索引只折 persistence 列表）。
- `usageScanPath: "$DSH_HOME/sessions"` —— 会话日志根目录（`~` / `$DSH_HOME` 前缀按既有一致规则展开）。

### 2.4 `__internals` 追加导出

`decodeSessionLog`、`parseSessionEvents`、`fallbackCutOf`、`fallbackLogsOf`、`fallbackSignature`、`ensureUsageIndexLoaded`、`FALLBACK_SCAN_BUDGET`。

## 3. 客户端（`lib/client.js`）

- 脚注区（官方对照条下方、既有「仅统计本机」脚注同一块）在 `coverage.rescued > 0` 时追加一行：
  - zh：`另有 {n} 个会话不在宿主的会话列表里，已按日志目录补扫。`
  - en：`{n} more session(s) were not in the host list and were recovered from the log directory.`
- 该行带 `data-usage-rescued="<n>"`；`rescued` 缺失或 0 → 不渲染（既有截图与布局不变）。
- `{n}` 用既有千分位格式化函数；文案禁 `%` 与 `Credits`。i18n 新键：`usageScanRescued`（zh/en）。

## 4. 边界

- 不新增出站主机（仍 8 条），不读 `.credentials.yaml`，不写日志目录（只读）。
- 索引 schema 不变：`top`/`sessions`/`days`/`stats` 及键白名单原样，`revision` 允许 `file:` 前缀。
- 响应与工具输出不含文件路径、会话标题、消息文本。
- `sessions` 与 `indexed` 的口径不变：都是「宿主过滤后本机有日志的会话」，兜底之后二者仍相等（本机实测 217/217）。
