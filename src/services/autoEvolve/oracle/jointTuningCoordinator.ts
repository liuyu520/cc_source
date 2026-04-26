/**
 * autoEvolve(v1.0) — Phase 36:Phase 24 + Phase 27 联合调优协调器
 *
 * 背景
 * ────
 * Phase 24 (thresholdTuner) 负责调 organism win/loss / oracleAdverseAvg /
 * goodhartPerfectAvgMin 这 4 个阈值;Phase 27 (metaEvolver) 负责调 4 个
 * oracle 维度的权重 (userSatisfaction / taskSuccess / codeQuality /
 * performance)。两者数据源都是同一条 fitness.ndjson,但从不同角度提建议。
 *
 * 关键耦合(在代码里已经客观存在):
 *   computeWeightSuggestion(windowDays) 内部调 loadTunedThresholds(),
 *   用 organismWinThreshold / organismLossThreshold 作为"赢/输"分桶的
 *   阈值来算 SNR —— 也就是说 Phase 27 的输入**依赖** Phase 24 当前值。
 *
 * 没有协调会发生什么
 * ────────────────
 *   1. 用户在 T0 跑 /evolve-tune --apply —— 阈值整体收紧了(organism
 *      win 从 0.3 → 0.4)。原来被判定为 "赢" 的一批样本现在不再是赢。
 *   2. 用户立刻 T0+Δ 跑 /evolve-meta --apply —— computeWeightSuggestion
 *      用新阈值重新分桶,SNR 自然变化,权重跟着变化。
 *   3. 两次 apply 同时落盘,下一次评估窗口的 fitness 分布是两个变量一起
 *      移的结果 —— 归因困难,调优不收敛,严重时震荡。
 *
 * 协调策略
 * ────────
 *   1. **单次规划(plan)**:一口气算出 thresholdSuggestion 和
 *      weightSuggestion(后者用 current thresholds 作为基准 —— 即"此刻
 *      的 weight 建议")。
 *   2. **就绪分类**:每边独立判断是否有"有效 delta"(大于噪声),避免
 *      把抖动当真实信号。
 *   3. **交互分类(interaction)**:两边都大 → big-shake;只有一边大 →
 *      single-lead;两边都小 → cooperative。
 *   4. **应用策略(strategy)**:
 *        - `nothing` / `thresholds-only` / `weights-only`:不需要协调
 *        - `thresholds-then-weights`:先写阈值,**重算** weight suggestion
 *          (因为阈值已经变了,旧 suggestion 已经 stale),再写权重
 *        - `thresholds-then-weights-damped`:big-shake 专属。先写阈值,
 *          重算权重,但只应用 dampFactor(默认 0.5)比例的 delta,防止
 *          两变量一起大移。
 *   5. **applyJointTuningPlan()**:严格按 strategy 执行;若重算后的
 *      weight suggestion 仍有 insufficientReason,就只写阈值。
 *
 * 为什么是"先阈值后权重"而不是反过来?
 * ──────────────────────────────
 *   - Phase 27 依赖 Phase 24 值(见上)。Phase 24 不依赖 Phase 27。
 *   - 先写阈值,再算权重 —— 这一轮权重建议就是"在新阈值世界下的
 *     权重",语义干净。
 *   - 反过来先写权重,新权重会立刻改变 fitness 聚合输出,下一窗口的
 *     阈值建议再跟着变 —— 两变量都在动,归因仍然困难。
 *
 * 为什么 Phase 27 没有"重算"这一步的等价物?
 * ────────────────────────────────
 *   - Phase 27 的 suggestion 对 weights 是"一步到位"的(SNR → 权重),
 *     不 iterative,写完就完了,下一轮再算。
 *
 * 本文件**不**做 feature-flag gate —— 和 /evolve-tune / /evolve-meta
 * 一样,gate 判断在命令层(CLAUDE_EVOLVE / CLAUDE_EVOLVE_TUNE /
 * CLAUDE_EVOLVE_META)。
 */

