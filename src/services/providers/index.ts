/**
 * Provider 插件化入口 (P0-2)
 *
 * 使用示例：
 *
 *   import { getProvider } from 'src/services/providers/index.js'
 *
 *   const provider = getProvider()
 *   const client = await provider.createClient({ maxRetries: 3 })
 *   try {
 *     const resp = await client.messages.create(...)
 *   } catch (err) {
 *     const std = provider.translateError(err)
 *     if (std.code === 'quota_exceeded') { ... }
 *   }
 */

import { bootstrapProviders } from './bootstrap.js'

// 导入即完成默认注册
bootstrapProviders()

export type {
  LLMProvider,
  ProviderId,
  Capabilities,
  CreateClientOpts,
  StandardErrorCode,
} from './types.js'
export { StandardApiError } from './types.js'
export {
  getProvider,
  getProviderById,
  registerProvider,
  providerRegistry,
} from './registry.js'
export { capabilityCache, CONSERVATIVE_DEFAULTS } from './capabilityCache.js'
export {
  translateAnthropicSdkError,
  translateHttpStatus,
  looksLikeQuotaExceeded,
} from './errors.js'
export { resolveModelRole, type ModelRole } from './routing.js'
export {
  isProviderRegistryEnabled,
  isProviderCapabilityProbeEnabled,
} from './featureCheck.js'
