/**
 * autoEvolve(v1.0) — Phase 39:Oracle 权重时间衰减(time-decay auto-tuner)
 *
 * 问题
 * ────
 * oracleAggregator.aggregateOrganismFitness / aggregateAllOrganisms 用
 * 算术平均计算 manifest.fitness.avg,所有 FitnessScore 不论 scoredAt 远近
 * 一视同仁。几个月前的 session 和昨天的同等影响分数,stable organism 一旦
 * 获得高 avg 就几乎被锁死 —— 即使最近 20 条全是 loss,历史 200 条 win
 * 也会把 avg 压在 +0.3 以上,autoPromotionEngine 不会 adverse-veto。
 * 反之,一条早年 loss 样本会持续拉低一个"刚刚起色"的 shadow。
 *
 * Phase 39 在 aggregator 的 sum 阶段接入 **指数半衰期衰减**:
 *   weight(score) = 0.5 ^ ((now - scoredAt) / halfLifeDays)
 *   weightedAvg   = Σ(score * weight) / Σ(weight)
 * 样本越老,指数越小,影响越小。halfLifeDays=45 即样本 45 天后衰至 0.5,
 * 90 天后衰至 0.25,180 天后衰至 0.0625。
 *
 * 向后兼容(critical):
 * ─────────────────────
 * DEFAULT_TUNED_ORACLE_DECAY.halfLifeDays = 0 是一个 **sentinel**,
 * 约定含义"不启用时间衰减,weight ≡ 1,行为完全等同 Phase 1-38"。
 * 用户 opt-in 的唯一路径是 `/evolve-tune-oracle-decay --apply` 写入正值。
 * 这和其它 tuned-*.json(那些 DEFAULT = 原硬编码生效值)的设计哲学不同 ——
 * 因为原来的 oracleAggregator 根本没有 "halfLife" 这个概念,没有"原值"
 * 可以对齐,所以 sentinel=0 代表"feature off"。文件缺失 → load fallback
 * → sentinel=0 → aggregator 走老路径,0% 行为变更。
 *
 * 自调信号
 * ────────
 * 从 fitness.ndjson 读 FitnessScore 窗口,对每条算 age = now - scoredAt,
 * 取 **p75 age**(75 分位数)作为"有意义的样本寿命"。和当前 halfLifeDays
 * 做比值 ratio = p75Age / halfLife:
 *
 *   - 若当前 halfLife = 0(feature off):
 *       - p75Age ≥ MIN_P75_AGE_FOR_FIRST_OPT_IN(14d)→ 首次 opt-in,
 *         suggested = round_to_step(p75Age) 作为初始值
 *       - 否则 hold(样本还太新,不用启用衰减)
 *
 *   - 若当前 halfLife > 0:
 *       - ratio ≥ HIGH_RATIO(2.0)→ halfLife 太短,老样本过快消失,
 *         relax:+HALF_LIFE_STEP(15d)
 *       - ratio ≤ LOW_RATIO(0.3)→ halfLife 太长,老样本几乎不衰减,
 *         tighten:-HALF_LIFE_STEP
 *       - 中间 hold
 *
 * 全部 clamp 在 [HALF_LIFE_MIN=7, HALF_LIFE_MAX=365]。样本不足
 * (count < MIN_SAMPLES_DECAY_TUNE=10)→ insufficient。
 *
 * 文件独立性
 * ──────────
 * Phase 24 / 37 / 38 都管离散阈值,Phase 39 管连续加权函数,职责分片清晰。
 * /evolve-tune-oracle-decay 只写 oracle/tuned-oracle-decay.json,不与其它
 * tuner 共享落盘结构,减少跨模块耦合。
 */

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { getTunedOracleDecayPath } from '../paths.js'
import { recentFitnessScores } from './fitnessOracle.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── 常量 ─────────────────────────────────────────────────────────

/**
 * halfLifeDays = 0 是 sentinel:"时间衰减关闭"。文件缺失时 load fallback
 * 到这里,oracleAggregator 走 weight=1 的老路径,100% 向后兼容。
 */
export const DEFAULT_TUNED_ORACLE_DECAY: TunedOracleDecay = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  halfLifeDays: 0,
}

/** opt-in 后的下限(一周)与上限(一年) */
export const HALF_LIFE_MIN = 7
export const HALF_LIFE_MAX = 365
/** 单次 ±步长;45d 的 ±15 是"每次都能看见效果"的保守值 */
export const HALF_LIFE_STEP = 15

/** ratio ≥ 此值 → halfLife 太短,relax(加大) */
export const HIGH_RATIO = 2.0
/** ratio ≤ 此值 → halfLife 太长,tighten(缩小) */
export const LOW_RATIO = 0.3

