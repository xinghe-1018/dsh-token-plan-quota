# Lens 3 — 计划一致性与完整性（004 架构图入库）

## 评审对象

- 仓库：`dsh-token-plan-quota`，分支 `004-architecture-diagram`，提交 **`f21f991`**（`f21f9916559d14e79744daf98488a27bfd6e0d6f`）
- 基线：`main` = **`863a346`**（`863a3463f4661ac71948bc46862332f3b066bc29`）
- 评审基准工件：`specs/004-architecture-diagram/{spec.md,plan.md,tasks.md}`，流程要求见 `workflow/PLAN.md`、`workflow/REVIEW-CHECKLIST.md`（Lens 3）
- 纪律：**只读**。除本报告文件外未修改/新增/删除仓库内任何文件；未 `git add` / `commit` / `checkout`。评审开始时与结束时 `git status --porcelain` 均为空（洁净）。
- 限制：本会话模型无图像输入，位图内容经 `modlens_read_image` 读回；破坏性反向用例（删图/改坏路径）**未重跑**，理由见文末「未复现的声称」。

### 实际跑过的命令

| 命令 | 结果 |
|---|---|
| `git log --oneline main..HEAD` | 4 个提交（见下） |
| `git diff --stat main...HEAD` / `--name-status` / `--numstat` | 11 个文件，+562 / −3（其中 `docs/images/architecture.png` 为二进制） |
| `git log --oneline --name-status main..HEAD` | 逐提交文件归属 |
| `git log --format='%h%n%B---' main..HEAD` | 四条提交正文（含 f21f991 的五条反向用例记录） |
| `git status --porcelain` / `--ignored` | 洁净；仅 `.dsh/`、`.scratch/`、`.shots-work/`、`.specify/feature.json` 为 ignored |
| `git tag --points-at f21f991` | 空（无 tag 指向本轮） |
| `git show main:AGENTS.md \| node -e …` | 基线 2653 字符 / 55 行 |
| `node scripts/check-docs.mjs` | OK（含第 10 项） |
| `node scripts/check-refs.mjs` | OK（22 个活文档，无行号引用——`specs/**` 在扫描面内） |
| `node scripts/check-manifest.mjs` | OK（0.4.8，出站主机 8 个） |
| `npm run check` | 7 步全绿（host 379 / client 207 / guards 80） |
| Node 度量 | 入库存量 sha256 与字节数、PNG IHDR、`package.json#files`、`__internals.PRESETS`、`docs/images/**` 体积 |
| `modlens_read_image docs/images/architecture.png` | 转录：3 个边界、10 个节点、9 条带标签关系、图例；**无**查看器那三张结论卡 |
| 读 `…/archify-dsh/skills/archify/bin/archify.mjs`（仓库外） | 子命令表实测：`render/compare/deliver/preview/validate/inspect/check/visual-check/guide/examples/doctor/demo`；**无位图导出选项** |

## 事实基线：`diff --stat` 与计划原文并列

```
 AGENTS.md                                       |   4 +-
 README.en.md                                    |  17 +++
 README.md                                       |  15 +++
 diagrams/README.md                              |  72 +++++++++++
 diagrams/dsh-token-plan-quota.architecture.json |  42 +++++++
 diagrams/make-diagram-png.mjs                   | 154 ++++++++++++++++++++++++
 docs/images/architecture.png                    | Bin 0 -> 186019 bytes
 scripts/check-docs.mjs                          |  17 ++-
 specs/004-architecture-diagram/plan.md          | 142 ++++++++++++++++++++++
 specs/004-architecture-diagram/spec.md          |  64 ++++++++++
 specs/004-architecture-diagram/tasks.md         |  38 ++++++
 11 files changed, 562 insertions(+), 3 deletions(-)
```

计划 `plan.md`「## 5. Design」的改动落点（原文，逐条摘录）：资产 `docs/images/architecture.png`（`:61`）、源规格 `diagrams/…architecture.json`（`:62`）、再生成脚本 `diagrams/make-diagram-png.mjs`（`:63-64`）、再生成说明 `diagrams/README.md`（`:65-66`）、**门禁：`check-docs.mjs` 第 10 项的清单加一条路径**（`:67`）、规则 `AGENTS.md`（`:68-70`）、对外文本 `README.md` / `README.en.md`（`:71`）；三份规格工件由「## 9. Steps」第 1 步（`:125`）列出。

