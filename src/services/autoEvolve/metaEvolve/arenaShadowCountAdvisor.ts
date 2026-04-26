/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5.6 · ArenaShadowCountAdvisor
 *
 * 定位:
 *   Phase 5.4 的姊妹建议器。mutationRate 控"单个体内变化量",
 *   arenaShadowCount 控"同时活跃的 shadow fork 数"——两者都是"探索宽度"
 *   的元杠杆,但一个是强度,一个是并行度。
 *
 *   verdict='converging' → 种群陷入局部最优 → 加 shadow(多条 fork 同时探)
 *   verdict='diverging'  → 种群波动太大 → 减 shadow(资源/抖动都先降)
 *   verdict='healthy' / 'insufficient-data' → hold
 *
 *   整数值,默认 step=1。clamp 到 [ARENA_SHADOW_COUNT_MIN,
 *   ARENA_SHADOW_COUNT_MAX] = [0, 8](对齐 arenaController.MAX_PARALLEL_ARENAS)。
 *
 * 纪律:与 mutationRateAdvisor 对齐
 *   - 纯只读:既不写 meta-genome.json,也不改 env
 *   - fail-open:任何错误 → direction='hold',current 保底为默认 3
 *   - 显式 opts > env > file > default(与 feedback_signal_to_decision_priority_stack 对齐)
 *   - clamp 后 delta==0 → direction 降级 hold + 原因注释,绝不静默吞
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  ARENA_SHADOW_COUNT_MAX,
  ARENA_SHADOW_COUNT_MIN,
  DEFAULT_META_GENOME,
  getEffectiveMetaGenome,
} from './metaGenome.js'
import {
  computeMetaOracleSnapshot,
} from './metaOracle.js'
import type { MetaOracleSnapshot, MetaOracleVerdict } from './metaOracle.js'

export type ArenaShadowCountDirection = 'up' | 'down' | 'hold'

export interface ArenaShadowCountAdvice {
  /** 当前生效的 arenaShadowCount(整数) */
  current: number
  /** 建议值(已 clamp + round 到整数) */
  suggested: number
  /** suggested - current(clamp 后) */
  delta: number
  /** 方向:up / down / hold */
  direction: ArenaShadowCountDirection
  /** 人类可读理由 */
  reason: string
  /** 触发本建议的 metaOracle verdict */
  verdict: MetaOracleVerdict
  /** 本次使用的 stepUp / stepDown(整数) */
  stepUp: number
  stepDown: number
  /** 若建议生效,推荐的实施命令(env override);hold 时为 null */
  applyHint: string | null
}

export interface ArenaShadowCountAdvisorOptions {
  /** 若给了 snapshot,则直接用;否则会调用 computeMetaOracleSnapshot() */
  snapshot?: MetaOracleSnapshot
  /** 覆盖 "当前值";否则通过 getEffectiveMetaGenome() 读 */
  currentOverride?: number
  /** 上调步长,默认 1;非整数会向上 round */
  stepUp?: number
  /** 下调步长,默认 1;非整数会向上 round */
  stepDown?: number
}

// step 为整数,最小 1,最大 = 全量程(从 0 跳到 MAX)
const DEFAULT_STEP = 1
const STEP_MIN = 1
const STEP_MAX = ARENA_SHADOW_COUNT_MAX - ARENA_SHADOW_COUNT_MIN // 8

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  const r = Math.round(v)
  return Math.min(hi, Math.max(lo, r))
}

function sanitizeStep(v: number | undefined, def: number): number {
  if (v === undefined || !Number.isFinite(v)) return def
  // step 至少是 1,向上 round 保证 1.5 → 2 而不是 0(1 都不动等于 hold)
  const r = Math.max(1, Math.ceil(v))
  return Math.min(STEP_MAX, Math.max(STEP_MIN, r))
}

function envStep(key: string, def: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return sanitizeStep(n, def)
}

