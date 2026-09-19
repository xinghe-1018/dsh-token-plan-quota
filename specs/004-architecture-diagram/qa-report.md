# QA-REPORT — 004 架构图入库

- **日期**：2026-09-19
- **分支 / 最后好的 commit**：`004-architecture-diagram` / `a61a098`
- **计划**：`specs/004-architecture-diagram/plan.md`
- **评审报告**：`specs/004-architecture-diagram/reviews/lens-1-correctness.md`、
  `lens-2-security.md`、`lens-3-plan-conformance.md`

## 0. 本次改动的"产品面"是什么

004 **不含任何运行时改动**（`lib/` 零改动），但它有真正的产品面：一张会随 npm 包发布、
出现在 README 与 npm 页面上的位图，外加一条新的门禁断言。所以：

- **功能 QA** = 那条断言的"应报 / 应放行 / 边界"两端 + 打包面 + `npm run check` 全量。
- **视觉 QA** = 逐张读图。本会话模型不接受图像输入（`read_image` 被拒），按项目既有做法用
  `modlens_read_image` 视觉桥读，并加 PNG 结构检查做旁证。

## 1. 功能 QA

十条用例由 `.scratch/004/falsification.mjs` 驱动（仓库外的一次性取证脚本；**它的输出就是本节**，
脚本自身不进仓库）。每条用例改完即还原，最后逐字节自证。

| # | 流程 / 状态 | 期望 | 实际（输出要点） | 结论 |
|---|---|---|---|---|
| 1 | 基线（不动任何文件） | 绿 | `check-docs` 退出码 0 | 通过 |
| 2 | 资产被删除 | 报红 | exit 1；两份 README「链接目标不存在」+ 第 10 项「不存在」 | 通过 |
| 3 | 资产 0 字节 | 报红 | exit 1；「只有 0 字节，多半是裁图裁空了」 | 通过 |
| 4 | 中文相对路径改坏 | 报红 | exit 1；链接目标不存在 + 点名断言 | 通过 |
| 5 | 挪到**不随包发布**的目录 | 报红 | exit 1；「链接目标不随包发布：diagrams/_probe.png」 | 通过 |
| 6 | 只从英文侧撤掉引用 | 报红 | exit 1；「README.en.md 没有引用 …：结构图必须双语同源」 | 通过 |
| 7 | 引用改成 HTML `<img src>` | **必须放行** | exit 0 —— **修复前是 exit 1** | 通过（假红已收口） |
| 8 | 引用改成引用式定义 | 必须放行 | exit 0 —— 修复前 exit 1 | 通过 |
| 9 | 引用改成绝对 GitHub 链接 | 必须放行 | exit 0 —— 修复前 exit 1 | 通过 |
| 10 | 引用藏进 HTML 注释 | 报红 | exit 1；点名断言 | 通过 |
| 11 | 取证脚本自证 | 每轮逐字节还原 | 三个文件 sha256 与原始一致（33511 / 37192 / 186019 B），退出码 0 | 通过 |
| 12 | 打包面 | 资产进包、`diagrams/` 不进包 | `npm pack --dry-run`：`docs/images/architecture.png` 186.0 kB 在清单内，**无任何 `diagrams/` 路径** | 通过 |
| 13 | 门禁全量 | 七步全绿 | host 379 / client 207 / guards 94 + manifest、docs、refs、submission 四个自检 OK，退出码 0 | 通过 |
| 14 | 位图确定性 | 同输入逐字节相同 | 连续两次运行 + 评审者从**新交付** HTML 重出，三次同为 sha256 `b8cae2aa…` / 186019 B | 通过 |

原始输出（第 2–10 条，节选）：

