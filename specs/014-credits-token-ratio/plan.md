# 014 计划：Credits ↔ tokens 换算

## 1. 现状盘点

| 已知 | 位置 |
|---|---|
| 控制台卡：meters[{key,label,total,remaining,used,usedPercent,remainingPercent,resetAt}] | `lib/index.js` `buildConsoleCard` + `finalize/normalize` |
| 官方 token 明细：`buildOfficialUsageSnapshot(config, ctx, query, {fresh})`，5 分钟缓存，`coverage.clampedFrom` | `lib/index.js` |
| 本机用量：`buildUsageSnapshot(config, ctx, query)` | `lib/index.js` |
| 路由：prefix `/token-plan-quota`，sub ∈ summary/refresh/reset/usage/usage-official/probe | `lib/index.js` 路由表 |
| 客户端：用量屏 `UsageScreen`，官方块 `usageOfficialSection`，取数 `fetchOfficial`（序号 + Abort + 15s） | `lib/client.js` |
| 日键：`dayKey(ms)`（本地时区） | `lib/usage-stats.js` |

## 2. 为什么不做「任意区间换算」

Credits 只有当前账期的已用比例，官方不提供历史账期的读数；按区间等比例拆分是**估算**，违反宪法口径。
因此换算只在「当前账期」这一固定窗口给，且与上方查询区间解耦。

## 3. 为什么比值必须是「混合口径」

同一个账期里 Credits 由模型、输入/输出/缓存 token、内置工具共同消耗（官方文档未给换算表）。
把官方 tokens 总量除以 Credits 得到的是**这段时间的混合均值**；缓存命中率高时比值会被抬高。
所以脚注必须写清：它不是固定兑换率，换模型/换缓存命中率就会变。

## 4. 实现分解

1. 宿主（`lib/index.js`）
   - `creditsCycleOf(card, now)`：账期窗口推导 + 读数校验（纯函数，`now` 可注入）。
   - `creditsTokenRatioOf(tokens, used)`：比值（非有限 / ≤0 → null）。
   - `composeCreditsToken({card, official, localTotals, now})`：把上面两块 + 官方明细拼成响应（纯函数，测试主入口）。
   - `buildCreditsTokenSnapshot(config, ctx, {fresh})`：IO 编排（`buildStatus` → 取卡 → `buildOfficialUsageSnapshot` →
     `buildUsageSnapshot` 取本机参考值 → `composeCreditsToken`）。
   - 路由 `GET /token-plan-quota/usage-credits`（只读，`fresh=1` 透传），404 路由表登记。
2. 客户端（`lib/client.js`）
   - `USAGE_CREDITS` 常量 + `fetchCredits`（独立状态槽/序号/Abort/15s，不随查询区间重取）。
   - `usageCreditsSection(copy, credits, onRetry, stale)`，插在官方对照块之后。
   - 9 个 COPY 键（zh/en）+ CSS 一节。
3. 测试：`test/host.mjs`（纯函数与组合）、`test/client.mjs`（渲染/状态/双语/格式）、`test/guards.mjs` 第 14 节（静态矩阵）。
4. 文档与图：README*、CHANGELOG、`scripts/check-docs.mjs`、截图场景 ⑯、`specs/014`。

## 5. 失败模式

| 失败 | 表现 | 处置 |
|---|---|---|
| Cookie 失效 | 卡片带 `errorCode=NoCredentials`/`NotLogined` | `console-unavailable` + 卡片 hint（zh） |
| 额度只有比例 | `meter.total` 缺失 | `no-credits-total`，不给比值 |
| 账期重置时间缺失 | `meter.resetAt` 缺失 | `no-reset-time` |
| 5 小时套餐 | 只有 `fiveHour` 计量 | `five-hour-only` |
| 官方明细最早日夹紧 | `coverage.clampedFrom` 存在 | `official-clamped`，不拿部分区间算 |
| 官方明细为空 | tokens ≤ 0 | `no-token-data` |
| 本机用量失败 | `tokens.local=null` | 不影响比值（本机只作参考行） |

## 6. 交付顺序

T001 宿主纯函数 → T002 宿主路由 → T003 客户端取数 → T004 客户端渲染 → T005 测试 →
T006 guards 第 14 节 → T007 文档与截图 → T008 门禁与提交。
