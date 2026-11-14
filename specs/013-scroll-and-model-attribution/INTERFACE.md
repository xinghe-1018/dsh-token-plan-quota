# 013 INTERFACE —— 实现唯一真值

> 本文件是 013 的实现契约。代码与本文件冲突时以本文件为准；实现中发现契约有问题，先改本文件再改代码。
> 编号：FR/SC 见 spec.md；测试编号 T0xx 见 tasks.md。

## 1 范围与边界

- 只改两处生产代码：`lib/client.js`（滚动视口）与 `lib/usage-stats.js`（索引 schema v2 + 折叠上下文）。
- `lib/index.js` 不改：不新增配置键、不新增路由、不新增出站主机、工具 action 枚举不变。
- 不动 `.tpq-usage` 的既有排版规则（max-width 920 / margin auto / padding 24 20 32 / gap 16），只把「谁来滚」从外层宿主改为插件自己的视口。
- 011 悬停浮层、012 占比/命中率、010 月份查询、008 官方对照的行为与文案不变。

## 2 滚动视口契约（lib/client.js）

### 2.1 DOM

`UsageScreen` 的两个 return 点（错误态短路与正常态）都包成同一结构，用内部 helper `usageViewport(copy, blocks)` 生成，避免两处漂移：

```jsx
<div className="tpq-usage-viewport" data-usage-scroll="1"
     tabIndex={0} role="region" aria-label={copy.usageTitle}>
  <div className="tpq-usage">{blocks}</div>
</div>
```

- `data-usage-scroll="1"`：截图/探针定位用（与 `data-usage-models-scroll` 同一命名习惯）。
- `role="region"` + `aria-label` = `copy.usageTitle`（zh「Token 计划用量」/ en 对应值），供读屏识别滚动区域。
- 内层 `.tpq-usage` 的 class 与内容顺序不变；测试仍用 `.tpq-usage` 取根。

### 2.2 CSS（新增，追加在 `.tpq-usage` 规则之后）

```css
.tpq-usage-viewport{display:block;width:100%;height:100%;min-height:0;flex:1 1 auto;
  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:var(--dsw-alias-border-l2,rgba(128,128,128,.4)) transparent}
.tpq-usage-viewport:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4176e6);outline-offset:-2px}
.tpq-usage-viewport::-webkit-scrollbar{width:8px}
.tpq-usage-viewport::-webkit-scrollbar-thumb{border-radius:4px;
  background:var(--dsw-alias-border-l2,rgba(128,128,128,.4))}
```

契约点：

- `height:100%` 解析基准是宿主 main 座位（`.mP3x-q_mainPanel`，实测 flex column、高度 860px）。座位若变成 auto 高度，`height:100%` 退化为 auto，视口随内容长高 —— 与改动前的可读性相同，不会更坏。
- 不写 `scrollbar-gutter:stable`：8px 细条 + 覆盖式滚动条时强制占位会让 920px 列左右位移，破坏既有截图几何。
- 不新增横向滚动：屏幕级横向溢出视为 bug（`.tpq-usage-scroll` 的图表内横向滚动保留）。

### 2.3 行为

- 滚轮 / 触控板 / 拖动滚动条 / 键盘（视口聚焦后 PageDown、↓、Home、End）都作用于本视口。
- 视口聚焦：Tab 顺序上排在屏内控件之前；不设 `autofocus`，不抢初始焦点；不设焦点陷阱。
- Esc 关闭整页（既有行为，由屏头关闭按钮与 011 的 keydown 逻辑维持）不变：Esc 不因视口聚焦而失效，也不因焦点在滚动条上而失效。
- 悬停浮层保持 `position:fixed` + portal：视口滚动时浮层随指针重新测量；指针不动而滚动时按既有「scroll 捕获事件关闭」通路收起。
- 嵌套滚动：模型排行容器 `.tpq-usage-models` 仍 `max-height:252px;overflow-y:auto`，滚到其边界后由 `overscroll-behavior:contain`（视口）阻断滚动链外溢，避免滚轮一次带动两层。

### 2.4 失败模式（必须写测试或明确接受）

