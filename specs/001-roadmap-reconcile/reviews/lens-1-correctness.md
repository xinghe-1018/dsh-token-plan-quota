# Lens 1 — 正确性与健壮性（纯文档对账提交）

**对象**：提交 `e33873d`（`docs(roadmap): 与代码事实对账（②已落地、①部分完成、版本计划修正）`），
改动 = `ROADMAP.md` ＋ 新增 `specs/001-roadmap-reconcile/{spec,plan,tasks}.md`。
**评审者**：只读，一条 lens，报告为本轮唯一写入。
**行号口径**：本报告所有 `file:line` 均指 **提交 `e33873d` 的 blob**（`git show e33873d:<file>`），不是工作区当前内容——见文末「评审期间工件漂移」。

## 结论

**对 `e33873d`：有 3 条发现，最高严重度 MEDIUM**（1×MEDIUM、2×LOW）。本次改动的事实核验主体（②的三处行号、①的 `PRESETS`/预设计数、③的版本三方、编码护栏、README「已知边界」一致性）**全部命中，无一错位**；MEDIUM 那条是**状态行对既有决策记录的归因错误**，恰好落在本次改动新增的那句话上。

**后续状态（评审期间 HEAD 前进到 `fb9b1e5`，已独立复核，见文末）**：MEDIUM 已被修好且我复核过内容成立；2 条 LOW 中 **1 条仍开放**（`plan.md:37`/`:76` 仍写「L344 起」），另 1 条未涉及；复核时**新增 1 条 LOW**——`fb9b1e5` 的 Retro 里「实测」的三个标题行号与该提交自身不符。

## 发现

### [MEDIUM] `ROADMAP.md:10` 与 `ROADMAP.md:61` — 把「C 档怎么支持」写成了「按 README 明确不做的三类不做」，且把「需 Cookie」划进不做

新增文本（顶部状态表 ① 行、§1 状态行）写：
- `:10` 「B/C 档（需额外强凭据 / 本地登录态）按 README「明确不做的三类」不做。」
- `:61` 「B/C 档（需 Cookie / OAuth / Admin key 等额外凭据）按 README「明确不做的三类」不做。」

同一提交明确保留的两处记录说的是另一回事：
- `README.md:354-361`「明确不做的三类」= **GLM 团队模式额外头 / Kimi Code 浏览器 Cookie 与 CLI 凭据文件 / Codex·ChatGPT、Gemini CLI 的 OAuth token 文件**；`ROADMAP.md:358`（§4 决策记录第 2 条，本次一行未改）记的也是**同样三类**。
- `ROADMAP.md:67` 定义 **C＝官方没有额度接口（只能走本实例实测窗口）**；`ROADMAP.md:357`（§4 第 1 条）把 C 档写成**正面决策**（「C 档平台显示"实测"徽标（不再整枚消失）」）。

**一句话失败场景**：读者问「Gemini API Key / MiniMax 为什么不接额度？」——状态行让他去 `README.md:354-361` 找依据，可这两档**根本不需要任何额外强凭据**（`ROADMAP.md:76` 记 Gemini 是「C（API Key）/ B（OAuth）」，`:79` 记 MiniMax「无 Key 化端点」），三条里没有一条对得上；同一文件 `:67`、`:357` 的真正答案是「C 档只做实测窗口」——FR-004「两处表述必须一致」在这句话上不成立，读者会以为 C 档被放弃了。

同一句话还有第二个可独立复现的错处：`:61` 把「需 Cookie」列为「按明确不做的三类不做」，而**控制台 Cookie 是已发布能力**——`lib/index.js:745` `cookieRef: 'BAILIAN_CONSOLE_COOKIE'`（预设键 `token-plan-console`，`lib/index.js:737`），`README.md:239` / `:246` 正**教用户粘贴整行 Cookie**。读者据此会以为 Cookie 形态不受支持。（C 档里的 Cookie 与控制台 Cookie 是两种东西，混在一句话里必然误读。）

### [LOW] `specs/001-roadmap-reconcile/plan.md:34`（并在 `plan.md:73` 复述）— 引用的 README 记录位置写成「L344 起」，实际差 10 行

