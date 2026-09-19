# ENVIRONMENT — 本机 / 本仓库的环境事实

<!-- 为什么单独一份：这类事实只在本机成立，写进 AGENTS.md 会让每个会话都为它付上下文，
     而它只在"取远端 / 出图 / 写文件"这几个分支上才被需要——分支罕见的材料就该放在指针后面。
     AGENTS.md 里不放，`workflow/README.md` 指向这里。

     判据：**能靠 `--help`、配置文件或目录结构查到的东西不写在这里**（那是环境本身，
     写下来就是一份会过期的缓存）。这里只写环境**不会告诉你**的坑与前置条件。 -->

## 远端与推送

- 远端是 **SSH 别名**，不是 `github.com`：`git@github.com-new:xinghe-1018/dsh-token-plan-quota.git`
  （`~/.ssh/config` 里 `github.com-new` 映射到 GitHub 与对应私钥）。看到 `github.com-new` 是正常的，
  不是打错字。
- 连通性自检用 `git ls-remote --heads origin`（只读，不动工作树）；它返回 ref 列表就说明鉴权没问题。
- `refs/remotes/origin/HEAD` 在本仓库**未设**（远端没有符号引用），所以 PR 的 base 分支要显式写 `main`，
  不要指望工具自动推断。

## tag、克隆深度与门禁

- `scripts/check-docs.mjs` 第 7 项会核 CHANGELOG 引用的 tag 是否存在。它**不打网络**：看不见 tag 就
  **出声跳过**（`notices`），而不是假红。浅克隆与非 git 目录都会走到这条。
- 因此 CI 的 checkout 必须 `fetch-depth: 0`（见 `.github/workflows/ci.yml` 的 manifest job）——
  默认的单层克隆会让四个 tag 全"不存在"，假红过一次。本地遇到类似情况先 `git fetch --tags`。

## 出图机（`scripts/shots/`）的前置

- `make-shots.mjs` 通过 CDP 连**活着的 DSH**：要先有实例在监听端口，`--url` 指到它。
- 它用宿主自带的 `?fixture` 模式拿"有活会话"这个徽标挂载前提，并在浏览器侧拦下 summary 响应换成
  `fixture.mjs` 的合成数据——**不需要任何凭据**，也不该给它真实凭据。
- **窄视口取景（`--width` / `--height`）要独立 `DSH_HOME`**：它在同一实例上换视口，会与正在用的
  实例互相干扰。非默认视口还额外拒绝写进 `docs/`（`--allow-docs` 才放行），防止 QA 图混进已发布物料。

## 写文本文件

- **用 Node 或文件工具写仓库里的文本，不要用 pwsh。** 机制与实测数字（本机 `pwsh` 实为
  Windows PowerShell 5.1、`Set-Content -Encoding utf8` 会加 BOM、不带 `-Encoding` 读 UTF-8 会按
  GBK 解码、含中文的 double-quoted 字符串里反引号是转义符）记在**全局 `$DSH_HOME/AGENTS.md`
  的「本机环境事实（工具与文本）」**——那是跨仓库都成立的事实，写两处就会各漂各的。
  本仓库只关心后果：BOM / GBK 残骸会触发 `check-docs.mjs` 第 9 项（编码护栏）红灯。
- 本机 `core.autocrlf = true`，但 `.gitattributes` 里 `* text=auto eol=lf` 压过它：落地的文本仍是 LF。
  shell 脚本（`.githooks/pre-commit`、`scripts/*.sh`）依赖这一条——CRLF 会让 shebang 失效。

## 门禁耗时

- `npm run check` 在本机约 **6 秒**（host 379 项 + client 207 项 + guards 94 项 + 四个自检：
  manifest / docs / refs / submission）。这就是 pre-commit 钩子可以直接跑全套、不必挑子集的依据。