# Lens 2 — 安全与信任边界（dsh-token-plan-quota 004-architecture-diagram）

## 评审对象

- 仓库：`C:\Users\OMEN\.dsh\plugins\dsh-token-plan-quota`
- ref：分支 `004-architecture-diagram`，HEAD = `f21f9916559d14e79744daf98488a27bfd6e0d6f`
- 基线：`main` = `863a3463f4661ac71948bc46862332f3b066bc29`
- 分支提交（4 条，`git log --oneline main..HEAD`）：`f21f991` guards / `8deb427` docs / `ca62f3b` diagrams / `02142e7` specs
- 工作树状态：评审开始时 `git status --porcelain` **空**；本次评审只读，除本报告外未新增/修改/删除仓库内任何文件，未执行 `git add|commit|checkout`。

## 评审范围（Lens 2）

凭据只进不出（新公开资产的逐个文件扫描 + 位图读图）·出站主机与 `dshhub.permissions.network` 的一致性 ·新脚本的参数注入/路径穿越/任意文件覆盖 ·零依赖（宪法原则 IV）·合成数据 ·发布面（`package.json#files`）。

## 实际跑过的命令（全部只读）

```
git -C <repo> log --oneline main..HEAD
git -C <repo> diff --stat main...HEAD
git -C <repo> diff --numstat main...HEAD
git -C <repo> status --porcelain
git -C <repo> rev-parse HEAD main
git -C <repo> diff main...HEAD -- README.md README.en.md AGENTS.md scripts/check-docs.mjs
git -C <repo> show -s --format='%H%n%an <%ae>%n%s%n%b' <4 个提交>
git -C <repo> log main --format='%an <%ae>' | Sort-Object -Unique
node scripts/check-manifest.mjs
node scripts/check-submission.mjs
npm run check
npm pack --dry-run --json            # 只读；未产出 tarball
Get-FileHash -Algorithm SHA256 docs\images\architecture.png
Get-FileHash -Algorithm SHA256 diagrams\dsh-token-plan-quota.architecture.json
Select-String 扫 lib/ 与 scripts/ 的 https:// 字面量（带文件:行号）
modlens_read_image docs\images\architecture.png
node %TEMP%\lens2-scan.mjs           # 我自建的只读扫描脚本（见下），不在仓库内
node -e '<PNG chunk 枚举 / 提交信息扫描 / 行内容核对>'
```

补充说明两点工具事实，避免下游误读：

1. 本会话模型 `deepseek-v4.1-flash` **不接受图像输入**，`read_image` 被拒（`does not declare image input`）。位图按任务指定用 `modlens_read_image` 读，另加 PNG chunk 结构检查做旁证。
2. 用于逐文件扫描的脚本我写在 `C:\Users\OMEN\AppData\Local\Temp\lens2-scan.mjs`（仓库外），跑完已删除；仓库工作树始终干净。
   早期我用 pwsh 双引号串内嵌正则做扫描时出现过 **1 个不可复现的假命中**（报在 JSON 第 1 行，而该行只有 `{`，charCode 123）；重写为脚本文件逐条 pattern 复核后该命中**不复存在**，下面的结论以脚本版为准。（教训一致于全局规则"别用 pwsh 做文本度量"。）

---

## 发现

### F1 [LOW] `diagrams/make-diagram-png.mjs:80,142` — `--out` 无扩展名/存在性守卫，直接覆盖任意路径

