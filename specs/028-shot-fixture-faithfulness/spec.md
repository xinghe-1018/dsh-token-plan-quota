# 028 截图夹具对齐宿主真值（三连图收敛 + 控制台卡标签）

状态：进行中（2026-11-17）
关联：005（徽标跟随模型）、026（卡片标签）、027（夜间说明）；scripts/shots/README.md

## 背景

README 的三种额度状态三连图（⑤⑥⑦）与徽标 GIF（①）停留在 2026-09-08 初版。2026-11-14 曾重拍，
但 make-shots 在⑤之后崩（`Error: 点不到模型按钮（应显示「DeepSeek-V4-Flash」）`，抛在 `switchModel`），
⑥⑦①从未重拍。本次修好取景链后复核夹具，发现三处与宿主真值漂移：

1. **控制台卡标签漂移**：fixture `consoleCard` 标签写「千问 Token Plan」/ "Qwen Token Plan"，
   而宿主 `token-plan-console` preset 的 `label`/`labelEn` 是「Token Plan 余量」/ "Token Plan quota"
   （lib/index.js）。②③④⑥拍出的卡名与真实界面不符。
2. **⑥用合成卡**：triptych 第二张推的是 `creditsPlanCard`（id `token-plan-credits`、4480/6000、无 meters），
   这个 id 宿主 `publicCard` 白名单（lib/index.js）永不发出——是一张宿主造不出的假图。
3. **钱卡 bindProviders 缺一条路由**：fixture `deepseekMoneyCard` 只绑 `['deepseek-official']`，
   宿主 deepseek-balance 源的 `providers` 是 `['deepseek', 'deepseek-official']`（lib/index.js，经 `bindProviders` 直传）。
   默认路由 `deepseek` 的模型匹配不到钱卡 ⇒ 面板 scoped 过滤为空 ⇒ `boundPanel` 退回全量（lib/client.js），
   ⑤拍成「所有卡都在」的假图，而非「只显示当前供应商那张」。

另有取景缺陷：徽标在输入行右对齐，中文权限标签 + 长模型名把整组推到 chip0.x≈715，
浮框 x≈705 ⇒ 面板右缘 1225 > 视口 1150 ⇒ `framedClip` 把⑥的重置日期裁掉。

## 目标

- FR-001 `consoleCard` 标签对齐宿主 preset：zh「Token Plan 余量」/ en "Token Plan quota"。
- FR-002 triptych 第二张改用 `consoleCard`（宿主真值、带两条窗口计量条），与②同源。
- FR-003 删除合成 `creditsPlanCard` 整段（宿主永不发出，留着只会再被误用）。
- FR-004 `deepseekMoneyCard` 的 `bindProviders` 改 `['deepseek', 'deepseek-official']`，与宿主 deepseek-balance 源一致。
- FR-005 triptych 浮框 x 夹取 `Math.min(chip0.x-10, 视口宽-面板宽-90)`，防右缘裁切；徽标靠左时不生效。
- FR-006 重拍受影响的①②③④⑤⑥⑦（zh）与①②③④⑤⑥（en）进 docs/images，全部脚本生成。

## 非目标

- 不改 lib/index.js、lib/client.js、test/：这是夹具与取景修复，宿主行为零变化。
- 不重拍⑧-⑱用量统计图（用 usage payload，不含上述卡，11-14 已新且未受影响）。
- 不改 README 图注（「官方余量卡与多窗口计量条」「有分母才画条」等描述对控制台卡仍成立）。
- 不改⑦的 `emptyReason` 文案（宿主 lib/index.js 写死中文，英文套⑦按既定规则跳过）。

## 验收标准

- SC-001 ②⑥控制台卡标签逐字「Token Plan 余量」/ "Token Plan quota"；旧「千问 Token Plan」/ "Qwen Token Plan" 零残留。
- SC-002 ⑤面板只显示 DeepSeek 余额卡（scoped 命中，不再退全量）。
- SC-003 ⑥控制台卡两条计量条与重置日期完整可见，面板右缘留白、不裁切。
- SC-004 仓库内 `creditsPlanCard` 与合成 id `token-plan-credits`（作为卡 id）零残留。
- SC-005 `npm run check` 全绿（host / client / guards / check-manifest / check-docs / check-refs / check-submission）。
- SC-006 零新路由、零新配置键、零新出站主机、零第三方依赖。
