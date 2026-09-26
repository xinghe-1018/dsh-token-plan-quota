/**
 * 出站主机的**单一实现**：从代码推导真实会打到的主机，并与 `dshhub.permissions.network`
 * 双向比对（宪法 V：声明集合与实际出站集合**逐项相等**）。
 *
 * 为什么单独一个文件：原先这段逻辑长在 `check-docs.mjs` 里，且只做单向、只认预设的
 * `url` / `infoUrl` / `regions[*].url` 三个字段，于是有两个洞——
 *  1. 阿里云 BSS 的主机是 `DEFAULTS.endpoint` 的**裸主机名**，请求时才拼成
 *     `https://${endpoint}/`：抠不出来，等于"人工声明对了、门禁从没验过"；
 *  2. 浏览器半边（`lib/client.js`）运行时拉的字体 CDN 只看 README 文本，而两份 README 里
 *     根本没有那个 URL —— 那行正则恒不命中，是**死代码**（门禁宣称管到了，实际没管）。
 * 逻辑抽出来还有个好处：它能被 `test/guards.mjs` 直接喂正反例（本仓库教条：
 * 机械检查必须做行为矩阵，且要能失败）。
 */

/** 从 URL 取 `https://<host>`（去尾斜杠）；取不到给 null —— 不猜、不补默认。 */
export function hostOfUrl(url) {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/([^/?#]+)/.exec(url.trim())
  return match === null ? null : `https://${match[1]}`
}

/**
 * 抠出 `lib/client.js` 里 `FONT_CSS` 数组中的绝对 URL。
 * 限定在那一块内匹配：注释里出现的示例 URL 不算出站（否则改一句注释就会假红）。
 */
export function fontCssUrls(clientSource) {
  const block = /const FONT_CSS = \[([\s\S]*?)\n\s*\]/.exec(String(clientSource ?? ''))
  if (block === null) return []
  return [...block[1].matchAll(/["'](https:\/\/[^"']+)["']/g)].map(match => match[1])
}

/**
 * 从代码推导出站主机集合。三个来源各自兜一种形态：
 *  1. `PRESETS` 的 `url` / `infoUrl` / `regions[*].url` —— 常规 http 源；
 *  2. `DEFAULTS.endpoint` —— 裸主机名（拼成 https），阿里云 BSS 走这条；
 *  3. `lib/client.js` 的 `FONT_CSS` —— 浏览器半边的运行时字体 CDN。
 * @param {{presets?: object, defaults?: object, clientSource?: string}} input
 * @returns {Set<string>}
 */
export function deriveHostsFromCode({ presets = {}, defaults = {}, clientSource = '' } = {}) {
  const hosts = new Set()
  const add = url => {
    const host = hostOfUrl(url)
    if (host !== null) hosts.add(host)
  }
  for (const preset of Object.values(presets ?? {})) {
    if (preset === null || typeof preset !== 'object') continue
    add(preset.url)
    add(preset.infoUrl)
    if (preset.regions !== null && typeof preset.regions === 'object') {
      for (const region of Object.values(preset.regions)) add(region?.url)
    }
  }
  if (typeof defaults?.endpoint === 'string' && defaults.endpoint.trim() !== '') add(`https://${defaults.endpoint.trim()}`)
  for (const url of fontCssUrls(clientSource)) add(url)
  return hosts
}

/**
 * 双向比对。
 * @param {Set<string>} derived 代码推导出来的主机
 * @param {Set<string>} declared `dshhub.permissions.network` 声明的（已去尾斜杠）
 * @returns {{undeclared: string[], unused: string[]}} 两边都空才叫"逐项相等"
 */
export function compareHosts(derived, declared) {
  const undeclared = [...derived].filter(host => !declared.has(host)).sort()
  const unused = [...declared].filter(host => !derived.has(host)).sort()
  return { undeclared, unused }
}