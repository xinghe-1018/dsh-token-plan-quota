# Lens 3 评审报告 — 计划一致性与完整性

**对象**：commit `e33873d`（分支 `001-roadmap-reconcile`，`git diff main...HEAD` 与提交内容一致）
**结论**：**有 3 条发现**（最高 MEDIUM）。`plan.md` §9 的四条实现步骤逐条落地、六条非目标全部未越界、
历史推理段删除行数为 0；问题集中在"工件勾选状态与事实脱节""新增状态文本对 C 档的口径与文件自身 §1.1 矛盾"
"计划里的行号锚点在同一次提交内即失效"。

## 发现

- **[MEDIUM] `specs/001-roadmap-reconcile/tasks.md:7-12`（另 `plan.md:97-101`）— 工件勾选状态与已提交事实脱节。**
  同一个提交 `e33873d` 里既写进了 T001–T004 的全部产出（`ROADMAP.md:6-16`、`:59-62`、`:181-182`、`:276-278`）
  又写进了 T006 要求的提交本身，但 `tasks.md` 六个框与 `plan.md` §9 五个框**全部仍是 `- [ ]`**。
  后果：下一个 agent（或 QA 相位）按工件判断，会得到"这一相位从未开始/未完成"的结论——这会直接触发
  项目自己写下的判据"没有工件 = 那一步没发生"，要么重做 T001–T004 形成重复改动，要么把已交付的
  对账当成未交付再提交一次；本文件是这次改动的进度唯一记录点，它的失真即进度的失真。

- **[MEDIUM] `ROADMAP.md:10` 与 `ROADMAP.md:61` — 新增状态文本把「B/C 档」整体写成"不做"，与同一文件 §1.1 的 C 档定义矛盾。**
  §1.1 明确 C 档＝"官方没有额度接口（只能走本实例实测窗口）"：`ROADMAP.md:76`（Gemini 仅 API Key 场景→只做实测窗口）、
  `:79`（MiniMax"只做实测窗口"），且 `:142-150` 的 T1.6 已把通用实测窗口简写 `"window:<provider>"` 标为 `[x]`
  （本机 `minimax-cn` 现场生效）。而新写的 `:10`（"B/C 档（需额外强凭据 / 本地登录态）按 README「明确不做的三类」不做"）
  与 `:61`（"B/C 档（需 Cookie / OAuth / Admin key 等额外凭据）按 README「明确不做的三类」不做"）用 B 档的
  定义（额外凭据）套在 B∪C 上，并把 C 档并入 README:354-361 那三类。B（凭据形态）与 C（有无官方端点）是两条
  正交轴，README 的三类只覆盖凭证侵入型（GLM 团队头、Kimi Code Cookie/CLI 凭据、Codex·Gemini OAuth），不含 C 档。
  后果：读者读 `:10` 判定"MiniMax / Gemini / OpenAI 普通 Key 这类 C 档一律不做"，而代码与 §1.1、§1.3 已给出实测窗口
  路径——本次改动本要消除的"两处漂移"，在新增的三行里又造出一处，且是**改动文件内部自相矛盾**，
  FR-004（与 README 表述一致）在这一句上不成立。

- **[LOW] `plan.md:62-64`（§5 设计表的 `（L48）`/`（L165）`/`（L257）`）与 `tasks.md:8-10` — 行号锚点在提交后立即失效。**
  这三处锚点是改动前的行号，而本次就在同一次提交里把顶部块从 7 行扩到 16 行（净 +9 行），改动后
  §1 标题在 `ROADMAP.md:57`、§2 在 `:179`、§3 在 `:274`。后果：任何人照 `plan.md` §5 跳到 `ROADMAP.md:48` 复核
  "§1 状态行"，落到的是 `### 0.2 其他先修项`（`ROADMAP.md:48`）——复核动作会指向错误位置，锚点失去可核验价值
  （计划与改动同提交时该用章节名而非行号）。不影响文档内容正确性，故 LOW。

## 已核验但不构成发现

**增删行数与历史段完整性**

