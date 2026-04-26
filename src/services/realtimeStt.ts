import { getInitialSettings } from '../utils/settings/settings.js'
import {
  connectAliyunRealtimeStt,
  getAliyunRealtimeSttUnavailableReason,
  isAliyunRealtimeSttAvailable,
} from './aliyunRealtimeStt.js'
import {
  connectVoiceStream,
  type FinalizeSource,
  isVoiceStreamAvailable,
  type VoiceStreamCallbacks,
  type VoiceStreamConnection,
} from './voiceStreamSTT.js'

export type RealtimeSttCallbacks = VoiceStreamCallbacks
export type RealtimeSttFinalizeSource = FinalizeSource
export type RealtimeSttConnection = VoiceStreamConnection

export type RealtimeSttProvider = 'anthropic' | 'aliyun'

export function getRealtimeSttProvider(): RealtimeSttProvider {
  const provider = getInitialSettings().voiceSttProvider
  return provider === 'aliyun' ? 'aliyun' : 'anthropic'
}

export function isRealtimeSttAvailable(): boolean {
  const provider = getRealtimeSttProvider()
  if (provider === 'aliyun') {
    return isAliyunRealtimeSttAvailable()
  }
  return isVoiceStreamAvailable()
}

export function getRealtimeSttUnavailableReason(): string {
  const provider = getRealtimeSttProvider()
  if (provider === 'aliyun') {
    return getAliyunRealtimeSttUnavailableReason()
  }
  return 'Voice mode requires a Claude.ai account. Please run /login to sign in.'
}

export async function connectRealtimeStt(
  callbacks: RealtimeSttCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<RealtimeSttConnection | null> {
  const provider = getRealtimeSttProvider()

  if (provider === 'aliyun') {
    return connectAliyunRealtimeStt(callbacks, options)
  }

  return connectVoiceStream(callbacks, options)
}
