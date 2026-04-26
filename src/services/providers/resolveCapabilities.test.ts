import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearResolveCapabilitiesCache,
  clearRuntimeCapabilityOverrides,
  resolveCapabilities,
  setRuntimeCapabilityOverride,
} from './resolveCapabilities.js'

const MODEL = 'us.anthropic.claude-sonnet-4-6'

const ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROVIDER_CAPABILITIES',
] as const

const originalEnv = new Map<string, string | undefined>()

describe('resolveCapabilities runtime overrides', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }

    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    clearRuntimeCapabilityOverrides()
    clearResolveCapabilitiesCache()
  })

  afterEach(() => {
    clearRuntimeCapabilityOverrides()
    clearResolveCapabilitiesCache()

    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    originalEnv.clear()
  })

  test('locks a Bedrock model to non-streaming in the current process', () => {
    expect(resolveCapabilities(MODEL, undefined).supportsStreaming).toBe(true)

    setRuntimeCapabilityOverride(MODEL, undefined, {
      supportsStreaming: false,
    })

    expect(resolveCapabilities(MODEL, undefined).supportsStreaming).toBe(false)
  })

  test('restores default capabilities after clearing runtime overrides', () => {
    setRuntimeCapabilityOverride(MODEL, undefined, {
      supportsStreaming: false,
    })
    expect(resolveCapabilities(MODEL, undefined).supportsStreaming).toBe(false)

    clearRuntimeCapabilityOverrides()

    expect(resolveCapabilities(MODEL, undefined).supportsStreaming).toBe(true)
  })
})