- 提交总计 `4 files changed, 230 insertions(+), 1 deletion(-)`；`ROADMAP.md` 单独 `22 insertions(+), 1 deletion(-)`。
  唯一删除行＝老的版本计划行（`-版本计划：① → 0.3.0，② → 0.4.0，③ → 1.0.0（首个对外版本）。`）。
  `git show e33873d --unified=0 -- ROADMAP.md` 只列出一条 `-` 行。
- 因此 §0.1（`ROADMAP.md:31`）、§1.1（`:64`）、§1.1.1（`:83`）、§4（`:353`）**删除行数均为 0**，标题与内容都在，
  符合 plan §2 第四条非目标与"历史推理段一行未删"的提交信息声明。

**计划 → diff（`plan.md` §9 / `tasks.md` T001–T006）**

- 步骤 1 / T001 顶部：已插入 `ROADMAP.md:6-12`「当前状态」三行表（每行带依据），并把版本计划行标注为
  "原文，已被上表取代"（`:14`）＋给出实际发布线（`:15`）。实现与 plan §9-1、task T001 的措辞（状态指针段＝状态表）一致。
- 步骤 2 / T002 §1：`ROADMAP.md:59-62` 状态行＝部分完成 + A 档依据 + 不做记录位置。✔
- 步骤 3 / T003 §2：`ROADMAP.md:181-182` 状态行＝已完成 + 三处代码位置引用。✔
- 步骤 4 / T004 §3：`ROADMAP.md:276-278` 状态行＝已开源发布 + "本文原定的 1.0.0 尚未"。✔
- 步骤 5 / T005：编码护栏这一条已独立复验（下），`npm run check` 全绿**未以提交状态复跑**——工作区另有 4 个
  未提交文件（见文末），现在跑测的是工作区而非 `e33873d`，故不在本报告中声称门禁结论。
- T006：`git log` 中确实存在 `e33873d docs(roadmap): 与代码事实对账（②已落地、①部分完成、版本计划修正）`，一条提交、覆盖五处插入。✔

**diff → 计划 / 非目标**

- 改动文件清单＝`ROADMAP.md` + `specs/001-roadmap-reconcile/{spec,plan,tasks}.md`，无意外文件；
  `specs/` 三个文件是 AGENTS.md "Workflow" 规定的计划相位工件（落 `specs/<编号>-<slug>/`），不是范围蔓延。
- `lib/`、`test/`、`scripts/`：本提交**一行未改**；`README.md`、`README.en.md`、`CHANGELOG.md`、`package.json`：**未改**
  （`--numstat` 只有 4 个文件）。
- plan §2 六条非目标逐条：①代码未改 ✔；②README/README.en/CHANGELOG/package.json 及版本号未改 ✔；
  ③未补齐任何未实现能力（ROADMAP 只有插入与 1 行版本文案替换，无 B/C 档能力声明）✔；④历史推理段未删（删除行 0）✔；
  ⑤`.specify/` 未动（不在提交内）✔；⑥npm 包内容未变（`package.json#files` 只有 `lib`/`docs`/`cordis.patch.yml`/
  `README.md`/`README.en.md`/`CHANGELOG.md`/`LICENSE`，无 ROADMAP、无 specs）✔。

**复用检查（引用 vs 复制）**

- 新文本对 README 是**引用**而非复制：`ROADMAP.md:10`/`:61` 只给"按 README「明确不做的三类」不做"的指向，
  未把三类清单抄一份；`:60` 与 `:10` 的"已知边界"条目也是指向 README。两处引用的锚点目标都真实存在
  （`README.md:344`「已知边界」、`README.md:354`「明确不做的三类」），未新增第二份权威表述。
- 逐条对照：`README.md:352` 的 Moonshot / OpenRouter "字段名尚未用真实 Key 核对"↔ `ROADMAP.md:10`/`:60` 同义 ✔；
  `README.md:356-361` 三类的共同前提"需要读取其它 CLI 的本地登录态或额外强凭据"↔ 新文本"需额外强凭据 / 本地登录态"同义 ✔。
  不一致点仅在上条发现里的"B/C 档"归属，三类清单本身没有漂移。

**可核验性（新文本的每条依据独立复验）**

- `lib/index.js:44` `autoDetect: true` ✔（`:1189` `async function applyAutoDetect`、`:2245` `await applyAutoDetect(config, ctx)` ✔；
  全文 11 处 `autoDetect`，与 plan §3 前提 1 的"11 处"一致）。
