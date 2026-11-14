# 016 计划

## 1 为什么这么做

- 014 的分项用**官方口径**（官方 accounts tokens 含其他设备），015 的模型行用**本机口径**（官方不按模型拆分）。
  两套分子不能混：混了模型行相加会不等于任何一边的总量。016 只在 015 的模型行内部再拆，分子仍是本机。
- 分母只有一个可用真值：本账期**账号级已用 Credits**（官方每账期一个读数）。所以每行都是「该模型贡献的 X 类 tokens ÷ 账号已用 Credits」，
  不是「该模型自己花了多少 Credits」——后者官方不存在，按比例分摊会让每行恒等于总比值（015 已拒绝的假精确）。

## 2 分工

| 层 | 文件 | 内容 |
|---|---|---|
| 宿主 | `lib/index.js` | `creditsModelRatios` 每行加 `classes`（4 类，各 `{tokens, perCredit}`）；`__internals` 不变（函数已在） |
| 宿主测试 | `test/host.mjs` | 恒等、0 兜底、非法行过滤、缺字段、used=0 短路、不取整 |
| 客户端 | `lib/client.js` | COPY +1 键、模型行第二行、CSS 一行、脚注改写 |
| 客户端测试 | `test/client.mjs` | 三类渲染、cacheWrite 追加条件、缺字段不渲染第二行、无 %、双语 |
| 静态守卫 | `test/guards.mjs` | 第 16 节静态矩阵 |
| 截图/文档 | `scripts/shots/*`、`README*`、`CHANGELOG.md` | fixture 扩 classes、场景 ⑯ 断言、重拍两张图 |

## 3 失败模式

| 情况 | 行为 |
|---|---|
| 本机某模型缺 `cacheRead` | 该类 tokens 记 0，仍渲染（0 是真实值，不是缺失） |
| 三类任一 perCredit 非有限 | 该行第二行不渲染，第一行保留 |
| 旧宿主（无 classes） | 客户端只渲染第一行，不报错（FR-006/SC-004） |
| `credits.used` ≤ 0 | 015 已提前短路成 `no-token-data`，016 不产生比值 |
| 模型极多 | 252px 定高内滚，键盘可达 |
| `cacheWrite` 恒 0 | 不渲染第四段，行更短 |

## 4 不做什么

- 不做「每模型 Credits 分摊」；不做「每模型配额百分比」；不请求官方模型维度（不存在）。
- 不改 014 的账号级三类分项，也不改 015 的 `tokensPerCredit` 语义。
- 不加新路由/参数/配置键/主机/依赖。

## 5 验收

- `node test/host.mjs`、`node test/client.mjs`、`node test/guards.mjs` 全绿；
- `npm run check` 七步（host/client/guards/manifest/docs/refs/submission）全绿；
- 中英截图各一张，模型块内滚触发（scrollHeight > clientHeight）。