**结论（先给答案）**：11 个文件**全部**在计划的 §5 + §9 第 1 步覆盖之内——**没有**"Design 没写、diff 却出现"的文件；被点名怀疑的 `diagrams/make-diagram-png.mjs` **恰恰写在** §5（`:63-64`）并在 §9 第 3 步复述。范围蔓延的形态不在此处，而在**§5 门禁条目描述得比实现窄**（见 F1）。

## 发现

### [MEDIUM] `scripts/check-docs.mjs:352-362`（另 `AGENTS.md:31`、`spec.md:48`、`plan.md:67`、`plan.md:86`、`plan.md:105`、`tasks.md:13`、`tasks.md:17-18`）— 新门禁断言是**计划外**的行为改动，且 `plan.md` 的失败模式小节声称了与实现**相反**的结论，三份工件与任务均未回写

实现新增的是一条**独立于清单**的断言：两份 README 都必须以相对路径引到 `docs/images/architecture.png`，否则红（`:352-362`，注释 `:307-308` 自述"004 用点名断言收口"）。而工件侧：

- `spec.md:48` 非目标原文：「本次只加资产、**加一条存在性清单项**、把一条规则写精确」——新断言不是"清单项"。
- `plan.md:67`（§5 门禁）原文：「`scripts/check-docs.mjs` 第 10 项的清单加一条路径」——未提断言。
- `plan.md:86`（§6 失败模式）原文：「**双语不同源**（只加 `README.md` 一侧）：现有门禁对"声明"是按 zh+en 并集看的，**单侧漏加可能不报**——这是 003 已记录的同一类边界，本轮**沿用**并如实标注，**不假装它被守住了**」——实现恰好把这条边界收口了（f21f991 提交正文亦自述"这里收口"）。
- `plan.md:105`（§8）原文：「本次确实改动**一处**机械检查（`check-docs` 第 10 项清单 +1），所以按规则必须给行为矩阵与可证伪性」——实际改动了一处清单 **+ 一处新断言行为**。
- `tasks.md:13`（T004）只写「第 10 项清单 +1」；`tasks.md:17-18`（T007）的四条反向用例是"删除 / 0 字节 / 改坏相对路径 / 挪到不随包发布的目录"，**不含**这条新断言唯一的失败形态（从一侧撤掉引用）。

**失败场景**：下一位 agent 按 `plan.md:86` 认定"单侧漏加不报"仍是已接受边界、按 §8 认定行为矩阵已覆盖，于是这条断言既没有计划里写下的负向用例，也没被要求补证——把它删掉或改回 `plan.md:67` 描述的样子，`npm run check` 照样全绿，而"两份 README 必须同源引图"这条规则就静默消失（正是 `spec.md`「为什么现在做」第 3 条要防的那类漂移）。证据强度：新断言的实测记录**只存在于 f21f991 的提交正文**（"只从英文侧撤掉引用 → README.en.md 没有引用 …"），未落任何评审可复核的工件（`specs/004-architecture-diagram/` 下只有三份文件，无 `qa-report.md`）。

**修法**：把 `plan.md:67/86/105` 与 `spec.md:48` 同步成实现的样子（门禁改动 = 清单 +1 **和**一条点名双语断言），并把这条断言的负向用例补进 T007；或把断言拆出去另立一条 FR。

### [MEDIUM] `specs/004-architecture-diagram/tasks.md:8-20` — T001–T008 全部未勾选，而 T001–T006 在 `f21f991` 都已实现（且提交信息未引用步骤号）

