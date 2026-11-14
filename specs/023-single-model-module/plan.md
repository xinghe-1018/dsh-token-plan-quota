# 023 方案

## 方案 A（采纳）独立 section + 去掉小字

- 新增 `usageSingleModelSection(copy, credits, stale)`：credits ready 且存在可用模型时渲染
  `section.tpq-usage-single-model[data-usage-single-model="1"][data-stale]`，h3 用 `copy.usageCreditsModelPickTitle`。
- `UsageCreditsModelPick` 去掉 title / hint / share / note；根节点由 section 降为 div，chips 的 aria-label 继续用标题文案。
- 换算卡的 children 不再 push modelPick；块装配处在 credits 块之后 push 新模块。
- CSS：删掉 hint / share / note / title 四条规则；新增 `.tpq-usage-single-model`（复制 credits 卡视觉：1px 描边、12px 圆角、14/16 内边距、layer-1 底、column gap 8、margin-top 12、stale 降透明度）。
- 不共用 `.tpq-usage-card`：既有用例按「恰好 3 张数据卡」精确计数（008/014 同一取舍）。

## 方案 B（否决）留在换算卡内只删小字

不满足「单独列一个模块」；模块边界不清，用户下一次仍会问「这块在哪」。

## 方案 C（否决）加 019/022 手动开关

用户没要开关；022 非目标已写明不新增配置键，加开关反而增加状态面。

## 实施步骤

1. COPY 中英改标题、删 Hint/Share/Note 三键（161 → 158）。
2. 改 `UsageCreditsModelPick` 与换算卡 children；新增 `usageSingleModelSection` 并在装配处接线。
3. CSS 删除死规则、新增模块容器规则。
4. client 测试：更新 022 相关断言；新增 T023（独立模块、无小字、无模型时不渲染）。
5. guards：六处 COPY 计数 161→158；022 静态断言改为新结构；新增第 23 节。
6. README 中英、CHANGELOG、specs/023 四件；全量门禁；三提交（feat / test / docs）。

## 风险

- 旧快照/旧宿主没有 estimate：仍回落 019 capacity，数字语义不变，只是少了 grey 说明。
- 删除 note 意味着面板不再解释估算口径；口径说明保留在 README 与 CHANGELOG/规格文档中（用户明确要求不写小字）。
