# 015 规格：Credits 比值的分项与按模型拆分

## 背景

用户 m05169：「这个比值加上每个模型单独的比值，还有单独的缓存命中，输入，输出的比值」。

现状（已核，2026-11-14）：

- 014 的换算块只有**一个**总量比值：官方账号 tokens ÷ 本账期已用 Credits（`1 Credit ≈ 57072 tokens`）。
- 官方 token 明细**没有按模型拆分**：请求里 `metricFilters` 只有一条 `{aggMethod:"sum", metricName:"model_usage"}`（`lib/index.js` 的 `metricFilters`），
  `buildOfficialUsage` 只出 `totals` 与按天 `buckets`（`lib/official-usage.js` 的 `buildOfficialUsage`）。
- 本机用量**有**按模型聚合：`aggregateUsageRange` 的 `models[]`（`lib/usage-stats.js` 的 `aggregateUsageRange`）。
- 官方 totals 口径：`tokens = input + output`，其中 **input 含 cacheRead**（2026-11-01..13 实测：tokens 2,122,918,870
  = input 2,112,709,710 + output 10,209,160，cacheRead 2,039,167,232 在 input 之内）。
- 本机 totals 口径：`tokens = input + cacheRead + output + cacheWrite`，其中 **input 不含 cacheRead**
  （同区间实测：tokens 2,080,883,520 = 67,721,552 + 2,004,226,560 + 8,935,408 + 0）。

⇒ 两条口径在数量上是同一批量（未命中输入 + 缓存命中 + 输出 + 缓存写入），只是「input」的边界不同。
这是本规格做「分项比值」的基础。

## 目标

在 014 换算块里补两类比值：

1. **分项比值**：把官方 tokens 拆成缓存命中 / 未命中输入 / 输出三类，各自给「每 Credit 多少 tokens」；
2. **按模型比值**：每个模型各自「每 Credit 多少 tokens」（本机口径，见 FR-004 的口径声明）。

非目标：

- 不给「每个模型消耗了多少 Credits」：官方不提供按模型拆分，按比例分摊会让每行都等于总比值，属于假精确。
- 不做历史账期（Credits 只有当前账期一个读数，014 FR-010 不变）。
- 不重复 012 已给的「模型占比 / 命中率」（那是构成比，不是 Credits 比值）。

## 功能需求

- FR-001 分项比值只出现在 `available` 态；三类 tokens 都取官方口径：`uncachedInput = max(0, official.input - official.cacheRead)`、
  `cacheRead = official.cacheRead`、`output = official.output`；三者相加在正常数据下必须**精确等于** `official.tokens`。
- FR-002 每类 `perCredit = 该类 tokens ÷ credits.used`，不取整（格式化交给客户端 `formatTokens`）；
  三类 `perCredit` 相加约等于总量比值（差异只来自浮点与显示取整）。
- FR-003 按模型比值：`ratio.models[]` 每项 `{id, provider, model, tokens, calls, tokensPerCredit}`，
  数据取自本机同一账期窗口的 `models[]`；`tokensPerCredit = tokens ÷ credits.used`；只收 `tokens > 0` 的模型，按 tokens 降序。
- FR-004 口径必须显式标注：模型行分子是**本机** tokens、分母是**账号级**已用 Credits，属于贡献值，不是官方兑换率；
  屏内脚注写清「官方不按模型拆分」与「各行相加 ≈ 本机总量，与账号级官方总量有少量差额」。
- FR-005 分项与模型都不改变总量行：`ratio.tokensPerCredit` 与 `ratio.capacityTokens` 仍是唯一官方口径的「1 Credit ≈ N」。
- FR-006 降级：宿主没给 `classes` / `models`（旧宿主，或本机用量读不到）时客户端**不渲染**对应区块，
  其余照旧；不报错、不显示 0 占位、不显示 `—`。
- FR-007 双语：新增文案中英各一套；数字格式沿用 `formatTokens`（万/亿/M/B）；英文界面不出现汉字与「万/亿」。
- FR-008 零新增：不加路由、不加查询参数、不加配置键、不加出站主机、不加第三方依赖
  （只在 `GET /token-plan-quota/usage-credits` 的响应里加字段）。
- FR-009 百分比白名单不变：本块仍不手拼百分比（014 只用 `usagePercentText` 产出已用比例），本次不新增百分比。
- FR-010 模型列表在块内自带滚动（约 5 行高、细滚动条、键盘可聚焦滚动），不把整块撑高。

## 验收标准

- SC-001 分项：官方 `{tokens:2122918870, input:2112709710, cacheRead:2039167232, output:10209160}`、`used=37196.8802` →
  `uncachedInput.perCredit=1977.11`、`cacheRead.perCredit=54820.92`、`output.perCredit=274.46`（±0.01），三者 tokens 之和 = 2122918870。
- SC-002 模型行：fixture 两个模型 tokens 13.13 亿 / 3.50 亿 → `tokensPerCredit` 分别约 35305 / 9419；顺序按 tokens 降序。
- SC-003 降级：`ratio` 无 `classes`/`models` 时块内仍是 014 的五行，无新钩子、无异常。
- SC-004 口径可核：屏内能读到「未命中输入」与「官方不按模型拆分」的说明文字。
- SC-005 英文界面：无汉字、无「万/亿」，`uncached input` 与 `Ratio per model` 逐字出现。
- SC-006 门禁：`npm run check` 七步全绿，README 声称的用例数与实跑一致。

## 依据与证据分级

- **本机源码**：`lib/index.js` 的 `metricFilters`、`lib/official-usage.js` 的 `buildOfficialUsage`（官方 totals
  无模型维度）、`lib/usage-stats.js` 的 `aggregateUsageRange`（本机 models）、`lib/index.js` 的
  `composeCreditsToken`（014 的 compose）。
- **实测**（2026-11-14，运行态 `127.0.0.1:57554`）：同区间官方与本机 totals 见背景；`credits.used=37196.8802`（46.4961% × 80000）。
- **官方文档**：Credits 随模型/输入输出/缓存变化、无公开换算表（`https://platform.qianwenai.com/docs/token-plan/overview`）。
- **推断**：模型行比值随模型不同，是因为各类 token 占比与单价不同；本插件只报实测比值，不解释成因。