import {
  computeTuningSuggestion,
  loadTunedThresholds,
  saveTunedThresholds,
  suggestionToNext as thresholdSuggestionToNext,
  type ThresholdSuggestionRow,
  type TunedThresholds,
  type TuningSuggestion,
} from './thresholdTuner.js'
import {
  computeWeightSuggestion,
  DEFAULT_TUNED_ORACLE_WEIGHTS,
  loadTunedOracleWeights,
  saveTunedOracleWeights,
  suggestionToNext as weightSuggestionToNext,
  WEIGHT_MAX,
  WEIGHT_MIN,
  type MetaWeightSuggestion,
  type MetaWeightSuggestionRow,
  type TunedOracleWeights,
} from './metaEvolver.js'

// ── 常量:"有效 delta" 门槛 ─────────────────────────────────────────────
// 低于这个值视作"噪声 / 往返抖动",判定 ready=false,避免一点小抖动就
// 触发一次联合调优。数值是经验值,字段文档在 SKILL.md Phase 36 里。

/** 单条阈值 row 的 delta ≥ 这个值就算"有效" */
export const THRESHOLD_MIN_EFFECTIVE_DELTA = 0.01
/** 单条权重 row 的 delta ≥ 这个值就算"有效" */
export const WEIGHT_MIN_EFFECTIVE_DELTA = 0.02

// ── 常量:"大幅 delta" 门槛(判定 big-shake 用) ─────────────────────
// 两边都 ready 时,再看 delta 是不是大 —— 两边都大 → big-shake 需要
// damping;否则 cooperative 不 damp。

/** 单条阈值 row |delta| ≥ 这个值 OR norm 超过 THRESHOLD_BIG_NORM → 大 */
export const THRESHOLD_BIG_SINGLE = 0.1
export const THRESHOLD_BIG_NORM = 0.15
/** 单条权重 row |delta| ≥ 这个值 OR norm 超过 WEIGHT_BIG_NORM → 大 */
export const WEIGHT_BIG_SINGLE = 0.05
export const WEIGHT_BIG_NORM = 0.08

/** big-shake 默认 damping 系数 —— 只应用这么多比例的 weight delta */
export const DEFAULT_DAMP_FACTOR = 0.5

// ── 类型 ─────────────────────────────────────────────────────────────

export type InteractionKind =
  | 'both-insufficient' // 两边要么样本不够、要么 delta 太小
  | 'threshold-only' // 只有 Phase 24 侧 ready
  | 'weights-only' // 只有 Phase 27 侧 ready
  | 'cooperative' // 两边都 ready,但都不大,无需 damping
  | 'big-shake' // 两边都 ready 且至少有一边大 —— 需要 damping

export type ApplyStrategy =
  | 'nothing'
  | 'thresholds-only'
  | 'weights-only'
  | 'thresholds-then-weights'
  | 'thresholds-then-weights-damped'

export interface JointTuningPlan {
  /** 计算窗口(天) */
  windowDays: number
  /** Phase 24 建议 */
  thresholdSuggestion: TuningSuggestion
  /** Phase 27 建议(用 current thresholds 算的,plan 时点的快照) */
  weightSuggestion: MetaWeightSuggestion

  /** 阈值侧是否 ready(样本够 + delta 非噪声) */
  thresholdReady: boolean
  /** 权重侧是否 ready */
  weightReady: boolean
  /** 两边同时 ready */
  bothReady: boolean

  /** 阈值 delta 范数 = sum |delta| / rows */
  thresholdDeltaNorm: number
  /** 阈值单条最大 |delta| */
  thresholdDeltaMax: number
  /** 权重 delta 范数 */
  weightDeltaNorm: number
  /** 权重单条最大 |delta| */
  weightDeltaMax: number

  /** 交互分类 */
  interaction: InteractionKind
  /** 应用策略 */
  strategy: ApplyStrategy
  /** 只在 big-shake 时 <1.0,其它 =1.0 */
  dampFactor: number
  /** 规划理由(逐条可读) */
  notes: string[]
}

