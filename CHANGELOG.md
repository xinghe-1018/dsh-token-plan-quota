# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式维护。

## [Unreleased]

### Changed

- **发布流水线的 `verify it landed` 窗口从 60 秒拉到 6 分钟，失败时还会把 registry 当下的
  `dist-tags` / `versions` 打出来**：v0.4.8 那次 `npm publish` 其实**已经成功**（OIDC trusted
  publishing + provenance，退出码 0，回执 24 files / 2.3 MB / shasum 齐全），但 runner 在
  60 秒里连续 6 次 `Cache-Control: no-cache` 查询都拿到旧文档 —— npm 自己还在传播 —— 于是
  verify 判红，连带把后面的 GitHub Release 跳过了。同一步骤在 0.4.6 那次也被骗过一回，
  那次根因是 runner 的本地 npm cache 旧快照：**症状一样、根因不一样**，而
  "绕开客户端缓存"并不等于"服务端已经是新的"。所以这次既拉长窗口（24×15s）又在失败分支里
  直接打印真相，不再靠事后翻 workflow 注解考古。

## [0.4.8] - 2026-09-15

### Fixed

- **审查采纳：`lib/client.js` 上 9 处真实缺陷**（Open Code Review 只扫这一个文件，
  逐条对着源码核实后修的；每条都补了断言，client 侧从 168 项涨到 192 项）：
  - **点「更新于」可能等于没点**：`load(fresh)` 原先「只要有请求在飞就搭车」，于是强制刷新
    会静默复用那条没带 `?fresh=1` 的普通轮询（宿主侧 `?fresh=1` 与 `POST /refresh` 都会绕开
    `cacheMs` 回源）。现在搭车规则改成**只允许新的搭旧的**，并且并发时后开的那条不会被
    先结束的那条从 `inflight` 上摘掉。
  - **面板底部那个按钮绕过缓存与 busy**：它直接 `POST /refresh`，不置 `busy`（按钮不会显示
    「刷新中…」），回包也不写 `cache`，还会被并发轮询的旧结果盖回去。现在统一走
    `reload(true)`；`busy` 改为按在飞条数收口；快照按 `generatedAt` 取胜，迟到的旧包不再
    把新数字刷回旧数字。`/token-plan-quota/refresh` 路由宿主仍保留（外部脚本可用），
    浏览器侧不再需要它。
  - **5 小时窗口两头都不出**：`CardDetail` 的 `else` 分支里又抄了一遍同名 `const
    extraMeters` / `hasFiveHourMeter`（只 `slice(1)`、没过滤读数），遮蔽了函数级那两份。
    于是「补一行 5h」的判定看的是**原始** meters，而真正渲染的 `MeterRows` 用的是**过滤后**
    meters —— 一个被当噪声滤掉的 5 小时窗口既不出条也不补行，信号凭空少一路。现在只留一份。
  - **宿主字段形状一变就整枚徽标消失**：`recentThrottle` 用 `for (const row of card.retry ?? [])`，
    `retry` 给成对象/字符串时 `??` 挡不住不可迭代值，抛在渲染里就是 React 把整枚徽标卸掉。
    现在按 `Array.isArray` 取数，并加了脏字段行为用例（`retry` 是对象时徽标与面板照常）。
  - **拖拽/缩放中途面板被卸载会漏绑监听**：手势解绑只挂在 `pointerup`/`pointercancel` 上，
    而宿主换会话重挂座位、按 Esc 关面板时这两个事件都不会再来。现在 `bindGesture` 注册一个
    幂等收口，卸载清理时调用它；**故意不跑 `onUp`**——那会把拖到一半的矩形写进 localStorage。
    Esc 那条路径还顺手补上「关掉面板同时丢掉 `dragBox`」：那是 `pointerdown` 才有的临时冻结态，
    留着的话下次打开会停在半路位置，且再也回不到锚定态。
  - `row.lastRetry != null && row.lastRetry !== undefined` 后半是死条件（`!= null` 已含
    `undefined`），删掉。
  - 余量渐变条的百分比在徽标和明细卡里各抄一遍嵌套三元（改一漏一），收成
    `remainingPercentOf(card)` 一份。
  - `itemText` 是一路猜到底的三层嵌套三元，末分支遇到既无 `remaining` 也无 `tokens` 的条目会
    印出「— / 2000」这种像数据被吃掉的行；改为按「这条有什么数字」早退分支，第三家硬编码的
    「次」统一走 `copy.calls`（英文界面不再中英混排），`expiresAt` 按格式化结果判断而不是
    按字段存在判断（老写法会输出 `· null`）。
  - 手写 CJS 壳里的 `var module` / `var exports` 改 `const`（no-var）。
- **审查采纳 · 第 6 条单独一轮：英文界面不再中英混排**。有 6 组会进画面的文案是硬编码
  中文，绕过了 `COPY` 字典，宿主切英文时它们照样是中文：卡片可信度（`官方接口` /
  `本实例实测` / `数据源`）、自动检测的可解释性文案（`按 {host} 自动识别`、
  `按供应商名自动识别`、`按 Key 前缀自动识别`、`没匹配到官方额度接口，按本实例实测显示`、
  `自动识别`）、重试 tooltip 的 `失败码` 与 `第 {n} 次重试`、摘要行的 `5h窗口`、
  标题 tooltip 的 `区 {r}`，以及 `官方接口：来源` 那个全角冒号。现在中英各补 13 个键、
  全部走字典，中文措辞逐字保持不变（`5h窗口 已用 1.23%` 这类既有断言一字未改地通过）。
  两处**刻意保留**：`formatTokens` 的 `万` / `亿` 由 `cjkTokenUnits` 门控（英文出 K/M/B，
  中文才有这两个字，本来就是按语言分的）；`ctx.logger` 的诊断文案跟全项目中文日志的约定，
  不进画面。并把这次清扫固化成三把锁：`COPY` 的 zh / en 键集必须一一对应（62 = 62）、
  剥掉字典与注释后源码里不得再有会进画面的中文（白名单只有上面那两处，注入一句硬编码
  中文即报错）、以及一组真的用 `lang="en"` 渲染的回归用例（断言 `official API: …`、
  `auto-detected via …`、`failure code`、`retry #3` 出英文，且那五句中文文案一律不在）。
