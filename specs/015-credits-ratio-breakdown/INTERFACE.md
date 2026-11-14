# 015 接口契约（唯一实现真值）

## 1 路由

不变：`GET /token-plan-quota/usage-credits?fresh=1`（同源、只 GET；非 GET 405）。本次**不新增**任何路由、查询参数、配置键、出站主机、第三方依赖。

## 2 响应新增字段（仅 `available: true` 时存在）

```js
ratio: {
  tokensPerCredit: number,      // 014 已有，官方口径，不变
  capacityTokens: number,       // 014 已有，不变
  classes: {                    // 新增：官方口径三类（三者 tokens 相加 = 官方 tokens）
    uncachedInput: { tokens: number, perCredit: number },  // max(0, official.input - official.cacheRead)
    cacheRead:     { tokens: number, perCredit: number },  // official.cacheRead
    output:        { tokens: number, perCredit: number },  // official.output
  },
  modelsBasis: "local",         // 新增：固定字符串，标明 models 的分子来源
  models: [                     // 新增：本机口径，按 tokens 降序，只含 tokens > 0
    { id, provider, model, tokens, calls, tokensPerCredit }
  ],
}
```

- `perCredit = tokens / credits.used`：不取整、不 toFixed；`credits.used > 0` 由 014 的提前短路保证（`no-token-data`）。
- 正常数据下三类 `tokens` 之和 **精确等于** `official.totals.tokens`（整数）；异常上游（cacheRead > input）下 `uncachedInput.tokens` 夹到 0，和不再等于总量，客户端**不做**校验、不报错。
- 官方字段缺失/非有限按 0 计（`finiteCount` 语义），绝不产出 NaN/Infinity。
- `models` 来自同一次 `buildUsageSnapshot(config, ctx, {from: cycle.from, to: cycle.to})` 的 `models[]`；本机读不到、或过滤后为空时 `models: []`（空数组，不是 null）。
- `classes` 与 `models` 互不影响：本机用量失败不影响分项，官方成功就照给 `classes`。
- `modelsBasis` 恒为 `"local"`。

## 3 客户端契约

### 3.1 COPY：新增 4 键、改 1 键（zh 147→151，en 同步）

zh：

- `usageCreditsClasses`: `每 Credit 的分项（tokens）：`
- `usageCreditsClassUncached`: `未命中输入`
- `usageCreditsModelsTitle`: `每个模型各自的比值`
- `usageCreditsModelsNote`: `模型行 = 本机该模型 tokens ÷ 本账期已用 Credits（官方不按模型拆分，这是贡献值）；各行相加约等于本机总量，与账号级官方总量有少量差额。`
- `usageCreditsNote`（改写）: `比值 = 官方账号 tokens ÷ 已用 Credits；已用 Credits = 官方额度 × 官方已用比例。分项按官方口径拆成缓存命中 / 未命中输入 / 输出（官方 input 含缓存命中，这里相减后单列），三者相加等于官方 tokens。它是本账期的混合口径均值，随模型与缓存命中率变化，不是固定兑换率。`

en：

- `usageCreditsClasses`: `Per credit by class (tokens): `
- `usageCreditsClassUncached`: `uncached input`
- `usageCreditsModelsTitle`: `Ratio per model`
- `usageCreditsModelsNote`: `Model rows = local tokens for that model / credits used this cycle (official data is not split by model, so these are contributions); rows sum to roughly the local total, which differs slightly from the official account total.`
- `usageCreditsNote`（改写）: `Ratio = official tokens / credits used; credits used = official allowance x official used share. Classes split the official figure into cache hit / uncached input / output (official input includes cache hits, so they are shown separately); the three add up to official tokens. It is a blended average for this cycle - model mix and cache hit rate change it, so it is not a fixed exchange rate.`

`usageSplitCacheRead` / `usageSplitOutput` 复用 012 已有键（zh 缓存命中 / 输出；en cache hit / output）。

### 3.2 分项行

- 位置：`data-usage-credits-detail` 之后、`data-usage-credits-estimate` 之前。
- 钩子：`data-usage-credits-classes="1"`，className `tpq-usage-credits-classes`。
- 文本：`copy.usageCreditsClasses + copy.usageSplitCacheRead + " " + formatTokens(cacheRead.perCredit) + " · " + copy.usageCreditsClassUncached + " " + formatTokens(uncachedInput.perCredit) + " · " + copy.usageSplitOutput + " " + formatTokens(output.perCredit)`。
  示例（zh）：`每 Credit 的分项（tokens）：缓存命中 5.5万 · 未命中输入 1977 · 输出 274`。
