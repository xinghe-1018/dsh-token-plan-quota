# 003 Lens 1 — 正确性与健壮性

**评审提交**：`82b6561`（`003-guardrails-and-doc-hygiene`）。行号一律按该提交写；工作树后来前进到 `91a4b76`，若某条已被后续提交修掉我只在条目里注明。全部实验只读：仓库内**未修改/未新建/未删除**任何文件（每条结论见下方命令；临时件都在 `%TEMP%\lens1-82b6561\`，含 `git archive 82b6561^` 的解包副本与 junction 链接）。

## 验证方式（可复跑）

| 实验 | 命令/做法 | 结果 |
|---|---|---|
| 门禁本体 | `node scripts/check-refs.mjs`、`node test/guards.mjs` | `OK（18 个活文档）` exit 0；`32 passed, 0 failed` exit 0 |
| FR-001 可证伪 | `git show 82b6561^:scripts/shots/fixture.mjs` → `%TEMP%\oldfix\`（借 `lib/index.js` 满足 `../../lib/index.js`） | 旧实现 `now=1789716103943` **必抛** `不含真实痕迹 "7943"`（zh/en 两套都抛）；新实现放行 —— **可证伪性成立** |
| 假红率 | 用「叶值 = `now+偏移`」模型复刻旧规则，与**真实旧函数**对拍 250 次 | **0 处不一致**（模型可信）；真实每轮假红率见 F-3 |
| T6 回归隔离 | 新旧 `makeSnapshot` 同 `now` 下 `JSON.stringify` | 5 变体 × 2 语言 **10/10 逐字节相同** —— 断言属实 |
| 门禁行为矩阵 | 自建「CommonMark 式围栏状态机」对照 `findLineRefs`，对 19 个在范围文档 + 8 个构造文档 | 见 F-2；在范围文档当前唯一的分歧源是 `workflow/ENVIRONMENT.md` |
| 链接抽取 | 从 `scripts/check-docs.mjs` 原文 slice 出 `extractLinkTargets/normalizeTarget/classifyTarget` 直接调用，与 `82b6561^` 的两套正则同表对照 | 见 F-4/F-7；真实两份 README 上 `escape=0`、全部相对目标存在 |
| 冻结工作树 | `git status --short` | **不成立**：`?? specs/003-…/qa-report.md`、`?? specs/003-…/reviews/` 在评审期间出现，`check-refs` 的扫描面从提交态的 18 份变成 19 份（`reviews/` 被排除，`qa-report.md` 在范围内）。对 82b6561 的行号无影响 |

---

## 发现

### HIGH

- **[HIGH] `scripts/check-refs.mjs:110` — main 守卫让门禁在符号链接/ junction 下**静默不执行**（exit 0、零输出）**
  `if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()`：Node 的 ESM 加载器会把入口模块解析成 **realpath**，而 `process.argv[1]` 保留调用时的路径；两者不等 → `main()` 被跳过 → 无输出、`process.exitCode` 保持 0。失败场景：在符号链接的检出/工作目录（Windows junction、macOS `/tmp`→`/private/tmp`、Linux 软链工作区）里跑 `npm run check`，`&&` 链只看退出码 → **CI 与 pre-commit 全绿，而这条门禁一次都没跑**，与脚本自己在 `:17` 写的「门禁自己悄悄失效是最坏的假绿」正好相反。
  实测：`New-Item -ItemType Junction -Path %TEMP%\lens1-82b6561\linkrepo -Target <repo>` 后 `node …\linkrepo\scripts\check-refs.mjs` → **无任何输出、exit 0**；同一命令走真实路径 → `check-refs: OK（18 个活文档，无行号引用）`。机制单独复现：junction 下 `resolvedArgv1 = …\linkdir\mech.mjs` 而 `importMetaUrlPath = …\realdir\mech.mjs`，`wouldRunMain: false`。`test/guards.mjs` 只 `import { findLineRefs }`，**主路径没有任何用例覆盖**，所以这个洞不会被现有矩阵抓到。
  （与 Lens 2 的「readdir 跟随 junction」是两回事：那条是扫描面越界，这条是**主函数根本不跑**；但同一条 junction 会同时触发两者。）

- **[HIGH] `scripts/check-refs.mjs:54` — 围栏剥离是「按出现顺序两两配对」，一个游离的 ``` 就把该文件后半段的判定反过来（同一次编辑同时造出假绿与假红）**
  `text.replace(/```[\s\S]*?```/g, ' ')` 只把第 1/3/5…个 ``` 与下一个配对，因此**任何奇偶错位**（正文里提到一次 ```、围栏被 `~~~` 写、四反引号嵌套）都会把「散文段」当成围栏内剥掉、把「围栏内」当散文来扫。失败场景：`workflow/ENVIRONMENT.md` **当前就是奇数**（`:45` 的 `` `"```" ` `` 是一处游离的 ```，全文件只有这一处，我用 `/`{3,}/g` 数过 51 份 md，只有它是奇数）。在该文件末尾追加一段普通围栏代码块后实测：散文里的真违规 `ROADMAP.md:12` **不再报**（假绿），围栏里的示例 `lib/index.js:44` **反而报红**（假红）——输出的命中项是 `["lib/index.js:44"]`，与应有的 `["ROADMAP.md:12"]` 完全互换。
  同一函数的第二个洞：`~~~` 围栏（合法 CommonMark）完全不被剥，构造输入 `~~~\n见 lib/index.js:44\n~~~\n` → 命中 `lib/index.js:44`，而该内容按文档承诺应当放行（假红）。
  影响面：`specs/003-…/plan.md` 自己的 T3 样例正**依赖**围栏豁免（HEAD 上不剥围栏时有 4 处裸命中、剥后 0 处），所以这条豁免是承重的，不是可有可无。

