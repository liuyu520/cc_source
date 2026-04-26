import { isEnvTruthy } from 'src/utils/envUtils.js'

// Default to prod config, override with test/staging if enabled
type OauthConfigType = 'prod' | 'staging' | 'local'

function getOauthConfigType(): OauthConfigType {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
      return 'local'
    }
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
      return 'staging'
    }
  }
  return 'prod'
}

export function fileSuffixForOauthConfig(): string {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'
  }
  switch (getOauthConfigType()) {
    case 'local':
      return '-local-oauth'
    case 'staging':
      return '-staging-oauth'
    case 'prod':
      // No suffix for production config
      return ''
  }
}

export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const
const CONSOLE_SCOPE = 'org:create_api_key' as const
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

// Console OAuth scopes - for API key creation via Console
export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
] as const

// Claude.ai OAuth scopes - for Claude.ai subscribers (Pro/Max/Team/Enterprise)
export const CLAUDE_AI_OAUTH_SCOPES = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const

// All OAuth scopes - union of all scopes used in Claude CLI
// When logging in, request all scopes in order to handle both Console -> Claude.ai redirect
// Ensure that `OAuthConsentPage` in apps repo is kept in sync with this list.
export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
)

type OauthConfig = {
  BASE_API_URL: string
  CONSOLE_AUTHORIZE_URL: string
  CLAUDE_AI_AUTHORIZE_URL: string
  /**
   * The claude.ai web origin. Separate from CLAUDE_AI_AUTHORIZE_URL because
   * that now routes through claude.com/cai/* for attribution — deriving
   * .origin from it would give claude.com, breaking links to /code,
   * /settings/connectors, and other claude.ai web pages.
   */
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string
  API_KEY_URL: string
  ROLES_URL: string
  CONSOLE_SUCCESS_URL: string
  CLAUDEAI_SUCCESS_URL: string
  MANUAL_REDIRECT_URL: string
  CLIENT_ID: string
  OAUTH_FILE_SUFFIX: string
  MCP_PROXY_URL: string
  MCP_PROXY_PATH: string
}

// Production OAuth configuration - Used in normal operation
// 支持通过 ANTHROPIC_BASE_URL 统一代理所有 Anthropic 域名
//
// 重要：必须使用函数（延迟求值）而非模块级常量，因为 ESM 模块加载发生在
// main() 执行之前。--force-oauth 的代理绕过逻辑在 main()/运行时才会生效，
// 如果用模块级常量，ANTHROPIC_BASE_URL 的旧值（如 MiniMax 地址）会被固化到
// PROD_OAUTH_CONFIG 中，导致 OAuth 请求仍然发往第三方网关 → 403 forbidden。
// 复用已有的 getLocalOauthConfig() 同款延迟求值模式。
// 当 ANTHROPIC_BASE_URL 存在时，将 OAuth 端点 URL 的路径部分拼接到代理 URL 上，
// 使 OAuth 控制面（authorize/token/roles/profile）和数据面统一走代理。
// OAUTH_PROXY_* 环境变量仍可逐端点覆盖（在 getProdOauthConfig 中优先检查）。
const getProxyUrl = (defaultUrl: string): string => {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return defaultUrl

  // 移除 baseUrl 末尾的斜杠
  const cleanBaseUrl = baseUrl.replace(/\/$/, '')

  // 提取原始 URL 的路径部分
  try {
    const url = new URL(defaultUrl)
    return `${cleanBaseUrl}${url.pathname}${url.search}`
  } catch {
    return defaultUrl
  }
}

