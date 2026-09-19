# Lens 1 — 正确性与健壮性 · 004 架构图入库

## 评审对象

| 项 | 值 |
|---|---|
| 仓库 | `C:\Users\OMEN\.dsh\plugins\dsh-token-plan-quota` |
| 被评 ref | 分支 `004-architecture-diagram`，HEAD = **f21f991** |
| 基线 | `main` = **863a346** |
| 提交序列 | `02142e7`（specs）→ `ca62f3b`（diagrams/）→ `8deb427`（README 双语）→ `f21f991`（check-docs + AGENTS） |
| 改动面 | 11 文件 / +562 −3：`lib/` 与 `test/` **零改动**；机械检查只改 `scripts/check-docs.mjs` |

**冻结核对**：评审开始前 `git status --porcelain` 为空；全部实验结束后仍为空，
`git diff --stat HEAD` 为空，HEAD 仍是 `f21f991`。全部反向/等价实验都在
`C:\Users\OMEN\AppData\Local\Temp\lens1-004\` 里做（副本 + 只读 import + `--out` 到临时目录），
没有改过仓库里任何文件。`specs/004-architecture-diagram/reviews/` 由调用方在本会话期间创建
（我首个检查时它还不存在，里面已有另两份 lens 报告）；除本报告外我没有写任何文件。

## 评审范围（Lens 1）

本轮 `lib/` 零改动，所以只走与本轮相关的面：**修改了的门禁**（`check-docs.mjs` 第 10 项清单 +1
与新增点名断言）的行为矩阵与可证伪性、**新断言**的误报面与漏检面、**新取证脚本**
（`diagrams/make-diagram-png.mjs`）的自证与阈值、**测试本身**（`check-docs` 改动 +
`.scratch/004/falsification.mjs`）、**文档与资产一致**（记录值 vs 实际文件）、以及
**图的内容准确性**（用 `modlens_read_image` 读位图，与代码逐条对照）。
运行时缺陷类（信封、方向/单位、降级链、资源生命周期）本轮不适用，未逐条走。

## 实际跑过的命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `git log --oneline main..HEAD` / `git diff --stat main...HEAD` / `git status --porcelain` | 4 提交、11 文件 +562 −3；工作树干净 |
| 2 | `node scripts/check-docs.mjs` | `check-docs: OK（配置键 17、数据源 8、出站主机 8、host 379 / client 207 / guards 80）`，exit 0 |
| 3 | `node .scratch/004/falsification.mjs` | 基线绿 + **五条反向用例全红** + 3 文件逐字节还原；exit 0；跑完 `git status --porcelain` 为空 |
| 4 | 临时副本 ×9 变体：`node scripts/check-docs.mjs`（见 §A） | 5 种写法放行、**3 种无害写法假红**、1 种绕过 |
| 5 | 同变体再跑 `git show main:scripts/check-docs.mjs`（修复前） | D/E/H/J/K 修复前 exit=0 → **D/E/H 是本轮新引入的假红** |
| 6 | `node scripts/link-targets.mjs` 只读 import 统计两份 README 的图片引用 | zh 8 张 / en 7 张，全部 `relative` 且存在 |
| 7 | `node docs/images/architecture.png` 结构校验（自写，只读） | 签名/IHDR/IEND 齐全，**2676×1336**，186019 B，无 tIME/tEXt 块，无尾部垃圾 |
| 8 | `archify validate architecture diagrams/…json --quality showcase --json` | **ok:true，9/9 检查通过，showcase/pass，errors 0，warnings 0** |
| 9 | `archify deliver … --quality showcase --json`（输出到临时目录） | 回执：spec `8615756d…`/4552 B，artifact `8957056b…`/641,980 B，9/9、0 error / 0 warning |
| 10 | `node diagrams/make-diagram-png.mjs --html <交付>/architecture.html --out <临时>/repro2.png` | **186019 B，sha256 `b8cae2aa…` —— 与入库位图逐字节相同** |
| 11 | CDP 量四档视口（自写，只读 import `cdp.mjs`） | 1440/1600/1920/2048 → 底部空白 **44/44/44/64 px**，四档 `fitsX/fitsY` 全 true，无溢出 |
| 12 | CDP 同裁剪区量字节（自写） | 纯白 13198 B；只剩背景（= 白图）**19304 B**；错位区 119851 B；正常 186019 B |
| 13 | 注入第二个 `svg[data-quality-profile]` 后跑真脚本 | **exit 0**，写出 96856 B 的"标签全丢"位图（自证放行） |
| 14 | `npm run check` | 七步全绿：379/207/80 passed，check-manifest / check-docs / check-refs / check-submission 全 OK |
| 15 | `modlens_read_image docs/images/architecture.png`（两次，第 2 次专问三块边界标题） | 见 §E |

---

## 发现

### [MEDIUM] `scripts/check-docs.mjs:355-362` — 新增点名断言只认"行内 markdown 图片"，三种无害写法被新判成红（修复前是绿的）

失败场景：维护者为了控制图片显示宽度把那一行换成
`<img src="docs/images/architecture.png" width="900">`（README 常见手法），或改用引用式定义
`![arch][a]` + `[a]: docs/images/architecture.png`，或按本项目自己在 `check-docs.mjs:109` 给的
整改建议「改成绝对链接」——CI 立刻红，而报错说「README.en.md 没有引用 docs/images/architecture.png：
结构图必须双语同源」，**README 其实引了**，作者会去查一个不存在的问题。

实测（临时副本，端到端跑真的 `check-docs.mjs`）：

| 写法 | 修复后 HEAD | 修复前 main |
|---|---|---|
| 原样 / `./` 前缀 / `"title"` / `<尖括号>` / `docs/./images/…` / `docs//images/…` | exit 0 | exit 0 |
| **HTML `<img src="…">`** | **exit 1**（"没有引用…双语同源"） | exit 0 |
| **引用式定义 `![x][r]` + `[r]: docs/images/architecture.png`** | **exit 1**（同上） | exit 0 |
| **绝对 GitHub URL**（`https://github.com/…/docs/images/architecture.png`） | **exit 1**（同上） | exit 0 |
| 围栏代码块 / 行内代码里塞一张 | exit 1 | exit 0 ← 这两条**是对的**（`stripCode` 生效，不算引用） |

