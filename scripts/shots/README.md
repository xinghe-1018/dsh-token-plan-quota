# README 截图是怎么来的

`docs/images` 里的中英两套截图（中文 15 张、英文 14 张：编号 7 只有中文，编号 12 是只落 `.shots-work/` 的 QA 错误态）里的余额、token 数、日期**全是合成数据**。这个目录就是那台"造图机"。

## 为什么不是随手截一张

本插件的立场之一是**不把真实额度放进公开仓库**。直接截日常实例会把真实余额、真实到期日、真实用户目录
一起带进 git 历史——那是删不干净的。桌面壁纸也会被半透明面板透出来（那上面还有画师的署名水印），
所以"随手截一张好看的"这条路一开始就该堵死。这里把"画面内容"做成了可重放的代码：任何人 clone 下来
跑一遍，得到的图和数据都是同一份假数。

## 三个设计决定

### 1. 拦响应，不造假上游

面板与徽标的渲染输入只有一个来源：同源 GET `/token-plan-quota/summary`。所以 `cdp.mjs` 用 Chrome DevTools
Protocol 的 `Fetch` 域，把这个响应（外加面板"更新于"按钮 POST 的 `/token-plan-quota/refresh`——它会覆盖快照，
漏拦就会拍到真数据）换成 `fixture.mjs` 造的对象。
用量统计整页屏是第三个接口：`GET /token-plan-quota/usage?days=N`（绝对 token 数）。它**按查询取参**，
所以 fixture 也按查询缓存、各写一份快照，并用 `assertUsageFixture()` 校验——7 天的快照去回答 90 天的请求，
拍出来就是"副标题说 90 天、图上只有 7 根柱"的假图。
查询入口有三个、互斥：006 的 `days`、007 的 `from`+`to`（自定义区间）、010 的 `month=YYYY-MM`（按月份）；
010 起 month 优先于 from/to 和 days，混用宿主回 400，脚本也直接报错而不是猜一个分支。
第四个接口是 008 的官方账号侧对照：`usage-official?…`（与本次查询同一份 query，三个入口都适用）。
官方对照的 fixture 与缓存键**独立于本机快照**（`o<days>` / `oc<from>_<to>` / `om<month>`），
并用 `assertUsageOfficialFixture()` 校验；两边数字不同源，拍出来就会出现"官方格等于本机格"或差额算反的假图。
第五个接口是 014 的 Credits ↔ tokens 换算块：`usage-credits`（无查询参数，恒回本账期）。
它既不是本机实测、也不是区间快照，而是「官方 Credits 计量 × 官方账号 tokens」的**本账期混合口径**，
所以 fixture 单独一份（`usage-credits.json`）、数值走 `builtCredits()` 并用 `assertUsageCreditsFixture()` 校验。

好处：不必模拟任何供应商的上游契约（尤其是千问控制台网关那套 Cookie/secToken 语义——最容易写错，
而且一旦写进文档就会和真实上游长期不一致），并且真实数字**根本进不到浏览器**，跑图用的实例不需要任何凭据。

代价：依赖 summary 的形状。这个形状由 `lib/index.js` 里 `publicCard()` 的**字段白名单**决定，
`fixture.mjs` 在运行时把它正则读出来比对——以后加字段而 fixture 没跟上，出图会直接报错而不是悄悄拍一张
宿主永远发不出来的图。

### 2. 用宿主自带的 `?fixture` 拿到"活会话"

徽标注入的座位是 `conversation.input.left`，**没有打开的会话就没有那块 DOM**，徽标整个不挂载。
DeepSeek Harness 的 web 层自带 fixture 模式（URL 加 `?fixture`，客户端会把整个 api 层换成内存假宿主，
自带种子会话和默认模型），所以：

- 不需要真凭据、不需要种工作区、不需要原生目录对话框；
- 图里出现的会话名和模型名也来自宿主的 fixture 常量，不是任何人的真实数据。

于是"UI 是假的、额度也是假的"——双保险。

### 3. 要"当前模型"和卡片对得上，就得补全假宿主的模型目录

徽标和面板都跟着**当前模型的供应商**走（`lib/client.js` 里按当前模型挑卡的那段：`pickOne()` / `bindOf()`），
所以一张讲「Token Plan 额度」的图，活动模型必须真的就是 `qwen-token-plan-cn/…`。而假宿主的模型目录只有 DeepSeek 与 OpenAI 两家。