`const out = resolve(args.out ?? 'docs/images/architecture.png')`（L80）→ 校验通过后 `writeFileSync(out, png)`（L142）。
`--out` 可以是任意路径（含 `..\..\` 或绝对路径），脚本既不要求 `.png` 后缀，也不检查目标是否已存在、是否是 PNG。

**利用/失败场景**：`node diagrams/make-diagram-png.mjs --html x.html --out README.md`（复制参数时手滑）会把已跟踪文件静默替换成 PNG 二进制——已跟踪的可靠 `git checkout` 恢复，**未跟踪的文件（例如开发者自己的一份笔记）不可恢复**。这是自伤型风险：脚本不进 CI、不进 npm 包、不对终端用户暴露，没有任何远程或低权主体能触发它，因此不拔高。可选硬化：要求 `.png` 尾缀，或目标已存在且不是 PNG 时拒绝写入（或先写临时文件再 rename）。

### F2 [LOW] `diagrams/make-diagram-png.mjs:52,90` → `scripts/shots/cdp.mjs:85` — `--edge` 的值被当作可执行文件 spawn

`if (name === 'edge') out.edge = value`（L52）→ `launchEdge({…, edge: args.edge})`（L90）→ `spawn(exe, args, { detached: false, stdio: [...] })`（cdp.mjs:85），参数以**数组**传递且**没有** `shell: true`，因此不存在 shell 元字符注入；但等价于"可以从 argv 指定任意本地可执行文件"。

**利用/失败场景**：只有本机开发者能传这个参数，而能跑这个脚本的人本来就拥有本机代码执行权（跑 `node <脚本>` 就是执行代码），没有权限边界被跨越——真正的风险是文档/工单里被抄成别人的参数串，属自伤。判 LOW，不要求本轮修；若要收口，可限制为 basename 是 `msedge.exe` / `chrome.exe` 的现存文件（保留"无 shell"这一既有优点）。

### F3 [LOW] `diagrams/make-diagram-png.mjs:79,86,95` — 把开发者指定路径的 HTML 当不可信文档加载进无头 Edge

`resolve(args.html)`（L79）→ `pathToFileURL(html).href`（L86）→ `cdp.openPage(url, …)`（L95），即在 Edge 里打开并执行该文档的脚本。

**利用/失败场景**：拿"别人给的 HTML"来裁图 = 在 Edge 里执行该页面的脚本；该页面还能自行向任意主机 POST 数据。同一代码路径里实测到的缓解是真实存在的（读源码确认）：`cdp.mjs:68` 用 `mkdtempSync` 起**全新临时 `--user-data-dir`**（不挂载开发者真实 profile/Cookie），未传 `--no-sandbox`（沙箱保留），`close()` 里 `rmSync` 整目录；也**没有**传 `--allow-file-access-from-files`，所以 Chromium 默认的 `file://` 取数限制未被放宽。残余面只有"浏览器自身 0day + 该页面自愿外发"，无凭据外泄路径。LOW。
**正面**：L86 用 `pathToFileURL()` 而不是字符串拼接 `file://` + path，因此不存在空格/`#`/`?` 把 file URL 改义的问题（读源码确认；未动态执行）。

### F4 [LOW] `AGENTS.md:22`（+ `workflow/REVIEW-CHECKLIST.md:46`，配合新增的 `diagrams/README.md:14-19` 流水线）— 出站主机规则的措辞未限定"运行时"，而本轮新增的开发流水线会新发两个出站主机

**事实（静态取证）**：Archify 查看器模板 `…/@tt-a1i/archify-dsh/skills/archify/assets/template.html` 内联引用外部字体主机——`<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">` 与 `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`；同一技能的**已交付示例** `examples/web-app-rendered.html` 里同样存在这两条（枚举脚本输出：`viewer template external hosts: https://fonts.gstatic.com, https://fonts.googleapis.com`；`delivered example external hosts:` 同上）。因此按 `diagrams/README.md:21-35` 走一遍再生成流程，Edge 一定会对 `fonts.googleapis.com` / `fonts.gstatic.com` 发请求——脚本注释 L102-106 自己也写了"离线时 CDN 字体本就会失败"。

**判断：不应该把这两个主机写进 `dshhub.permissions.network`。依据（不是结论先行）：**

- (a) 该字段描述的是 `dsh plugin add` 装下来的**插件运行时**会联系谁。我独立枚举了 `lib/` 里每一个 `https://` 字面量：`client.js:44-46` = `cdn.jsdelivr.net`；`index.js:11,688` = `api.deepseek.com`；`index.js:743,744,752,753` = `cs-data.qianwenai.com` / `platform-home.qianwenai.com`；`index.js:787-788` = `api.moonshot.cn` / `api.moonshot.ai`；`index.js:811` = `openrouter.ai`；外加 `index.js:46` 的 `endpoint: 'business.aliyuncs.com'`（无 scheme，故 `https://` 扫描不命中）。共 8 个，与声明的 8 条**逐项相等**，即"声明集合 == 运行时集合"在事实上成立（`check-manifest: OK（… 出站主机 8 个）`）。
- (b) 交付 HTML 与 `diagrams/` 都明确不进包（`spec.md:49-50`；`npm pack --dry-run --json` 的清单里**没有任何 `diagrams/` 路径**，而有 `docs/images/architecture.png`）。把字体主机写进声明，等于对外宣称一个"装了插件也永远不会发生"的出站。
- (c) 开发运行时发这些请求的是 **Edge 子进程**，不是插件代码；Node 侧只有 `127.0.0.1`（`cdp.mjs:101` 的 `/json/version` 与 CDP 的 `ws://127.0.0.1`）。

**利用/失败场景**：未来贡献者按 `AGENTS.md:22` 的字面口径（"实际出站主机集合"，无"运行时"限定）把 `fonts.googleapis.com` 补进插件权限表，于是插件对外宣称的出站面被无端放宽；或者反方向误判本轮"声明的集合与事实不符"。修法：把那句话限定为"插件**运行时**"，并在 `diagrams/README.md` 前置一节写明本流水线的两个主机以及为何刻意不声明。判 LOW（文档口径问题，不是代码缺陷）。

