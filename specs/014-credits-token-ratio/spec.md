# 014 规格：Credits 与 tokens 的换算对比

## 背景

用户 m04781 先问「官方侧的那个也加上和上面一样的按时间查询」，在给出三选一后自答：
「加一个对比吧，就是 credits 和 token 的转换，看看是几比几」。

现状（已核，2026-11-14）：

- 官方侧只有三个**固定窗口**的已用比例（`per1MonthPercentage` / `per1WeekPercentage` / `per5HourPercentage`），
  绝对量要靠「官方档位额度 × 比例」推，单位写死 Credits（`lib/index.js` `buildConsoleCard`）。
- 官方账号级 token 明细（`/token-plan-quota/usage-official`）支持任意区间，但只回 tokens，不回 Credits。
- 两条口径都是**账号级**（含其他设备），这是它们能相除的前提。
- 官方文档口径：Credits 消耗随模型、输入/输出/缓存 token 与内置工具调用变化，**没有单一固定兑换率**
  （平台 Token Plan 概述页 https://platform.qianwenai.com/docs/token-plan/overview，标题「Token Plan 概述」，
  「以 Credits 统一计量」；具体换算表官方未公开）。因此本功能只报**实测混合比值**，不宣称固定兑换率。

## 目标

在用量统计屏新增一块「Credits 与 tokens 换算」，把**同一个官方账期窗口**里两侧的官方读数并排给出来，
并给出本账期实测比值（`1 Credit ≈ N tokens`，等价写法 `1 : N`）。

非目标：不换算货币、不预测剩余可用 tokens 的官方值、不按任意查询区间换算（Credits 只有当前账期一个读数）。

## 功能需求

- FR-001 账期窗口自动推导：优先 `monthly` 计量（`resetAt` 往前一个自然月 → 今天），只有 `weekly` 时退到它
  （`resetAt` 往前 7 天 → 今天）；只有 `fiveHour` 计量时**不给比值**，显式说明 5 小时窗口无法与按天口径的
  token 明细对齐。
- FR-002 已用 Credits = 官方档位额度 × 官方已用比例（与订阅页「剩余量/总额度」同源）；比例是官方原值，
  宿主不二次取整；额度缺失（只有比例、没有分母）时**不给比值**。
- FR-003 比值分子 = 官方账号级 tokens（`usage-official` 的 `totals.tokens`，口径同官方对照块：
  输入侧已含缓存读取，不与 cacheRead 相加），分母 = 本账期已用 Credits；两者区间一致（账期起 → 今天）。
- FR-004 三个数字都要上屏：官方 tokens、已用 Credits / 额度、官方已用比例；比值与它们同屏，可自行复核。
- FR-005 不可用必须显式解释，且**不用本机 tokens 顶替官方 tokens**、不用部分区间凑比值：
  官方明细被夹紧（`coverage.clampedFrom`）、token 为 0、Cookie 失效、官方开关关闭、缺额度、缺重置时间
  各自给固定原因码 + 中文可操作提示（英文界面只显通用文案，不透传中文 hint）。
- FR-006 折算参考行（额度总量按本账期比值约合多少 tokens）必须标注「折算参考，非官方口径」，
  并说明它假设同一种模型与缓存命中率。
- FR-007 双语：中文模板中文、英文模板英文；数字格式沿用 `formatTokens`（万/亿/M/B）与 `usageCount`（千分位）。
- FR-008 零新增：不加配置键、不加出站主机、不加凭据引用、不引第三方依赖。
- FR-009 屏内不出现货币金额、不出现配额百分比（官方已用比例本身除外，且只能由 012 的
  `usagePercentText` 产出）。
- FR-010 该块**不随上方查询区间变化**：Credits 只有当前账期一个读数，换区间不会让换算更准，
  所以只在首次打开、点刷新/重试时取一次（`fresh=1` 强制回源）。

## 验收标准

- SC-001 `creditsCycleOf`：`resetAt=2026-12-01T00:00+08`、`now=2026-11-14` →
  `from=2026-11-01`、`to=2026-11-14`、`cycleDays=30`、`elapsedDays=14`；weekly 计量 → `from=resetAt-7d`。
- SC-002 比值：`tokens=2122918870`、`used=37196.8802` → `tokensPerCredit≈57072`（±0.5）；
  `capacityTokens=round(ratio×80000)=4565760000` 量级。
- SC-003 不可用原因逐条覆盖（`five-hour-only` / `no-credits-total` / `no-reset-time` /
  `official-clamped` / `no-token-data` / `console-unavailable`），每条都有屏上文案。
- SC-004 英文界面下该块无中文、无「万/亿」后缀。
- SC-005 门禁：`npm run check` 七步全绿，README 声称的用例数与实跑一致。

## 依据与证据分级

- **官方文档**：Credits 是统一计量单位、换算随模型/输入输出缓存变化（平台 Token Plan 概述页；页面 JS 渲染，
  只有标题与描述可静态取到，细则以平台页面为准）。
- **本机源码**：`lib/index.js` `buildConsoleCard`（meters / used / usedPercent / resetAt）、
  `buildOfficialUsageSnapshot`（官方 token 明细与 `clampedFrom`）。
- **实测（2026-11-14 运行态）**：summary 里 `token-plan-console` 卡 `total=80000`、
  `used=37196.8802`、`usedPercent=46.4961`、`resetAt=1796054400000`（2026-12-01 00:00 +08）；
  `/usage-official?from=2026-11-01&to=2026-11-13` `totals.tokens=2122918870`。
  两者相除 ≈ 57,072 tokens/Credit。
- **未覆盖（不猜）**：官方按模型/缓存的实际 Credits 单价表；5 小时窗口对应的 token 区间。
