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
| 020 | `specs/020-scroll-chain/` | 「按模型用量」列表滚到底后，滚轮应继续滚动外层整页视口（根因已确认：内层 `overscroll-behavior:contain`）。 |
| 021 | `specs/021-badge-footer/` | 徽标小窗底部「用量统计」入口被挤到边缘只露半行，需要固定底栏（先复现再定实现路线）。 |

## 环境备注（接手会话直接可用）

- 仓库：`C:/Users/OMEN/.dsh/plugins/dsh-token-plan-quota`；shell 只有 pwsh 7.6.9（`ops_bash` 在本机不可用）。
- Node 必须绝对路径：`& 'D:/Node/node.exe' <脚本>`；跑测试与起 Edge 前设 `TEMP=TMP=C:/Users/OMEN/.dsh/tmp/quota-check-temp`。
- git：`D:/Git/cmd/git.exe`，提交带 `-c user.name=xinghe -c user.email=xjm2216182261@163.com` 与 `TEMP=TMP=C:/Users/OMEN/.dsh/tmp/git-temp`。
- 当前会话的图片识别通道（`read_image` 的 vision 引擎、modlens 两个 provider）全部失败，无法目检截图；需要目检时先 `npx @liustack/modlens doctor`。
