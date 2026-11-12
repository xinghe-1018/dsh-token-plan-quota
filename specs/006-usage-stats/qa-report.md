# QA-REPORT — 006 用量统计（绝对 token）

- **日期**：2026-11-13
- **计划**：`specs/006-usage-stats/plan.md`；接口真值：`specs/006-usage-stats/INTERFACE.md`
- **评审报告**：`reviews/lens-1-correctness.md`、`lens-2-security.md`、`lens-3-plan-conformance.md`
- **最后一轮全量门禁**：`npm run check` 七步全绿（原始输出见 §5）

## 0. 这次的产品面

新增一块**整页用量屏**（替换会话主区、侧栏保留）+ 侧栏常驻入口 + 徽标小窗入口：把本机会话日志离线折叠成
按本地日分桶的绝对 token 用量，按 2D / 3D 柱状图呈现，天数可选（今日 / 7 / 30 / 90 / 自填 1..365，>62 天按周聚合）。
口径是"**本实例实测**"：不是官方余额、不是 Credits、没有百分比。

## 1. 功能 QA（真实端点与真实实例）

测法：真桌面实例（dsh 0.2.2-rc.1）上直接打宿主只读路由。

| # | 场景 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| 1 | `GET /usage?days=7` | 200，7 个日桶 | 200 / 24ms / `buckets=7` / `tokens=494,623,759` | 通过 |
| 2 | `GET /usage?range=today` | 200，1 个桶 | 200 / `buckets=1` / `tokens=105,050,928` | 通过 |
| 3 | `GET /usage?days=365` | 200，周桶，起点约一年前 | 200 / `granularity=week` / 53 桶 / `from=2025-11-14` / `tokens=6,017,778,297` | 通过 |
| 4 | 边界夹紧 | 400 天→365、0→1、`abc`→7 | 三种都按预期夹紧 / 回落 | 通过 |
| 5 | 三条恒等式 | 总分 = 桶和 = 模型和；`calls` = `steps` | 365 天下 `totals.calls = 23,858 = sum(buckets.calls) = sum(models.calls)`；`tokens` 等式成立 | 通过 |
| 6 | 覆盖信息 | 会话数 / 已索引 / 失败 / 未识别模型 | `{sessions:214, indexed:214, failed:0, unknownModel:62..76, skippedOld:0}` | 通过 |
| 7 | 跨源拒绝 | 带外部 Origin → 403 | `{"error":"cross-origin-denied"}` | 通过 |
| 8 | 方法限制 | POST /usage → 405 | `{"error":"method-not-allowed"}` | 通过 |
| 9 | 首轮回填成本 | 空索引到可用，量级可接受 | 215 个会话 / 211MB 原始日志，裸解码 19.8s；插件路径（含 zstd 解帧与折叠）后台跑，期间屏上是进度条不是空白 | 通过（SC-003 判定为可接受） |
| 10 | 索引落盘形态 | 白名单，无文本/路径/凭据 | 71,896 B，顶层 `[version,updatedAt,sessions,days,stats]`；`sessions` 214 条只有 `id/revision/lastSeq/cut` | 通过 |
| 11 | 坏索引文件 | 备份成 `.bad-<毫秒>` 后重建，不崩 | 单测覆盖（`test/host.mjs` 破坏 JSON 用例） | 通过 |

### 1.1 折叠正确性（独立反证，非自证）

用**不依赖插件代码**的脚本按 zstd 帧切分解压全部会话日志、逐条累加 `assistant/message` 的 usage，与索引逐日对比：

- 独立结果：26,563 calls / 6,729,880,647 tokens（71 个本地日）。
- 插件索引：23,858 calls / 6,017,778,297 tokens（同区间）。
- 12 天有差，其余**逐 token 完全相等**；最大一个续写会话的前缀 566,616,243 tokens 与"09-06~09-10 四天差额合计 611M"对得上。
- 判定：差额来自**继承前缀被正确跳过**（不重复计），另有 2 个目录未被宿主列举（合计 65M）属可见面限制。**插件这一侧没有编造数字**。

## 2. 视觉 QA（造图机，不截真实实例）

真实实例的余额、用户名、盘符不能进 git，所以截图全部由 `scripts/shots/make-shots.mjs` 用 fixture 合成：

| # | 图 | 检查点 | 结论 |
|---|---|---|---|
| 1 | `docs/images/usage-2d.png` | 标题/副标题/总分与四拆/7 根柱/最高柱标值/3 个模型/脚注 | 通过 |
| 2 | `docs/images/usage-3d.png` | 同一数据切 3D：总分与桶数与 2D **逐字一致**，三面等轴、无透视 | 通过 |
| 3 | `docs/images/en/usage-2d.png`、`en/usage-3d.png` | 英文页**0 个汉字**、脚注英文、无宿主中文 label | 通过 |
| 4 | fixture 白名单 | 禁 `%`、禁 Credits、禁真实痕迹（用户名/盘符/`.dsh`） | 通过（6 个 pattern 0 命中） |
| 5 | 座位宽度 | 整页座位占视口 ≥60%（不是浮层） | 通过（1280 下 920px） |
| 6 | `375px` 窄视口 | 无横向溢出 | 通过（`scrollWidth == clientWidth == 375`） |
| 7 | 四状态 | 骨架 / 错误 / 空 / 内容互斥；错误态无数据卡 | 通过（客户端断言 + 渲染自检） |
| 8 | 切天降级 | 新快照未回时标题仍按旧快照、数据卡半透明，不出现"近 30 天 + 7 根柱" | 通过 |

## 3. 安全与合规

- 只读端点、同源限制、GET-only（§1 第 7、8 条）。
- 索引落盘白名单；无消息文本、请求头、Cookie、文件路径。
- 新增零出站主机（数据全来自本地日志），`check-manifest` 仍报 8 个。
- 宿主 500 固定 `usage-unavailable`，客户端不回显宿主原文。

## 4. 未覆盖 / 已知边界（不猜）

- **旧宿主（0.1.x）的 persistence 形状**不可在本机复现：快照双形态、`revision` 类型不固定、`inheritedEventCount`
  三级兜底都由单测按形状构造验证，并以 `@gehennawu/dsh-service` 的实现逐行对照，**没有**跑过真实的 0.1.x 宿主。
- `refreshing` 在响应生成时判定：踢同步的那次响应仍是 `false`，客户端靠 30s 轮询在下一拍看到 `true`（约一拍延迟）。
- 回填期间的失败会在下一轮重试，屏上只写"部分会话读取失败"，不逐条列会话。
- `parseDaysInput` 拒绝 `1e2`/`+5`/`-5`（契约留白，保持"正整数"语义）。

## 5. 门禁原始输出（最后一轮编辑之后）

```text
test/host.mjs                    600 passed, 0 failed
test/client.mjs                  407 passed, 0 failed
test/guards.mjs                  198 passed, 0 failed
check-manifest: OK（dsh-token-plan-quota 0.4.13，出站主机 8 个）
check-docs: OK（配置键 21、数据源 8、出站主机 8、host 600 项 / client 407 项 / guards 198 项，中英 README 与代码一致）
check-refs: OK（45 个活文档，无行号引用）
check-submission: OK（条目 data/plugins/xinghe-1018__dsh-token-plan-quota.yml，category=usage，en 424 字符内含 zh 双语描述，与 README 同源）
```

（一轮中间态：改完代码后 `check-docs` 曾报 6 条数字漂移 —— README 仍写 592/381/188；改 README 与 CHANGELOG 后重跑全绿。这条本身就是"数字漂了 CI 会红"的实证。）
