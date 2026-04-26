/**
 * autoEvolve(v1.0) — Phase 41:Rollback 阈值自适应 tuner
 *
 * 问题
 * ────
 * Phase 40 rollbackWatchdog 的 6 个阈值(canary/stable × avgMax/minTrials/
 * minAgeDays)是 v1 硬编码,无法随真实使用数据自适应。长期观察之后一定会
 * 出现两种偏差:
 *   - 误降级(false positive):rollback 出来的 organism 在 shadow 重新
 *     接样本后 fitness 很快回升 → 说明阈值过松
 *   - 漏降级(false negative):canary/stable 里有 organism avg 早已低于
 *     阈值但被 trials/age 门槛挡住没 rollback → 说明阈值过严
 *
 * Phase 37 管进(promotion 阈值 tuner),Phase 38 管出(archive 阈值 tuner),
 * Phase 41 管退回(rollback 阈值 tuner)—— 三者串成 FSM 边上每一条决策的
 * 闭环自适应。
 *
 * 调参信号与决策规则(v1 纪律)
 * ──────────────────────────
 *   对每个 status(canary/stable):
 *     1. 扫 promotions.ndjson 里 trigger='auto-rollback' + from=status
 *        的历史事件(rollbackEvents)
 *     2. 对每条事件,在 fitness.ndjson 里找 organism 在
 *        [rollbackAt, rollbackAt + RECOVERY_WINDOW_DAYS] 窗口内所有
 *        FitnessScore,算 recoveryAvg
 *        - recoveryAvg > FP_RECOVERY_MIN(+0.0)→ "回升了" → false positive
 *        - 否则 true positive
 *     3. 样本不足(rollbackEvents.length < MIN_SAMPLES_TO_TUNE)→ insufficient
 *     4. fpRate ≥ HIGH_FP_RATE 且 fnRate < HIGH_FN_RATE → **tighten**
 *     5. fpRate ≤ LOW_FP_RATE 且 fnRate ≥ HIGH_FN_RATE → **relax**
 *     6. 其它 → **hold**
 *
 *   fnRate 来源:扫当前 canary/stable 目录,对每个 organism 跑
 *   `evaluateRollback`,统计 decision=hold AND 仅因 trials/age 门槛挡掉
 *   (avg 其实已经过线)的占比 —— 这些是"看起来该降但被门槛拦住"的候选。
 *
 * Tighten step(让阈值更严,更不容易 rollback):
 *   - avgMax:减 TIGHTEN_AVG_DELTA(= -0.05,更负)
 *   - minTrials:加 1
 *   - minAgeDays:加 1
 *
 * Relax step(让阈值更松,更容易 rollback):
 *   - avgMax:加 TIGHTEN_AVG_DELTA(更正)
 *   - minTrials:减 1(clamp ≥ MIN_TRIALS_FLOOR)
 *   - minAgeDays:减 1(clamp ≥ MIN_AGE_DAYS_FLOOR)
 *
 * Clamp 边界(安全护栏):
 *   - avgMax ∈ [-0.7, -0.05]    —— 过负把所有 organism 视作无辜;过正把
 *                                   正常波动都视为失能
 *   - minTrials ∈ [1, 20]       —— 至少 1 条样本,最多 20 条太迟钝
 *   - minAgeDays ∈ [1, 30]      —— 至少 1 天观察期,最多 30 天太迟钝
 *
 * Sentinel 语义
 * ────────────
 * 不同于 Phase 39 的 halfLifeDays=0(sentinel=feature off),Phase 41
 * 的 DEFAULT 就是 Phase 40 的现用值(-0.3/3/3d & -0.2/5/7d),行为
 * 完全一致。文件缺失 → DEFAULT;文件存在但 version 不匹配 → DEFAULT
 * 并警告(不 throw,避免破坏 rollback scan)。这样 Phase 41 上线默认 no-op,
 * 用户主动跑 `/evolve-tune-rollback-thresholds --apply` 才生效。
 *
 * 与 Phase 40 rollbackWatchdog 的接线
 * ────────────────────────────────
 * rollbackWatchdog.evaluateRollback 本来读 6 个 export const;Phase 41
 * 让它在进入函数时先 `loadTunedRollbackThresholds()` 拿当前值,把
 * export const 留作 DEFAULT 给测试 / 诊断 直接引用,保持 Phase 40 语义
 * 完全兼容(文件不存在时 getter 返回同样的值)。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { getTunedRollbackThresholdsPath } from '../paths.js'
import { readRecentTransitions } from '../arena/promotionFsm.js'
import { recentFitnessScores } from './fitnessOracle.js'
import type { FitnessScore, Transition } from '../types.js'

// ── 类型 ────────────────────────────────────────────────────────

/** 单层(canary 或 stable)的三个阈值一组 */
export interface RollbackThresholdBand {
  avgMax: number
  minTrials: number
  minAgeDays: number
}