/** 窗口内最小样本数,低于此直接 insufficient */
export const MIN_SAMPLES_DECAY_TUNE = 10
/** 首次从 halfLife=0 opt-in 的样本寿命门槛 */
export const MIN_P75_AGE_FOR_FIRST_OPT_IN = 14

/** 计算 p75 的默认窗口 */
export const DEFAULT_DECAY_SAMPLE_WINDOW = 500

// ── 类型 ─────────────────────────────────────────────────────────

/** tuned-oracle-decay.json 的 schema(v1) */
export interface TunedOracleDecay {
  version: 1
  updatedAt: string
  /** 半衰期(天);0 = 关闭衰减,> 0 = 启用 */
  halfLifeDays: number
}

/** 单行建议(只有 halfLifeDays 一行) */
export interface OracleDecaySuggestionRow {
  name: 'halfLifeDays'
  current: number
  suggested: number
  rationale: string
}

/** 单次规划产物 */
export interface OracleDecayTuningSuggestion {
  /** 窗口 score 条数 */
  windowSampleCount: number
  /** 样本寿命 p25 / p50 / p75(天);sample<2 时都为 0 */
  p25AgeDays: number
  p50AgeDays: number
  p75AgeDays: number
  /** 当前 halfLife(读 tuned 文件 or DEFAULT sentinel=0) */
  currentHalfLife: number
  /** 样本不足 / 不需要动时的理由,空串表示 ready */
  insufficientReason: string
  /** 单条建议(empty 时表示不动) */
  rows: OracleDecaySuggestionRow[]
}

// ── 缓存(mtime 触发重读) ──────────────────────────────────────

let cachedTuned: TunedOracleDecay | null = null
let cachedMtime = 0

/**
 * 热路径:oracleAggregator 每次 aggregate* 都要读 halfLife,mtime 比对
 * 避免 disk re-read。
 */
export function loadTunedOracleDecay(): TunedOracleDecay {
  const path = getTunedOracleDecayPath()
  try {
    if (!existsSync(path)) {
      cachedTuned = null
      cachedMtime = 0
      return { ...DEFAULT_TUNED_ORACLE_DECAY }
    }
    const mtime = statSync(path).mtimeMs
    if (cachedTuned && mtime === cachedMtime) return cachedTuned
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as TunedOracleDecay
    if (
      parsed.version !== 1 ||
      typeof parsed.halfLifeDays !== 'number' ||
      !Number.isFinite(parsed.halfLifeDays) ||
      parsed.halfLifeDays < 0
    ) {
      logForDebugging(`[autoEvolve:oracleDecayTuner] tuned-oracle-decay.json schema invalid, falling back to DEFAULT`)
      return { ...DEFAULT_TUNED_ORACLE_DECAY }
    }
    cachedTuned = parsed
    cachedMtime = mtime
    return parsed
  } catch (e) {
    logForDebugging(`[autoEvolve:oracleDecayTuner] loadTunedOracleDecay fallback: ${e}`)
    return { ...DEFAULT_TUNED_ORACLE_DECAY }
  }
}

export function saveTunedOracleDecay(t: TunedOracleDecay): void {
  const path = getTunedOracleDecayPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(t, null, 2), 'utf8')
    cachedTuned = null
    cachedMtime = 0
  } catch (e) {
    logForDebugging(`[autoEvolve:oracleDecayTuner] saveTunedOracleDecay failed: ${e}`)
    throw e
  }
}

export function _resetTunedOracleDecayCacheForTest(): void {
  cachedTuned = null
  cachedMtime = 0
}

// ── 计算帮手 ────────────────────────────────────────────────────

/**
 * 给 (scoredAtIso, halfLifeDays) 算 weight。
 *
 *   halfLifeDays <= 0(sentinel)→ weight = 1(衰减关闭,等同老行为)
 *   halfLifeDays > 0           → weight = 0.5^((now - scoredAt) / halfLife)
 *
 * 解析失败 / 未来时间 → 返回 1(保守,不把坏数据强行衰减)。
 * 这是 oracleAggregator 的热路径 —— 必须无异常。
 */
export function decayWeight(scoredAtIso: string, halfLifeDays: number, nowMs?: number): number {
  if (!(halfLifeDays > 0)) return 1
  const ts = Date.parse(scoredAtIso)
  if (!Number.isFinite(ts)) return 1
  const now = nowMs ?? Date.now()
  const ageMs = now - ts
  if (ageMs <= 0) return 1
  const ageDays = ageMs / 86400_000
  return Math.pow(0.5, ageDays / halfLifeDays)
}

/** 取 p25/p50/p75 分位(nearest-rank,sample<2 返回 [0,0,0]) */
function computeQuantiles(ageDays: number[]): { p25: number; p50: number; p75: number } {
  const n = ageDays.length
  if (n < 2) return { p25: 0, p50: 0, p75: 0 }
  const sorted = [...ageDays].sort((a, b) => a - b)
  const q = (p: number) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)))
    return sorted[idx]
  }
  return { p25: q(0.25), p50: q(0.5), p75: q(0.75) }
}

