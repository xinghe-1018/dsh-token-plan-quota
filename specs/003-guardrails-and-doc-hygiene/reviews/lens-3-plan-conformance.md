# 003 Lens 3 — 计划一致性与完整性

> **评审对象**：`82b6561`（分支 `003-guardrails-and-doc-hygiene`，HEAD；`git status` 起始为干净，工作树内容在 `$TEMP` 外零改动）· **工件**：`specs/003-guardrails-and-doc-hygiene/{spec,plan,tasks}.md`（`82b6561` 内新增）+ 评审期间出现的未跟踪 `qa-report.md`
> **验证方式**：`git show/diff 82b6561^ 82b6561`；`npm run check`（实测 6.2 s、退出码 0、host 379 / client 207 / guards 32 / 四个自检 OK）；`node scripts/check-refs.mjs`、`node test/guards.mjs`；把 `git archive 82b6561^`、`git show 82b6561^:…` 落到 `$env:TEMP` 后重跑新门禁与旧守卫（仓库零写入）；`findLineRefs()` 全仓复算；旧/新链接抽取正则的行为矩阵复算；`git config` / `git remote` / `.gitattributes` / `ci.yml` 逐条对照。

## 0. 结论摘要

- **计划 → diff**：`plan.md` §7 步骤 1–7 **全部落地**，混合验：步骤 1→`scripts/shots/fixture.mjs`、2→`scripts/check-docs.mjs`、3→`scripts/check-refs.mjs`+`package.json`+`ci.yml`+`ROADMAP.md`+`specs/001` 三份、4→`.githooks/pre-commit`+`CONTRIBUTING.md`、5→`AGENTS.md`、6→`workflow/ENVIRONMENT.md`+`workflow/README.md`。**但有一件实现没进计划/任务**（`test/guards.mjs` 及其接线，见 M10）。
- **接线合规**：新检查**同时**进了 `npm run check`（`package.json:80`）与 `ci.yml`（`ci.yml:57-62`），retro 的"只接一处=未接线"这一条满足；`AGENTS.md:11`、`CONTRIBUTING.md:11-15` 的清单与 `package.json` 逐字一致。**但在 `constitution.md`、`release.mjs`、中英 README 里还有三份同语义清单没同步**（M3/M4/M5）。
- **`tasks.md` 勾选状态与事实不符**：T001–T010 **全部 `[ ]`**，而 T001–T009 都能在本提交里逐条找到产物（M2）。
- **单源化部分收敛**：README 链接抽取确实只剩一处（grep 只剩 `check-docs.mjs`），"行为矩阵+可证伪"规则确实只剩 `PLAN.md:78` + `REVIEW-CHECKLIST.md:36` 两份——但 **pwsh 环境事实反而新增了第二份**（M12），且新文件 `test/guards.mjs:5` 引用了本次提交刚删掉的 `AGENTS.md` 副本（M11）。
- **`specs/003` 工件结构**不合 `workflow/PLAN.md`：缺 `## 1. Problem`、`## 5. Design`、`### Chosen approach and why`（M9）。
- **前提 1（本次规格的第一优先级依据）不可信**：3.73% 是高估（H1），配套的"冲突时刻"派生关系写错（M1），"50 处/26 条"两个基线数都不可复现（M6）。
- **`workflow/ENVIRONMENT.md` 事实核对**：SSH 别名、`origin/HEAD` 未设、`core.autocrlf=true`、`.gitattributes`、CI `fetch-depth: 0`、check-docs 第 7 项 tag 出声跳过、AGENTS.md 的 4575 字节 / 2598 / 3055 三个数字、pwsh 5.1.26100.9444 Desktop、`npm run check` 约 6 秒——**逐条实测无误**；只有"三个自检"是四个（L1）。

---

## 1. 发现

### [HIGH] `specs/003/plan.md:18`（另 `specs/003/spec.md:11`、`82b6561` 提交信息）— 前提 1 标了 ✅，但 **3.73% 的算法是错的：把共用同一时钟的 10 张快照当成了独立事件**

`plan.md:18` 写"按派生偏移在 600000ms 窗口内穷举：2279 个时刻会冲突，单张 p≈0.0038，每轮 10 张 → 每轮假红率≈3.73%"。我独立复算（`$env:TEMP/lens3/premise.mjs`，从真实 `makeSnapshot()` 输出反推 10 个 `now±常数` 偏移，用旧实现的 `JSON.stringify(...).includes(banned)` 判定）：

```
窗口 [1789716103943, 1789716703943)：单张(panel/zh) 冲突 = 2279 → p = 0.003798   ← 与计划完全一致
直接穷举同窗口 10 张（5 变体×2 语言）的并集 = 2479 → 每轮 0.413%
用 1-(1-p)^10                              = 3.734%   ← 计划用的就是这个式子
```