补法是在浏览器侧改写那个客户端包里的一段目录常量（`make-shots.mjs` 的 `patchFixtureCatalog`）。
**不改宿主源码**：`dsh web` 发的是**预构建**的客户端包，改 `packages/client` 下的 src 不重新构建就不生效
（踩过）。锚点找不到就直接失败——宁可不出图，也不拍一张"当前模型"和卡片对不上的假截图。

## 前置

| 需要 | 说明 |
| --- | --- |
| Node ≥ 22 | CDP 客户端用全局 `WebSocket`，零 npm 依赖 |
| Microsoft Edge（或 Chrome） | 只用来跑无头截图，脚本会探两个常见安装路径，找不到用 `--edge` 指定 |
| 一个装好本插件的 dsh web 实例 | 建议用**独立 `DSH_HOME`** 的实例，别在日常实例上跑（脚本对 3080 默认拒绝） |
| ffmpeg（只有 GIF 需要） | 装在你自己选的目录，**不要加进插件 `dependencies`**：`npm i --no-save --prefix <dir> ffmpeg-static` |

起一个隔离实例（示例）：

```bash
DSH_HOME=/tmp/dsh-quota-demo dsh plugin --profile web add /path/to/dsh-token-plan-quota
DSH_HOME=/tmp/dsh-quota-demo dsh web --port 3099 --no-open
```

## 跑

```bash
node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 --lang zh --out docs/images
node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 --lang en --out docs/images
```

`--lang` 决定浏览器语言，而插件界面文案跟着 `document.documentElement.lang` 走，所以中英各跑一次就是两套图。
新版 `dsh web` 启动时会打印一条带 `?token=…` 的地址（首次访问 303 换 cookie）；**把整条地址原样传给 `--url`**
即可，脚本会自己接 `fixture` 参数（直接传裸端口会被 401 挡在门外）。
`--shots` 可以只跑其中几张（默认 `2,3,4,5,6,7,8,9,10,11,13,14,15,16`，`1` 是要 ffmpeg 的 GIF；`12` 只出 QA 错误态、
不进 `docs/`，所以不在默认集合里）。产物：

| # | 文件 | 证明什么 |
| --- | --- | --- |
| 1 | `badge-follows-model.gif` | 徽标跟随当前模型的供应商切换：官方真值 ↔ 明确标注的「实测」 |
| 2 | `panel-official-plus-meters.png` | 明细面板：官方余量卡 + 一张卡里的多窗口计量条 |
| 3 | `floating-panel.png` | 面板拖成悬浮小窗（拖标题栏、双击复位） |
| 4 | `cookie-fallback-measured.png` | Cookie 掉线：官方卡变成不带任何数字的错误卡，实测兜底卡留在徽标上 |
| 5 | `state-deepseek-balance.png` | 按钱计费的官方卡：没有分母 ⇒ 不画条、不报百分比 |
| 6 | `state-token-plan-credits.png` | 官方给了分母的卡：画条、报百分比、报周期重置日 |
| 7 | `state-no-history.png` | 既没官方额度、本实例又还没调用过：徽标「无官方额度数据」，面板只说清为什么没有 |
| 8 | `usage-2d.png` | 用量统计整页座位（2D）：区间总分、四类拆分、调用次数、逐日柱状图 |
| 9 | `usage-3d.png` | 同一份数据的 3D 等轴柱图。视图只是前端投影，数字必须与 2D 完全一致 |
| 10 | `usage-range-2d.png` | 自定义起止日期：日期行可见、chip 停在「自定义」、桶恰好铺满 `[from, to]` |
| 11 | `usage-official-2d.png` | 官方账号侧对照：官方/本机/差额三格数字与本机细分，与各自 fixture 逐个相等 |
| 13 | `usage-month-2d.png` | 按月份查询：月份行可见、chip 停在「月份」、桶恰好是整月（如 31 天 31 根柱）、标题回显该月 |
| 14 | `usage-tooltip-2d.png` | 柱子悬停：浮层报出该桶日期与 tokens 明细，位置夹在视口内 |
| 15 | `usage-composition-2d.png` | 用量构成（012）：中文分项标签、四类占比、缓存命中率、模型列表内滚动 |
| 16 | `usage-credits-2d.png` | Credits ↔ tokens 换算（014）：本账期比值、官方 tokens、已用 Credits、折算参考 |

