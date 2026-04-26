/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5.4 · MutationRateAdvisor
 *
 * 定位:
 *   blueprint §5 Phase 5 要求"metaOracle 根据种群状态反馈调整元基因"。
 *   本模块是这条回路的**建议器**(非执行器):纯函数 + 零副作用,根据
 *   metaOracle snapshot 的 verdict 建议 mutationRate 的下一步方向,
 *   附带 env override 命令,让人工或上层脚本自行决定是否落地。
 *
 * 纪律:
 *   - 只读不写:既不写 meta-genome.json,也不改 env。Phase 5.5+ 才考虑
 *     灰度自动应用。
 *   - fail-open:snapshot/metagenome 读取失败 → 维持当前值,direction='hold'。
 *   - 显式 opts > env > file > default(与 feedback_signal_to_decision_priority_stack 对齐)。
 *   - clamp 到 [0, 1],到达天花板/地板时 direction='hold' 并给出原因,
 *     避免静默吞掉"想变但不能变"的信号。
 *
 * 规则:
 *   - verdict='converging' → suggested = clamp(current + stepUp)
 *   - verdict='diverging'  → suggested = clamp(current - stepDown)
 *   - verdict='healthy' 或 'insufficient-data' → hold
 *   - 若 clamp 把 delta 顶成 0 → direction='hold' + reason 解释
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  MUTATION_RATE_MAX,
  MUTATION_RATE_MIN,
  getEffectiveMetaGenome,
} from './metaGenome.js'
import {
  computeMetaOracleSnapshot,
} from './metaOracle.js'
import type { MetaOracleSnapshot, MetaOracleVerdict } from './metaOracle.js'

export type MutationRateDirection = 'up' | 'down' | 'hold'

export interface MutationRateAdvice {
  /** 当前生效的 mutationRate(未应用建议之前) */
  current: number
  /** 建议值(已 clamp 到 [0,1]) */
  suggested: number
  /** suggested - current(clamp 后) */
  delta: number
  /** 方向:up / down / hold */
  direction: MutationRateDirection
  /** 人类可读理由 */
  reason: string
  /** 触发本建议的 metaOracle verdict */
  verdict: MetaOracleVerdict
  /** 本次使用的 stepUp / stepDown */
  stepUp: number
  stepDown: number
  /** 若建议生效,推荐的实施命令(env override);hold 时为 null */
  applyHint: string | null
}

export interface MutationRateAdvisorOptions {
  /** 若给了 snapshot,则直接用;否则会调用 computeMetaOracleSnapshot() */
  snapshot?: MetaOracleSnapshot
  /** 覆盖 "当前值";否则通过 getEffectiveMetaGenome() 读 */
  currentOverride?: number
  /** 上调步长,默认 0.1 */
  stepUp?: number
  /** 下调步长,默认 0.1 */
  stepDown?: number
}

const DEFAULT_STEP = 0.1
const STEP_MIN = 0.001
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

/**
 * 基于 metaOracle.verdict 建议 mutationRate 调整方向。
 * 纯函数 + fail-open:任何错误 → direction='hold',current 保底。
 */
export function advocateMutationRate(
  opts: MutationRateAdvisorOptions = {},
): MutationRateAdvice {
  // ── step(env > opts > default) ─────────────────────────────
  // 注意:env 优先是因为 env 代表 ops 层人工选择的"这次不要那么激进",
  // 应该压过传入的代码默认;与决策点优先级栈一致。
  const stepUp = envStep(
    'CLAUDE_EVOLVE_META_MUTATION_STEP_UP',
    sanitizeStep(opts.stepUp, DEFAULT_STEP),
  )
  const stepDown = envStep(
    'CLAUDE_EVOLVE_META_MUTATION_STEP_DOWN',
    sanitizeStep(opts.stepDown, DEFAULT_STEP),
  )

  // ── current ─────────────────────────────────────────────────
  let current: number
  try {
    if (opts.currentOverride !== undefined && Number.isFinite(opts.currentOverride)) {
      current = clamp(opts.currentOverride, MUTATION_RATE_MIN, MUTATION_RATE_MAX)
    } else {
      current = getEffectiveMetaGenome().mutationRate
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:mutationRateAdvisor] getEffectiveMetaGenome failed: ${(e as Error).message}`,
    )
    current = 0.3 // DEFAULT_META_GENOME.mutationRate
  }

  // ── snapshot ────────────────────────────────────────────────
  let snapshot: MetaOracleSnapshot | null = null
  try {
    snapshot = opts.snapshot ?? computeMetaOracleSnapshot()
  } catch (e) {
    logForDebugging(
      `[autoEvolve:mutationRateAdvisor] computeMetaOracleSnapshot failed: ${(e as Error).message}`,
    )
    snapshot = null
  }

  const verdict: MetaOracleVerdict = snapshot?.verdict ?? 'insufficient-data'

  // ── 决策 ────────────────────────────────────────────────────
  let proposed = current
  let direction: MutationRateDirection = 'hold'
  let reason: string

  switch (verdict) {
    case 'converging':
      proposed = current + stepUp
      direction = 'up'
      reason = `population converging (${snapshot?.verdictReason ?? 'n/a'}); raise mutationRate to inject diversity`
      break
    case 'diverging':
      proposed = current - stepDown
      direction = 'down'
      reason = `population diverging (${snapshot?.verdictReason ?? 'n/a'}); lower mutationRate to stabilize`
      break
    case 'healthy':
      direction = 'hold'
      reason = `population healthy (${snapshot?.verdictReason ?? 'n/a'}); hold mutationRate`
      break
    case 'insufficient-data':
    default:
      direction = 'hold'
      reason = `insufficient data (${snapshot?.verdictReason ?? 'snapshot missing'}); hold mutationRate`
      break
  }

  const suggested = clamp(proposed, MUTATION_RATE_MIN, MUTATION_RATE_MAX)
  const delta = suggested - current

  // Clamp 顶到天花板/地板 → direction 降级成 hold,但保留 verdict 供上层展示
  if (direction === 'up' && suggested <= current) {
    direction = 'hold'
    reason = `converging but mutationRate already at ceiling (${MUTATION_RATE_MAX}); hold`
  } else if (direction === 'down' && suggested >= current) {
    direction = 'hold'
    reason = `diverging but mutationRate already at floor (${MUTATION_RATE_MIN}); hold`
  }

  // applyHint:方向 != hold 时给 env override 命令;
  // 用 env 而不是直接 saveMetaGenome,是因为 Phase 5.4 的建议器定位是
  // "建议",由 ops 或 /evolve-status 操作者决定是否人工落盘。
  const applyHint =
    direction === 'hold'
      ? null
      : `export CLAUDE_EVOLVE_META_MUTATION_RATE=${suggested.toFixed(3)}`

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