- 渲染条件：`ratio.classes` 是对象且三个 `perCredit` 都是有限数；否则**整行不渲染**（不显示 `—`、不显示 0）。
- 不出现 `%`。

### 3.3 模型块

- 位置：`data-usage-credits-estimate` 之后、`data-usage-credits-note` 之前。
- 渲染条件：`ratio.models` 是非空数组，且至少一项 `tokensPerCredit` 有限；否则**整块不渲染**。
- 结构：
  - `div.tpq-usage-credits-models`：`data-usage-credits-models="1"`、`tabIndex: 0`、`role: "group"`、`aria-label: copy.usageCreditsModelsTitle`；
  - `p.tpq-usage-credits-models-title` → copy.usageCreditsModelsTitle；
  - 每个模型一行 `div.tpq-usage-credits-model`：`data-usage-credits-model="1"`、`data-model="{id}"`，内含
    `span.tpq-usage-credits-model-name`（`id` 全名，`title={id}`，溢出省略）、
    `span.tpq-usage-credits-model-tokens`（`formatTokens(tokens) + " tokens"`）、
    `span.tpq-usage-credits-model-ratio`（`copy.usageCreditsRatio.replace("{tokens}", formatTokens(tokensPerCredit))`）；
  - `p.tpq-usage-credits-models-note` → copy.usageCreditsModelsNote。
- 顺序严格按宿主 `models` 顺序（已按 tokens 降序），客户端**不重排**、不截断。
- 无障碍：块 `tabIndex 0` + `:focus-visible` 描边；行不带 role；名字带 `title`。

### 3.4 CSS（新增，加在 014 的 `.tpq-usage-credits-*` 段之后）

- `.tpq-usage-credits-classes`：12px、弱化色（`var(--label-secondary)`）。
- `.tpq-usage-credits-models`：`max-height: 252px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;`、
  `scrollbar-color: <既有 thumb 变量> transparent;`、`:focus-visible { outline: ... }`。
- `.tpq-usage-credits-models::-webkit-scrollbar { width: 8px }` 与 `::-webkit-scrollbar-thumb { ... }`。
- `.tpq-usage-credits-models-title`：12.5px、标题色、`margin: 0 0 4px`。
- `.tpq-usage-credits-model`：`display:flex; gap:8px; align-items:baseline; padding:2px 0; font-size:12px`。
- `.tpq-usage-credits-model-name`：`flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`。
- `.tpq-usage-credits-model-tokens` / `-model-ratio`：`white-space:nowrap; font-variant-numeric: tabular-nums`；tokens 用弱化色、ratio 用正文色。
- `.tpq-usage-credits-models-note`：10.5px、弱化色。

## 4 测试口径

- **host**：`creditsClassRatios` / `creditsModelRatios` 数值与边界（cacheRead>input、缺字段、0 tokens、非数组）；
  `composeCreditsToken` 三组用例（classes+models / 无本机 / 旧调用无新字段）；`buildCreditsTokenSnapshot` 与路由的透传（沿用既有 stub 风格）。
- **client**：分项行文本逐字（zh/en）、模型行结构与顺序、降级不渲染（无 classes / 无 models / 空数组）、
  `aria-label` 与 `tabIndex`、CSS 四件、块内无 `%`。
- **guards 第 15 节**：静态字符串矩阵（`creditsClassRatios`/`creditsModelRatios` 定义与 `__internals` 导出、`ratio.classes`/`modelsBasis`、
  `data-usage-credits-classes`、`data-usage-credits-models`、`data-usage-credits-model`、`usageCreditsClassUncached`、COPY 计数 151、
  CSS 五件、模型块 252px+thin+contain、无新路由/配置键、`DECLARED_HOSTS` 8、`DEFAULTS` 25）。

## 5 兼容与降级

- 宿主旧、客户端新：无 `classes`/`models` → 只渲染 014 五行。
- 宿主新、客户端旧：多出的字段被忽略。
- 官方侧不可用：014 的 9 个 reason 原样，本次**不新增** reason。

## 6 实施记录

### 6.1 门禁计数（最后一次编辑之后实跑）

| 套件 | 基线 | 015 后 | 增量 |
|---|---|---|---|
| `test/host.mjs` | 928 | **954** | +26（21 个 check + 5 个 ok，块自 `test/host.mjs` 末段起） |
| `test/client.mjs` | 1012 | **1080** | +68（T015 显式 56 条 + 挂载触发的 12 条既有注册断言） |
| `test/guards.mjs` | 459 | **497** | +38（第 15 节静态矩阵） |

`check-manifest` OK（版本仍 0.5.0、出站主机 8）；`check-docs` OK（配置键 25、数据源 8、出站 8、954/1080/497、中英一致）；
`check-refs` OK（81 个活文档）；`check-submission` OK（category=usage）。

