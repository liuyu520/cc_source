import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

// 'thirdParty' — 通过 ANTHROPIC_BASE_URL 接入的非 Anthropic 第三方 API（如 MiniMax）
// 'codex' — 通过 OpenAI Responses API 接入的 Codex/OpenAI 兼容 LLM
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'thirdParty' | 'codex'

export function isConservativeExecutionProvider(
  provider: APIProvider = getAPIProvider(),
): boolean {
  return provider === 'codex' || provider === 'thirdParty'
}

/**
 * 判断 ANTHROPIC_BASE_URL 是否为 OAuth 代理地址。
 *
 * 匹配规则（严格按路径段，避免裸字符串误伤）：
 * - 解析 URL 后按 "/" 切分 pathname
 * - 必须存在相邻的两个段 "v1" + "proxy"（完整匹配，不接受 "proxy_old"/"proxyfoo" 等变体）
 *
 * 示例：
 * - https://proxy.example.com/v1/proxy/anthropic       ✓
 * - https://example.com/gateway/v1/proxy/foo            ✓
 * - https://example.com/v1/proxy                        ✓
 * - https://example.com/api/v1/proxy_old                ✗（proxy_old != proxy）
 * - https://example.com/v1proxy                         ✗（单段，不是 v1 + proxy）
 */
export function isOauthProxyBaseUrl(
  baseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL,
): boolean {
  if (!baseUrl) return false
  try {
    const pathname = new URL(baseUrl).pathname
    const segments = pathname.split('/').filter(Boolean)
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] === 'v1' && segments[i + 1] === 'proxy') return true
    }
    return false
  } catch {
    return false
  }
}

export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'foundry'
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)) return 'codex'

  // 自定义 base URL 且非 Anthropic 官方域名
  if (process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()) {
    // 判定逻辑：
    // - 有 ANTHROPIC_API_KEY → 真正的第三方 API（MiniMax 等），用 API Key 认证
    // - 无 ANTHROPIC_API_KEY → 必须走 OAuth → OAuth 只能是 Anthropic → 视为 firstParty
    //
    // 注意：ANTHROPIC_MODEL 仅为模型偏好，不影响 provider 判定。
    // 用户可以设置 ANTHROPIC_MODEL=claude-opus-4-6 同时使用 OAuth 代理。
    if (process.env.ANTHROPIC_API_KEY) {
      return 'thirdParty'
    }
    // OAuth 代理模式：代理转发到 api.anthropic.com，等价于 firstParty
    return 'firstParty'
  }

  return 'firstParty'
}

/**
 * 是否为代理模式（设置了 ANTHROPIC_BASE_URL 且非 Anthropic 官方域名）
 * 注意：代理模式不等于 thirdParty。OAuth 代理用户的 getAPIProvider() 返回 'firstParty'，
 * 但 isProxyMode() 返回 true。用于需要区分"直连"和"代理"的场景（如 URL 构建）。
 */
export function isProxyMode(): boolean {
  return Boolean(process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl())
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
