# Lens 2 — 安全与信任边界（只读评审）

- **对象**：`dsh-token-plan-quota`，分支 `002-publish-surface-links`，被评审提交 `5921a07`（实现）与 `fa9ae88`（任务勾选）
- **评审依据**：`workflow/REVIEW-CHECKLIST.md` 的 "Lens 2 — 安全与信任边界" 一节（只执行该节）
- **日期**：2026-09-18 · **只读**：本文件是本次唯一写入；未做任何 git 写操作、未改任何其它文件
- **HEAD 核对**：`git status --porcelain` 全程只有 `?? specs/002-publish-surface-links/qa-report.md`（评审前既存），评审未改变工作树

## 结论（先说结果）

1. **发布面没有扩大，且内部工程材料零进入。** `package.json#files` 未被改（`git diff 5921a07^ 5921a07 -- package.json` 输出为空）；`npm pack --dry-run --json` 实测 **24 files**（与提交信息一致，非采信）；实测对照包内路径清单，`specs/`、`workflow/`、`AGENTS.md`、`.specify/`、`scripts/` 在包内**命中数 = 0**。`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` 实测均为 `undefined`（未新增依赖）。
2. **新增的 5 条绝对链接指向可信域名且不泄露内部信息。** 全部形如 `https://github.com/xinghe-1018/dsh-token-plan-quota/blob/main/<path>`，owner/repo 与 `package.json#repository` / `homepage` 完全同源；`/Users/`、`C:\`、`127.0.0.1`、`192.168.`、内网域、真实邮箱、本机用户名在这些改动行上**零命中**。链接目标串（`ROADMAP.md`、`SECURITY.md` 等）在改动前就已经以相对链接形式公开在 README 正文里，绝对化**不新增任何披露**。
3. **新增检查本身不做文件读取，无路径穿越面，正则无灾难性回溯。** 用 monkeypatch 计数实测：跑完 4b 整段（`scripts/check-docs.mjs:74-88`）产生 **0 次 `readFileSync` / `existsSync` / `statSync` / `readdirSync`**——它只是字符串比对。4MB 单条链接输入耗时 4ms、20 万层括号 1ms（正则只有否定字符类、无嵌套量词）。README 文本**不流入任何进程调用或动态正则**（`execFileSync` 的参数全为字面量/`process.execPath`）。
4. **`SECURITY.md` 作为公开仓库文件是安全的**，里面只有键名与工具通用路径（`BAILIAN_CONSOLE_COOKIE`、`~/.codex/auth.json` 等），无任何值、无秘密、无内网信息；把它接成 npm 面可点通，是**信任面的改善**（此前那份安全策略在包页上是 404）。
5. **未与安全立场冲突**：`README.md` 「已知边界」(L344) /「明确不做的三类」(L354) 的**正文一字未动**（CRLF 归一 + 抹掉链接目标后，两份 README 的前后文本**逐字相同 = true**）；`AGENTS.md` 的 Do-not-touch 全未触碰（提交未含 `AGENTS.md`、`lib/`、`test/`、`docs/images/`、`.env*`、凭据）；`dshhub.permissions.network` 未变（github.com 只是给**人**点的文档超链接，插件不对它发请求）。
6. **一个实质问题（MEDIUM，F1）**：新增的 4b 只抽内联 `](…)` 形式，**带标题属性的链接与引用式链接可静默绕过**，而它声称关闭的正是这一类——见我给出的可复现反例（同一段文本下 `npm run check` 判绿）。

**发现计数：5 条（1 MEDIUM + 4 LOW）。无 CRITICAL/HIGH。** 两条 LOW（F3/F4）是关于**已发布 tarball 永不改变**这一性质的固有取舍，不阻塞；F5 是**本提交之前就存在**的行为，仅作记录。

---

## 发现

### F1 — [MEDIUM] `scripts/check-docs.mjs:77` — 4b 只覆盖内联链接形式，标题属性/引用式链接可静默绕过，防线声称的"这类问题不可能再悄悄上线"不成立

`/!?\[[^\]]*\]\(([^)\s]+)\)/g` 要求目标后面**紧跟 `)`**（`([^)\s]+)\)`）。于是两种合法的 Markdown 相对链接写法都抽不到：

- **标题属性**：`[安全策略](SECURITY.md "安全策略")` —— 目标后是空格，4b 无匹配；
- **引用式**：`见[安全策略][sec]` + `[sec]: SECURITY.md` —— 没有 `](` 结构，4b 无匹配。

而这两条同时**也躲过第 4 项**（`check-docs.mjs:66` 的 `[^)#\s]+` 会抽出 `SECURITY.md`，但 L67 的 `existsSync(join(root, link))` 因为文件**在仓库内存在**而放行）。**实测反例**（用文件里逐字复制的两条正则，输入为合成 README 片段）：

```
A inline   [安全策略](SECURITY.md)              | item4-fails=[] 4b-fails=["SECURITY.md"] => CI RED
B title    [安全策略](SECURITY.md "安全策略")    | item4-fails=[] 4b-fails=[]              => CI GREEN
C angle    [安全策略](<SECURITY.md>)             | item4-fails=["<SECURITY.md>"] ...        => CI RED
D refstyle 见[安全策略][sec] + [sec]: SECURITY.md | item4-fails=[] 4b-fails=[]             => CI GREEN
```

**利用/失败场景**：维护者下轮把 `README.md:368` 那行改成 `[`SECURITY.md`](SECURITY.md "安全策略")`（或者把 5 个目标写成引用式定义，`CHANGELOG.md` 已经在用引用式定义这种写法，`README` 目前 0 处只是巧合）。`npm run check` 全绿、`git push` 无阻力；而这个包一旦发版就**永久**带着一条在 npm 包页 404 的安全策略链接——读者点不开 COOKIE 风险那段说明，正是本次改动想消灭的那类坑。当前工作树上这两种写法**均不存在**（实测 title-attr 命中 0、引用式定义 0），所以是**潜在**回归面，不是当前缺陷。

**修法方向**（供实现会话独立确认，不是"必须照做"）：抽取时把"标题属性"（`(target "title")`）与引用式定义（`^\[[^\]]+\]:\s*(\S+)`）一并纳入，或对 README 用统一的力量更弱的抽取（`](` 之后取到第一个空白/`)` 为止）后再各自排除图片；并把 B/D 两个反例补进 FR-002 的可证伪用例（现在只有 A 形态被证伪过）。

### F2 — [LOW] `scripts/check-docs.mjs:75` — `isPublished` 自行重实现了 npm `files` 语义且不处理否定条目，将来会给出假绿

`publishedFiles.some(f => target === f || target.startsWith(f.replace(/\/$/, '') + '/'))` 只理解"纯目录前缀"。npm 的 `files` 语义还支持否定（`"!docs/internal"`）与始终收录（`README*`/`LICENSE*`/`main` 入口）。**场景**：将来出现 `"files": ["docs", "!docs/internal"]` 时，一条 `[内部契约](docs/internal/contract.md)` 会被 4b 判为"随包发布"→ 绿，而 tarball 里根本没有该文件 → 本次修掉的 404 类别原样复发，且这次连防线都判绿。当前 `files` 无否定条目（实测：7 条全为普通目录/文件），所以是**潜在**问题。（注：`files` 缺失时 `?? []` 会让每条相对链接报红，方向是 fail-closed，安全。）

### F3 — [LOW] `README.md:368`（及 `48/49/385/386`；`README.en.md:426/446/447`）— 绝对链接钉在可变分支 `blob/main` 上，而承载它的 npm 包是**永久不变**的

`blob/main` 是可变引用。**场景**：用户装 `0.4.8`（tarball 永不改），点开 `SECURITY.md` 读到的是**当时 main** 的文本。若 main 之后改变了安全承诺（例如给某源加了新的凭据读取路径、放宽了 Cookie 处理口径），`0.4.8` 的读者会拿**新文本**去判断**旧代码**——"读到的保证与实际运行的代码不同源"，恰是信任边界最怕的那种错配。修法可选：钉 tag（`blob/v0.4.8/…`）或把这 1-2 份安全相关文档纳入 `files`。不阻塞：先前相对链接在包页是 404，**可点开但可能不同源**比**打不开**更好。

### F4 — [LOW] `README.md:48`（5 条链接同源）— 文档内容链接从此依赖 GitHub 命名空间的持续控制权

已发布的 tarball 不可修改，而它里面的 README 现在指向 `github.com/xinghe-1018/dsh-token-plan-quota`。**场景**：仓库被删除/转移、或 owner 改名后该名字被他人注册时，**所有历史版本的 npm 包**的 README 会指向第三方可控内容（GitHub 对改名/转移有重定向，但删除后名字可被重新注册）。这正是本次问的"有没有把原本指向仓库内的链接变成别人可控的内容"——**今天没有**（owner/repo 与 `repository` 字段一致、都是本人），但引入了该依赖。评 LOW 而非更高：`package.json` 的 `repository`/`homepage`/`bugs` 早就是同一命名空间的绝对 URL，本次没有新增"这类依赖"的种类，只是把它扩到了 5 个内容链接。

### F5 — [LOW] `scripts/check-docs.mjs:67` — 第 4 项把 README 链接直接 `join` 到仓库根后 `existsSync`，可探测仓库外路径（**本提交之前已存在**，非本次引入）

`if (!existsSync(join(root, link)))`，`link` 取自 README 文本；`](../../../../etc/passwd)` 这类目标会被 `path.join` 解析到仓库根之外。**影响**：仅"文件存在性 oracle"（不读内容、不返回内容），且 batch 里同时会落进报错文案；要触发需先获得 README 写权限（此时仓库已经失守），故 LOW。**与本 lens 问题 3 的对照要点**：新增的 4b（L74-88）**刻意没有**走这条路——实测 0 次 fs 调用，是纯字符串比对，所以 4b 自身**无路径穿越面**；风险只存在于既有的第 4 项。

---

## N/A 项（不静默跳过，逐条给理由）

| Lens 2 检查项 | 判定 | 理由 / 证据 |
|---|---|---|
| 凭据只进不出（路由响应 / 日志 / 错误串 / 快照 / 截图） | **N/A** | 两个提交都未触碰凭据路径：`lib/`、`test/` 零改动（`git diff 5921a07^ 5921a07 --stat -- lib test scripts` = 仅 `scripts/check-docs.mjs` +20 行）；新增代码只处理 README 链接串。`specs/*.md` 与提交正文对 `sk-`/`Bearer `/`cookie=`/`C:\Users` 扫描零命中。4b 会把链接目标原样打进报错文案，但链接目标本来就公开在 README 里，不构成新增泄漏面 |
| 出站主机 == `dshhub.permissions.network` | **N/A** | 无新增运行时出站主机：`package.json` 未被本次提交改动，网络声明仍 8 条，插件代码无改动。新增的 `github.com` 只出现在 README 的**文档超链接**里，插件不对其发请求，因此**不应**进该声明；`check-docs` 第 3 项只扫 `cdn.jsdelivr.net`，不会也不该因此报警 |
| 注入（上游文本进 tooltip/面板/徽标前转义、Cookie 回退输入校验） | **N/A** | 无渲染层/上游处理层改动（`lib/` 零改动）。另外核过本次新增代码的注入面：`execFileSync` 参数全为字面量或 `process.execPath`（L93/157/160/163），动态 `new RegExp`（L101-102）的插值变量 `suite` 来自字面量数组 `['host','client']`，README 文本不流入任何进程/正则 → 无命令注入、无 ReDoS（实测 4MB 输入 4ms） |
| 零依赖（`dependencies` 为空；新增依赖需查 slopsquatting） | **通过（非 N/A）** | 实测 `dependencies/devDependencies/peerDependencies/optionalDependencies` 全为 `undefined`；两个提交都未改 `package.json` |
| 外壳差异（座位探测/降级路径不引入样式或 DOM 注入） | **N/A** | 无客户端/外壳代码改动 |
| 合成数据（`scripts/shots/` fixture 与截图无真实余额/用户名/盘符） | **N/A** | `scripts/shots/` 与 `docs/images/` 未被本次提交触碰；13 张图与 fixture 守卫（`check-docs` 第 10 项 `assertFixture`）原样 |
| （本次任务问题 1）`package.json#files` 是否被改 / 包内容是否 24 files / 内部材料是否入包 | **通过（非 N/A）** | `git diff` 空；`npm pack --dry-run` 实测 `total files: 24`；对 `--json` 清单实测 `specs/ workflow/ .specify/ scripts/ AGENTS.md` 命中 0 |
| （本次任务问题 2）链接目标安全性与"是否变成别人可控内容" | **通过（含 F3/F4 两条 LOW 限定）** | 5 条全为 `https://github.com/xinghe-1018/dsh-token-plan-quota/blob/main/`，与 `repository.url` 同 owner/repo；无内网/用户名/私有路径；未指向第三方；可变分支与命名空间两条限制见 F3/F4 |
| （本次任务问题 3）4b 是否会被恶意构造的 README 影响（超长链接 / 正则回溯 / 把路径当文件读） | **通过（纯字符串比对）** | 实测 4b 段 fs 调用 = 0（`readFileSync`/`existsSync`/`statSync`/`readdirSync` 全无）；4MB 单链接 4ms、20 万括号 1ms、10 万 `!` 1ms → 无灾难性回溯；因不读文件，`../../etc/passwd` 类目标只被当成待比对的字符串。**唯一的规避面是形式而非负载**：见 F1 |
| （本次任务问题 4）`SECURITY.md` 是否适合通过 GitHub 链接给 npm 用户读 | **通过（非 N/A）** | 逐行读过全文 43 行：只有键名（`BAILIAN_CONSOLE_COOKIE`）、其它 CLI 的**公开**路径（`~/.kimi-code/credentials/*`、`~/.codex/auth.json`、`~/.gemini/oauth_creds.json`）和一条指向本仓库 issues 的 URL；无值、无 secret、无内部地址、无维护者联系方式泄露。它本就是公开仓库文件，绝对链接只是**恢复了可达性** |
| （本次任务问题 5）与安全立场一致性（README「已知边界」/「明确不做的三类」/ `AGENTS.md` Do-not-touch / 新增依赖） | **通过（非 N/A）** | 两份 README 在"CRLF 归一 + 抹掉链接目标"后与 `5921a07^` **逐字相同**，L344/L354 两节正文未动；`AGENTS.md`、`.env*`、凭据、`docs/images/`（13 张图）、`lib/detect.js` 全未触碰；依赖仍为空 |
| 链接可达性（HTTP 200 实测） | **未验证（不判）** | 本机 `web_fetch` 对 `github.com` 返回 `resolves to a non-public IP address`（环境侧解析限制），无法取回。可达性属 Lens 1/3 正确性范畴，本 lens 只判目标**安全性**，不因此升降级 |
| 未纳入命名空间的残留项 | **已核，无发现** | `fa9ae88` 仅改 `specs/002-publish-surface-links/tasks.md` 的 7 处复选框（`git diff --stat` = 1 file / 7 insertions / 7 deletions），不涉及代码或发布面 |

### 非发现（观察，不构成 finding）

- **`qa-report.md`（未跟踪文件，评审前既存）** 第 18/69 行写 `dependencies: null`，实测是 `undefined`；语义等价（都表示"键不存在"），且该文件不在被评审的两个提交里，仅提示：它将被提交，措辞可顺手对齐。
- **`check-docs.mjs:74` 重新 `JSON.parse(read('package.json'))`**，而 L32 已有 `pkg`；重复解析本身无安全后果（同一次运行内文件不会被换），仅是"两处来源可能漂移"的可维护性提示。**无独立利用场景，故降级为观察，不计入发现。**
- **4b 会把链接目标原样打进报错文案**（L85）：若有人把凭据误黏成相对链接目标，它会出现在 CI 日志里。但此时该串已经在（公开的）README 里，日志回显不构成新增泄漏 → 不计入发现。

---

## 我实际查过的文件

读取（未修改）：

- `package.json`（全文；`files`、`dshhub.permissions.network`、`repository`、依赖字段）
- `README.md`（改动行 L48/49/368/385/386 + 章节结构；另全文中英各自扫描泄漏模式）
- `README.en.md`（改动行 L52/53/426/446/447 + 全文扫描）
- `scripts/check-docs.mjs`（全文 336 行，重点 L64-88）
- `SECURITY.md`（全文 43 行）
- `specs/002-publish-surface-links/{spec,plan,tasks}.md`（`git show 5921a07` 的完整 diff 内容）
- `specs/002-publish-surface-links/qa-report.md`（未跟踪，一并核对）
- `workflow/REVIEW-CHECKLIST.md`（全文；L36-43 为本次执行范围）

命令/实测（全部只读）：

- `git log/branch/status/show/diff`（`5921a07` 与 `fa9ae88` 的完整 diff、`--stat`、`-- package.json`、`-- package.json dshhub`、`--stat -- lib test scripts`）
- `npm pack --dry-run`（文本 24 files）与 `npm pack --dry-run --json`（按路径清单对照 README 相对链接、并实测内部材料命中 0）
- `node -e` 内存内复算（未落盘任何临时脚本）：4b 逻辑对**当前**与 `5921a07^` 两份 README 的跑分（当前 0 违规 / 修复前 5 违规）；4b 段 fs 调用计数 = 0；正则对抗输入计时；A/B/C/D 四种链接形式对第 4 项与 4b 的端到端判定；CRLF 归一后的前后文本同一性比对
- `Select-String` 泄漏模式扫描（README 改动行、两份 README 全文、`specs/002-publish-surface-links/*.md`、提交正文）