/** 把建议值对齐到 HALF_LIFE_STEP 的整数倍,且夹紧到 [MIN, MAX] */
function clampAndStep(v: number): number {
  // round to nearest step
  const stepped = Math.max(1, Math.round(v / HALF_LIFE_STEP)) * HALF_LIFE_STEP
  return Math.max(HALF_LIFE_MIN, Math.min(HALF_LIFE_MAX, stepped))
}

// ── 主 API ─────────────────────────────────────────────────────

/**
 * 规划(纯读 —— 不写盘)。
 *
 * 返回 rows 为空 + insufficientReason 非空,表示不动。
 */
export function computeOracleDecayTuningSuggestion(
  windowSamples: number = DEFAULT_DECAY_SAMPLE_WINDOW,
): OracleDecayTuningSuggestion {
  const current = loadTunedOracleDecay()
  const scores = recentFitnessScores(windowSamples)
  const now = Date.now()
  const ageDays: number[] = []
  for (const s of scores) {
    const ts = Date.parse(s.scoredAt)
    if (!Number.isFinite(ts)) continue
    const age = (now - ts) / 86400_000
    if (age < 0) continue  // future timestamp, skip
    ageDays.push(age)
  }
  const { p25, p50, p75 } = computeQuantiles(ageDays)
  const base = {
    windowSampleCount: ageDays.length,
    p25AgeDays: p25,
    p50AgeDays: p50,
    p75AgeDays: p75,
    currentHalfLife: current.halfLifeDays,
  }

  if (ageDays.length < MIN_SAMPLES_DECAY_TUNE) {
    return {
      ...base,
      insufficientReason: `insufficient samples: count=${ageDays.length} < ${MIN_SAMPLES_DECAY_TUNE}`,
      rows: [],
    }
  }

  // 当前 halfLife = 0:首次 opt-in 判断
  if (current.halfLifeDays <= 0) {
    if (p75 < MIN_P75_AGE_FOR_FIRST_OPT_IN) {
      return {
        ...base,
        insufficientReason: `samples too fresh: p75Age=${p75.toFixed(1)}d < ${MIN_P75_AGE_FOR_FIRST_OPT_IN}d (no decay needed yet)`,
        rows: [],
      }
    }
    const suggested = clampAndStep(p75)
    return {
      ...base,
      insufficientReason: '',
      rows: [
        {
          name: 'halfLifeDays',
          current: 0,
          suggested,
          rationale: `first opt-in: p75Age=${p75.toFixed(1)}d ≥ ${MIN_P75_AGE_FOR_FIRST_OPT_IN}d → halfLife=${suggested}d`,
        },
      ],
    }
  }

  // 当前 halfLife > 0:比值决策
  const ratio = p75 / current.halfLifeDays
  let suggested = current.halfLifeDays
  let rationale = ''
  if (ratio >= HIGH_RATIO) {
    suggested = Math.min(HALF_LIFE_MAX, current.halfLifeDays + HALF_LIFE_STEP)
    rationale = `relax: ratio=${ratio.toFixed(3)} ≥ ${HIGH_RATIO.toFixed(2)} (p75=${p75.toFixed(1)}d, halfLife=${current.halfLifeDays}d) → +${HALF_LIFE_STEP}`
  } else if (ratio <= LOW_RATIO) {
    suggested = Math.max(HALF_LIFE_MIN, current.halfLifeDays - HALF_LIFE_STEP)
    rationale = `tighten: ratio=${ratio.toFixed(3)} ≤ ${LOW_RATIO.toFixed(2)} (p75=${p75.toFixed(1)}d, halfLife=${current.halfLifeDays}d) → -${HALF_LIFE_STEP}`
  } else {
    rationale = `hold: ratio=${ratio.toFixed(3)} in (${LOW_RATIO.toFixed(2)}, ${HIGH_RATIO.toFixed(2)}) (p75=${p75.toFixed(1)}d, halfLife=${current.halfLifeDays}d)`
  }
  return {
    ...base,
    insufficientReason: '',
    rows: [{ name: 'halfLifeDays', current: current.halfLifeDays, suggested, rationale }],
  }
}

/**
 * suggestion → 下一版 TunedOracleDecay。
 */
export function suggestionToNext(
  s: OracleDecayTuningSuggestion,
): TunedOracleDecay {
  const base = loadTunedOracleDecay()
  const next: TunedOracleDecay = {
    version: 1,
    updatedAt: new Date().toISOString(),
    halfLifeDays: base.halfLifeDays,
  }
  for (const r of s.rows) {
    if (r.name === 'halfLifeDays') next.halfLifeDays = r.suggested
  }
  return next
}
