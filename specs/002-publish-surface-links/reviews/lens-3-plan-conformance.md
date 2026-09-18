# Lens 3 — 计划一致性与完整性（002-publish-surface-links）

- **评审对象**：`5921a07`（实现）、`fa9ae88`（勾选工件）；工件 `specs/002-publish-surface-links/{spec,plan,tasks}.md`
- **基线**：`git merge-base HEAD main` = `0ccb327`；`git log --oneline main..HEAD` = 6 个提交（另 4 个属 001，见 F8）
- **只读**：本轮除本报告外未写任何文件，无 git 写操作
- **本轮自己跑过的证据**：`npm run check`（`EXIT=0`，`379 passed, 0 failed` / `207 passed, 0 failed`，manifest·docs·submission 全 OK）；`npm pack --dry-run`（`total files: 24` / `package size: 2.0 MB`）；把 HEAD 的 4b 逻辑抽出来对 `5921a07~1` 的两份 README 复算差集（10 条报错 / 5 个去重目标）；两份 README 的 CRLF 归一正文等价比对
- **行号口径**：本报告引用的代码行号一律取自**已提交 blob**（`git show HEAD:scripts/check-docs.mjs`，337 行；`5921a07~1` 版本 317 行）。工作树正在被并发修改（F3），当前磁盘上的行号会继续漂

## 结论

计划 §5 的两处改动都实现了，T001–T006 都能对到产物，六条 FR 都有可复现证据，plan §2 的四条非目标逐条守住。**勾选状态与事实一致**：作者"提交后立即勾选"的说法成立——`fa9ae88` 落在 `5921a07` 之后 18 秒，六项勾选我逐条独立复现过，没有"只勾不做"。最高严重度为 **MEDIUM**：plan 里两条**位置行号引用已经腐烂**（`plan.md:9` 的 `L66` 现在指到相邻一行；`plan.md:29` 的"第 292 行"现在落在截图文件名字符串上）——这正是上一轮 001 `T013`"计划文件内不再含位置行号"要消灭的形态，被 002 的 plan 重新引入；其余为流程/措辞级 LOW。另有一条评审期间的协调事实（F3）：有人正在改同一个 `check-docs.mjs`，改写范围已超出 plan §5/§6 与 FR-002 的措辞。

## 发现

### F1 [MEDIUM] `specs/002-publish-surface-links/plan.md:29` — 前提 6 的"第 292 行（图片）"已被本提交改烂

`5921a07~1:scripts/check-docs.mjs` 第 292 行确实是图片存在性断言（`if (!existsSync(join(root, ref))) problems.push(…引用的图片不存在…)`）；同一提交在文件头部插了 "4b." 注释行、在第 68 行后插了 19 行检查（合计 +20），该断言在已提交 blob 里移到**第 312 行**，而**第 292 行现在是 `'docs/images/en/cookie-fallback-measured.png',`**（截图清单里的一个字符串）。
**后果场景**：下一位 agent 按前提 6 到"第 292 行"核对"相对链接与图片引用是两条独立检查路径"，看到的是 PNG 文件名 → 会误判前提写错，或改到错误位置。规则回归：001 的 `tasks.md` `T013` 明确"计划文件内不再含位置行号"，本 plan 又把行号带了回来。

### F2 [MEDIUM] `plan.md:9` — `L66: existsSync(join(root, link))` 是位置行号，且已离线一行

`5921a07~1` 第 66 行就是该断言；已提交 blob 第 66 行是 `for (const link of new Set([...text.matchAll(…)]))`，第 67 行才是 `existsSync`（头部插的 "4b." 注释行导致 +1）。
**后果场景**：按 `L66` 定位会拿到外层 `for`/正则行，核对"现有第 4 项只查仓库内存在"时读到的是抽取逻辑而不是断言 → 复核结论只能靠猜。应写成 `check-docs.mjs 第 4 项`（检查项编号）+ 文件名。

### F3 [MEDIUM] 工作树 `scripts/check-docs.mjs` 未提交改写超出 plan §5/§6 与 FR-002（评审期间进行中）

`git status` = ` M scripts/check-docs.mjs`（未提交；mtime 15:01:49 → 15:03:06 仍在变，`git diff --numstat` 由 35/12 变为 35/13，即仍在写）。改写后的 4b 明确**不再是 plan 描述的实现**：注释写着"为什么不用第 4 项那个正则"，改为覆盖内联 / 带 title / 引用式 `[x][r]`+`[r]: x` / HTML `<a href>` 四种写法，先剥代码围栏与行内代码，并引入"`npm pack` 无论如何都会带上"的文件（package.json、README*、LICENSE*、main 指向文件）以及 files 含 glob/否定项时的出声跳过。
**后果场景**：(a) `tasks.md` `T003` 的 `[x]` 描述的是 `5921a07` 的实现，工作树已不是那一份，"已完成"不能当作新实现的证据；(b) 这份改写若要发布，`plan.md` §5 的"链接抽取沿用第 4 项那段写法（同一 `](…)` 正则），不另造一套"与 `spec.md` FR-002 的措辞（只讲"每个相对链接被 `files` 覆盖"）都必须随提交更新，否则就是计划外扩张；(c) 在同一工作区跑 `npm run check` 的结果无法归因到被评审提交（本轮那次 `EXIT=0` 也受此影响，故 FR 证据我另用 HEAD 的逻辑独立复算过）。这属评审闭环里"修复回到实现相位"的正常动作，不是这两个提交的缺陷；要补的是 plan/spec 同步与"勾选归属"。

