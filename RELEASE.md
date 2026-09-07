# 发布手册（T3.9）

三条渠道，顺序不能换：**先 GitHub（公开 + topic），再 npm，最后插件目录站**——
后两者都要引用前者的地址，且目录站的评审会**实际读你的仓库**。

本机已核对的状态（2026-09-07）：仓库 `xinghe-1018/dsh-token-plan-quota` **已经是 public**、
**没有 topic**、**tag 一个都没推**（本地已有 `v0.2.0/v0.3.0/v0.4.0/v0.4.1`）、
npm 名 `dsh-token-plan-quota` **未被占用**、`npm whoami` 未登录、`npm publish --dry-run` 通过（9 文件 / 80 kB）。

> 未推送的提交数以 `git rev-list --count origin/main..main` 为准，别信文档里写死的数字。

---

## 0. 已决定：`ROADMAP.md` 随仓库公开，且已脱敏

2026-09-07 定：公开。所有**属于个人账号的余额与用量数字**已从 ROADMAP / 测试夹具里清掉，
换成明显虚构的值（`0.625` 比例、`1500 / 4000` 余额、`800` 五小时上限）。
保留的是结论所依赖的**结构**：路由 id、字段名、档位配置的存在性——去掉这些，"配置 ≠ 额度"
和"手填 providers 必然漂移"两条教训就无法复现。

发布前自查（有输出就说明又漏了）：

```bash
# 有输出就说明又漏了（排除本文件，否则这条模式会自己匹配自己）
git grep -nI -E '40\.33|40\.74|2117|2661|2957|3620|3,677|934 字符|specCode: standard' -- . ':(exclude)RELEASE.md'
```

> 历史边界：脱敏发生在**推送之前**，所以这些数字从未进过公开历史；
> 若将来已推送再想撤，那属于"发布后删除"，GitHub 的缓存与 fork 不保证消失。

---

## 1. 推送提交与 tag

```bash
cd ~/.dsh/plugins/dsh-token-plan-quota
git push origin main --follow-tags        # 未推送的提交 + 3 个 tag
git ls-remote --tags origin               # 确认 v0.2.0 … v0.4.1 都在
```

远端别名 `github.com-new` 已在 `~/.ssh/config` 指向 `~/.ssh/id_ed25519_ghnew`，
所以直接 push 即可（不需要 HTTPS 凭据）。

## 2. 加 `dsh-plugin` topic（官方认可的发现机制）

DSH 主仓不接受外部 PR，官方对插件作者的唯一要求就是这一行（`deepseek-harness/CONTRIBUTING.md` L13-15）。

```bash
# 有 gh 且已登录：
gh repo edit xinghe-1018/dsh-token-plan-quota --add-topic dsh-plugin --add-topic deepseek-harness

# 没装 gh：网页操作，仓库右栏 Topics → 输入 dsh-plugin → Save
# 只有 API token 时：
curl -X PUT https://api.github.com/repos/xinghe-1018/dsh-token-plan-quota/topics \
  -H "Accept: application/vnd.github.mercy-preview+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{"names":["dsh-plugin","deepseek-harness","quota","token-plan"]}'
```

验证：`https://github.com/topics/dsh-plugin` 里能搜到自己（可能有几分钟索引延迟）。

## 3. 发 npm

```bash
npm login                                  # 网页授权即可
npm publish --access public                # 名字已被占用时报 403，未占用时这步就是发布
npm view dsh-token-plan-quota version      # 应为 0.4.1
```

两个坑：

- **开了 2FA 的账号**不能直接 `npm publish`（会 `E401`/要求 OTP）。要么 `npm publish --otp=…`，
  要么建一个 **Granular Access Token** 并勾上 `Read and publish`，用它：
  `npm publish // 带 NPM_TOKEN=...`。组织/受保护包需要走后者。
- **`files` 白名单决定包里有什么**。当前是 `lib / cordis.patch.yml / README.md / README.en.md / CHANGELOG.md / LICENSE`。
  发布前务必看 dry-run 列表（`npm publish --dry-run`），漏 `lib/detect.js` 这类新文件会让用户装到坏包——
  本仓库的 `scripts/check-docs.mjs` + CI 的 tarball 冒烟就是为这个准备的：

  ```bash
  npm run check            # 测试 + manifest + README 声明一致性
  npm pack && tar -tzf dsh-token-plan-quota-0.4.1.tgz   # 肉眼过一遍文件表
  ```

装法验证（发布后，任选一台干净机器）：

```bash
dsh plugin --profile web add dsh-token-plan-quota
```

## 4. 提交到 awesome-dsh-plugin（插件目录站）

投稿形式是**一个 YAML 文件**，不是改 README（那两个文件是生成的，手改会被拒）。
目录站默认分支 `main`，`data/plugins/` 已有 1000+ 条目（API 分页上限），命名就是 `<owner>__<repo>.yml`。

