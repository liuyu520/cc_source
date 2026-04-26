/**
 * 第三方 API Provider 实现 (P0-2) — MiniMax / DeepSeek / Qwen 等。
 *
 * detect 逻辑与原 utils/model/providers.ts 中的判定保持一致：
 *   - 设置了 ANTHROPIC_BASE_URL
 *   - 且非 Anthropic 官方域名
 *   - 且设置了 ANTHROPIC_API_KEY（否则走 OAuth 代理即视为 firstParty）
 *
 * 影子模式期间不直接替代 services/api/client.ts，仅作为新路径候选。
 */

import { isFirstPartyAnthropicBaseUrl } from '../../../utils/model/providers.js'
import {
  CONSERVATIVE_DEFAULTS,
  capabilityCache,
} from '../capabilityCache.js'
import {
  looksLikeQuotaExceeded,
  translateAnthropicSdkError,
} from '../errors.js'
import type {
  Capabilities,
  CreateClientOpts,
  LLMProvider,
} from '../types.js'
import { StandardApiError } from '../types.js'

export const thirdPartyProvider: LLMProvider = {
  id: 'thirdParty',

  detect(): boolean {
    const url = process.env.ANTHROPIC_BASE_URL
    if (!url) return false
    if (isFirstPartyAnthropicBaseUrl()) return false
    // 有 API Key 才视为真正的第三方（OAuth 代理则落回 firstParty）
    return Boolean(process.env.ANTHROPIC_API_KEY)
  },

  async createClient(opts: CreateClientOpts) {
    // 真切流：复用 client.ts 的既有构造逻辑（避免重写 330 行 SDK 初始化），
    // 但带 _bypassRegistry 标记打破循环调用。第三方 provider 的 detect/
    // capability/translateError 已经在本文件集中化。
    const { getAnthropicClient } = await import('../../api/client.js')
    return getAnthropicClient({ ...opts, _bypassRegistry: true })
  },

  async probeCapabilities(model: string): Promise<Capabilities> {
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? ''
    return capabilityCache.getOrProbe(
      this.id,
      baseUrl,
      model,
      async () => {
        // 影子模式期间不发起真实探测，直接返回保守默认。
        // 切流后可在此调用 GET {baseUrl}/v1/models 等探测。
        return CONSERVATIVE_DEFAULTS
      },
      CONSERVATIVE_DEFAULTS,
    )
  },

  translateError(err: unknown): StandardApiError {
    // 1. 先做第三方特有的配额判定
    if (looksLikeQuotaExceeded(err)) {
      return new StandardApiError('quota_exceeded', false, this.id, err)
    }
    // 2. 其余走通用 Anthropic SDK 错误翻译
    return translateAnthropicSdkError(err, this.id)
  },
}
