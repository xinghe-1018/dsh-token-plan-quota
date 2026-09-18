# 003 — 任务

> 每步一个 commit；每步结束后工作树必须干净。引用位置一律用锚点或符号名，不写行号（本规格 FR-003 自我适用）。
> **勾选状态必须在交付后立即对齐**：本仓库为此吃过一次教训（001 的 Lens 3 发现 1 —— 工件与事实脱节时，
> 下一位 agent 会按"这一步没发生"重做或重复提交）。

## 实现

- [x] **T001** FR-001 误报消除：`scripts/shots/fixture.mjs` 的痕迹守卫改逐叶比对 + 时钟整数豁免（含上界）。
- [x] **T002** FR-001 回归隔离：证明固定 `now` 下 `makeSnapshot()` 输出逐字节未变（10/10），故截图无需重拍。
- [x] **T003** FR-002 单源化：抽出 `scripts/link-targets.mjs`（`extractLinkTargets` / `extractImageTargets` /
  `classifyTarget`），第 4 项、4b、第 10 项共用；**只有 `relative` 才允许 `existsSync`**。
- [x] **T004** FR-003 新门禁：`scripts/check-refs.mjs`（行号引用），带行为矩阵与可证伪证据。
- [x] **T005** FR-003 接线：`package.json#scripts.check` **与** `.github/workflows/ci.yml` 同时加进去
  （只接一处 = 未接线的检查）。
- [x] **T006** FR-003 存量：修门禁范围内的引用形态（`ROADMAP.md`、`specs/001-…/plan|qa-report|tasks.md`）。
  只换形态不改结论。**不碰** `reviews/` 与 `CHANGELOG.md`。
- [x] **T007** FR-004 提交门禁：`.githooks/pre-commit` + `CONTRIBUTING.md` 启用说明（默认不启用）。
- [x] **T008** FR-005 规则单源化：删 `AGENTS.md` 里的机械检查规则副本；确认 `AGENTS.md` 仍在一页以内（54 行）。
- [x] **T009** FR-006 环境事实：`workflow/ENVIRONMENT.md` + `workflow/README.md` 指针 + 全局 `$DSH_HOME/AGENTS.md` 两条。
- [x] **T010** 常驻行为矩阵：`test/guards.mjs`（三处门禁），并接进 `npm run check` 与 CI。
  ——**评审 M10 指出这一步原先不在计划与任务里**，本行是补记的。
- [x] **T011** 文档同步：`npm run check` 组成清单在四处（README 中英 / `release.mjs` / `CONTRIBUTING` /
  `ENVIRONMENT`）与 `constitution.md` 保持同源；宪法按自身修订程序 → v1.0.1（PATCH）。
- [x] **T012** CI 覆盖面：两道新门禁挪进三平台矩阵（Windows 的 `\` 与 junction 语义要有覆盖）。

## 评审修复轮

| 来源 | 发现 | 处置 |
|---|---|---|
| Lens 1 | **HIGH** 入口判定在 junction / symlink 下静默不执行（无输出、exit 0） | 改比 `realpathSync`；加"直接运行必须有输出"的常驻用例 |
| Lens 1 | **HIGH** 围栏剥离按出现顺序两两配对，一个游离的 ``` 让后半段同时假绿 + 假红；`~~~` 完全不认 | 改按行的 CommonMark 状态机，抽到 `scripts/markdown-strip.mjs` |
| Lens 1 | MEDIUM 抽取器相对旧第 4 项**收窄**（label 含方括号的目标消失） | 改"找 `](` + 向左配对 `[` + 有界读目标" |
| Lens 1 | MEDIUM 逐叶扫描与 `JSON.stringify` 不同构（key / `Date` / `BigInt` 溜掉） | key 一起收；`Date` 折 ISO 串；`BigInt` 折十进制串 |
| Lens 1 | MEDIUM `1e12` 豁免没有上界 | 加 `1e13` 上界（毫秒时间戳的取值区间） |
| Lens 1 | MEDIUM "26 条红线"不可复现 | 口径改为提交态 **21 条**，并注明 26 = 21 + 未提交草稿里的 5 个示例 |
| Lens 1 | MEDIUM T2 矩阵把旧实现说窄（title 形态本来就认得）；"10 个 now 派生字段"实为 10–16 个 | 都改了 |
| Lens 1 | LOW 徽标式注释对任何旧实现都不成立 / 扩展名白名单太窄 / 引用式定义不认缩进 / `recursive` 需 Node ≥20.1 | 注释重写；扩展名表加宽 + 认 `文件#L44`；允许 3 个前导空格；已换掉 `recursive` |
| Lens 2 | MEDIUM `classifyTarget` 漏裸 `..` 与反斜杠形态；协议相对被误判 | 按目录深度判越界；反斜杠单列 `backslash`；归一化前判 `//` |
| Lens 2 | MEDIUM 第 10 项未过分类器（仍是存在性神谕） | 第 10 项改走 `classifyTarget` |
| Lens 2 | MEDIUM `findLineRefs` 的 Θ(n²)（80 KB 要 7.8 s） | 改两段式线性扫描（实测 0.1 ms 量级） |
| Lens 2 | MEDIUM 链接抽取正则在连续 `[` / `![` 上二次方（10.9 s） | 改 `](` 有界扫描（实测 0.7 ms） |
| Lens 2 | MEDIUM `readdirSync(recursive)` 跟随 junction，读得到仓库外 `.md` | 手工 walk + 跳过 `isSymbolicLink()`（配对实测：旧报出 TEMP 里的文件，新放行） |
| Lens 2 | LOW 协议相对假红 / 对象 key 漏扫 / reviews 豁免比 spec 宽 / CI 无 Windows 覆盖 | 分别修掉；豁免口径与 spec 对齐；门禁进三平台矩阵 |
| Lens 3 | **HIGH** 假红率 3.73% 用了错误外推（把共享时钟的 10 张快照当独立事件） | 不再报单一数字，改为**区间 + 确定性复现点** |
| Lens 3 | MEDIUM 命中字段归因写错（是 `byProvider[1].lastAt`，不是 `updatedAt`） | 三处注释 + 常驻自证用例 |
| Lens 3 | MEDIUM `constitution.md` / `release.mjs` / README 中英 的清单陈旧 | 四处同步；宪法 → v1.0.1 |
| Lens 3 | MEDIUM `test/guards.mjs` 不在计划与任务里 | 补进 `plan.md` §9 与本文件 T010 |
| Lens 3 | MEDIUM `test/guards.mjs` 的规则来源引用指向同一提交删掉的 `AGENTS.md` 副本 | 改指 `workflow/PLAN.md` + `workflow/REVIEW-CHECKLIST.md` |
| Lens 3 | MEDIUM `ENVIRONMENT.md` 与全局 `AGENTS.md` 重复 pwsh 事实 | 仓库侧只留后果 + 指针 |
| Lens 3 | MEDIUM `specs/003` 缺 Problem / Design / Chosen approach；“100–103 行”已被自己提交弄失效 | `plan.md` 按 `PLAN.md` 的十节重写 |

## 备注

- **merge 顺序不再受限**：001→002 的顺序约束来自"002 由 001 切出"。三条分支都还没 push，
  因此按一个 PR 从本分支尖端合入时该约束自动消解（原记录留在 `specs/002/tasks.md`）。
- 本轮 **冻结工作树** 在评审期间被并发的未跟踪工件（`qa-report.md`、`reviews/`）打破，
  三份报告各自如实记录了这一点；对 `82b6561` 的行号无影响。