本机**没装 `gh` CLI**，所以走 GitHub 网页的「新建文件」路径——它会替你自动 fork 并直接开 PR：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/new/main?filename=data/plugins/xinghe-1018__dsh-token-plan-quota.yml
```

（命令行路径留在这里备用：`git clone` → 建分支 → 加这一个文件 → `git push -u <fork>` → 开 PR；
`npm ci && node scripts/generate-readme.mjs` 可本地预览生成出来的那一行，但**别把生成物一起提交**，
维护者会在合并后重新生成。）

文件内容（`description.en` 是唯一必填项；**含 `: ` 的值必须加引号**，否则 YAML 当嵌套键解析）。
这一段是投稿用的**权威文本**：`node scripts/check-submission.mjs`（已并入 `npm run check`）守着它的
结构与措辞——分类在上游取值表里、含 `: ` 的加了引号、行尾没有逗号、以句号结尾、点名的厂家在预设里
确实存在、条目文件名符合 `<owner>__<repo>.yml`。别在别处再抄一份，抄了就会漂。

```yaml
url: https://github.com/xinghe-1018/dsh-token-plan-quota
name: xinghe-1018/dsh-token-plan-quota
category: usage
description:
  en: 'Balance badge that follows the active model provider: official readings for DeepSeek, Qwen Token Plan and Aliyun BSS, plus Moonshot and OpenRouter endpoints not yet key-verified.'
  zh: '跟随当前模型供应商的额度徽标：DeepSeek、千问 Token Plan、阿里云费用中心取官方真值，Moonshot / OpenRouter 已接官方端点但字段未用真 Key 核对；其余只报本实例实测。'
```

> 这句描述是**收窄过的**。早先的写法是"有官方接口处显示官方余额"，但 README 自己的表格写着 Moonshot 与
> OpenRouter 的字段名**没拿真 Key 核对过**（只实测过端点存在）。目录站的评审会逐字核描述与代码，
> 所以宁可写明哪三家核过、哪两家待核——这也正是本插件"标到字段级"口径该给自己用的标准。

评审会看什么（我读过它们的 `contributing.md`，这几条对我们最相关）：

1. **CI 绿只是前置条件**，维护者会真的读仓库；
2. **"两个插件做同一件事，先来者留位"** → `dsh-cost-meter`（九家 Coding Plan）已在榜，
   所以 README 里那节「与相邻插件的区别」不是装饰，是投稿能不能过的关键；
3. **描述必须与代码逐字对得上** → 这就是 `scripts/check-docs.mjs` 存在的原因；
   上面那句 `description.en` 已经按这个标准**收窄过**：点名 DeepSeek / 千问 / 阿里云三家"取官方真值"，
   Moonshot 与 OpenRouter 明写"已接官方端点但字段未用真 Key 核对"（T1.8 还没做）。
   早先的草稿写的是 "official balances where an API exists"——那句对我们自己来说就是超售，
   评审拿代码一核就露；**宁可点名哪几家核过、哪两家没核过**；
4. **源码里有没有可疑之处**（混淆、凭据外传、安装期意外行为）→ 我们有 Cookie 型源，
   `SECURITY.md` 已主动交代边界与"明确不做的三类"，别等维护者去代码里翻；
5. 仓库满 1 天 ✅（本仓库早于今天）、有真实代码 ✅、声明了 `dsh.bundle` ✅
   （**最常见的被拒原因是只写 `dsh.client`**，`scripts/check-manifest.mjs` 会替你守住这条）。

## 5. 发布后

- 装一次真包跑通：徽标跟随切换、`GET /token-plan-quota/summary` 的 `detection` 块正常；
- 生态里两个审计插件会自然索引到它（`dsh-sentinel-scanner` 静态评分、`dsh-score`/`dsh-quality-score` 质量分）。
  先自己跑一遍，若 Cookie 型源被判高风险，**不要狡辩**：把该源改成默认关闭 + README 顶部一句话说明，
  比争论评分口径便宜；
- `CHANGELOG.md` 顶部加 `## [Unreleased]`，下次改动往那儿堆。

## 5.1 撤回

```bash
npm deprecate dsh-token-plan-quota "reason"   # 保留包但装机时给警告
npm unpublish dsh-token-plan-quota@0.4.1      # 24 小时内可撤；之后受限，别指望它
git push origin :refs/tags/v0.4.1             # 撤 tag（GitHub release 也要手动删）
```

---

## 一句话版

```bash
# 0) 决定 ROADMAP.md 去留（见上），然后
git push origin main --follow-tags
gh repo edit xinghe-1018/dsh-token-plan-quota --add-topic dsh-plugin
npm login && npm publish --access public
# 4) 往 awesome-dsh-plugin 提一个 data/plugins/xinghe-1018__dsh-token-plan-quota.yml
```
