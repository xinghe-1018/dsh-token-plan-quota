# 加一家供应商（清单）

本插件加一家的标准流程。已经照这个模板做过两家：`moonshot-balance`、`openrouter-credits`。

前提：**有可核实的官方端点**。没有的话不要加源——那类供应商走 `window:<provider>` 实测窗口，
一行配置就够，不需要代码。

## 1. 先核实端点，再写代码

按这个顺序拿证据，缺一条就先别动手：

1. **官方文档**：URL、方法、鉴权头、响应字段名；
2. **存在性实测**（不需要真 Key）：用一把故意无效的 Key 打一次，
   看是 `401/403`（端点在）还是 `404`（路径不对）。**只用只读端点，绝不做会产生计费的探活**；
3. **字段名核对**（需要真 Key）：配好凭据后跑 `GET /token-plan-quota/probe?source=<id>`
   看打码后的字段骨架。没有真 Key 就在文档里标注"官方文档背书，未用真 Key 核对"——
   README 与 issue 里的描述会被拿去和代码核，**不许写过头**。

同时把这些问清楚，它们决定要不要新代码：

| 问题 | 影响 |
|---|---|
| 余额是**字段**还是**差值**（充值 − 花费）？ | 差值用 `derive`，不用写 builder |
| 端点回不回报**币种**？ | 不回就得靠 `regions` 静态给 `unit`，别让前端猜 `¥`/`$` |
| 一次请求回**几个窗口**？ | 多个 → 由**构建器**产出 `card.meters`（这是卡的形状，不是配置键；手写条目一条只有一个读数，想显示两个窗口就写两条源）；要第二次请求才拿得到 → 见「一源多请求」（尚未实现，别 hack 假 meter） |
| 百分比是**已用**还是**剩余**？ | 方向搞反＝仪表反向 |
| 窗口标识是数字还是**枚举**？ | 枚举要显式映射表，认不出的一律不出条 |
| 有没有**多区/多 host**？ | 用 `regions`（host 与币种成对），不做自动探测 |

## 2. 加预设（`lib/index.js` 的 `PRESETS`）

形状（`moonshot-balance` 是完整样板）：

```js
'xxx-quota': {
  label: '中文名', labelEn: 'English name',
  kind: 'single',            // single | list | window
  metric: 'money',           // money | credits | count
  url: 'https://…',          // 或 action/version（阿里云那类 RPC 签名源）
  method: 'GET',
  bearerRef: 'XXX_API_KEY',  // Cookie 型用 cookieRef；两者都写会走 Cookie 分支
  extract: { remaining: ['data.available_balance', 'available_balance'] },  // 每个字段给多版候选路径
  fields: { a: ['data.a', 'a'], b: ['data.b', 'b'] },   // 需要派生时用
  derive: { remaining: 'a - b' },                        // 只认一次 +/-
  regions: { 'china-mainland': { url: '…', unit: 'CNY' }, international: { url: '…', unit: 'USD' } },
  regionConfigKey: 'xxxRegion',
  errorHints: { 401: '这家特有的坑，写成人话' },
  providers: ['xxx'],        // 手填别名只是过渡，②之后由检测接管
}
```

## 3. 补三处元数据

- `SOURCE_META[id]`：`veracity`（`verified` 官方真值 / `local` 本实例实测）＋ `sourceNote`
  （**这张卡的口径**，会进 tooltip；写清端点与已知边界）；
- `errorHints`（源级）或 `ERROR_HINTS`（全局）：报错必须给**下一步动作**，不要只复述状态码；
- `package.json` → `dshhub.permissions.network`：**加一家就加一条 host**。
  `node scripts/check-manifest.mjs` 会检查格式，CI 会跑。

## 4. 让自动检测认识它（`lib/detect.js`）

往 `PLATFORM_RULES` 加一条：

```js
{ key: 'xxx', hosts: ['api.xxx.com'], idKeywords: ['xxx'], keyPrefixes: ['sk-xxx-'],
  presets: ['xxx-quota'], fallbackPresets: [], regionByHost: { 'api.xxx.cn': 'china-mainland' } }
```

两条铁律（有回归测试锁着）：

- **有 `baseURL` 时只信 `baseURL`**。路由名像不是一回事——`deepseek-modlens` 曾被按名字认成
  DeepSeek 官方，开出一张假余额卡。名字与 Key 前缀只在拿不到 host 时降级使用。
- **认不准就不开**。宁可少一张卡，也不能把别家的数字顶在某个模型上。

## 5. 测试（`test/host.mjs`，必要时 `test/client.mjs`）

至少覆盖：信封判定（成功码与非成功码）、字段抽取（含多版候选路径）、`0` 与负值按真值显示、
`derive` 宁缺勿猜、区/币种成对切换与未知区退回并 warn、源级 hint 不污染别家、
回环 `querySource` 跑通 200 与 4xx 两条路径、检测规则命中与**反例不许命中**。

```bash
node test/host.mjs && node test/client.mjs && node scripts/check-manifest.mjs
```

## 6. 回填文档

- `README.md` / `README.en.md` 的支持表：加一行，**写清验证到什么程度**
  （真 Key 实测 / 仅端点存在性实测 / 官方文档背书）；
- [`upstream-contracts.md`](upstream-contracts.md)：端点、鉴权、字段、单位陷阱、实测日期与出处 URL；
- `CHANGELOG.md`。

## 不要做的事

- 不要为"多一个窗口"去 hack 一个假 meter（一源多请求是独立的架构件，没做就是没做）；
- 不要读其它 CLI 的本地登录态（`~/.codex/auth.json`、`~/.gemini/*`、Kimi Cookie）——
  见 `SECURITY.md`，这类形态明确不做；
- 不要在 `cordis.patch.yml` 里写死 `sources`：那等于"用户手写过的清单"，会盖住自动检测；
- 不要折算 Credits、不要估算余量、不要给没有官方分母的数字画进度条。
