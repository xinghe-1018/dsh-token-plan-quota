# 028 方案

## 方案 A（采纳）夹具对齐宿主 + 取景夹取

三处漂移都在 scripts/shots/fixture.mjs，取景在 make-shots.mjs，全是截图物料层，不碰宿主。
标签与 `bindProviders` 直接照宿主真值抄（lib/index.js 的 `token-plan-console` preset 与 deepseek-balance 源 `providers`）；
⑥换成与②同源的 `consoleCard`；合成卡删掉断绝误用；浮框 x 夹取防裁切。改完重拍受影响图。

## 方案 B（否决）改 demo 路由 id 迁就旧夹具

把 demo 的 deepseek 路由改名 deepseek-official 也能让⑤收敛，但那是拿测试环境去凑一张错夹具，
且与宿主默认路由 `deepseek` 不符；正确方向是夹具绑双 id（宿主本就如此）。

## 方案 C（否决）⑥保留合成卡只改标签

`creditsPlanCard` 的 id 宿主永不发出，改标签也仍是假图；项目立场「宁可少一张也不拍宿主发不出的图」，
必须换成宿主真值卡。

## 已知盲点

- `consoleCard` 带两条 meters，竖直能否塞进 triptych 浮框 h332 须实测——已验证塞得进，无需调高度。
- 夹取用的视口宽 1150 是 triptych 内部取景视口（make-shots.mjs），不是 CLI 默认 1280；
  写 docs 的窄视口闸门（make-shots.mjs）看的是 CLI 参数，默认取景不受影响。
- 徽标右对齐程度随界面语言/权限标签长度变；夹取只在右缘要溢出时生效，向左不改变原取景。

## 实施步骤

1. fixture.mjs：`consoleCard` 标签、triptych 换卡、删 `creditsPlanCard`、钱卡 `bindProviders` 双 id。
2. make-shots.mjs：triptych 浮框 x 夹取。
3. 起 demo 实例（orchestrator-docs-028.mjs）重拍 zh ①-⑦ / en ①-⑥ 进 docs/images。
4. 本目录四件 + CHANGELOG Unreleased/Fixed；全量门禁；提交。
