# 018 规格：用量页的焦点噪音（整页白边 + 点柱出框）

## 背景

用户 2026-11-14 反馈用量统计页两处视觉噪音：

1. 「点击方向键的时候会出现白边」——点页面空白后按 ↑↓←→，整块主区边缘闪一圈白边。
2. 「点击界面内的额度条时会出现一个框」——鼠标点柱状图的柱子后，整根「列轨道」被一个深色框套住。

隔离实例 CDP 实测（fixture 数据、浅/深两种主题，证据见 `~/.dsh/tmp/shots-018/evidence/`）：

- 白边 =.tpq-usage-viewport 的 :focus-visible outline。视口 tabIndex=0 铺满宿主 main 座位，
  点空白即成为 activeElement；焦点环写的是 2px 实线 + outline-offset:-2px，颜色取
  --dsw-alias-brand-primary —— 该变量在 body 主题层解析成 ink（浅色 #0f1115 / 深色 #f9fafb，
  回退值 #4176e6 从不生效），深色主题下就是整整一圈白边。按方向键滚动会把
  :focus-visible 从 false 翻成 true，于是每按一次闪一次。
- 出框 = Chromium 对可聚焦 SVG <g> 的 UA 默认 outline。柱子是 `<g tabindex=0 role=img>`，
  点击后普通 :focus 命中 UA 的 `outline: auto 5px`（浅色 #101010 / 深色白），框住整列轨道。
  插件原先只压了 :focus-visible（键盘态改用 stroke），所以键盘无框、鼠标有框。

## 需求

- FR-001 用量页滚动视口不再绘制整页焦点环（outline:none）；tabIndex、role=region、
  aria-label 与 PageDown/↓/Home/End 滚动行为全部保留。
- FR-002 柱状图每根柱（2D 与 3D）在**任何焦点态**下都不出现 UA 默认轮廓；
  键盘聚焦仍用内层 stroke（.tpq-usage-rect / .tpq-usage-face-front）表达。
- FR-003 零新增配置键/路由/出站主机/i18n 键/依赖；不改任何数据、文案与几何。

## 非目标

- 不取消视口与柱子的可聚焦性（读屏与键盘操作不受影响）。
- 不改其它控件的焦点环（今日/7/30/90、模式切换、输入框、重试按钮仍保留 2px 品牌环）。
- 不为这次改动重拍截图（2px 边缘与点击态都不是交付图的内容）。

## 验收

- SC-001 视口规则为 .tpq-usage-viewport:focus-visible{outline:none}，全仓不再有
  「.tpq-usage-viewport:focus-visible{outline:2px solid …」。
- SC-002 两根柱子的规则为 .tpq-usage-bar2d:focus,.tpq-usage-bar3d:focus{outline:none}，
  且原先只压 :focus-visible 的那条已不存在；两条 stroke 规则仍在。
- SC-003 柱子仍逐根 tabIndex=0 + role=img + aria-label=usageBucketTitle(...)。
- SC-004 静态守卫（第 18 节）与客户端测试（T102/T104）覆盖以上四条；全仓 npm run check 七步全绿。
