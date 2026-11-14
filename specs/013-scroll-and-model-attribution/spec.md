# 013 用量统计屏整页滚动 + 未知模型归属

> 状态：已批准（用户 2026-11-14 提出，原话「缺少一个大滚动条用来调整整个页面的垂直方向上的上下，另外那个显示为未知的模型实际上是带视觉桥的千问平台的v4.1flash」）
> 模板：specs/006-usage-stats/spec.md。实现唯一真值见 INTERFACE.md。

## 背景

1. 用量统计屏是宿主 main 座位的整页应用。宿主给的主区是固定高度（实测 860px 视口下 `.mP3x-q_mainPanel` = 860px），外层 `.mP3x-q_centerCol` 与 `.mP3x-q_frame` 都是 `overflow:hidden`。屏幕根节点 `.tpq-usage` 只有 `max-width:920px` 与 padding、没有高度与溢出策略，内容比视口高时（实测 1183px）被外层裁掉，且没有任何滚动条 —— 用户看不到下半屏（缓存命中率公式脚注、官方对照块、更新时间）。
2. 模型排行里出现 `unknown/unknown`（本机实测 285,747,102 tokens / 2347 次调用）。根因在会话索引的**增量折叠**：`syncUsageIndex` 每轮只读 `lastSeq+1` 之后的切片，而折叠函数只在切片内遇到 `request/header` 才更新 provider/model；切片里没有新的 header 时，模型上下文丢失，整片用量被记成 unknown。全量重扫（从 0 折叠）实测 245 份会话 0 条 unknown，证明数据本身有归属、只是增量路径丢了上下文。

## 用户故事

- US-1：我用鼠标滚轮或拖动右侧滚动条，能把用量统计屏从上滚到下，看到全部内容（总量卡、图表、模型排行、脚注、更新时间）。
- US-2：模型排行不再出现「未知」；这些调用按真实模型（provider/model）归位。

## 功能需求

- FR-001 整页滚动：`.tpq-usage` 外包一层滚动视口；视口在宿主主区高度内撑满并 `overflow-y:auto`，纵向可滚、横向不允许出现滚动条。
- FR-002 滚动条可见可用：细滚动条（8px thumb、圆角、主题变量取色），键盘可滚（视口 `tabindex=0`，可聚焦时显示 focus 环），滚轮/触控板/拖动滚动条三种都生效。
- FR-003 键盘与读屏：视口 `role="region"` + `aria-label` = 屏幕标题；不许把内部所有控件移出 Tab 序列，也不许新增焦点陷阱。
- FR-004 内层滚动保留：模型排行仍在自己的 252px 盒子里滚动（嵌套滚动是有意的），整页滚动只负责屏幕级上下。
- FR-005 滚动不改变既有版面：920px 居中列宽、24px/20px/32px padding、卡片间距与 2D/3D 图表几何不变；375px 与 320px 下不得出现横向溢出。
- FR-006 模型归属：会话索引增量折叠要跨轮次记住该会话最后一次已知的 provider/model，下一轮切片没有 header 时沿用；兜底目录扫描路径同口径。
- FR-007 归属是**实测真值**：只把会话日志里 header 声明的 provider/model 写回索引，不按「看起来像」映射，不猜测；仍无法确定（日志里从未出现合法 header）时继续记 `unknown/unknown` 并在 `stats.unknownModel` 计数。
- FR-008 老索引迁移：索引 schema 升版；旧版文件按既有坏索引策略备份为 `<path>.bad-<ms>` 后从空索引全量重建，重建结果覆盖全部历史日桶。
- FR-009 双语：新增文案（若有）zh/en 成对；本轮不新增配置键、不新增路由、不新增出站主机。
- FR-010 011 浮层与 012 占比不受影响：悬停浮层、占比/命中率公式与口径不变。

## 非目标

- 不做吸顶表头、不做虚拟滚动、不改宿主 main 座位布局、不给图表加缩放。
- 不手工改写历史 unknown 数字做「凑数」；只通过重建让真实 header 生效。

## 验收标准

- SC-001 860px 视口、7 天数据（内容高 1183px）下：视口 `clientHeight=860`、`scrollHeight>clientHeight`，滚到底后最后一条脚注与更新时间都在视口内。
- SC-002 375px 与 320px 视口：`documentElement.scrollWidth === clientWidth`（无横向溢出），滚动条不遮挡内容（`scrollbar-gutter` 不强制占位，内容仍可读）。
- SC-003 视口可聚焦：`tabindex="0"`、`role="region"`、`aria-label` 非空；键盘 PageDown/↓ 能改变 `scrollTop`。
- SC-004 模型排行内层滚动仍在：容器 `clientHeight≈252`、`scrollHeight>clientHeight`；整页滚动到模型卡时它仍独立可滚。
- SC-005 增量折叠单测：第一片含 header、第二片只有 `assistant/message` 时，第二片用量记在 header 声明的模型上，`stats.unknownModel === 0`，`sessions[id].lastProvider/lastModel` 已写入。
- SC-006 兜底扫描路径同样的两片用例通过。
- SC-007 旧版（version 1）索引文件加载：返回空索引并生成 `.bad-<ms>` 备份；随后全量重建后 unknown 不再新增。
- SC-008 本机真实日志重建后：`stats.unknownModel` 从 2347 降到 0（允许日志缺失导致的小量残留，若不为 0 必须在实施记录里写清残留在哪些会话、为什么），`unknown/unknown` 桶的 285.7M tokens 落到真实模型 id。
- SC-009 门禁：host / client / guards 三套断言全绿，README 计数、CHANGELOG、INTERFACE 实施记录同步。