/** 全量 tuned 文件 schema(v1) */
export interface TunedRollbackThresholds {
  version: 1
  updatedAt: string
  canary: RollbackThresholdBand
  stable: RollbackThresholdBand
}

/** suggestion 输出 —— 单个 band 的维度变化 */
export interface RollbackThresholdSuggestionBand {
  /** canary 或 stable */
  status: 'canary' | 'stable'
  /** insufficient / tighten / relax / hold */
  decision: 'insufficient' | 'tighten' | 'relax' | 'hold'
  /** 当前 band(tune 前) */
  current: RollbackThresholdBand
  /** 建议 band(tune 后;insufficient/hold 时 === current) */
  next: RollbackThresholdBand
  /** 分析出的信号 snapshot */
  signals: {
    rollbackSamples: number
    fpCount: number
    fpRate: number
    fnCandidates: number
    fnRate: number
  }
  /** 人类可读理由 */
  rationale: string
}

/** 整体 suggestion */
export interface RollbackThresholdSuggestion {
  canary: RollbackThresholdSuggestionBand
  stable: RollbackThresholdSuggestionBand
  /** 合成的 next 文件内容(始终可 save;hold/insufficient 时内容 ≡ current) */
  nextTuned: TunedRollbackThresholds
}

// ── 常量 ────────────────────────────────────────────────────────

/**
 * Phase 40 硬编码的缺省值 —— 此处作为 Phase 41 DEFAULT。
 * Phase 40 的 export const 保持不变(作为 DEFAULT sub-reference);
 * rollbackWatchdog runtime 通过 getter 读 tuned 值。
 */
export const DEFAULT_TUNED_ROLLBACK_THRESHOLDS: TunedRollbackThresholds = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  canary: { avgMax: -0.3, minTrials: 3, minAgeDays: 3 },
  stable: { avgMax: -0.2, minTrials: 5, minAgeDays: 7 },
}

// 分析窗口与门槛(v1 硬编码,后续 Phase 4x 可再抽一层 meta-tuner)
export const RECOVERY_WINDOW_DAYS = 14
export const FP_RECOVERY_MIN = 0.0
export const MIN_SAMPLES_TO_TUNE = 5
export const HIGH_FP_RATE = 0.5
export const LOW_FP_RATE = 0.1
export const HIGH_FN_RATE = 0.3

// 调整步长
export const TIGHTEN_AVG_DELTA = 0.05 // 绝对值;tighten 是 -=,relax 是 +=

// Clamp 护栏
export const AVG_MAX_FLOOR = -0.7
export const AVG_MAX_CEIL = -0.05
export const MIN_TRIALS_FLOOR = 1
export const MIN_TRIALS_CEIL = 20
export const MIN_AGE_DAYS_FLOOR = 1
export const MIN_AGE_DAYS_CEIL = 30

// ── load/save(mtime-cached)────────────────────────────────────

let _cache: { path: string; mtimeMs: number; data: TunedRollbackThresholds } | null = null

/**
 * 读 tuned 文件;带 mtime 缓存,未变更直接复用对象。
 * 任何错误(文件缺失 / JSON 损坏 / version 不匹配)都 fallback 到 DEFAULT,
 * 不 throw —— rollbackWatchdog 是 scan 热路径,不能被配置问题打穿。
 */