**并集/单张只有 ~1.1 倍，不是 10 倍**：`scripts/check-docs.mjs:369-372` 的 10 张快照走 `makeSnapshot({ variant, lang })`，**不传 `now`**，于是每张各取一次 `Date.now()`，整轮跨度只有毫秒级——同一巧合一次命中就命中整轮。旁证：`qa-report.md:62` 的 3000 轮配对实验给出"单张 0.590% / 整轮 1.10%"，同样是 ~1.9 倍，绝不是 10 倍。此外我换窗口再算（`[0,600000)`）单张只有 1576/600000 = 0.263%，说明这个 10 分钟窗口的估计本身抖动很大（±40%），更不该用乘法外推。

**一句话失败场景**：下一位 agent 按 `PLAN.md` 的硬要求"前提逐条核验"复算，得到 0.4%（我的建模）或 1.1%（QA 报告 §1.2 的建模），与规格/计划/提交信息里标着 ✅ 的 3.73% 差 3–9 倍，于是要么判定前提被夸大、要么把 FR-001 的第一优先级降档——而 `qa-report.md:71-73,112` 已经把这条记为"MEDIUM 发现 1"并把"数字修正"列为放行条件，`82b6561` 的规格/计划/提交信息却仍带旧数字，工件之间自相矛盾。

### [MEDIUM] `specs/003/plan.md:18`（另 `scripts/shots/fixture.mjs:383`、`test/guards.mjs:50-51`、提交信息）— 冲突时刻的派生关系写错：实际命中来自 `byProvider[1].lastAt/lastTpsAt = now-26000`，不是 `updatedAt = now-12000`

三处都写"`now=1789716103943` 时 `updatedAt = now - 12000 = 1789716077943` 含禁用串 `7943`"。实测（`premise.mjs` 逐叶定位）：

```
命中 "7943" <- throughput.byProvider[1].lastAt  = 1789716077943  (offset = -26000)
命中 "7943" <- throughput.byProvider[1].lastTpsAt = 1789716077943 (offset = -26000)
now-12000 实际 = 1789716091943；含 "7943" = false
```

（`fixture.mjs:321` 的 `stats.lastAttemptAt`、`fixture.mjs:123` 的 `updatedAt` 都是 `now-12000`，都不含 `7943`。）

**一句话失败场景**：读者照计划给的复现配方把 `now` 冻成 `1789716103943`、去查 `updatedAt=now-12000` 是否含 `7943`，得到否——于是判定"这个前提/这个豁免用例是空转的、守卫没被真正验证"，而真正命中的字段在 `throughput.byProvider[1]`。同一处还有 `test/guards.mjs:71-72` 的自证断言只查 `JSON.stringify(...).includes('7943')`（结论对、归因错），错误归因因此被固化。

### [MEDIUM] `specs/003/tasks.md:5-20` — T001–T010 全部 `[ ]`，而 T001–T009 在本提交里都已实现

逐条对上产物：T001/T002→`scripts/shots/fixture.mjs`（并已由我复现：旧守卫在冲突时刻抛错、新守卫放行、`7943`/`39.91 CNY`/`OMEN` 仍被拦；固定 `now` 下 10/10 组合逐字节相同）；T003→`check-docs.mjs` 的 `extractLinkTargets`；T004→`scripts/check-refs.mjs`；T005→`package.json:80` + `ci.yml:57-62`（两处都在）；T006→`ROADMAP.md` + `specs/001` 三份；T007→`.githooks/pre-commit` + `CONTRIBUTING.md:46-56`；T008→`AGENTS.md` 已无该规则正文、54 行 ≤ 60；T009→`workflow/ENVIRONMENT.md` + `workflow/README.md:73-75`（全局 `$DSH_HOME/AGENTS.md` 第 44-58 行确有那两条事实，属仓库外、无法从提交核验）。只有 T010 真的未完成。`plan.md:166-174` 的 §7 步骤连勾选框都没有（`workflow/PLAN.md:88` 的模板是 `1. [ ]`）。**对本仓库这不是风格意见**：`specs/001/tasks.md:50-53` 的备注、001 的 Lens 3 发现 1、以及 `6c6202f`（"修 Lens 3 的工件发现（…勾选…）"）都是同一条教训的落点；`qa-report.md:117` 的 `[ ] 视觉 QA 完成` 也是同一现象（§2 已论证无需重拍，勾却没打）。

