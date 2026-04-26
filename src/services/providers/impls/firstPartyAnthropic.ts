/**
 * 第一方 Anthropic Provider 实现 (P0-2)
 *
 * detect 逻辑：默认兜底 provider —— 无 Bedrock/Vertex/Foundry/thirdParty 环境
 * 变量命中时返回 true。注册顺序要求它排在最后。
 */

import {
  CONSERVATIVE_DEFAULTS,
  capabilityCache,
} from '../capabilityCache.js'
import { translateAnthropicSdkError } from '../errors.js'
import type {
  Capabilities,
  CreateClientOpts,
  LLMProvider,
} from '../types.js'
import { StandardApiError } from '../types.js'

export const firstPartyProvider: LLMProvider = {
  id: 'firstParty',

  detect(): boolean {
    // 兜底：始终返回 true；registry 按顺序探测时作为最后一个
    return true
  },

  async createClient(opts: CreateClientOpts) {
    const { getAnthropicClient } = await import('../../api/client.js')
    return getAnthropicClient({ ...opts, _bypassRegistry: true })
  },

  async probeCapabilities(model: string): Promise<Capabilities> {
    // Anthropic 第一方：能力相对稳定，直接走保守默认。
    // 正式切流后可对接 utils/model/modelCapabilities.ts 的硬编码表。
    return capabilityCache.getOrProbe(
      this.id,
      'api.anthropic.com',
      model,
      async () => CONSERVATIVE_DEFAULTS,
      CONSERVATIVE_DEFAULTS,
    )
  },

  translateError(err: unknown): StandardApiError {
    return translateAnthropicSdkError(err, this.id)
  },
}
