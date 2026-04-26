/**
 * ProviderRegistry 运行时开关 (P0-2)
 *
 *   CLAUDE_CODE_PROVIDER_REGISTRY=1  → 启用影子/切流
 *   未设置                           → 默认禁用
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isProviderRegistryEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_PROVIDER_REGISTRY
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isProviderCapabilityProbeEnabled(): boolean {
  if (!isProviderRegistryEnabled()) return false
  const v = process.env.CLAUDE_CODE_PROVIDER_CAPABILITY_PROBE
  if (isEnvDefinedFalsy(v)) return false
  return true
}
