# 027 计划

## 方案

纯文案替换（方案 A 采纳）：

1. 改 `lib/client.js` 的 `usageSingleModelNightNote`（zh 一条、en 一条），注释补一句 027。
2. 同步 `test/client.mjs` 的静态字面量断言与渲染期望（各两处）。
3. 同步 `test/guards.mjs` 第 25 节两条字面量；新增第 27 节：新文案逐字、旧文案零残留、
   渲染条件原样、README/CHANGELOG/规格四件、零配置键/出站/依赖。
4. README.md / README.en.md 的引文与 022 段落里的「未计夜间折扣」表述改成「折扣已在已用 Credits 里」。
5. CHANGELOG `[Unreleased]/Added` 顶部加 027 条目；跑七步门禁；三提交。

被否方案：

- B 只改标签不动说明：两处口径继续打架，用户明确要求统一。
- C 删掉这行说明：025 是用户点名要的，删掉等于回退用户需求；且夜间时段信息有用。

## 风险

- 文案改动会打掉测试里的逐字断言，必须同步（已列入步骤 2/3）。
- 历史 CHANGELOG（0.6.0 的 025 条目）保留原文属预期，guards 只对新代码断言旧句零残留，
  不对 CHANGELOG 断言。

## 验收手算

无数字变化：estimate 公式未动，唯一区别是说明文字。发版 0.6.1（patch）。
