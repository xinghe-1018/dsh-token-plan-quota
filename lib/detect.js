/**
 * 零配置自动检测：把「宿主在用的供应商路由」映射成「该开哪些额度数据源」。
 *
 * 本模块是**纯函数层**——不打网络、不读文件、不碰 cordis：宿主信息一律由调用方注入，
 * 凭据也由调用方解析成布尔后再传进来。所以规则表能逐条离线测，不需要任何真 Key。
 * 接线在 lib/index.js 的异步层做。
 *
 * 匹配优先级（越靠前越可信，命中即停）：
 *   1. `baseURL` 的 host —— 路由实际打到哪，这是唯一不会说谎的信号；
 *   2. 路由 id / displayName 关键词 —— host 被自建网关反代时兜底；
 *   3. Key 前缀 —— 连 baseURL 都拿不到时的最后线索；
 *   4. 都没有 → 给这条路由挂 `window:<routeId>` 实测源。
 *
 * 两条硬约束：
 *   - **认不准就不开源**。宁可少一张卡，也不能把别家的余额数字顶在某个模型上——
 *     徽标是跟着模型走的，报错的数比没有数恶劣得多。
 *   - **不越权**：用户已经用某个源覆盖过的路由，检测一概不再追加（`coveredRoutes`）。
 */

/** 每家平台的识别规则。`presets` 里的名字必须是 lib/index.js `PRESETS` 的键。 */
export const PLATFORM_RULES = [
  {
    key: 'qwen-token-plan',
    hosts: ['token-plan.cn-beijing.maas.aliyuncs.com'],
    idKeywords: ['token-plan', 'tokenplan', 'qwen-token'],
    // 控制台网关给官方余量；实测窗口同时挂着，Cookie 掉线时徽标不至于空。
    presets: ['token-plan-console', 'token-plan-window'],
    note: '千问 Token Plan（订阅套餐网关）',
  },
  {
    key: 'moonshot',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    idKeywords: ['moonshot', 'kimi-open', 'kimi-platform'],
    presets: ['moonshot-balance'],
    // host 直接决定区（省一次配置）。区的 host 与币种成对，见 PRESETS['moonshot-balance'].regions。
    regionByHost: {
      'api.moonshot.cn': 'china-mainland',
      'api.moonshot.ai': 'international',
    },
    // 故意不收 `kimi`：kimi.com/code 是另一个产品、另一套端点，撞上去就是报错数字。
    note: 'Moonshot / Kimi 开放平台',
  },
  {
    key: 'openrouter',
    hosts: ['openrouter.ai'],
    idKeywords: ['openrouter'],
    keyPrefixes: ['sk-or-'],
    presets: ['openrouter-credits'],
    note: 'OpenRouter',
  },
  {
    key: 'deepseek',
    hosts: ['api.deepseek.com'],
    idKeywords: ['deepseek'],
    presets: ['deepseek-balance'],
    note: 'DeepSeek 官方',
  },
]