| 情形 | 期望 | 处理 |
| --- | --- | --- |
| 宿主座位高度 auto | 视口不裁切内容、无内部滚动 | 接受（`height:100%`→auto） |
| 内容比视口矮 | 视口仍撑满座位高度（背景/边框一致） | 接受（`height:100%`） |
| 375px/320px | 无横向滚动条 | 测试 `scrollWidth===clientWidth` |
| 错误态/回填进度态 | 同样包在视口里，短内容不抖动 | 两个 return 点都走 helper |
| 视口内 fixed 浮层 | 不被 `overflow` 裁切（portal 到 body） | 既有 011 实现，保持不变；内联回退路径在视口内 absolute 也正常 |

## 3 索引 schema v2 与折叠契约（lib/usage-stats.js）

### 3.1 schema

- `USAGE_INDEX_VERSION = 2`（1 → 2）。
- `SESSION_KEYS = new Set(['revision','lastSeq','cut','lastProvider','lastModel'])`。
- `sessions[id].lastProvider` / `.lastModel`：可选、字符串、非空；要么都有、要么都没有；值取自该会话最近一次合法 `request/header` 的 `data.header.config.provider/model`（`trim()` 后）。
- `assertUsageIndexShape` 校验：出现键时必须是 `typeof === 'string' && trim() !== ''`，否则抛 `用量索引 schema 坏：sessions[<id>].lastProvider 不是非空字符串`（lastModel 同理）。不允许空串落盘。
- 顶层、days、models、stats 的其余白名单与计数含义不变。

### 3.2 foldUsageEvents

- 接收已有 `opts.modelDefaults`（不变），返回对象新增：
  - `provider`：折叠结束时的当前 provider（`''` 表示本片从未见过合法 header 且没有默认值）
  - `model`：同上
- 语义：`modelDefaults` 只在片首播种；片内遇到合法 header 即覆盖；空串 header 不覆盖（沿用既有行为）。
- 返回的 provider/model 已 `trim()`，不含 `/`；拼接 id 仍为 `provider + '/' + model`。

### 3.3 syncUsageIndex 增量路径

对每个会话（列表路径与兜底扫描路径同口径）：

1. 读 `previous = index.sessions[id]`；
2. `modelDefaults = previous.lastProvider && previous.lastModel ? { provider: previous.lastProvider, model: previous.lastModel } : undefined`；
3. 调 `foldUsageEvents(..., { retentionDays, now, modelDefaults })`；
4. 写回 `index.sessions[id] = { revision, lastSeq, cut }`，当 `folded.provider && folded.model` 都非空时再补 `lastProvider/lastModel`；否则省略两键（不要写空串）。
5. 折叠后仍无法确定模型的用量继续记 `unknown/unknown` 并累加 `stats.unknownModel`（这是唯一的 unknown 来源）。

### 3.4 迁移与重建

- `loadUsageIndex` 遇到 version 1 文件：`assertUsageIndexShape` 抛错 → 既有 `backupBadIndex` 复制为 `<path>.bad-<ms>` → 返回空索引 → 下一轮 `syncUsageIndex` 全量重建。
- 重建不删除任何会话日志，只重算 `days/models/stats`；旧 `.bad-<ms>` 文件保留给用户核查，不自动清理。
- `emptyUsageIndex()` 自动带 version 2，无需额外迁移函数。

### 3.5 验收用可复现命令

```
# 单测（宿主侧新增用例在 test/host.mjs）
node test/host.mjs

# 真实日志重建（在仓库根、用真 node；先备份真实索引）
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.dsh/token-plan-quota.usage-index.json';if(fs.existsSync(p))fs.copyFileSync(p,p+'.pre-013')"
# 触发：打开 DSH 用量屏（或进程内直接调 loadUsageIndex/syncUsageIndex）后读新索引
node -e "const j=require(process.env.USERPROFILE+'/.dsh/token-plan-quota.usage-index.json');console.log(j.version,j.stats,Object.keys(j.days).length)"
```

真实重建的统计结果（unknownModel 前后、285.7M tokens 落到哪个模型）写入 §6 实施记录。

## 4 测试矩阵

