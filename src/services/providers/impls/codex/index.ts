/**
 * Codex Provider — 通过 OpenAI Responses API 调用 OpenAI/Codex 兼容 LLM
 *
 * 启用方式：设置环境变量 CLAUDE_CODE_USE_CODEX=1
 * 认证来源：~/.codex/auth.json（Codex CLI 的原生认证文件）
 *
 * 该 Provider 在 bootstrap 时注册，优先级在 thirdParty 之前：
 *   Bedrock > Vertex > Foundry > Codex > thirdParty > firstParty
 */

import type Anthropic from '@anthropic-ai/sdk'
import { isEnvTruthy } from '../../../../utils/envUtils.js'
import type {
  CreateClientOpts,
  LLMProvider,
} from '../../types.js'
import { StandardApiError } from '../../types.js'
import type { ProviderCapabilities } from '../../providerCapabilities.js'
import { createCodexAdapter } from './adapter.js'
import { loadCodexCredentials, loadCodexConfig, resolveCodexModel } from './auth.js'
import { isCodexReasoningModel, normalizeCodexModelName } from './models.js'

// OpenAI 模型上下文窗口大小映射
const OPENAI_MODEL_CONTEXT: Record<string, number> = {
  'gpt-5.5': 1_000_000,
  'gpt-5.4': 1_000_000,
  'gpt-5.4-mini': 1_000_000,
  'gpt-5.3-codex': 1_000_000,
  'gpt-5.3-codex-spark': 1_000_000,
  'gpt-5.2': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
}

function getOpenAIModelContextTokens(model: string): number {
  const normalized = normalizeCodexModelName(model)
  // 精确匹配
  if (OPENAI_MODEL_CONTEXT[normalized]) return OPENAI_MODEL_CONTEXT[normalized]
  // 前缀匹配（兼容带日期后缀的模型名如 gpt-4o-2024-11-20）
  for (const [prefix, tokens] of Object.entries(OPENAI_MODEL_CONTEXT)) {
    if (normalized.startsWith(prefix)) return tokens
  }
  return 200_000 // 默认值
}

