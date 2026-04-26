/**
 * Tiered Context Rehydration — 公共 API
 */

export { contextTierManager } from './tierManager.js'
export {
  isTieredContextEnabled,
  isRehydrateEnabled,
  isAutoRehydrateEnabled,
} from './featureCheck.js'
export type {
  TierEntry,
  TierIndex,
  RehydrateResult,
} from './types.js'