### MEDIUM

- **[MEDIUM] `scripts/check-docs.mjs:72-82` — `extractLinkTargets()` 相对旧的第 4 项**收窄**了覆盖：链接文字里含方括号的目标，现在两个消费者都看不见**
  新实现要求 `\[[^\]]*\]\(`（`]` 到 `(` 之间不能有 `]`），而旧第 4 项的 `/\]\((?!https?:|#|mailto:)([^)#\s]+)/g` 是「见 `](` 就取」。失败场景：README 写 `[see note [1]](docs/a.md)` 或 `![shot [1]](docs/a.png)` → 新抽取返回空，第 4 项与 4b 都放行；旧的第 4 项会报出来。实测：`old4=["docs/a.md"] / ["docs/a.png"]`，`new=[]`。这是「单源化」顺带丢掉的覆盖，而 T2 的叙述是「原先只有 4b 认得的写法，现在第 4 项也认得」（只讲变宽，没讲变窄）。当前两份 README 不受影响（21/20 个原始目标全部正常抽出，无缺失）。
- **[MEDIUM] `scripts/shots/fixture.mjs:359-367, 387-396` — 逐叶扫描 ≠ JSON 序列化：键、`toJSON()` 对象、BigInt 从守卫里消失**
  `collectLeaves()` 走的是内存值，旧实现走的是 `JSON.stringify` 的产物，两者并不同构。实测（同一注入，新旧对拍）：`snap.probe = new Date('2026-09-14T00:00:00Z')` → 旧**报红**、新放行（Date 没有自有可枚举属性 → 收集不到任何叶）；`snap['OMEN'] = 'x'`（键名带真实痕迹）→ 旧报红、新放行（新实现只收值不收键，嵌套键 `s.stats['39.91']` 同理）；`snap.probe = 7943n` → 旧因 `JSON.stringify` 抛 `Do not know how to serialize a BigInt` 报红，新静默放行。真实余额 / 用户名 / 盘符 / 日期这四类**值**仍然抓得住（见下方「干净面」），所以这是守卫范围的收窄，不是失效。
- **[MEDIUM] `scripts/shots/fixture.mjs:359` — 1e12 豁免没有上界、也不限定于那批 `now` 派生字段，任何 ≥1e12 的整数都能藏住 4 位禁用串**
  `isClockMillis = value => Number.isInteger(value) && Math.abs(value) >= 1e12`。失败场景：`snap.probe = 17943999999999`（≥1e12，十进制里含禁用串 `7943`）→ 旧报红、新**放行**；`9063000000000`（含 `9063`）同理。注释给的安全依据是「真实痕迹都远在 1e12 以下」，但代码没有把这个依据变成约束：豁免的是「量级」，而禁用串里有两个是 4 位数字串（`7943`/`9063`），它们可以被任意大整数命中。务实地说，我构造的反例**不像**一笔真实余额，所以这不是「守卫失效」，而是一处**声明比代码更宽**的豁免（连 `test/guards.mjs:95` 自己那个 `7_939_999_999_999` 用例也说明豁免不看值是否真的像时钟：那是公元 2221 年）。