5/6/7 是同一取景（面板浮在聊天区左上角 + 底部徽标行进同一个裁切框），只差当前模型 ——
读者要看的正是"换模型时这张卡怎么变"。所以 `panelScope` 设成 `current`（面板只列当前那一家）。
**英文套没有第 7 张**：那句解释文案宿主只有中文（`lib/index.js` 的 `buildWindowCard` 里 `emptyReason` 那句），
编一句英文就等于拍假图。

⑧⑨ 是**整页座位**：从徽标小窗底部的「用量统计」按钮打开，替换会话主区、侧栏保留。所以这两张是
整视口截图（1280×860、DPR 1），不像 5–7 那样裁切——侧栏和外层壳一起进图，才看得出它确实"是一整页"。
脚本先断言座位宽度 ≥ 视口 60%，再断言 2D/3D 的总分文本与桶数完全一致：同一份 fixture 的两个投影对不上，
说明那是另一次（可能失败的）加载，不是换了个画法。

中间产物落在仓库根的 `.shots-work/<lang>/<variant>.json`（当次用的合成 payload；用量统计是
`.shots-work/<lang>/usage-<days>d.json` / `usage-custom-<from>_<to>.json` / `usage-month-<YYYY-MM>.json`，官方对照是
`usage-official-<days>d.json` / `usage-official-custom-<from>_<to>.json` / `usage-official-month-<YYYY-MM>.json`，把那个接口单独一份；
014 的换算块是单份 `usage-credits.json`；QA 错误态是
`.shots-work/<lang>/qa/usage-official-error.png`）与 `.shots-work/<lang>/frames/`（GIF 帧），已 gitignore。**别把它们放到 `docs/` 下面**：
`package.json` 的 `files` 显式列了 `docs`，而 allowlist 会压过 `.gitignore`，帧文件会直接被打进 npm 包。

## 窄视口取景（QA 用，不是出图用）

`--width` / `--height` 覆盖默认取景（1280×860），给 `workflow/QA-REPORT.md` 的视觉 QA 用：

```bash
node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 --width 375 --out .shots-work/narrow
node scripts/shots/make-shots.mjs --url http://127.0.0.1:3099 --width 768 --out .shots-work/narrow
```

**非默认取景默认拒绝写入 `docs/`**：README 引用那批图、`check-docs.mjs` 第 10 项断言它们存在，
用 375px 的裁切覆盖它们等于把产品证据悄悄换一种口径。确实要覆盖（例如你就是要换掉已发布的图）
再加 `--allow-docs`。产物留在 `.shots-work/`，不要提交。

窄视口下若报 `point-outside-viewport`：先判断是**布局问题**还是**取景问题**，
别改流水线绕过去——那正是这一档要暴露的东西。

## 改图时注意的几条口径

这些不是审美问题，是**产品立场**——图里画错就等于 README 打自己的脸：

1. **实测卡永不画条、永不显示百分比**：没有官方分母的进度条就是估算。合成数据里连
   `usedPercent`/`remainingPercent` 都不该出现（宿主对实测卡就是不发这两个字段）。
2. **`meters[0]` 与顶层 `remaining/total` 同源**：前端只渲染 `meters.slice(1)`，写错顺序会少一条窗口。
3. **百分比是派生值**：`usedPercent`/`remainingPercent` 由 `finalizeCard()`/`finalizeMeter()` 从
   `{remaining,total}` 算出（取整到 4 位）。`fixture.mjs` 跑的是同一套公式，`assertFixture()` 还会复算比对——
   手改一个数字让算式对不上，出图会被拒。
4. **余量条的配色有硬档位**：`lib/client.js` 里余量条的三档配色是 ≥70% 绿 / 40–70% 蓝 / <40% 橙红。
   想让图里是绿条，合成数字就得真的落在 70% 以上，而不是去改前端。
5. **"还没调用过"的卡必须字段缺席**：宿主在 `buildWindowCard` 的 `startedAt === undefined` 分支根本不发
   `tokens`/`calls`/`resetAt`。写成 `tokens: 0` 会拍出一张宿主永远发不出的
   「0 tok」，徽标也不会是「无官方额度数据」。

另外 ④ 那张图里的"官方卡"必须**不带任何数字**：一旦带了数字，前端会把同供应商的实测兜底卡收掉
（一家只展示一张额度卡），徽标就变空白了。