### F5 [LOW·既存] `scripts/check-docs.mjs:51-63` — 机械检查的"期望主机集合"只来自 `PRESETS`，从不扫 `lib/` 源码

L52-59 从 `__internals.PRESETS` 的 url/regions/infoUrl 派生期望主机，L60 再把 zh README 里的 `https://cdn.jsdelivr.net` 字面量并进去，然后 L61-63 只做 `declared.has(host)`。也就是说 `AGENTS.md:22` / `REVIEW-CHECKLIST.md:46` 那条"集合相等"只在**预设数据面**上被机械守住。

**利用/失败场景**：有人在非预设代码路径上加一处 `fetch('https://new-vendor.example')`，`npm run check` 仍全绿，包就带着未声明出站主机发出去。**本轮不构成缺陷**：我的独立枚举（见 F4(a)）没有找到未声明项，所以该声称在事实层面成立；我把它记为既存范围限制，是因为 Lens 2 本次要核的正是这条声称。修法（另起改动）：补一条扫 `lib/**/*.js` 的 `https://` 字面量断言，并给 `detect.js:24` 那种"路由形态而非出站"的主机（`token-plan.cn-beijing.maas.aliyuncs.com`，纯函数层零网络）留显式白名单，否则会假红。LOW。

### F6 [LOW·既存] 四份新提交的作者/提交者邮箱（形态：`xjm2…@163.com`，值不在本报告回显）

**利用/失败场景**：公开仓库的抓取者可据此把个人邮箱与 GitHub 账号对应起来，用于垃圾邮件/定向钓鱼。**不是本轮引入**：`git log main --format='%an <%ae>'` 显示 main 上全部既存提交（两种显示名）用的是同一个邮箱，本轮 4 条只是延续。提交信息本体干净：无 `Co-Authored-By`，唯一 trailer 是 `Refs: specs/004-architecture-diagram/`；扫描提交信息正文也没有密钥形态、没有 `C:\…` 本机路径（8 个 email 命中全部来自 author/committer 行 = 4 提交 × 2 行）。要根治得整仓重写历史 + 换 `noreply` 地址，超出本轮范围。

---

## 通过项与正面证据（均有输出支撑）

- **凭据只进不出**：11 个新公开资产逐个扫描（README.md / README.en.md / AGENTS.md / `diagrams/` 三件 / `specs/004-*` 三件 / scripts/check-docs.mjs / 位图），原始命中 4 个，全部良性：
  - `README.md:271` / `README.en.md:311` 的 `env-assignment` 命中 = 既有的配置占位写法（`BAILIAN_CONSOLE_COOKIE: <内容>`）。`git diff --numstat main...HEAD` 显示两份 README 都是**纯新增**（`15 0` / `17 0`，0 删除），该两行未被本轮触碰；且 main 的 README.en 本来就提 cookie 21 次、`BAILIAN_CONSOLE_COOKIE` 2 次 ⇒ 本轮**没有新增凭据披露面**。
  - `diagrams/README.md:51,52` 的 `long-hex-blob` 命中 = 资产与源规格的 sha256（有意公开的完整性指纹），非密钥。
  - 未命中：`sk-` / `ghp_` / `github_pat_` / `glpat-` / `AKID…` / `LTAI…` / `Bearer <值>` / `Cookie=<值>` / `C:\Users…` / `[\\/]Users[\\/]<name>` / 邮箱 / 本机用户名。文档里只出现**键名与形态**（`Bearer`、`AK/SK`、`Cookie`、`BAILIAN_CONSOLE_COOKIE`），符合 README 既有口径。