根因：断言用的 `extractImageTargets`（`scripts/link-targets.mjs:87-89`）只扫 `![…](…)` 内联形态；
`extractLinkTargets` 的另一半覆盖（`link-targets.mjs:76-77` 的引用式定义与 `href="…"`）在图片侧完全没接上，
而 HTML 侧只认 `href=`、不认 `<img src=>`。写这段断言时的注释声称「比照 `classifyTarget` 归一化后再比，
避免写法不同（`./docs/...`）造成假红」——归一化只覆盖了 `./`/title/尖括号/`./`/`//`，确实挡住了这 6 种，
但**没有覆盖 HTML / 引用式 / 绝对 URL 三种**。降级说明：本条不是"新检查没生效"，而是"新检查比它自称的窄"。

### [MEDIUM] `specs/004-architecture-diagram/tasks.md:30-32` — "检查逻辑未变"与事实不符，而这正是本轮不做常驻行为矩阵的理由；新断言因此没有任何常驻测试

失败场景：下一次有人为了让上面那条假红消失，把比较放宽（例如 `kind === 'skip'` 也放行、或直接删掉
`kind === 'relative' &&`），`test/guards.mjs` **不会有任何反应**——它 80/80 全绿，"双语同源"这个保证
静默消失，而没人会注意到。

`tasks.md:30` 写：「只在既有第 10 项的硬编码清单上加一条路径，检查**逻辑未变**。因此
`workflow/PLAN.md` 第 8 节要求的"行为矩阵"对本轮而言是**可证伪证据**，而不是一份新的常驻矩阵」。
事实：diff 新增了 11 行断言（`check-docs.mjs:352-362`），含一条**新的归一化比较语义**——这不是"清单 +1"。
而 `scripts/link-targets.mjs:4-8` 恰好把这条规矩写成了模块级理由：「这两件事恰恰**必须有常驻行为矩阵**
——只有进了测试才守得住、才可能进 CI 的三平台矩阵」，并为此把函数抽出了顶层脚本。
本轮新逻辑又写回了**顶层执行的** `check-docs.mjs`（import 它等于跑整套检查，`test/guards.mjs` 测不到）。