- **按 Open Code Review 的规范自查后修掉一处违规**：面板锚点的 `anchorTop` 原先写成
  嵌套三元（规范里 "Ternary Expressions: nested ternary expressions are not allowed"）。
  改为顺序语句，并加一条源码断言把"锚点计算不许出现嵌套三元"钉住。
  同一次审查还标出 `pickLocale()` 在渲染期改模块级 `uiEnglish` / `cjkTokenUnits`
  —— 那是"渲染期副作用"，但它是"宿主异步写 `<html lang>`"那条时序 bug 的修法，
  值只由 `<html lang>` 决定、同一帧内幂等，故保留并在此留痕。

- **Windows 上发布脚本的自检根本没跑**：`scripts/release.mjs` 用
  `spawnSync('npm.cmd', …, { shell: false })` 跑 `npm run check`，而 Node 24 起
  （CVE-2024-27980 的修复）拒绝在不带 shell 的情况下启动 `.cmd` —— 于是那步直接失败，
  报「自检没过」却给不出任何原因，`main` 与 tag 都推不出去（0.4.7 发布时实机撞上，
  当时手动 `npm run check` 全绿）。现在改成用自己的 `process.execPath` 依次跑
  `npm run check` 那五步：跨平台都是真可执行体，不碰 shell，也不触发 DEP0190；
  失败时会报出**具体是哪一步**，并区分「连启动都失败」和「退出码非零」。

## [0.4.7] - 2026-09-15

### Fixed

- **模型工具整条被宿主拒收**：`token_plan_quota` 的返回对象里 `estimated` / `remaining`
  这类「有才填」的字段会被显式写成 `undefined`。宿主在把工具结果交给模型之前会按
  「无损 JSON」深走一遍（判定在 `@deepseek-ai/dsh-util-values` 的 `walkJsonValue`），
  显式 `undefined`、稀疏数组、循环引用、NaN / ±Infinity / `-0` 任一命中都会让
  **整条结果**变成 `value is not lossless JSON`。在 dsh 0.1.2-rc.1 上实测：仅
  `.cards.0.remaining` 一个 undefined 就让工具通道全灭（徽标本身不受影响，它走 HTTP 路由）。
  新增 `toToolJson()` 在跨界前整形——丢字段而不是丢整条结果，非有限数收成 `null`、
  `-0` 收成 `0`、数组的洞补成 `null`、循环引用截断；`execute` 出口统一套用。
- **兼容声明在预发布线上自相矛盾**：`dsh.engines.dsh` 与 `dshhub.compatibility.dsh`
  原写 `>=0.1.0-rc.5`，但按 semver 的预发布元组规则它**并不接纳** `0.1.2-rc.1`
  （范围里必须有一个比较子带着同样的 `[major,minor,patch]` 元组）。改为逐线并列的
  `^0.1.0-rc.5 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0`，与 `dsh-cost-meter` 同法。
- **浏览器半边失败不留痕迹**：座位注册包在裸 `catch {}` 里，`ctx.get("slots")` 返回
  `undefined` 时也是静默 `return`。徽标一旦因为宿主座位契约变动而不出现，控制台与
  宿主日志两头都没有线索（本轮排查就因此多绕了一圈）。两处现在都走 `ctx.logger?.warn?.()`。
  注意：client 侧的 `ctx.logger` 落到宿主的日志缓冲，**不出现在 DevTools 控制台**——
  想在前台看到挂载结论，仍然只能靠徽标自己在不在。
- **0.1.2 起徽标整个不挂载（本轮根因）**：动态浏览器插件的 fiber 只看得见**自己声明过**的
  服务；没声明时 `ctx.get("slots")` 直接返回 `undefined`（直读 `ctx.slots` 则抛
  `cannot get property "slots" without inject`，判定在 `cordis-client-runner` 的
  `dynamicCordisContext`）。本插件的 `apply()` 于是走「无 slots 服务」分支静默退出——
  不注册、不轮询、不留日志。现在在返回对象上声明 `inject: ["slots"]`（与
  `dsh-client-ui-skill-explorer` / `dsh-git-graph` 同法）。`sessions` / `modelDirectories`
  刻意**不**进这个列表：它们是可选依赖，列进去会让 fiber 无限等待 provider，缺一份就是
  整个徽标停摆，比退回全量显示更糟。
- **座位占位只进不出 + 更好的座位后到拿不到**：`slots.inject` 工厂在该座位每次渲染时
  都会回调一次。原先是个 `let mounted = false` 的一次性闩锁——置位后既不随 disposer
  复位，也不区分是哪个座位占着。两个实机症状都出自它：切换会话把输入区卸载重挂之后
  徽标永久消失（"重启后所有历史会话都看不到"）；宿主先渲染通栏行、工具行后到时，
  徽标被钉在视口最左边的通栏上（"位置不对"）。现在占位记名 + 卸载释放 + 按偏好迁移，
  同一时刻仍只有一个座位挂着徽标。
- **中文界面里徽标变成英文**：语言原先在 `apply()` 里 `pickLocale()` 定一次。宿主的 locale
  插件是**异步**把 `zh-CN` 写进 `<html lang>` 的（`packages/client/locale/src/client/index.ts:149`），
  而动态插件的 `apply` 可能跑在它之前——那一刻 `<html lang>` 还是空的，只能退回
  `navigator.language`（操作系统语言），于是中文界面里徽标整屏英文，且不重载永不纠正。
  现在徽标每次渲染都重取语言。
