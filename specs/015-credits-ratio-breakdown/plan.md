# 015 计划：Credits 比值的分项与按模型拆分

## 1. 现状盘点

| 已知 | 位置 |
|---|---|
| 014 换算块响应：`ratio{tokensPerCredit,capacityTokens}` | `lib/index.js` `composeCreditsToken` |
| 官方明细：只有 totals（tokens/input/cacheRead/output）+ 按天 buckets，**无模型维度** | `lib/index.js` 的 `buildOfficialUsageSnapshot`、`lib/official-usage.js` 的 `buildOfficialUsage` |
| 本机按模型：`models[]{id,provider,model,totals{input,output,cacheRead,cacheWrite,calls,tokens}}` | `lib/usage-stats.js` 的 `aggregateUsageRange` |
| 本机 tokens = input+cacheRead+output+cacheWrite；官方 tokens = input+output（input 含 cacheRead） | 2026-11-14 实测 |
| 客户端换算块：`usageCreditsSection`，5 行 + 独立 section | `lib/client.js` 的 `usageCreditsSection` |
| 百分比白名单段 `usagePercentText` | `lib/client.js` §「012 比例白名单段」 |

## 2. 为什么模型行只能是「贡献口径」

官方只给账号级总量与按天曲线；按模型拆必须知道每个模型的 Credits 单价，官方未公开。
把已用 Credits 按 tokens 比例分摊给各模型，则每行比值恒等于总比值——信息量为零，却是**伪造的精确**。
因此模型行固定为「本机该模型 tokens ÷ 本账期已用 Credits」，并在屏内与 README 明写：
分子本机、分母账号级、属于贡献值，各行相加 ≈ 本机总量（官方账号总量），差额来自其他设备。

## 3. 实现分解

1. 宿主（`lib/index.js`）
   - `creditsClassRatios(officialTotals, used)`：官方三类 tokens + perCredit（纯函数，`__internals` 导出）。
   - `creditsModelRatios(localModels, used)`：本机模型 → `{id,provider,model,tokens,calls,tokensPerCredit}`（纯函数）。
   - `composeCreditsToken` 的 `available` 态加 `ratio.classes`、`ratio.models`、`ratio.modelsBasis:"local"`；
     本机用量不可读时 `models: []`，`classes` 照给（官方侧有数据）。
   - 路由不变（同一 `GET /token-plan-quota/usage-credits`），`buildCreditsTokenSnapshot` 把本机 `models` 透传进 compose。
2. 客户端（`lib/client.js`）
   - `usageCreditsClassesLine(copy, classes)` 与 `usageCreditsModelsBlock(copy, models)` 两个渲染 helper；
   - `usageCreditsSection` ready 态在 detail 之后插分项行、在 estimate 之后插模型块；
   - COPY 增 4 键、改 1 键（note 补分项口径）；CSS 一节（模型块内滚动 252px）。
3. 测试：`test/host.mjs`（纯函数 + 组合 + 边界）、`test/client.mjs`（渲染/降级/双语/数字）、`test/guards.mjs` 第 15 节。
4. 文档与图：README*（用量统计节）、CHANGELOG、`specs/015`、场景 ⑯ 扩展并重拍中英两图。

## 4. 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| 官方 `cacheRead > input`（异常上游） | 未命中输入为负 | `max(0, input-cacheRead)`，测试钉住 |
| 官方缺 cacheRead / output | 字段 undefined | 按 0 计入，不产出 NaN |
| 本机用量读不到 | `localTotals=null` | `models: []`，客户端不渲染模型块 |
| 模型 tokens 为 0 | 空行 | 过滤掉 |
| 旧宿主不返回新字段 | 客户端拿到 undefined | 不渲染、不报错（FR-006） |
| Credits 已用为 0 | 014 更早已短路（`no-token-data`） | 不进入 available 态 |
| 模型极多 | 块被撑高 | 模型块内滚动 252px（FR-010） |

## 5. 交付顺序

T001 宿主纯函数 → T002 宿主组合与透传 → T003 宿主测试 → T004 客户端分项行 → T005 客户端模型块 →
T006 客户端测试 → T007 guards 第 15 节 → T008 截图与文档 → T009 门禁与提交。

## 6. 备选与取舍

- **不做「按模型分摊 Credits」**：分摊需要假设单价，等于估算；宁可标注贡献口径。
- **不在模型行加 012 的占比/命中率**：012 的模型卡已经给，重复会让两块互相矛盾（区间也可能不同）。
- **分项只给官方口径**：本机口径的四类边界与官方不同（input 是否含 cacheRead），混用会得出「分项相加 ≠ 总量」。
  因此分项只取官方三类；本机口径只在模型行的分子上以总量形式出现。

