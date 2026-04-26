/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5.7a · LearningRateAdvisor
 *
 * 定位:
 *   mutationRateAdvisor / arenaShadowCountAdvisor 的第三号姊妹。
 *
 *   learningRate 在本仓的 ε-greedy learner 里是"Q-update 步长":
 *     q_next = q + learningRate * (reward - q)
 *   高 learningRate → 当前 evidence 主导,策略切换快
 *   低 learningRate → 历史 evidence 主导,策略切换慢
 *
 * 方向(与 mutationRate 同向):
 *   - verdict='converging' → 种群陷入 plateau,老策略 q 被历史均值锁死
 *     → 升 learningRate,让新 evidence 更快冲刷旧 Q
 *   - verdict='diverging'  → 策略剧烈抖动(新 outcome 把 q 甩来甩去)
 *     → 降 learningRate,滤掉高频噪声
 *   - 'healthy' / 'insufficient-data' → hold
 *
 *   注:有一派 DNN 直觉是"diverging 升 lr 快适应"—— 这在监督学习成立
 *   (因为 loss 可以指导方向),但在 ε-greedy 的 reward-driven 更新里,
 *   diverging 意味着 reward 噪声放大,抬 lr 只会让策略追噪声,反效果。
 *   所以这里采用与 mutation 同向的"降噪"语义,和 mutationRate 的
 *   "converge→注入多样性 / diverge→稳定"对称。
 *
 * 纪律:
 *   - 纯只读,零副作用,fail-open
 *   - 显式 opts > env > file > default
 *   - Clamp [LEARNING_RATE_MIN, LEARNING_RATE_MAX] = [0.001, 1]
 *   - clamp 后 delta==0 → direction 降级 hold
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  DEFAULT_META_GENOME,
  LEARNING_RATE_MAX,
  LEARNING_RATE_MIN,
  getEffectiveMetaGenome,
} from './metaGenome.js'
import {
  computeMetaOracleSnapshot,
} from './metaOracle.js'
import type { MetaOracleSnapshot, MetaOracleVerdict } from './metaOracle.js'

export type LearningRateDirection = 'up' | 'down' | 'hold'

export interface LearningRateAdvice {
  current: number
  suggested: number
  delta: number
  direction: LearningRateDirection
  reason: string
  verdict: MetaOracleVerdict
  stepUp: number
  stepDown: number
  applyHint: string | null
}

export interface LearningRateAdvisorOptions {
  snapshot?: MetaOracleSnapshot
  currentOverride?: number
  stepUp?: number
  stepDown?: number
}

// learningRate 动态范围 [0.001, 1],默认步长 0.1。
// step clamp [0.0001, 0.5]:最小 0.0001 保证在 LEARNING_RATE_MIN=0.001 时
// 仍能 round-trip 造出 1 step 的 delta;上限 0.5 避免单步过度。
const DEFAULT_STEP = 0.1
const STEP_MIN = 0.0001
const STEP_MAX = 0.5

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

export function advocateLearningRate(
  opts: LearningRateAdvisorOptions = {},
): LearningRateAdvice {
  const stepUp = envStep(
    'CLAUDE_EVOLVE_META_LEARNING_STEP_UP',
    sanitizeStep(opts.stepUp, DEFAULT_STEP),
  )
  const stepDown = envStep(
    'CLAUDE_EVOLVE_META_LEARNING_STEP_DOWN',
    sanitizeStep(opts.stepDown, DEFAULT_STEP),
  )

  let current: number
  try {
    if (
      opts.currentOverride !== undefined &&
      Number.isFinite(opts.currentOverride)
    ) {
      current = clamp(opts.currentOverride, LEARNING_RATE_MIN, LEARNING_RATE_MAX)
    } else {
      current = getEffectiveMetaGenome().learningRate
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:learningRateAdvisor] getEffectiveMetaGenome failed: ${(e as Error).message}`,
    )
    current = DEFAULT_META_GENOME.learningRate
  }

  let snapshot: MetaOracleSnapshot | null = null
  try {
    snapshot = opts.snapshot ?? computeMetaOracleSnapshot()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:learningRateAdvisor] computeMetaOracleSnapshot failed: ${(e as Error).message}`,
    )
    snapshot = null
  }

  const verdict: MetaOracleVerdict = snapshot?.verdict ?? 'insufficient-data'

  let proposed = current
  let direction: LearningRateDirection = 'hold'
  let reason: string

  switch (verdict) {
    case 'converging':
      proposed = current + stepUp
      direction = 'up'
      reason = `population converging (${snapshot?.verdictReason ?? 'n/a'}); raise learningRate so new evidence displaces stale Q`
      break
    case 'diverging':
      proposed = current - stepDown
      direction = 'down'
      reason = `population diverging (${snapshot?.verdictReason ?? 'n/a'}); lower learningRate to filter reward noise`
      break
    case 'healthy':
      direction = 'hold'
      reason = `population healthy (${snapshot?.verdictReason ?? 'n/a'}); hold learningRate`
      break
    case 'insufficient-data':
    default:
      direction = 'hold'
      reason = `insufficient data (${snapshot?.verdictReason ?? 'snapshot missing'}); hold learningRate`
      break
  }

  const suggested = clamp(proposed, LEARNING_RATE_MIN, LEARNING_RATE_MAX)
  const delta = suggested - current

  if (direction === 'up' && suggested <= current) {
    direction = 'hold'
    reason = `converging but learningRate already at ceiling (${LEARNING_RATE_MAX}); hold`
  } else if (direction === 'down' && suggested >= current) {
    direction = 'hold'
    reason = `diverging but learningRate already at floor (${LEARNING_RATE_MIN}); hold`
  }

  const applyHint =
    direction === 'hold'
      ? null
      : `export CLAUDE_EVOLVE_META_LEARNING_RATE=${suggested.toFixed(4)}`

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
