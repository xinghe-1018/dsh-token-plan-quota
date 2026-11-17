# 028 INTERFACE（实现唯一真值）

## 1. 宿主

无改动。`publicCard` 白名单、`token-plan-console` preset 的 `label`/`labelEn`、
deepseek-balance 源 `providers`、`bindProviders` 直传（均在 lib/index.js）为本次对齐的**权威来源**，不改。

## 2. 夹具（scripts/shots/fixture.mjs）

| 卡 | 字段 | 旧 | 新（宿主真值） |
|---|---|---|---|
| `consoleCard` | label zh / en | 千问 Token Plan / Qwen Token Plan | Token Plan 余量 / Token Plan quota |
| `deepseekMoneyCard` | bindProviders | ['deepseek-official'] | ['deepseek', 'deepseek-official'] |
| triptych 第二张 | 卡 | `creditsPlanCard`（合成 id token-plan-credits） | `consoleCard`（与②同源） |
| `creditsPlanCard` | 整段 | 存在 | 删除 |

`consoleCard` 数据不变：weekly 53600/70000、fiveHour 900/1200、extra.usedPercent 23、两条 meters。

## 3. 取景（scripts/shots/make-shots.mjs）

triptych 浮框：`const floatX = Math.min(Math.round(chip0.x) - 10, 1150 - 520 - 90)`，
`setFloatBox({ x: floatX, y: 18, w: 520, h: 332 })`。视口 1150×820、dsf2 不变；`framedClip` 不变。

## 4. 测试契约

宿主/客户端/guards 测试不涉及夹具，零改动、测试数不变。check-docs 引用的图文件名
（state-token-plan-credits.png 等）保持，内容重拍。

## 5. 文档契约

README 图注不变；CHANGELOG Unreleased/Fixed 记 028；specs/028 四件。