`:34`「C/B 档"不做"的记录位置 | README「明确不做的三类」（L344 起）」；`:73`「实现时对照 README L344 起的表述逐条对齐」。
实测：`README.md:344` 是 **`## 已知边界`**，`## 明确不做的三类` 在 **`README.md:354`**。

**一句话失败场景**：按 plan 的行号跳 `README.md:344` 去核对权威记录，落在「已知边界」上，必须再往下找 10 行；同一张前提表里 `README.md:48`、`README.en.md:52`、`check-docs.mjs:222`、`lib/index.js:44/:1189/:2245` 都精确到行，只有这一条不精确。

### [LOW] `ROADMAP.md:10` 与 `ROADMAP.md:59-62` — ①「部分完成」的归因漏掉 A 档自身的推迟项

状态行把 ① 的不完备只归因于两件事：B/C 档不做 ＋ 字段名未用真实 Key 核对（对应 `ROADMAP.md:155` T1.8 `[ ]`）。但 A 档自身还有未完成项：
- `ROADMAP.md:134` `T1.4b 一源多请求`（OpenRouter，A 档）`[ ]`
- `ROADMAP.md:137` `T1.5 预设：glm-quota … **主动推迟**（2026-09-06）` `[ ]`——智谱是 `ROADMAP.md:73` 的「A（个人）/ B（团队）」，即这是 **A 档平台的预设被主动推迟**

**一句话失败场景**：读者只按状态行结论读（spec 的 User Story 1 正是「只读 ROADMAP 能否说出三阶段状态」），得到「A 档已落地、B/C 档不做」，据此认为 A 档无遗留，从而漏掉 glm-quota / T1.4b。
**降级理由**：任务清单就在同文件下方且 `:137` 明确写着「主动推迟」，信息并未丢失，故只记 LOW，不上升为「把部分完成写成完成」。

## 评审期间工件漂移（不是 `e33873d` 的缺陷，但影响这次评审的可复现性）

评审期间工作区被改动两次，**被评审对象在脚下变了**：

| 时点 | `ROADMAP.md` | 其余 |
|---|---|---|
| 评审开始时 | `c884ce0`（提交 `e33873d` 的 blob，406 行） | `plan.md` 110 行 / `tasks.md` 21 行 |
| 评审中途（11:47:14） | 工作区变 `65bdebb`→`b39a2f5`（未提交，`+4/-2`） | `plan.md`、`tasks.md` 也被改（未提交） |
| 评审尾声 | 上述改动被提交为 `b5e3c2f` + `fb9b1e5`，HEAD 由 `e33873d` → `fb9b1e5` | 工作区现已干净 |

**后果**：任何在 11:47 之后读工作区的人，读到的都不是 `e33873d` 的内容；本报告的行号**全部锚定 `e33873d` 的 blob**（`git show e33873d:<file>`），不受影响，但复现时请显式用 `git show`，不要用工作区文件。

## 后续提交复核（`b5e3c2f` / `fb9b1e5`，不属本次评审范围，仅作闭环核对）

`fb9b1e5` 的提交信息自称「修评审发现（B/C 档判定与 Cookie 边界、引用改锚点、勾选对齐）」。我**不采信标题**，逐条复核如下：

