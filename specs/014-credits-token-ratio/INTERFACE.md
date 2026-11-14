# 014 接口契约（实现唯一真值）

## §1 路由

`GET /token-plan-quota/usage-credits`（同源；非 GET → 405；无需参数）

- `fresh=1`：跳过缓存（本机 status 与官方明细都回源）。
- 成功恒 200，两态由 `available` 区分；构建异常 → 500 `{ error: "credits-unavailable" }`。
- 响应不含凭据、Cookie、原始上游报文与文件路径。

### §1.1 可用态

```json
{
  "generatedAt": 1763,
  "available": true,
  "window": {
    "key": "monthly", "label": "本月账期", "labelEn": "Monthly cycle",
    "from": "2026-11-01", "to": "2026-11-14", "resetAt": 1796054400000,
    "resetDay": "2026-11-30", "cycleDays": 30, "elapsedDays": 14
  },
  "credits": { "unit": "Credits", "total": 80000, "used": 37196.8802, "usedPercent": 46.4961 },
  "tokens": { "official": 2122918870, "local": 2080883520 },
  "ratio": { "tokensPerCredit": 57072.3, "capacityTokens": 4565784000 },
  "scope": {
    "officialFrom": "2026-11-01", "officialTo": "2026-11-14", "officialDays": 14,
    "cached": false, "clampedFrom": null
  },
  "source": {
    "kind": "credits-token", "veracity": "measured",
    "label": "官方 Credits × 官方 tokens（本账期实测）",
    "labelEn": "Official credits × official tokens (measured this cycle)"
  }
}
```

字段规则：

- `window.from`：monthly → `resetAt` 本地日期回退一个自然月；weekly → 回退 7 天。均取 `dayKey` 字符串。
- `window.to` = `dayKey(now)`；`resetDay` = `resetAt` 前一天的 `dayKey`。
- `cycleDays` = `from`..`resetDay` 日历天数（含两端）；`elapsedDays` = `from`..`to` 天数（含两端）。
- `tokens.local` 仅作参考，取不到给 `null`，**不**参与比值。
- `ratio.tokensPerCredit` = `tokens.official / credits.used`（原始浮点，客户端负责取整展示）。
- `ratio.capacityTokens` = `round(tokensPerCredit × credits.total)`（折算参考，非官方口径）。
- 所有数值均为有限数；不可计算的字段不出现（不写 `null` 占位，例外：`tokens.local` 与 `scope.clampedFrom`）。

### §1.2 不可用态

```json
{ "generatedAt": 1763, "available": false, "reason": "no-credits-total", "code": "…", "hint": "…" }
```

`reason` 枚举（固定，客户端按它决定要不要显示 hint）：

| reason | 触发 |
|---|---|
| `console-unavailable` | 控制台卡带 `error`（Cookie 失效 / 网关失败），`code`=`card.errorCode` |
| `no-console-card` | status 里没有 `token-plan-console` 卡（数据源被禁） |
| `no-credits-reading` | 没有任何 monthly/weekly 计量，或读数字段坏 |
| `no-credits-total` | 有比例但缺额度（`meter.total` 非有限或 ≤0） |
| `no-reset-time` | 缺 `meter.resetAt` |
| `five-hour-only` | 只有 5 小时计量 |
| `official-unavailable` | 官方明细返回失败体，`code` 原样透传（`official-disabled` 等） |
| `official-clamped` | `coverage.clampedFrom` 存在：官方最早日盖不住账期起点 |
| `no-token-data` | 官方 tokens ≤ 0 或比值不可算 |

## §2 宿主函数（lib/index.js，全部进 `__internals`）

### §2.1 `creditsCycleOf(card, now = Date.now())`

- 入参 `card`：status 里的 `token-plan-console` 公开卡（或 undefined）。
- 返回 `{ ok: true, key, label, labelEn, from, to, resetAt, resetDay, cycleDays, elapsedDays, total, used, usedPercent }`
  或 `{ ok: false, reason }`。