- **[MEDIUM] `specs/003-…/plan.md:141`（`tasks.md`/提交信息同源） — 「修复前 26 条红线」不可复现**
  实测：把 `82b6561` 的 `check-refs.mjs` 放进 `git archive 82b6561^` 的解包树跑 → **21 条**命中行、exit 1；同一树按原始出现次数是 **27** 次（`ROADMAP.md` 4/7、`specs/001` plan 9/12、qa 1/1、tasks 7/7），14 个在范围文档。21、27 都不是 26，「可证伪」这条自己的证据数字对不上。注意 `findLineRefs` 有**按 label+match 去重**（`:55-63`），所以「红线数」既非命中次数也非违规处数；报告数量本身也没有说明口径。（FR-003 的**定性**可证伪性成立：确实报红、确实 exit 1。Lens 3 已独立报了 3.73% 那条算错，此处不重复。）
- **[MEDIUM] `specs/003-…/plan.md:113` 与 `spec.md:28` — 行为矩阵把「旧的第 4 项」说窄了：带 title 的写法它一直认得，所以「三种写法」实为两种**
  plan T2 表写「带 title `[x](a.md "t")` → 修复前 **第 4 项不认**」、spec FR-002 验收写「原先只有 4b 认得的**三种**写法」。实测旧第 4 项正则（`82b6561^`）在 `[x](a.md "t")` 上捕获 `a.md`（`[^)#\s]+` 遇空格即止），即**是认的**；真正对它隐形的只有引用式与 HTML 两种（这两条我确认属实）。失败场景：下一位维护者拿着这张矩阵做回归，会以为 title 形态是这次修好的行为，从而在一个**从来没坏过**的格子上得出错误因果（本规格的全部主张都建立在「行为矩阵实测」上）。
- **[MEDIUM] `specs/003-…/plan.md:18` 与提交信息 — 「10 个由 `now` 派生的 13 位毫秒时间戳」低估了命中面**
  用两个独立 delta（+1000、+12345）在真实快照上识别 `now` 派生叶值：panel/zh 有 **16** 个、triptych 8 个、cookieDrop 12 个（`10` 的说法只对某个中间形态成立）。它直接进入概率模型的分母，所以「2279/600000」这类数字是在错误的基数上算的。（与 Lens 3 的 3.73% 是同源问题的两个面，此处只补数字。）

### LOW

- **[LOW] `scripts/check-docs.mjs:76` — 注释「旧实现两头都错：既把外层 URL 当成图片目标，又让这个写法整个躲过检查」对任何一版旧实现都不成立**
  实测 `[![alt](docs/images/a.png)](docs/other.md)`：`82b6561^` 的**第 4 项**捕获 `["docs/images/a.png","docs/other.md"]`，`4b`（`cce1904` 引入，与 `82b6561^` 相同）也捕获这两个；`cce1904^` 里根本没有 4b 抽取段。所以「外层 URL 被当图片目标」「整个躲过检查」都不是事实。场景：维护者据此认为徽标式是这次修掉的真 bug，不再给它做回归用例（矩阵里确实也没有徽标式用例）。
- **[LOW] `scripts/check-refs.mjs:43` — 扩展名白名单是维护陷阱，`file:line` 的多种等价写法一律静默放行**
  实测放行（`findLineRefs` 返回 `[]`）：`lib/index.ts:44`、`lib/index.jsx:44`、`LICENSE:5`（本仓确有 `LICENSE` 这种无扩展名文件）、`lib/index.js : 44`（冒号前后有空格）、`` `lib/index.js`:44 ``、以及 GitHub permalink 形态 `…/index.js#L44`。场景：仓库哪天加了一个 `.ts` 文件或文档改引 `…/x.yaml`（不在表内）之外的扩展名，门禁继续绿；`#L44` 更是**会腐烂的行号引用**却不在任何一条规则里（`L44` 裸形态是刻意排除的，但 `文件#L44` 不是）。
- **[LOW] `scripts/check-docs.mjs:79` — 缩进 1–3 格的引用式定义（合法 CommonMark）不被抽取**
  实测 `  [r]: docs/a.md`、`   [r]: docs/a.md`、`\t[r]: docs/a.md` 全部 `new=[]`（`^\[` 要求顶格）。`82b6561^` 的 4b 也是 `^\[`，所以**不是回归**，只是这次「四种写法全覆盖」的说法不覆盖缩进形态。
