# 017 接口契约（实现唯一真值）

## 1 宿主配置

| 键 | 默认 | 说明 |
|---|---|---|
| `creditsDailyPath` | `$DSH_HOME/token-plan-quota.credits-daily.json` | 折算基础的按日快照文件；同日复用，跨日覆盖 |

配置键总数 25 → 26（`check-docs` 会核）。

## 2 快照文件（version 1）

```json
{
  "version": 1,
  "cycleKey": "monthly|2026-11-01|2026-11-30",
  "day": "2026-11-14",
  "computedAt": 1794700000000,
  "tokensOfficial": 2421781235,
  "creditsTotal": 80000,
  "creditsUsed": 38280.2997,
  "tokensPerCredit": 63356.07202313405,
  "capacityTokens": 5068485762,
  "classes": {
    "uncachedInput": { "tokens": 83716309, "perCredit": 2167.1984 },
    "cacheRead": { "tokens": 2350618624, "perCredit": 60851.428 },
    "output": { "tokens": 13035122, "perCredit": 337.4455 }
  }
}
```

- `capacityTokens = Math.round(tokensPerCredit * creditsTotal)`；
- 所有 perCredit 保留原始浮点，不 toFixed；
- 文件损坏、`version !== 1`、缺字段 → 视为不可复用，现算覆盖。

## 3 响应增量（GET /token-plan-quota/usage-credits）

```
ratio.basis = { day: "2026-11-14", computedAt: <ms>, cycleKey: "...", cached: true|false, policy: "daily" }
ratio.classes[key].capacity = Math.round(perCredit * credits.total)
```

- `ratio.tokensPerCredit`、`ratio.capacityTokens`、`ratio.classes[key].perCredit`、
  `ratio.models[].tokensPerCredit` 一律用同一份按日快照的比值与 `creditsUsed`；
- `credits.*`、`tokens.*`、`window.*`、`scope`、`source` 保持实时读数不变；
- `?fresh=1` → 强制重算快照并落盘，响应 `cached:false`；
- 无 `daily` 时（旧链路/写盘失败）响应与本提交前逐字段一致（不出现 basis）。

## 4 客户端结构

```html
<section class="tpq-usage-credits" data-usage-credits="1">
  <h3>Credits 与 tokens 换算</h3>
  <p data-usage-credits-ratio>1 Credit ≈ 63,356 tokens</p>
  <p data-usage-credits-window>…</p>
  <p data-usage-credits-detail>…</p>
  <section class="tpq-usage-credits-classes" data-usage-credits-classes="1">
    <p class="tpq-usage-credits-classes-title">1 Credit 折合</p>
    <div class="tpq-usage-credits-classes-grid">
      <div class="tpq-usage-credits-class" data-usage-credits-class="cacheRead">
        <span class="tpq-usage-credits-class-label">缓存命中</span>
        <span class="tpq-usage-credits-class-value">6.1万</span>
        <span class="tpq-usage-credits-class-unit">tokens</span>
      </div>
      <!-- 未命中输入 uncachedInput、输出 output 同构 -->
    </div>
  </section>
  <p data-usage-credits-estimate>按本账期实测比值，80000 Credits 约合 50.68亿 tokens（折算参考，非官方口径）</p>
  <p data-usage-credits-daily>按 2026-11-14 当日实测比值计算，每日刷新一次（20:05）</p>
  <section data-usage-credits-models>…</section>
  <p class="tpq-usage-credits-note">…</p>
</section>
```

- 三格顺序固定：缓存命中 / 未命中输入 / 输出；
- 任一 `perCredit` 缺失/非有限 → 整卡不渲染（不渲染空壳）；
- `basis` 缺失 → 不渲染 `data-usage-credits-daily` 节点；
- 卡内不得出现 `%`、`Credits`、货币符号。

## 5 CSS

