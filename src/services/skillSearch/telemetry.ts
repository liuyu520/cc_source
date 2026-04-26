import { logEvent } from '../analytics/index.js'

type SkillSearchTelemetry = {
  phase: 'turn0' | 'collect'
  signalType: string
  resultCount: number
  latencyMs: number
  hiddenByMainTurn?: boolean
  source: 'native' | 'remote' | 'both'
}

type RemoteSkillLoadedTelemetry = {
  slug: string
  cacheHit: boolean
  latencyMs: number
  urlScheme: string
  fileCount?: number
  totalBytes?: number
  fetchMethod?: string
  error?: string
}

export function logSkillSearchTelemetry(params: SkillSearchTelemetry): void {
  logEvent('tengu_skill_search', {
    phase: params.phase,
    signal_type: params.signalType,
    result_count: params.resultCount,
    latency_ms: params.latencyMs,
    hidden_by_main_turn: params.hiddenByMainTurn ?? false,
    source: params.source,
  })
}

export function logRemoteSkillLoaded(
  params: RemoteSkillLoadedTelemetry,
): void {
  logEvent('tengu_remote_skill_loaded', {
    slug: params.slug,
    cache_hit: params.cacheHit,
    latency_ms: params.latencyMs,
    url_scheme: params.urlScheme,
    file_count: params.fileCount,
    total_bytes: params.totalBytes,
    fetch_method: params.fetchMethod,
    error: params.error,
  })
}