- **[LOW] `scripts/check-refs.mjs:74` — `readdirSync(dir, { recursive: true })` 需要 Node ≥ 20.1，而 `package.json` 只要求 `>=20`（未实跑，本机 Node 24）**
  在 Node 20.0.x 上 `recursive` 会被忽略 → 只拿到 `workflow/*.md` 顶层 6 份 + `ROADMAP.md` = 7 份 → 触发 `:91` 的 `files.length < 8` 而**报红**。方向是对的（宁红不假绿），但报错文案会指向「目录改名/递归 API 变了」，读者得自己想到是 Node 小版本。场景：某人在 Node 20.0.0 上跑 `npm run check`，看到「扫描面像失效了」而实际是引擎下限写宽了。

---

## 我验证过、确认干净的面（不要在这几处"顺手修"）

1. **FR-001 的可证伪性与修复效果都成立**：旧函数在 `now=1789716103943` 必抛（两个语言），新函数放行；`test/guards.mjs:71` 那条「前提自证」也真的成立（该快照 JSON 确实含 `7943`）。
2. **T6 逐字节回归隔离属实**：5 变体 × 2 语言 = 10/10 `JSON.stringify` 完全相同 → 「截图不需要重拍」这个推论有据。
3. **我构造的 250 个确定性样本上，碰撞模型与真实旧 `assertFixture` 100% 一致**（含巧合点与非巧合点），所以「每轮约 0.28%、不是 3.73%」这条结论不是模型假象：`560/200000`（10 张快照取 OR）≈ **0.28%**，而单张 `460/200000` ≈ **0.23%**，两者比值只有 **1.0–1.22**——十张快照共用同一个 `now`（派生偏移高度重合），**不满足 `1-(1-p)^10` 的独立性假设**；提交信息里「20 次跑出 1 次红」的经验值（期望 1.08 次）恰好支持 0.28%，而不是 3.73%（后者 20 次里至少红一次的概率约 53%）。
4. **围栏豁免今天是必要的、且没有误伤**：HEAD 上不剥围栏会裸命中 4 处（正是 `specs/003-…/plan.md` T3 那段的样例），剥后 0 处。
5. **链接抽取在真实 README 上没有误报**：两份 README `escape=0`、全部相对目标存在、`skip` 9 个/份（含 `#frag`、`https:`、`mailto:`）；`docs/../ROADMAP.md`、`./x`、`<x>`、`"title"`、`?query`、`#frag` 的归一化都正确。`[x](docs/a(b).md)` 的截断是**新旧一致**的既存限制。
6. **三条「应放行」超易误报形态真的放行**：`7:00`/`比例 1:2`、`http://127.0.0.1:3080`、`第 1–9 项`（en dash 连行号一起被拒，见 LOW 里那条）。
7. **接线双份、钩子可执行**：`check-refs` 与 `guards` 同时进了 `package.json#scripts.check` 与 `.github/workflows/ci.yml`（manifest job）；`.githooks/pre-commit` 在提交里是 `100755`（`git ls-tree -r 82b6561 -- .githooks`），不是只在 Windows 上"看起来能用"。
8. **接线面的一项观察（非缺陷）**：本机 `git config core.hooksPath` 现在等于 `.githooks`（评审环境已启用），与「默认不启用」不矛盾——那是仓库外的一次本地配置。
9. **在范围文档没有任何行号引用**（0，exit 0），排除规则按预期生效：`specs/**/reviews/**` 与 `specs/reviews/*` 都被 `startsWith('reviews/') || includes('/reviews/')` 挡住，`specs/004/…/reviews.md` 这种同名文件不会被误排。

## 未能确认 / 没做完

- **「26」的出处**：我试过的口径（去重命中行 21、原始出现 27、全局去重 ≈13、不剥围栏 27、仅第 1 条正则 17）都得不到 26，无法还原当时的统计方式；这一条只能报「不可复现」，不能报「数字对应哪个量」。
- **Node 20.0.0 上 `readdirSync recursive` 被忽略**：只据 Node 文档判断（`recursive` 于 v20.1.0 加入），本机是 Node 24，**未实跑**。
- **F-2 的真实触发次数**：`workflow/ENVIRONMENT.md` 已处于奇数态，但当前它没有任何行号引用，所以「同一文件里同时假红+假绿」是我用追加最小编辑（一段散文引用 + 一段围栏）构造出来的，不是今天就能观察到的既有误判。
- 我没跑 `npm run check` 全量（`check-docs` 会 `execFileSync` 两个测试套件；为避免任何写入面，我只跑了 `check-refs`、`guards` 与 `git status` 复核，每次跑完确认工作树只有那两个 untracked 路径）。