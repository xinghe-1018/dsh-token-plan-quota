# 003 Lens 2 — 安全与信任边界

评审提交：**82b6561**（HEAD，分支 `003-guardrails-and-doc-hygiene`；`git status --porcelain` 为空，工作树未动）。验证方式：只读复现——`git show/diff 82b6561^..82b6561`、**从 `check-docs.mjs` 原样抽出 `normalizeTarget`/`classifyTarget`/`extractLinkTargets` 后跑行为矩阵**、`import` 真实 `findLineRefs` 跑极端输入计时、在 `$env:TEMP` 造 junction/symlink 验证枚举跟随。临时文件全在 TEMP，仓库内零写。基线三连（评审时实跑）：`test/guards.mjs` → `32 passed, 0 failed`；`check-refs.mjs` → `OK（19 个活文档）`；`check-docs.mjs` → `OK（配置键 17、数据源 8、出站主机 8、host 379 / client 207）`。

**无 HIGH。** 8 项重点逐条回答；发现 9 条，其中 3 条 MEDIUM（1 条属既存），无轻率场景的一律 LOW。

---

## 发现

### [MEDIUM] scripts/check-docs.mjs:95-96 — `classifyTarget` 的 escape 判定漏掉 `target === '..'` 与反斜杠形态，`existsSync(join(root,target))` 仍能探仓库外（本次部分收紧，有残留）