```
[PASS] 基线（不动）                    exit=0（期望 0）
[PASS] 1 资产被删除                    exit=1  README.md / README.en.md 链接目标不存在 + 第 10 项
[PASS] 2 资产 0 字节                   exit=1  只有 0 字节，多半是裁图裁空了
[PASS] 3 中文相对路径改坏              exit=1  链接目标不存在 + 点名断言
[PASS] 4 挪到未发布目录（发布面检查）  exit=1  链接目标不随包发布：diagrams/_probe.png
[PASS] 5 英文侧撤掉引用（双语同源）    exit=1  README.en.md 没有引用 docs/images/architecture.png
[PASS] 6 引用改成 HTML <img src>（应放行）        exit=0（期望 0）
[PASS] 7 引用改成引用式定义（应放行）             exit=0（期望 0）
[PASS] 8 引用改成绝对 GitHub 链接（应放行）       exit=0（期望 0）
[PASS] 9 引用藏进 HTML 注释（应报红）  exit=1  结构图必须双语同源

自证：文件是否逐字节还原
  ok   README.md (33511 B)
  ok   README.en.md (37192 B)
  ok   docs/images/architecture.png (186019 B)
```

### 1.1 取证脚本自己的 bug（被它的自证抓到）

第一次跑扩展后的十条用例时，脚本**退出码 2** 并报"有文件没有还原回去"。原因是 `stash` 把
**新内容**当成备份存了下来，"还原"写回的是被改过的文本，于是后续用例全被污染
（两个 README 各少 64 B / 120 B），表现为"三条应放行的用例反而报红"。

处置：修脚本（先读旧内容再写）→ 把两个 README 从 git 恢复 → 重跑，十条全过、逐字节还原。

这条正是 `workflow/PLAN.md` 那条盲点的现场应用：**取证脚本必须先自证再采信**。
没有那道自证，那一轮会被误读成"新断言坏了"，然后去修一个本来正确的断言
——而 `test/guards.mjs` 里那 14 条常驻用例恰恰证明断言是对的。

## 2. 视觉 QA

位图是本轮唯一真正的视觉面。逐张读图（`modlens_read_image`）：

| # | 看什么 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| 1 | 完整性 | 三块边界 + 10 节点 + 9 关系 + 图例都在，四边不裁 | 逐词转录里 3 个边界标题、10 个节点标签、9 条关系标签、图例 `Frontend 2 / Backend 3 / Database 1 / Security 1 / External 3`（合计 10，与规格的 component 数一致）齐全；无裁切 | 通过 |
| 2 | 与代码同源 | 每个节点/关系都能指到代码 | 「自动检测纯函数层 · 零配置 · 零网络」↔ `lib/detect.js` 内 `fetch` / `http` / `fs` 全无；`token_plan_quota` ↔ 宿主注册的模型工具；8 条出站主机 ↔ `dshhub.permissions.network`；8 个数据源预设（含 `token-plan-console`）↔ 宿主预设表 | 通过 |
| 3 | 口径正确 | 不得把"明确不做的三类"画成已支持 | 图里没有 GLM 团队模式 / Kimi Code 浏览器 Cookie / OAuth 凭据文件这三类 | 通过 |
| 4 | 不是白图、无隐私元数据 | 有内容、无本机信息 | `<text>` 实测 49 个；PNG chunk 序列只有 `IHDR + IDAT + IEND`（无 tEXt，即没有把路径/注释写进元数据）；转录里无数字、账号、盘符、URL | 通过 |
| 5 | README 里的显示尺寸 | 可读 | **偏小**：正文宽约 1012 px，2676 px 的图被容器压到约 850 px，图内约 12 px 的字在页面上约 7 px | **已知边界**（§3） |

## 3. 已知的流水线边界（如实记录，别当成"QA 过了"）

- **README 里字偏小**：可点开看原图；可缩放的交互式 HTML 按非目标不入库。
  这是"按额度端点讲结构"这个画幅的固有取舍（要更大就得重排图的密度，那要另一轮）。
- **位图内容无法机械化核**：`npm run check` 只能证明它存在、非空、两份 README 都引到它。
  内容正确性靠读图 + 与代码对照；漂移靠 `diagrams/README.md` 的硬要求兜（改运行时行为时复核此图）。
- **错位裁区识别不了**：自证只做"元素在视口内 + `<text>` 数量 + 体积"，裁区若整体偏移不会被发现。
- **确定性依赖字体可得性**：本机 CDN 字体取不到，两次都回落系统字体栈，故逐字节相同；
  若有机器能取到 webfont，产物可能不同。
