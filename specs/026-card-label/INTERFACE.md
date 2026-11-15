# 026 INTERFACE（实现唯一真值）

## 1. 宿主

无改动。`ratio.models[].estimate` / `ratio.priceBasis` 契约保持。

## 2. 客户端

COPY（键名不变，只改值）：

| key | zh | en |
|---|---|---|
| `usageCreditsModelPickEstimate` | 按实测用量折算 tokens | Derived from measured usage |

DOM 不变：结果卡内 `p.tpq-usage-credits-modelpick-card-label` 继续渲染 `copy.usageCreditsModelPickEstimate`，
仅在 `estimate !== null` 时出现。类名、数据钩子、分项格、025 夜间说明均不动。

## 3. COPY 契约

153 / 153，无新增 / 删除键。

## 4. 测试契约

- client：COPY 四键逐字更新为「按实测用量折算 tokens」/ "Derived from measured usage"；T022 有 estimate 与 en 用例的
  card-label 期望同步；无 estimate 时仍回落「折算可用 tokens」。
- guards：§22 README 断言要求 README 出现「按实测用量折算」与 "Derived from measured usage"；第 26 节校验新字面量、
  旧字面量零残留、DOM 节点与 estimate 接线未变、零新配置键 / 出站 / 依赖、README / CHANGELOG 含 026、specs/026 四件。

## 5. 文档契约

README.md / README.en.md 的单模型段落写明 026 起标签改名、数字口径未变；CHANGELOG 在 Unreleased/Added 记 026。
