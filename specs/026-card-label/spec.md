# 026 单模型卡片标签改为「按实测用量折算」

状态：进行中（2026-11-15）
关联：019（单模型容量）、022（价目估算）、023（独立模块）、024（撤脚注）、025（夜间折扣说明）

## 背景

022 起，有公开忙时单价的模型在主数字上打标签「按官方价目估算 tokens」/ "Estimated from list prices"。
用户读到的意思是「这个数是按官方价目换算出来的」，于是追问（m02010）：

> 「实际上在我本机的计算方式应该是我使用的量做的计算而不是官方价格计算吧」

复核结论：主数字的**规模**来自本机实测 tokens 与官方已用 Credits（单模型时价目约掉，等价于
`total × tokens / used`），官方价目只提供「跨模型换乘倍率」。所以旧标签把口径说反了一半。
用户（m02330）要求：

> 「改一下卡片标签」

## 目标

- FR-001 卡片标签文案改为 zh「按实测用量折算 tokens」/ en "Derived from measured usage"。
  仍是 i18n 键 `usageCreditsModelPickEstimate`，键名与键数（153 / 153）不变。
- FR-002 只改文案：结果卡 DOM（`p.tpq-usage-credits-modelpick-card-label`）、类名、数据钩子、
  分项格结构、夜间折扣说明（025）全部不动。
- FR-003 数据口径零变化：主数字仍是 022 `estimate`，无价目回落 019 `capacity`；不改估算公式、
  不新增路由 / 配置键 / 出站主机 / 依赖，宿主 `lib/index.js` 不动。
- FR-004 同步测试与守卫：client 断言新字面量；guards §22 的 README 断言改口径，新增第 26 节静态矩阵。
- FR-005 文档：README 中英的单模型段落说明 026 起标签改名且数字口径未变；CHANGELOG 在
  Unreleased/Added 加 026 条目。

## 非目标

- 不改 025 的夜间折扣说明（用户本次只点名标签；两句是否要统一口径留待用户决定）。
- 不改历史 CHANGELOG 里 022 条目原有的「按官方价目估算 tokens」表述（那描述的是 022 发布时的实现）。
- 不重拍 docs 截图（022 起已声明读图/截图通道不用，界面文案改动不重拍）。

## 验收标准

- SC-001 中英文界面卡片标签逐字为「按实测用量折算 tokens」/ "Derived from measured usage"。
- SC-002 `lib/client.js` 里不再出现「按官方价目估算 tokens」与 "Estimated from list prices" 字面量。
- SC-003 COPY 153 / 153；client / guards 全绿；宿主机测试数不变（1073）。
- SC-004 零新配置键（DEFAULTS 26）、零新出站主机（8）、零第三方依赖。