/**
 * 基于 metaOracle.verdict 建议 arenaShadowCount 调整方向。
 * 纯函数 + fail-open:任何错误 → direction='hold',current 保底。
 */
export function advocateArenaShadowCount(
  opts: ArenaShadowCountAdvisorOptions = {},
): ArenaShadowCountAdvice {
  // ── step(env > opts > default) ─────────────────────────────
  // env 优先的理由与 mutationRateAdvisor 一致:env 代表 ops 层临时调整,
  // 应该压过代码默认。
  const stepUp = envStep(
    'CLAUDE_EVOLVE_META_SHADOW_STEP_UP',
    sanitizeStep(opts.stepUp, DEFAULT_STEP),
  )
  const stepDown = envStep(
    'CLAUDE_EVOLVE_META_SHADOW_STEP_DOWN',
    sanitizeStep(opts.stepDown, DEFAULT_STEP),
  )

  // ── current ─────────────────────────────────────────────────
  let current: number
  try {
    if (
      opts.currentOverride !== undefined &&
      Number.isFinite(opts.currentOverride)
    ) {
      current = clampInt(
        opts.currentOverride,
        ARENA_SHADOW_COUNT_MIN,
        ARENA_SHADOW_COUNT_MAX,
      )
    } else {
      current = getEffectiveMetaGenome().arenaShadowCount
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arenaShadowCountAdvisor] getEffectiveMetaGenome failed: ${(e as Error).message}`,
    )
    current = DEFAULT_META_GENOME.arenaShadowCount // 默认 3
  }

  // ── snapshot ────────────────────────────────────────────────
  let snapshot: MetaOracleSnapshot | null = null
  try {
    snapshot = opts.snapshot ?? computeMetaOracleSnapshot()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:arenaShadowCountAdvisor] computeMetaOracleSnapshot failed: ${(e as Error).message}`,
    )
    snapshot = null
  }

  const verdict: MetaOracleVerdict = snapshot?.verdict ?? 'insufficient-data'

  // ── 决策 ────────────────────────────────────────────────────
  let proposed = current
  let direction: ArenaShadowCountDirection = 'hold'
  let reason: string

  switch (verdict) {
    case 'converging':
      proposed = current + stepUp
      direction = 'up'
      reason = `population converging (${snapshot?.verdictReason ?? 'n/a'}); add shadow forks to widen exploration`
      break
    case 'diverging':
      proposed = current - stepDown
      direction = 'down'
      reason = `population diverging (${snapshot?.verdictReason ?? 'n/a'}); reduce shadow forks to conserve resources and stabilize`
      break
    case 'healthy':
      direction = 'hold'
      reason = `population healthy (${snapshot?.verdictReason ?? 'n/a'}); hold arenaShadowCount`
      break
    case 'insufficient-data':
    default:
      direction = 'hold'
      reason = `insufficient data (${snapshot?.verdictReason ?? 'snapshot missing'}); hold arenaShadowCount`
      break
  }

  const suggested = clampInt(
    proposed,
    ARENA_SHADOW_COUNT_MIN,
    ARENA_SHADOW_COUNT_MAX,
  )
  const delta = suggested - current

  // Clamp 顶到 ceiling(8)/floor(0) → direction 降 hold
  if (direction === 'up' && suggested <= current) {
    direction = 'hold'
    reason = `converging but arenaShadowCount already at ceiling (${ARENA_SHADOW_COUNT_MAX}); hold`
  } else if (direction === 'down' && suggested >= current) {
    direction = 'hold'
    reason = `diverging but arenaShadowCount already at floor (${ARENA_SHADOW_COUNT_MIN}); hold`
  }

  // applyHint:环境变量实施(不自动落盘)
  const applyHint =
    direction === 'hold'
      ? null
      : `export CLAUDE_EVOLVE_META_ARENA_SHADOW_COUNT=${suggested}`

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