**一句话失败场景**：下一位 agent 打开 `tasks.md` 看到十项全空，无法区分"T010 待做"和"T001–T009 已做完"，按仓库自己的教训（001 `tasks.md:50`"工件与事实脱节时，下一位 agent 会按'这一步没发生'重做或重复提交"）重做/重复提交其中一项。

### [MEDIUM] `.specify/memory/constitution.md:78` — `npm run check` 的组成清单没跟着改（5 项 vs 实际 7 项）

宪法原文：``- `npm run check`（host + client + check-manifest + check-docs + check-submission）``。`package.json:80` 实际是 host + client + **guards** + check-manifest + check-docs + **check-refs** + check-submission。本次只同步了 `AGENTS.md:11` 与 `CONTRIBUTING.md`，而 `AGENTS.md:4` 自己写着"判定口径的权威是 `.specify/memory/constitution.md`"；`08` 行同节还写着"`npm run check` 为机械化门，任何一项为红即不得合并"。

**一句话失败场景**：读者以宪法为准判断"提交前提覆盖哪些门"，会认为只有 5 项、不存在 refs/guards 两个门——这正是本规格 FR-005 要消灭的"同一语义多处副本各自漂移"，只是这次漂移发生在最高权威那份上。

### [MEDIUM] `scripts/release.mjs:159-164` — 发布路径自带一份 5 步检查清单，注释仍称它是"`npm run check` 里那五步"，两个新门禁不在其中

```js
// 直接用自己的 process.execPath 跑 `npm run check` 里那五步…
const CHECK_STEPS = [
  ['test/host.mjs'], ['test/client.mjs'],
  ['scripts/check-manifest.mjs'], ['scripts/check-docs.mjs'], ['scripts/check-submission.mjs'],
]
```
实际 7 步。`RELEASE.md:80` 把人指向 `npm run check`，而 `RELEASE.md:80/85` 与 `runtime` 的 Ship 相位走的是 `scripts/release.mjs`。

**一句话失败场景**：维护者跑 `node scripts/release.mjs`，终端打印"本地已提交并打 tag，开始全量自检…"并全绿通过——`check-refs`/`guards` 一次都没跑，而操作者得到的是"全量自检通过"的结论（首道防线只剩 `publish.yml:64` 的 `npm run check`，本地这道已名不副实）。

### [MEDIUM] `README.md:373`（另 `README.en.md:431`）— "下面四步一次跑完"与实际的 7 步不符，本次新增的两个门禁不在开发段里

`README.md:372-378` 的代码块列出 4 条命令并断言 `npm run check` = 这四步；`README.en.md:431` 是同一句 `# all four steps below`。`AGENTS.md:19` 明确要求"对外描述…必须与代码同源，且在同一次改动内完成"，而 `README.md` 本次零改动。

**一句话失败场景**：贡献者照 README 的开发段逐条跑检查（host/client/manifest/check-docs）就以为覆盖了提交前提，于是 `check-refs`/`guards` 从没在他本地跑过——这正是 `specs/003/tasks.md:24` 自己写的"只接一处 = 未接线的检查"的读者版。

### [MEDIUM] `specs/003/plan.md:24`（另 `:141`、`spec.md:17`、`scripts/check-refs.mjs:6`）— "仓库里仍有 50 处"与"26 条红线"都不可复现

用被评审提交自己的 `findLineRefs()` 全仓复算（`$env:TEMP/lens3/count.mjs` / `count-prefix.mjs`）：

| 口径 | 实测 |
|---|---|
| 全仓 `.md` 命中（HEAD） | **203**（reviews 占 196） |
| 全仓 `.md` 命中（`82b6561^`） | **224** |
| 门禁范围内（HEAD） | **0** |
| 门禁范围内（`82b6561^`，= 新门禁的可证伪基线） | **21**：`ROADMAP.md` 4、`specs/001/…/plan.md` 9、`tasks.md` 7、`qa-report.md` 1，退出码 1 |

`50` 既不等于 50 处全仓、也不等于范围内（21）；`plan.md:24` 的"ROADMAP.md 3 处、specs/001 的 plan/qa/tasks 6 处"同样对不上（实测 4 / 17）。`plan.md:141` 与 `qa-report.md:20,144` 记的可证伪基线是 **26 条**，我在 `git archive 82b6561^` 出的整棵树上跑同一个脚本只得到 **21 条**；差额 5 条无法解释（可能是当时工作树里尚未提交、后被改写的 003 草稿贡献的，现已不可复现——这一点我**未能确认**）。同一份 plan 的失败模式表还写着"本计划记录实际红线数"。

**一句话失败场景**：下一位 agent 按 T3 的配方复现"修复前必须报红"，得到 21 ≠ 26，无法判断是门禁漏了 5 条检测还是记录不实——正是 `qa-report.md:46-48` 自己刚记录的"空数据会伪装成结论"的同一类陷阱，只不过这次伪装成的是基线的数字。

