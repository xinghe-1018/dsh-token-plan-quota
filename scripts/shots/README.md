# README 截图是怎么来的

七张图（中文一套、英文一套）里的余额、token 数、日期**全是合成数据**。这个目录就是那台"造图机"。

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

徽标和面板都跟着**当前模型的供应商**走（`lib/client.js:979`、`:994-1003`），所以一张讲「Token Plan 额度」
的图，活动模型必须真的就是 `qwen-token-plan-cn/…`。而假宿主的模型目录只有 DeepSeek 与 OpenAI 两家。

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
`--shots` 可以只跑其中几张（默认 `2,3,4,5,6,7`，`1` 是要 ffmpeg 的 GIF）。产物：

| # | 文件 | 证明什么 |
| --- | --- | --- |
| 1 | `badge-follows-model.gif` | 徽标跟随当前模型的供应商切换：官方真值 ↔ 明确标注的「实测」 |
| 2 | `panel-official-plus-meters.png` | 明细面板：官方余量卡 + 一张卡里的多窗口计量条 |
| 3 | `floating-panel.png` | 面板拖成悬浮小窗（拖标题栏、双击复位） |
| 4 | `cookie-fallback-measured.png` | Cookie 掉线：官方卡变成不带任何数字的错误卡，实测兜底卡留在徽标上 |
| 5 | `state-deepseek-balance.png` | 按钱计费的官方卡：没有分母 ⇒ 不画条、不报百分比 |
| 6 | `state-token-plan-credits.png` | 官方给了分母的卡：画条、报百分比、报周期重置日 |
| 7 | `state-no-history.png` | 既没官方额度、本实例又还没调用过：徽标「无官方额度数据」，面板只说清为什么没有 |

5/6/7 是同一取景（面板浮在聊天区左上角 + 底部徽标行进同一个裁切框），只差当前模型 ——
读者要看的正是"换模型时这张卡怎么变"。所以 `panelScope` 设成 `current`（面板只列当前那一家）。
**英文套没有第 7 张**：那句解释文案宿主只有中文（`lib/index.js:376`），编一句英文就等于拍假图。

中间产物落在仓库根的 `.shots-work/<lang>/<variant>.json`（当次用的合成 payload）与
`.shots-work/<lang>/frames/`（GIF 帧），已 gitignore。**别把它们放到 `docs/` 下面**：
`package.json` 的 `files` 显式列了 `docs`，而 allowlist 会压过 `.gitignore`，帧文件会直接被打进 npm 包。

## 改图时注意的几条口径

这些不是审美问题，是**产品立场**——图里画错就等于 README 打自己的脸：

1. **实测卡永不画条、永不显示百分比**：没有官方分母的进度条就是估算。合成数据里连
   `usedPercent`/`remainingPercent` 都不该出现（宿主对实测卡就是不发这两个字段）。
2. **`meters[0]` 与顶层 `remaining/total` 同源**：前端只渲染 `meters.slice(1)`，写错顺序会少一条窗口。
3. **百分比是派生值**：`usedPercent`/`remainingPercent` 由 `finalizeCard()`/`finalizeMeter()` 从
   `{remaining,total}` 算出（取整到 4 位）。`fixture.mjs` 跑的是同一套公式，`assertFixture()` 还会复算比对——
   手改一个数字让算式对不上，出图会被拒。
4. **余量条的配色有硬档位**：`client.js:218-222` 是 ≥70% 绿 / 40–70% 蓝 / <40% 橙红。
   想让图里是绿条，合成数字就得真的落在 70% 以上，而不是去改前端。
5. **"还没调用过"的卡必须字段缺席**：宿主在 `startedAt === undefined` 分支根本不发
   `tokens`/`calls`/`resetAt`（`lib/index.js:368-376`）。写成 `tokens: 0` 会拍出一张宿主永远发不出的
   「0 tok」，徽标也不会是「无官方额度数据」。

另外 ④ 那张图里的"官方卡"必须**不带任何数字**：一旦带了数字，前端会把同供应商的实测兜底卡收掉
（一家只展示一张额度卡），徽标就变空白了。

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

`assertFixture` 会拦：真实痕迹（用户名/盘符/真实余额数字）、不在 `publicCard()` 白名单里的键、
实测卡带百分比、百分比与 `remaining/total` 不自洽、零记录实测卡带了本该缺席的字段、
以及**英文套里出现中文文案**（宿主单语字段除外）。`npm run check` 会连它一起跑。