⑧⑨ 的额外两条：**两条恒等式必须成立**（区间 totals == 各桶 totals 之和 == 顶层模型 totals 之和），
否则总分卡与柱状图会各说各话；**不许出现 "Credits"（脚注除外）**——用量统计只报绝对 token，不折算 Credits。
012 起 `%` 不再一刀切禁止：只允许构成比与命中率走客户端的白名单段（总量卡「占 57%」、模型行「(61.5%)」、
命中率「27.6%」），值由 ⑮ 逐格复算；⑧⑨⑩⑬⑭ 的旧断言已从「整屏无 %」改为「只查 Credits」。

⑧⑨⑩⑬⑭⑮⑯ 拍之前都先过一道**官方对照就绪断言**：`[data-usage-official]` 存在、`data-stale="0"`、三格
（官方 / 本机 / 差额）都是非空整数、细分行与说明段非空、块内无 `%` / `Credits`。008 起本机快照成功就会再请求
一次 `usage-official`，少了这道断言，图里要么缺一块、要么是「官方取不到」的错误态，而截图本身看不出来。

⑩ 是 007 的自定义区间，比 ⑧⑨ 多两道关卡，因为一张柱图本身证明不了"查询条件生效了"：
**日期行必须可见且回显拍图用的那对日期**（`data-usage-custom` 与两个 `<input type="date">` 都在视口内，
标题/区间副标题同时出现 `from` 与 `to`），**桶数必须与 fixture 的 `buckets` 数量相等**（桶恰好铺满 `[from, to]`，
周桶首桶从 `from` 起）。区间取"今天所在月往前推 2 个月的 1 号 → 今天"，跨度随月份在 60–92 天之间浮动，
正好落在 `>62 天按周聚合` 那一档；日期由脚本现算，不写死。

⑬ 是 010 的按月份查询（`?month=YYYY-MM`），固定拍**上一个自然月**：当月还没过完，夹到今天只剩十几天，
看不出"整月 31 根柱"这个要点。断言链条与 ⑩ 同构：点开 `data-usage-preset="month"` 后，
`data-usage-month` 行、`<input type="month" data-usage-month-input>` 与 `data-usage-month-apply`
必须都可见；输入框必须真的 `type="month"`，并且要吃下 prototype setter 填进去的月份（直接
`el.value = …` 不会更新 React 的受控状态）；点查询后标题/区间副标题要回显该月（zh 认「YYYY 年 M 月」
与补零的「YYYY 年 0M 月」两种写法，en 认「YYYY-MM」），柱数必须等于 fixture 该月的 `buckets`；
chip 必须停在「月份」，脚注以外无 `Credits`（012 起 `%` 只来自构成比与命中率，不再整屏禁止）。

⑭ 是 011 的柱子悬停，固定拍 **2026-10 的 22 号**那根柱：fixture 的逐日公式与真实时钟无关，`fixture.mjs`
导出 `USAGE_TOOLTIP_BAR_MONTH` / `_DATE` / `_TOKENS` 三个常量（tokens = 1,403,000，界面写作「140.3万」/「1.40M」），
断言、文档与图共用同一个真值，重拍才是字节可复现的。打开路径与 ⑬ 相同（chip → 月份框 → 查询），
柱子定位靠测试钩子 `[data-usage-bar][data-usage-bar-from="2026-10-22"]`，命中区还得带 `role="img"`、
`tabindex="0"` 与非空 `aria-label`（读屏和键盘走同一份文案）。然后**真发 `Input.dispatchMouseEvent` 的 `mouseMoved`**
到柱心——`element.hover()` 只走 JS 派发路径，证明不了指针事件能唤起浮层。浮层出现后逐项断言：
`[data-usage-tip]` 恰好 1 个且标了 `aria-hidden="true"`（012 复核第二轮起浮层不再有 `role`/`id`，改由柱子 `aria-label` 承担读屏）、`data-usage-tip-index` 等于该桶序号、`[data-usage-tip-range]`
含 `2026-10-22`、`[data-usage-tip-tokens]` 含上面那个量纲串、四类拆分与调用五行分别含 fixture 量纲串、
浮层四边都在视口内（≥8px）、整屏（脚注除外）无 `Credits`（012 起 `%` 只来自构成比与命中率）、英文套不混中文。前置同 ⑬：先过
官方对照就绪断言；脚注在 860 折叠线下，⑭ 不断言其可见（也不落 QA 图），只断言 `.tpq-usage-notes`
存在且含「仅统计本机」，并确认剔除脚注后的文本非空，才做 `%` / `Credits` 探针。⑬ 收尾时可能为 QA 脚注
滚到了底，⑭ 先把滚动容器拉回顶部再点月份 chip，否则柱子不在视口里、hover 与截图都会落空。

