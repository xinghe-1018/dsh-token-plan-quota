# 013 实施计划：整页滚动 + 模型归属

> 前提与契约见 spec.md / INTERFACE.md（INTERFACE 是唯一实现真值）；任务与负责人见 tasks.md。

## 1 已核前提（证据来自本轮实测，不再重复调研）

1. 宿主 main 座位是固定高度容器：`.mP3x-q_mainPanel` 860px、column flex；`.mP3x-q_centerCol` 与 `.mP3x-q_frame` 均 `overflow:hidden`。插件屏根节点是 slot wrapper 的 `display:contents` 子节点 ⇒ 根节点自己没有高度约束，内容超出即被外层裁掉。
2. 在根节点外包一层「height:100% + overflow-y:auto」的 div 后，同一份真实数据（内容 1183px）在 860px 视口下 `clientHeight=860 / scrollHeight=1183`，滚到底可见脚注与更新时间；模型列表仍独立内滚。这是 FR-001..FR-005 的直接验证。
3. 索引增量折叠丢失模型上下文：`syncUsageIndex` 只读 `lastSeq+1` 起的切片，折叠函数只在切片内遇到 `request/header` 才更新 provider/model；切片无 header 时整片记 unknown。全量重扫 245 份日志 unknown 调用数为 0 ⇒ 数据可归位。
4. 索引已有坏文件备份 + 空索引重建通路（`backupBadIndex` / `loadUsageIndex`），schema 升版不需要写迁移函数。

## 2 方案取舍

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| A. 让宿主 main 座位可滚（改宿主/配置） | 否 | 插件不能改宿主布局；会影响其他整页插件 |
| B. 在插件根节点自建滚动视口（选中） | 是 | 局部改动、两个 return 点统一 helper、可测可截图；失败模式温和（座位变 auto 时退化为不裁切） |
| C. 虚拟滚动 / 粘性表头 | 否 | 超出需求，且会破坏既有截图几何与 DOM 断言 |
| D. 前端按启发式把 unknown 映射成某模型 | 否 | 违反「只报实测真值」宪法：必须从会话 header 取真值 |
| E. 索引里存「最近已知模型」上下文（选中） | 是 | 增量折叠本来就有 previous 状态；两键可选字段，旧索引自然重建 |

## 3 分阶段

1. **Phase A 宿主（host-core）**：`lib/usage-stats.js` schema v2 + 折叠上下文继承 + 两处写回；`test/host.mjs` 新增 T201–T205。
2. **Phase B 客户端（client-ui）**：`lib/client.js` 滚动视口（helper + CSS）；`test/client.mjs` 新增 T101–T103，并修既有受 DOM 层级影响的断言。
3. **Phase C 门禁与真机（Lead）**：`test/guards.mjs` 第 13 节（T104）；真实日志重建（T302）；CDP 真机滚动与窄屏（T301）；文档计数与 CHANGELOG。
4. **Phase D 收口**：三个提交（feat / test / docs），提交后复跑 `npm run check` 七步并汇报。

## 4 写作用域（并行安全）

- host-core：`lib/usage-stats.js`、`test/host.mjs`
- client-ui：`lib/client.js`、`test/client.mjs`
- Lead：`test/guards.mjs`、`README*`、`CHANGELOG.md`、`specs/**`、截图脚本与图
- 互不重叠；两个 teammate 并行无冲突。

## 5 风险与失败模式

1. **高度解析失败**（座位变 auto）：视口退化为内容高度，行为与今天相同（可读但不滚），不会裁得更狠。测试里对 `height:100%` 的存在做静态断言即可，不假定运行时一定 860。
2. **双层滚动打架**：模型列表内滚到边界后滚轮外溢。用视口 `overscroll-behavior:contain` 阻断；真机探针验证「列表滚到底一次滚轮不带动整页超过一屏」。
3. **滚动条挤压 920px 列**：不写 `scrollbar-gutter:stable`；截图仍按 1280×860，若实测列位移 >2px 则回退该属性并在实施记录写明。
4. **索引重建耗时**：245 份日志全量重扫在本机约十几秒量级（历史 backfill 实测同量级），可接受；重建失败会留 `.bad-<ms>` 备份，不丢日志。
5. **unknown 仍有残留**：若某些会话日志里从未出现合法 header（截断/空会话），重建后仍有少量 unknown。此时按 SC-008 记录残留会话 id 与原因，不伪装成 0。
6. **测试断言与 DOM 层级耦合**：既有 client 断言用 `.tpq-usage` 取根，包一层后仍成立；但若有断言直接假定「根节点是最外层」，需改为在 `.tpq-usage-viewport` 下查找。

## 6 验收

- `npm run check` 七步全绿（host / client / guards / manifest / docs / refs / submission）。
- 真机：860px 滚到底可见脚注；375/320 无横向溢出；模型列表内滚仍在。
- 真实重建：unknown/unknown 285.7M tokens / 2347 次调用按 header 归位（目标 0 残留），实施记录写前后对比。
- 文档：README 中英、CHANGELOG、INTERFACE §6 实施记录同步；测试计数按实跑回填。