export const codexProvider: LLMProvider = {
  id: 'codex',

  /**
   * 能力声明（权威来源）— 解决"分裂脑"问题
   * 直接被 resolveCapabilities() Layer 4.5 使用，
   * 优先级高于磁盘缓存 (Layer 5) 和域名预设 (Layer 6)。
   *
   * 注意：maxContextTokens 在 probeCapabilities() 中按模型动态判定
   */
  capabilityDeclaration: {
    supportsThinking: true,       // o1/o3 支持 reasoning
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsEffort: true,         // reasoning effort levels
    supportsMaxEffort: false,
    supportsPromptCache: false,   // OpenAI 自动缓存，不需要显式 cache_control
    supports1M: true,             // gpt-4.1 支持 1M context
    supportsToolSearch: false,
    supportsStreaming: true,
    supportsVision: true,
    maxContextTokens: 200_000,    // 默认值，probeCapabilities 会按模型覆盖
    supportedBetas: [],           // 不使用 Anthropic beta headers
  } satisfies ProviderCapabilities,

  detect(): boolean {
    return isEnvTruthy(process.env.CLAUDE_CODE_USE_CODEX)
  },

  async createClient(opts: CreateClientOpts): Promise<Anthropic> {
    // 加载 Codex 认证凭证
    const credentials = await loadCodexCredentials()
    if (!credentials) {
      throw new Error(
        '[codex-provider] No credentials found. Set CODEX_API_KEY/OPENAI_API_KEY env var, or login via Codex CLI (codex login).',
      )
    }

    // 加载 Codex 配置
    const config = loadCodexConfig()

    // 确定 API base URL
    // OAuth 模式优先级：OPENAI_BASE_URL env > openai_base_url config > chatgpt_base_url config > 默认值
    // API Key 模式优先级：OPENAI_BASE_URL env > openai_base_url config > 默认值
    const isOAuthMode = credentials.tokenType === 'oauth_access_token'
    const baseUrl =
      process.env.OPENAI_BASE_URL ??
      config?.baseUrl ??
      (isOAuthMode ? config?.chatgptBaseUrl : undefined) ??
      'https://api.openai.com/v1'

    // 确定模型名称 —— 委托给 auth.ts 的单真相源 resolveCodexModel
    // OAuth 模式忽略 opts.model（主循环传入的 claude-* 模型名不适用于 OpenAI API），
    // API Key 模式 opts.model 最高优先级。
    // 展示层（prompts.ts getCodexModelDescription）调用同一函数，彻底消除展示/执行漂移。
    const model = await resolveCodexModel(opts.model)

    // 创建适配器
    const adapter = createCodexAdapter({
      baseUrl,
      credentials,
      model,
      accountId: credentials.accountId,
      maxRetries: opts.maxRetries ?? 3,
    })

    return adapter as unknown as Anthropic
  },

  async probeCapabilities(model: string): Promise<Partial<ProviderCapabilities>> {
    // 按模型动态判定上下文窗口大小和能力
    const contextTokens = getOpenAIModelContextTokens(model)
    const supportsThinking = isCodexReasoningModel(model)
    return {
      maxContextTokens: contextTokens,
      supportsThinking,
      supportsPromptCache: false,
      supportsStreaming: true,
      supportsVision: true,
      supportsEffort: supportsThinking,
      supportsAdaptiveThinking: false,
      supportsInterleavedThinking: false,
      supportsMaxEffort: false,
      supports1M: contextTokens >= 1_000_000,
      supportsToolSearch: false,
      supportedBetas: [],
    }
  },

  translateError(err: unknown): StandardApiError {
    // 提取 HTTP status
    const status =
      (err as Record<string, unknown>)?.status ??
      (err as Record<string, unknown>)?.statusCode

    if (typeof status === 'number') {
      switch (status) {
        case 401:
        case 403:
          return new StandardApiError('auth', false, 'codex', err,
            `[codex] Authentication failed (${status}). Check your Codex credentials.`)
        case 402:
          // HTTP 402 Payment Required — OpenAI 计费问题，映射为 quota_exceeded 触发备用 API 切换
          return new StandardApiError('quota_exceeded', false, 'codex', err,
            `[codex] Payment required (402). Quota may be exceeded.`)
        case 429: {
          // 区分 rate_limit 和 quota_exceeded：检查错误 body 是否包含配额相关关键词
          const errMsg = String((err as Error)?.message ?? '')
          if (errMsg.includes('quota') || errMsg.includes('limit') && errMsg.includes('exceeded')
            || errMsg.includes('billing') || errMsg.includes('insufficient_quota')) {
            return new StandardApiError('quota_exceeded', false, 'codex', err,
              `[codex] Quota exceeded. Will try backup API if available.`)
          }
          return new StandardApiError('rate_limit', true, 'codex', err,
            `[codex] Rate limited. Will retry.`)
        }
        case 500:
        case 502:
        case 503:
          return new StandardApiError('server', true, 'codex', err,
            `[codex] Server error (${status}). Will retry.`)
        case 529:
          return new StandardApiError('overloaded', true, 'codex', err,
            `[codex] Server overloaded. Will retry.`)
        case 400: {
          // 检查是否是上下文长度超限
          const msg = String((err as Error)?.message ?? '')
          if (msg.includes('context_length') || msg.includes('max_tokens')) {
            return new StandardApiError('context_length', false, 'codex', err)
          }
          return new StandardApiError('bad_request', false, 'codex', err)
        }
        default:
          if (status >= 400 && status < 500) {
            return new StandardApiError('bad_request', false, 'codex', err)
          }
          return new StandardApiError('server', true, 'codex', err)
      }
    }

    // 网络错误
    const code = (err as Record<string, unknown>)?.code
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND'
    ) {
      return new StandardApiError('network', true, 'codex', err,
        `[codex] Network error: ${code}`)
    }

    // 默认：可重试的服务端错误
    return new StandardApiError('server', true, 'codex', err)
  },

  async refreshAuth(): Promise<void> {
    // 触发凭证重新加载（清除缓存，下次 loadCodexCredentials 时会重新读取文件）
    const { clearCredentialsCache } = await import('./auth.js')
    clearCredentialsCache()
  },
}
