# 023 单模型估算独立成模块

状态：进行中（2026-11-15）
关联：019（单模型容量占比）、022（按官方价目估算）

## 背景

022 交付后，「如果只用这一个模型」被塞在 014 的 Credits ↔ tokens 换算卡内部（`usageCreditsSection` 的 children 末尾），
标题之下还有三行灰色小字：提示「把本账期全部 {total} Credits 都花在 {model} 上能换多少 tokens」、
「按实测占比折算 {tokens} tokens（贡献份额，不可相加）」、口径脚注。

用户（m01265）原话：

> 「如果只用这一个模型」
>
> 「如果只用单个模型」
> 另外那些小的灰色字体不用写，把我说的这个单独列一个模块

即：标题改为「如果只用单个模型」；不再写那些小号灰色说明文字；把这块从换算卡里拆出来，单独成为一个模块。

## 目标

- FR-001 标题：中文「如果只用单个模型」，英文「If you used a single model」。
- FR-002 独立模块：成为与「本机用量」「官方对照」「Credits 换算」并列的独立 section，位于 Credits 换算卡之后。
- FR-003 去掉灰色小字：删除 hint / share / note 三段文案与对应 DOM、CSS、i18n 键；只保留标题、模型 chip、结果卡（标签 + 数字 + 四类分项）。
- FR-004 数据与口径不变：仍用 022 的 estimate（官方价目 × 本账号实测比值），无价目模型回落到 019 的 capacity；不新增配置键、路由、出站请求。
- FR-005 计数契约不变：页面数据卡仍是 `tpq-usage-card` 恰好 3 张；新模块用自有类名，不污染既有断言。
- FR-006 旧宿主兼容：credits 不可用 / 未就绪 / 没有可算模型时，新模块不渲染（与 022 行为一致）。

## 非目标

- 不改宿主 `lib/index.js` 的价目表与估算公式（022 已定稿）。
- 不新增开关、不改面板其它块顺序。
- 不重拍 docs 截图（读图通道仍不可用，spec 022 已写明）。

## 验收标准

- SC-001 换算卡内不再出现 `data-usage-credits-modelpick`；新模块 `data-usage-single-model="1"` 出现在换算卡之后。
- SC-002 新模块标题文案为「如果只用单个模型」，且模块内不存在 hint / share / note 节点。
- SC-003 COPY 键数 158 / 158（删除 3 个键 × 中英）。
- SC-004 `npm run check` 全绿（host / client / guards / manifest / docs / refs / submission）。
