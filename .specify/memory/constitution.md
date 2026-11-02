<!--
Sync Impact Report
==================
- Version change: 1.0.1 → 2.0.0
- 变更类型: MAJOR（按本文 Governance 的档位：这改的是 NON-NEGOTIABLE 原则 I 的**边界**，不是清单同步）
- 修订内容: 把"没有官方分母就永不出现百分比"限定为"不得**自行派生**百分比"。触发事实：
  2026-09-23 千问控制台把 `usage` 改成按月之后，上游**直接返回** `per1MonthPercentage` 这个官方
  比例；而同一次查询里的 `quota-config` 会超时（实测 5 次里 1 次，那一次全程 19.8 s），此时没有
  分母。按旧解读整张卡必须退回"无数据"——结果是**一个能追溯到官方字段名的真值被丢掉**，反而与
  原则 I 第一句（每个数字必须可追溯到官方真值或实测账本）相悖。新口径：上游直接返回的比例属官方
  真值，可以显示，也可以照它画余量条；**派生**出来的百分比仍无条件禁止。另一条硬约束：
  **不报绝对剩余量**（算不出来的东西不显示），并且必须留 `extra.denominatorFailed` 一类的诊断，
  不得静默降级。
- 修订过程中的一次自我更正（同样记在这里）：初稿额外写了"缺分母时**不画余量条**"，实机试了半小时
  就被用户否掉——"换回条状显示"。理由成立：条画的是同一个官方比例（`100 − 已用%`），禁它只是在
  视觉上惩罚用户，并不增加任何真值保护。**v2.0.0 尚未随任何已发布版本出厂**（0.4.9 打的是 1.0.1
  口径），所以在它本身的措辞里改掉，不另计版本号、不制造假 semver 流水。
- 未变更: 原则 II–VI（含另两个 NON-NEGOTIABLE）、附加约束、开发工作流、Governance 规则本身。
- 触发来源: 用户报告"插件的额度显示又出现问题"；诊断与实测见 CHANGELOG 与 docs/upstream-contracts.md。
- 上一版记录（1.0.1）保留在下方。

## 1.0.1（清单同步）
- Version change: 1.0.0 → 1.0.1
- 变更类型: PATCH（清单同步，非语义修订）
- 修订内容: VI 章第 4 条里 `npm run check` 的组成清单由 5 项补为 7 项（新增 guards、check-refs
  两道门禁），并注明以 `package.json#scripts.check` 为准。该清单是"订阅"而非规则本身——
  门禁集合变了它就该跟着变，否则 `AGENTS.md` 所称的"判定口径的权威"这一份会最先漂。
- 未变更: 六条原则（含三个 NON-NEGOTIABLE 标记）、附加约束、开发工作流、Governance 规则。
- 触发来源: specs/003-guardrails-and-doc-hygiene（把两个新门禁接进 `npm run check` 与 CI）。
- 上一版记录（1.0.0）保留在下方。

## 1.0.0（首次确立）
- Version change: (none) → 1.0.0
- 新增原则:
    I.   真值优先，绝不估算 (NON-NEGOTIABLE)
    II.  凭据只进不出 (NON-NEGOTIABLE)
    III. 只读且零计费探活 (NON-NEGOTIABLE)
    IV.  零依赖、单包双半边
    V.   可核性优先于宣称
    VI.  离线、跨平台、可重现的回归
- 新增章节: 附加约束：上游契约与发布卫生；开发工作流与质量门；Governance
- 删除章节: 无
- 待办 TODO: 无（本文为首次确立，占位符已全部落实）
- 来源说明: 本宪法把既有实践成文化，不引入新约束。I–III、VI 来自 CONTRIBUTING.md
  「产品口径（改代码前先读）」六条与「跑测试」；IV 来自 CONTRIBUTING 首段与
  package.json 无 dependencies 的事实；V 来自 CONTRIBUTING「描述必须属实」与
  check-manifest 的出站主机声明门。其中「阶段声明已落地必须同步更新」一条由 V 延伸
  而来（本轮实测发现 ROADMAP.md 的 ②阶段已落地却仍写作待做）。
- 非治理意图（延后，不在本次执行）: 无。
-->

# dsh-token-plan-quota Constitution

## Core Principles

### I. 真值优先，绝不估算 (NON-NEGOTIABLE)

徽标、明细面板与 `token_plan_quota` 工具返回的每个数字，必须可追溯到二者之一，并明示归属：

- **官方接口真值**，或 **本实例「实测」窗口**（只统计经过本 DSH 实例的真实调用）。

永久禁止：Credits 折算、抵扣率换算、「按历史推算剩余」。**没有官方分母就永不自行派生百分比**
（`used/total` 与任何换算式都算派生）。上游接口**直接返回**的比例（如千问 `usage.per1MonthPercentage`）
属官方真值，可以显示，也可以照它画余量条——`100 − 已用%` 是同一个官方数的反向写法，不是第二个事实；
但缺分母时**不报绝对剩余量**（算不出来就是不报），且必须留 `extra.denominatorFailed` 一类的诊断，
不得静默降级成"无数据"。实测卡永不画余量条、永不显示百分比（它压根没有官方读数）。
一个计量窗口当且仅当该套餐确实返回了读数时才存在——档位配置里躺着的上限值不是额度，
只能进 `extra.*ConfiguredNoReading` 供 debug。