### F4 [LOW] `tasks.md:23`（T006 引用的提交标题与实际不符）

T006 写 `fix(docs): README 不再链接**到**不随包发布的文件，并加发布面检查`；`5921a07` 的实际标题是 `fix(docs): README 不再链接不随包发布的文件，并加发布面检查`（少一个"到"）。
**后果场景**：按工件里的标题 `git log --grep` 找不到该提交。

### F5 [LOW] `tasks.md:20` 与 `tasks.md:17` / `plan.md` §8 — 同一事实两个计数、未定义单位

Phase 3 标题写"逐条指名 **10 处**违规"，T004 与 plan §8（可证伪性行）写"必须报红并指名 **5 条**"。我复算：pre-fix README 下 4b 产生 10 条问题行、覆盖 5 个去重目标——两个数都对，但工件没说单位（10 = 问题行，5 = 去重目标）。
**后果场景**：照 plan §8"5 条"验收的人看到 10 行报错，需自行判断多出的 5 行不是新回归。

### F6 [LOW] `plan.md:85-89`（§9 Steps）五步仍是 `[ ]`，而事实已落地

tasks.md 六项已全勾、提交已存在，plan §9 却仍显示五步未做。
**后果场景**：只读 `plan.md` 的下一相位 agent 得到"这一步没发生"的信号并重做——正是上一轮 Lens 3 发现 1 的形态（§10 Retro 空属"未完成相位"，性质不同，见下方清单第 5 条）。

### F7 [LOW] `tasks.md:31`（实现策略）"两个文件、一个提交" 与提交内容不符

`git show --numstat 5921a07`：6 个文件——`README.md` +5/−5、`README.en.md` +5/−5、`scripts/check-docs.mjs` +20/−0，外加 `plan.md` +98、`spec.md` +64、`tasks.md` +42（三份相位工件同车）。
**后果场景**：核对"一个提交、两个文件"的人看到三份 spec 工件混在实现提交里，会先怀疑越界改动，多花一轮确认。

### F8 [LOW] 分支基线：`main..HEAD` 含 001 的 38 个文件

`git diff --stat main..HEAD` = **44 files, +3783 −16**；其中 38 个文件来自 001-roadmap-reconcile 的四个提交（`e33873d`、`b5e3c2f`、`fb9b1e5`、`3e23414`；001 分支 tip = `3e23414`，未合入 main，main tip = `0ccb327`）。被评审的两个提交自身只碰 6 个文件（含 3 份 002 工件）。
**后果场景**：002 → main 的 PR 会顺带带上 001 的全部改动；先合 002 再合 001 会让同一批改动以两个 PR 名义出现。属 speckit 顺序编号的默认叠加，非本提交引入，但合并顺序必须明确。

### F9 [LOW] 证据没有随提交落盘

`5921a07` 正文只声称"`npm run check` 全绿；`npm pack --dry-run` 仍 24 files"，未贴输出；带输出的 `qa-report.md` 与 `reviews/` 目前是 untracked（`?? specs/002-publish-surface-links/qa-report.md`、`?? …/reviews/`）。
**后果场景**：AGENTS.md「Definition of done」要求"贴出来，不是声称"；若这些工件不随修复提交入库，这轮唯一的落盘证据只活在工作区（我已独立复现，故 FR 结论不依赖它）。

### F10 [LOW] `plan.md` §5 复用说明与实现不符（"不另造一套"没做到）

§5 称"链接抽取沿用第 4 项那段的写法（同一 `](…)` 正则），不另造一套"；4b 实际另写了一套：`!?\[[^\]]*\]\(([^)\s]+)\)` + JS 协议过滤 + `startsWith('!')` 排除图片，而第 4 项用的是 `\]\((?!https?:|#|mailto:)([^)#\s]+)`。
**后果场景**：同一概念存在两条独立抽取/过滤规则，将来给一边加协议或排除项（如 `ftp:`、`tel:`）不会覆盖另一边，两条道会悄悄分叉（F3 的进行中改写已从"三种已知写法治不了"证实了分叉代价）。

## 已核验但不构成发现