export function loadTunedRollbackThresholds(): TunedRollbackThresholds {
  const p = getTunedRollbackThresholdsPath()
  try {
    if (!existsSync(p)) {
      _cache = null
      return DEFAULT_TUNED_ROLLBACK_THRESHOLDS
    }
    const st = statSync(p)
    if (_cache && _cache.path === p && _cache.mtimeMs === st.mtimeMs) {
      return _cache.data
    }
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TunedRollbackThresholds>
    if (parsed.version !== 1 || !parsed.canary || !parsed.stable) {
      // 结构不合法 → 退回 DEFAULT(不清缓存,避免反复读取损坏文件)
      return DEFAULT_TUNED_ROLLBACK_THRESHOLDS
    }
    const normalized: TunedRollbackThresholds = {
      version: 1,
      updatedAt: String(parsed.updatedAt ?? '1970-01-01T00:00:00.000Z'),
      canary: {
        avgMax: clampAvg(parsed.canary.avgMax),
        minTrials: clampTrials(parsed.canary.minTrials),
        minAgeDays: clampAge(parsed.canary.minAgeDays),
      },
      stable: {
        avgMax: clampAvg(parsed.stable.avgMax),
        minTrials: clampTrials(parsed.stable.minTrials),
        minAgeDays: clampAge(parsed.stable.minAgeDays),
      },
    }
    _cache = { path: p, mtimeMs: st.mtimeMs, data: normalized }
    return normalized
  } catch {
    return DEFAULT_TUNED_ROLLBACK_THRESHOLDS
  }
}

/**
 * 写 tuned 文件。Command `--apply` 路径调用。
 * 自动创建父目录;写完后清缓存(下次 load 按新 mtime 走热路径)。
 */
export function saveTunedRollbackThresholds(t: TunedRollbackThresholds): void {
  const p = getTunedRollbackThresholdsPath()
  mkdirSync(dirname(p), { recursive: true })
  const body: TunedRollbackThresholds = {
    version: 1,
    updatedAt: t.updatedAt || new Date().toISOString(),
    canary: {
      avgMax: clampAvg(t.canary.avgMax),
      minTrials: clampTrials(t.canary.minTrials),
      minAgeDays: clampAge(t.canary.minAgeDays),
    },
    stable: {
      avgMax: clampAvg(t.stable.avgMax),
      minTrials: clampTrials(t.stable.minTrials),
      minAgeDays: clampAge(t.stable.minAgeDays),
    },
  }
  writeFileSync(p, JSON.stringify(body, null, 2) + '\n')
  _cache = null
}

/** 仅测试用:显式清缓存,避免 mtime 精度(秒)导致的短时更新失效 */
export function clearTunedRollbackThresholdsCache(): void {
  _cache = null
}

// ── clamp 助手 ─────────────────────────────────────────────────

function clampAvg(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : -0.3
  if (n < AVG_MAX_FLOOR) return AVG_MAX_FLOOR
  if (n > AVG_MAX_CEIL) return AVG_MAX_CEIL
  return n
}

function clampTrials(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 3
  if (n < MIN_TRIALS_FLOOR) return MIN_TRIALS_FLOOR
  if (n > MIN_TRIALS_CEIL) return MIN_TRIALS_CEIL
  return n
}

function clampAge(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 3
  if (n < MIN_AGE_DAYS_FLOOR) return MIN_AGE_DAYS_FLOOR
  if (n > MIN_AGE_DAYS_CEIL) return MIN_AGE_DAYS_CEIL
  return n
}

// ── 信号计算 ────────────────────────────────────────────────────

/**
 * 给定所有 rollback 事件 + 所有 FitnessScore,产出每个 status 的 FP 信号。
 *
 * pure(不访问磁盘),便于注入测试数据。
 */
