# 017 计划：小卡片 + 折算按日快照

## 1 宿主

- 新增常量与配置：`creditsDailyPath`（默认 `$DSH_HOME/token-plan-quota.credits-daily.json`），
  解析方式与 `usagePath` 相同（`$DSH_HOME` 展开、相对路径按 cwd）。
- 纯函数（`__internals` 导出，供测试与 guards 定位）：
  - `creditsDailyCycleKey(cycle)` → `"monthly|2026-11-01|2026-11-30"`；
  - `creditsDailySnapshotOf({cycle, officialTokens, officialTotals, computedAt})` → 快照对象（不取整）；
  - `creditsDailyReusable(snap, cycle, day)` → `snap.day === day && snap.cycleKey === cycleKey`；
  - `readCreditsDaily(file)` / `writeCreditsDaily(file, snap)`：读坏/写坏都不抛；
    写盘用 `.tmp` + rename，失败静默。
- `composeCreditsToken({..., daily})`：`daily` 有效时
  `ratio.tokensPerCredit / capacityTokens / classes[key].perCredit / models[].tokensPerCredit`
  全用快照的 `tokensPerCredit` 与 `creditsUsed`；补
  `ratio.basis = {day, computedAt, cycleKey, cached, policy:"daily"}` 与
  `ratio.classes[key].capacity = Math.round(perCredit * creditsTotal)`。
  没有 `daily` 时行为与本提交前完全一致（既有测试不动）。
- `buildCreditsTokenSnapshot`：取到 cycle 与 official 后，
  若 `!fresh` 且快照可复用 → 直接用；否则现算快照并落盘。

## 2 客户端

- `usageCreditsClassesLine` 改为 `usageCreditsClassesCard`：
  `section.tpq-usage-credits-classes[data-usage-credits-classes="1"]`，
  标题 `p.tpq-usage-credits-classes-title`（`1 Credit 折合` / `One credit is worth`），
  三格 `div.tpq-usage-credits-class[data-usage-credits-class="cacheRead|uncachedInput|output"]`，
  每格 `span.-label / span.-value / span.-unit`。
- 字号：value 20px、label 11px、unit 10.5px；tabular-nums；窄屏 `grid-template-columns: repeat(3, minmax(0,1fr))`
  在 <520px 时换 `1fr 1fr`（第三格换行仍可读）。
- 折算行后新增 `p[data-usage-credits-daily]`：`按 {day} 当日实测比值计算，每日刷新一次（{time}）` /
  `Computed from the measured ratio on {day}; refreshed once per day ({time})`；
  `ratio.basis` 缺失就不渲染。
- COPY：`usageCreditsClasses` 改为「1 Credit 折合」/「One credit is worth」，
  新增 `usageCreditsClassesUnit` = `tokens`、`usageCreditsDaily`（中英各一条）。

## 3 截图与文档

- fixture 响应补 `ratio.basis`、`classes[key].capacity`；
- 场景 ⑰：卡片存在且三格逐字等于 fixture；value 计算字号 ≥18px；卡片在视口内、无横向溢出；
  无 `%` 与 `Credits`；重拍 `usage-credits-2d.png` 中英两张；
- README 中英（小卡片说明 + 配置表 +1 行）、CHANGELOG、shots/README。

## 4 失败模式

- 快照文件不存在/坏 JSON/版本不符 → 现算，`cached:false`；
- 同日但账期已变（重置日到了）→ cycleKey 不同，重算；
- 快照写失败（磁盘只读）→ 仍用现算值应答，不阻塞；
- `fresh=1` 并发两次 → 单飞 promise，只有一次写盘；
- 旧宿主无 `ratio.basis` → 客户端不显示每日提示，卡片照旧。

## 5 测试

- 宿主：快照纯函数、同日复用、跨日重算、损坏回落、fresh 强制、compose 的 basis/capacity 字段、
  恒等 `80000 × tokensPerCredit ≈ capacityTokens`（±1）。
- 客户端：卡片三格文字、缺一不渲染、字号/单位/数据钩子、basis 有无、无 %/Credits、375px 排版。
- guards：第 17 节静态矩阵（钩子、字号、COPY 计数、配置键数、README/CHANGELOG/specs）。