### [MEDIUM] `specs/003/plan.md:21`（另 `:22`、`qa-report.md:84`）— 用"第 N 行 / N–M 行"写的行号引用是新门禁**结构上看不到**的形态，其中一条在提交后立即失效

`plan.md:21`："4b 在 **100–103 行**另有四套正则"。实测：`82b6561^` 里那四条正则确实在 100-103（前提当时准确），但在被评审提交里已移到 **75 / 78 / 79 / 80 行**（新增的共用实现里），而门禁 `REF_PATTERNS`（`check-refs.mjs:42-45`）只认 `文件.ext:数字` 与反引号裸 `:数字`，**不认"第 100–103 行"**。同类还有 `plan.md:22`（`PLAN.md` 第 77–78 行，目前仍准）与 `qa-report.md:84`（`makeSnapshot()` 第 257–346 行，目前仍准）。FR-003 的动机是"散文规则拦不住机械违规"，而这三个引用落在新门禁的盲区里。

**一句话失败场景**：读者按 plan 前提 4 去 `scripts/check-docs.mjs:100-103` 核对"旧 4b 有四套正则"，读到的是新写的文档注释——前提无法验证，而门禁永远绿。

### [MEDIUM] `specs/003/plan.md:113`（另 `spec.md:26-28`、`scripts/check-docs.mjs:116`）— FR-002 的"三种写法"实为两种；title 形态旧的第 4 项本来就认

`plan.md:113` 的 T2 矩阵写"带 title `[x](a.md "t")`：**修复前**第 4 项不认"；`spec.md:28` 同样写"原先只有 4b 认得的**三种**写法"；`check-docs.mjs:116` 的新注释写"窄的那套只认内联 `](x)`，对带 title、引用式、HTML 三种写法完全隐形"。我用 `82b6561^` 的第 4 项正则逐字复刻做行为矩阵（`$env:TEMP/lens3/t2.mjs`）：

```
内联 [p](workflow/nope.md)            旧·第4项 报    新 报
带 title [p](workflow/nope.md "t")    旧·第4项 报 ←  新 报      （旧正则 [^)#\s]+ 在 title 的空格处截断）
引用式 [p][r] + [r]: workflow/nope.md 旧·第4项 放行  新 报
HTML <a href="workflow/nope.md">p</a> 旧·第4项 放行  新 报
围栏内                                旧·第4项 报 ←  新 放行
```

与 `qa-report.md:38-44` 实测的矩阵（title 行"新 报 / 旧 报 / 一致"）一致，与 plan 的矩阵格子冲突；提交信息反而写对了（只说"引用式与 HTML 写法对旧的第 4 项完全隐形"）。

**一句话失败场景**：下一位 agent 读到"三种写法曾漏检"，会以为 title 形态在旧实现下是盲区，于是把 FR-002 的覆盖范围/回归用例写成三条独立风险并据此重排优先级——而实际要守住的是"引用式/HTML 两种曾漏检"+"围栏内曾误报"两条。

### [MEDIUM] `specs/003/plan.md`（整份）— 结构不满足 `workflow/PLAN.md`：缺 Problem、缺 Design、缺 "Chosen approach and why"

`workflow/PLAN.md:14/18/26/37/52/57/63/75/84/92` 列了十节；`001`/`002` 的 plan **十节齐全**（我逐份核过标题），003 只有"0 修订 / 1 非目标 / 2 前提 / 3 备选方案 / 4 失败模式 / 5 UI 状态 / 6 测试计划 / 7 步骤 / 8 Retro"：**`## 1. Problem` 缺失**（"为什么现在做"只写在 `spec.md:7-18`，plan 不自洽）、**`## 5. Design` 缺失**（"改动落在哪些文件/函数 + 复用检查"没有地方写——`PLAN.md:55` 要求先搜有没有已在做这件事的东西）、`### Chosen approach and why` 只剩 §3 表格里的"（采用）"标注。

**一句话失败场景**：实现相位只拿 plan 开工（`workflow/README.md:23` 说 Plan 相位产物是 `{spec,plan,tasks}`、读者"读一遍"），读不到 Design 与 Problem，只能在动手时才去找 spec——而本规格最主要的"复用检查"结论（`extractLinkTargets` 取代两处实现）与"为什么否决钉死 `now`"没有落在 plan 的可审位置上。

### [MEDIUM] `test/guards.mjs`（另 `package.json:80`、`ci.yml:57-59`、`CONTRIBUTING.md:11`、`workflow/ENVIRONMENT.md:52`）— 这件实现没写进计划，也没写进任务