- **上面的 MEDIUM 发现：已修，且修得对。** 新文本（`fb9b1e5:ROADMAP.md:10` 与 `:61-65`）把「不做」收窄为 `README.md:355-361` 那三类（GLM 团队模式额外头 / Kimi Code 浏览器 Cookie 与 CLI 凭据文件 / Codex·Gemini 的 OAuth token 文件——逐字对上 ✓），把 C 档改为「不是不做，只做实测窗口」并引 T1.6 `[x]`（`fb9b1e5:ROADMAP.md:147` 确为 `[x]` ✓），并显式写「不用 Cookie 不是本项目的边界」（`token-plan-console`/`BAILIAN_CONSOLE_COOKIE` 确实存在 ✓）。修后的陈述与 `:69`（C＝官方无额度接口）、§4 决策记录（C 档显示实测徽标）不再冲突。
- **上面的 LOW 发现 #2（引用 `L344 起`）：仍开放。** `fb9b1e5:plan.md:37` 与 `:76` 依旧写「README「明确不做的三类」（L344 起）」；同一提交只把 §5 设计表的位置引用换成了标题锚点——提交信息里的「引用改锚点」并未覆盖这两处。
- **上面的 LOW 发现 #3（① 状态未提 A 档自身推迟项）：仍开放。** `fb9b1e5:ROADMAP.md:139`（T1.4b）、`:142`（T1.5 `glm-quota`）仍是 `[ ]`，① 状态行仍未提及。
- **[LOW] 新增（对 `fb9b1e5`）：`plan.md:117`「（实测三个阶段标题为 L57 / L181 / L276）」与该提交自身的文件不符** —— 实测 `fb9b1e5:ROADMAP.md` 三个阶段标题在 **L57 / L184 / L279**。**失败场景**：读者按 Retro 里标着「实测」的行号去定位 §2，落在 §1 尾部 3 行开外；这条正是本轮「行号会腐烂」教训的同一个坑，只是从对外文档挪进了计划工件。该 commit 的 `ROADMAP.md` 本身仍是编码护栏干净的（`# R` 开头、无 BOM、`U+FFFD` 0、私用区 0 ✓）。

## 我核验过但不构成发现的项

以下逐条**独立查过**（不是相信文档自述），结论是准确：

