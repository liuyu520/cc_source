import { useAppState } from '../state/AppState.js'
import { isRealtimeSttAvailable } from '../services/realtimeStt.js'
import { isVoiceGrowthBookEnabled } from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with provider availability and
 * the GrowthBook kill-switch. Availability is checked through the shared
 * realtime STT gateway so Anthropic and third-party providers use one path.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  return userIntent && isRealtimeSttAvailable() && isVoiceGrowthBookEnabled()
}
