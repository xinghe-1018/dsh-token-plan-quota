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

**本流水线的出站**：查看器模板会请求 `fonts.googleapis.com` 与 `fonts.gstatic.com`（三枚 CDN 字体），
请求由 **Edge 子进程**发起，Node 侧只连 `127.0.0.1`。这两个主机**刻意不写进**
`dshhub.permissions.network`：那个字段声明的是**插件运行时**的出站集合，而本目录与渲染出的 HTML
都不随包发布。依据（004 的 Lens 2 独立取证）：枚举 `lib/` 里全部 `https://` 字面量 = 8 项，
与声明的 8 条**逐项相等**；`npm pack` 清单里没有任何 `diagrams/` 路径。

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

**自证是硬要求**：读回空矩形、图被视口裁掉、`<text>` 少于 8 个、产物小于 60 KB、大于 400 KB，
一律非零退出且**不落盘**——空数据不许伪装成结论。

两道内容门都是**实测校准**过的，不是拍的（004 的 Lens 1 在真实 Chromium 上量过）：

| 门 | 阈值 | 依据 |
|---|---|---|
| 体积下限 | 60,000 B | 同一裁剪区：纯白 13,198 B、只剩背景的"真·白图"19,304 B、入库真图 186,019 B ⇒ 对两端各留 3.1× 余量 |
| `<text>` 数量下限 | 8 个 | 体积挡不住"截到了别的元素 / 标签全丢"（Lens 1 注入第二个同选择器 SVG 后产物 96,856 B 照样过关）；真图实测 49 个 |

**这两道门证明的是"有内容、是张渲染出来的图"，不是"内容正确"**：位图的语义正确性无法机械化
（它是已知盲点），真正的核对是读图 + 与 `lib/` 逐条对照。若图将来确实变简单而低于阈值，
**按新基线重新校准常量**，不要直接删掉门。

## 产出记录（当前入库的这份）

| 项 | 值 |
|---|---|
| 命令 | `node diagrams/make-diagram-png.mjs --html <rendered>.html`（默认参数） |
| 尺寸 / 字节 | 2676×1336 px（2×） / 186019 B |
| 位图 sha256 | `b8cae2aab32c1ada44d01a16ecb753661e97ac4a9d851273f75c1bbaea877070` |
| 源规格 sha256 | `8615756dc15cfa113c942143ab426d4b7dba069c41c5cbb796fcfa5b68e22ecd`（4552 B） |
| 确定性 | 连续两次独立运行**逐字节相同**；004 的 Lens 1 又从**新交付**的 HTML 重出一次，仍是同一 sha256。前提：**字体可得性相同**（本机 CDN 字体取不到，两次都回落系统字体栈；若一次拿到 webfont、一次没拿到，光栅会变）。同一 Chromium 构建下确定，换版本可能变 |

源规格的哈希与当时 `archify deliver` 回执里记的规格哈希一致——也就是说仓库里这份规格
就是产出那张图的那份字节，不是"看起来差不多"的另一版。

## 图里有什么、没有什么

- **有**：三块边界（浏览器 · Web GUI / DSH 宿主进程 / 上游供应商）、10 个节点、9 条关系及标签、图例。
- **没有**：查看器里那三张结论卡（取数与口径 / 凭据边界 / 工程门禁）。它们是 SVG 之外的 HTML，
  不进位图；同样的口径 README 正文里已经写着，图里不重复。
- **也没有**：浏览器半边那三枚 CDN 字体 link（`cdn.jsdelivr.net`，`lib/client.js` 的运行时外部资源）。
  图里的"上游供应商"边界**按额度端点划**，而字体不是额度源——这是有意的范围决定，不是漏画
  （004 的 Lens 1 点出过这处省略，这里写明）。

## 漂移约束（重要）

位图**无法被机械检查核内容**：`npm run check` 只能证明它存在、非空字节、且两份 README 都引到了它，
证明不了"图上画的东西代码里还在"。所以：

- **改运行时行为时必须复核此图**，并在同一次改动里重新生成它：新增/删除供应商、改只读接口面、
  改半边划分、改凭据边界，都算。否则 README 会长期挂着一张"代码里已经没有的东西"。
- 图上每个节点与每条关系都要能指到代码里的出处（`lib/index.js` 的源目录、`lib/detect.js`、
  只读路由面、`lib/client.js`）。画不出来的能力，就是没有的能力。