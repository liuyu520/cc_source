/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5.7b · SelectionPressureAdvisor
 *
 * 定位:
 *   与其它三个 advisor(mutationRate / arenaShadowCount / learningRate)
 *   平级,但**方向相反**:
 *
 *     selectionPressure = "在 fitness 排序下,高分被选中的陡峭度"
 *       (≈ softmax temperature 的倒数;或 top-k 淘汰强度的代理)
 *
 *     - 高 pressure:只留 top,淘汰快 → 种群快速收敛
 *     - 低 pressure:弱者也能留一代 → 种群保持多样性
 *
 *   所以规则是:
 *     - verdict='converging' → **降 pressure**(放生弱者,避免进一步收敛)
 *     - verdict='diverging'  → **升 pressure**(加速淘汰不稳定个体,回拉能力中位数)
 *     - healthy / insufficient-data → hold
 *
 *   这是 meta-evolution 里"负反馈"的关键来源之一:
 *   mutation/shadow/learning 三把"探索杠杆"同向(converge→up),
 *   selection 这把"收敛杠杆"反向(converge→down),
 *   形成天然的多样性/稳定 push-pull 平衡。
 *
 * 纪律:与其它 advisor 对齐
 *   - 纯只读,零副作用,fail-open
 *   - 显式 opts > env > file > default
 *   - Clamp [SELECTION_PRESSURE_MIN, SELECTION_PRESSURE_MAX] = [0.25, 4]
 *   - clamp 后 delta==0 → direction 降级 hold
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  DEFAULT_META_GENOME,
  SELECTION_PRESSURE_MAX,
  SELECTION_PRESSURE_MIN,
  getEffectiveMetaGenome,
} from './metaGenome.js'
import {
  computeMetaOracleSnapshot,
} from './metaOracle.js'
import type { MetaOracleSnapshot, MetaOracleVerdict } from './metaOracle.js'

export type SelectionPressureDirection = 'up' | 'down' | 'hold'

export interface SelectionPressureAdvice {
  current: number
  suggested: number
  delta: number
  direction: SelectionPressureDirection
  reason: string
  verdict: MetaOracleVerdict
  stepUp: number
  stepDown: number
  applyHint: string | null
}

export interface SelectionPressureAdvisorOptions {
  snapshot?: MetaOracleSnapshot
  currentOverride?: number
  stepUp?: number
  stepDown?: number
}

// selectionPressure 动态范围 [0.25, 4],步长默认 0.25(= 最小值也 = 默认跨度)。
// 这让 default 3 步就能覆盖 0.25 → 1.0 → 1.75 → 2.5 → 3.25 → 4,粒度够用。
const DEFAULT_STEP = 0.25
const STEP_MIN = 0.05
const STEP_MAX = 1.0 // 单步最多走 1/4 全量程,避免剧烈切换

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

function sanitizeStep(v: number | undefined, def: number): number {
  if (v === undefined || !Number.isFinite(v)) return def
  return clamp(v, STEP_MIN, STEP_MAX)
}

function envStep(key: string, def: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return clamp(n, STEP_MIN, STEP_MAX)
}

export function advocateSelectionPressure(
  opts: SelectionPressureAdvisorOptions = {},
): SelectionPressureAdvice {
  const stepUp = envStep(
    'CLAUDE_EVOLVE_META_PRESSURE_STEP_UP',
    sanitizeStep(opts.stepUp, DEFAULT_STEP),
  )
  const stepDown = envStep(
    'CLAUDE_EVOLVE_META_PRESSURE_STEP_DOWN',
    sanitizeStep(opts.stepDown, DEFAULT_STEP),
  )

  let current: number
  try {
    if (
      opts.currentOverride !== undefined &&
      Number.isFinite(opts.currentOverride)
    ) {
      current = clamp(
        opts.currentOverride,
        SELECTION_PRESSURE_MIN,
        SELECTION_PRESSURE_MAX,
      )
    } else {
      current = getEffectiveMetaGenome().selectionPressure
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:selectionPressureAdvisor] getEffectiveMetaGenome failed: ${(e as Error).message}`,
    )
    current = DEFAULT_META_GENOME.selectionPressure
  }

  let snapshot: MetaOracleSnapshot | null = null
  try {
    snapshot = opts.snapshot ?? computeMetaOracleSnapshot()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:selectionPressureAdvisor] computeMetaOracleSnapshot failed: ${(e as Error).message}`,
    )
    snapshot = null
  }

  const verdict: MetaOracleVerdict = snapshot?.verdict ?? 'insufficient-data'

  let proposed = current
  let direction: SelectionPressureDirection = 'hold'
  let reason: string

  switch (verdict) {
    // ⚠ 与其它 advisor 反向:converging 时要**降** pressure 注入多样性
    case 'converging':
      proposed = current - stepDown
      direction = 'down'
      reason = `population converging (${snapshot?.verdictReason ?? 'n/a'}); relax selection pressure to spare weaker variants and preserve diversity`
      break
    // ⚠ diverging 时要**升** pressure 加速淘汰,稳定中位数
    case 'diverging':
      proposed = current + stepUp
      direction = 'up'
      reason = `population diverging (${snapshot?.verdictReason ?? 'n/a'}); tighten selection pressure to cull unstable variants faster`
      break
    case 'healthy':
      direction = 'hold'
      reason = `population healthy (${snapshot?.verdictReason ?? 'n/a'}); hold selectionPressure`
      break
    case 'insufficient-data':
    default:
      direction = 'hold'
      reason = `insufficient data (${snapshot?.verdictReason ?? 'snapshot missing'}); hold selectionPressure`
      break
  }

  const suggested = clamp(
    proposed,
    SELECTION_PRESSURE_MIN,
    SELECTION_PRESSURE_MAX,
  )
  const delta = suggested - current

  if (direction === 'up' && suggested <= current) {
    direction = 'hold'
    reason = `diverging but selectionPressure already at ceiling (${SELECTION_PRESSURE_MAX}); hold`
  } else if (direction === 'down' && suggested >= current) {
    direction = 'hold'
    reason = `converging but selectionPressure already at floor (${SELECTION_PRESSURE_MIN}); hold`
  }

  const applyHint =
    direction === 'hold'
      ? null
      : `export CLAUDE_EVOLVE_META_SELECTION_PRESSURE=${suggested.toFixed(2)}`

  return {
    current,
    suggested,
    delta,
    direction,
    reason,
    verdict,
    stepUp,
    stepDown,
    applyHint,
  }
}