export function computeFpSignal(
  rollbackTransitions: Transition[],
  fitnessScores: FitnessScore[],
  status: 'canary' | 'stable',
  nowMs: number = Date.now(),
  recoveryWindowDays: number = RECOVERY_WINDOW_DAYS,
): { rollbackSamples: number; fpCount: number; fpRate: number } {
  // 仅保留该 status 的 rollback 事件
  const evts = rollbackTransitions.filter(
    t => t.trigger === 'auto-rollback' && t.from === status && t.to === 'shadow',
  )
  if (evts.length === 0) {
    return { rollbackSamples: 0, fpCount: 0, fpRate: 0 }
  }

  // 按 organismId 归组 fitness 分数,便于按 organismId 快速查询
  const byOrganism = new Map<string, FitnessScore[]>()
  for (const s of fitnessScores) {
    if (!s.organismId) continue
    const arr = byOrganism.get(s.organismId) ?? []
    arr.push(s)
    byOrganism.set(s.organismId, arr)
  }

  let fpCount = 0
  let countable = 0
  const windowMs = recoveryWindowDays * 86400_000

  for (const ev of evts) {
    const rollbackTs = Date.parse(ev.at)
    if (!Number.isFinite(rollbackTs)) continue
    // 需要至少过了 recoveryWindow 才能评估"是否回升"
    if (nowMs - rollbackTs < windowMs) continue
    const samples = (byOrganism.get(ev.organismId) ?? []).filter(s => {
      const ts = Date.parse(s.scoredAt)
      return Number.isFinite(ts) && ts >= rollbackTs && ts < rollbackTs + windowMs
    })
    if (samples.length === 0) continue // 无数据,不计入 FP/TP
    countable++
    const avg = samples.reduce((a, s) => a + s.score, 0) / samples.length
    if (avg > FP_RECOVERY_MIN) fpCount++
  }

  const fpRate = countable === 0 ? 0 : fpCount / countable
  return { rollbackSamples: countable, fpCount, fpRate }
}

/**
 * 给定"当前候选评估列表"(来自 rollbackWatchdog.scanRollbackCandidates 的
 * evaluations),产出漏降级(FN)信号:
 *   - 分母:所有 decision=hold 中,avg 已经过线(avg ≤ currentAvgMax)的组织
 *   - 分子:这些组织里,hold 原因是 trials/age 门槛挡住(avg 已不是瓶颈)
 *   - fnRate = fnCount / candidates
 *
 * 传入 "evaluationsForStatus" 让调用方自己从 scan 结果切片。
 * 保持 pure。
 */
export function computeFnSignal(
  evaluationsForStatus: Array<{
    fromStatus: 'canary' | 'stable'
    aggregate: { avg: number; trials: number }
    ageSincePromotionDays: number | null
    thresholds: { avgMax: number; minTrials: number; minAgeDays: number }
    decision: 'rollback' | 'hold'
  }>,
): { fnCandidates: number; fnCount: number; fnRate: number } {
  let candidates = 0
  let fnCount = 0
  for (const ev of evaluationsForStatus) {
    if (ev.decision !== 'hold') continue
    // 只关心"avg 已经过线"的 hold —— 这些是"本来该降但被 trials/age 拦住"
    if (ev.aggregate.avg > ev.thresholds.avgMax) continue
    candidates++
    // 如果 avg 过线 + trials 或 age 未过线 → FN
    const trialsShort = ev.aggregate.trials < ev.thresholds.minTrials
    const ageShort =
      ev.ageSincePromotionDays == null ||
      ev.ageSincePromotionDays < ev.thresholds.minAgeDays
    if (trialsShort || ageShort) fnCount++
  }
  const fnRate = candidates === 0 ? 0 : fnCount / candidates
  return { fnCandidates: candidates, fnCount, fnRate }
}

// ── 单 band 决策 ──────────────────────────────────────────────