- `PRESETS` 现有 8 个键（`:683,:705,:737,:768,:806,:828,:848,:875`），含 `moonshot-balance`、`openrouter-credits`，
  且 `ROADMAP.md:24` 的历史行确写"6 个预设"——新文本"§0 记的 6 个预设现为 8 个"准确 ✔。
- 版本三方：`package.json:3` = `0.4.8` ✔、本地 tag 到 `v0.4.8` ✔、`CHANGELOG.md`「## [0.4.8] - 2026-09-15」✔；
  `ROADMAP.md:12` 的 `registry latest = 0.4.8` 用 `npm view dsh-token-plan-quota version` **实测确认为 0.4.8**，
  不是不可核验断言（FR-006 无违反）。
- 编码护栏：`ROADMAP.md`、`specs/.../plan.md`、`spec.md`、`tasks.md` 四个文件 `bom=false`、无 U+FFFD、无 GBK 私用区字符，
  符合 FR-005 与前提 5 的处置 ✔。

**计划自身自洽（第 6 条）**

- `plan.md:32` 把"门禁不看 ROADMAP"记为**被推翻的前提**（`❌ 修正`），写明 `check-docs.mjs:222` 把 `ROADMAP.md`
  纳入编码护栏，并追溯出两条硬要求（`:37-38`、`§6 `plan.md:70`）；提交信息正文同样记了这次推翻。
  独立确认：`scripts/check-docs.mjs:222` 的 `textFiles` 数组确实包含 `'ROADMAP.md'` ✔。计划对前提失效是诚实的，
  没有把被推翻的假设留成默认。
- `plan.md:95` 说明"一个提交"的理由（CONTRIBUTING"一个提交只做一件事"，五处插入同属对账这一件事），提交事实一致 ✔。
- 另：`plan.md:52` 的"五处插入/替换"＝顶部状态指针 + 顶部版本计划行 + ①②③ 三行状态，计数与 `ROADMAP.md:6-16`/`:59-62`/`:181-182`/`:276-278` 的实现一致 ✔。

**上下文文件仍然准确（AGENTS.md / workflow/）**

- `AGENTS.md` Commands 逐条可用：`test/host.mjs`、`test/client.mjs` 存在；`package.json` 的 `check` ＝
  host + client + check-manifest + check-docs + check-submission（与 AGENTS.md 的"提交前提"完全一致）；
  `scripts/shots/make-shots.mjs`、`scripts/release.mjs` 存在。
- `AGENTS.md` Do-not-touch 未因本次改动失效：`docs/images/` 确为 **13 张**（顶层 7 张 + `docs/images/en/` 6 张，
  与 `scripts/check-docs.mjs:262-274` 断言的 13 个路径、`README.md:47-48` 的"七张/六张"一致）；
  README「明确不做的三类」仍在（`README.md:354`），ROADMAP 新文本只是引用它；`lib/detect.js` 仍是独立文件且本次未动。
- `AGENTS.md`/`CONTRIBUTING.md` 引用的 `workflow/README.md`、`PLAN.md`、`REVIEW-CHECKLIST.md`、`QA-REPORT.md`、
  `SESSION-HANDOFF.md` 与 `.specify/memory/constitution.md` 均存在；`workflow/` 下 **没有任何**对本次 ROADMAP 对账的
  状态描述（grep `ROADMAP|001-|T001` 零命中），也就不存在"被本次改动改旧"的描述；
  `workflow/SESSION-HANDOFF.md` 是未填写的空模板（无断言），不构成失效。

**范围外备注（据提示不计入发现）**

- 工作区另有 4 个**未提交**文件：`.gitignore`、`CONTRIBUTING.md`、`scripts/shots/README.md`、`scripts/shots/make-shots.mjs`
  （`+63/-5`）。它们不在 `e33873d` 内，且从新增的 `--width/--height/--allow-docs` 与 CONTRIBUTING 的 QA 说明看，
  属脚手架/流程轮，按提示不计入本次评审。但要提醒：`plan.md:17` 的非目标写的是"`scripts/` 一行不动"，
  若日后以 `git add -A` 收尾，这 4 个文件会被卷进"对账"提交，同时把该非目标声明变成假——建议提交前显式分文件。