# 018 接口：焦点噪音修复（实现真值）

本改动只碰客户端 CSS 与其断言，**宿主零改动**：无新路由、无新配置键、无新出站主机、
无新 i18n 键、响应逐字段不变。

## 1 改动清单（唯一真值）

| 位置 | 旧 | 新 |
| --- | --- | --- |
| lib/client.js 视口规则 | `.tpq-usage-viewport:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:-2px}` | `.tpq-usage-viewport:focus-visible{outline:none}` |
| lib/client.js 柱子规则 | `.tpq-usage-bar2d:focus-visible,.tpq-usage-bar3d:focus-visible{outline:none}` | `.tpq-usage-bar2d:focus,.tpq-usage-bar3d:focus{outline:none}` |

**不变的部分（回归底线）**：

- 视口 JSX：`className: "tpq-usage-viewport"`、`data-usage-scroll: "1"`、`tabIndex: 0`、
  `role: "region"`、`aria-label: copy.usageTitle` 逐字保留；滚动容器 CSS 六件
  （height:100%、min-height:0、overflow-y:auto、overflow-x:hidden、overscroll-behavior:contain、
  scrollbar-width:thin）与 8px 细滚动条不变。
- 柱子 JSX：`tabIndex: 0`、`role: "img"`、`aria-label: usageBucketTitle(bucket, copy)`、
  data-usage-bar 四个钩子、透明命中矩形、指针/焦点浮层行为全部不变。
- 键盘焦点反馈：`.tpq-usage-bar2d:focus-visible .tpq-usage-rect{stroke:var(--dsw-alias-brand-primary,#4176e6);stroke-width:1.5}`
  与 `.tpq-usage-bar3d:focus-visible .tpq-usage-face-front{…}` 原样保留。
- 其它控件的焦点环（今日/7/30/90、模式、日期与月份输入、应用、重试、模型块、换算块重试）不动。

## 2 断言契约

- client.mjs T102：视口规则含 `outline:none`，且不再含 `outline:2px solid`；
  JSX 仍为 `"data-usage-scroll": "1", tabIndex: 0,`。
- client.mjs T104：`.tpq-usage-bar2d:focus,.tpq-usage-bar3d:focus{outline:none}` 存在，
  两条 `:focus-visible …{stroke:` 规则仍在。
- guards 013：细滚动条断言保留，焦点环断言改为「视口不画整页环 + 仍可聚焦」。
- guards 第 18 节：视口/柱子规则、旧规则已不存在、stroke 与可聚焦保留、注释含原因、
  CHANGELOG 有 018 条目、specs/018 四件存在。

## 3 不做

- 不改任何数据、文案、几何、截图（docs/images 无 018 产物）。
- 不给视口加替代性描边；不把柱子做成不可聚焦。

## 4 实施记录

- 2026-11-14 落地：CSS 两处、client.mjs T102 改写 + 新增 T104、guards 013 改写 + 第 18 节 8 条；
  CHANGELOG [Unreleased]/Fixed 一条；README 中英测试计数随断言数更新。
