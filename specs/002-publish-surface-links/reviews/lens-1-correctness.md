# Lens 1 — 正确性与健壮性（只读评审）

**对象**：`5921a07`（实现）+ `fa9ae88`（勾选工件）· 分支 `002-publish-surface-links`
**范围**：只执行 `workflow/REVIEW-CHECKLIST.md` 的 "Lens 1" 一节。本次改动 = 5 个相对链接改绝对链接 + 新增 check-docs 4b。
**评审方式**：只读。唯一写入是本报告。**没有**改 README、没有 `git add/commit/checkout`、没有临时还原文件
（可证伪性用"从 `scripts/check-docs.mjs` 里**按字节切出** 4b 代码块 + `git show 5921a07^:README.md`
把修复前文本喂进去"的等价方式复现，工作树零改动）。

---

## 结论

**修复本身通过**（改写正确、当前 0 违规、可证伪性为真、包仍 24 files）；**新检查 4b 有 8 条健壮性/覆盖缺陷**，
最高严重度 **MEDIUM**。缺陷全部是"将来某次 README 编辑会漏检/误报"，**当前仓库没有一条现存违规**。

---

## 发现

### [MEDIUM] `scripts/check-docs.mjs:77` — 4b 与第 4 项用了**两个不同的抽取正则**，三种惯用链接形态对 4b 完全隐形

4b 用 `/!?\[[^\]]*\]\(([^)\s]+)\)/g`（要求目标无空白**且紧跟 `)`**），第 4 项用 `/\]\((?!https?:|#|mailto:)([^)#\s]+)/g`。
实测（把 4b 代码块原样切片执行）：

| 写法 | 4b | 第 4 项 |
|---|---|---|
| `[a][r]` + `[r]: ROADMAP.md`（引用式） | pass **漏检** | pass（也不看） |
| `[a](ROADMAP.md "Roadmap")`（带 title） | pass **漏检** | pass（存在，放行） |
| `<a href="ROADMAP.md">`（HTML） | pass **漏检** | pass（也不看） |

**后果**：这次修掉的 bug 类（相对链接指向非发布文件 → 包页 404）可以用这三种植入回来而 `npm run check` 全绿——
其中"带 title"一例连第 4 项也放行（目标在仓库内存在），两道检查同时失明。
（`plan.md` §5 声称"链接抽取沿用第 4 项那段的写法（同一 `](…)` 正则）"，实现并非如此；这正是漏检的结构性原因。）

### [MEDIUM] `scripts/check-docs.mjs:78` — 图片排除只看 `m[0].startsWith('!')`，徽标惯用式 `[![alt](img.png)](url)` 既误报又漏检

实测 `[![status](assets/b.svg)](https://ci.example.com)`：4b 抽出的是**内层图片** `assets/b.svg`（外层匹配文本以 `[` 开头，不是 `!`），
报 `链接目标不随包发布：assets/b.svg`；而真正的外层链接目标从未被 4b 看见。

**后果**：任何"图片包在链接里"的 shields 徽标会让 CI 红在一个**已发布/无关**的图片路径上（误报），
同时把真正的相对链接目标放过去（漏检）——两个方向都错，而且报错指名的对象是用户没写错的那个。

### [MEDIUM] `scripts/check-docs.mjs:75` — 发布面被建模成 `files` 数组**字面值**，而 npm 的发布面 ≠ `files`

`npm pack --dry-run --json` 实测：tarball 的 24 条里有 `package.json`，而 `package.json#files` 只列
`lib / docs / cordis.patch.yml / README.md / README.en.md / CHANGELOG.md / LICENSE`——**npm 总是附带 package.json**
（同理 README*、LICENSE*、`main` 指向的文件）。另外 npm 的 `files` 支持 glob/否定项。

实测：`[a](package.json)` → 4b **报红**"不随包发布"，而它明明在包里；模拟 `files: ["docs/**/*.md"]` 或 `["!docs/internal"]`
时，`[a](docs/upstream-contracts.md)` 也一律报红。

**后果**：一个指向真实随包发布文件的相对链接会被判违规，给出的建议（"改成绝对链接，或加进 package.json#files"）
在这个方向上都是错的——把 `package.json` 加进 `files` 是谎报，改成绝对链接是白改。

### [LOW] `scripts/check-docs.mjs:74` — `files` 缺失被 `?? []` 吞掉："manifest 少了字段"变成"所有相对链接都违规"

