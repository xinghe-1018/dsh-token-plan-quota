# Lens 2 — 安全与信任边界（评审对象：`e33873d`）

**结论：有 1 条发现（最高 MEDIUM）**——不是泄漏、也不是诱导危险动作；是新增文本把「B/C 档（含 Cookie 凭据形态）」
整体说成「按 README 明确不做的三类不做」，与**已发布**的 Cookie 凭据源和 README 的实际边界矛盾，属信任边界表述错误。
其余检查项：凭据值/主机/注入/依赖/外壳/合成数据等经实证**通过**或 **N/A**（理由见下）。

评审范围＝`e33873d` 的 4 个文件（`ROADMAP.md` + `specs/001-roadmap-reconcile/{spec,plan,tasks}.md`）。
工作区未提交的 `AGENTS.md`、`workflow/`、`.specify/`、`qa-report.md` 按要求**不在**评审范围（仅作为对照口径阅读）。

## 发现

### F1 [MEDIUM] `ROADMAP.md:61`（同一缺陷亦见 `ROADMAP.md:10`）— 把凭据形态说反了：新增状态行把「B/C 档」整体等同于 README「明确不做的三类」

新增原文（`ROADMAP.md:61`）：`> B/C 档（需 Cookie / OAuth / Admin key 等额外凭据）按 README「明确不做的三类」不做。`
（`ROADMAP.md:10` 同义："B/C 档（需额外强凭据 / 本地登录态）按 README「明确不做的三类」不做"）

实证（四条互相独立）：
1. **Cookie 凭据源是已发布的出厂能力**：`lib/index.js:737` 预设 `token-plan-console`，`:745` `cookieRef: 'BAILIAN_CONSOLE_COOKIE'`，
   `:1465-1466` 是它的凭据解析链；`package.json:4` 的 description 与 `package.json:27` 的 `dshhub.summary` 都把
   「千问 Token Plan 控制台网关（Cookie）」列为官方真值来源之一。
2. **README 的真实边界不是「不用 Cookie」**：`README.md:356` 的界定是「需要读取**其它 CLI 的本地登录态**或额外强凭据」，
   三条具体项为 `README.md:359-361`（GLM 团队模式头 / Kimi Code 浏览器 Cookie / Codex·Gemini OAuth token）；
   `README.md:64`「不读别的 CLI 的登录态」同口径。而 `README.md:239` + `244-247` 恰恰**教用户**把自己控制台的整行 `Cookie:`
   存成 `BAILIAN_CONSOLE_COOKIE`——这是"用户自己的控制台会话"，与"别的 CLI 的登录态"是两类东西。
3. **C 档根本不是「不做」**：`ROADMAP.md:66-67` 自订 C 档＝「官方没有额度接口 → 只做本实例实测窗口」，
   而实测窗口正是已发布能力（`lib/index.js:705` 预设 `token-plan-window`、`<provider>` 窗口简写、`README.md:346-348`）。
   同时 B 档还包含 xAI Management key、Anthropic Admin key（`ROADMAP.md:77-78`），也都不在那"三类"里。
4. 该表述也违反本次改动**自己写下的** FR：`specs/001-roadmap-reconcile/spec.md:55` FR-004「与 README 相关的不做决策
   MUST 两处表述一致」。

**一句话场景**：安全审计者或三个月后的维护者按 `ROADMAP.md:61` 判定「本插件不使用 Cookie 凭据形态」，于是跳过
`lib/index.js:1465-1466` 那条唯一长期持有 Cookie 的解析链——正是本插件凭据面里最该被审的路径；反向若照此把
README/SECURITY.md「对齐」成「Cookie 不做」，则会删掉已发布能力的正确描述（对比：`README.md:368` 指向
`SECURITY.md` 的正是「Cookie 只从本地解析、只在进程内使用、绝不进任何路由响应」这条边界）。
无直接泄漏、无可利用动作，故为 **MEDIUM**（信任边界表述错误 + 误导审计/维护决策；不是 HIGH）。

> 复现证据：见文末「核验命令」。

## 通过项（有实证，非静默跳过）

- **P1 新增文本无凭据值 / 无账号标识 / 无真实余额数字**：对 `e33873d` 的**全部新增行**（`ROADMAP.md:6-15/59-63/181-183/276-279`
  ＋三份 spec 全文）扫 `sk-` / `Bearer` / `Cookie` / `credentials` / `.env` / `secret` / `token=` / `@域名` / 邮箱 / 盘符，
  命中只有一处**概念词**（`ROADMAP.md:61` 的 "Cookie / OAuth / Admin key"，无值）；新增数字只有 `0.4.8`/`v0.4.8`（公开发布事实）、
  `11 处`/`8 个键`/`24 files`（仓库自身计数）、日期。无真实余额数字、无账号 id。
