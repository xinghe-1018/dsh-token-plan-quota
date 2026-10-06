# Plan: 额度徽标在 DSH 0.2 上重新跟随模型，并修掉降级挑选挑中报错卡

## 1. Problem

实机反馈："额度插件又没有正常显示了。" 现场（2026-10-06，桌面版 `@deepseek-ai/dsh-desktop`
0.2.0-rc.2）是：输入框工具行里那枚胶囊只写「无官方额度数据」——没有数字、没有条、没有「实测」角标，
而同一时刻宿主快照里三张卡都活着（DeepSeek 余额 ¥39.80、千问 7 天实测 3400 万 tokens、
控制台余量卡报 `BailianGateway.Login.NotLogined`）。

拆开看是两层叠加：

1. **徽标根本没在跟随模型。** 客户端取"当前会话"的唯一写法是
   `sessions.list.getSnapshot().current`。DSH 0.2 起这个快照是 `{ ids, byId, phase }`，
   **没有 `current`**；宿主自己取"主区域正在看的那一个"用的是
   `Object.values(byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id`。
   于是 `provider` 恒为 `null` → `primary` 恒为 `null` → 徽标永远落进"路由解析不到"的降级分支。
2. **降级分支挑错了卡。** 它把"有数字"和"报错"混在同一优先级、且候选只取官方卡：
   控制台 Cookie 失效后，报错的官方卡按数组顺序先命中（真在服务请求的那条路由上，
   明明有一张有数字的实测窗口卡）。`cardValueText` 对"没有数字的卡"给的是
   `copy.noData`（「无官方额度数据」），于是正面既不是数字、也不是失败提示。

两条都得修：只修第 1 条，Cookie 一过期还会退回"报错卡抢位"；只修第 2 条，徽标继续不跟模型。

## 2. Non-goals

- 不碰控制台 Cookie 的获取方式，也不读、不回显任何 Cookie（原则 II）。**重抄 Cookie 是用户动作**，
  本轮只保证"Cookie 失效时画面说的是失败，而不是'没有数据'"。
- 不改官方源的抽取口径、不折算 Credits、不给没有官方分母的卡加百分比（原则 I）。
- 不新增数据源、不改出站声明集合、不加依赖（原则 IV / V）。
- 不改面板的 `panelScope` 语义与座位注册规则。

## 3. Premises

| # | 前提 | 怎么核 | 结论 |
|---|---|---|---|
| 1 | DSH 0.2 的客户端 `sessions.list` 快照没有 `current`，只有 `ids/byId/phase` | 读随应用发布的客户端产物（`app.asar`）里 `reconcileStatus`：`list.byId` / `list.ids` / `list.phase` 三处取值 | ✅ 老写法在 0.2 上恒为 undefined |
| 2 | 宿主认定的"当前会话" = `retainedBy.mainView > 0` 那一行 | 同一产物里 6 处同构写法（会话面板、open-in-app、ui-workspace 都用它） | ✅ 这就是 0.2 的口子 |
| 3 | 实机症状能被离线复现 | 把**线上真实快照**（`GET /token-plan-quota/summary`）喂给浏览器半边（`.scratch/diag-live-render`）：修前 provider 解析不到 → 正面 `无官方额度数据`；同一快照 provider=qwen → `3426.4万 tok · 实测` | ✅ 症状与推断一致 |
| 4 | 报错卡的 `data-sev` 本来就是 `bad`（红），只是正面文案误导 | `severityOf` 首行 `if (card.error) return "bad"` | ✅ 只需改正面文案 |
| 5 | 现有守卫"余量百分比只留一份算法"数的是**调用点个数**（`=== 3`） | 读 `test/client.mjs` 该条；工作区已是 5 处调用 | ✅ 这条守卫会退化成"每加一处用途就改魔数"，改成认结构 |
| 6 | 上一轮未提交的 host 侧修复（出站声明断言、值级脱敏）已经过测试，只是文档没同步 | `npm run check`：host 379 全绿，`check-docs` 报 15 条（`allowUndeclaredHosts` 未进配置表、键数/行数/测试数漂了） | ✅ 本轮一并收口，否则门禁无法变绿 |
| 7 | 插件当前其实**跑得动** 0.2.0-rc.2，只是 `dsh.engines` 还写着 0.1.x | 实机：工具 `token_plan_quota` 与 `/summary` 正常出数；host 测试 379 项通过 | ✅ 兼容区间应补 `^0.2.0-0` |

## 4. Approach

**选：两代外壳都认 + 降级挑选与跟随路径同一优先级 + 报错卡正面改口。**