⑮ 是 012 的用量构成，固定拍 **7 天预设**（fixture 该区间的 totals 与 8 条模型由权重算死）：
总量卡必须恰好六格且顺序为 输入 / 输出 / 缓存命中 / 缓存写入 / 缓存命中率 / 调用次数
（英文 input / output / cache hit / cache write / cache hit rate / requests），中文界面不许混英文分项名；
四格的数值等于 fixture 的对应 token 量纲串，占比子行用 `usageModelSharePercent` 复算（「占 57%」/「57% of total」），
命中率格用 `usageCacheHitRatePercent` 复算（7 天 = 27.6%）。模型列表必须是
`[data-usage-models-scroll="1"]` + `tabindex="0"` + `role="group"` + 非空 `aria-label`，
`scrollHeight > clientHeight`（8 条超过 4 行高，内滚动真的生效、computed `overflow-y` 是 auto/scroll）；
截图启动参数带 `--hide-scrollbars`（全流水线既有取景设定），所以模型列表的滚动条在图上不可见，
内滚动以「第 5 行被裁切 + `scrollHeight > clientHeight` 断言」体现；真机界面有滚动条。
首条模型 = `USAGE_COMPOSITION_FIRST_MODEL_ID`，分项行必须同时含四个中文标签、61.5% / 30.8% / 7.7% 三个后缀
与「命中率 11.1%」，缓存写入为 0 时不许印 `(0%)`。脚注断言含「不是配额比例」与命中率公式；
`Credits` 按脚注剔除后再查（006 的来源脚注原文就写着「不折算 Credits」）。
取景与 ⑧⑨⑩⑬⑭⑯ **不同**：这一屏的证据在模型卡上（卡头 + 四行可见行 + 第 5 行被裁切），
所以脚本把「按模型用量」卡滚到视口上部，断言整卡完整落在视口内、列表高度 ≥100px 才拍；
官方对照与脚注仍在折叠线下，由就绪断言与脚注断言兜底。真值常量（8 条、首条 id、三项占比、命中率 11.1%）
放在 `fixture.mjs` 并导出，`assertUsageFixture` 与截图脚本共用同一份，重拍才是字节可复现的。

⑯ 是 014 的 Credits ↔ tokens 换算块，固定拍 **2026-11-01 起的本账期**（fixture 常量
`USAGE_CREDITS_WINDOW` / `USAGE_CREDITS_TOTAL` / `USAGE_CREDITS_USED` / `USAGE_CREDITS_OFFICIAL_TOKENS`）：
这一块展示的是「1 Credit ≈ 5.7万 tokens」（原始比值 57072.5，按官方 tokens ÷ 已用 Credits 现算）这类混合口径均值，不是固定兑换率，也不是区间快照。
断言四层：① `[data-usage-credits]` 恰 1 个、`data-stale="0"`、非 loading / 非不可用 / 无重试按钮，
且 `[data-usage-credits-ratio]` / `-window` / `-detail` / `-estimate` 与 `.tpq-usage-credits-note` 全部非空；
② 比值行含 `Credit` 与 fixture 量纲串（zh「5.7万」/ en「57K」），明细含官方 tokens（zh「21.23亿」/ en「2.12B」）、
已用 Credits `37197` / 总额 `80000` 与百分比 `46.5%`，账期行含 `2026-11-01` 与 `2026-11-30`，
折算行含容量 tokens（zh「45.66亿」/ en「4.57B」）与「折算参考 / derived」；
③ 口径护栏：无货币符号（¥ $ € £ / 元）、无「Credits 剩余」话术、无 `NaN`/`undefined`，
英文套不混中文、中文套不混 `credits used` 这类英文句式；④ 换算块必须排在官方对照块之后。
取景把这一块滚到视口上部并断言整块完整可见（≥120px）——
它的证据是那四行文本，不是柱图，所以不像 ⑧⑨ 那样从页顶拍。