`plan.md:166-174` 的 §7 只有 7 步，无一步提到 `test/guards.mjs`；`tasks.md` T001–T010 也没有它；`spec.md` 的 FR-001/FR-003 只要求"验收：行为矩阵 + 可证伪"，读起来像是提交正文里的实测证据。而实际入库的是一个**常驻 32 用例的门禁测试文件**，并连带改了 `package.json`、`ci.yml`、`CONTRIBUTING.md`、`environment` 文档四处。"漏的场景"里它是最有价值的那件产物，却在作为契约的工件里不存在；`workflow/PLAN.md:86` 还要求"每步一个 commit，提交信息引用步骤号"，这个文件没有步骤号可引。

**一句话失败场景**：下一个 agent 从 `tasks.md`/`plan.md` 重建工作面时，`test/guards.mjs`（以及它在 CI 与 `npm run check` 里的接线）属于"计划外"文件，被当作历史遗留重构掉或漏加断言——而它正是这次唯一常驻守住"时钟巧合"与"行号正则两端"的东西。

### [MEDIUM] `test/guards.mjs:5` — 新文件声明规则来自 `AGENTS.md` 与 `PLAN.md`，但同一提交刚把 `AGENTS.md` 那份删掉

`test/guards.mjs:5`："为什么单独一个文件：`AGENTS.md` 与 `workflow/PLAN.md` 都要求…"。`git diff 82b6561^ 82b6561 -- AGENTS.md` 删掉的正是那条（`git grep "机械检查也是代码" -- AGENTS.md` 退出码 1）；现存两份是 `workflow/PLAN.md:78` 与 `workflow/REVIEW-CHECKLIST.md:36`，FR-005/T005 的验收恰好断言"`AGENTS.md` 不再含该规则正文"（我已独立核实）。

**一句话失败场景**：下一位 agent 或评审按 `test/guards.mjs` 的指引去 `AGENTS.md` 找这条规则的出处，找不到，于是要么判定"这条规则没有权威落点"（并顺手补回第三份，撤销 FR-005），要么怀疑 T008 没做完。

### [MEDIUM] `workflow/ENVIRONMENT.md:34-46` — pwsh 三条事实与全局 `$DSH_HOME/AGENTS.md` 第 44-53 行重复，违反本次自己的分工决定

`plan.md:68-71`（§3 FR-006 落点决策）写得很明确："仓库无关的（pwsh 实为 Windows PowerShell 5.1、写文件带 BOM、ANSI 解码、GitHub 通道间歇失败）进全局 `$DSH_HOME/AGENTS.md`；仓库内的 `workflow/ENVIRONMENT.md` **只放本仓库的环境事实**（远端 SSH 别名、CDP 出图前置、`DSH_HOME` 隔离）"；提交信息也这么声称。实际新增的 `ENVIRONMENT.md:34-46` 把同样的三条（BOM / ANSI 解码 / 中文弯引号）又写了一遍，而 `workflow/README.md:73` 恰恰把"pwsh 写文件会加 BOM"指为 ENVIRONMENT.md 的内容。两份里的数字（`4575` 字节 / `2598` 字符 / `3055` 字符）我已逐条实测**都正确**，但存在于两处。

**一句话失败场景**：本机换成 PowerShell 7 或某个数字变了，改全局 `AGENTS.md` 的人不会知道 `workflow/ENVIRONMENT.md` 里还躺着一份同样的断言——两份开始给出不同的"实测"值，而两边都是"实测事实"体例，读者无法判断哪份新。

### [LOW] `workflow/ENVIRONMENT.md:52` — "三个自检"实际是四个

原文：`` `npm run check` 在本机约 **6 秒**（host 379 项 + client 207 项 + guards + 三个自检）``。实测输出有四个自检：`check-manifest` / `check-docs` / `check-refs` / `check-submission`（`npm run check` 退出码 0，用时 6.2 s，379/207/32 项均与文档一致）。

**一句话失败场景**：读者拿这句去对照 `package.json#scripts.check`，发现数目对不上，开始怀疑整份环境文档的时效性（它的价值恰恰全在"可信的查表数字"上）。

### [LOW] `.git/config`（`core.hooksPath=.githooks`）— FR-004 的"默认不启用"在本克隆已不成立

`git config --get core.hooksPath` → `.githooks`（仓库级默认确实没配，提交里也没有它，所以 `CONTRIBUTING.md:48` 的描述不算错）；但 `qa-report.md:28-29` 记录 T4 是靠 `git commit --allow-empty` / 临时弄红来实测的，测完留在本地配置里。

