/**
 * 仓库路径（`owner/repo`）的**单一实现**：从 `package.json#repository.url` 派生。
 *
 * 为什么单独一份：`scripts/release.mjs` 要在 CHANGELOG 里生成 compare 链接、
 * `scripts/check-submission.mjs` 要拼投稿条目文件名，原先两处各写了一条正则（加上 package.json
 * 自己，owner/repo 一共三份）——改名时 check-docs 只核 tag 那半段，于是链接会静默指向旧仓库，
 * 而门禁全绿。两处语义相同的实现必然会各自漂，所以放这里。
 *
 * 点号必须留着：`owner/plugin.v2.git` 只该剥掉末尾的 `.git`——早先的 `[^/.]+` 会把仓库名截成
 * `plugin`，导致投稿条目文件名算错（CodeRabbit 在 PR #3 上指出）。
 */

/**
 * @param url 形如 `git+https://github.com/owner/repo.git`、`https://github.com/owner/repo`、
 *   `git@github.com:owner/repo.git` 的字符串。
 * @returns `owner/repo`；不是 GitHub 仓库地址就给 `undefined`（不猜）。
 */
export function repoPathFromUrl(url) {
  if (typeof url !== 'string') return undefined
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match === null ? undefined : match[1]
}