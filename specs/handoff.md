# 交接待做（2026-11-14）

这份文件是会话交接用的**待做入口**：两个已立项但未动代码的问题，各自有 `spec.md` + `tasks.md`。接手后按仓库工作流先取证、再写 plan/INTERFACE、再实现、再跑门禁。

## 接手时的仓库状态

- 版本 0.5.0，HEAD = 019 的 docs 提交（feat → test → docs 三个提交依次是「支持按模型测算整套额度的折算 tokens」「019 的容量取整、退化与静态守卫」「019 的单模型容量说明与四张重拍图」）。
- 七步门禁在 019 提交后全绿：host 1037 / client 1346 / guards 592，check-manifest / check-docs / check-refs / check-submission 全 OK。
- 019（单模型容量测算）**需要重启 DSH 宿主**才在界面上生效：当前跑着的进程起于旧版，`ratio.models[].capacity` 还不存在。
- 未送达用户的两项待点头决定：010 的 0.6.0 发版（`scripts/release.mjs --minor`，不可回退）、本体升级到 0.2.2-rc.3（只报告不动手）。

## 待做

| 编号 | 目录 | 一句话 |
| --- | --- | --- |
| ~~020~~ | `specs/020-scroll-chain/` | 已完成（2026-11-15）：内层两个列表 `contain` → `auto`，滚动链交还外层；双向链与「不穿透宿主」均有 CDP 证据。 |
| ~~021~~ | `specs/021-badge-footer/` | 已完成（2026-11-15）：两按钮收进 `.tpq-panel-foot` sticky 粘底；顺带修掉悬浮态无效属性选择器。 |

## 2026-11-15 进展

- 两个待做项都按工作流走完（取证 → plan/INTERFACE → 实现 → 断言 → CDP 验收 → 文档），提交为
  `fix(usage) 020 滚动链` → `fix(panel) 021 底栏（含 [data-float] 选择器修正）` → `test(usage,panel) 成对断言`
  → `docs(usage) README/CHANGELOG/specs`。
- 020 验收：`evidence/wheel-after.json` verdict=`chain-ok`（内层到 396 后外层 1302→1526，反向内层归零后外层 1406→0，
  `window.scrollY` 恒 0）。021 验收：`evidence/panel-after.json` verdict=`pinned-ok`（锚定态入口全可见、悬浮 280×160 可滚、
  160→420 十一档 sweep 无一被裁）。证据在 `~/.dsh/tmp/shots-020/evidence/`，不入库。
- 门禁：host 1037 / client 1358 / guards 603，check-manifest / check-docs / check-refs / check-submission 全 OK。
- 仍未送达用户的两项待点头决定（不变）：010 的 0.6.0 发版（`scripts/release.mjs --minor`，不可回退）、
  本体升级 0.2.2-rc.3（只报告不动手）。

## 环境备注（接手会话直接可用）

- 仓库：`C:/Users/OMEN/.dsh/plugins/dsh-token-plan-quota`；shell 只有 pwsh 7.6.9（`ops_bash` 在本机不可用）。
- Node 必须绝对路径：`& 'D:/Node/node.exe' <脚本>`；跑测试与起 Edge 前设 `TEMP=TMP=C:/Users/OMEN/.dsh/tmp/quota-check-temp`。
- git：`D:/Git/cmd/git.exe`，提交带 `-c user.name=xinghe -c user.email=xjm2216182261@163.com` 与 `TEMP=TMP=C:/Users/OMEN/.dsh/tmp/git-temp`。
- 当前会话的图片识别通道（`read_image` 的 vision 引擎、modlens 两个 provider）全部失败，无法目检截图；需要目检时先 `npx @liustack/modlens doctor`。