| 选择器 | 要点 |
|---|---|
| `.tpq-usage-credits-classes` | 卡片：背景 `var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10))`、边框 `1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))`、圆角 10px、padding 10px 12px、无 margin（块间距交父容器 flex `gap:8px`） |
| `-classes-title` | 11px、`label-secondary`、margin 0 0 6px |
| `-classes-grid` | `display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px`；`@media (max-width:520px)` → `1fr 1fr` |
| `-class` | `display:flex; flex-direction:column; gap:2px; min-width:0` |
| `-class-label` | 11px、`label-tertiary` |
| `-class-value` | **20px**、600、`color:var(--dsw-alias-label-primary,inherit)`、`font-variant-numeric: tabular-nums lining-nums`、`overflow-wrap:anywhere` |
| `-class-unit` | 10.5px、`label-tertiary` |

## 6 验收断言清单

1. 同日两次非 fresh 请求：`ratio.basis.day` 相同、第二次 `cached:true`、
   `tokensPerCredit` 与 `capacityTokens` 逐位一致；
2. `?fresh=1`：`cached:false`，快照文件 mtime 更新；
3. 模拟跨日：`basis.day` 变新日期；
4. 快照写坏 JSON：响应 200、`cached:false`、不抛错；
5. 卡内三格逐字等于 fixture；value 计算字号 ≥ 18px；
6. 375px 视口无横向溢出；
7. 旧响应（无 basis、classes 只有 perCredit）→ 卡片照常、无每日提示；
8. 配置键 26、出站主机 8、零新增依赖。
## 7 实施记录（交付后补写）

| 契约项 | 落地符号 / 位置（按名字，不写行号） |
|---|---|
| 配置键 `creditsDailyPath` | `lib/index.js` 的 `DEFAULTS`（第 26 键） |
| 账期 key | `creditsDailyCycleKey`：`key|from|resetDay` |
| 快照构造 / 白名单 | `creditsDailySnapshotOf`、`normalizeCreditsDailySnapshot`、`CREDITS_DAILY_VERSION`、`CREDITS_DAILY_CLASS_KEYS` |
| 复用判定 | `creditsDailyReusable`：`day` 与 `cycleKey` 同时相等 |
| 读写 | `readCreditsDaily`、`writeCreditsDaily`（同目录 `.tmp` + `renameSync`） |
| 编排 | `resolveCreditsDaily`、`buildCreditsTokenSnapshot`（原并发单飞保留） |
| 响应拼装 | `composeCreditsToken` + `withDailyBasis` |
| 客户端卡片 | `usageCreditsClassesCard`、`usageCreditsDailyLine`，均在 `__internals` |
| 测试 | `test/host.mjs` 的 017 块、`test/client.mjs` 的 T017、`test/guards.mjs` 第 17 节 |

计数：宿主 971→1016、客户端 1159→1267、guards 526→561（第 17 节 35 条）；配置键 25→26、COPY 153→155、出站主机仍 8。

约定与偏差（均有测试锁定）：

1. `resolveCreditsDaily` 与 `buildCreditsTokenSnapshot` 多一个可选 `now` 入参——只为测试可注入「今天是哪一天」，生产路径不传，默认 `Date.now()`。
2. plan §4 写「写盘失败仍用本次现算值」，INTERFACE §3 写「写盘失败退回旧链路（无 `basis`）」；按 INTERFACE 实现，宿主用例与静态守卫都断言「无 `basis`」。
3. 额外防御：官方明细 `coverage.clampedFrom` 非空时不生成/落盘快照（残缺口径不能当当日基准），响应退回旧链路。
4. 客户端三格顺序与 CSS 断点按 §4/§5 实现：桌面 3 列、`@media (max-width:520px)` 两列。**交付后按用户反馈改过一次配色**：初版用 `#fff` 底 + `#e6e9ef` 描边 + `#1f232b` 数值字，在深色主题下白块像贴纸、且 `margin:8px 0` 与父容器 `gap:8px` 叠成 16px；现改为与 `.tpq-usage-official-*` 嵌套块同一套 token（`--dsw-alias-bg-layer-2` / `--dsw-alias-border-l2` / `--dsw-alias-label-primary`），圆角 12→10px 与父卡内嵌层级一致，margin 归零。该修正只动 CSS 与测试断言，DOM 结构、三格顺序、字号、grid 一律未变。
5. 卡片数值统一走 `formatTokens`（中文万/亿、英文 K/M/B），与全屏其它数字同一口径；不产生百分比。
6. 017 未改动 2D/3D 图表、路由表、`token_plan_quota` 工具入参与阅读侧工具能力。