function decideBand(
  status: 'canary' | 'stable',
  current: RollbackThresholdBand,
  fp: { rollbackSamples: number; fpCount: number; fpRate: number },
  fn: { fnCandidates: number; fnCount: number; fnRate: number },
): RollbackThresholdSuggestionBand {
  const signals = {
    rollbackSamples: fp.rollbackSamples,
    fpCount: fp.fpCount,
    fpRate: fp.fpRate,
    fnCandidates: fn.fnCandidates,
    fnRate: fn.fnRate,
  }

  if (fp.rollbackSamples < MIN_SAMPLES_TO_TUNE) {
    return {
      status,
      decision: 'insufficient',
      current,
      next: current,
      signals,
      rationale: `insufficient rollback samples (${fp.rollbackSamples} < ${MIN_SAMPLES_TO_TUNE}); hold current thresholds`,
    }
  }

  // tighten:误降级偏高 + 漏降级不紧迫
  if (fp.fpRate >= HIGH_FP_RATE && fn.fnRate < HIGH_FN_RATE) {
    const next: RollbackThresholdBand = {
      avgMax: clampAvg(current.avgMax - TIGHTEN_AVG_DELTA),
      minTrials: clampTrials(current.minTrials + 1),
      minAgeDays: clampAge(current.minAgeDays + 1),
    }
    return {
      status,
      decision: 'tighten',
      current,
      next,
      signals,
      rationale: `fpRate=${fp.fpRate.toFixed(2)} ≥ ${HIGH_FP_RATE} (${fp.fpCount}/${fp.rollbackSamples} recovered in ${RECOVERY_WINDOW_DAYS}d, threshold too loose) and fnRate=${fn.fnRate.toFixed(2)} < ${HIGH_FN_RATE}; tighten`,
    }
  }

  // relax:误降级很低 + 漏降级偏高
  if (fp.fpRate <= LOW_FP_RATE && fn.fnRate >= HIGH_FN_RATE) {
    const next: RollbackThresholdBand = {
      avgMax: clampAvg(current.avgMax + TIGHTEN_AVG_DELTA),
      minTrials: clampTrials(current.minTrials - 1),
      minAgeDays: clampAge(current.minAgeDays - 1),
    }
    return {
      status,
      decision: 'relax',
      current,
      next,
      signals,
      rationale: `fpRate=${fp.fpRate.toFixed(2)} ≤ ${LOW_FP_RATE} (few recovered; rollbacks are justified) and fnRate=${fn.fnRate.toFixed(2)} ≥ ${HIGH_FN_RATE} (${fn.fnCount}/${fn.fnCandidates} candidates blocked by trials/age); relax`,
    }
  }

  return {
    status,
    decision: 'hold',
    current,
    next: current,
    signals,
    rationale: `fpRate=${fp.fpRate.toFixed(2)}, fnRate=${fn.fnRate.toFixed(2)}; signals inconclusive, hold current thresholds`,
  }
}

// ── 主 API ─────────────────────────────────────────────────────

/**
 * 产出 tuning suggestion。
 *
 * 入参(允许测试注入,命令入口传真数据):
 *   - currentTuned:当前 tuned 值(默认 loadTunedRollbackThresholds())
 *   - rollbackTransitions:全量 rollback 历史(默认 readRecentTransitions(5000) 过滤)
 *   - fitnessScores:全量 fitness 分数(默认 recentFitnessScores(5000))
 *   - evaluations:当前 canary/stable 的 evaluation 结果(默认由调用方给 scan)
 *   - nowMs:Date.now()
 *
 * 注意:evaluations 必须传(Phase 41 tuner 不主动触 rollbackWatchdog.scanRollbackCandidates
 * 以避免循环依赖 —— 命令入口自己 scan 再传进来)。不传 evaluations 时 FN=0,
 * 只凭 FP 信号决策(tighten/insufficient/hold,不会 relax)。
 */
export function computeRollbackThresholdTuningSuggestion(opts?: {
  currentTuned?: TunedRollbackThresholds
  rollbackTransitions?: Transition[]
  fitnessScores?: FitnessScore[]
  evaluations?: Array<{
    fromStatus: 'canary' | 'stable'
    aggregate: { avg: number; trials: number }
    ageSincePromotionDays: number | null
    thresholds: { avgMax: number; minTrials: number; minAgeDays: number }
    decision: 'rollback' | 'hold'
  }>
  nowMs?: number
}): RollbackThresholdSuggestion {
  const now = opts?.nowMs ?? Date.now()
  const current = opts?.currentTuned ?? loadTunedRollbackThresholds()
  const transitions = opts?.rollbackTransitions ?? readRecentTransitions(5000)
  const scores = opts?.fitnessScores ?? recentFitnessScores(5000)
  const evaluations = opts?.evaluations ?? []

  const canaryEvals = evaluations.filter(e => e.fromStatus === 'canary')
  const stableEvals = evaluations.filter(e => e.fromStatus === 'stable')

  const canaryFp = computeFpSignal(transitions, scores, 'canary', now)
  const stableFp = computeFpSignal(transitions, scores, 'stable', now)
  const canaryFn = computeFnSignal(canaryEvals)
  const stableFn = computeFnSignal(stableEvals)

  const canaryBand = decideBand('canary', current.canary, canaryFp, canaryFn)
  const stableBand = decideBand('stable', current.stable, stableFp, stableFn)

  const nextTuned: TunedRollbackThresholds = {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    canary: canaryBand.next,
    stable: stableBand.next,
  }

  return {
    canary: canaryBand,
    stable: stableBand,
    nextTuned,
  }
}
