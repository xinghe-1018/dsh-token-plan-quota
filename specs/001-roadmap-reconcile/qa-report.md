# QA-REPORT — 001-roadmap-reconcile

- **日期**：2026-09-18
- **分支 / 最后好的 commit**：`001-roadmap-reconcile` / `e33873d`
- **计划**：`specs/001-roadmap-reconcile/plan.md`
- **评审报告**：`specs/001-roadmap-reconcile/reviews/lens-{1,2,3}-*.md`

## 1. 功能 QA

本次改动**不含 UI**，其"产品面"是文档本身与仓库门禁，所以功能 QA 的流程取"读者流程"与"门禁"：

| # | 流程 / 状态 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| 1 | 读者只看 ROADMAP 判断三阶段状态 | ①②③ 各自状态明确，且给出可 grep 的依据 | 顶部状态表 + 三处章节状态行；依据为 `lib/index.js:44/:1189/:2245`、`PRESETS` 键、registry+tag+CHANGELOG | 通过 |
| 2 | 版本计划与发布事实一致（SC-004） | 与 `package.json` / CHANGELOG / tag 零冲突 | `package.json`=`0.4.8`；registry `latest`=`0.4.8`；tag `v0.4.8`；CHANGELOG `[0.4.8] - 2026-09-15` | 通过 |
| 3 | 可核验性（SC-001） | 每条"已落地"按文中位置 grep，100% 命中 | `autoDetect: true`→L44；`applyAutoDetect()`→L1189；调用→L2245；`PRESETS` 8 键含 `moonshot-balance`/`openrouter-credits` | 通过 |
| 4 | 编码护栏 | 无 BOM / 无 U+FFFD / 无 GBK 私用区 | 前 3 字节 `35,32,82`（非 BOM）；U+FFFD 计数 0；`check-docs` 第 9 项 OK | 通过 |
| 5 | 链接与 README 一致性 | 未新增失效链接；不做的决策两处一致 | 本次未新增 markdown 链接；README 链接行未动；①状态行按 README「明确不做的三类」口径写 | 通过 |
| 6 | 窄视口（375/768） | — | **不适用**：无 UI 改动 | 不适用 |

> 关于"画面"：`ROADMAP.md` 在 Windows PowerShell 控制台里用 `Get-Content` 直读会显示乱码，
> 那是**控制台代码页**的表现，不是文件损坏——字节级检查与 `check-docs` 第 9 项都通过了。

## 2. 视觉 QA

**不适用**：`git diff main...HEAD --name-only` = `ROADMAP.md` + `specs/001-roadmap-reconcile/{spec,plan,tasks}.md`，
既无 `lib/client.js` 也无 `docs/images` 改动。按 `workflow/QA-REPORT.md` 第 3 节如实记录，不假装跑过。

## 3. 已知的流水线边界（如实记录）

- 本次**没有**使用造图机（无 UI 改动），因此 `scripts/shots/make-shots.mjs` 新增的 `--width/--height`
  窄视口能力**仍未在真实实例上端到端验证过**（只验证了语法、参数解析与护栏三条用例）。
  这是一条**遗留项**，不是"已通过"。
- 本次门禁用例数与改动前一致（379 host / 207 client），因为改动不涉及代码。

## 4. 发现与修复

| # | 严重度 | 位置 | 发现 | 失败场景 | 修复 commit | 回归测试 |
|---|---|---|---|---|---|---|
| — | — | — | 三条 lens 的结论见 `reviews/`；本轮无阻断级发现 | — | — | — |

## 5. 结论

- [x] 功能 QA 覆盖了本次改动的全部可验证面（读者流程 + 门禁 + 一致性 + 编码）
- [x] 视觉 QA 判定为不适用，理由已记录
- [x] 所有发现已记录（详见 `reviews/`）
- [x] `npm run check` 在**最后一次编辑之后**跑过，输出见下
- **Verdict**：通过（无阻断级发现；遗留项：造图机窄视口未端到端验证）

## 附：验证输出

```
> dsh-token-plan-quota@0.4.8 check
> node test/host.mjs && node test/client.mjs && node scripts/check-manifest.mjs && node scripts/check-docs.mjs && node scripts/check-submission.mjs

379 passed, 0 failed

207 passed, 0 failed
check-manifest: OK（dsh-token-plan-quota 0.4.8，出站主机 8 个）
check-docs: OK（配置键 17、数据源 8、出站主机 8、host 379 项 / client 207 项，中英 README 与代码一致）
check-submission: OK（条目 data/plugins/xinghe-1018__dsh-token-plan-quota.yml，category=usage，en 424 字符内含 zh 双语描述，与 README 同源）
exit=0
```