# 016 每个模型的分项比值（spec）

**需求（用户 m05460）**：「这个各自的比值也转换一下，我想看到对应的输入，输出，命中缓存的比值，每1credit是对应不同的模型的多少输入，输出或命中缓存的token」。

014 给出了账号级总比值与官方口径三类分项比值，015 给出了每个模型的**总量**比值；016 把两者合成：**每个模型各自再拆成三类**，回答「1 Credit 对应该模型多少输入 / 多少缓存命中 / 多少输出 tokens」。

## 状态

- 前置：014（比例块）、015（分项 + 按模型行）已入库。
- 范围：只扩 015 已有的 `GET /token-plan-quota/usage-credits` 响应与客户端模型行；**不新增**路由、查询参数、配置键、出站主机、第三方依赖。
- 宿主数据来源不变：本机 `buildUsageSnapshot({from: cycle.from, to: cycle.to})` 的 `models[]`（官方接口不提供模型维度，这一点 015 已定，016 不改）。

## 功能需求

- **FR-001 模型行带三类分子**：`ratio.models[i]` 增加 `classes: { input, cacheRead, output, cacheWrite }`，每项 `{ tokens, perCredit }`。
- **FR-002 口径**：`classes.x.tokens` 直接取本机该模型的 `totals.x`；`perCredit = tokens ÷ credits.used`，**不取整、不 toFixed**（与 014/015 一致）。
- **FR-003 输入含义**：本机 `input` **不含**缓存命中（与官方口径相反，014 已实证），因此模型行的「输入」就是未命中输入，文案用「输入」（复用 012 的 `usageSplitInput`），不加「未命中」前缀。
- **FR-004 恒等**：同一模型 `input + cacheRead + output + cacheWrite === tokens`（本机口径），故三类 perCredit 相加 = 该行 `tokensPerCredit`。
- **FR-005 0 与缺失**：本机缺字段、非有限、负数一律按 0 计；四类全 0 的行本就不会出现（015 已按 `tokens > 0` 过滤）。
- **FR-006 渲染**：模型行第二行显示「每 Credit：输入 X · 缓存命中 Y · 输出 Z」，`cacheWrite.perCredit > 0` 时追加「· 缓存写入 W」；三类任一 `perCredit` 非有限 → **该行分项不渲染**（第一行保留）；0 是真实值，照实显示 `0`。
- **FR-007 双语**：新增 COPY 键中英各 2 个模板（151→153）；「缓存写入」沿用 012 的 `usageSplitCacheWrite`。zh 用汉字，en 全 ASCII。
- **FR-008 只报实测**：所有数都是本机实测 tokens ÷ 已用 Credits，不折算 Credits、不派生配额比例；模型块脚注补一句「模型行的分母是本账期已用 Credits（账号级），不是该模型自己的额度」。
- **FR-009 宿主零猜测**：不新增上游请求；官方成功、本机失败时 `models: []`（015 既有降级不变）。
- **FR-010 可滚**：行变成两行后 252px 定高会真正触发内滚，键盘可滚、焦点环、细滚动条等 015 既有契约不变。

## 成功标准

- **SC-001** 实际数据（2026-11-14，used = 38280.2997）：`qwen-token-plan-cn/qwen3.8-flash` 的三类 perCredit 为
  输入 1,341.40 / 缓存命中 33,302.19 / 输出 132.79，相加 34,776.37 = 该行 `tokensPerCredit`。
- **SC-002** 五个模型行的三类 tokens 分别相加等于本机区间 totals（input 74,846,821 / cacheRead 2,269,964,800 / output 10,866,708）。
- **SC-003** 模型行不出现 `%`、不出现 `Credits 剩余`、不出现 NaN/Infinity。
- **SC-004** 缺 `classes` 的旧宿主响应下，模型行仍渲染（只是没有第二行），不报错、不白屏。
- **SC-005** 截图（中英各一张）在同一屏内看到三类比值，且模型块内滚生效（8 行两行制 > 252px）。