核对：`test/guards.mjs:22` 确实 import 了 `extractImageTargets`，`:223/:226` 只有 2 条用例
（"图片只取图片""图片文字含方括号"）；全仓库搜 `双语同源|DIAGRAM|architecture\.png` 的 `.mjs`
只在 `check-docs.mjs:355-361` 与 `diagrams/make-diagram-png.mjs:80` 命中，**guards 里没有**。
配合上一条：`REVIEW-CHECKLIST.md:36-38` 要求的"边界形态"矩阵若真做了 9 种写法，其中 3 种当场就会暴露。

### [MEDIUM] `diagrams/make-diagram-png.mjs:37-38` — `MIN_BYTES = 20000` 的论证依据偏了约 3 倍，对真实白图只剩 696 B 余量

失败场景：换一个 Chromium 构建（README 自己写了「换版本可能变」），同一张白图的 PNG 编码从 19.3 KB
涨到 20.5 KB，脚本 exit 0 把**空图写进仓库**并打印一行"产物 字节/尺寸"当成功；门禁也放行
（`check-docs.mjs:331` 对这张图只要求 ≥ 1024 B）。

用**真实 Chromium**在同一裁剪区（`x=131 y=94 w=1338 h=668 scale=2`，即入库产物的裁剪区）量的字节数：

| 画面 | 字节 | ≥ 20000? |
|---|---|---|
| `about:blank` 纯白 | 13,198 | 否 |
| 抽掉全部 `<text>`（无标签） | 91,415 | 是 |
| 抽掉 `rect/path/g` 只剩背景 | **19,304** | **否（差 696 B，96.5%）** |
| `svg` 可见性置 hidden（= 真·白图） | **19,304** | **否（差 696 B）** |
| 同尺寸但裁到页面别处 | 119,851 | 是 |
| 正常产物 | 186,019 | 是 |

脚本注释写「2676×1336 的纯色 PNG 压出来只有几 KB，20 KB 足以把"截到一张白图"挡掉」：
纯白实测 13.2 KB 是"十几 KB"不是"几 KB"，而**真实失败形态不是纯白、是"页面背景"**（19.3 KB），
余量 3.5%。这条阈值目前仍然**有效**（我没能构造出被放行的白图），但它的安全性远低于注释声称的程度。
另外：文档承诺的 20 KB 下限**没有出现在门禁里**——真正守这张资产的字节下限是 `check-docs.mjs:331` 的 1024 B。

### [MEDIUM] `diagrams/make-diagram-png.mjs:109-140` — 自证只验"格式 + 尺寸 + 体积"，不验"裁到的确实是这张图"；实测被放行一张标签全丢的图

失败场景：Archify 查看器将来多出一个同样带 `data-quality-profile` 的元素并排在前面
（脚本 `:34` 的注释自己就写了「查看器工具栏里也有 svg 图标」，说明作者已知有第二个 svg 的风险），
或 `rectOf` 读到布局未稳的旧矩形 ⇒ `querySelector` 选中错误的元素 ⇒ 脚本 exit 0、打印成功，
仓库里换上一张内容不对的图；`npm run check` 无法分辨。

实测（把"真实 svg 去掉 title/desc/全部 `<text>`"的副本插到 body 最前，它同样匹配选择器）：

```
裁剪区  : x=194 y=94 w=1212 h=605
尺寸    : 2424x1210 px（2×）
字节    : 96856
exit=0                      ← 全部自证通过
```

自证的四道闸——选择器存在（`:110`）、rect 非空（`:111`）、落在视口内（`:113-120`）、
IHDR 与 `rect×scale` 一致（`:130-134`）、体积在 [20 000, 400 000]（`:135-140`）——**没有一道涉及内容**。
"同尺寸但裁到页面别处"实测 119,851 B，同样落在合法区间内。
公正说明：`plan.md:83` 与 `diagrams/README.md:66` 都**如实承认**"位图无法被机械检查核内容"，
所以"内容错抓不到"是已记录的盲点；**未记录**的是脚本头部自称的"空数据不许伪装成结论"在
"截错元素/裁错区域"这一路上并不成立，而且它打印的是成功行、不是告警。

### [LOW] `scripts/check-docs.mjs:355-362` — "必须双语同源"可被 HTML 注释绕过（实测绿）

失败场景：有人改这一节时把图片那行临时包进 `<!-- -->`（或整块注释掉），README 渲染后**没有结构图**，
而门禁 exit 0——点名断言认了注释里的引用，第 10 项的数量下限也照样满足。