- 计量选择：`meters` 里 `key==='monthly'` 优先，其次 `'weekly'`；两者皆无 → 若存在 `key==='fiveHour'` → `five-hour-only`，
  否则 `no-credits-reading`。
- `used`：`meter.used` 有限且 ≥0 用它；否则 `usedPercent` 有限时 `total×percent/100`；都没有 → `no-credits-reading`。
- `usedPercent`：优先 `meter.usedPercent`；否则 `used/total×100`。
- `total` 非有限或 ≤0 → `no-credits-total`；`resetAt` 非有限 → `no-reset-time`；`from > to` → `no-credits-reading`。
- **不得**在本函数里做任何取整（展示层负责）。

### §2.2 `creditsTokenRatioOf(tokens, used)`

- `tokens` / `used` 均需为有限数且 `used > 0`、`tokens > 0`；否则返回 `null`。

### §2.3 `composeCreditsToken({ card, official, localTotals, now })`

- 纯函数，返回 §1.1 / §1.2 的响应对象（`generatedAt` = `now`）。
- `official` 为 `buildOfficialUsageSnapshot` 的返回值（成功体或失败体）。
- `localTotals` 可为 `null`（本机快照失败）。
- `official.coverage.clampedFrom` 存在 → `official-clamped`（`hint` 里带上被夹紧后的起点）。

### §2.4 `buildCreditsTokenSnapshot(config, ctx, { fresh = false } = {})`

- 编排：`buildStatus(config, ctx, { fresh })` → 卡 → `creditsCycleOf` →
  `buildOfficialUsageSnapshot(config, ctx, { from, to }, { fresh })` →
  `buildUsageSnapshot(config, ctx, { from, to })`（失败忽略）→ `composeCreditsToken`。
- 异常不外抛（路由层兜 500）。

## §3 客户端（lib/client.js）

### §3.1 取数

- 常量 `USAGE_CREDITS = "/token-plan-quota/usage-credits"`（挨着 `USAGE_OFFICIAL`）。
- 状态槽 `credits: { status: "idle"|"loading"|"ready"|"unavailable"|"error", data, error }`，
  自带 `seqRef` / `abortRef`，15s 超时（沿用 `USAGE_TIMEOUT_MS`）。
- 触发：`UsageScreen` 挂载时一次；`onRetry` 时带 `?fresh=1` 再来一次。**不**跟随天数/区间变化重取。
- `payload.available === false` → `unavailable`（保留 `reason`/`code`/`hint`）；HTTP 失败 → `error`。

### §3.2 渲染

`usageCreditsSection(copy, credits, onRetry, stale)` 返回：

```html
<section class="tpq-usage-credits" data-usage-credits="1" data-stale="0|1">
  <h3 class="tpq-usage-credits-title">{copy.usageCreditsTitle}</h3>
  <p class="tpq-usage-credits-ratio" data-usage-credits-ratio>{copy.usageCreditsRatio}</p>
  <p class="tpq-usage-credits-window" data-usage-credits-window>{copy.usageCreditsWindow}</p>
  <p class="tpq-usage-credits-detail" data-usage-credits-detail>{copy.usageCreditsDetail}</p>
  <p class="tpq-usage-credits-estimate" data-usage-credits-estimate>{copy.usageCreditsEstimate}</p>
  <p class="tpq-usage-credits-note">{copy.usageCreditsNote}</p>
</section>
```

- 加载中：`<p class="tpq-usage-credits-loading">{copy.usageCreditsLoading}</p>`（同一 section 外壳）。
- 不可用：`<p data-usage-credits-unavailable>{copy.usageCreditsUnavailable}</p>`；
  中文界面且 `hint` 非空时追加 `" · " + hint`；英文界面不透传中文 hint。
- 错误：同上 + `<button data-usage-credits-retry>{copy.usageCreditsRetry}</button>`；
  不可用态也带这个按钮（可能只是这一次网关抖动）。