实测（`package.json` 无 `files` 键）：4b 对当前两份 README 报 **10 条**，包含自相矛盾的一条
`README.md 的链接目标不随包发布：README.md`（README.md 本来就在 whitelist 里、npm 也必然发布）。不会崩，但方向错。

**后果**：真正的病根（`files` 被误删/改名，或改用 `.npmignore`）不会出现在报错里，维护者看到的是 10 条"你该改链接"，
按建议改会把本来可用的相对链接全部绝对化——**假红的代价是让人改坏正确的东西**。仓库对"不假红"已有先例（第 7 项宁出声跳过）。

### [LOW] `scripts/check-docs.mjs:82` — 目标归一化只处理 `#fragment` 与开头 `./`：`?query` 与 `<...>` 目标会误报

实测：`[a](LICENSE?raw=1)` → 报红（`LICENSE` 是文件型 whitelist 条目，`LICENSE?raw=1` ≠ `LICENSE`）；
`[a](<ROADMAP.md>)`（CommonMark 合法的尖括号包裹目标）→ 报红 `链接目标不随包发布：<ROADMAP.md>`，而这条建议**无法执行**
（你没法把含尖括号的字符串加进 `files`，也不该为此改成绝对链接）。
（注：`docs/upstream-contracts.md?raw=1` 侥幸通过，只因为 `docs` 是目录型条目、前缀匹配恰好成立——不是归一化在起作用。）

**后果**：报红对象是干净的链接，且给出的两条处置建议都通向错误修法。

### [LOW] `scripts/check-docs.mjs:75` — 前缀规则挡住了 `lib`→`library.md`，但放过了 `docs/../ROADMAP.md`

前缀实测：whitelist 含 `lib` 时 `library.md`/`libx/y.md`/`docsomething.md` 均 `published=false`（`f + '/'` 这一步做对了）；
`lib/index.js`、`docs/a/b.md` 为 `true`（目录展开正确）。反例在另一侧：`[a](docs/../ROADMAP.md)` 与 `[a](docs/./../ROADMAP.md)`
**4b 与第 4 项都 pass**（4b 命中 `docs/` 前缀；第 4 项的 `existsSync` 会把 `..` 归一化掉）。

**后果**：一条在包页/GitHub 上都会 404（解析后落回不随包发布的 `ROADMAP.md`）的链接，能同时骗过检验存在性的第 4 项和新增的发布面检查。

### [LOW] `scripts/check-docs.mjs:73` — 注释把图片推给第 10 项，但第 10 项**不查发布面**（没接住）

第 10 项（`:296`–`:314`）对图片只做 `existsSync` + 字节数 + 引用计数，**没有** `files` 白名单判断。
实测：`![alt](assets/demo.png)` 在 4b 被排除（`pass`），第 10 项只会在文件不存在时红。

**后果**：README 里一张放在 `files` 之外（例如 `.github/` 或仓库根）的图，在仓库里正常、在包页上是裂图，而 `npm run check` 全绿——
正是这次要堵的同一类洞，只是被"交给第 10 项"这句话挡住了视线。当前 13 张图都在已发布的 `docs/` 下，故无现存实例。

### [LOW] `scripts/check-docs.mjs:77` — 代码围栏里的示例链接被当成真链接

实测：```` ```md\n[a](ROADMAP.md)\n``` ```` → 4b **报红**（第 4 项不红，因为目标在仓库内存在）。

**后果**：将来在 README 的"检查项说明"里举一个链接示例（哪怕只在文档里演示），CI 就会红在示例文本上——
这是本次改动**新引入**的假红面（第 4 项只在文件不存在时才红）。

---

## 已核验但不构成发现（含构造的反例与实测结果）

1. **改写正确性（10 处绝对 URL）——全部正确**。逐条比对 pre/post 的 `(标签, 目标)` 对：两份 README 各 5 处，
   标签与顺序完全不变，图片引用数不变（zh 7 / en 6），`--numstat` 为 `5 5 README.en.md` / `5 5 README.md`（正好 5 行替换，无附带改动）。
   5 个 URL 均为 `https://github.com/xinghe-1018/dsh-token-plan-quota/blob/main/<path>`：owner/repo 与
   `package.json#repository.url`（`git+https://github.com/xinghe-1018/dsh-token-plan-quota.git`）一致；
   `git ls-remote --symref origin HEAD` → `ref: refs/heads/main HEAD`（默认分支确为 `main`，非 master）；
   5 个目标在 `main` 上均存在（`git cat-file -e main:<path>` 逐个为真）；未改到图片、无多改、无漏改（4b 对当前两份 README 报 0 条）。
