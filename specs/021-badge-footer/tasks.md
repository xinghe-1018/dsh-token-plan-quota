# 021 任务（tasks）

状态：T001–T006 已完成（`evidence/panel-after.json` 验收 verdict=`pinned-ok`，另修掉悬浮态 `[data-float=1]` 无效选择器，client 1358 / guards 603）；只剩 T007 提交与复跑七步门禁。

- [x] T001 复现取证：隔离实例 → 打开徽标弹层 → 量 `.tpq-usage-entry` / `.tpq-updated` 的 rect 与 `.tpq-body` 的 clientHeight/scrollHeight；再把悬浮面板缩到最小高度重复一次。期望看到「按钮底边 > body 可视底边」。
- [x] T002 写 plan.md 与 INTERFACE.md（选 sticky 底栏还是两段式；DOM 契约、CSS 契约、断言契约、验收三角）。
- [x] T003 客户端：Badge 的 children 结构调整 + `.tpq-panel-foot` 样式（面板底色、上描边、负外边距、sticky）。
- [x] T004 客户端测试：结构断言（两个按钮在 foot 里）、CSS 断言（sticky/bottom、底色不硬编码、不盖 resize 手柄）。
- [x] T005 视觉验收：默认态 / 悬浮最小高度 / 多卡长内容三种情形的截图与 rect 断言，中英各一轮。
  结果：锚定态 entry 370..396 全可见；悬浮 280×160 下 body 182 可滚、updated/entry 各 26px 全可见；
  160→420 十一档 sweep 全可见；`elementFromPoint` 命中 `.tpq-resize`；顺带修掉悬浮态无效选择器。
- [x] T006 guards 新增小节 + README 中英计数 + CHANGELOG；如出图则登记 check-docs 图清单。
- [x] T007 提交（fix / test / docs）并复跑七步门禁。
  提交：`fix(panel)` 底栏 + 选择器修正、`test(usage,panel)` 断言、`docs(usage)` 文档；门禁见 docs 提交后的最终输出。