export interface ApplyJointResult {
  /** 实际最终采用的 strategy(可能比 plan 更保守,例如重算后样本不够) */
  strategy: ApplyStrategy
  /** 阈值是否真写盘了 */
  wroteThresholds: boolean
  /** 权重是否真写盘了 */
  wroteWeights: boolean
  /** 如果 damped,记录 damp 之前和之后的 weight 值(用于审计) */
  dampedWeights?: Array<{ name: string; raw: number; damped: number }>
  /** 写盘后的 TunedThresholds(若 wroteThresholds=true) */
  thresholdsAfter: TunedThresholds | null
  /** 写盘后的 TunedOracleWeights(若 wroteWeights=true) */
  weightsAfter: TunedOracleWeights | null
  /** 每一步的叙事 —— dry-run 预览 + 真 apply 都会用 */
  notes: string[]
}

// ── helpers ─────────────────────────────────────────────────────────

/** 阈值侧:单条 row delta 总和的"平均范数",粗略度量"一次要移多少" */
function thresholdNorms(s: TuningSuggestion): { norm: number; max: number } {
  if (s.rows.length === 0) return { norm: 0, max: 0 }
  let sum = 0
  let max = 0
  for (const r of s.rows) {
    const d = Math.abs(r.suggested - r.current)
    sum += d
    if (d > max) max = d
  }
  return { norm: sum / s.rows.length, max }
}

/** 权重侧同款 */
function weightNorms(s: MetaWeightSuggestion): { norm: number; max: number } {
  if (s.rows.length === 0) return { norm: 0, max: 0 }
  let sum = 0
  let max = 0
  for (const r of s.rows) {
    const d = Math.abs(r.suggested - r.current)
    sum += d
    if (d > max) max = d
  }
  return { norm: sum / s.rows.length, max }
}

/**
 * 判断是否"有效":样本够 AND 至少一条 row 超过 min effective delta。
 * 样本不够(insufficientReason != '' / != null)直接 not-ready。
 */
function thresholdIsReady(s: TuningSuggestion): boolean {
  if (s.insufficientReason) return false
  const { max } = thresholdNorms(s)
  return max >= THRESHOLD_MIN_EFFECTIVE_DELTA
}

function weightIsReady(s: MetaWeightSuggestion): boolean {
  if (s.insufficientReason) return false
  const { max } = weightNorms(s)
  return max >= WEIGHT_MIN_EFFECTIVE_DELTA
}

/** big-shake 判定:两边都 ready 且至少一边达到"大"门槛 */
function isBigShake(
  tNorm: { norm: number; max: number },
  wNorm: { norm: number; max: number },
): boolean {
  const tBig =
    tNorm.max >= THRESHOLD_BIG_SINGLE || tNorm.norm >= THRESHOLD_BIG_NORM
  const wBig = wNorm.max >= WEIGHT_BIG_SINGLE || wNorm.norm >= WEIGHT_BIG_NORM
  return tBig || wBig
}

/**
 * 把 damped weight 做 clamp + 重归一化(语义上和 metaEvolver.suggestionToNext
 * 产物一致;我们先按行 damp,再整体归一化到 [WEIGHT_MIN, WEIGHT_MAX])。
 *
 * 入参:
 *   current: 当前 TunedOracleWeights(damp 的起点)
 *   suggested: 建议 TunedOracleWeights(damp 目标)
 *   damp: damp 系数 ∈ [0,1]。damp=1 → 完全采用 suggested;damp=0 → 完全保留 current
 *
 * 输出:damp 后、clamp 到 [WEIGHT_MIN, WEIGHT_MAX]、再归一化的 TunedOracleWeights
 *   + 每一维的 {raw, damped} 便于审计
 */