- **面板不按当前模型收敛**：宿主默认 `panelScope:"current"`，但客户端的判定是
  `watchActive && … && panelScope === "current"`，而 `watchActive` 依赖 `sessions` /
  `modelDirectories` 两份服务。它们没进 `exports.inject` 声明，`ctx.get` 就返回
  `undefined`，`watchActive` 恒为 `false`，面板于是**永远退回全量显示**（实机反馈：
  「跟随当前模型，不要显示全部」）。现在三份服务一起声明。取舍写进代码注释与 README：
  任一服务缺席（例如 profile 停用了模型选择插件）时 fiber 会一直等 provider，整个徽标
  不出现，而不是退回全量。

### Fixed（面板遮挡，本轮修好）

- **面板被输入框遮挡**：实机探针证据 —— 面板 `position:'absolute'`、
  父节点是工具行里一个无类名 DIV（**不是** `body`）、面板下缘的命中测试落在
  `g9YjGG_card`。也就是 `canPortal` 为假，退回 CSS 锚定，被卡片的 `overflow` 沿上缘裁掉，
  不是 z-index 问题。根因与 `slots` 同一类病：`react-dom` 确实在平台模块表里
  （`packages/client/web/src/platform.ts:9`、种子表 `seed.ts:30` 也带着 `createPortal`），
  但动态插件要用的平台模块必须在 **`dsh.client.external`** 里点名
  （`packages/client/modules/src/index.ts:210`），而本插件的 `dsh.client` 只有 `platform`。
  于是 `require("react-dom")` 抛错，被 `client.js` 那个 `try/catch` 静默吞掉，
  `createPortal` 留成 `null`。修法是补 `dsh.client.external: ["react-dom"]`，
  实机确认面板重新 portal 到 `body`，不再被卡片上缘裁掉。
- **面板反过来盖住输入框**：portal 修好之后症状翻过来了 —— 探针量到 `position:fixed` +
  `parent=BODY` + 面板下缘命中的是它**自己**，说明不是被遮，是它在遮别人：锚定底边只贴到
  **徽标所在那一行**上方，而徽标在卡片底部的工具行里，486px 高的面板正好压在卡片和输入框上，
  点开就打不了字。底边改为贴**输入卡片上缘**（`closest("[class*='_card']")`，取不到才退回
  徽标上缘），面板体高度的可用空间也按卡片上缘算。
- **面板跑到视口左上角**：断线重连后徽标可能被卸载或尚未布局，`getBoundingClientRect()`
  全是 0，于是 `bottom = vh - 0 + 6 = vh + 6` 把整块面板顶出视口上沿，看着就是缩在左上角
  （实机反馈："过一段时间，面板会出现在左上角"）。现在先判锚点可信度（`isConnected` +
  退化 rect），不可信就退到「水平居中、上三分之一处」的悬浮位，保证面板始终完整可见、✕ 点得到。
- **"模型未知"不再等于"徽标消失"**：`Badge` 里原先有一条早退 —— `watchActive` 为真但
  `provider == null`（空白会话、切会话/重连的瞬间目录还没发布 `current`）就返回一个空的
  `.tpq`。它才是"长时间挂机后消失""打开会话又消失"的正面原因：徽标不是没挂载，是自己
  把内容清空了，而 0×0 看起来和"插件坏了"完全一样。按已定口径统一降级为全量显示，
  等目录发布后订阅再把胶囊切回跟随当前模型。
- **匹配不到当前路由就整个不显示**：`panelScope:"current"` 下按当前供应商收敛后一张卡
  都不剩时，徽标与面板一起空掉（实机反馈："匹配不到就改成全量显示"）。现在两处都退回
  全量：自定义路由、`providers` 写成通用名这类情况，至少还能看见别的源的余量。
- **胶囊位置**：按用户选定，首选座位从 `conversation.input.left` 改为
  `conversation.input.right` —— 徽标跟随当前模型供应商，就该贴在模型选择器左边
  （`.trailing` 里排在 model 座位之前，且是 list 座位，不挤掉官方控件）。工具行左侧与
  通栏行仍按优先级作为回退。

### Fixed（长时间挂机后徽标消失，本轮修好）

- **断线重连后徽标永久藏空**：模型观察原先只在 `sessions.list.current` **变化**时重挂目录
  （`if (current === watchedSession) return`）。宿主重连后会重建目录 store，而会话 id 往往
  没变 —— 于是等不到第二次 `follow()`，旧订阅又挂在已被替换的 store 上收不到发布，
  `modelWatch` 停在 `(null, null)`，Badge 里 `watchActive && provider == null` 那条分支
  就把徽标整个藏空（实机反馈："长时间不看这个页面之后插件会消失"）。现在两条口子自愈：
  id 没变但已经看不到模型时照样重挂，外加一个与轮询同量级的兜底重挂（`MODEL_RETRY_MS`，
  靠 `directory.load()` 把 current 拉回来）。

### Added

- 宿主测试补 6 项无损 JSON 回归闸：`toToolJson` 的四类畸变、JSON 往返一致性，
  以及 `execute` 出口确已套用的源码断言。

## [0.4.6] - 2026-09-08

### Added

- **发布自动化**：`.github/workflows/publish.yml` 接 `v*` tag，在 CI 里核"tag ↔ `package.json` ↔
  CHANGELOG 三处一致" → 跑全量 `npm run check` → 扫 tarball（有没有夹带截图中间产物、有没有漏掉
  README 引用的图）→ `npm publish --access public` → 回读 registry 确认版本真的上了。任一步失败
  都发不出包。鉴权两种都支持：配了 npmjs 的 Trusted Publishing 就走 OIDC（带 provenance、零 secret），
  配了 `NPM_TOKEN` 就自动改走 token。
- `scripts/release.mjs`（`npm run release -- --patch`）：切版本、把 `[Unreleased]` 搬进
  `## [X] - 日期` 并补 compare 链接、提交、打 tag、跑全量自检，全绿才推 `main` + tag。
  前置会拦四件事：工作区不干净、不在 `main`、`[Unreleased]` 是空的、版本号或 tag 已被占用。
  先加 `--dry-run` 可以看计划而不写入任何东西。
