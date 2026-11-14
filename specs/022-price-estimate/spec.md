# 022 按官方价目的单模型估算（spec）

## 背景

用户（m00796 / m00861）质疑折算口径：「8w credit 能出来的额度应该是 50 亿左右，但是按照单个模型算怎么加起来是 50 亿左右」
「如果将 8w 额度只用在单个模型上为什么会发现额度低了这么多？明明我是两个模型一个便宜一个贵混着用的，现在测出来都是 50 亿，单用一个便宜的为什么只有一半」；
随后（m00879）明确提出：「如果我想看到单用一个模型的套餐额度大概用量呢」。

根因在 019：`capacity.tokens = Σ Math.round(perCredit × credits.total)`，其中 `perCredit = 本机该模型 tokens ÷ 账号级已用 Credits`。
这是**占比折算**——五行 capacity 相加恒等于表头容量（5,100,197,867 ≈ 51.0 亿），所以任何单模型的数字都不可能超过 51 亿，
而且把模型之间的**价格差异**完全抹平：本机 96% 的 tokens 是缓存命中，qwen3.8-flash 缓存价 ¥0.1/M 是
deepseek-v4.1-flash-1017 缓存价（忙时 ¥0.04/M）的 2.5 倍，按 tokens 占比分摊必然给贵的模型低估、便宜的模型高估。

## 目标

- 在 019 的结果卡上，对**有公开价目**的模型再给一个「按官方价目估算」的可用 tokens，作为主数字；
  019 的占比折算降为卡片下方一行小字（明写「贡献份额，不可相加」），两种口径同时可见、不互相冒充。
  > 后续：023 把整个选择器拆成独立模块并删除 hint / share / note 三行小字（用户要求），estimate 主数字口径不变；
  > 本节「一行小字」的描述自 023 起不再成立，留作历史记录。
- 价目内置为宿主常量（零网络、零第三方依赖），校准系数来自**本账号实测**（价目成本 ÷ 已用 Credits），
  不硬编码套餐价、不写死汇率。
- 口径标注不变：仍写「折算参考，非官方口径」；没有公开价目的模型退回 019 行为（只给占比折算）。

## 非目标

- 不新增路由、配置键、出站主机或第三方依赖；不改 019 的 `capacity` 字段及其含义。
- 不做模型横向对比表（用户要的是「选一个看一个」），不做「剩余额度」估算，不写回账本。
- 不按设备/时段拆分 Credits：官方控制台不返回按模型明细（见 008），本功能只能反推，属估算。
- 本轮不重拍截图（本机图像目检通道失效，见 §证据）；019 的两张旧图沿用，文字描述为准，留给发版前统一重拍。

## 功能需求

- **FR-001 价目表常量**：宿主内置 `MODEL_PRICE_PER_MTOKENS`（人民币 / 百万 tokens，忙时标准价，取价日 2026-11-15）：
  `qwen3.8-flash = { input: 0.8, cacheRead: 0.1, output: 2.7 }`、
  `deepseek-v4.1-flash-1017 = { input: 2, cacheRead: 0.04, output: 8 }`、
  `deepseek-v4.1-flash = { input: 2, cacheRead: 0.04, output: 8 }`；
  `qwen4-max-preview` 等没有公开单价的模型**不进表**，不出估算。
- **FR-002 估算函数**：`modelsWithPriceEstimate(models, used, total)` 在 019 的结果上追加 `estimate = { tokens, classes }`：
  `priceMix = Σ(单价 × 该类 tokens) / 行 tokens`；`cost = Σ(priceMix × 行 tokens)`；`ypc = cost / used`；
  `estimate.tokens = Math.round(total × ypc / priceMix)`；`estimate.classes` 按该模型四类 tokens 占比分配、
  合计严格等于 `estimate.tokens`（最大余数法，cacheWrite 为 0 时不分配）。
- **FR-003 接线与元数据**：`composeCreditsToken` 的 `ratio.models` 走新函数；至少一项有估算时补
  `ratio.priceBasis = { kind: 'list-price', verifiedAt: '2026-11-15', unit: 'CNY per million tokens' }`。
