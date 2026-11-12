# 评审 · Lens 3 — 计划一致性（006 用量统计）

- **对照物**：`specs/006-usage-stats/spec.md`（FR-001..FR-008、SC-001..SC-007）、`plan.md`（§5.3 数据源、§5.4 响应形状、§5.5 挂载面、§5.6 天数）、`INTERFACE.md`（唯一接口真值）、`tasks.md`
- **结论**：无实质偏离；登记 4 处"实现正确但需留痕"的取舍，均已写进 INTERFACE 或注释。

## 逐项核对

| 项 | 计划要求 | 实现 | 结论 |
|---|---|---|---|
| 数据源 | sessionPersistence 离线折叠；缺失时降级 | `lib/usage-stats.js` 纯函数 fold + 增量 revision/lastSeq；无持久化退 `in-process`，关闭退 `disabled` | 一致 |
| 响应形状 | `generatedAt/range/granularity/totals/buckets/models/source/coverage` | 逐字段一致；`buckets` 升序、缺失日/周补 0 | 一致 |
| 查询参数 | `?range=today|7d|30d|90d` 或 `?days=N`，1..365 优先 | 一致；`days` 优先并夹紧，非法值回落 7，未知 range 回落默认 | 一致 |
| 桶粒度 | >62 天按本地周一为界周聚合 | 一致；首末桶可不足 7 天，365 天 = 53 个周桶 | 一致（用例 10 已按此改写） |
| 挂载面 | 宿主 `main` 整页座位 + `sidebar.panellist` 常驻入口 + 徽标小窗 | 一致；`PANEL_ID = "token-plan-quota.usage"`；`store = {...handle, create: () => instance}`；关闭走 `selectPanel(null)` | 一致 |
| 缺座降级 | 无 `slots` / 无 `layout` / 无 `main` 时不留半死入口 | 三路径各自 warn 并退回徽标小窗 | 一致 |
| 图表 | 2D/3D 共用线性比例；3D 为 SVG 等轴投影、固定角度、无透视 | 共用 `barRatio` 与 `PLOT_H`；三面用主色 + 两档明度（`color-mix` 78%），逐柱断言 2D/3D 高度相等 | 一致 |
| 口径 | 只报绝对 token；不折算 Credits、无百分比、不估算余量 | 端点与屏内都只有绝对数；脚注写明「实测，不是官方余额」 | 一致 |
| 配置 | `usageStats` / `usageIndexPath` / `usageBackfillDays` | 一致；`usageStats=false` 时入口保留、屏内写明已关闭与配置键 | 一致 |
| 测试 | 折叠 / 路由 / 客户端 / 静态矩阵 | host 600、client 407、guards 198 | 一致 |

## 登记的取舍（不构成偏离）

1. `main` 座位的 `inject` 返回 `{}`，而 plan §5.5 的示例写 `() => ({ close })`。按"冲突以 INTERFACE 为准"，实现取 `{}`；关闭走模块级 `closeUsagePanel`，不依赖座位 props。
2. 注册 `main` 时未传 `locale` 命名空间（插件管理页先例传了）。locale 由 `pickLocale()` 从 `<html lang>` 每次取，行为正确，仅与官方写法不同。
3. 三处「宿主保活组件实例」注释与宿主 keyed 渲染事实不符，**已改注释**并写明"将来若改保活渲染需订阅 `panelInfo` 转前台补拉"。
4. `selectPanel(null)` 落在 `closeUsagePanel` 而不是 `UsageScreen` 区间内，静态矩阵因此分两段扫（`UsageScreen`→文件尾判 %/Credits/register，`openUsagePanel`→`usagePanelActive` 判关闭）。这是位置的客观事实，不是放宽判据：两段都有非空长度校验。

## 计划文件的修订（本相位之前）

- `spec.md` SC-007 由"90 天以上"改为"超过 62 天（周一起界）"——与 FR-003 的桶粒度一致。
- `plan.md` 前提 10 换成已核实的整页座位证据；新增前提 11「3D 无需三维库」。
- `plan.md` 用例 10 改为固定 `now` 下的桶数断言（63 天 10 周桶、365 天 53 周桶）。
- `INTERFACE.md` §2 在真机验证后收紧 `refreshing` 的定义（只表示"同步在飞"），并明确"错误态与其余三态互斥"、`no-sessions` 空态、`/usage` 异常固定 `usage-unavailable`。
