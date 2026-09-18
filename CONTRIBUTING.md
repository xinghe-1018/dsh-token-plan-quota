# 贡献指南

本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件，
零第三方依赖，宿主半边与浏览器半边都在同一个包里。

## 跑测试

```bash
node test/host.mjs      # 宿主半边：离线，回环 HTTP 例外
node test/client.mjs    # 浏览器半边：假 React / 假 DOM / 假 fetch，不联网
node test/guards.mjs    # 门禁自己的行为矩阵（fixture 痕迹守卫 / 行号引用检测）
npm test                # 前两个
node scripts/check-manifest.mjs   # 清单自检（安装性、出站主机声明、许可证）
node scripts/check-docs.mjs       # README 的可核实声明必须与代码一致
node scripts/check-refs.mjs       # 活文档里不得出现 `文件:行号` 引用
npm run check           # 上面全部 + 文档与投稿自检；**提交前跑这个**
```

测试**必须能在 Linux/macOS/Windows 上跑**：不要写死平台路径，临时目录一律用
`join(os.tmpdir(), ...)`；也不要依赖真实 `~/.dsh`（测试会把 `DSH_HOME` 指到临时目录）。

## 产品口径（改代码前先读）

1. **不估算**。徽标里的数字要么来自官方接口，要么明确标注「实测」（只统计经过本 DSH 实例的
   真实调用）。没有 Credits 折算、没有抵扣率、没有"按历史推算剩余"。
2. **没有官方分母就没有百分比**：实测卡永不画余量条、永不显示百分比。
3. **一个窗口只有在这个套餐真回了读数时才存在**。档位配置里躺着的上限值不是额度
   （`quota-config.five_hour` 这类只记进 `extra.*ConfiguredNoReading` 供 debug）。
4. **认不准就不开源**。自动检测宁可少一张卡，也不把别家的余额数字顶在某个模型上；
   有 `baseURL` 时只信 `baseURL`，路由名与 Key 前缀只在拿不到 host 时降级使用。
5. **凭据只进不出**：密钥/Cookie 只在本进程解析，绝不进任何路由响应、日志或错误信息。
6. **永不做会产生计费的探活**。只用只读端点。

## 加一家供应商

照 [`docs/adding-a-provider.md`](docs/adding-a-provider.md) 的清单走（预设 → `SOURCE_META` →
`errorHints` → `PLATFORM_RULES` → 回环单测 → `probe` 核对 → 文档回填）。

## 提交与 PR

- 提交信息用 Conventional Commits：`feat|fix|docs|test|chore(scope): 一句话说清做了什么`。
  正文写**为什么**，尤其是被推翻的初版思路——这个项目里"为什么不用另一种做法"比代码更贵。
- 一个提交只做一件事。修 bug 的提交必须带**能重现该 bug 的回归测试**。
- 描述必须属实：README / `dshhub.summary` / issue 里写的数字与端点名，会被拿去和代码核。
  没验证过的字段名要写清"官方文档背书，未用真 Key 核对"。

### 提交门禁

仓库带一个 pre-commit 钩子（`.githooks/pre-commit`），跑的就是 CI 那件事（`npm run check`，约 6 秒）。
**默认不启用**——`core.hooksPath` 是**本地**仓库配置，一次改动静默改掉所有人的提交行为不合适。
想启用是显式的一行：

```bash
git config core.hooksPath .githooks
```

知道自己在做什么时跳过：`git commit --no-verify`。CI 仍然会在 push / PR 上跑同一件事。

## 工程流程

非平凡改动走 `Context → Plan → Implement → Review → QA → Ship → Retro`：**每个相位留下写下来的工件，
人读过之后才进下一步**（没有工件 = 那一步没发生）。

- 给 AI agent 的常驻指令：[`AGENTS.md`](AGENTS.md)（DSH 每个会话自动加载，一页以内）。
- 完整流程与各相位模板：[`workflow/`](workflow/README.md)；判定口径的权威是
  [`.specify/memory/constitution.md`](.specify/memory/constitution.md)。
- 计划与需求：`.specify/`（Spec Kit）的 `/speckit-specify` → `/speckit-plan` → `/speckit-tasks`，
  结构要求见 [`workflow/PLAN.md`](workflow/PLAN.md)（尤其**非目标**与**前提逐条核验**）。
- 评审：[`workflow/REVIEW-CHECKLIST.md`](workflow/REVIEW-CHECKLIST.md) 三条 lens
  （正确性 / 安全 / 计划一致性）——分开跑、只读、各出一份报告。
- QA：[`workflow/QA-REPORT.md`](workflow/QA-REPORT.md)——功能 QA 加视觉 QA（用 `scripts/shots/`
  那台造图机，`--width` 可出窄视口）。
- 长会话过 40% 上下文时：[`workflow/SESSION-HANDOFF.md`](workflow/SESSION-HANDOFF.md)。

小改动不必走完整流程：错别字 / 文案 / 依赖升级直接做，单文件修复写一段话计划即可。

## 结构速览

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边：预设表、凭据解析、查询编排、只读路由、`token_plan_quota` 工具 |
| `lib/detect.js` | **纯函数层**：路由 → 数据源的识别规则表（不碰网络/文件/cordis） |
| `lib/client.js` | 浏览器半边：徽标与明细面板（手写 bundle，无构建步骤） |
| `test/*.mjs` | 两个离线自测，新增能力请同步加断言 |