- **FR-004 客户端主数字**：019 组件里若选中项有 `estimate`，总值与分项改用 estimate，标签换成
  `usageCreditsModelPickEstimate`，并在卡片底部加一行 `usageCreditsModelPickShare`
  （「按实测占比折算 {tokens} tokens（贡献份额，不可相加）」）；无 estimate 时逐字段保持 019。
- **FR-005 文案口径**：Hint / Note 改写说明价目口径、未计 22:00–08:00 夜间折扣与无公开单价模型（不新增键数）；
  `usageCreditsModelPickCard` 保留给旧宿主路径。
- **FR-006 退化与防御**：`used` / `total` 非有限或 ≤ 0、没有任何可定价模型、行 tokens 为 0 → 不写 `estimate`（旧形状）；
  客户端 estimate 解析失败（tokens 非有限、classes 缺键）→ 回落 capacity；绝不产出 NaN / Infinity / 负数。
- **FR-007 可核性**：两个宿主函数进 `__internals`，客户端 `usageModelEstimateOf` 进 `__internals`；
  测试用手算数值钉住 ratio 数学与取整自洽（不依赖真实网络快照）。
- **FR-008 文档**：README.md / README.en.md 的单模型段补估价说明；CHANGELOG Unreleased/Added 加 022 条目；
  本目录四件（spec / plan / INTERFACE / tasks）。

## 成功标准

- **SC-001** 本机 11-01..11-15 真实数据下估算量级正确：qwen3.8-flash ≈48 亿、deepseek-v4.1-flash-1017
  qwen 通道 ≈48 亿 / modlens 通道 ≈55 亿 tokens（按本目录 plan.md 的价目成本手算，`ypc ≈ 8.26×10³`），四类分项之和逐字等于总值。
- **SC-002** 估算与手算一致：测试里用独立算式复算 `Math.round(total × (Σ priceMix_i × tokens_i / used) / priceMix)`，
  不复制实现里的中间变量。
- **SC-003** 静态守卫锁住：价目表常量与取价日、两个函数存在且被接线、COPY 键数 zh/en 各 161、
  README 两版与 CHANGELOG 都有 022 说明、规格目录四件齐全。
- **SC-004** 七步门禁（host / client / guards / check-manifest / check-docs / check-refs / check-submission）
  在最后一次编辑之后全绿，工作树干净，feat / test / docs 三个提交分开。

## 证据与依赖

- **价目（2026-11-15 实取）**：`https://www.qianwenai.com/models/qwen3.8-flash` 明码
  输入 ¥0.8/M、缓存命中 ¥0.1/M、输出 ¥2.7/M；`https://www.qianwenai.com/models/deepseek-v4.1-flash-1017`
  有「闲时 / 忙时」两档（页面默认闲时：¥1 / ¥0.02 / ¥4；忙时：¥2 / ¥0.04 / ¥8，与 DeepSeek 官方 CNY 价一致）；
  `/models/qwen4-max-preview` 404，无公开单价。
- **校准数据（credits-daily 快照）**：`tokensOfficial = 2,568,983,334`、`creditsUsed = 40,296.2144`、
  `creditsTotal = 80,000`、`tokensPerCredit = 63,752.47`、`capacityTokens = 5,100,197,867`。
- **分模型 tokens（11-01..11-15 本机账本）**：qwen3.8-flash 1,331,249,952（input 51,349,067 / cacheRead 1,274,817,792 /
  output 5,083,093）；qwen 通道 ds1017 633,676,137（14,692,780 / 614,849,792 / 4,133,565）；modlens 通道 ds1017
  525,264,805（10,762,290 / 511,813,888 / 2,688,627）；qwen4-max-preview 13,688,489；ds-v4.1-flash 2,760,961。
- **已知限制**：官方不按模型拆 Credits、也没有公开的「每模型 Credits 价」，所以估算 = 公开价目（相对权重）×
  本账号实测（绝对水平）；夜间折扣、Batch 价、其他设备用量都会带来偏差，量级 ±15%。
- **视觉验证通道**：本机 `read_image` / modlens 视觉读图失败，截图无法目检，故本轮不新增截图。