- 取当前会话：先认 0.1.x 的 `snapshot.current`，再认 0.2 的 `retainedBy.mainView` 行
  （取 `row.id`，取不到回退到 `byId` 的键）。两代都认不出时给 `null`——退回降级，不抛。
- 降级挑选（`pickOne`）的候选池与跟随路径一致（**官方 + 实测**），档间先后也一致：
  正在服务请求的那条路由上、有数字的官方卡 > 同一路由上有数字的实测卡 > 任意有数字的官方卡 >
  任意有数字的卡 > 带 `meters` 的卡 > 只报错的官方卡 > 其余官方卡。
- 报错且没有任何数字的卡，正面说「查询失败」（`copy.failed`），不再说「无官方额度数据」；
  错误码与修复提示仍在 tooltip 与明细面板。

被否掉的替代：

| 方案 | 为什么不选 |
|---|---|
| 只修 `pickOne`，不动会话解析 | Cookie 一恢复、官方卡有数，降级分支就不再触发——但"徽标不跟模型"这个病还在，换个模型/换条路由就会再次表现为挑错卡 |
| 只修会话解析 | 控制台 Cookie 失效期间，降级分支仍会挑中报错卡，实机症状原样复现 |
| 用模型名当线索猜供应商 | 已经踩过：`deepseek-v4.1-flash` 是模型家族，会把绑 `deepseek` 的余额卡挑出来 |
| 新增一条宿主路由，让客户端把 provider 回传给宿主做诊断 | 本轮不需要：根因已从宿主产物里读实，且新增网络面要连带改声明与文档；先把静默失败变成"画面说得清"更划算 |

## 5. 改动面

| 文件 | 改什么 |
|---|---|
| `lib/client.js` | 新增 `currentSessionId`（两代外壳）；`attachModelWatch` 三处取值改走它；`cardValueText` 增加"报错且无数字 → 查询失败"；`pickOne` 重写为七档优先级、候选含实测卡 |
| `test/client.mjs` | 新增 3 组回归（新外壳形状认出现行会话 / 实机症状原样复现 / 只剩报错卡时的正面文案）；新增 `console-only-err` fixture；两条旧断言按新口径改写（未绑定供应商、目录被重建）；"只留一份算法"守卫改成认结构而不是数调用点 |
| `scripts/check-docs.mjs` | 英文正文那句断言的冠词放宽（`an 18-row` → `an? N-row`），否则 19 行时无法表达 |
| `README.md` / `README.en.md` | 补 `allowUndeclaredHosts` 配置行；同步键数 18、配置表 19 行、client 测试 217 项 |
| `package.json` | `dsh.engines.dsh` 与 `dshhub.compatibility.dsh` 补 `^0.2.0-0`（两处保持一致） |

## 6. 验证

`npm run check`（提交前最后一次编辑之后跑）：

```
host   379 passed, 0 failed
client 217 passed, 0 failed
guards  94 passed, 0 failed
check-manifest: OK（出站主机 8 个）
check-docs: OK（配置键 18、数据源 8、出站主机 8、host 379 / client 217 / guards 94，中英 README 与代码一致）
check-refs: OK（23 个活文档，无行号引用）
check-submission: OK
```

线上快照回放（`.scratch/diag-live-render`，非发布物）——同一份 `/summary` 快照，四种条件：

| 条件 | 徽标渲染 |
|---|---|
| 0.2 外壳 + provider=qwen-token-plan-cn | `4327.3万 tok · 实测` |
| 会话解析不出（降级路径） | `4327.3万 tok · 实测`（修前是 `无官方额度数据`） |
| 0.2 外壳 + provider=deepseek-official | `¥39.80` |
| 0.1 外壳（老写法） | `4327.3万 tok · 实测` |

**未验证 / 限定**：真机画面确认要等下一次页面加载（客户端产物在打开页面时装载），
本轮只做到"线上快照 → 浏览器半边"的离线回放；控制台 Cookie 仍是失效状态，
所以官方余量卡在有数之前不会回到徽标（这是数据问题，不是本轮改动）。

## 7. 风险

- `retainedBy.mainView` 是 DSH 内部字段：宿主再改形状时它同样会腐。缓解是 `current` 与
  `mainView` 两代都认，且都认不出时退回降级而不是藏空；下一个 DSH 大版本要重新核这条。
- `pickOne` 的七档优先级是"有数字优先"：Cookie 失效期间徽标显示的是实测窗口（口径已带「实测」角标），
  不是官方余量。这是刻意的取舍——宁可给一个标了口径的真读数，也不给一枚说不出所以然的空胶囊。
