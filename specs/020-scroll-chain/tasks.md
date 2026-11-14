# 020 任务（tasks）

状态：待做。接手会话先把 T001/T002 做完再动代码；spec 见同目录 spec.md。

- [ ] T001 复现取证：隔离实例打开用量屏 → 定位「按模型用量」列表 → 用 CDP wheel 连续滚动，记录内层/外层 scrollTop 序列，确认「内层到底后外层不动」。证据落 `~/.dsh/tmp/shots-020/evidence/`。
- [ ] T002 写 plan.md 与 INTERFACE.md（改动表：哪几条 CSS 的 `overscroll-behavior` 从 contain 改成 auto、哪些**必须保留** contain；断言契约；不做清单）。
- [ ] T003 客户端：内层列表改为可链式滚动（`overscroll-behavior:auto` 或删声明），确认 012 遗留列表是否同一路径并按需同步。
- [ ] T004 客户端测试：DOM/CSS 静态断言（内层不再 contain、外层仍 contain、滚动条与 tabIndex 不变）。
- [ ] T005 真实滚轮验收：CDP 连续 wheel 断言「内层到边界后外层 scrollTop 递增」，中文界面 + 2D/3D 各一次。
- [ ] T006 guards 新增小节并同步 COPY/计数；README 中英计数与 CHANGELOG 条目。
- [ ] T007 提交（fix / test / docs 三个提交）并复跑七步门禁，贴输出。