### 6.2 实现落点

- 宿主 `lib/index.js`：`creditsClassRatios`（官方三类相减，`uncachedInput = max(0, input - cacheRead)`，不取整）、
  `creditsModelRatios`（保序、只收 `tokens > 0`、`used <= 0` 返回空数组）、`composeCreditsToken` 的 `ratio` 增加
  `classes` / `modelsBasis: 'local'` / `models`；两者进 `__internals`。
- 客户端 `lib/client.js`：`usageCreditsClassesLine`、`usageCreditsModelsBlock`（均进 `__internals`）、CSS 015 段、
  ready 态顺序 `ratio → window → detail → classes → estimate → models → note`、COPY 147→151。
- 宿主零新路由/查询参数/配置键/出站主机/依赖；客户端零 `%` 字面量（百分比仍只由 `usagePercentText` 产出）。

### 6.3 与契约的偏差（均已在测试里钉住）

1. **§3.2 示例数字与 `formatTokens` 公式冲突**：示例写「未命中输入 1977 · 输出 274」，同条又要求数值走 `formatTokens`；
   实现按公式，产出「1,977」「274.46」（千分位、≤1000 保留两位小数）。示例未改，按公式为准。
2. **模型行行级闸门**：§3.3 只规定块级闸门；实现额外跳过 `tokensPerCredit` 非有限的单行（不印 `—`、不冒充 0），
   块内其余行照常渲染。
3. **tokens span** 用 `copy.usageTokensUnit`（值 `tokens`）而非硬写字面量，渲染结果与契约逐字相同。
4. **CSS 两处小件**：模型块 `padding-right:4px`（给细滚动条让位）、分项行 `overflow-wrap:anywhere`（与既有脚注一致）。
5. **门槛子句冗余**：模型块 `models.length === 0` 与「rows 为空返回 null」等价；保留但不作为可失败性证据。

### 6.4 可失败性实证（改坏 → 变红 → 还原）

- 宿主把 `uncachedInput` 从 `max(0, input - cacheRead)` 改回 `input`：host 948/6 红。
- 客户端把模型行顺序倒置：client 6 红；中文分项分隔符 ` · ` 改坏：2 红；`scrollbar-width:thin` 改 `auto`：1 红。
- guards 把 `"data-usage-credits-models": "1"` 改成 `"0"`、在分项段插 `"%"` 字面量、把中文`未命中输入`退回英文：各红。

### 6.5 口径注意（写给后来的维护者）

- 模型行是**贡献值**（本机该模型 tokens ÷ 账号级已用 Credits），不是官方按模型计费；官方不按模型拆分 Credits，
  也没有公开的模型单价。按 tokens 比例分摊会让每行恒等于总比值，属假精确，禁止改成那种算法。
- 分项三类只取官方口径：官方 `input` 含 `cacheRead`，所以未命中输入必须相减；混本机口径会让三项之和 ≠ 官方 tokens。

### 6.6 截图与内滚的取证口径

- 两张图由 shots-docs 用隔离实例（`DSH_HOME=~/.dsh/tmp/shots-012`、`--port 3099`、Junction 指向仓库）实拍：
  `docs/images/usage-credits-2d.png` 187,893 B、`docs/images/en/usage-credits-2d.png` 155,053 B，
  均 1280×860 / DPR 1；命令 `node scripts/shots/make-shots.mjs --shots 16 --lang zh|en`，两次 exit 0，拦截各命中 9 次。
- 实拍文本（zh）：「每 Credit 的分项（tokens）：缓存命中 5.5万 · 未命中输入 1,977 · 输出 274」；模型 8 行，
  首行 `deepseek/deepseek-v4-flash` / 4.21亿 tokens / `1 Credit ≈ 1.1万 tokens`。注意分项行给的是 **perCredit**
  （每 Credit 多少 tokens），不是三类 tokens 本身；三类 tokens 的恒等式（相加 = 官方 2,122,918,870）由 fixture 自检守。
- **模型块内滚在截图里未触发**：fixture 只有 8 行本机模型，块高 229px（en 246px）< 252px 定高。场景 ⑯ 的断言因此
  钉的是「cap 在位且真行没被裁」：computed `max-height: 252px` + `overflow-y: auto` + `scrollHeight === clientHeight`。
  真正的内滚行为在 `test/client.mjs`（CSS 钩子 + 降级矩阵）与客户端 375px headless 实测（20 行时 252/541）里验过；
  **不为截图临时克隆 DOM 行或往 fixture 塞假模型**——那样图与数据都不是真实状态，还会撬动 ⑮ 的行数与图。
