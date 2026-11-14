# 018 实施计划

## 1 结论先行

两处噪音同源：**焦点环只按「键盘/鼠标」判断，没按「这块元素是不是页面骨架」判断**。
视口是整页骨架，画环即整页描边；柱子是装饰性数据点，鼠标点击本不该给焦点反馈
（键盘态已有 stroke）。所以修复是两条 CSS 规则 + 断言，不动结构。

## 2 证据

- 隔离实例 DSH_HOME=~/.dsh/tmp/shots-018，fixture 数据，CDP 取 computed style：
  - 点空白 → activeElement=DIV.tpq-usage-viewport，rect {280,0,1000,860}，outline none；
    按 ArrowDown → scrollTop 40、:focus-visible=true、outline rgb(15,17,21) 2px offset -2px；
    深色主题同一步 rgb(249,250,251) = 白。
  - 点柱 <g class="tpq-usage-bar2d" tabindex=0> → activeElement 为该 g，:focus-visible=false，
    outline rgb(16,16,16) auto 5px（UA 默认），框住整列轨道；3D 同。
  - 对照：Tab 到柱子时 :focus-visible=true 且 outline none（既有规则生效）。
- 结论：白边来自 .tpq-usage-viewport:focus-visible；框来自 :focus 未被覆盖。

## 3 方案

1. lib/client.js 视口规则：`outline:2px solid var(--dsw-alias-brand-primary…);outline-offset:-2px`
   → `outline:none`，注释写清「变量在 body 层解析成 ink，深色成白边」与「可聚焦保留」。
2. 柱子规则：`:focus-visible{outline:none}` → `:focus{outline:none}`（同一条选择器覆盖 2D/3D，
   普通 :focus 与 :focus-visible 都命中）；两条 stroke 规则原样保留。
3. 测试：client.mjs 的 T102 断言改为「不画整页环 + 仍可聚焦」，新增 T104 断言柱子两种焦点态；
   guards 013 的旧断言改成新口径，并新增第 18 节 8 条静态矩阵。
4. 文档：CHANGELOG 的 [Unreleased]/Fixed 加一条；README 两版的测试计数随断言数更新
   （配置键 26、数据源 8、出站主机 8 均不变）。

## 4 备选与否决

- 备选 A：把视口焦点环改成 1px 主题边框色。——仍是整页描边，只是变淡，用户诉求是「别出现」，否决。
- 备选 B：视口去掉 tabIndex，靠滚轮/触摸滚动。——方向键与 PageDown 就失效，键盘用户先受损，否决。
- 备选 C：柱子 :focus-visible 改成 :focus:not(:focus-visible)。——与 :focus 等价且更难读，取直白写法。

## 5 风险

- 无障碍：视口失去可见焦点指示。取舍理由：视口铺满整屏、内容滚动本身即反馈，且它有
  role=region + aria-label；仍保留键盘可聚焦，只是不画整页描边。柱子键盘态由 stroke 表达，未削弱。
- 截图回归：docs/images 不涉及（2px 边缘、点击态都不在截图里）；若未来加点击态截图需重拍。

## 6 任务

见 tasks.md；提交按 feat/test/docs 三段（实现、断言、CHANGELOG+规格）。