事实：`check-docs` 第 10 项清单已 +1（`:325`）；`AGENTS.md:31` 规则已改写；`README.md:125` 与 `README.en.md:140` 已同源加图与图注；`diagrams/` 三件套与资产都已入库。但 `tasks.md` 的 8 个复选框无一为 `[x]`，且文件 `:4` 自己写着「交付前必须把勾选状态对齐事实（001 的 Lens 3 教训：工件与事实脱节时，下一位 agent 会按"这一步没发生"重做）」。同一形态在 003 已被判过 MEDIUM（`specs/003-…/reviews/lens-3-plan-conformance.md:48`）。

附带（同一根因、独立规则）：`tasks.md:3` 与 `workflow/PLAN.md:100` 都要求「每步一个 commit，提交信息引用步骤号」，实际是 4 个提交承载 T001–T008（`ca62f3b` = T001+T002+T005；`8deb427` = T003+T006；`f21f991` = T004），四条提交信息均不含 T 编号。具体后果示例：资产与 README 同在 `8deb427`，无法在不牵动另一侧的情况下单独回滚图形资产。

**失败场景**：T007/T008 目前确实只是"证据待落"（属于第 7 步），但 T001–T006 已完成的复选框没勾——下一个会话照 `tasks.md` 把 T001–T003 当未发生，重跑造图并重写 README 段落，或在评审里把 T004/T005 报成"未实现"。

### [LOW] `workflow/ENVIRONMENT.md:46` — 「guards 32 项」与实跑 80 项不符（非本轮引入，但本 lens 的检查面包含 workflow 准确性）

`npm run check` 及 `check-docs` 的输出都是 `guards 80 项`；`scripts/check-docs.mjs:116` 的注释还记录了这段历史（"它的用例数在评审修复中从 32 涨到 80"）。该文件不在本轮 diff 内，所以这不是本次引入的陈旧——但 `check-docs` 第 5 项只扫两份 README（`:118-138`），扫不到 `workflow/ENVIRONMENT.md`，因此这条错数没有任何门禁兜。同类先例见 003 的 `[LOW] workflow/ENVIRONMENT.md:52 —「三个自检」实际是四个`。

**失败场景**：读者按该节估算"门禁耗时与套件规模"时拿到一个差 2.5 倍的旧数，并据此判断 pre-commit 是否可以跑全套。

### [LOW] `screenshots.json:1-9` — 新增 `architecture.png` 后未同步；且"不同步"这个决定没有写在任何工件里

依据（谁读它、有没有别的地方引用它）：全仓库对 `screenshots.json` 的引用只有两处——`CHANGELOG.md:327-330`（权威说明：向插件市场声明**截图与展示顺序**，上游允许 1–8 张，**不声明时市场会从 README 自动抽取**，该文件只给目录站读、不进 npm 的 `files`）与 `workflow/REVIEW-CHECKLIST.md:59`（本 lens 的清单原文："`docs/images/` 与 `screenshots.json` 一致"）。`scripts/**` 里**没有任何脚本**读它（`grep screenshots\.json` 仅命中上述两处）。

判断：文件里已声明 7 条，而 `docs/images/` 现在有 14 个图文件（13 张截图 + 新增架构图），可见"一致"本来就不是集合相等，而是**人工挑选的子集**；架构图是文档资产而非产品界面截图，**不必**进市场的图集。因此这不是越界。但 `spec.md` / `plan.md` / `tasks.md` **通篇没有提到这个文件**，所以"不加"属于**默默跳过**，而不是"明确推迟并同步改了计划"。

**失败场景**：目录站按声明清单渲染图集 → 新增的结构图不会出现在目录站那一面，`spec.md:11` 那条动机（"仓库对外只有文字 + UI 截图，没有一张讲结构的图"）在目录站并未被解决；同时任何照 `REVIEW-CHECKLIST.md:59` 字面核对的人会报一条"docs/images 与 screenshots.json 不一致"，而这条差异没有门禁可判。

### [LOW] `specs/004-architecture-diagram/plan.md:27`（§3 前提 3）— 「Archify 没有 CLI 导出子命令」与 `diagrams/README.md:25-31` 的 `deliver` 命令字面冲突