function dampWeights(
  current: TunedOracleWeights,
  suggested: TunedOracleWeights,
  damp: number,
): { weights: TunedOracleWeights; trace: Array<{ name: string; raw: number; damped: number }> } {
  const dims = ['userSatisfaction', 'taskSuccess', 'codeQuality', 'performance'] as const
  const rawMap: Record<string, number> = {}
  const dampedMap: Record<string, number> = {}
  const trace: Array<{ name: string; raw: number; damped: number }> = []
  for (const d of dims) {
    const cur = current[d]
    const sug = suggested[d]
    const raw = sug
    const damped = cur + damp * (sug - cur)
    rawMap[d] = raw
    dampedMap[d] = damped
  }
  // clamp
  for (const d of dims) {
    let v = dampedMap[d]
    if (v < WEIGHT_MIN) v = WEIGHT_MIN
    if (v > WEIGHT_MAX) v = WEIGHT_MAX
    dampedMap[d] = v
  }
  // normalize to sum 1
  const sum = dims.reduce((acc, d) => acc + dampedMap[d], 0)
  if (sum > 0) {
    for (const d of dims) dampedMap[d] = dampedMap[d] / sum
  }
  for (const d of dims) {
    trace.push({ name: d, raw: rawMap[d], damped: dampedMap[d] })
  }
  return {
    weights: {
      version: 1,
      updatedAt: new Date().toISOString(),
      userSatisfaction: dampedMap.userSatisfaction,
      taskSuccess: dampedMap.taskSuccess,
      codeQuality: dampedMap.codeQuality,
      performance: dampedMap.performance,
    },
    trace,
  }
}

// ── 主 API ──────────────────────────────────────────────────────────

/**
 * 规划(纯读 —— 不写盘)。
 *
 * 顺序:先算阈值 suggestion,**用 current thresholds** 算权重 suggestion;
 * 分类后产 strategy。
 */
export function planJointTuning(windowDays: number = 30): JointTuningPlan {
  const tSug = computeTuningSuggestion(windowDays)
  const wSug = computeWeightSuggestion(windowDays)

  const tNorms = thresholdNorms(tSug)
  const wNorms = weightNorms(wSug)
  const tReady = thresholdIsReady(tSug)
  const wReady = weightIsReady(wSug)
  const bothReady = tReady && wReady

  let interaction: InteractionKind
  let strategy: ApplyStrategy
  let damp = 1.0
  const notes: string[] = []

  if (!tReady && !wReady) {
    interaction = 'both-insufficient'
    strategy = 'nothing'
    if (tSug.insufficientReason) {
      notes.push(`thresholds: ${tSug.insufficientReason}`)
    } else {
      notes.push(
        `thresholds: max |delta|=${tNorms.max.toFixed(4)} < ${THRESHOLD_MIN_EFFECTIVE_DELTA} (noise threshold)`,
      )
    }
    if (wSug.insufficientReason) {
      notes.push(`weights: ${wSug.insufficientReason}`)
    } else {
      notes.push(
        `weights: max |delta|=${wNorms.max.toFixed(4)} < ${WEIGHT_MIN_EFFECTIVE_DELTA} (noise threshold)`,
      )
    }
    notes.push('decision: nothing to do, both sides are quiet')
  } else if (tReady && !wReady) {
    interaction = 'threshold-only'
    strategy = 'thresholds-only'
    notes.push(
      `thresholds: ready (max |delta|=${tNorms.max.toFixed(4)}, norm=${tNorms.norm.toFixed(4)})`,
    )
    notes.push(
      wSug.insufficientReason
        ? `weights: ${wSug.insufficientReason}`
        : `weights: max |delta|=${wNorms.max.toFixed(4)} < ${WEIGHT_MIN_EFFECTIVE_DELTA}`,
    )
    notes.push('decision: apply thresholds only')
  } else if (!tReady && wReady) {
    interaction = 'weights-only'
    strategy = 'weights-only'
    notes.push(
      tSug.insufficientReason
        ? `thresholds: ${tSug.insufficientReason}`
        : `thresholds: max |delta|=${tNorms.max.toFixed(4)} < ${THRESHOLD_MIN_EFFECTIVE_DELTA}`,
    )
    notes.push(
      `weights: ready (max |delta|=${wNorms.max.toFixed(4)}, norm=${wNorms.norm.toFixed(4)})`,
    )
    notes.push('decision: apply weights only')
  } else {
    // both ready
    const shake = isBigShake(tNorms, wNorms)
    if (shake) {
      interaction = 'big-shake'
      strategy = 'thresholds-then-weights-damped'
      damp = DEFAULT_DAMP_FACTOR
      notes.push(
        `thresholds: BIG (max |delta|=${tNorms.max.toFixed(4)}, norm=${tNorms.norm.toFixed(4)})`,
      )
      notes.push(
        `weights: BIG (max |delta|=${wNorms.max.toFixed(4)}, norm=${wNorms.norm.toFixed(4)})`,
      )
      notes.push(
        `decision: thresholds-then-weights-damped (damp=${damp.toFixed(2)}) — both sides moving fast, damp weight side to avoid overshoot`,
      )
    } else {
      interaction = 'cooperative'
      strategy = 'thresholds-then-weights'
      notes.push(
        `thresholds: small (max |delta|=${tNorms.max.toFixed(4)}, norm=${tNorms.norm.toFixed(4)})`,
      )
      notes.push(
        `weights: small (max |delta|=${wNorms.max.toFixed(4)}, norm=${wNorms.norm.toFixed(4)})`,
      )
      notes.push(
        `decision: thresholds-then-weights — both small and cooperative, apply in order`,
      )
    }
  }

  return {
    windowDays,
    thresholdSuggestion: tSug,
    weightSuggestion: wSug,
    thresholdReady: tReady,
    weightReady: wReady,
    bothReady,
    thresholdDeltaNorm: tNorms.norm,
    thresholdDeltaMax: tNorms.max,
    weightDeltaNorm: wNorms.norm,
    weightDeltaMax: wNorms.max,
    interaction,
    strategy,
    dampFactor: damp,
    notes,
  }
}

