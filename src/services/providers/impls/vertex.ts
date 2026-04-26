/**
 * Vertex Provider 实现 (P0-2) — 影子模式期间委托既有 getAnthropicClient()。
 */

import { isEnvTruthy } from '../../../utils/envUtils.js'
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

export const vertexProvider: LLMProvider = {
  id: 'vertex',

  detect(): boolean {
    return isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
  },

  async createClient(opts: CreateClientOpts) {
    const { getAnthropicClient } = await import('../../api/client.js')
    return getAnthropicClient({ ...opts, _bypassRegistry: true })
  },

  async probeCapabilities(model: string): Promise<Capabilities> {
    return capabilityCache.getOrProbe(
      this.id,
      'vertex',
      model,
      async () => CONSERVATIVE_DEFAULTS,
      CONSERVATIVE_DEFAULTS,
    )
  },

  translateError(err: unknown): StandardApiError {
    return translateAnthropicSdkError(err, this.id)
  },
}
