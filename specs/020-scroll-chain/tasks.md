# 020 任务（tasks）

状态：T001–T006 已完成（`evidence/wheel-after.json` 验收 verdict=`chain-ok`，代码与断言已落地，client 1358 / guards 603）；只剩 T007 提交与复跑七步门禁。

- [x] T001 复现取证：隔离实例打开用量屏 → 定位「按模型用量」列表 → 用 CDP wheel 连续滚动，记录内层/外层 scrollTop 序列，确认「内层到底后外层不动」。证据落 `~/.dsh/tmp/shots-020/evidence/`。
- [x] T002 写 plan.md 与 INTERFACE.md（改动表：哪几条 CSS 的 `overscroll-behavior` 从 contain 改成 auto、哪些**必须保留** contain；断言契约；不做清单）。
- [x] T003 客户端：内层列表改为可链式滚动（`overscroll-behavior:auto` 或删声明），确认 012 遗留列表是否同一路径并按需同步。
- [x] T004 客户端测试：DOM/CSS 静态断言（内层不再 contain、外层仍 contain、滚动条与 tabIndex 不变）。
- [x] T005 真实滚轮验收：CDP 连续 wheel 断言「内层到边界后外层 scrollTop 递增」，中文界面 + 2D/3D 各一次。
  结果：正向内层 396 后外层 1302→1526（+224）、反向内层 396→0 后外层 1406→0、`window.scrollY` 恒 0；2D/3D 两种视图与中文界面各滚一轮。
- [x] T006 guards 新增小节并同步 COPY/计数；README 中英计数与 CHANGELOG 条目。
- [x] T007 提交（fix / test / docs 三个提交）并复跑七步门禁，贴输出。
  提交：`fix(usage)` 滚动链、`test(usage,panel)` 断言、`docs(usage)` 文档；门禁见 docs 提交后的最终输出。
