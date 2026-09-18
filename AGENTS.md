# AGENTS.md — dsh-token-plan-quota

<!-- DSH 在每个会话开始自动加载本文件（仓库根）。**一页以内**，每一行都要证明自己值这个位置。
     完整的工程流程在 workflow/README.md；判定口径的权威是 .specify/memory/constitution.md。
     与它描述的行为在同一个 PR 里改（评审清单 Lens 3 会核这一条）。 -->

## Commands

- 宿主半边测试：`node test/host.mjs`
- 浏览器半边测试：`node test/client.mjs`
- **提交前提**：`npm run check`（host + client + guards + check-manifest + check-docs + check-refs + check-submission）
- 造 README 截图：`node scripts/shots/make-shots.mjs --url http://127.0.0.1:<port> --lang zh|en --out docs/images`
- 发布：`node scripts/release.mjs`（完整流程见 RELEASE.md）

## Conventions（只写非显然的）

- **零第三方依赖**：`package.json` 不出现 `dependencies`。想加依赖 = 先改宪法（原则 IV），不是先 `npm i`。
- 提交信息用中文 Conventional Commits，一个提交只做一件事，正文写**为什么**（尤其被推翻的初版思路）。修 bug 必须带能重现该 bug 的回归测试。
- 对外描述（`README.md` / `README.en.md` / `dshhub.summary` / issue 文字）必须与代码同源，且在同一次改动内完成——`check-docs.mjs` 会拿去和代码核。
- `docs/` 是 `package.json#files` 白名单成员，**会随 npm 包发布**。中间产物（`.shots-work/`、`.scratch/`）只能待在 `docs/` 之外。
- 数字口径：要么官方接口真值，要么明确标注「实测」的本实例窗口；不折算 Credits、不估算余量；**没有官方分母就不出现百分比**（原则 I）。
- `dshhub.permissions.network` 的声明集合必须等于实际出站主机集合，新增供应商要同步（原则 V）。
- **"不做"的精确边界**是**读取其它 CLI 的本地登录态 / 额外强凭据**（见 README「明确不做的三类」）；
  **Cookie 是已发布能力**（`token-plan-console` 的 `BAILIAN_CONSOLE_COOKIE`）。**A/B/C 档位描述"需要什么形态 /
  有没有官方端点"，不是做与不做的判定**——引用档位时不许合并、不许当结论用。

## Do not touch

- `.env*`、`.credentials.yaml`、任何密钥 / Cookie：**不读、不回显、不进日志与错误信息**。这是硬线，不是建议（原则 II）。
- 已决定不做的形态：**读取其它 CLI 的本地登录态 / 额外强凭据**那三类（GLM 团队模式额外头、Kimi Code 浏览器 Cookie 与 CLI 凭据文件、Codex·Gemini 的 OAuth token 文件）——不要"顺手补上"；README「明确不做的三类」是权威记录。**注意：Cookie 不是禁区**——控制台 Cookie（`BAILIAN_CONSOLE_COOKIE`）是已发布能力。
- `docs/images/` 下已发布的 13 张图：只能由 `scripts/shots/make-shots.mjs` 生成（README 引用它们，`check-docs.mjs` 第 10 项断言它们存在）。
- `lib/detect.js` 是纯函数层：网络 / 文件 / cordis 调用不进这个文件。

## Definition of done

`npm run check` 全绿，**且是最后一次编辑之后跑出来的输出**——贴出来，不是声称。
同理：任何"测试通过 / 类型干净 / 页面渲染正常"的声称，都要附命令输出或截图。没有证据的声称只有一个回应：跑一遍给我看。

## Workflow

非平凡改动走完整循环：**Context → Plan → Implement → Review → QA → Ship → Retro**。

分档（判不准就按更重的一档）：
- 错别字 / 文案 / 依赖升级 → 直接做，不走流程。
- 单文件修复 → 提示词里一段话计划（改什么、什么能证明它 work）。
- 多文件 / 行为变更 / 新功能 / 数据迁移 → 走完整流程。

每一相位**消费上一相位的写下工件，产出一份写下工件，人读过之后才进下一步**。没有工件 = 那一步没发生。

- 计划：`.specify` 的 `/speckit-specify` → `/speckit-plan` → `/speckit-tasks`（工件落 `specs/<编号>-<slug>/`）；模板与要求见 `workflow/PLAN.md`
- 评审：`/speckit-analyze` **加上** `workflow/REVIEW-CHECKLIST.md` 的三条 lens——分开跑、各自新鲜上下文、只读、只产报告
- QA：`workflow/QA-REPORT.md`（功能 + 视觉两段；视觉用上面的造图命令，fixture-only）
- 长会话：上下文过 40% 时在干净边界写 `workflow/SESSION-HANDOFF.md` 再重置
- 收货：Retro 的每条结论只落两个地方——`AGENTS.md`（反复出现的误解）或 `workflow/PLAN.md`（反复出现的盲点）