- **P2 提交信息**：`e33873d` 正文只引用文件名与 `check-docs.mjs:222`，无路径细节、无键名值。作者邮箱出现在 git 元数据里，
  但此前每个提交都有、非本 diff 引入，且属仓库既有公开信息 → 不报为发现。
- **P3 `specs/plan.md` 的「本机绝对路径」前提：证据不支持（如实撤回该前提）**。`plan.md` 通篇只有**仓库相对**引用：
  `lib/index.js:44`/`:1189`/`:2245`、`README.md:48`、`check-docs.mjs:222`、`Select-String lib/index.js -Pattern 'autoDetect'`。
  仓库里唯一带盘符的串是 `C:\test-dsh-home`，位于 `ROADMAP.md:285`、`ROADMAP.md:320`、`test/host.mjs:81`——三处都**不在本 diff 的
  新增行内**（新增行已逐行列出核对），且它是**合成测试目录名**：无用户名、无真实私有目录，并且 `test/` 与 `ROADMAP.md`
  都不进 npm 包（P4 实测）。`plan.md:64` 的 `npm pack --dry-run 24 files` 也属实（实测 24 files）——只是公开包的文件计数，
  不含任何账号或本机信息。**故 `specs/plan.md` 不构成泄漏。**
- **P4 `package.json#files` 与发布面**：白名单＝`lib`, `docs`, `cordis.patch.yml`, `README.md`, `README.en.md`, `CHANGELOG.md`, `LICENSE`
  （`package.json:67-75`）。`npm pack --dry-run --json` 实测 **24 files**，其中**不含** `ROADMAP.md`、**不含** `specs/`、
  不含 `AGENTS.md`、不含 `SECURITY.md`。本 diff 也没有在 `docs/` 下新增文件，所以即便 `docs` 在白名单内也无新增发布内容
  → **改动不会把内部工程材料带进 npm 包**（`plan.md` 前提 4/8 属实）。
- **P5 未诱导读凭据文件 / 未引入计费请求**：新增行无「读 `.env`/`.credentials.yaml`/登录态」类指令；新增行反而声明
  「字段名**尚未**用真实 Key 核对」（`ROADMAP.md:10`/`:60`），方向是"未做"而非"去做"。新增文本指向的 README 两节
  （`README.md:344` 已知边界、`README.md:354` 明确不做的三类）本身都不含读取凭据的操作指令；`README.md:360-361` 列出
  `~/.kimi-code/credentials/*`、`~/.codex/auth.json`、`~/.gemini/oauth_creds.json` 是**其它** CLI 的公开已知位置，
  且被明确标为"不做、不接受相关 PR"——这是划界，不是诱导。既有 T1.8（`ROADMAP.md:155-156`，**非本 diff**）让维护者用真 Key
  跑只读 `probe`，与 `README.md:63`「不做会产生计费的探活」一致（额度端点只读）→ 通过。
- **P6 与 README「已知边界」的一致性（除 F1 外）**：新增行引用的「Moonshot / OpenRouter 字段名尚未用真实 Key 核对」
  与 `README.md:352` 逐字同义 → 该引用通过。§2「已完成」（`ROADMAP.md:181-183`）与 `README.md:113` 零配置自动检测一致；
  §3「已开源发布」（`ROADMAP.md:276-278`）与 `package.json:3` = 0.4.8 一致。

## N/A（逐条给理由，不静默跳过）

| 检查项 | 判定 | 理由 |
|---|---|---|
| 出站主机集合 == `dshhub.permissions.network` | **N/A** | 本 diff 无代码、无 host 新增；新增行不含任何主机名（逐行扫过），`package.json:46-57` 的 8 条声明未变。核这条属 Lens 1/3（`check-manifest.mjs`）。 |
| 上游文本进 tooltip/面板/徽标的转义 | **N/A** | 纯 Markdown 文档改动，不进入任何渲染路径，无插值/无 DOM。 |
| Cookie 回退路径的输入校验 | **N/A** | 无运行时代码改动（`lib/` 一行未动，`git show --stat` 可证）。 |
| 零依赖（无新依赖/无 slopsquatting） | **N/A** | `package.json` 未被本 commit 触碰；实测 `dependencies` 仍为 `undefined`。 |
| 外壳差异（座位探测/样式注入/DOM 注入） | **N/A** | 无客户端代码改动。 |
| 合成数据（`scripts/shots/` fixture 与截图不得含真实余额/用户名/盘符） | **N/A** | 本 commit 未触碰 `scripts/shots/`、`docs/images/`；新增行无任何余额/token 数字。 |
| 编码护栏 / 版本三方一致 / 链接与截图契约 | **N/A（不属本 lens）** | 属 Lens 1 / Lens 3；本报告不重复结论。 |