| 编号 | 层 | 断言 |
| --- | --- | --- |
| T101 | client | 静态：`data-usage-scroll`、`role: "region"`、`tabIndex: 0`、`aria-label: copy.usageTitle` 都在；两处 return 都经 helper（源码中 `usageViewport(` 至少 3 次） |
| T102 | client | CSS：`.tpq-usage-viewport` 含 height:100%/overflow-y:auto/overflow-x:hidden/overscroll-behavior:contain/scrollbar-width:thin/::-webkit-scrollbar-thumb |
| T103 | client | 错误态与正常态都渲染 `.tpq-usage-viewport > .tpq-usage`（假 DOM 渲染两态） |
| T104 | guards | 静态矩阵：滚动视口钩子、CSS 六件、模型容器 252px 内滚仍在、DEFAULTS 仍 25 键、DECLARED_HOSTS 仍 8、无新增 i18n/路由 |
| T201 | host | 两片增量：header 在片 1、片 2 只有 message → 模型归属正确、unknownModel=0、sessions[id] 有 lastProvider/lastModel |
| T202 | host | 三片：片 2 无 header 沿用片 1，片 3 换模型 header → 片 3 记新模型 |
| T203 | host | 兜底扫描两片同口径 |
| T204 | host | schema：lastProvider 为空串/非字符串 → assertUsageIndexShape 抛错；legacy v1 文件 → 空索引 + `.bad-` 备份 |
| T205 | host | 折叠返回 provider/model：无 header 无默认值时为空串，有默认值时回默认值 |
| T301 | 真机 | 860px 视口滚动到底可见脚注与更新时间（CDP 探针）；375/320 无横向溢出 |
| T302 | 真机 | 真实日志重建后 unknownModel 与 unknown 桶符合 SC-008（或记录残留原因） |

## 5 门禁与文档

- `npm run check` 七步全绿（最后一次编辑之后实跑并贴输出）。
- README.md / README.en.md：用量统计节补一句「整页可上下滚动」；测试计数同步。
- CHANGELOG.md `[Unreleased]` 加 013 条目（Fixed：整页无滚动条、unknown 模型归属）。
- specs/006-usage-stats/INTERFACE.md 的「根节点无高度」相关描述若与本契约冲突，加 013 收窄注记（不改历史结论）。
- 本文件 §6 写实施记录：门禁计数、偏差清单、真实重建数据、可失败性实证。

## 6 实施记录（2026-11-14）

### 6.1 门禁（最后一次编辑之后实跑，`D:/Node/node.exe`，TEMP/TMP=`C:/Users/OMEN/.dsh/tmp/quota-check-temp`）

| 套件 | 013 前 | 现在 | 净增 |
| --- | --- | --- | --- |
| `test/host.mjs` | 855 | 887 | +32（T201–T205） |
| `test/client.mjs` | 885 | 918 | +33（T101–T103：7 + 12 + 14） |
| `test/guards.mjs` | 384 | 413 | +29（第 013 块） |

全部 `0 failed`；`check-manifest` OK（0.5.0、出站主机 8）；`check-docs` OK（配置键 25、数据源 8、计数 887/918/413 与 README 一致）；`check-refs` OK；`check-submission` OK（category=usage）。

### 6.2 T301 真机探针（demo 实例 3099，真实会话日志 246 份 / 282.8 MB）

打开用量屏后逐项量测（CDP，1280×860 DPR1；窄屏用 `Emulation.setDeviceMetricsOverride` 在同一页面改视口）：

| 视口 | `.tpq-usage-viewport` | 文档横向 | 模型卡内滚 | 图表横滚 |
| --- | --- | --- | --- | --- |
| 1280×860 | 高 860 / 内容 1188，可滚 | 无（sw=cw=1280） | 237/237（本次仅 4 个模型，未溢出） | 无 |
| 375×812 | 高 764 / 内容 1420，可滚 | 无（sw=cw=375） | 252/307，内滚仍在 | 无 |
| 320×812 | 高 764 / 内容 1505，可滚 | 无（sw=cw=320） | 252/307，内滚仍在 | 无 |