**一句话失败场景**：在这个克隆里做下一次提交的人会突然被 `npm run check`（6 秒）挡住，而 `CONTRIBUTING.md:49` 告诉他"默认不启用"；同时 FR-004 验收第 3 条（"未设 `core.hooksPath` → 钩子不生效"）在当前工作区已无法复验。

### [LOW] `specs/003/qa-report.md:6-7` — 指向三份尚不存在的评审报告，且它自己是评审期间才落盘、未被提交的工件

`Test-Path specs/003-…/reviews` = False（本报告落盘时该目录不存在）；`qa-report.md` 的 mtime 是 `2026-09-18 15:42:35 +08:00`，而被评审提交是 `15:35:34 +08:00`，且它到落盘为止仍是 `?? specs/003-guardrails-and-doc-hygiene/qa-report.md`（未跟踪、不在 `82b6561` 里）。

**一句话失败场景**：读者从 QA 报告头部点进 `reviews/lens-1|2|3` 拿到 404；或误以为 QA 报告属于被评审提交，把它的结论当作 `82b6561` 的已验证状态（`82b6561` 里既没有 QA 报告，也没有修掉 QA 报告 §4 发现 1 的后续提交）。

### [LOW] `CONTRIBUTING.md:8-16` — 命令清单给了 manifest / refs / submission 各自一行，唯独 `check-docs` 没有自己的行

清单是 host、client、guards、`npm test`、check-manifest、check-refs、`npm run check`；"`npm run check` # 上面全部 + 文档与投稿自检"在总量上兜住了（我核过：上面五项 + 文档 + 投稿 = `package.json:80` 的七项，逐项一致）。但想单独跑文档门的人在这一节找不到命令。

**一句话失败场景**：贡献者要单独复现 CI 的 "README claims match the code" 那一步，只能去猜脚本名或翻 `package.json`。

---

## 2. 计划步骤 ↔ diff、非目标、范围

**文件清单（18 个）→ 计划 §7 映射**：全部对得上（见 §0 摘要），**唯一例外是 `test/guards.mjs`**（M10）。反向看：**没有计划外的多余文件**，也没有碰到 `lib/`、`docs/`、`.specify/memory/constitution.md`、`docs/images/`、`.env*`、凭据。

**非目标逐条核（`spec.md:45-54`）**：

| 非目标 | 核验 |
|---|---|
| 不改 `CHANGELOG.md` | ✅ 不在 diff 文件清单里；`git grep` 也确认门禁按范围外处理（`CHANGELOG.md` 有 2 条命中而不被扫） |
| 不改 `specs/**/reviews/**` | ✅ 不在 diff 里；且我复跑新门禁确认 `reviews/` 的 196 条命中**一条都没被报**（`82b6561^` 上 21 条无一条来自 reviews） |
| 不改源码注释里的行号 | ✅ 只新增注释，没有改写既有行号引用（`fixture.mjs:11/24` 等原文未动）；新代码里出现的 `lib/index.js:44` 属"例子"，且门禁不扫源码 |
| 不 bump 宪法版本 | ✅ `constitution.md` 未被修改（但见 M3：它的第 78 行内容已陈旧） |
| 不新增依赖 | ✅ `package.json` 无 `dependencies`/`devDependencies`（`node -e` 实测 `undefined`），diff 只改 `scripts.check` |
| 不逐字重写 `ROADMAP.md` 历史段 | ✅ 3 行只把行号形态换成符号名/锚点（`ROADMAP.md` 的 3 处替换与实测命中 4 条相符，均只换形态） |

**门禁自证（T3 的 7 格）**：我在真实文件上复验——`specs/003/plan.md:137` 的围栏样例（含 `lib/index.js:44`）**未报**（围栏豁免成立）；`specs/003/.../qa-report.md`（未跟踪，新出现）被计入扫描面（19 个文件）后仍全绿；`ROADMAP`/`specs/001` 修复后范围内 0 命中。✅

---

## 3. 前提逐条复现结果（`plan.md:16-24`）

