# diagrams

本目录是 README 那张**结构总览图**的源规格与生成方式。产物在 `docs/images/architecture.png`
（随 npm 包发布，两份 README 都引用它）；**本目录不随包发布**。

## 文件

| 文件 | 作用 |
|---|---|
| `dsh-token-plan-quota.architecture.json` | Archify `architecture` 规格——图的**唯一可编辑真源** |
| `make-diagram-png.mjs` | 从已渲染的 HTML 裁出位图；复用 `scripts/shots/cdp.mjs` 的 CDP 客户端 |
| `README.md` | 本文件 |

## 前置（两个都在仓库之外，所以这条流水线**不进 CI**）

1. **Archify 技能**（内含 `bin/archify.mjs`）：渲染规格用它。仓库零第三方依赖，
   不会也不能把它写成依赖（宪法原则 IV）。
2. **Chromium 系浏览器**：`scripts/shots/cdp.mjs` 先找 Microsoft Edge（本机实测无 Chrome、有 Edge）。
   换别的浏览器用 `--edge <路径>`——Chrome 走同一套 CDP。

## 再生成

```bash
# 1) 校验规格：showcase 档 9 项检查必须全过、0 error / 0 warning
node <archify>/bin/archify.mjs validate architecture \
  diagrams/dsh-token-plan-quota.architecture.json --quality showcase --json

# 2) 渲染成交互式 HTML。这份 HTML 进的是临时目录，**不进仓库**：
#    它是生成器的输出（600 KB 的查看器应用），不是文档资产。
node <archify>/bin/archify.mjs deliver architecture \
  diagrams/dsh-token-plan-quota.architecture.json <临时目录>/architecture.html --quality showcase --json

# 3) 从 HTML 裁出位图（默认写 docs/images/architecture.png，视口 1600x1000、倍率 2）
node diagrams/make-diagram-png.mjs --html <临时目录>/architecture.html
```

第 3 步做的事，顺序不能省：等 SVG 出现 → **重载一次**（`Target.createTarget` 会立刻开始加载，
而设备度量是附着之后才覆盖的；查看器按**窗口**尺寸算过一次面板大小就不再看后续变化，
于是一次都不重载会随启动窗口漂——实测同一视口下裁到 w=1192 与 w=1338 两个值）→
校验 SVG 完整落在视口内 → 按倍率裁 → 自证（PNG 签名 / IHDR 尺寸 / 体积上下限）。

**自证是硬要求**：读回空矩形、图被视口裁掉、产物小于 20 KB（多半是白图）、大于 400 KB，
一律非零退出且**不落盘**——空数据不许伪装成结论。

## 产出记录（当前入库的这份）

| 项 | 值 |
|---|---|
| 命令 | `node diagrams/make-diagram-png.mjs --html <rendered>.html`（默认参数） |
| 尺寸 / 字节 | 2676×1336 px（2×） / 186019 B |
| 位图 sha256 | `b8cae2aab32c1ada44d01a16ecb753661e97ac4a9d851273f75c1bbaea877070` |
| 源规格 sha256 | `8615756dc15cfa113c942143ab426d4b7dba069c41c5cbb796fcfa5b68e22ecd`（4552 B） |
| 确定性 | 连续两次独立运行**逐字节相同**（同一 Chromium 构建下位图是确定的；换版本可能变） |

源规格的哈希与当时 `archify deliver` 回执里记的规格哈希一致——也就是说仓库里这份规格
就是产出那张图的那份字节，不是"看起来差不多"的另一版。

## 图里有什么、没有什么

- **有**：三块边界（浏览器 · Web GUI / DSH 宿主进程 / 上游供应商）、10 个节点、9 条关系及标签、图例。
- **没有**：查看器里那三张结论卡（取数与口径 / 凭据边界 / 工程门禁）。它们是 SVG 之外的 HTML，
  不进位图；同样的口径 README 正文里已经写着，图里不重复。

## 漂移约束（重要）

位图**无法被机械检查核内容**：`npm run check` 只能证明它存在、非空字节、且两份 README 都引到了它，
证明不了"图上画的东西代码里还在"。所以：

- **改运行时行为时必须复核此图**，并在同一次改动里重新生成它：新增/删除供应商、改只读接口面、
  改半边划分、改凭据边界，都算。否则 README 会长期挂着一张"代码里已经没有的东西"。
- 图上每个节点与每条关系都要能指到代码里的出处（`lib/index.js` 的源目录、`lib/detect.js`、
  只读路由面、`lib/client.js`）。画不出来的能力，就是没有的能力。