**理由**：用户据此数字做支出决策。在这个位置，估算值不是"差不多"，是有害。

### II. 凭据只进不出 (NON-NEGOTIABLE)

密钥与 Cookie 只在本进程解析与使用，**绝不**进入路由响应、日志、错误信息、测试快照、
截图流水线或仓库。文档、CHANGELOG、issue、提交信息中只允许出现凭据**键名**，禁止出现值。

**理由**：本插件跨多家供应商持有长期凭据，一次回显即不可撤销（网关侧上下文无法追回）。

### III. 只读且零计费探活 (NON-NEGOTIABLE)

只调用只读端点。任何可能产生计费的请求一律禁止，无论以"探活""预热""对账"何种名义。
未用真实 Key 核对过的端点与字段名，必须在文档中标注「官方文档背书，未用真 Key 核对」。

**理由**：一个额度插件绝不能成为用户账单的来源，也不能用未经核对的字段名误导用户。

### IV. 零依赖、单包双半边

运行时零第三方依赖（`package.json` 不出现 `dependencies`）；宿主半边与浏览器半边同包分发。
浏览器半边手写 bundle，不引入构建步骤；新增能力不得以"引入一个依赖"为代价。
平台差异靠运行时探测，不靠打包变体。

**理由**：插件必须能在宿主的最小环境里原地加载，这是它可安装性的前提。

### V. 可核性优先于宣称

README、`dshhub.summary`、`docs/`、issue 中出现的数字、端点名、主机名，一律视为**会被拿去
与代码对账的断言**。具体约束：

- `dshhub.permissions.network` 的声明集合必须与实际出站主机集合逐项相等；新增出站主机必须同步声明。
- 对外描述与代码同源；描述层（README 中英、`docs/`）与实际行为漂移时，以代码为准并立即修文档。
- 阶段/路线图声明若已落地，必须同步更新——禁止把已完成项留在"待做"。

**理由**：这个项目的对外承诺就是它的产品面，宣称与实现之间的距离就是它的可信度。

### VI. 离线、跨平台、可重现的回归

- `node test/host.mjs` 与 `node test/client.mjs` 必须离线运行（仅回环 HTTP 例外），
  且不依赖真实 `~/.dsh`（测试把 `DSH_HOME` 指向临时目录）。
- 不写死平台路径；临时目录一律 `join(os.tmpdir(), ...)`；Linux / macOS / Windows 三平台都必须能跑。
- 新增能力同步新增断言；**修复缺陷必须带能重现该缺陷的回归测试**。
- `npm run check`（host + client + guards + check-manifest + check-docs + check-refs + check-submission，
  以 `package.json#scripts.check` 为准）全绿是任何改动进入仓库的前提。

**理由**：无构建步骤的项目里，测试是唯一的结构性保障。

## 附加约束：上游契约与发布卫生

- 新增供应商/数据源必须照 `docs/adding-a-provider.md` 的清单执行：预设 → `SOURCE_META` →
  `errorHints` → `PLATFORM_RULES` → 回环单测 → `probe` 核对 → 文档回填。
- 每条上游契约在 `docs/upstream-contracts.md` 中必须带出处（官方文档链接）与陷阱说明：
  信封路径、单位、方向（绝对值 / 剩余 / 已用）——接错方向等于仪表反向。
- 错误提示必须给出**下一步动作**，不得只复述状态码。
- 版本遵循语义化版本；CHANGELOG 遵循 Keep a Changelog；发布走 `scripts/release.mjs` 与
  `RELEASE.md`，验证必须留下可核对的证据（registry 的 `dist-tags` / `versions`）。
- 已决定不做的档位（如需 Management / Admin key 或 OAuth 的形态）必须写进 README 的
  "明确不做的三类"，避免反复讨论。

## 开发工作流与质量门

- 提交信息用 Conventional Commits；一个提交只做一件事；正文写**为什么**，尤其写清被推翻的
  初版思路——在本项目里"为什么不用另一种做法"比代码更贵。
- 涉及对外描述（README、`dshhub.summary`、issue）的改动必须与代码同源，并在同一次提交内完成。
- `docs/` 是 `package.json#files` 的显式 allowlist 成员：对外文档放 `docs/`；中间产物必须
  放在 `docs/` 之外并加进 `.gitignore`（allowlist 会压过 `.gitignore`）。
- 凭据、余额、用量的真实数字不得进入仓库、测试快照或截图流水线。

## Governance

- 本宪法优先于仓库内其他实践。与 `CONTRIBUTING.md` / `ROADMAP.md` 冲突时以本文件为准，
  并即时修正那份文档。
- 修订程序：提出变更 → 说明 bump 类型 → 更新本文件并在顶部写 Sync Impact Report →
  以 `docs: amend constitution to vX.Y.Z (<摘要>)` 提交。
- 版本号规则：MAJOR＝移除或重定义原则、引入不兼容治理；MINOR＝新增原则或实质性扩展约束；
  PATCH＝措辞澄清、错别字等非语义修订。
- 合规评审：每个提交 / PR 必须核验本宪法；`npm run check` 为机械化门，任何一项为红即不得合并。

**Version**: 2.0.0 | **Ratified**: 2026-09-18 | **Last Amended**: 2026-09-23