实测：把 `![…](docs/images/architecture.png)` 换成 `<!-- ![architecture](docs/images/architecture.png) -->`
⇒ `node scripts/check-docs.mjs` **exit=0**（修复前 main 也是 0，即这是新断言留下的新窗口，不是旧问题）。
同一实验对照组：放进围栏代码块或行内代码里会**正确报红**（`stripCode` 生效），说明抽取链路本身是好的，
缺的是"忽略 HTML 注释"这一步。

### [LOW] `diagrams/README.md:53` — "两次独立运行逐字节相同"只在本机"字体加载不到"的状态下成立，文档没写这个前提

失败场景：一位有外网（能拿到 Google Fonts）的维护者按 `diagrams/README.md:23-34` 的三步照做，
得到与记录值 `b8cae2aa…` **不同**的 sha256，于是认为"记录的产出校验不成立/流水线坏了"。

证据链：交付 HTML 里有 `@font-face` ×2、引用 `fonts.googleapis.com`（`css2?family=JetBrains+Mono…`）
与 `fonts.gstatic.com`（我实测读出的 3 个外部 URL），`font-family` 首选 `'JetBrains Mono'`；
脚本 `:102-107` 把字体就绪做成"8 秒等不到就告警继续"。我这 4 次运行（入库那份 + `repeat-check.png`
+ 从 scratch HTML 重出 + 从**新交付**的 HTML 重出）全部打印"字体未在 8s 内就绪"，四次位图逐字节相同。
**未能证实**的部分：我无法在这台机器上让 webfont 真的加载，因此"字体到位后位图会变"只是机制推断，
没有实测字节差。

### [LOW] `docs/images/architecture.png`（内容） — 图里没有浏览器半边的出站主机 `cdn.jsdelivr.net`

失败场景：读者按这张"三块边界怎么串起来"的图理解架构，会以为浏览器半边不发出任何网络请求；
实际 `lib/client.js:44-46` 在浏览器侧加载三个 `https://cdn.jsdelivr.net/npm/@fontsource-variable/…`
样式表，而这个主机正因"真实出站"才被列进 `package.json#dshhub.permissions.network`（8 个之一）。
这是**漏画**（不是画了不存在的能力），严重度低；但 FR-006 要求"图上每个节点与每条关系都能指到代码出处"，
反向的"实际存在的出站面没画"没有读者能从图上发现。

### [LOW] `scripts/check-docs.mjs:20` — 文件头的第 10 项索引段仍写"十三张截图"，已不描述现在的第 10 项

失败场景：下一位 agent 只读索引，认为第 10 项只守 13 张截图，于是把新的结构类资产放进
`docs/` 却不去看那条**硬编码单路径**的点名断言，重复本轮要解决的问题。

第 10 项现在是 14 条路径（13 张截图 + `architecture.png`）+ 一条点名双语断言，块内注释
（`:303-308`）已改，但文件头 `:20` 的「10. 十三张截图（中文 7 张 / 英文 6 张）真实存在且 README 已引用」
没跟着改。

### [LOW] `.scratch/004/falsification.mjs:17` — 五条反向用例的取证脚本硬编码绝对路径且被 gitignore，冻结提交里无法重跑

失败场景：另一个 checkout / CI 上的评审者拿到 `f21f991` 后**无法复现**"五条用例全红"这个声称，
能拿到的只有 `f21f991` 的提交信息文本（`msg-4.txt` 同文）；我之所以能跑出
"基线绿 + 5 条全红 + 逐字节还原"，只是因为这份脚本恰好还在本机工作树里。

`const root = 'C:/Users/OMEN/.dsh/plugins/dsh-token-plan-quota'` 是硬编码的；`.scratch/` 在
`.gitignore` 里（第一条）。同一脚本的自证只比对 3 个文件（README ×2 + PNG），
用例 4 新建/删除的 `diagrams/_probe.png` 若残留不在自证范围内（会以未捕获异常 exit 1，而不是约定的 exit 2）。

### [LOW] `specs/004-architecture-diagram/tasks.md:8-20`、`plan.md:125-134` — T001–T008 与 Steps 1–8 全部仍未勾选，而其中 6 项已由提交落实