前提 3 原文：「Archify **没有 CLI 导出子命令**，导出是查看器里的按钮 ⇒ 位图不能靠工具命令产出」。仓库外实测 `archify.mjs` 的 12 个子命令里有 `render` / `deliver` / `preview`（`deliver` 就是"导出成文件"的 CLI 子命令，`diagrams/README.md` 第 2 步正是用它产出 HTML），只是**没有任何位图导出选项**（`grep png` 只命中 `visual-check` 的 sidecar 截图与拼版）。前提的**结论成立**（确实得自己截：`visual-check` 固定 4 档视口 × 主题、`--force-device-scale-factor=1`、不裁剪区域、无可控倍率），但表述与自家 `diagrams/README.md` 记的命令直接抵触。

**失败场景**：读者对照两处会认定 `diagrams/README.md` 里记的 `deliver` 命令不存在（前提说 CLI 没有导出子命令），进而怀疑整条再生成链路的可执行性——即 FR-002 的验收锚点。建议把前提 3 改成"没有**位图**导出子命令"。

### [LOW] `diagrams/make-diagram-png.mjs:43-66` — 复用检查只覆盖了 CDP 一层；新脚本自带第二份 `parseArgs`，计划未记录这个判断

`plan.md:63-64` 与 `:73-77` 的复用检查只论证了"不另造 CDP 客户端"，实测该论证**成立**：脚本 `import { Cdp, launchEdge } from '../scripts/shots/cdp.mjs'`，用到的 `launchEdge({width,height,edge})`、`browser.wsUrl`、`Cdp.connect`、`openPage(url,{width,height,deviceScaleFactor})`、`reloadAndSettle`、`waitFor`、`rectOf`（含"找不到 → null"）、`evaluate`、`shot({clip:{…,scale}})`、`close()` **在 `cdp.mjs` 里都真实存在**；PNG 解析（`pngSize`）与"找元素"逻辑在仓库内也没有同类可复用（全仓库 `IHDR|readUInt32BE|pngSize` 只命中本文件），`make-shots.mjs` 也没有任何体积/字节断言。**但**参数解析是第二份：`scripts/shots/make-shots.mjs:26` 已有同类私有 `parseArgs`（未导出），新脚本又写了一份。属可接受的小重复，只是这条判断没有写进"复用检查"。

**失败场景**：两条造图命令的参数校验口径（未知参数、取值缺失、数值域）各写一次，未来要加 `--help`、dry-run 或统一报错形态时得改两处，且两处行为已经不一致（`make-shots` 用 `next()` 顺序取值，新脚本拒绝以 `--` 开头的取值）。

## 本 lens 的结论

### 逐条对 T001–T008 的对账结果

| 任务 | 计划要求 | 事实（`f21f991` 冻结树） | 判定 |
|---|---|---|---|
| T001 | 源规格 + `diagrams/README.md` | `diagrams/…architecture.json` 4552 B / sha256 `8615756d…e22ecd` **与 `diagrams/README.md:52` 记录逐字一致**；说明含前置/命令/校验/漂移复核（`:14-43`、`:64-72`） | **已实现** |
| T002 | CDP 裁剪脚本、空值即失败、打印 URL/rect/字节/sha256 | 脚本存在；空 rect / 找不到选择器 / 超视口 / 尺寸不符 / <20 KB / >400 KB 六条路径均 `throw`（`:110-140`），`main().catch → exit(1)`（`:151-154`）；打印 URL(`:87`)、rect(`:124`)、字节(`:147`)、sha256(`:148`) | **已实现** |
| T003 | 产出并提交 `docs/images/architecture.png`（2×） | IHDR 实测 **2676×1336**、186019 B、sha256 `b8cae2…877070`，与 `diagrams/README.md:50-51` 记录一致；PNG 签名/IHDR/IEND 自证通过 | **已实现** |
| T004 | 第 10 项清单 +1 | `check-docs.mjs:325` 已加入；清单现 14 条（13 张截图 + 架构图） | **已实现，但计划描述窄于实现（F1）** |
| T005 | `AGENTS.md` 规则写精确 | `AGENTS.md:31` 已按"两类产出方 + 第 10 项断言 + 点名双语"改写；与 `check-docs` 实现逐句对得上 | **已实现** |
| T006 | 两份 README 同一次改动加图 + 同源图注 | `README.md:125`、`README.en.md:140` 同一提交 `8deb427`；图注语义一致（"三块怎么分工" ↔ "how the halves divide the work"），正文口径一致 | **已实现** |
| T007 | 四条反向用例实测并贴输出 | 无工件记录；f21f991 提交正文记了**五条**（含新断言那条）。本次未重跑（冻结纪律） | **证据仅存在于提交正文，未落工件；且用例集缺新断言那条** |
| T008 | 三套测试 + 最后一次编辑后的 `npm run check` 全绿 | 本次实跑：host 379 / client 207 / guards 80 全 0 failed，外加 manifest/docs/refs/submission 四个自检 OK | **已实现**（本报告即为输出记录） |