2. **考卷覆盖面：路径拼写**。`scripts/shots/README.md`（大小写、子目录层级）在 whitelist 外但在仓库内存在 → 属于本次该改的 5 个之一，已改。
3. **`./x.md`** → `replace(/^\.\//,'')` 生效，实测 pass（`[a](./LICENSE)`）。
4. **`x.md#anchor`** → `split('#')[0]` 生效，实测 pass（`[a](LICENSE#top)`、`[a](README.md#top)`）。
5. **大写路径 `DOCS/...`** → 4b 报红；**这不是误报**：npm/GitHub 上都按大小写精确解析，链接确实死。
   注意与第 4 项的反差（Windows 的 `existsSync` 大小写不敏感 → 第 4 项放行）；4b 更严格且更正确，**记录为已核验**。
6. **反斜杠路径** → 4b 报红；同样不是误报（web 渲染器不解析 `\`）。
7. **纯图片引用** `![alt](assets/demo.png)` → 4b 正确排除（`pass`，误报面问题见发现 #2 的嵌套形态）。
8. **放行项**：`https://…` / `mailto:` / `#anchor` / 空目标 `[]()` / 已发布相对链接（`LICENSE`、`CHANGELOG.md`、`cordis.patch.yml`、`lib/index.js`、`docs`、`docs/adding-a-provider.md`）实测全部 pass。
9. **目录条目展开**：`docs` 覆盖 `docs/a/b.md`（实测 `published=true`），符合 npm 递归发布目录的语义（`npm pack` 清单里 `docs/images/en/*.png` 与 `docs/*.md` 均在包内）。
10. **`lib` 前缀误判不存在**：`library.md` / `libx/y.md` 均 `published=false`（`f.replace(/\/$/,'') + '/'` 起了作用）。
11. **可证伪性（提问 #6）——复现成功，与提交信息的声称一致**：把 `scripts/check-docs.mjs` 第 74–88 行**原文切片**注入执行环境，
    喂入 `git show 5921a07^:README.md` / `README.en.md`（修复前文本）+ 当前 `files`（实测 pre-fix `files` 与当前逐字节相同），
    得到 **exit 语义等价的红：10 条**，逐条指名 `ROADMAP.md`、`scripts/shots/README.md`、`SECURITY.md`、`CONTRIBUTING.md`、`RELEASE.md`
    各 ×2 份 README ——与 `tasks.md` Phase 3 标题的"逐条指名 10 处违规"完全对上；同一代码块喂当前 README 报 **0 条**。
    （未采用"临时还原 README"路径，故不需要备份/恢复，工作树自始至终无改动。）
12. **`npm pack` 仍 24 files**：`entryCount: 24`，与 `FR-004/SC-003` 一致（顺带看到 `package.json` 在包内却不在 `files`——见发现 #3）。
13. **重复 `JSON.parse(read('package.json'))`**（`:74` 与 `:32` 的 `pkg`）：同源同文本，无行为差异；仅冗余，不计为发现。
14. **检查范围只覆盖两份 README**（`docs/*.md` 自身的相对链接未巡检）：`plan.md` §2 明确列为非目标，且 README 引用的
    `docs/upstream-contracts.md`、`docs/adding-a-provider.md` 均在已发布目录内；按"计划内的范围取舍"处理，不计为 Lens 1 发现。
15. **第 4 项与 4b 的功能分工**：4b **不会**取代第 4 项。4b 漏掉的目标若不在仓库内（`docs/nope.md`）由第 4 项红（实测），
    两者是"存在性"与"发布面"两层；本报告只针对 4b 未覆盖的**交集**（存在但不发布）。

---

## 未核实项（诚实声明）

- "npm 包页只渲染包内文件、不把相对链接重写成 GitHub blob"是本次改动的前提。本机 `web_fetch` 对 `github.com` /
  `api.github.com` 均返回 `resolves to a non-public IP address`（网络受限），**无法联网确认 npmjs.com 的链接重写行为**；
  spec 引用的是仓库自身 `RELEASE.md` 的既往实证，我未独立复核。本报告的结论**不依赖**该前提（无现存违规、可证伪性成立与否
  与前提真假无关）。
- 工作树状态说明：评审开始时的 `git status --porcelain` 为空（干净）；会话中途出现一个**非本 lens 产生的**未跟踪文件
  `specs/002-publish-surface-links/qa-report.md`（`CreationTime 2026/9/18 14:55:07`，本 lens 只创建了 `reviews/` 目录并写本报告）。
  按硬性规则，本 lens 未对它做任何修改。