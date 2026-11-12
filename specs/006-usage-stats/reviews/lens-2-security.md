# 评审 · Lens 2 — 安全与隐私（006 用量统计）

- **对象**：`lib/usage-stats.js`、`lib/index.js` 用量路由、`lib/client.js` 用量屏
- **结论**：高危 0 条；低 2 条；门禁缺口 1 条。**全部已处置**。

## 发现与处置

| 编号 | 严重度 | 现象 | 处置 |
|---|---|---|---|
| L2-1 | 低 | 宿主 500 兜底把 `error.message` 原样回给浏览器，客户端再 `String(error)` 上屏——当前分支是纯计算，但一旦将来读盘/序列化失败，message 可能带索引路径或 IPC 细节 | **两端同时收口**：宿主 `/usage` 分支单独 try/catch，日志用 `logger.warn` 记录原因、响应固定 `{ error: "usage-unavailable" }`；客户端只把 `code` 当机器码，仅 `usage-stats-disabled` 显示专属句，其余一律本地化通用文案 |
| L2-2 | 低 | 客户端 i18n 漏 `no-sessions`（en 语义丢失，会误导排查方向） | 同 Lens 1 的 L1-8 |
| G-1 | 门禁缺口 | 静态矩阵只覆盖 `lib/usage-stats.js` 与 `lib/index.js`，客户端用量屏若写出 `%` 或「Credits」两套测试都不会红 | **已补**：`test/guards.mjs` 切出「`function UsageScreen` 到文件尾」的 `clientUsageRegion`，断言 `%` 命中 0、`credit` 只出现在「不折算 Credits」那一行；另单独切「`openUsagePanel` → `usagePanelActive`」段断言含 `selectPanel(null)` |

## 未发现问题（核过并留证）

- **注入面**：客户端全文件无 `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function`；唯一 `fetch` 走相对路径 + `credentials: "same-origin"` + `cache: "no-store"` + 无 body；宿主字符串（`model.id`、`bucket.label`、`source.label`、错误码）只作文本节点 / `title` / `aria-label`。
- **数据面**：`/usage` 只回聚合数字、日期、模型 id、覆盖计数；落盘索引是白名单 JSON（`version`/`updatedAt`/`stats`/`sessions(id,revision,lastSeq,cut)`/`days`），**没有消息文本、请求头、Cookie、文件路径**；坏文件备份成 `.bad-<毫秒>` 再重建。
- **越权面**：路由沿用既有 `sameOriginOnly`（真机实测带 `Origin: http://evil.example` → 403 `cross-origin-denied`），`/usage` 只接受 GET（POST → 405 `method-not-allowed`）。
- **日志**：客户端无 `console.*`；宿主日志文案不含 payload 内容。
- **出站主机**：本轮新增零出站（数据全部来自本地会话日志），`check-manifest` 仍报 8 个声明主机。