⑪ 是 008 的官方账号侧对照条，比 ⑩ 多一层"两个来源不许混"：三格（官方 / 本机 / 差额）必须与**各自的 fixture**
逐个相等——官方取 `makeUsageOfficialSnapshot` 的 `totals.tokens`，本机取 `makeUsageSnapshot` 的
`totals.tokens`，差额按官方 − 本机带符号比对 `data-sign`（`pos` / `neg` / `zero`）；下方细分用官方 totals 的
input / cacheRead / output，三个数字必须在一行里对得上（顺序不作为契约，按多重集比）。说明段要同时含两层意思：
官方数字含其他设备、其他客户端用同一 Key 发出的调用；官方口径是 Token 总数，输入侧已含缓存读取（两项不相加）。
脚注以外不许出现 "Credits"（那句脚注原文就写着不折算 Credits）；012 起 `%` 只允许来自构成比与命中率（白名单段）。

取景：1280×860 装不下「页头 + 总卡 + 柱图 + 模型榜 + 官方块」（到官方块底边约 940–1020px），所以分两种口径——
⑧⑨⑩⑬⑭ 保持从页顶拍（标题、区间、日期行 / 月份行是它们的证据），官方块只露到三格数字；⑮ 滚到「按模型用量」卡、⑯ 滚到「Credits 换算块」（见上）；⑪ 单独滚到
「柱图卡顶 → 官方块 + 说明段 + 脚注」的取景，整块完整进图，且顶边吸到 `.tpq-usage` 子块边界，
不把一行字切一半（`frameUsage()`：块底贴视口底 16px，再往上找最近的子块边界）。

⑫ 是官方查询的失败态，只落到 `.shots-work/<lang>/qa/`、不进 `docs/`：让 `usage-official` 路由返回
`200 {error, code, hint}`，断言块内**零数字格**、只剩错误文案与重试按钮——失败态还留着半截数字，
等于把"取不到"拍成"取到了"。

## 两个静默失败的坑（都变成断言了）

- **「内测声明」模态在 fixture 模式下关不掉**：假宿主没有 settings 写入通道，
  `WelcomeNoticeStore.acknowledge()` 永远判失败，点「继续」只会亮出「暂时无法保存确认状态」那行错误——
  它正好压在徽标上，于是图里"面板有了、徽标没了"，而脚本一路绿。现在 `dismissOnboarding()` 先按标题定位
  到模态自己再点（不能用宽的 `[class*="dialog"]`：额度面板本身就是 `role="dialog"`），点不动就把这层宿主
  遮罩连同压暗层隐藏掉，并且以"没有浮层挡着徽标"（`elementFromPoint`）为唯一通过条件。
- **文本匹配要两边一起归一化**：`deepClick` 把节点 `innerText` 去了空白，却拿原始串去比，
  于是 `Qwen3.8 Flash` 这种带空格的名字永远点不到；`GPT-5` 没空格，坑藏了很久。

## 自检

```bash
node -e "import('./scripts/shots/fixture.mjs').then(m=>{const s=m.makeSnapshot({variant:'triptych',lang:'zh'});console.log(m.assertFixture(s,{lang:'zh'}).length+' 条断言通过')})"
```

```bash
node -e "import('./scripts/shots/fixture.mjs').then(m=>{const u=m.makeUsageSnapshot({days:7});console.log(m.assertUsageFixture(u,{lang:'zh',days:7}).length+' 条断言通过')})"
```

`assertUsageFixture` 会拦：区间/桶/模型三层 totals 的恒等式、日桶连续与周桶从周一起步、
顶层模型按 tokens 降序且 id = provider + "/" + model、桶 models 只有 5 个原始计数、
被渲染的字符串里出现 `%` 或 "Credits"、以及同样的真实痕迹与英文套中文泄漏。
010 起同一套断言也覆盖 `month=YYYY-MM`：`range` 必须是 `{kind: 'month', month, days, from, to}`、`from` 是该月 1 号、
`to` 是该月最后一天（当月夹到今天）、桶数与天数相等、粒度恒为 `day`（不走周聚合），月份非法或晚于当前月直接抛错。
官方对照 `assertUsageOfficialFixture` 的 month 分支同样要求 `range` 五键 `{kind, month, days, from, to}`：宿主按 `from`/`to` 命中缓存时靠 `month` 区分两个月查询（`month` 与夹紧后的 `from/to` 可能完全同值），缺了这个键会把 kind/month 串味。

`assertFixture` 会拦：真实痕迹（用户名/盘符/真实余额数字）、不在 `publicCard()` 白名单里的键、
实测卡带百分比、百分比与 `remaining/total` 不自洽、零记录实测卡带了本该缺席的字段、
以及**英文套里出现中文文案**（宿主单语字段除外）。`npm run check` 会连它一起跑。
