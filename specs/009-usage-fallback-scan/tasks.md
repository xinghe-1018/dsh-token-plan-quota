# TASKS — 009 兜底目录扫描 + 重启即可见

- [x] T001 `lib/usage-stats.js`：`decodeSessionLog` / `parseSessionEvents` / `fallbackCutOf` / `fallbackLogsOf` / `fallbackSignature` 五个纯函数（零联网、只读文件、zstd 能力缺失时降级）。
- [x] T002 `lib/usage-stats.js`：`syncUsageIndex` 接 `sessionsDir` / `scanFallback` / `scanBudgetBytes`，返回 `scanned`/`rescued`/`scanFailed`/`scanDeferred`/`scanSkipped`；候选集排除 persistence 列表；签名幂等；追加/变短两种分支；64 MB 预算 + 逐文件让出。
- [x] T003 `lib/index.js`：`ensureUsageIndexLoaded` 懒加载；`buildUsageSnapshot` 用它并在无同步结果时回落 `coverage.sessions`；`coverage` 追加四键；DEFAULTS 加 `usageScanFallback`/`usageScanPath`；`runUsageSync` 传目录；`__internals` 追加导出。
- [x] T004 `test/host.mjs`：T001/T002 的纯函数与全链路断言（合成多帧 zstd、隐藏会话补扫、幂等、追加、变短、预算、seeded、重启懒加载）。
- [x] T005 `lib/client.js` + `test/client.mjs`：`rescued > 0` 脚注行 + i18n 两键 + 断言（含 zh/en 无 `%`/`Credits`、0 不渲染）。
- [x] T006 `test/guards.mjs`：009 静态矩阵（新段无联网/无写入/无凭据词、DEFAULTS 两键、出站主机仍 8 条）。
- [x] T007 文档：`README.md` / `README.en.md`（兜底扫描 + 重启即可见 + 配置表两行 + coverage 四键）、`CHANGELOG.md`、`docs/upstream-contracts.md`（会话日志：多帧 zstd / 目录命名 / `session/end-seed {inherited:true}` 契约）、`scripts/check-docs.mjs` 计数。
- [x] T008 真实实例验证 + 门禁：重启后首个 `/usage` 非零；补扫后 `sessions` 215→217、总账 tokens 增加约 6,500 万（多属 9 月，10 月约 +640 万）；`npm run check` 七步全绿；四个中文 Conventional Commits 提交。