- **浏览器一键发版**：`.github/workflows/release.yml` 接 `workflow_dispatch`，Actions 页面点
  Run workflow → 选 `patch`/`minor`/`major` → 跑。跑的还是上面那段 `release.mjs`，逻辑不复制；
  差别只在 runner 上 checkout 是 detached HEAD 且没配过 git 身份 —— 脚本看到 `GITHUB_ACTIONS=true`
  会补 `user.name/email` 并把推的分支写成 `HEAD:main`。commit 里带 `[bot]` 署名，不冒名。
- **tag 一落地自动开 GitHub Release**：`publish.yml` 在 `npm publish` + 回读 registry 之后
  追加两步 —— 用 `scripts/extract-changelog-section.mjs` 从 CHANGELOG 抠出这一版的正文（逐行
  扫，不用 `\s*\n` 那种会连吞下一节的正则；同一套代码在 `release.mjs` 里也踩过的坑），落成
  `release-notes.md` 交给 `softprops/action-gh-release@v2` 的 `body_path`。抽错节等于把公告
  挂到别的版本下面，8 条回归锁进 `test/host.mjs`。publish 失败（`verify it landed` 红灯）时
  公告也不会建，registry 与 GitHub 上不会一个说发了一个说没发。

### Fixed

- **每点一次标题栏，明细窗口就永久大一点**（实机反馈）。根因不在点击，在**量到的和套回去的
  不是同一个盒**：拖拽/缩放存进 `localStorage` 的是 `getBoundingClientRect()` 的 border box，
  而 `.tpq-panel` 没写 `box-sizing`，`style.width/height` 默认按 content box 解释 —— 于是每轮
  加回 1px×2 边框。而标题栏的 `onPointerDown` 会先 detach 并存一次尺寸，所以"只是点了一下
  额度明细标题"也会触发。实测连点六次 `382→384→386→388→390→392→394`；`.tpq-panel` 加
  `box-sizing:border-box` 后六次稳定在 `380×434`。
  **双击标题栏复位保留不动**（先试过删它，但那治不了这个 bug —— 单击同样会存尺寸；
  真正的问题在盒模型，修好后功能完好，实测双击仍能清掉悬浮矩形回到锚定态）。
  三条回归锁进 `test/client.mjs`：`.tpq-panel` 必须是 border-box、`onDoubleClick: resetFloat`
  与 `resetFloat` 本体都必须在（均已反向验证会红）。
- **OIDC 发布被 setup-node 的 `registry-url` 挡在门外**（首次真跑 publish.yml 时踩到）。
  `actions/setup-node@v4` 只要给了 `registry-url: https://registry.npmjs.org`，就会往
  `~/.npmrc` 写一行 `_authToken=${NODE_AUTH_TOKEN}`；npm 客户端**不展开 `${...}`**，于是 OIDC
  那条本应"没 token、走 runner 注入"的路被这把字面量假钥匙挡住，返回 "Access token expired
  or revoked"（真实原因完全无关）。修法是 setup-node 只留 `node-version`，token 路径下由
  发布步骤自己 `printf ... >> ~/.npmrc`，OIDC 路径保持 `.npmrc` 里没有 `_authToken` 键。
  `test/host.mjs` 三条新断言：`publish.yml`/`release.yml` 不许再出现 `registry-url:`、
  token 分支必须显式写 `_authToken`。
- **publish 流水线不幂等，重跑永远发不出去**（v0.4.6 首跑撞上：`npm publish` 真把包传上去了，
  `verify it landed` 却因为 `npm view` 读 runner 本地 `~/.npm/_cacache` 拿到旧快照，误报
  60 秒查不到 → 整条 run 判失败 → 后面的 GitHub Release 步骤被跳过；下一次 tag 强推重跑，
  `npm publish` 又被 registry "You cannot publish over the previously published versions"
  挡下来，公告就永远建不出来）。两处一起改：publish 把这条 E403 当"其实已经发过了"继续往下走；
  verify 换成 `curl -fsSL -H 'Cache-Control: no-cache' registry.npmjs.org/<pkg>` 打 HTTP，
  绕开 npm 本地缓存。两条各一条断言锁进 `test/host.mjs`（371 → 373 项）。

## [0.4.5] - 2026-09-08

### Fixed

- **徽标收成工具行里的一枚小胶囊**（实机反馈"效果太差"后的定案）。之前 0.4.4 的 312px 上限没治本：
  换行取决于模型名的**内容宽度**，CSS 容器查询只量得到容器（卡片 ~773px）宽度、量不到内容宽度，
  所以任何固定上限都可能被长模型名挤到第二行。最终做法不是搬位置，而是**把徽标做小**：只留
  「渐变条 + 余量数字 +（实测时）那颗 `实测` pill」（约 126px）。**pill 特意留在脸上**：它是
  "这张卡不是官方余量"的唯一即时信号，收进 tooltip 等于把本插件最要紧的立场藏到悬停后面。
  速度、剩余天数、当前模型、来源一律进 tooltip，详细内容交给点开后的明细面板。
  胶囊宽度足够小，和「+」、工作区、模型选择器、上下文条、发送键
  挤在同一条 `flex-wrap` 工具行里也放得下（最坏情况仍 < 764px），不再换行。做成胶囊观感：全圆角 +
  一层淡底 + 细边框。
- **老外壳没有工具行座位时退到 dock，且 dock 态对齐卡片列**。dock 是通栏行，裸徽标会孤零零贴在视口
  最左边、和居中的卡片对不上。dock 态包一层 `.tpq-dock`，复刻卡片居中几何
  （`max-width = --dsh-composer-card-max-width` + `--dsh-composer-side-clearance` 内边距），徽标左缘落在卡片左缘上方。
