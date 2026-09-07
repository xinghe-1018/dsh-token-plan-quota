# 安全策略

## 凭据处理边界

本插件会读取用于查询额度的凭据，边界如下：

- **解析顺序**：DSH 凭据服务 → 环境变量 → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`。
  插件不写这些文件，只读。
- **只发往声明过的主机**：出站目标全部列在 `package.json` 的
  `dshhub.permissions.network`，加一家就要同步加一条（`scripts/check-manifest.mjs` 会检查格式）。
- **绝不外泄**：`/token-plan-quota/*` 只回标量与打码后的凭据状态，且只接受同源请求
  （`sec-fetch-site` / `Origin` 双检）；密钥不出现在任何路由响应、快照字段或错误文案里。
- **`debug` 模式**：回显上游响应的**字段骨架**，值会被打码，且跳过
  `cookie` / `authorization` / `api[-_]?key` / `signature` 一类字段名。

## Cookie 型数据源（千问 Token Plan 官方余量）

这是本插件风险最高的一类，请知情后再开：

- 它用的是**控制台数据网关**（登录 Cookie 会话鉴权），**不是公开发布的官方 API**；
  上游随时可能改动或拒绝，插件不为此负责。
- Cookie 只从本地凭据链解析，**只在进程内使用**；订阅页 Cookie 通常包含会话票据，
  请自行评估把它交给本地插件的风险。
- 只在 `BAILIAN_CONSOLE_COOKIE` 能解析到时才会启用该源；解析不到就退回实测窗口卡，
  不会拿着空凭据去打上游。
- 若上游服务条款禁止此类访问，请**不要启用**该源（把 `sources` 里的
  `token-plan-console` 去掉即可）。

## 明确不做的凭据形态

以下三类需要读取其它 CLI 的本地登录态或额外强凭据，本插件**不实现**，也不接受相关 PR：

- GLM 团队模式（`Bigmodel-Organization` / `Bigmodel-Project`）
- Kimi Code 的浏览器 Cookie / `~/.kimi-code/credentials/*`
- Codex·ChatGPT / Gemini CLI 的 OAuth token（`~/.codex/auth.json`、`~/.gemini/oauth_creds.json`）

需要这些家请用「自定义源」自己配 HTTP 端点（见 README）。

## 报告漏洞

请开 [GitHub issue](https://github.com/xinghe-1018/dsh-token-plan-quota/issues) 描述现象；
涉及凭据泄露等敏感问题时，请**不要**在 issue 正文里贴任何 Key 或 Cookie，
先只描述触发路径，维护者会在私下一对一沟通中要复现材料。