工件质量（`workflow/PLAN.md` 四条硬要求，`:7-12`）：① 前提 9 条**逐条**有"怎么核 + ✅/n/a"（`plan.md:23-33`）✅；② 非目标写出（`spec.md:46-57` + `plan.md:10-19`）✅；③ 涉及上游的前提写明"本轮不涉及上游"并说明第 4 条不适用✅；④ 引用用锚点/符号名，不写行号——`check-refs.mjs` 覆盖 `specs/**`（`:113-132`）且实测 0 违规 ✅。唯一不合格的是 §5/§6/§8 与实现脱节（F1）与 `tasks.md` 勾选状态（F2）。

`AGENTS.md` 是否仍在"一页以内"：基线 2653 字符 / 55 行 → HEAD **2821 字符 / 54 行**（`--numstat` 2/2，行数未变），增加 168 字符（+6.3%），未越界 ✅。改写后的两行与实际行为一致：`:12` 的造图命令（`--html` 必填、产出默认 `docs/images/architecture.png`）与前提一致；`:31` 的"13 张界面截图 + `architecture.png` 两类产出方"经 `docs/images/**` 清点（7 顶层 + 6 `en/` = 13 截图，另有 1 张架构图）✅；"断言存在且非空字节"实际阈值是 <1024 B 即红（`:331`，比"非空"更严）✅；"点名要求两份 README 都引到"对应 `:355-362` ✅。

`workflow/` 其它文档：`PLAN.md` / `README.md` / `QA-REPORT.md` / `REVIEW-CHECKLIST.md` 未因本轮失效（`QA-REPORT.md:35-41` 的造图命令仍是截图流水线，本轮没碰那条流水线；`REVIEW-CHECKLIST.md:59` 的措辞问题归入 F4）；唯一陈旧的是 `ENVIRONMENT.md:46`（F3，非本轮引入）。`CHANGELOG.md` / `RELEASE.md` / 宪法 / `.github/` 均不在 diff，第 7 项"CHANGELOG / 版本 / tag 同步"因"不做发布动作"而**不适用**——且该推迟**已明确写下**（`spec.md:56-57`、`plan.md:19`），不是默默跳过 ✅。

### 非目标逐条验证结果

| 非目标（原文出处） | 验证 | 结果 |
|---|---|---|
| 不改 `lib/` 与运行时行为（`spec.md:48`、`plan.md:12`） | `lib/**` 不在 diff；`dependencies` 仍为 `null` | ✅（门禁脚本部分见 F1） |
| 不改门禁脚本的**行为**，只"加一条存在性清单项、把一条规则写精确"（`spec.md:48`） | `check-docs.mjs` 另有 16 行新增，含一条新断言 | ⚠️ **字面越界**（F1） |
| 不新建独立门禁进程（`plan.md:13-14`、`spec.md:62-63`） | diff 无新脚本进程、无 CI 改动，只在既有第 10 项内加代码 | ✅ |
| 不入库 642 KB 交互式 HTML（`spec.md:49-50`、`plan.md:15`） | diff 无 `.html`；入库存量 186019 B 位图 | ✅ |
| 不抽 SVG 重做矢量（`spec.md:53-54`、`plan.md:15-16`） | diff 无 `.svg` | ✅ |
| 不动 `docs/images/` 那 13 张截图（`spec.md:51-52`、`plan.md:17`） | 13 张逐字节未改（diff 只有 `A docs/images/architecture.png`；清点 7 + 6 张不变） | ✅ |
| 不动截图流水线 `scripts/shots/make-shots.mjs`（同上） | `scripts/shots/**` 不在 diff | ✅ |
| 不改 `CHANGELOG.md` / `reviews/` / 宪法（`spec.md:55`、`plan.md:18`） | 三者均不在 diff | ✅ |
| 不新增依赖（`spec.md:55`、`plan.md:18`） | `package.json` 不在 diff；`dependencies` 缺失 | ✅ |
| 不做发布动作（`spec.md:56-57`、`plan.md:19`） | 版本仍 0.4.8；`git tag --points-at f21f991` 为空；**推迟已明确写下** | ✅ |
| README「明确不做的三类」不被越界（`REVIEW-CHECKLIST.md:62`） | 新增段落只写"Cookie 会话走控制台数据网关、凭据只在宿主进程内解析、只读路由与模型工具不回传"，未提及读其它 CLI 登录态/额外强凭据；`BAILIAN_CONSOLE_COOKIE` 是已发布能力 | ✅ |

