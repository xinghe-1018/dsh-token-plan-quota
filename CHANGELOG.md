# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式维护。

## [0.4.0] - 2026-09-06

### Added

- **零配置自动检测**（`lib/detect.js`）：按宿主在用的供应商路由决定该开哪些数据源，
  不再需要手写 `sources` 与 `providers`。识别优先级 `baseURL host` > 路由名 > Key 前缀，
  都没命中就挂 `window:<provider>` 实测源。规则表是纯函数层，不打网络、不读文件，
  所以全部可离线测试，不需要任何真 Key。
- 每张自动开出的卡带 `detected: {by, rule, host, fallback, credentialRef}`，
  标题 tooltip 会写「按 api.moonshot.ai 自动识别 · 区 international」；
  快照新增 `detection` 块（在用路由 / 开了什么 / 谁因何被跳过 / 谁没被认出）。
- `autoDetect` 配置项（默认开）。用户写过的源永远赢：某路由已被任意源覆盖，检测就不再碰它。
- 凭据引用优先沿用路由 profile 点名的那个（如 `MOONSHOT_CN_API_KEY`），不必重复配置。
- 测试改用每进程唯一的 `os.tmpdir()` 目录，Linux/macOS 与 CI 可直接跑。

### Changed

- 明细面板改为**常驻小窗**：取消「点外面就关」，关闭只由再点徽标或 Esc 决定。
  原先的实现依赖宿主输入区的 DOM 属性，而线上产物里那些属性并不存在，导致点哪儿都关。
- 一家只展示一张额度卡：官方卡**有数字**时收起自动挂的实测兜底卡；官方卡变成错误卡
  （Cookie 过期等）时兜底必须回来。收合放在看得见数据的显示层，不在规划期决定。

### Fixed

- Cookie 型源不再继承检测写入的 `bearerRef`——曾导致千问官方余量卡报
  「未配置凭据 BAILIAN_CONSOLE_COOKIE（…或设同名环境变量）」，而 Cookie 其实一直在。
- 检测不再按路由名冒充别家：`deepseek-modlens` 这类指向本地代理的路由曾被认成
  DeepSeek 官方，开出第二张同名源；同名源共用 TTL 缓存并互相覆盖，表现为
  「两张余量卡、数字还不一样」。
- 实测窗口不再被误判为「缺凭据」而跳过（它本来就不需要凭据）。
- 一个窗口只有在该套餐真回了读数时才成为一条计量；`quota-config` 里躺着的档位配置
  （如个人版 `five_hour=3000`）不再被渲染成「5 小时窗口 额度上限 3,000」这种噪声。
- `deepseek-balance` 补上出厂适配器真实注册的路由 id `deepseek-official`
  （此前只绑 `deepseek`，卡片查得到却永远不显示，还每 10 分钟白打一次上游）。

## [0.3.0] - 2026-09-06

### Added

- 一张卡可承载**多个窗口**（`card.meters`）：宿主统一派生百分比，前端逐条渲染细渐变条。
  千问余量卡的 5 小时窗口从此是自己的计量行，不再是摘要尾巴上的一句小字。
- 新数据源：`moonshot-balance`（Moonshot / Kimi 开放平台，`.cn` CNY 与 `.ai` USD 两区）、
  `openrouter-credits`（OpenRouter，余额＝累计充值 − 累计花费）。
- `regions`（一家多 host/币种）、`derive`（一次加减的派生表达式）、静态 `unit`
  （端点不回币种字段时由区给出）、源级 `errorHints`（同一个 401 在不同家给不同人话）。
- `"window:<provider>"` 简写：给任意供应商挂实测窗口，不必手抄整个源对象。
- 4xx 卡片会捞上游错误体里的 `error.message`，不再只报一个状态码。

### Fixed

- 实测卡一律不出余量条、不出百分比（宿主剥一遍、前端再兜一道）：
  没有官方分母的比例就是估算，而估算不是本插件的口径。
- `0` 余额与欠款按真值显示，不再被当成「没数据」。

## [0.2.0] - 2026-09-06

### Added

- 徽标跟随当前会话的模型供应商切换（订阅宿主 `sessions.list` → `modelDirectories`），
  不轮询、不打网络；拿不到这两个服务的老外壳退回全量显示。
- 明细面板可拖出悬浮（`createPortal` 挂到 `body`、fixed 视口坐标）、右下角拖拽缩放，
  位置与尺寸记进 `localStorage`，双击标题栏归位。
- 极简视觉：幽灵小徽标、无状态圆点与表情符号，余量渐变条本身即状态表达；
  自成一套字体栈（Geist Variable + Noto Sans SC，断网落系统栈）。

## [0.1.0] - 2026-09-05

### Added

- 初版：DeepSeek 官方余额、千问 Token Plan 实测 7 天窗口（本实例账本，明确标注非官方余量）、
  可选阿里云 BssOpenApi（AK/SK 签名）三个数据源；只读路由 `/token-plan-quota/*`；
  模型可调用工具 `token_plan_quota`。

> 注：本仓库的公开历史始于 0.2.0（根提交即 `feat: dsh-token-plan-quota v0.2`），
> 0.1.0 没有对应提交，因此**不打 `v0.1.0` tag**——留一个指向不存在的 tag 的链接就是假链接。

[0.4.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/xinghe-1018/dsh-token-plan-quota/releases/tag/v0.2.0