失败场景：`tasks.md:3-4` 自己写「交付前必须把勾选状态对齐事实……下一位 agent 会按"这一步没发生"重做」，
但 T001–T006 对应的实现已在 `02142e7`/`ca62f3b`/`8deb427`/`f21f991` 落地，T007 已被实际执行、
T008 我实测 `npm run check` 七步全绿，勾选框却全是 `- [ ]`。下一位 agent 会重做已完成的工作。

---

### 已核对为**正确**的项（不作为发现，仅记录已核过的面）

- **资产记录值全部对得上**：`diagrams/README.md:50-52` 记的 `2676×1336 px（2×） / 186019 B`
  与位图 sha256 `b8cae2aab32c1ada44d01a16ecb753661e97ac4a9d851273f75c1bbaea877070`，
  以及源规格 `8615756dc15cfa113c942143ab426d4b7dba069c41c5cbb796fcfa5b68e22ecd（4552 B）`
  ——我用 `createHash` 逐个实测，**三项完全一致**；`plan.md:32` 的前提 8 同值。
- **FR-002 的"可再生成"整链独立复现**：`archify validate`（9/9、showcase/pass、0 error / 0 warning）
  → `archify deliver` 回执 spec=`8615756d…`(4552 B)、artifact=`8957056b…`(641,980 B)，与 `plan.md:32`
  记录的两个哈希**逐位相同** → 用**新交付的** HTML 跑 `make-diagram-png.mjs` 得到
  `186019 B / b8cae2aa…`，与入库位图**逐字节相同**。也就是说 steps 1–3 全链可从仓库文件重放。
- **`plan.md:31` 的四档视口数字复现**：底部空白 44 / 44 / 44 / 64 px（1440 / 1600 / 1920 / 2048），
  四档均在视口内（`fitsX`/`fitsY` 全 true）。
- **位图结构合法**：签名 / `IHDR` / `IEND` 齐全，chunk 序列只有 `IHDR:1 + IDAT:47 + IEND:1`（实测计数），
  **没有 `tIME`/`tEXt` 块**（这本身是确定性的一条好证据），无尾部多余字节。
- **`MIN_BYTES`/`MAX_BYTES` 的兄弟文件量级说法准确**：实测 `docs/images/` 现有 13 张为
  106,701 – 342,122 B，与 `make-diagram-png.mjs:40`／`tasks.md:36` 的"106–342 KB / ≤400 KB"相符。
- **选择器的唯一性目前成立**：交付 HTML 里 `data-quality-profile` 恰好 1 处、`<svg` 恰好 1 个。
- **图的内容与代码逐条相符**（`modlens_read_image` 两次读图）：三块边界标题确实都在
  （`DSH 宿主进程 (profile: web)`、`浏览器 · Web GUI (React 半边)`、`上游供应商 (只读端点)`，均未被裁切），
  10 个节点、9 条关系标签、图例 `Frontend 2 / Backend 3 / Database 1 / Security 1 / External 3` 齐全，
  与 `diagrams/README.md:60` 的"10 个节点、9 条关系及标签、图例"一致。逐条对代码：
  `secToken`（`lib/index.js:729,1594-1615`）、`BssOpenApi + AK/SK`（`:12,46`）、
  `/token-plan-quota/* · 模型工具`（`:2619-2693` 四个只读子路由 + `:2453` `token_plan_quota` 工具）、
  `llm/stream 记本实例账本`（`:2585`）、只读路由标量与打码凭据（`:21`）、
  `React 半边`（`lib/client.js`：98 处 react / 149 处 createElement）、
  `零配置 · 零网络`（`lib/detect.js` 纯函数层，AGENTS.md 规则）；
  **"明确不做的三类"没有被画成已支持**（它们只出现在源规格的 `cards` 里，而 `diagrams/README.md:61-62`
  说明了三张结论卡不进位图——我读图确认位图里没有这些卡）。
  两个千问主机（`cs-data` 取数 + `platform-home` 取 secToken）分别对应节点与箭头标签，均已覆盖。
- **`plan.md:32` 的 CI 口径**：`.github/workflows/ci.yml:17` 是 `node: ['20','22']` ×
  `[ubuntu, windows, macos]`，而源规格 `cards` 里"node 20 / 22 × 三平台"准确；
  `host 379 / client 207 / guards 80` 与我实测的 `npm run check` 输出逐项一致。