对外描述与代码同源（第 1–9 项）：`npm run check` 全绿即为其机械证据；本 lens 另做了人工抽查——「宿主半边挂 `llm/stream` 记本实例账本」（`lib/index.js:2585`）、「`token_plan_quota` 工具」（`:2453`）、「只读接口面 `/token-plan-quota/*`」（`:36`、`:2626`）、「浏览器半边在输入框工具行渲染跟随当前模型的徽标」（`lib/client.js:1449`）、「官方真值 DeepSeek / Moonshot / OpenRouter / 阿里云」（`lib/index.js:768`、`:806`、`:12`；`detect.js:33-50`）、「千问控制台 Cookie 会话」（`lib/index.js:745`、`:2264`）**均与代码对得上**；新增的两条 GitHub 绝对链接沿用既有先例（`README.md` 已有 10 条同类，含同样不随包发布的 `scripts/shots/README.md`），故过"发布面"检查不靠豁免 ✅。位图内容经视觉转录核过：3 边界 / 10 节点 / 9 关系 + 图例，与 `diagrams/README.md:60-62` 的"有什么、没有什么"一致，未画"明确不做的三类" ✅。

### 未能复现的声称（不当作结论）

1. `diagrams/README.md:53`「连续两次独立运行**逐字节相同**」——需仓库外的 Archify 技能与一份已渲染 HTML，本次未重跑（冻结纪律下也不宜在仓库外生成新文件）。方向性旁证：入库位图 sha256 与记录值一致 ✅。
2. `f21f991` 提交正文的五条反向用例（"基线绿、五条全红、跑完逐字节还原"）——负向用例必须删/改名冻结树里的文件，本次**未复现**；我只做了静态确认：两条判定路径（`:329` 存在性、`:361` 点名断言）都会 `problems.push`，`problems.length > 0` 时退出码非 0。
3. `plan.md:31` 的四档空白像素（44/44/44/64）与 `plan.md:32` 的 deliver 回执哈希（成品 641,980 B）——前者依赖仓库外工具链，后者对应的 642 KB HTML 按非目标不入库、无从核对；**规格**哈希与字节数已核对一致 ✅。
4. `plan.md:30`「本机没有 Chrome、有 Edge」——未重测（与本次一致性判定无关）。

### 汇总

- 发现 **7 条**：0 HIGH、2 MEDIUM、5 LOW。
- 最高严重度的两条：F1（新门禁断言未回写 spec/plan/tasks，且 `plan.md:86` 声称的失败模式与实现相反）、F2（`tasks.md` T001–T008 全未勾选而 T001–T006 已实现）。
- 计划要求与实际改动**没有**未预期的文件、没有越界的非目标触碰（唯一例外是 F1 描述的"门禁行为改动比 spec 非目标写得更宽"）；前 6 条 FR 与 T001–T006 均有可核证据。
- 交付前待补：`qa-report.md` 与 F1/F2 的工件同步；F1 的新断言负向用例应进 T007。