- 数字格式化：tokens → `formatTokens`；Credits → `usageCount(Math.round(value))`；
  比例 → `usagePercentText(used, total)`（**唯一**允许产出百分比的函数，禁止 `%` 字面量）。
- 插入位置：官方对照块之后、整页 note 之前。

### §3.3 COPY 新增键（zh / en，各 9 个；总键数 138 → 147）

| key | zh | en |
|---|---|---|
| usageCreditsTitle | Credits 与 tokens 换算 | Credits ↔ tokens |
| usageCreditsRatio | 1 Credit ≈ {tokens} tokens | 1 credit ≈ {tokens} tokens |
| usageCreditsWindow | 本账期 {from} 起至今 · 官方额度 {resetDay} 重置 | Cycle from {from} · allowance resets {resetDay} |
| usageCreditsDetail | 官方账号 tokens {tokens} · 已用 Credits {used} / {total}（{percent}） | Official tokens {tokens} · credits used {used} / {total} ({percent}) |
| usageCreditsEstimate | 按本账期实测比值，{total} Credits 约合 {tokens} tokens（折算参考，非官方口径） | At this cycle's measured ratio, {total} credits ≈ {tokens} tokens (derived, not official) |
| usageCreditsNote | 比值 = 官方账号 tokens ÷ 已用 Credits；已用 Credits = 官方额度 × 官方已用比例。它是本账期的混合口径均值，随模型与缓存命中率变化，不是固定兑换率。 | Ratio = official tokens ÷ credits used; credits used = official allowance × official used share. It is a blended average for this cycle — model mix and cache hit rate change it, so it is not a fixed exchange rate. |
| usageCreditsLoading | 正在读取 Credits 换算… | Reading credits conversion… |
| usageCreditsUnavailable | 本账期换算暂不可用 | Conversion unavailable this cycle |
| usageCreditsRetry | 重新读取 | Retry |

- 以上字面量必须**逐字**落地（测试按字面量断言）。

### §3.4 CSS

`.tpq-usage-credits`（与 `.tpq-usage-official` 同一套卡片视觉：边框/圆角/内边距，margin-top 12px）、
`.tpq-usage-credits-title`（14px 600）、`.tpq-usage-credits-ratio`（18px 600，`tabular-nums`）、
`.tpq-usage-credits-window`/`-detail`（12px 次要色）、`.tpq-usage-credits-estimate`（11.5px 次要色）、
`.tpq-usage-credits-note`（11px 次要色，行高 1.6）、`.tpq-usage-credits-loading`、`.tpq-usage-credits-retry`（按钮同既有次要按钮样式）。

## §4 测试口径

- `test/host.mjs`：`creditsCycleOf` 8 例（monthly / weekly / 只有 fiveHour / 缺 total / 缺 resetAt /
  used 由 percent 兜底 / 非法卡 / from>to）；`creditsTokenRatioOf` 4 例；`composeCreditsToken` 至少 8 例
  （可用态字段、clamped、官方失败体、tokens=0、本机 null、monthly/weekly 标签、capacity 取整）。
- `test/client.mjs`：就绪态文案逐字（zh/en）、loading、unavailable（含 zh hint / en 不显示 hint）、
  error + 重试触发、`fresh=1`、不随区间变化（切 30 天不发新请求）、数字格式（万/亿、千分位、百分比）。
- `test/guards.mjs` 第 14 节（Lead 写）：路由与函数存在性、`__internals` 导出、客户端钩子字面量、
  COPY 147/147 与 9 键双语、无新配置键（DEFAULTS 25）、无新主机（DECLARED_HOSTS 8）、
  `usagePercentText(` 在该段出现、无货币符号、README/CHANGELOG/specs/check-docs 登记。

## §5 文档与截图

