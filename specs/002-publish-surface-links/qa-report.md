# QA-REPORT — 002-publish-surface-links

- **日期**：2026-09-18
- **分支 / HEAD**：`002-publish-surface-links` / `fa9ae88`（实现提交 `5921a07`）
- **计划**：`specs/002-publish-surface-links/plan.md`
- **评审报告**：`specs/002-publish-surface-links/reviews/lens-{1,2,3}-*.md`
- **本轮加载的技能**：`verification-before-completion`（新装）——本文按其"证据先于声称"的门函数写法组织：
  每条声称都先指明"什么命令能证明它"，再贴该命令的**本次**输出。

## 1. 功能 QA

| # | 流程 / 状态 | 期望 | 实际（本次跑出） | 结论 |
|---|---|---|---|---|
| 1 | npm 包页链接可点通（机制层） | README 的相对链接目标全部随包发布 | `README.md 违规链接: 0`；`README.en.md 违规链接: 0` | 通过 |
| 2 | 机械门 | 五项检查 + 用例全绿 | `379 passed, 0 failed` / `207 passed, 0 failed` / manifest·docs·submission 全 OK，**EXIT=0** | 通过 |
| 3 | 包不被撑大、无内部材料泄漏 | 仍 24 files，无 `specs/` `workflow/` `AGENTS.md` `.specify/` `scripts/` | `total files: 24`，`package size: 2.0 MB`；泄漏检查无输出 | 通过 |
| 4 | 新检查确实在跑（不是死代码） | 文件里存在 4b 项 | `select-string '4b) 发布面链接'` = 1 处 | 通过 |
| 5 | 未新增依赖 | `dependencies` 为空 | `dependencies: null` | 通过 |
| 6 | 视觉 QA | — | **不适用**：改动只有 README 链接写法与自检脚本，无 UI/截图改动 | 不适用 |

## 2. FR 逐条核对（按 `verification-before-completion` 的"需求逐条核查"要求）

| FR | 声称 | 证明它需要 | 实测 |
|---|---|---|---|
| FR-001 | 非发布目标改绝对链接 | README 违规相对链接数 = 0 | ✅ 两份均 0（证据 3） |
| FR-002 | 新增机械检查 | 文件内存在该检查 + 门禁会跑它 | ✅ 4b 项在位；`npm run check` 内含 `check-docs` 并通过（证据 1、4） |
| FR-003 | 可证伪 | 修复前输入下**必须报红** | ✅ 还原修复前 README 后 `node scripts/check-docs.mjs` → **exit=1**，逐条指名全部违规链接（10 处） |
| FR-004 | 包不增重 | `npm pack --dry-run` = 24 files | ✅ 24 files / 2.0 MB（证据 2） |
| FR-005 | 中英一致 | 两份都处理且形态一致 | ✅ 各改写 5 处、各 0 违规（证据 3） |
| FR-006 | 报错指名 | 报错含 `文件:链接` | ✅ 输出形如 `README.md 的链接目标不随包发布：SECURITY.md` |

## 3. 本次 QA 的边界（如实记录，不当成"已通过"）

- **无法直接验证 npm 包页的真实渲染**（需要已发布版本 + 页面访问）。本次验证的是**机制前提**：
  包内文件集合与 README 相对链接集合的交集。若 npm 的行为与该前提不符，这条检查的立意需要复核。
- 新检查的**覆盖面边界**（例如引用式链接 `[a][ref]`、HTML `<a>`、尖括号目标）由 Lens 1 独立核验，
  其结论并入本文的"发现与修复"；未核实前不声称"全覆盖"。
- 视觉 QA 不适用（无 UI 改动），未跑造图机。

## 4. 发现与修复

| # | 严重度 | 位置 | 发现 | 处置 |
|---|---|---|---|---|
| 1 | **MEDIUM** | `scripts/check-docs.mjs` 4b（初版） | 检查会骗人：漏检带 title / 引用式 / HTML / 未发布图片；误报 `package.json` 与代码围栏示例；`docs/../x` 绕过前缀；报出脏目标名 | **已重写**（T007），矩阵 13/13 + 可证伪性 10 条红 |
| 2 | **MEDIUM** | 同上（Lens 2 F1 独立复核一致） | 带 title 与引用式两种写法**同时躲过第 4 项与 4b** → CI GREEN（潜在回归面；当前工作树无此写法） | **已覆盖**（T007），并把两反例并入矩阵 |
| 3 | LOW | `README.md` 的绝对链接钉 `blob/main` | 与所装 tarball 可能不同源（尤其 SECURITY.md） | 记录为**已知边界**（见 plan §4 与 Retro），替代方案是按 tag 钉或把安全文档纳入 files |
| 4 | LOW | 4b 的 `files` 静态模型 | 含否定项/glob 时会失真 | 已改为**出声跳过/告警**，不假绿 |
| 5 | LOW（**既有**，非本次引入） | `check-docs.mjs` 第 4 项 `existsSync(join(root, link))` | 可探测仓库外路径（仅存在性 oracle，不读内容） | 记为**后续候选**，不在本次范围（本次未动第 4 项） |

## 5. 结论

- [x] 功能 QA 覆盖了本次改动的全部可验证面（发布面 / 门禁 / 可证伪 / 依赖）
- [x] 视觉 QA 判定不适用，理由已记录
- [x] FR-001…FR-006 逐条有本次证据
- [x] `npm run check` 在**最后一次编辑之后**跑过，输出见 §1
- **Verdict**：通过（有 §3 两条边界；评审发现待并入后收口）

## 附：验证输出

```
> dsh-token-plan-quota@0.4.8 check
> node test/host.mjs && node test/client.mjs && node scripts/check-manifest.mjs && node scripts/check-docs.mjs && node scripts/check-submission.mjs

379 passed, 0 failed

207 passed, 0 failed
check-manifest: OK（dsh-token-plan-quota 0.4.8，出站主机 8 个）
check-docs: OK（配置键 17、数据源 8、出站主机 8、host 379 项 / client 207 项，中英 README 与代码一致）
check-submission: OK（条目 data/plugins/xinghe-1018__dsh-token-plan-quota.yml，category=usage，en 424 字符内含 zh 双语描述，与 README 同源）
EXIT=0

npm notice total files: 24 / package size: 2.0 MB
README.md 违规链接: 0 / README.en.md 违规链接: 0 / dependencies: null
```