- **明细面板向上展开时，标题栏的 ✕ 会被屏幕顶端裁掉**（短窗口 / hero 居中态）。面板朝上弹、底边贴徽标
  上方 6px，内容高时整块顶出视口、✕ 看不见也点不到。锚定态现在把面板体高度夹到「徽标上方可用空间」
  以内：底边不动、顶边往下挪，✕ 永远落在 8px 视口边距内（等价于「把详细界面向下移动、给 ✕ 留空间」）。
  悬浮态（拖出/缩放）不受影响。座位契约、dock 对齐契约、面板夹取契约进 `test/client.mjs`。
- **面板「吞吐」一行看不明白**（实机反馈）。三处叠在一起：
  ① 同一行混了两套量纲 —— 中文阶梯里插着一条 `≥1e6 → M`，于是 `近 60 秒 38.4万 · 近 5 分 2.47M`
  并排出现；现在中文只用 万/亿，英文只用 K/M/B。
  ② 数字不带单位 —— `近 60 秒 38.4万` 读者不知道是 token 还是请求，`247.0万/8` 更像一个除法；
  现在写成 `38.4万 tok` / `247.0万 tok / 8 次请求`，实测卡的 `窗口内已用 7天 84.7万` 也补上 `tok`。
  ③ 聚合速度之外又逐家列一遍 `qwen-token-plan-cn 50.2 tok/s · deepseek-official 161 tok/s · …`，
  与头部重复、常出现两家同速（看着像坏了）、还把这格撑到换行 —— **整行删掉，只留聚合值**；
  逐家数据仍在快照里，需要时走 `action=status`。
- **英文界面整屏中文标签**：服务端同时发 `label`（中文）与 `labelEn`，客户端却只读 `label`。
  现在界面语言是英文时优先读 `labelEn`（面板卡头与多窗口计量条），取不到才退回 `label`——
  客户端不翻译，想要英文标题就在条目里写 `labelEn`。README 的 `label`/`labelEn` 那一行原来写着
  "当前界面不消费它"，已同步改成实际行为。
- **`ok()` 断言失败时不给现场**：只打一行"X 没出现在输出里"，这轮排查三条此类断言时完全无从下手。
  现在 `ok(label, cond, context)` 可带现场片段，失败时打出来（截 900 字）。
- **座位偏好与测试互相矛盾**：代码与注释早已改成"首选工具行座位、dock 兜底"，但两条测试还断言
  dock 必须在前（上一轮翻转时漏改），一直红着。按代码与 README（"输入框**工具行**里的徽标"）
  统一成工具行优先，测试同步改正。

## [0.4.4] - 2026-09-08

### Added

- **明细面板标题栏加了关闭用的 ✕**（`aria-label` + tooltip，中英各一份）。此前只有"再点一次徽标"和
  `Esc` 两条关闭路径——都在，但都得先知道这个习惯。测试锁住四件事：按钮在、带可读标签、
  自己挡下 `pointerdown`（标题栏整条是拖拽把手，不挡就被 `beginDrag` 捕获），以及它没把拖拽把手替掉。
- 两条回归锁：`test/host.mjs` 断言 `window:<provider>` 的标签只写供应商名；`test/client.mjs` 断言
  `.tpq-chip` 的 `max-width` 上限存在且 **≤ 实测折行阈值 317px**（写死数字是为了有人放宽前先回去量一遍）。

### Fixed

- **徽标会把输入框那一行挤换行**（模型选择器被顶到第二行）。两层原因，缺一不可修：
  ① flex item 的 `min-width` 默认 `auto`，徽标顶在自己的内容宽度上不让收缩；
  ② 更关键——宿主那一行是 `flex-wrap: wrap`，**分行按各项的 base size 决定**，收缩只发生在分行之后，
  所以光"允许收缩"救不了它。实测（输入列是固定宽的居中列，980/1150/1400 窗口都一样）：
  徽标 ≤317px 一行，320px 起折行。现在上限取 312px，并给名字加了省略号（完整名一直在 `title` 里），
  数字与「实测」pill 用 `flex:none` 保住——**能裁的只有供应商名**。
- **同一枚徽标里出现两次「实测」**：`window:<provider>` 生成的标签是 `minimax-cn 实测`，
  右边那颗 pill 又写一遍 `实测`。现在标签只写供应商名，「实测」由 pill 负责（徽标与面板卡头都有）。
  顺带把重复掉的 ~40px 还回来：`minimax-cn` 全家桶的自然宽度从 345px 降到 296px，
  常见供应商名**一行放得下且不截断**。

- **✕ 与标题栏挤在一起**（实机反馈"这个 x 跟额度明细重合了"）。量出来两件事：
  ① 默认 380px 面板里 `当前模型: qwen-token-plan-cn/qwen3.8-flash` 那串**折成了两行**
  （标题行从 20px 被撑到 34px），✕ 跟着错位；② 按钮的负外边距把它往面板圆角上拽，
  悬停底色正好压在边框上。现在标题行**永远一行**：模型名走省略号（完整名进 tooltip），
  ✕ 外边距归零（距右缘从 10px 变成 14px）。四条 CSS 契约进 `test/client.mjs`。
- **英文界面里印着中文字符**：`formatTokens` 的单位写死「万/亿」，英文徽标会长成
  `84.7万 tok … measured in5d` 这种半中半英。现在紧凑单位跟着界面语言走（中文 `2.3万` /
  英文 `23K`，≥1e9 才用 `B`）。没有给 `formatTokens` 加 `copy` 参数——它有 14 个调用点，
  漏一个就是同一屏两种单位并存；改成在 `pickLocale()` 里记一次语言风格。
- **`pickLocale()` 让浏览器语言盖过了宿主语言**：原来是"两个来源里任一说 zh 就算 zh"，
  于是**中文操作系统 + 英文界面**的用户会看到一枚中文徽标嵌在全英文界面里。
  现在以宿主自己写的 `<html lang>` 为准，取不到才退回浏览器语言。