function getProdOauthConfig(): OauthConfig {
  // OAuth 控制面和数据面统一走 ANTHROPIC_BASE_URL 代理。
  // OAUTH_PROXY_* 环境变量可逐端点覆盖（优先级最高）。
  const baseApiUrlFromEnv = process.env.ANTHROPIC_BASE_URL
  const claudeAiOriginFromEnv = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '')
  const mcpProxyFromEnv = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '')

  return {
    BASE_API_URL: process.env.OAUTH_PROXY_BASE_API_URL || baseApiUrlFromEnv || 'https://api.anthropic.com',
    CONSOLE_AUTHORIZE_URL: process.env.OAUTH_PROXY_CONSOLE_URL || getProxyUrl('https://platform.claude.com/oauth/authorize'),
    CLAUDE_AI_AUTHORIZE_URL: process.env.OAUTH_PROXY_CLAUDE_AI_URL || getProxyUrl('https://claude.com/cai/oauth/authorize'),
    CLAUDE_AI_ORIGIN: process.env.OAUTH_PROXY_CLAUDE_AI_ORIGIN || claudeAiOriginFromEnv || 'https://claude.ai',
    TOKEN_URL: process.env.OAUTH_PROXY_TOKEN_URL || getProxyUrl('https://platform.claude.com/v1/oauth/token'),
    API_KEY_URL: process.env.OAUTH_PROXY_API_KEY_URL || getProxyUrl('https://api.anthropic.com/api/oauth/claude_cli/create_api_key'),
    ROLES_URL: process.env.OAUTH_PROXY_ROLES_URL || getProxyUrl('https://api.anthropic.com/api/oauth/claude_cli/roles'),
    CONSOLE_SUCCESS_URL:
      process.env.OAUTH_PROXY_CONSOLE_SUCCESS_URL || 'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
    CLAUDEAI_SUCCESS_URL:
      process.env.OAUTH_PROXY_CLAUDEAI_SUCCESS_URL || 'https://platform.claude.com/oauth/code/success?app=claude-code',
    // /oauth/code/callback 是浏览器回调页面，必须指向 Anthropic 官方域名，不走代理
    MANUAL_REDIRECT_URL: process.env.OAUTH_PROXY_MANUAL_REDIRECT_URL || 'https://platform.claude.com/oauth/code/callback',
    CLIENT_ID: process.env.OAUTH_PROXY_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    // No suffix for production config
    OAUTH_FILE_SUFFIX: '',
    MCP_PROXY_URL: process.env.OAUTH_PROXY_MCP_URL || mcpProxyFromEnv || 'https://mcp-proxy.anthropic.com',
    MCP_PROXY_PATH: '/v1/mcp/{server_id}',
  }
}