- `README.md` / `README.en.md`：用量统计节加一条 bullet（换算口径、非固定兑换率、只在当前账期）+ 一张图。
- `CHANGELOG.md` [Unreleased]/Added：014 条目。
- `scripts/check-docs.mjs`：登记 `docs/images/usage-credits-2d.png` 与 `docs/images/en/usage-credits-2d.png`。
- 截图：make-shots 场景 ⑯（拦截 `/usage-credits` 用 fixture），1280×860 DPR1，zh/en 各一张。
- `specs/014-credits-token-ratio/INTERFACE.md` §6 实施记录（计数、实测值、偏差）。
## §6 实施记录

### §6.1 门禁计数（提交前最后一次编辑之后实跑）

| 套件 | 基线（013） | 014 后 | 增量 |
|---|---|---|---|
| test/host.mjs | 887 | **928** | +41（T003：账期 8 例、比值 4 例、组合 8 例以上，其余为边界收口） |
| test/client.mjs | 918 | **1012** | +94（T006：就绪/加载/不可用/错误、双语逐字、数字格式、重试、不随区间重取） |
| test/guards.mjs | 413 | **459** | +46（第 14 节静态矩阵） |

全部 0 failed；check-manifest OK（0.5.0、出站主机 8）；check-docs OK（配置键 25、数据源 8、928/1012/459、中英一致）；
check-refs OK；check-submission OK（category=usage）。

### §6.2 实测值（2026-11-14，真实账号 + 本机会话索引）

- console 卡：total 80000、used 37196.8802、usedPercent 46.4961、resetAt 1796054400000（2026-12-01 00:00 +08）、
  账期 from 2026-11-01 / to 2026-11-14（elapsedDays 14、cycleDays 30）。
- 官方账号 tokens（2026-11-01..2026-11-13）：2,122,918,870；本机 tokens 同区间：2,080,883,520。
- 比值：2,122,918,870 ÷ 37,196.8802 ≈ **57,072.5 tokens/Credit**；容量 57,072.5 × 80,000 ≈ 4,565,799,838 tokens。
- 官方无公开固定换算表（平台文档只以 Credits 统一计量）⇒ 脚注写明「混合口径均值，不是固定兑换率」；
  fixture 的 57072.49797793526 / 4,565,799,838 是按公式现算，与 §1.1 示例里的截断值 57072.3 有意不同（示例便于阅读）。

### §6.3 与契约的偏离（7 条，均已写进测试）

1. 换算块只在 snapshot 就绪且未禁用（`snapshot !== null && disabled !== true`）的渲染支插入：§3.2 的锚点
   「官方对照块之后」只存在于就绪支，比值也依赖本地+官方两侧数据；错误态/回填/骨架/空态不渲染。
2. hint 只在中文界面追加（严格按 §3.2 的字面量）；英文界面显示主文案 + 重试。
3. unavailable 与 error 两种失败态都带「重新读取」按钮（§3.2 明文要求）。
4. usagePercentText 返回 null 时（used=0 / total 非法），明细里的百分比位显示「—」，不显示伪百分比。
5. tokens.local 为 null 仍算 ready（契约规定它不参与比值）；渲染不展示 local，因此不需要缺省文案。
6. 重试请求 URL 带 ?fresh=1，首次取数不带 query（首取走缓存，手动重试强制回源）。
7. 请求失败/超时时不回显 code、HTTP 状态与 hint（沿用 008 的「不把上游报文带进 UI」纪律）。

### §6.4 可失败性实证

- 改坏 COPY 中文标题（与→和）：client 1006 passed / 1 failed（逐字断言命中）。
- 让挂载 ref 闸门失效：后续重试节点断言直接 TypeError、套件非 0。
- 比值格式化从 formatTokens 换成 usageCount：client 1005 passed / 7 failed。
- 把 guards 的 className 期望退回 JSX 写法（等号式）会红，证明第 14 节不是空扫。
- 还原后 928 / 1012 / 459 全绿。