## 附注（不在本 lens，也不计入发现数；交人裁决）

- `specs/plan.md:34` 把「明确不做的三类」记在「README L344 起」，实际该节起于 `README.md:354`（`README.md:344` 是「已知边界」）
  → 行号引用偏移 10 行。属 **Lens 3**（文档准确性与可核验性）判定范围；这里只作为 F1 的旁证（该偏移说明"B/C 档 ↔ 三类"
  的对应关系是凭记忆写的，未逐条比对）。
- **既有、非本 diff 引入**：`README.md:368`（会随包发布）以相对链接指向 `SECURITY.md`，而 `SECURITY.md` 不在
  `package.json#files` 白名单 → npm 包内没有该文件（P4 实测）；npm 网页端是否改写相对链接本机未核实，故不下断言。
  本 commit 未改 README，不计入发现。

## 我实际查过的文件

- 被评审：`ROADMAP.md`（逐行提取全部新增行；另通读 L50-169 的 §1.1/§1.1.1 上下文；其余区段按 `C:\`/密钥/主机/凭据 关键词全文件扫描）、
  `specs/001-roadmap-reconcile/spec.md`、`plan.md`、`tasks.md`（三份新文件全文，经 diff 与工作区各读一次并比对一致）
- 对照口径：`README.md`（L40-69、L225-254、L340-369；节标题全扫）、`package.json`（全文）、
  `workflow/REVIEW-CHECKLIST.md`（Lens 2）、`AGENTS.md`（Do-not-touch）、`scripts/check-docs.mjs`（L18/L219/L222/L241/L252）
- 实证代码：`lib/index.js`（PRESETS 682-760 全量键提取、`:44/:1004-1008/:1189/:2245` 的 autoDetect 锚点、`:1465-1466` cookieRef 链）、
  `test/host.mjs:81`
- 命令：`git show e33873d`（含 `--unified=0` 新增行定位）、`git status --porcelain`、`git diff --stat`、
  `npm pack --dry-run --json`、`node -e`（PRESETS 键提取）、`Select-String` 一轮（盘符/密钥/主机/凭据关键词）

## 核验命令（可逐条复现 F1 与 P4）

## 评审完毕后工作区变动观察（不计入发现数，但影响 F1 的处置）

本报告评审对象是**已提交的 `e33873d`**。评审过程中（写入时间 11:44:36–11:44:55，与本报告同一分钟内）**另一个会话**
在同一工作区就地改了 `ROADMAP.md`、`specs/.../plan.md`、`specs/.../tasks.md`（未提交，`git diff` 可见）：

- 该改动把 `ROADMAP.md:10/61` 拆成了「**B 档**（需 Cookie / OAuth / Admin key 等额外凭据形态）按 README『明确不做的三类』不做；
  **C 档**（官方无额度端点）**不是不做**，而是只做实测窗口」——**C 档那一半确实修好了**（与 F1 的第 3 条实证一致）。
- 但**B 档那一半没被修**：拆分后的原文仍写「需 **Cookie** … 不做」，而 `lib/index.js:737/745` 的 `token-plan-console`
  （`cookieRef: BAILIAN_CONSOLE_COOKIE`）与 `README.md:239/244-247` 就是已发布的 Cookie 凭据源 →
  **F1 在改动后依然成立**，只是位置从 `ROADMAP.md:10/61` 变为改动后的同一段（`ROADMAP.md:10` 与 §1 状态行）。
- 该会话把这条修正记在「Lens 3」名下（`tasks.md` 的 T007）。按本仓库的 lens 分工，凭据形态与安全立场一致属 **Lens 2**——
  所以这里不重叠计数，只提示：**只按 Lens 3 修完不能关掉 F1**。

## 核验命令（可逐条复现 F1 与 P4）

```powershell
git -C . show e33873d --stat
Select-String README.md -Pattern '明确不做的三类' -Context 0,8      # 真实边界＝其它 CLI 登录态/强凭据
Select-String README.md -Pattern 'BAILIAN_CONSOLE_COOKIE'           # L239/L246：Cookie 是已发布能力
Select-String lib/index.js -Pattern "token-plan-console|cookieRef"  # L737/L745/L1465
npm pack --dry-run --json | Select-String 'ROADMAP|specs/'          # 无命中
```