- **位图内容（读图 + 结构双重取证）**：`modlens_read_image` 的逐词转录里**不含任何数字、账号、用户名、盘符、本机路径、URL、邮箱**；文字与仓库自己的 `diagrams/*.json` 逐条对得上（10 个节点：双向/面板、只读接口面、宿主半边、自动检测层、凭据解析、实测账本、官方余额接口、BssOpenApi、千问控制台数据网关；关系标签 `只读快照`/`注册只读端点`/`识别在用路由`/`按引用名解析`/`Bearer GET`/`AK/SK 签名 RPC`/`Cookie 取 secToken`/`写月份账与窗口锚点`；图例 `Frontend 2 Backend 3 Database 1 Security 1 External 3` = 10，与 JSON 的 10 个 component 的 type 计数一致；`Legend`/`PATH MAP LENS` 属查看器/图例生成物）。PNG 结构旁证：chunk 序列只有 `IHDR + IDAT×47 + IEND`，**没有任何 tEXt/iTXt 元数据块** ⇒ 文件里不存在被写进注释/路径的元数据；`latin1` 探针里 `Users`/`OMEN`/`archify`/`http://`/`file://` 均为 false。
- **零依赖**：`package.json` 的 `dependencies` / `devDependencies` / `optionalDependencies` **三个字段都不存在**（脚本输出 `deps keys: [] devDeps: [] optionalDeps: []`），`check-manifest.mjs:29-31` 也在守这一条。新脚本只 import `node:fs` / `node:crypto` / `node:path` / `node:url` 与仓库内相对路径 `../scripts/shots/cdp.mjs`（后者只用 `node:child_process|fs|os|path`）；**没有任何地方 import Archify**，JSON 规格也不是被脚本 import 的（脚本只吃 `--html`）。Archify 在 `diagrams/README.md:14-19` 被写成"仓库之外的开发前置"，与"事实依赖"区分清楚。
- **发布面**：`npm pack --dry-run --json` 的清单含 `docs/images/architecture.png` 与两份 README，**不含任何 `diagrams/` 路径**；`package.json:67-75` 的 `files` = `lib, docs, cordis.patch.yml, README.md, README.en.md, CHANGELOG.md, LICENSE` ⇒ `diagrams/` 确认不在发布面（`files.includes('diagrams')` = false）。新增位图与两份 README 的内容均适合公开发布（无秘密值、无本机信息、无未公开能力宣称——"Cookie 会话"是 README 既有已发布口径）。
- **资产自证（我独立复算，未采信文档数字）**：`docs/images/architecture.png` sha256 = `b8cae2aab32c1ada44d01a16ecb753661e97ac4a9d851273f75c1bbaea877070`、186 019 B、IHDR 尺寸 **2676×1336**；`diagrams/dsh-token-plan-quota.architecture.json` sha256 = `8615756d…`、4552 B — 与 `diagrams/README.md:50-52` 的记载**逐项相符**。
- **回归与门禁**：`npm run check` 全绿（host 379 / client 207 / guards 80；check-manifest、check-docs、check-refs、check-submission 全 OK）。`git diff --numstat main...HEAD` 显示 `lib/`、`test/`、`package.json`、`cordis.patch.yml` **零改动** ⇒ 本轮没有引入任何新的运行时出站主机或新的凭据读取面。

---

## 本 lens 的结论

**总体**：本轮把一张图入库的四条提交，在 Lens 2 的六个检查面上**没有发现 HIGH / MEDIUM 级问题**；6 条发现全部是 LOW，其中 2 条（F5、F6）明确是既存状况而非本轮引入，F4 是文档口径而非代码缺陷，"注入/路径穿越"三项（F1–F3）按真实威胁模型（本机开发者自用、不进 CI、不进包、不暴露给终端用户）定级，也未把开发便利当终端用户风险。

**我独立复现了的声称**：
1. `npm run check` 全绿与其分段计数（379/207/80 + 7 步）；
2. `check-manifest: OK（出站主机 8 个）`，且声明集合 == 我独立从 `lib/` 枚举出的运行时主机集合（8 项，含无 scheme 的 `business.aliyuncs.com`）；
3. 位图与源规格的 sha256/字节数/尺寸 = `diagrams/README.md` 记载值；位图内无数字/账号/路径（读图），PNG 无元数据块；
4. `diagrams/` 不进 npm 包、`docs/` 进包（`npm pack --dry-run --json` 实测，非读配置推断）；
5. 零依赖：三个依赖字段均不存在，新脚本无第三方 import；
6. 新公开资产无密钥值（逐文件扫描）；两份 README 本轮为纯新增，未触碰既有的 Cookie 说明行；
7. 提交信息无密钥/无本机路径；作者邮箱为既存公开元数据。
8. 查看器 HTML 会对外请求 `fonts.googleapis.com` / `fonts.gstatic.com`（静态取证：技能模板 + 已交付示例两处都在，且与脚本注释自述一致）。

**我没能复现的声称（未证实，卡在哪写清楚）**：
1. **动态**证实无头 Edge 真的发出了那两个字体请求：脚本我**没跑**——它的输入（Archify 渲染好的 HTML）不在工作区，`%TEMP%\archify*` 现在只剩 archify 的 git 克隆。故用"模板 + 已交付示例"做静态取证，属强证据但不是运行证据。
2. 脚本自述的取证数字（裁剪 rect、`--html` URL、产物尺寸）与 `diagrams/README.md:53` 的"连续两次独立运行逐字节相同"：同样因为需要 Archify + Chromium + 联网才能重跑。附一条限定：该确定性结论**依赖 CDN 字体可得性**（在线两次都拿到同一字体才成立），离线回落系统字体栈时产物是否仍逐字节相同，本轮**未证实**。
3. F4 里"若不跑流水线则不会有这些请求"这一点，只能由代码事实推出（脚本只在被调用时启动浏览器），不能由我"不跑它"来证明。