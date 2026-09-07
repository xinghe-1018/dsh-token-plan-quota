# 贡献指南

本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件，
零第三方依赖，宿主半边与浏览器半边都在同一个包里。

## 跑测试

```bash
node test/host.mjs      # 宿主半边：离线，回环 HTTP 例外
node test/client.mjs    # 浏览器半边：假 React / 假 DOM / 假 fetch，不联网
npm test                # 两个都跑
node scripts/check-manifest.mjs   # 清单自检（安装性、出站主机声明、许可证）
```

测试**必须能在 Linux/macOS/Windows 上跑**：不要写死平台路径，临时目录一律用
`join(os.tmpdir(), ...)`；也不要依赖真实 `~/.dsh`（测试会把 `DSH_HOME` 指到临时目录）。

## 产品口径（改代码前先读）

1. **不估算**。徽标里的数字要么来自官方接口，要么明确标注「实测」（只统计经过本 DSH 实例的
   真实调用）。没有 Credits 折算、没有抵扣率、没有"按历史推算剩余"。
2. **没有官方分母就没有百分比**：实测卡永不画余量条、永不显示百分比。
3. **一个窗口只有在这个套餐真回了读数时才存在**。档位配置里躺着的上限值不是额度
   （`quota-config.five_hour` 这类只记进 `extra.*ConfiguredNoReading` 供 debug）。
4. **认不准就不开源**。自动检测宁可少一张卡，也不把别家的余额数字顶在某个模型上；
   有 `baseURL` 时只信 `baseURL`，路由名与 Key 前缀只在拿不到 host 时降级使用。
5. **凭据只进不出**：密钥/Cookie 只在本进程解析，绝不进任何路由响应、日志或错误信息。
6. **永不做会产生计费的探活**。只用只读端点。

## 加一家供应商

照 [`docs/adding-a-provider.md`](docs/adding-a-provider.md) 的清单走（预设 → `SOURCE_META` →
`errorHints` → `PLATFORM_RULES` → 回环单测 → `probe` 核对 → 文档回填）。

## 提交与 PR

- 提交信息用 Conventional Commits：`feat|fix|docs|test|chore(scope): 一句话说清做了什么`。
  正文写**为什么**，尤其是被推翻的初版思路——这个项目里"为什么不用另一种做法"比代码更贵。
- 一个提交只做一件事。修 bug 的提交必须带**能重现该 bug 的回归测试**。
- 描述必须属实：README / `dshhub.summary` / issue 里写的数字与端点名，会被拿去和代码核。
  没验证过的字段名要写清"官方文档背书，未用真 Key 核对"。

## 结构速览

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半边：预设表、凭据解析、查询编排、只读路由、`token_plan_quota` 工具 |
| `lib/detect.js` | **纯函数层**：路由 → 数据源的识别规则表（不碰网络/文件/cordis） |
| `lib/client.js` | 浏览器半边：徽标与明细面板（手写 bundle，无构建步骤） |
| `test/*.mjs` | 两个离线自测，新增能力请同步加断言 |