- **FR-001 的发布面**：`docs` 在 `package.json#files` 内（位图随包发布），`diagrams/` 不在（README 说"不随包发布"属实）；
  两份 README 用相对路径引 `docs/images/architecture.png`（各 8 / 7 张图片引用，全为 `relative` 且存在），
  对 `diagrams/README.md` 用的是绝对 GitHub 链接——与既有 `scripts/shots/README.md`、`workflow/README.md`
  等 9 处同形，org/repo 与 `git remote -v` 的 `xinghe-1018/dsh-token-plan-quota` 一致，第 4b 项正确跳过。
- **"能失败"**：独立复现，五条反向用例全红且报错行与声称一致（删除 / 0 字节 / 错路径 / 未发布目录 / 单侧撤引用），
  且跑完逐字节还原、工作树干净。

## 本 lens 的结论

**整体判断**：本轮把资产入库这件事本身是对的且证据链异常完整——我第一次见到"规格哈希 → 交付产物哈希 →
位图哈希"三级都能从冻结提交重放、并且位图内容与代码逐条对得上的入库。`lib/` 零改动、`npm run check` 全绿、
`docs/` 随包发布的判定也正确。缺陷集中在**新加的那条门禁断言与那个取证脚本的"自称强度"**上：
它们都工作了，但都比注释里说的窄——新断言把 3 种无害写法判成红（修复前是绿的），
又能被 HTML 注释绕过；`MIN_BYTES` 对真实白图只剩 696 B 余量；
取证脚本的"自证"不含内容，我实测让它成功放行了一张标签全丢的图。
另有 `tasks.md` 的"检查逻辑未变"与事实不符，而它正是本轮不做常驻行为矩阵的理由——
这条我认为必须回填，因为它会让下一次放宽断言的改动无人可拦。

**我独立复现了的声称**（都有上面的命令输出）：
1. `npm run check` 七步全绿（379/207/80 + 4 个自检脚本），`lib/` 零改动的回归面无变化。
2. 五条反向用例：基线绿、五条全红、跑完 3 文件逐字节还原、`git status` 干净。
3. `archify validate` 9/9、showcase/pass、0 error / 0 warning；`archify deliver` 回执的
   spec `8615756d…`/4552 B 与 artifact `8957056b…`/641,980 B 与 `plan.md:32` 记录一致。
4. 位图 `2676×1336`、`186019 B`、sha256 `b8cae2aa…`；从**新交付的** HTML 重出位图逐字节相同。
5. `diagrams/README.md` 记录的两个 sha256 与两个字节数、`plan.md:31` 的四档视口空白 44/44/44/64。
6. 位图里三块边界标题、10 节点、9 关系标签、图例计数齐全，且与 `lib/index.js` / `lib/detect.js` /
   `lib/client.js` 的出处逐条对得上；"明确不做的三类"没有被画成已支持。
7. 新断言对 `./` 前缀、title、尖括号、`docs/./`、`//` 等 6 种写法**不误报**（作者注释里的这个声称成立）。

**我没能复现 / 无法证实的**：
1. **"字体到位后位图会变"** —— 机制成立（HTML 引用 Google Fonts ×2，`font-family` 首选 JetBrains Mono，
   脚本对字体就绪只告警不阻断），但我在这台机器上让 webfont 加载不到，拿不出字节差。所以
   "逐字节确定性"这条我只验证了**离线字体状态**下的 4 次一致。
2. **位图内容无法被机械校验**（本轮已如实记为盲点）——我只能用读图 + 人工对代码，不能证明"下一个提交后它仍然对"。
3. **`modlens_read_image` 首次读图时的两处 OCR 歧义**（"点明明细/点开明细"、"窗口端点/窗口锚点"）：
   第二次聚焦读图给出的是 `点开明细`、`月份账 + 7 天窗口锚点`，与源规格一致——这两处判定为**读图工具的
   歧义，不是图与规格不一致**。图里的小号标签在读图链路里确实易被降采样糊掉，我未能在像素级独立确认每个字符。
4. **Archify 侧的可编辑性**：我验证了"按说明能重产出同一张图"，但没有改规格再渲染一次，
   因此"改规格即可再生成"这一半（FR-002 的可编辑真源）未实测。