### Changed

- 截图全部重拍（标签变了）。README 顶部那段 ASCII 示意图原来把余量条和「实测」画在同一枚徽标上，
  正好违反本插件"没分母就不画条"的立场——改成并排两行，一行官方、一行实测，把这条差异直接摆出来。

## [0.4.3] - 2026-09-08

### Added

- README 的**三种状态**三连图（`state-deepseek-balance` / `state-token-plan-credits` / `state-no-history`）：
  同一取景（面板浮在聊天区左上角、底部徽标行进同一个裁切框），只差当前模型 —— 一张图同时给出
  「当前模型 → 面板里那一张卡 → 徽标怎么报」这条链。为此 `fixture.mjs` 加了两个卡型：
  官方 Credits 单窗口卡，和**字段缺席**的零记录实测卡（照 `lib/index.js:368-376` 的形状，
  不是 `tokens: 0` —— 后者会拍出一张宿主永远发不出的「0 tok」）。
  英文套只有前两张：那句解释文案宿主目前只发中文（`lib/index.js:376`），编一句英文等于拍假图。
- `make-shots.mjs` 会补全假宿主的模型目录：徽标与面板都跟着当前模型的供应商走，
  而 fixture 目录只有 DeepSeek 与 OpenAI 两家。做法是在浏览器侧改写那个客户端包里的一段常量
  （`dsh web` 发的是预构建包，改宿主源码不重新构建不生效），锚点找不到就直接失败。
- `screenshots.json`（仓库根）：向插件市场声明截图与展示顺序。上游规范允许 1–8 张、
  相对路径不得跳出插件目录；**不声明时市场会从 README 自动抽取**，声明只是取得顺序与选择权。
  顺序把 PNG 放在 GIF 之前——万一某个店面不处理动图，前面的静态图仍能正常呈现。
  该文件只给目录站读（它读 GitHub 仓库），因此**不加入 npm 的 `files`**。
- `check-docs.mjs` 规则 10 扩到十三张图，并新增两条口径检查：英文套的卡字段不得出现中文
  （宿主双语字段除外）、零记录实测卡不得带本该缺席的字段。

### Changed

- `RELEASE.md` §4 重写投稿路径：原写的"网页新建文件会自动 fork 并直接开 PR"实测**是错的**
  （带子目录的深链接在无写权限时直接报错），换成实际走通的 fork → git 推分支 → 写死 base 的
  compare 链接，并记录 PR #4581 与"fork 的 PR 需维护者批准工作流"。
- `ROADMAP.md`：T3.9 勾选；两处过期计数按实测更正（`data/plugins/*.yml` 3196 → **3304** 条、
  `category: usage` 178 → **182** 条）。

### Fixed

- 截图流水线里两个**静默失败**：「内测声明」模态在 fixture 模式下根本关不掉（假宿主没有 settings 写入
  通道，`WelcomeNoticeStore.acknowledge()` 永远判失败），那行「暂时无法保存确认状态」的错误正好压在徽标上，
  于是图里"面板有了、徽标没了"而脚本一路绿；现在改为按模态标题定位后再点/摘除，并以
  `elementFromPoint` 判定"没有浮层挡着徽标"作为唯一通过条件。
- `deepClick`/`clickText` 只归一化了页面文本、没归一化待匹配串，带空格的名字
  （`Qwen3.8 Flash`）永远点不到；`GPT-5` 没空格，所以这个坑藏了很久。

## [0.4.2] - 2026-09-07

### Added

- README 的四张截图（中英各一套）：改由 `scripts/shots/` 用**合成数据**生成——CDP 拦下同源
  `/token-plan-quota/summary` 与 `/token-plan-quota/refresh` 换成 `fixture.mjs` 造的对象，画面状态由宿主自带的
  `?fixture` 模式提供。真实余额、真实日期、真实用户目录不会进入仓库，跑图实例也不需要任何凭据。
- `scripts/check-docs.mjs` 规则 10：四张图必须存在且非零字节、README 不得再留「截图位」占位块、
  合成 payload 仍符合产品口径（键 ⊆ `publicCard()` 白名单、实测卡不带百分比、百分比与 `remaining/total` 自洽）。
  三条破坏性注入均已验证会转红。

### Changed

- README 顶部原先那段 ASCII 示意图旁边补上了真图；英文 README 改用英文界面截图（`--lang` 驱动界面语言）。

### Fixed

- **npm 包里的 README 图片不再 404**：`package.json` 的 `files` 之前只有 `lib`/`cordis.patch.yml`/三份 md/`LICENSE`，
  不含 `docs`，而 README 引用的正是 `docs/images/*`——GitHub 页面正常、npm 页面全断（本地看不出）。
  现在 `files` 补上 `docs`。中间产物（合成 payload 快照、GIF 帧）改落在仓库根的 `.shots-work/`——
  一开始放在 `docs/images/_debug`、`_frames` 并指望 `.gitignore` 排除，结果 `npm pack --dry-run` 显示
  **显式 allowlist 会压过 `.gitignore`**，34 帧 JPEG 被一起打进了包。这条就是"必须看 dry-run 文件表"的理由。

### 说明

- 本版本只动文档与出图物料，`lib/**` 的产品逻辑一行未改。
- 记录一处既有 i18n 缺口：`formatTokens` 把中文数量单位「万/亿」写死，英文界面会出现 `84.7万 tok`。

## [0.4.1] - 2026-09-07

开源发布前做了**四轮盲测**：中英文档各交两名读者，只准读 README，不许看代码、不许上网，回答同一组配置题。
独立答不出来、或读出相反结论的地方，就是文档的洞——四轮共补了六个洞，其中两个是功能/诊断缺口。

### Added

- **`enabled: false` 现在连自动检测一起压住**：`{"id":"moonshot-balance","enabled":false}` 写下去，检测就不会
  再把这张卡补回来，诊断块 `skipped` 留 `disabled-by-config`——「没认出来」和「你关掉了」从此分得开。
  此前"我只想干掉某一张卡"这个最高频诉求，文档里没有答案。