/**
 * 执行 plan。strategy 决定写入路径;damping 只在 big-shake 时生效。
 *
 * 关键点:若 plan.strategy 是 thresholds-then-weights(-damped),我们先
 * saveTunedThresholds,然后**重算** computeWeightSuggestion —— 因为它内部
 * loadTunedThresholds(),阈值已经变了,旧 suggestion 已经不再对齐。
 *
 * 若重算后的 weight suggestion 变成 insufficient(例如阈值变紧后,win/loss
 * 样本都太少),我们就停在 thresholds-only,把实际采用的 strategy 记在
 * result.strategy 里;notes 里给出理由。
 */
export function applyJointTuningPlan(
  plan: JointTuningPlan,
): ApplyJointResult {
  const notes: string[] = []
  let actualStrategy: ApplyStrategy = plan.strategy
  let wroteThresholds = false
  let wroteWeights = false
  let thresholdsAfter: TunedThresholds | null = null
  let weightsAfter: TunedOracleWeights | null = null
  let dampedWeights: Array<{ name: string; raw: number; damped: number }> | undefined

  if (plan.strategy === 'nothing') {
    notes.push('strategy=nothing — nothing written')
    return {
      strategy: 'nothing',
      wroteThresholds: false,
      wroteWeights: false,
      thresholdsAfter: null,
      weightsAfter: null,
      notes,
    }
  }

  // 写阈值(thresholds-only / thresholds-then-weights(-damped))
  if (
    plan.strategy === 'thresholds-only' ||
    plan.strategy === 'thresholds-then-weights' ||
    plan.strategy === 'thresholds-then-weights-damped'
  ) {
    const next = thresholdSuggestionToNext(plan.thresholdSuggestion)
    saveTunedThresholds(next)
    wroteThresholds = true
    thresholdsAfter = loadTunedThresholds()
    notes.push(
      `wrote thresholds: win=${next.organismWinThreshold.toFixed(3)} loss=${next.organismLossThreshold.toFixed(3)} adv=${next.oracleAdverseAvg.toFixed(3)} perf=${next.goodhartPerfectAvgMin.toFixed(3)}`,
    )
  }

  // 写权重(weights-only / thresholds-then-weights(-damped))
  if (plan.strategy === 'weights-only') {
    const next = weightSuggestionToNext(plan.weightSuggestion)
    saveTunedOracleWeights(next)
    wroteWeights = true
    weightsAfter = loadTunedOracleWeights()
    notes.push(
      `wrote weights: us=${next.userSatisfaction.toFixed(3)} ts=${next.taskSuccess.toFixed(3)} cq=${next.codeQuality.toFixed(3)} pf=${next.performance.toFixed(3)}`,
    )
  } else if (
    plan.strategy === 'thresholds-then-weights' ||
    plan.strategy === 'thresholds-then-weights-damped'
  ) {
    // 重算:阈值已落盘 → computeWeightSuggestion 再算一次,基于新阈值
    const reSug = computeWeightSuggestion(plan.windowDays)
    if (reSug.insufficientReason) {
      // 降级:只落了阈值,权重不动
      actualStrategy = 'thresholds-only'
      notes.push(
        `recomputed weight suggestion after threshold apply: ${reSug.insufficientReason} — fall back to thresholds-only`,
      )
    } else {
      const reNext = weightSuggestionToNext(reSug)
      if (plan.strategy === 'thresholds-then-weights-damped') {
        // damp:在**此刻** current 之上,只走 dampFactor 比例到 reNext
        const current =
          loadTunedOracleWeights() ?? { ...DEFAULT_TUNED_ORACLE_WEIGHTS }
        const { weights, trace } = dampWeights(
          current,
          reNext,
          plan.dampFactor,
        )
        dampedWeights = trace
        saveTunedOracleWeights(weights)
        wroteWeights = true
        weightsAfter = loadTunedOracleWeights()
        notes.push(
          `wrote damped weights (damp=${plan.dampFactor.toFixed(2)}): us=${weights.userSatisfaction.toFixed(3)} ts=${weights.taskSuccess.toFixed(3)} cq=${weights.codeQuality.toFixed(3)} pf=${weights.performance.toFixed(3)}`,
        )
      } else {
        saveTunedOracleWeights(reNext)
        wroteWeights = true
        weightsAfter = loadTunedOracleWeights()
        notes.push(
          `wrote weights: us=${reNext.userSatisfaction.toFixed(3)} ts=${reNext.taskSuccess.toFixed(3)} cq=${reNext.codeQuality.toFixed(3)} pf=${reNext.performance.toFixed(3)}`,
        )
      }
    }
  }

  return {
    strategy: actualStrategy,
    wroteThresholds,
    wroteWeights,
    thresholdsAfter,
    weightsAfter,
    dampedWeights,
    notes,
  }
}

/**
 * env gate:和 /evolve-tune / /evolve-meta 一致的三级优先 ——
 *   1. CLAUDE_EVOLVE_JOINT(最强)
 *   2. CLAUDE_EVOLVE_TUNE AND CLAUDE_EVOLVE_META(都 on 才放行)
 *   3. CLAUDE_EVOLVE(兜底)
 *   4. 默认:因为联合写入 blast radius 比单边大,保守默认 off
 */
export function isJointTuneWriteEnabled(): boolean {
  const joint = process.env.CLAUDE_EVOLVE_JOINT
  if (joint !== undefined) {
    const v = joint.trim().toLowerCase()
    if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
    if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true
  }
  const tune = process.env.CLAUDE_EVOLVE_TUNE
  const meta = process.env.CLAUDE_EVOLVE_META
  if (tune !== undefined && meta !== undefined) {
    const isOn = (s: string): boolean => {
      const v = s.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' || v === 'yes'
    }
    if (isOn(tune) && isOn(meta)) return true
  }
  const ev = process.env.CLAUDE_EVOLVE
  if (ev !== undefined) {
    const v = ev.trim().toLowerCase()
    if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true
  }
  return false
}
