import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isRealtimeSttAvailable } from '../services/realtimeStt.js'

/**
 * Kill-switch check for voice mode. Returns true unless the
 * `tengu_amber_quartz_disabled` GrowthBook flag is flipped on (emergency
 * off). Default `false` means a missing/stale disk cache reads as "not
 * killed" — so fresh installs get voice working immediately without
 * waiting for GrowthBook init. Use this for deciding whether voice mode
 * should be *visible* (e.g., command registration, config UI).
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // Positive ternary pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  return feature('VOICE_MODE')
    ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
    : false
}

/**
 * Provider availability check for voice mode. Anthropic continues to use the
 * existing OAuth-backed voice_stream availability logic; third-party realtime
 * STT providers can expose their own env/config-based availability here.
 */
export function hasVoiceAuth(): boolean {
  return isRealtimeSttAvailable()
}

/**
 * Full runtime check: provider availability + GrowthBook kill-switch.
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}
