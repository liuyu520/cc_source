import { isEnvTruthy } from '../../utils/envUtils.js'

export type ProceduralMode = 'off' | 'shadow' | 'on'

export function getProceduralMode(): ProceduralMode {
  const raw = (process.env.CLAUDE_PROCEDURAL ?? '').trim().toLowerCase()
  // Explicit disable path: CLAUDE_PROCEDURAL=off | 0 | false | no
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off'
  if (raw === 'shadow') return 'shadow'
  if (raw === 'on' || isEnvTruthy(raw)) return 'on'
  // Default: shadow — record candidate macros to disk but never promote.
  // Zero behavior change for agent loop; only adds candidate files under
  // <auto-memory>/procedural/candidates/ so `/procedures list` has content.
  return 'shadow'
}

export function isProceduralEnabled(): boolean {
  return getProceduralMode() !== 'off'
}

export function isProceduralShadowMode(): boolean {
  return getProceduralMode() === 'shadow'
}

export function isProceduralPromoteEnabled(): boolean {
  return getProceduralMode() === 'on'
}