- **成品 HTML 的哈希从仓库内不可复核**：它按非目标不入库；仓库内可复核的是源规格与位图两个哈希。

## 4. 发现与修复

三份 lens 共 6 MEDIUM / 17 LOW（0 HIGH）。逐条独立核实后的处置全表在
`specs/004-architecture-diagram/tasks.md` 的「评审修复轮」；下表是**本轮真正改了东西**的六条：

| # | 来源 | 严重度 | 位置（符号名） | 发现 | 失败场景 | 修复 commit | 回归 |
|---|---|---|---|---|---|---|---|
| 1 | Lens 1 | MEDIUM | `check-docs` 点名断言的判定逻辑 | 只认行内图片 | `<img src>` 等无害写法被判红——假红训练人忽略红灯 | `a61a098` | `test/guards.mjs` 14 条常驻用例 |
| 2 | Lens 1 | MEDIUM | `make-diagram-png.mjs` 的体积阈值 | 依据偏约 3 倍 | 真·白图实测 19,304 B，距阈值 20,000 B 只差 696 B | `a61a098` | 阈值 60,000 B + 校准表 |
| 3 | Lens 1 | MEDIUM | `make-diagram-png.mjs` 自证 | 完全不含内容 | 注入同选择器 SVG、标签全丢仍 exit 0 | `a61a098` | `<text>` ≥ 8 的内容门 |
| 4 | Lens 1 | LOW | `mentionsTarget` | 注释里的引用可绕过 | 断言被无渲染的写法满足 | `a61a098` | 常驻用例（注释必须不算） |
| 5 | Lens 2 | LOW | `make-diagram-png.mjs` 的 `--out` | 可静默覆盖任意文件 | `--out README.md` 把已跟踪文件换成位图二进制 | `a61a098` | 尾缀 + 非 PNG 拒绝两道守卫 |
| 6 | Lens 3 | MEDIUM | `spec` / `plan` / `tasks` 工件 | 断言是计划外的；tasks 未勾选 | 下一轮据计划误判"边界仍未收口"，删掉断言照样全绿 | `a61a098` | 四处工件同轮回写 + 提交对账 |

**不修**的都写明了理由（见 tasks 的同名表）：Lens 2 的 `--edge`、加载他人给的 HTML、
既存的"期望主机只来自 PRESETS"与提交作者邮箱；Lens 3 的 `screenshots.json`（策展子集，
是否上市场是产品决策，本 PR 不做）。

## 5. 结论

- [x] 功能 QA 覆盖 diff 触及的流程 + 入口冒烟（十条用例 + 打包面 + 门禁全量）
- [x] 视觉 QA 完成，读图对象：`docs/images/architecture.png`
- [x] 所有发现已修复或明确记录为已知问题
- [x] `npm run check` 在**最后一次编辑之后**跑过，输出附下
- **Verdict**：**通过**（带 §3 四条已记录的已知边界）

## 附：验证输出

```
> dsh-token-plan-quota@0.4.8 check
> node test/host.mjs && node test/client.mjs && node test/guards.mjs && node scripts/check-manifest.mjs && node scripts/check-docs.mjs && node scripts/check-refs.mjs && node scripts/check-submission.mjs

379 passed, 0 failed
207 passed, 0 failed
94 passed, 0 failed
check-manifest: OK（dsh-token-plan-quota 0.4.8，出站主机 8 个）
check-docs: OK（配置键 17、数据源 8、出站主机 8、host 379 项 / client 207 项 / guards 94 项，中英 README 与代码一致）
check-refs: OK（22 个活文档，无行号引用）
check-submission: OK（条目 data/plugins/xinghe-1018__dsh-token-plan-quota.yml，category=usage，en 424 字符内含 zh 双语描述，与 README 同源）
```

打包面（`npm pack --dry-run`，节选）：

```
npm notice 186.0kB docs/images/architecture.png
npm notice package size: 2.2 MB
npm notice total files: 25
```

（`diagrams/` 无任何路径出现在清单里——设计如此。)