/** 从 URL 取 host；拿不到给空串，不抛。 */
export function hostOf(url) {
  const text = String(url ?? '').trim()
  if (text === '') return ''
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(text) ?? /^([^/?#]+)/i.exec(text)
  if (match === null) return ''
  return match[1].split('@').pop().split(':')[0].toLowerCase()
}

function normalizeToken(value) {
  return String(value ?? '').toLowerCase().replace(/[._/]+/g, '-')
}

/** host 匹配：允许官方域名作为子域出现（自建网关反代常见），但要整段边界对齐。 */
function hostMatches(rule, host) {
  if (host === '' || !Array.isArray(rule.hosts)) return undefined
  return rule.hosts.find(known => host === known || host.endsWith(`.${known}`))
}

function keywordMatches(rule, route) {
  const haystack = [route.id, route.name, route.displayName].map(normalizeToken).filter(part => part !== '')
  return (rule.idKeywords ?? []).some(keyword => haystack.some(part => part.includes(normalizeToken(keyword))))
}

function prefixMatches(rule, keyValue) {
  const text = String(keyValue ?? '')
  return (rule.keyPrefixes ?? []).some(prefix => text.startsWith(prefix))
}

/** 一条路由 × 一条规则 → `{ by, host? }` 或 undefined。 */
function matchRule(route, profile, rule) {
  const host = hostMatches(rule, hostOf(profile?.baseURL))
  if (host !== undefined) return { by: 'baseURL', host }
  if (keywordMatches(rule, route)) return { by: 'routeId' }
  if (prefixMatches(rule, profile?.keyValue)) return { by: 'keyPrefix' }
  return undefined
}

/**
 * 主入口。
 * @param input
 *   - `routes`：在用路由 `[{ id, name? }]`（宿主 `llm.listProviders()` 的形状）；
 *   - `profiles`：`{ [routeId]: { baseURL?, keyValue? } }`（调用方从宿主设置分节解析；
 *     `keyValue` 只在"必须靠前缀才认得出"的家里传，别把密钥到处传）；
 *   - `hasCredential(preset, route)`：这个源在这条路由上解析得到凭据吗（缺省视为有）；
 *   - `coveredRoutes`：用户已配置的源已经覆盖的路由 id 列表；
 *   - `rules`：覆盖默认规则表（测试用）。
 * @returns `{ sources, skipped, uncovered }`：要追加的源、因何没开的源、没被任何规则认出的路由。
 */
export function detectSources(input) {
  const rules = Array.isArray(input?.rules) ? input.rules : PLATFORM_RULES
  const routes = Array.isArray(input?.routes) ? input.routes : []
  const profiles = input?.profiles ?? {}
  const hasCredential = typeof input?.hasCredential === 'function' ? input.hasCredential : () => true
  const covered = new Set((Array.isArray(input?.coveredRoutes) ? input.coveredRoutes : []).map(normalizeToken))
  const grouped = new Map()
  const skipped = []
  const uncovered = []

  for (const route of routes) {
    const id = String(route?.id ?? '').trim()
    if (id === '') continue
    if (covered.has(normalizeToken(id))) continue
    const profile = profiles[id] ?? {}
    let hit
    for (const rule of rules) {
      const matched = matchRule(route, profile, rule)
      if (matched !== undefined) {
        hit = { rule, matched }
        break
      }
    }
    if (hit === undefined) {
      uncovered.push(id)
      continue
    }
    const region = hit.matched.host !== undefined && hit.rule.regionByHost !== undefined
      ? hit.rule.regionByHost[hit.matched.host]
      : undefined
    for (const preset of hit.rule.presets ?? []) {
      const bucket = grouped.get(preset) ?? { providers: [], region, by: hit.matched, ruleKey: hit.rule.key }
      if (!bucket.providers.includes(id)) bucket.providers.push(id)
      if (bucket.region === undefined && region !== undefined) bucket.region = region
      grouped.set(preset, bucket)
      if (!hasCredential(preset, id)) {
        skipped.push({ preset, route: id, reason: 'no-credential', by: hit.matched.by })
      }
    }
  }

  const sources = []
  for (const [preset, bucket] of grouped) {
    // 该源在这些路由上一个凭据都没有 → 不开（开了只会挂一张 NoCredentials 错误卡占地方）。
    const usable = bucket.providers.filter(route => hasCredential(preset, route))
    if (usable.length === 0) continue
    sources.push({
      id: preset,
      preset,
      providers: usable,
      region: bucket.region,
      detected: { by: bucket.by.by, rule: bucket.ruleKey, host: bucket.by.host ?? null },
    })
  }
  for (const id of uncovered) {
    sources.push({
      id: `window:${id}`,
      window: id,
      providers: [id],
      detected: { by: 'fallback-window', rule: null, host: null },
    })
  }
  return { sources, skipped, uncovered }
}