/**
 * Client ID Metadata Document URL for MCP OAuth (CIMD / SEP-991).
 * When an MCP auth server advertises client_id_metadata_document_supported: true,
 * Claude Code uses this URL as its client_id instead of Dynamic Client Registration.
 * The URL must point to a JSON document hosted by Anthropic.
 * See: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

// Staging OAuth configuration - only included in ant builds with staging flag
// Uses literal check for dead code elimination
const STAGING_OAUTH_CONFIG =
  process.env.USER_TYPE === 'ant'
    ? ({
        BASE_API_URL: 'https://api-staging.anthropic.com',
        CONSOLE_AUTHORIZE_URL:
          'https://platform.staging.ant.dev/oauth/authorize',
        CLAUDE_AI_AUTHORIZE_URL:
          'https://claude-ai.staging.ant.dev/oauth/authorize',
        CLAUDE_AI_ORIGIN: 'https://claude-ai.staging.ant.dev',
        TOKEN_URL: 'https://platform.staging.ant.dev/v1/oauth/token',
        API_KEY_URL:
          'https://api-staging.anthropic.com/api/oauth/claude_cli/create_api_key',
        ROLES_URL:
          'https://api-staging.anthropic.com/api/oauth/claude_cli/roles',
        CONSOLE_SUCCESS_URL:
          'https://platform.staging.ant.dev/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
        CLAUDEAI_SUCCESS_URL:
          'https://platform.staging.ant.dev/oauth/code/success?app=claude-code',
        MANUAL_REDIRECT_URL:
          'https://platform.staging.ant.dev/oauth/code/callback',
        CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
        OAUTH_FILE_SUFFIX: '-staging-oauth',
        MCP_PROXY_URL: 'https://mcp-proxy-staging.anthropic.com',
        MCP_PROXY_PATH: '/v1/mcp/{server_id}',
      } as const)
    : undefined

// Three local dev servers: :8000 api-proxy (`api dev start -g ccr`),
// :4000 claude-ai frontend, :3000 Console frontend. Env vars let
// scripts/claude-localhost override if your layout differs.
function getLocalOauthConfig(): OauthConfig {
  const api =
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000'
  const apps =
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000'
  const consoleBase =
    process.env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.replace(/\/$/, '') ??
    'http://localhost:3000'
  return {
    BASE_API_URL: api,
    CONSOLE_AUTHORIZE_URL: `${consoleBase}/oauth/authorize`,
    CLAUDE_AI_AUTHORIZE_URL: `${apps}/oauth/authorize`,
    CLAUDE_AI_ORIGIN: apps,
    TOKEN_URL: `${api}/v1/oauth/token`,
    API_KEY_URL: `${api}/api/oauth/claude_cli/create_api_key`,
    ROLES_URL: `${api}/api/oauth/claude_cli/roles`,
    CONSOLE_SUCCESS_URL: `${consoleBase}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`,
    CLAUDEAI_SUCCESS_URL: `${consoleBase}/oauth/code/success?app=claude-code`,
    MANUAL_REDIRECT_URL: `${consoleBase}/oauth/code/callback`,
    CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
    OAUTH_FILE_SUFFIX: '-local-oauth',
    MCP_PROXY_URL: 'http://localhost:8205',
    MCP_PROXY_PATH: '/v1/toolbox/shttp/mcp/{server_id}',
  }
}

// Allowed base URLs for CLAUDE_CODE_CUSTOM_OAUTH_URL override.
// Only FedStart/PubSec deployments are permitted to prevent OAuth tokens
// from being sent to arbitrary endpoints.
const ALLOWED_OAUTH_BASE_URLS = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

// Default to prod config, override with test/staging if enabled
export function getOauthConfig(): OauthConfig {
  let config: OauthConfig = (() => {
    switch (getOauthConfigType()) {
      case 'local':
        return getLocalOauthConfig()
      case 'staging':
        return STAGING_OAUTH_CONFIG ?? getProdOauthConfig()
      case 'prod':
        return getProdOauthConfig()
    }
  })()

  // Allow overriding all OAuth URLs to point to an approved FedStart deployment.
  // Only allowlisted base URLs are accepted to prevent credential leakage.
  const oauthBaseUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  if (oauthBaseUrl) {
    const base = oauthBaseUrl.replace(/\/$/, '')
    if (!ALLOWED_OAUTH_BASE_URLS.includes(base)) {
      throw new Error(
        'CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.',
      )
    }
    config = {
      ...config,
      BASE_API_URL: base,
      CONSOLE_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_ORIGIN: base,
      TOKEN_URL: `${base}/v1/oauth/token`,
      API_KEY_URL: `${base}/api/oauth/claude_cli/create_api_key`,
      ROLES_URL: `${base}/api/oauth/claude_cli/roles`,
      CONSOLE_SUCCESS_URL: `${base}/oauth/code/success?app=claude-code`,
      CLAUDEAI_SUCCESS_URL: `${base}/oauth/code/success?app=claude-code`,
      MANUAL_REDIRECT_URL: `${base}/oauth/code/callback`,
      OAUTH_FILE_SUFFIX: '-custom-oauth',
    }
  }

  // Allow CLIENT_ID override via environment variable (e.g., for Xcode integration)
  const clientIdOverride = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config = {
      ...config,
      CLIENT_ID: clientIdOverride,
    }
  }

  return config
}