- **绑定漂移提醒**：手写源写了 `providers` 却没有一条对得上在用路由时，宿主日志会直说"这张卡查得到也不会
  露面，改 `providers` 或设 `panelScope: all`"。第三轮盲测照文档写法试出来这个坑——预设自带的 `providers`
  是 `moonshot` 这类通用名，不含用户的路由 id，表现正是本项目犯过的那类"查得到却看不见"。
- README 新增两节：**「只想关掉某一张卡」**（带可抄的 JSON）与**「卡片空着、又没报错，按这个顺序查」**
  （probe → 键名 → 字段路径 → 卡整个不出现的两种原因）。中英同步。
- README 补一张**手写条目可用键的权威表**（28 个键，逐个标注用在哪、默认值、哪个构建器消费），并明确
  「认不出的键不报错、只是没作用」——所以键名打错的表现是卡片空着，不是启动失败。
- `check-docs` 加三条硬检查：配置表逐行必须等于 `DEFAULTS` 键（`moonshotRegion` 是唯一例外）、条目键表逐行
  必须被代码 `source.<key>` 真读到、正文成对写的 "N/M tests" 必须等于实跑数（这条一上线就抓到英文 README
  里漂着的 324）；再加一条编码护栏（BOM / U+FFFD / GBK 私用区残骸）。六种损坏逐一验证可捕获，附对照组。
- **投稿条目纳入 CI**：新增 `scripts/check-submission.mjs`（并入 `npm run check` 与 manifest job），守
  `RELEASE.md` §4 那段权威 YAML——分类在上游取值表里、含 `: ` 的加了引号、行尾没有逗号、以句号结尾、
  条目文件名符合 `<owner>__<repo>.yml`。更要紧的是**描述与代码双向核对**：点名的厂家必须在预设里真有
  对应源，而 MiniMax / Anthropic / Gemini 这类"官方无额度端点"的 ❌ 档一旦写进描述就红。
  四个方向各注入验证过（包括把 OpenRouter 预设临时改名，确认它真能抓到脱钩）。

### Changed

- **讲清"写了 `sources` 会不会把检测关掉"**：那句"以你写的为准"（本版自己写进去的）与"关一张卡不影响别的卡"
  读起来互相打架，第三轮两名读者都因此不敢落笔。现在改成「**叠加层，不是替换**」，并把"已覆盖"限定为三种
  精确含义（`providers` 含该路由 / 同名 `id` / `enabled:false`），各对应一个 `skipped` 原因
  （`id-taken-by-configured`、`disabled-by-config`），凭据解析不到则单列为 `no-credential` 并列出试过的引用名。
- **说清关掉一张卡之后还剩什么**：认得出的厂家各只有一条官方源，关掉它就**没有卡**（实测兜底只挂在
  **认不出**的路由上）；千问是唯一同时有官方与实测两条预设的，关掉 `token-plan-console` 后 `token-plan-window`
  照旧；认不出的路由**每条各挂一张** `window:<provider>`，要连它一起关就点名
  `{"id":"window:<路由 id>","enabled":false}`。三条不对称各有一组带对照的测试钉住。
- **统一术语**：`provider` / 路由 id / `providers[]` 里的字符串是同一个东西（宿主 `llm.listProviders()` 的
  `id`；比较时忽略大小写，`.` `_` `/` 一律当 `-`）。
- **`panelScope: current` 的可见性第一次写进文档**：按路由过滤意味着**阿里云那三条在 `current` 下永远看不到**
  （账户余额与资源包没有供应商归属），要看只能设 `"all"`。
- 强制开某张官方卡的写法改为带 `providers` 的对象形式——只写源名会让卡片落在面板视野之外。
- `detection` 块的可见位置说明白：只在 `GET /token-plan-quota/summary` 的返回里，**明细面板不渲染它**。

- **文档不再写自己做不到的事**：`token-plan-window` 明确标注为"千问本地实测账本"而非自建窗口预设，并在
  「它不做什么」写死**没有"我手填额度上限"的窗口**（分母只能来自官方接口）；`card.meters` 从"配置键"改标为
  快照里的卡形状，多行窗口只有 `token-plan-console` 会产生；`docs/adding-a-provider.md` 同一处同步。
- 配置表改为**一键一行**（18 行 = 17 个 `DEFAULTS` 键 + `moonshotRegion`），阿里云专属五个键标注"仅阿里云使用"，
  `refreshMinutes` 说清「TTL = 分钟 × 60s，下限 15s，所以 3 就是每 3 分钟」。此前合并行让"17 个键"这句
  自查声明对不上任何人自己数出来的行数。
- 说明「只看 API host，不看控制台域名」：`platform.kimi.com` / `platform.moonshot.cn` /
  `bailian.console.aliyun.com` 不参与识别，并给出 Kimi 用户的路径；`labelEn` 如实标注**当前界面不消费**。

### Fixed

- **CI 六个 job 全红、本机全绿**：`process.env.X = undefined` 在 Node 里写入的是字符串 `"undefined"`，
  于是"未设 `DSH_HOME`"那条用例在 CI 上把默认路径算成 `undefined/...`。本机之所以看不出来，是因为
  宿主恰好导出了 `DSH_HOME`——本地跑得越顺，越是骗人。现在这条**显式删除**变量，恢复也统一走
  `setDshHome()`；另在三种环境形态下各跑一遍（无 `DSH_HOME`＋空 HOME、本机常态、`DSH_HOME` 指向无关目录）。
