/**
 * Model Router — 公共 API
 *
 * 统一对外导出，上层只 import from './modelRouter'。
 */

export { modelRouter } from './router.js'
export {
  isModelRouterEnabled,
  isModelRouterEnforceMode,
  isModelRouterFallbackEnabled,
} from './featureCheck.js'
export { healthTracker } from './healthTracker.js'
export { costTracker } from './costTracker.js'
export {
  getProviderMatrix,
  getProviderByName,
  reloadProviderMatrix,
} from './providerMatrix.js'
export type {
  ProviderConfig,
  ProviderCapability,
  ProviderTier,
  ProviderHealth,
  RouteDecision,
  RouterTelemetry,
  RouteContext,
  RouteIntent,
  RouteIntentResult,
  TaskComplexity,
  RouteRcaPhase,
} from './types.js'