- 滚到底：`scrollTop=328`（= 1188 − 860），最后一条脚注 bottom=783、底栏 bottom=828，均 ≤ 视口底 860 ⇒ 内容不再被裁。
- 计算样式：`overflow-y:auto`、`overflow-x:hidden`、`overscroll-behavior:contain`、`scrollbar-width:thin`、`height:860px`（= 宿主 main 座位高）。
- 键盘：视口 `focus()` 后 `activeElement === viewport`；PageDown 让 `scrollTop` 0→309，End→307（600 ms 采样，仍在平滑滚动中，上限 328）。
- 钩子齐备：`data-usage-scroll="1"`、`role="region"`、`tabindex="0"`、`aria-label="Token 计划用量"`。

### 6.3 T302 真实日志重建（v1 → v2）

重建前把旧 v1 索引保留在 demo home，触发首轮同步后：

- 旧文件按坏文件策略备份为 `token-plan-quota.usage-index.json.bad-1794650097526`（74,542 B，原样）。
- 新索引 `version=2`、`sessions=221`、`stats={"unknownModel":0,"skippedOld":0}`；抽查条目带 `lastProvider/lastModel`（如 `qwen-token-plan-cn` / `qwen3.8-flash`）。
- 与 v1 逐模型对比（同一 72 天窗口）：

| 模型 | v1 tokens | v2 tokens | 变化 |
| --- | --- | --- | --- |
| unknown/unknown | 291,524,117 | 0 | **−291.5 M（归零）** |
| modlens-qwen-token-plan-cn/deepseek-v4.1-flash-1017 | 268,621,260 | 426,572,829 | +158.0 M |
| qwen-token-plan-cn/deepseek-v4.1-flash-1017 | 901,553,131 | 1,032,696,947 | +131.1 M |
| qwen-token-plan-cn/qwen3.8-flash | 4,033,969,324 | 4,052,336,490 | +18.4 M |
| 其余 10 个模型 | — | 不变 | 0 |

  291.5 M 的 unknown 被拆到 `modlens-qwen-token-plan-cn/deepseek-v4.1-flash-1017`（带视觉桥的那条）与 `qwen-token-plan-cn/deepseek-v4.1-flash-1017`；差额 15.9 M 来自这一轮新同步到的增量会话。
- 运行态 `GET /token-plan-quota/usage?days=365`：`coverage.unknownModel=0`，`models` 13 条，最大 `qwen-token-plan-cn/qwen3.8-flash` 4.05 B tokens；无 `unknown` 条目、无 %、无 Credits。

### 6.4 偏差清单

1. **不写 `scrollbar-gutter`**（契约要求）：经典滚动条占 10 px 布局宽，920 px 居中列左移 5 px（innerLeft 180→175，列宽不变）。接受，已写进 CHANGELOG 与源码注释。
2. `overscroll-behavior:contain` 写在视口上（按契约字面）；真正阻断「模型列表滚到边界带动整页」的是 012 给 `.tpq-usage-models` 加的 contain，两者同时存在、行为正确。
3. `height:100%` 在宿主座位不是定高时退化为内容高（不滚不裁，与改动前等价）；契约未规定该降级，已写进源码注释。
4. 模型列表在 1280×860 且模型很少时不出现内滚（237/237）—— 只在窄屏或模型多时内滚（375/320 为 252/307）；这不是回归。

### 6.5 可失败性实证

- 删掉 `lib/usage-stats.js` 两处 `modelDefaults: inheritedModelDefaults(previous)` → host `878 passed, 9 failed`。
- 把 `data-usage-models-scroll` 改成 `"0"` / 在 `usageSplitCell` 里插 `"%"` / zh `usageSplitInput` 退回 `"input"` → guards 各 `359/1` 红（012 轮次记录，第 013 块同源矩阵）。
- 013 新增块：把 `wrongVersion.version` 改回 2 → 「version 不是 2 报错」断言红；删 `.tpq-usage-viewport` 的 `overflow-y:auto` → CSS 断言红。

### 6.6 未做/留给后续

- 截图未重拍：`make-shots` 启动参数带 `--hide-scrollbars`，页面滚动条不会出现在图里；013 的画面内容与 012 一致（只多了滚动条），已有 8 张图仍然准确。
- 真实 GUI（非 headless）里的滚动条外观未截图核对，仅以计算样式与几何断言为准。