- **`check-docs` 的 tag 死链检查会假红**：`actions/checkout` 默认给的是"单层且不带 tag"的克隆，
  那里四个 tag 全部"不存在"。manifest job 改为 `fetch-depth: 0` 取真实 ref；检查本身遇到浅克隆/
  非仓库安装时**出声跳过**（`note:` 一行），而"非浅克隆但一个 tag 都看不见"仍然红，只是把两条对策
  一起写出来（删链接 vs `git fetch --tags`）——这条检查当初就是靠"仓库其实没 tag"抓到四个死链的，
  不能为了 CI 安静把它做成空转。
- 手写条目不写 `label` 时卡片标题为空 → 回落成条目 `id`（徽标 tooltip 直接用了 `label`，此前会渲染出 `undefined`）。
- `plan.skipped` 从未透出到诊断块：规则层判定的跳过原因（含新增的 `disabled-by-config`）现在会出现在
  `detection.skipped` 里，与本地更详细的凭据记录合并去重。

## [0.4.0] - 2026-09-06

### Added

- **零配置自动检测**（`lib/detect.js`）：按宿主在用的供应商路由决定该开哪些数据源，
  不再需要手写 `sources` 与 `providers`。识别优先级 `baseURL host` > 路由名 > Key 前缀，
  都没命中就挂 `window:<provider>` 实测源。规则表是纯函数层，不打网络、不读文件，
  所以全部可离线测试，不需要任何真 Key。
- 每张自动开出的卡带 `detected: {by, rule, host, fallback, credentialRef}`，
  标题 tooltip 会写「按 api.moonshot.ai 自动识别 · 区 international」；
  快照新增 `detection` 块（在用路由 / 开了什么 / 谁因何被跳过 / 谁没被认出）。
- `autoDetect` 配置项（默认开）。用户写过的源永远赢：某路由已被任意源覆盖，检测就不再碰它。
- 凭据引用优先沿用路由 profile 点名的那个（如 `MOONSHOT_CN_API_KEY`），不必重复配置。
- 测试改用每进程唯一的 `os.tmpdir()` 目录，Linux/macOS 与 CI 可直接跑。

### Changed

- 明细面板改为**常驻小窗**：取消「点外面就关」，关闭只由再点徽标或 Esc 决定。
  原先的实现依赖宿主输入区的 DOM 属性，而线上产物里那些属性并不存在，导致点哪儿都关。
- 一家只展示一张额度卡：官方卡**有数字**时收起自动挂的实测兜底卡；官方卡变成错误卡
  （Cookie 过期等）时兜底必须回来。收合放在看得见数据的显示层，不在规划期决定。

### Fixed

- Cookie 型源不再继承检测写入的 `bearerRef`——曾导致千问官方余量卡报
  「未配置凭据 BAILIAN_CONSOLE_COOKIE（…或设同名环境变量）」，而 Cookie 其实一直在。
- 检测不再按路由名冒充别家：`deepseek-modlens` 这类指向本地代理的路由曾被认成
  DeepSeek 官方，开出第二张同名源；同名源共用 TTL 缓存并互相覆盖，表现为
  「两张余量卡、数字还不一样」。
- 实测窗口不再被误判为「缺凭据」而跳过（它本来就不需要凭据）。
- 一个窗口只有在该套餐真回了读数时才成为一条计量；`quota-config` 里躺着的档位配置
  （如个人版 `five_hour=3000`）不再被渲染成「5 小时窗口 额度上限 3,000」这种噪声。
- `deepseek-balance` 补上出厂适配器真实注册的路由 id `deepseek-official`
  （此前只绑 `deepseek`，卡片查得到却永远不显示，还每 10 分钟白打一次上游）。

## [0.3.0] - 2026-09-06

### Added

- 一张卡可承载**多个窗口**（`card.meters`）：宿主统一派生百分比，前端逐条渲染细渐变条。
  千问余量卡的 5 小时窗口从此是自己的计量行，不再是摘要尾巴上的一句小字。
- 新数据源：`moonshot-balance`（Moonshot / Kimi 开放平台，`.cn` CNY 与 `.ai` USD 两区）、
  `openrouter-credits`（OpenRouter，余额＝累计充值 − 累计花费）。
- `regions`（一家多 host/币种）、`derive`（一次加减的派生表达式）、静态 `unit`
  （端点不回币种字段时由区给出）、源级 `errorHints`（同一个 401 在不同家给不同人话）。
- `"window:<provider>"` 简写：给任意供应商挂实测窗口，不必手抄整个源对象。
- 4xx 卡片会捞上游错误体里的 `error.message`，不再只报一个状态码。

### Fixed

- 实测卡一律不出余量条、不出百分比（宿主剥一遍、前端再兜一道）：
  没有官方分母的比例就是估算，而估算不是本插件的口径。
- `0` 余额与欠款按真值显示，不再被当成「没数据」。

## [0.2.0] - 2026-09-06

### Added

- 徽标跟随当前会话的模型供应商切换（订阅宿主 `sessions.list` → `modelDirectories`），
  不轮询、不打网络；拿不到这两个服务的老外壳退回全量显示。
- 明细面板可拖出悬浮（`createPortal` 挂到 `body`、fixed 视口坐标）、右下角拖拽缩放，
  位置与尺寸记进 `localStorage`，双击标题栏归位。
- 极简视觉：幽灵小徽标、无状态圆点与表情符号，余量渐变条本身即状态表达；
  自成一套字体栈（Geist Variable + Noto Sans SC，断网落系统栈）。

## [0.1.0] - 2026-09-05

### Added

- 初版：DeepSeek 官方余额、千问 Token Plan 实测 7 天窗口（本实例账本，明确标注非官方余量）、
  可选阿里云 BssOpenApi（AK/SK 签名）三个数据源；只读路由 `/token-plan-quota/*`；
  模型可调用工具 `token_plan_quota`。

> 注：本仓库的公开历史始于 0.2.0（根提交即 `feat: dsh-token-plan-quota v0.2`），
> 0.1.0 没有对应提交，因此**不打 `v0.1.0` tag**——留一个指向不存在的 tag 的链接就是假链接。

[0.4.8]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/releases/tag/v0.2.0