1. **计划 → diff（plan §5 两处都实现）**：`README.md` +5/−5、`README.en.md` +5/−5（5 个目标 × 2 份 = 10 个链接实例，全部改为 `https://github.com/xinghe-1018/dsh-token-plan-quota/blob/main/<path>`，owner/repo 与 `package.json#repository.url` 一致）；`scripts/check-docs.mjs` +20/−0 新增 4b：只遍历两份 README、`files` 目录条目按前缀展开、放行 `^https?:|^mailto:|^#`、排除 `![` 图片、报错串 `${file} 的链接目标不随包发布：${target}` 与 plan §5 格式一致（尾部的"改成绝对链接，或加进 files"是额外提示，不违和）。
2. **tasks.md T001–T006 ↔ 产物（勾选与事实一致）**：
   - T001 ✅ diff 里 10 个绝对链接，owner/repo 与 `repository.url` 一致；
   - T002 ✅ 当前两份 README 违规相对链接 = 0（非图片相对链接 10 → 5；去重目标 23 → 18，含 13 张图）；中英各 6 个绝对 GitHub 链接、目标集合完全相同（FR-005）；
   - T003 ✅ 4b 在位，且是新增（第 4 项未被删改）；
   - T004 ✅ 用 `5921a07~1` 的 README + 未变的 `files` 复算 → 10 条问题行 / 5 个去重目标，逐条指名那 5 个文件（"可证伪"成立）；
   - T005 ✅ 本轮 `npm run check` `EXIT=0`（379/207，manifest·docs·submission OK）；`npm pack --dry-run` = 24 files / 2.0 MB；
   - T006 ✅ `5921a07` 存在（标题字面差异见 F4）。
3. **非目标逐条（plan §2）**：
   - **没**把这 5 个文件加进 `files` ✅ 两个提交的 diff 无 `package.json`；`files` 仍是 `lib`、`docs`、`cordis.patch.yml`、`README.md`、`README.en.md`、`CHANGELOG.md`、`LICENSE`；
   - **没**改 README 正文/结构 ✅ CRLF 归一后把 `](…)` 归为 `](LINK)`，两份文本**完全相等**、标题序列相等、行数相等（391/391、452/452），每份只改 5 行；
   - **没**动 `docs/`、`lib/`、`test/`、`scripts/shots/`、`.specify/` ✅ 两个提交只碰 `README.md`、`README.en.md`、`scripts/check-docs.mjs` + 3 份 002 工件；
   - **没**扩成全仓 markdown 巡检 ✅ 4b 硬编码只遍历 `['README.md','README.en.md']`；
   - **没**改版本号/CHANGELOG ✅ diff 无 `package.json` / `CHANGELOG.md`。
4. **FR 逐条证据**：FR-001（0 违规 + 10 条绝对链接）、FR-002（4b 代码在位）、FR-003（pre-fix 复算报红）、FR-004（24 files）、FR-005（两份目标集合相同）、FR-006（报错串含文件名与链接）——六条都有可核验支撑，无缺口。
5. **`plan.md:95-98`（§10 Retro）仍是占位行**（"错误的前提：/计划里缺的/agent 反复误解的/落点："）→ **未完成的相位，不是缺陷**：本轮未要求填，且按 AGENTS.md，Retro 结论只落 `AGENTS.md` 或 `workflow/PLAN.md`。
6. **`spec.md:7` Status 仍写 `Draft`** → 与 `specs/001-roadmap-reconcile/spec.md:7`、`.specify/templates/spec-template.md:7` 的默认值一致，plan/tasks 里没有任何一步要求改它；**判为不算脱节**。若项目希望"已交付"有标记，应先改模板/流程词表（建议，不作为本轮缺陷）。
7. **Lens 3 清单其余条目**：截图契约、CHANGELOG/版本/tag 同步、`AGENTS.md` 与 `workflow/` 准确性 — 4b 只是**新增**检查项编号（"4b."），第 4 项与第 10 项编号未变，故 `workflow/REVIEW-CHECKLIST.md:51`（"第 1–9 项"）与 `AGENTS.md:31`（"第 10 项"）仍然准确；README「明确不做的三类」段落只有链接目标被改写（见第 3 条）。**复用检查**见 F10。
8. **数字对账**：`check-docs.mjs` 由 317 行 → 337 行（= numstat +20）；相对目标去重 23 → 18；非图片相对链接 10 → 5；13 张图引用不变。
9. **工作区状态（评审时）**：` M scripts/check-docs.mjs`（F3）+ untracked `specs/002-publish-surface-links/qa-report.md`、`reviews/`；同级 lens-1（14:59:44）、lens-2（15:00:19）已落盘，本报告落 `reviews/lens-3-plan-conformance.md`。
10. **方法学注意**：工作副本是 CRLF（`core.autocrlf=true`）。做"正文是否只改了链接"这类整段比对必须先归一 `\r\n`，否则会得到假的"文本已变"（我第一次比对就踩到；归一后两份 README 正文完全相等）。