| # | 计划声称 | 我的复现 | 结论 |
|---|---|---|---|
| 1 | 干净树会假红；③ 3.73% | 假红机制成立（旧守卫在 `now=1789716103943` 必抛错，已实测）；但 3.73% 是高估（H1），派生关系写错（M1） | **部分 ❌** |
| 2 | 整段 JSON 当字符串找子串 + 10 个 `now` 派生字段 | `82b6561^` 代码逐字确认；我另从真实输出反推出 10 个偏移（-2d/-26000/-20000/-12000/-9000/0/+2h/+5d/+5d3h/+88d） | ✅ |
| 3 | CI 也在跑 check-docs | `ci.yml:52-54` 的 manifest job "README claims match the code" 跑 `check-docs.mjs` | ✅ |
| 4 | 两套抽取实现；4b 在 100–103 行 | 两套实现成立；100–103 行对 `82b6561^` 准确、对 HEAD 已失效（M7）；"三种写法"实为两种（M8） | **部分 ❌** |
| 5 | 规则有三份副本 | `82b6561^` 确认三份；现存量 2 份（`PLAN.md:78` + `REVIEW-CHECKLIST.md:36`），`AGENTS.md` 已删 | ✅ |
| 6 | 仓库无提交门禁 | `82b6561^` 时 `.githooks` 不存在（本提交新增）；`core.hooksPath` 规划时为空——**现在已变成 `.githooks`**（L2） | ✅（规划时） |
| 7 | 全仓 50 处；范围内 ROADMAP 3 + specs/001 6 | 实测 224（全仓，`82b6561^`）/ 21（范围内）：ROADMAP 4 + specs/001 17 | **❌（不可复现，见 M6）** |

---

## 4. 单源化核实（grep 证据）

| 声称 | 核实 | 结论 |
|---|---|---|
| README 链接抽取收敛为一处 | `git grep extractLinkTargets\|classifyTarget\|normalizeTarget` 只命中 `scripts/check-docs.mjs`（第 72/85/93/101/132 行）；仓库里没有第三套 `](…)` 抽取正则（`matchAll(/` 逐条看过） | ✅ 真的收敛 |
| "行为矩阵 + 可证伪"从三份减到两份 | 现在只有 `workflow/PLAN.md:78`（产出方，测试计划要求）与 `workflow/REVIEW-CHECKLIST.md:36`（校验方，Lens 1 条目）；`AGENTS.md` 已无 | ✅ 数量成立 |
| 两份分别承担产出方/校验方 | **站得住但语义高度重叠**：两份是同一句话的改写（"行为矩阵（应报/应放行/边界）+ 可证伪（还原到修复前必须报红）"/"检查漏检或误报比没有检查更糟"）。区别只在使用相位与读者，没有任何机械手段保证两份继续同步 | ⚠️ 可接受，但见 M11：本次已有一处引用把落点写错 |
| 环境事实按"谁需要"分两处 | pwsh 三条**两处都有**（M12），与 `plan.md:68-71` 的分工决定不一致 | ❌ 未收敛 |

---

## 5. 对外描述与代码同源核对

| 位置 | 声称 | 实际 | 结论 |
|---|---|---|---|
| `AGENTS.md:11` | `npm run check` = host + client + guards + check-manifest + check-docs + check-refs + check-submission | `package.json:80` 逐字相同 | ✅ |
| `CONTRIBUTING.md:8-16` | host / client / guards / `npm test`=前两个 / manifest / refs / `npm run check`=上面全部+文档与投稿自检 | `npm test`=`host && client` ✅；七项总量一致 ✅ | ✅（细化见 L4） |
| `CONTRIBUTING.md:48` | 钩子跑的是"CI 那件事（`npm run check`，约 6 秒）" | 钩子确实跑 `npm run check`；CI 各 job 的并集 == `npm run check` 的集合（两处新检查都在 `ci.yml:57-62`）；实测 6.2 s | ✅ |
| `workflow/README.md:20-28` 相位表 | Plan 结构见 `PLAN.md`；Review 三 lens；QA `QA-REPORT.md`；Ship `scripts/release.mjs`/RELEASE.md | `workflow/{PLAN,REVIEW-CHECKLIST,QA-REPORT}.md` 均存在；`package.json` 有 `release` → `node scripts/release.mjs` | ✅（Ship 的实际覆盖面见 M4） |
| `workflow/README.md:73-75` | 环境事实记在 `ENVIRONMENT.md` | ✅ 指针在；但同一批事实也被塞进全局 `AGENTS.md`（M12） | ⚠️ |
| `.specify/memory/constitution.md:78` | 5 项 | 7 项 | ❌ M3 |
| `README.md:373` / `README.en.md:431` | 四步 | 7 步 | ❌ M5 |
| `scripts/release.mjs:159-164` | "`npm run check` 里那五步" | 5 步且不含两个新门禁 | ❌ M4 |
| 接线（retro 硬要求） | 新检查须**同时**进 `npm run check` 与 CI | `package.json:80` ✅ + `ci.yml:57-62`（guards、check-refs 各一步，走 `ci-run.sh`）✅ | ✅ |

---

## 6. `workflow/ENVIRONMENT.md` 事实逐条核实