1. **②的三处行号全部精确**（字节级读取 `lib/index.js`，LF-only，2711 LF）：`:44` = `  autoDetect: true,`（`DEFAULTS` 内，上一行 `:43` 就是零配置注释）；`:1189` = `async function applyAutoDetect(config, ctx) {`（定义）；`:2245` = `  const detection = await applyAutoDetect(config, ctx)`（调用点，`computeStatus` 内）。`lib/index.js` 相对 HEAD 干净，行号未被后续编辑漂移。
2. **①的 `PRESETS`**：顶层键恰好 **8** 个——`deepseek-balance`(`:683`)、`token-plan-window`(`:705`)、`token-plan-console`(`:737`)、`moonshot-balance`(`:768`)、`openrouter-credits`(`:806`)、`account-balance`(`:828`)、`fr-instances`(`:848`)、`resource-package`(`:875`)。含 `moonshot-balance` ✓、`openrouter-credits` ✓。
3. **「§0 记的 6 个预设」与 §0 原文一致**：`ROADMAP.md:24` 列 6 个（`deepseek-balance`、`token-plan-window`、`token-plan-console`、`account-balance`、`fr-instances`、`resource-package`），6 ＋ 2（`moonshot-balance`、`openrouter-credits`）= 8 ✓（§0 未被改动，新文本已显式标注「§0 记的 6 个现为 8 个」这一差量）。
4. **③的三方版本**：`npm view dsh-token-plan-quota dist-tags.latest` = **`0.4.8`**；本地 tag `v0.4.8` 存在（指向 `6630a00`，2026-09-15）；`CHANGELOG.md:22` = `## [0.4.8] - 2026-09-15`（与文中 `（2026-09-15）` 一字不差）；`package.json` `version` = `0.4.8`。
5. **「本文原定的 `1.0.0` 尚未」成立**：npm 已发布版本仅 `0.4.2 / 0.4.6 / 0.4.7 / 0.4.8`，无 `1.0.0`；本地 tag 到 `v0.4.8` 为止，无 `v1.0.0`。**③「已开源发布」有依据**：registry 上确有公开版本 ＋ tag ＋ CHANGELOG ＋ §3.3 任务 T3.1–T3.9 全 `[x]`。
6. **「①②随 0.3–0.4 线落地」与 git 事实一致**（逐条 `git tag --contains`）：①的 `moonshot-balance`(`12b22ac`)、`openrouter-credits`(`d4be5ad`) 首见于 **v0.3.0**；②的零配置检测 `6aca28a` 首见于 **v0.4.0**（不在 v0.3.0）。
7. **`README.md`「已知边界」表述与新文本一致，不存在「一处说未核对、一处说已核对」**：`README.md:352`「Moonshot / OpenRouter 的字段名**尚未用真实 Key 核对**」，`:85`/`:86` 两行也标「字段名未用真 Key 核对」；`ROADMAP.md:10`/`:60`/`:59` 的说法与之同向，且指向同一小节 ✓。另 `ROADMAP.md:155` T1.8（真实 Key 逐家核对）确为 `[ ]` ✓。
8. **编码护栏与文件字节（健壮性）**：`scripts/check-docs.mjs:222` 确实把 `ROADMAP.md` 列入第 9 项编码护栏（与提交信息、plan 前提 5 的说法一致，前置假设「门禁不看 ROADMAP」的自我修正成立）。字节级实测 `e33873d:ROADMAP.md`（也复核了工作区当前版本）：**前 3 字节 = `35,32,82`（`# R`，无 BOM）**，`U+FFFD` = 0，私用区 `U+E000–U+F8FF` = 0，CJK 8057 字；即不会触发护栏的任一条（BOM / 替换符 / 「有 CJK 且有私用区」），也无 GBK 误读残骸。`ROADMAP.md` 以换行结尾。
9. **plan 前提核验**：`plan.md:32`「`check-docs.mjs:222`」✓（该行正是含 `ROADMAP.md` 的 `textFiles` 数组）；`plan.md:33`「`README.md:48` / `README.en.md:52` 是链接引用」✓（`README.md:48` 含 `[ROADMAP](ROADMAP.md)`，`README.en.md:52` 含 `[ROADMAP.md](ROADMAP.md)`；两份 README 相对 HEAD 均干净）；前提 4「`package.json#files` 里没有 ROADMAP」✓（`files` = `lib, docs, cordis.patch.yml, README.md, README.en.md, CHANGELOG.md, LICENSE`）；前提 8「`files` 里没有 `specs`」✓。
10. **`plan.md:64`「`npm pack --dry-run` 24 files」**：实跑 `npm pack --dry-run --json` 得 `entryCount = 24` ✓（不写盘）；且清单里 **无 `ROADMAP.md`、无 `specs/`** ✓（旁证前提 4/8）。
11. **`plan.md:62-64` / `tasks.md:8-10` 的 `L48 / L165 / L257`**：这是**改动前**（`e33873d^`）的行号——`e33873d^` 中 `## 1.` = L48、`## 2.` = L165、`## 3.` = L257，**完全正确**；插入后实际变为 L57 / L179 / L274。计划工件用规划时坐标，不算缺陷；且这些数字没有出现在对外的 `ROADMAP.md` 里，不会误导读者。
12. **`tasks.md:7`「顶部（`ROADMAP.md` L1–L7）」**：插入区确实落在「顶部」——`e33873d^` 的 L1–L7 头块被插入段顶到 L14/L16，新内容在 L6–L15 ✓（区域描述，非逐行坐标）。
13. **`plan.md:28`「grep `autoDetect` → 11 处」**：可复现但口径模糊——**行数**口径（PowerShell `Select-String` 默认大小写不敏感，含 `applyAutoDetect` 所在行）恰为 **11 行**；若按**大小写敏感的匹配次数**则为 `lib/index.js` 内 **10 次**／7 行。原文写「11 处」在行数口径下成立，故不记为发现，仅提示口径。
14. **未发现「无法核验的断言」**：新增文本里的每条状态依据（`lib/index.js:44/:1189/:2245`、`PRESETS` 两家预设、registry `latest`、tag、CHANGELOG 版本段、§0 预设计数）都能 grep 到；③「已开源发布」有 registry/tag/changelog 三证；②「已完成」有 §2.2 任务 T2.1–T2.8 全 `[x]` 支撑。唯一过度声称就是上面 MEDIUM/LOW 两条。
15. **旁注（不构成发现，未改动内容）**：`ROADMAP.md:20` §0 标题自称「现状盘点（v0.2，代码事实）」，而 `ROADMAP.md` 本身并不存在于 tag `v0.2.0`（首次加入是 `99f0a45`，2026-09-06，首个含它的 tag 是 v0.3.0）——所以提交信息/plan 里的「写于 v0.2」应读作「描述 v0.2 代码状态」，与文档自称一致。另 §0 的行号引用（如 `:16` 的 `normalizeSources()（L926）`，实际定义在 `lib/index.js:1019`）在本次改动前即已过期，本次未触碰，仅作背景记录。