复核（实跑真实函数，非改写）：`normalizeTarget('..')` = `'..'` → `startsWith('../')` 为 **false** → `kind='relative'` → `join(root,'..')` = `C:\Users\OMEN\.dsh\plugins`，`existsSync` **true** → 不产生 problem；`normalizeTarget('a/../..')` 也归 `'..'`（同样漏）。反斜杠形态 `'..\..\..\..\..\Windows\win.ini'` 经 `posix.normalize` **原样保留**（posix 不认 `\`），判 `relative`，但 Windows 的 `join` 把它当分隔符 → `C:\Windows\win.ini`，`existsSync` **true** → 静默放行。对照：`'../x'`、`'../../x/../y'`、`'/abs/path'` 都正确判 escape。

**失败场景**：README 里写一行 `![x](..\..\..\..\..\Windows\win.ini)`（或简到 `[x](..)`）→ 检查把它当"仓库内相对路径"并 `existsSync` 探仓库外：文件存在则**全绿**、不存在才报"目标不存在"——绿/红的差别本身就是"某仓库外文件是否存在"的神谕，而 104-105 行注释声称"顺带关掉'用存在性探测仓库外路径'那个面"。`/` 形态本次确实被关掉，`\` 与裸 `..` 是残留。

### [MEDIUM] scripts/check-docs.mjs:363 — 第 10 项仍对 README 的图片目标原样 `existsSync(join(root, ref))`，未过 `classifyTarget`（**既存**，本次未动）

复核：`git show 82b6561^:scripts/check-docs.mjs | Select-String '引用的图片不存在'` 命中同一行 → 早于本次提交存在；diff 未触第 10 项。`join(root,'../../../../../Windows/win.ini')` = `C:\Windows\win.ini`，`existsSync` **true** → 该条静默、不打印。

**失败场景**：`![x](../../../../../Windows/win.ini)` 在第 4 项报 escape（红），但第 10 项只在目标**不存在**时给出另一条信息 → 两条信息组合仍可判定仓库外文件的存在性；且它对 `/` 形态也照探，新 escape 分支管不到。本次宣称的收口（第 104 行）不完整。

### [MEDIUM] scripts/check-refs.mjs:43 — 新增的 `REF_PATTERNS[0]` 在"长点号 token"上二次方回溯：160 KB 需 41 秒（本次引入）

实测（真实 `findLineRefs`，输入 `'a.'.repeat(n)`）：10k→654 ms、20k→2624 ms、40k→10380 ms、80k→41213 ms（**每翻倍 ×4**，Θ(n²)）。成因：`\b[\w./-]+\.(?:md|mjs|…):\d+` 的字符类本身含 `.` 又紧跟字面 `\.`，且 `\b` 在每个 `a` 处成立 → 每个起点都要回退扫描。不是指数级（非灾难性回溯），但对门禁是实打实的 DoS。当前仓库最大文档 49 KB（ROADMAP.md），真 README/file 实测 1.0 ms，**今天不触发**。

**失败场景**：agent 生成的 spec/workflow 文档里粘进一段 160 KB 单行点号文本（压缩 JS、长清单）→ 本地 pre-commit 的 `npm run check` 卡 40 秒以上（1 MB 量级外推分钟级），CI 同步（无超时）。

### [MEDIUM] scripts/check-docs.mjs:75,78 — `extractLinkTargets` 两条内联链接正则在连续 `[` / `![` 上二次方（正则为**既存**，本次从 4b 提升为两个消费者共用）

实测：`'['*n` → 10k 41 ms / 20k 160 / 40k 586 / 80k 2682；`'!['*n` → 10k 618 / 20k 2412 / 40k 9648；`'['*n+']'*n` → 100/413/1656 ms（均 ×4/翻倍）。对照：`'[a](x)'*20000` = 4.6 ms、真 README = 1.0 ms、反引号/`-`/围栏输入均 <1 ms。

**失败场景**：README（agent 可写）出现一行 100 KB 的 `[` 或 `![` → 单次检查 5–10 秒；配合 F3，门禁可被文档内容拖死。

### [MEDIUM] scripts/check-refs.mjs:74 — `readdirSync(dir,{recursive:true})` 会跟随 junction/symlink，新枚举面可越出仓库并读仓库外 `.md`（本次引入的新访问面）

实测（TEMP，非仓库）：`loop/a/real.md` + junction `loop/a/self -> loop` → `readdirSync(loop,{recursive:true})` 返回 **192 条**（含 `a\self\a\self\…`），3 条真实条目被展开到路径长度上限才停 → 它**下钻了 reparse point**。另实测 `readFileSync` 跟随文件 symlink（`alias.md -> C:\Windows\win.ini`，读出 92 字节）。仓库当前无任何 reparse point（`Get-ChildItem -Recurse -Attributes ReparsePoint` 无输出）。

**失败场景**：`specs/vendor -> ..\..\某目录`（Windows junction 不需要管理员）或符号链接环 → 新门禁把仓库外 `.md` 枚举进来并读入，违规以 `specs/vendor/...` 的假路径报出；环把枚举放大（本机被 MAX_PATH 截停于 192 条）。POSIX 侧 Node 对 symlink 的 `Dirent.isDirectory()` 为 false，**推断**不会下钻，但本机无 POSIX 环境（WSL 不可用）→ **未能确认**。

### [LOW] scripts/check-docs.mjs:95,106 — 协议相对链接 `//host/path` 被判 escape，合法对外链接假红

复核（矩阵）：`'//example.com/x'` → `posix.normalize` 收敛为 `/example.com/x` → `kind='escape'` → 106 行**无条件** `problems.push`。绝对 URL、`mailto:`、`#frag`、`data:`、`C:/…`（被 scheme 正则吃掉）全部 `skip`，不假红。

**失败场景**：README 写 `[docs](//example.com/x)`（协议相对是合法外部链接写法）→ CI 假红。

### [LOW] scripts/shots/fixture.mjs:391-396 — 失败标签打印命中叶值：实测**无真实凭据路径**，但守卫覆盖面同时变窄（不再扫对象 key）

复核：`assertFixture` 的全部调用点是 `make-shots.mjs:177` 与 `check-docs.mjs:371`，输入一律 `makeSnapshot()`（合成）；`BANNED_TRACES`（352 行）本身就是仓库常量，禁用串在旧标签里也已被 `JSON.stringify(banned)` 打印过，故新增的"命中叶值"不是新泄漏。**但**旧实现 `JSON.stringify(snapshot).includes(banned)` 覆盖对象 key，新 `collectLeaves`（362-367）只收 value → `{'OMEN': 1}` 这类 key 内的痕迹不再报红。

**失败场景**：CI 上 `ci-run.sh` 把失败输出前 40 行以 `::error::` 公开发布，落到那里的只会是合成 payload（且其来源已提交在仓库里）→ 不构成凭据外泄；覆盖收窄的实际影响接近零（截图渲染的是 value，key 有 `publicCard` 白名单兜底）。

### [LOW] scripts/check-refs.mjs:78 — `reviews/` 豁免范围比 spec 宽（`workflow/**/reviews/**` 与任意嵌套 `reviews/` 都被跳过）

复核：实现为 `startsWith('reviews/') || includes('/reviews/')`；spec.md:30 只豁免 `specs/**/reviews/`。

**失败场景**：把文档放进 `workflow/x/reviews/y.md` 即永久躲过行号门禁。

### [LOW] .githooks/pre-commit:13 — 钩子执行工作树里的 `npm run check`（仓库可控脚本），且**本克隆已启用**

复核：`git config --show-origin --get core.hooksPath` → `file:.git/config .githooks`（本地已启用；plan.md 前提 6 当时为空，现已不成立）；`package.json:80` 的 check 链即仓库内容。

**失败场景**：任何改 `package.json#scripts.check` 的提交都会在**本机提交时**执行那段脚本——这是所有 npm 钩子的固有权限面；本插件零依赖、`npm run check` 不联网不读凭据（`fixture.mjs` 只 import `node:fs/url/path`），故**没有新增权限面**，但"默认不启用"在当前克隆已不成立，`git commit --no-verify` 已在 Hook 注释与 CONTRIBUTING 记录。

### [LOW] .github/workflows/ci.yml:57-62 — 新增两道门禁只挂在 ubuntu 的 manifest job，Windows 专属行为无 CI 覆盖

**失败场景**：F1（`\` 形态 escape 漏判）与 F5（junction 下钻）都是 Windows-only 差异，CI 上永远看不到——本地 `npm run check` 是唯一会命中的路径。

---

## 逐条回答（含验证为否的部分）

1. **新文件系统面的路径穿越/越权读取**：仓库内无穿越（`readdirSync` 只回名字，`specs/`+`workflow/`+`ROADMAP.md`，非 `.md` 一律跳过；`.env*`/`.credentials.yaml` 不在目录内且不以 `.md` 结尾）。**无限递归/软链接跟随已确认存在**（F5）。无符号链接环时的枚举是线性的，仓库现无 reparse point。
2. **`classifyTarget` 可靠性**：`../../x`、`../x`、`/abs`、`//host`（收敛后 `/host`）、`a/../..` 的实测归属见 F1；`%2e%2e`/`%2f` **不做 URL 解码**（`posix.normalize('%2e%2e/x')` 原样）→ 不构成穿越，只会误报"不存在"；Windows 盘符 `C:\…`/`C:/…` 被 scheme 正则判 `skip`（不探测，也不报 escape）。**结论：本次对 `/` 形态确实收紧（旧第 4 项对 `../../x` 直接 `join`+`existsSync`），但 `..` 与 `\` 形态仍有残留（F1），第 10 项完全未收（F2）。**
3. **正则安全**：无指数级灾难性回溯；但有**两处二次方**（F3 新增、F4 既存），极端输入实测数据见上。围栏剥离 ` ```[\s\S]*?``` `（含无闭合围栏 + 50k 行正文）实测 ≤13 ms，不构成风险；`normalizeTarget` 的 title 正则（`\s+"[^"]*"$`）在 10 万字符无闭合引号下 2.9–10.6 ms，安全。`^…$` with `m` 的引用式定义正则逐行锚定，`'[a]: '+100k` = 0.5 ms，安全。
4. **失败消息泄露**：实测**不泄露**——`assertFixture` 的输入只可能是 `makeSnapshot()` 合成快照，禁用串本身是仓库常量；`check-refs.mjs` 打印的是**匹配子串**（`[\w./-]+\.(ext):\d+`，不含换行/`%`/`=`，装不下密钥）与仓库相对路径；`test/guards.mjs` 打印用例 label 与 `error.message`（同上）。守卫覆盖面收窄见 F7。
5. **第 4 项新增"指向仓库外即报错"的假红**：绝对 URL、`mailto:`、`#片段`、`data:`、`tel:`、`<…>` 包裹、带 title 全部 `skip`，不假红；**唯一假红形态是协议相对 `//host/path`**（F6）。另：裸 `..` 不会假红（反而漏判，F1）。
6. **入口保护**：**没有"被 import 时意外执行 main()"**——`node -e "import('…/check-refs.mjs")` 实测 `argv[1]=undefined`、`exported=['findLineRefs']`、`process.exitCode` 未被改写；`node test/guards.mjs` 下 `argv[1]` 是测试文件路径 → guard 为 false。大小写变形的绝对路径调用（`C:\USERS\OMEN\.DSH\…`）依然正常跑 `main()`（Node 两侧都按输入形态取值，`resolve` 相等）。该写法的失败方向只会是"静默不跑"（本机未复现任何形态）。
7. **钩子/CI 注入与权限面**：新增步骤只用 `bash scripts/ci-run.sh node …`，脚本内容为读操作（`check-refs` import 仅 `node:fs/path/url`，`guards` 只 import 两个本地模块），无网络、无凭据、无写文件；`ci-run.sh` 给每行加 `::error::` 前缀，新检查打印的仓库内容不会变成新的 workflow command（匹配子串也不含换行）。`.githooks/pre-commit` 的注入面是"仓库自己的 package.json 脚本"这一 npm 钩子固有属性（F9），且本克隆已启用。
8. **零依赖**：成立——`node -e` 读 `package.json` → `dependencies: undefined`、`devDependencies: undefined`（`files` 仍为 `["lib","docs","cordis.patch.yml","README.md","README.en.md","CHANGELOG.md","LICENSE"]`，无新增）。

**既存 vs 本次引入**：本次引入 = F1（escape 分支判定面）、F3（`check-refs.mjs` 新正则）、F5（新枚举面）、F6（新 escape 规则带来的新假红形态）、F8。既存且未修 = F2（第 10 项裸 `existsSync`）、F4（4b 的正则，本次只提升为共用）、F7 的旧行为（`JSON.stringify` 全量扫描）。修正建议方向（不属本次评审范围）：escape 判定改为对 `posix` 与 `win32` 双语义归一后判断"是否越出 root"，并对所有 `existsSync` 走同一分类器；两条二次方正则加占有量词或改写为"先切 token 再判后缀"。

---

## 处置（评审结束后由实现相位填写）

见 `specs/003-guardrails-and-doc-hygiene/qa-report.md` §4 与后续 commit。