| # | 声称 | 实测 | 结论 |
|---|---|---|---|
| 1 | 远端是 SSH 别名 `git@github.com-new:…` | `git remote -v` 逐字一致 | ✅ |
| 2 | `refs/remotes/origin/HEAD` 未设 | `git show-ref \| grep origin/HEAD` 无输出；`git symbolic-ref` 报 "not a symbolic ref" | ✅ |
| 3 | `core.autocrlf = true` | `git config --get core.autocrlf` → `true` | ✅ |
| 4 | `.gitattributes` 里 `* text=auto eol=lf` 压过它 | 文件第 5 行逐字一致（另有 `*.sh eol=lf`、图片 binary） | ✅ |
| 5 | CI checkout 必须 `fetch-depth: 0` | `ci.yml:41-43` 的 manifest job 确有 `fetch-depth: 0` | ✅ |
| 6 | check-docs 第 7 项看不见 tag 就出声跳过、不打网络 | `check-docs.mjs` 第 7 项 + `visibleTags()`：非 git / 浅克隆 / git 不可用 → `notices.push(...)`，不报红；只用 `git tag` | ✅ |
| 7 | 窄视口要独立 `DSH_HOME`；非默认视口拒绝写 `docs/` | `make-shots.mjs:162-166` 非默认取景无 `--allow-docs` 即抛错；`scripts/shots/README.md:53-60` 给出独立 `DSH_HOME` 配方；**"会在同一实例上互相干扰"我没有端到端复现（需活 DSH 实例）→ 未确认** | ✅ / 一部分未确认 |
| 8 | pwsh 实为 Windows PowerShell 5.1（5.1.26100.9444、Desktop） | 本会话 `$PSVersionTable` 逐字一致 | ✅ |
| 9 | 同一 `AGENTS.md`（4575 字节）：Node 2598 字符 / pwsh 3055 字符 | 三个数字全部实测命中（`fs.readFileSync` / `Get-Content -Raw`） | ✅ |
| 10 | `npm run check` 约 6 秒；host 379 + client 207 | 实测 6.2 s、`379 passed` / `207 passed` / `32 passed` | ✅ |
| 11 | "guards + 三个自检" | 四个自检 | ❌ L1 |

---

## 7. 已独立复现、无异议的部分（供闭环时不必重复核）

- **可证伪性成立**：把 `82b6561^` 的 `fixture.mjs` 逐字节取到 `$TEMP`，旧 `assertFixture` 在 `now=1789716103943` **必抛错**（`fixture 自检失败：不含真实痕迹 "7943"`），新守卫放行；反向注入 `7943` / `39.91 CNY` / `OMEN` **仍全部被拦**。
- **T6 回归隔离**：固定 `now=1_789_000_000_000`，old vs new `JSON.stringify(makeSnapshot(...))` **10/10 组合逐字节相同**——"截图不需要重拍"的论据成立。
- **`test/guards.mjs` = 32 passed / 0 failed**，与提交信息一致；`check-refs` 在 HEAD 上 OK（19 个活文档，含评审期间新出现的未跟踪 `qa-report.md`）。
- **`AGENTS.md` 一页以内**：54 行 ≤ 60；规则正文已删（`git grep "机械检查也是代码"` 退出码 1）。

## 8. 评审期间的协调事实

评审开始瞬间 `git status --porcelain` 为空（= `82b6561` 干净树），随后出现 `?? specs/003-guardrails-and-doc-hygiene/qa-report.md`（mtime `15:42:35 +08:00`，被评审提交 `15:35:34`）。也就是说 **"评审期间冻结工作树"这条规则在本轮被一个并发的未跟踪工件打破**：`reviews/` 目录尚不存在（`Test-Path` = False），而 QA 报告已引用其中三份报告；`ROADMAP.md`/`specs/003` 的绝对行号在 15:42 之后可能与评审开始时不同。我引用 `specs/003` 的行号取自 `82b6561` 的 blob（`git show`/`read` 一致），并在上表中标注了唯一的未跟踪文件。

## 9. 未能确认（不计入发现）

1. `plan.md:141` / `qa-report.md:20,144` 的 **26 条**红线原始读数——本仓库历史里不可复现（我得到 21 条）；差额 5 条的可能来源（当时未提交的 003 草稿）已无法取证。
2. T4 的"红树拦住提交"过程（需要弄脏工作树或提交，本次评审只读）——`qa-report.md:29` 声称退出码 1；脚本静态可判（`set -e` + `npm run check` 非零即中止）成立。
3. `ENVIRONMENT.md:31` 的"窄视口取景会与正在用的实例互相干扰"——需要活 DSH + Edge 端到端跑一次，本轮没有。
4. T009 的全局 `$DSH_HOME/AGENTS.md` 改动（仓库外，不在 `82b6561` 里）——只能核到文件现状确实含那两条事实（第 44-58 行）。