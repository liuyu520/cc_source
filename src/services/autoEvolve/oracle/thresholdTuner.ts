/**
 * autoEvolve — Phase 24 threshold auto-tuner
 *
 * 问题:autoPromotionEngine / oracleAggregator / goodhartGuard 的几个核心阈值
 * (oracle-adverse / organism-win / organism-loss / goodhart-perfect-avg)目前
 * 全是"凭直觉拍"的硬编码常量。但真实 fitness 分布会随着项目、用户、模型能力
 * 迁移而变化 —— 一个在 MiniMax-M2.7 下偏慢启动的用户,organism-win=0.3 可能
 * 永远达不到,进而整套 FSM 失灵;反过来一个 canonical 分布偏高的环境,
 * perfect-record(>=0.95)会被当成"奖励作弊"错杀。
 *
 * 本模块提供一个纯读的 "建议" 路径 + 一个 JSON 快照文件:
 *   1. computeTuningSuggestion(windowDays) —— 从 fitness.ndjson 最近窗口里
 *      按分位数重算 4 个阈值,并给出每个阈值的 rationale + dataPoints。
 *   2. loadTunedThresholds() —— mtime-cached 读 tuned-thresholds.json;文件
 *      缺失或读取失败直接回退 DEFAULT_TUNED_THRESHOLDS,保证上游模块永远拿到
 *      一个完整对象,不需要到处写 ?? default。
 *   3. saveTunedThresholds() —— 写文件 + invalidate cache;/evolve-tune --apply
 *      的唯一写入口。
 *
 * 位置选择(oracle/):与 fitnessOracle / goodhartGuard / oracleAggregator 同层,
 * 复用 recentFitnessScores 读 ledger,不跨目录。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { FitnessScore } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getTunedThresholdsPath } from '../paths.js'
import { recentFitnessScores } from './fitnessOracle.js'

/**
 * 调过的阈值快照。version 用于将来破坏性迁移(例如新增阈值时旧文件仍可读)。
 */
export interface TunedThresholds {
  version: 1
  updatedAt: string
  /**
   * autoPromotionEngine:oracleAvg <= 此值 触发全局 gatedByOracle。
   * 默认 -0.5;分位数建议值 ≈ 最近窗口 score 的 p10(越负越严)。
   */
  oracleAdverseAvg: number
  /**
   * oracleAggregator:单条 score >= 此值计一次 win。
   * 默认 0.3;分位数建议值 ≈ 正分段的 median(可控范围 [0.1, 0.8])。
   */
  organismWinThreshold: number
  /**
   * oracleAggregator:单条 score <= 此值计一次 loss。
   * 默认 -0.3;分位数建议值 ≈ 负分段的 median(可控范围 [-0.8, -0.1])。
   */
  organismLossThreshold: number
  /**
   * goodhartGuard R4 perfect-record:avg >= 此值且 trials>=10 且 losses=0 判违禁。
   * 默认 0.95;分位数建议值 ≈ max(正分段 p99, 0.9),不让它跌到 0.9 以下避免 R4 过于严格。
   */
  goodhartPerfectAvgMin: number
}

export const DEFAULT_TUNED_THRESHOLDS: TunedThresholds = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  oracleAdverseAvg: -0.5,
  organismWinThreshold: 0.3,
  organismLossThreshold: -0.3,
  goodhartPerfectAvgMin: 0.95,
}

// ── mtime-based cache ──────────────────────────────────────────────────
// 调用方每次 decide/aggregate 都会读一次阈值;文件 IO 要廉价。这里用 mtime
// 校验:文件没变就直接返回缓存;变了(比如 /evolve-tune --apply 刚写完)
// 自动重新读。saveTunedThresholds 同步 invalidate,双保险。
let _cache: { mtimeMs: number; value: TunedThresholds } | null = null

function invalidateCache(): void {
  _cache = null
}

/**
 * 读当前生效阈值。文件缺失/损坏时返回 DEFAULT_TUNED_THRESHOLDS。
 * 不抛异常,保证调用方 decide() 永远能拿到数值。
 */
export function loadTunedThresholds(): TunedThresholds {
  try {
    const p = getTunedThresholdsPath()
    if (!existsSync(p)) return DEFAULT_TUNED_THRESHOLDS
    const st = statSync(p)
    if (_cache && _cache.mtimeMs === st.mtimeMs) return _cache.value
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TunedThresholds>
    // 字段级回退:任一字段缺失用默认值兜底(防止文件被手改成半残)
    const value: TunedThresholds = {
      version: 1,
      updatedAt: parsed.updatedAt ?? DEFAULT_TUNED_THRESHOLDS.updatedAt,
      oracleAdverseAvg:
        typeof parsed.oracleAdverseAvg === 'number'
          ? parsed.oracleAdverseAvg
          : DEFAULT_TUNED_THRESHOLDS.oracleAdverseAvg,
      organismWinThreshold:
        typeof parsed.organismWinThreshold === 'number'
          ? parsed.organismWinThreshold
          : DEFAULT_TUNED_THRESHOLDS.organismWinThreshold,
      organismLossThreshold:
        typeof parsed.organismLossThreshold === 'number'
          ? parsed.organismLossThreshold
          : DEFAULT_TUNED_THRESHOLDS.organismLossThreshold,
      goodhartPerfectAvgMin:
        typeof parsed.goodhartPerfectAvgMin === 'number'
          ? parsed.goodhartPerfectAvgMin
          : DEFAULT_TUNED_THRESHOLDS.goodhartPerfectAvgMin,
    }
    _cache = { mtimeMs: st.mtimeMs, value }
    return value
  } catch (e) {
    logForDebugging(
      `[autoEvolve:thresholdTuner] loadTunedThresholds fallback: ${(e as Error).message}`,
    )
    return DEFAULT_TUNED_THRESHOLDS
  }
}

/**
 * 写 tuned-thresholds.json 并 invalidate 缓存。/evolve-tune --apply 的唯一写入口。
 * 写失败返回 {ok:false, error};不抛。
 */
export function saveTunedThresholds(
  next: Omit<TunedThresholds, 'version' | 'updatedAt'>,
): { ok: boolean; error?: string; path: string; value?: TunedThresholds } {
  const p = getTunedThresholdsPath()
  const value: TunedThresholds = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...next,
  }
  try {
    writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf-8')
    invalidateCache()
    return { ok: true, path: p, value }
  } catch (e) {
    return { ok: false, path: p, error: (e as Error).message }
  }
}

// ── 分位数建议 ──────────────────────────────────────────────────────────

/** 单个阈值的建议 + 该建议背后的依据行 */
export interface ThresholdSuggestionRow {
  name: keyof Omit<TunedThresholds, 'version' | 'updatedAt'>
  current: number
  suggested: number
  rationale: string
}

/** computeTuningSuggestion 完整返回 */
export interface TuningSuggestion {
  /** 实际用于计算的窗口 fitness 分数个数 */
  dataPoints: number
  /** 窗口内正分段 (score>0) 个数 */
  positiveCount: number
  /** 窗口内负分段 (score<0) 个数 */
  negativeCount: number
  /** 窗口起点(含),ISO 字符串;dataPoints=0 时为空字符串 */
  windowFrom: string
  /** 建议行(即便 insufficient 也会列出,只是 suggested==current) */
  rows: ThresholdSuggestionRow[]
  /** 若数据量太少 (<MIN_SAMPLES_FOR_TUNE),此处给出原因;否则空字符串 */
  insufficientReason: string
  /** 当前生效阈值快照(方便 /evolve-tune 对照展示) */
  current: TunedThresholds
}

/**
 * 分位数建议阈值需要的最少样本数。低于此值我们拒绝给出建议,直接返回 current
 * ——percentile 在 n<10 时噪声非常大,"稍微抽 5 条就重写阈值"反而会动摇系统。
 */
export const MIN_SAMPLES_FOR_TUNE = 10

/**
 * 在 sorted 数组上取百分位(线性插值 percentile-continuous)。
 * p ∈ [0, 100]。空数组返回 fallback。
 */
export function percentile(
  sorted: number[],
  p: number,
  fallback: number,
): number {
  if (sorted.length === 0) return fallback
  if (sorted.length === 1) return sorted[0]
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

/** 把数值钳到 [min,max] 并保留 2 位小数(JSON 读起来清爽,对下游决策影响可忽略) */
function clamp2(v: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, v))
  return Math.round(clamped * 100) / 100
}

/**
 * 核心:窗口 fitness ledger → 4 个阈值的建议。
 *
 * windowDays 默认 30。我们用 recentFitnessScores(LARGE_CAP) 再按时间窗过滤;
 * 这是因为 fitness ledger 有 Phase 12 rotation 但单文件上限 10MB,30 天内样本
 * 基本不会超过 100_000 条;用 recentFitnessScores 的简单 slice(-N) 读法已经够用。
 *
 * 不读盘失败时返回 insufficientReason + current 兜底,不抛。
 */
export function computeTuningSuggestion(
  windowDays = 30,
  opts?: {
    /** 测试用:直接注入 scores,绕开 ledger IO */
    scoresOverride?: FitnessScore[]
    /** 测试用:固定"now"以便写稳定断言 */
    nowMs?: number
  },
): TuningSuggestion {
  const current = loadTunedThresholds()
  const baseRow = (
    name: ThresholdSuggestionRow['name'],
    suggested: number,
    rationale: string,
  ): ThresholdSuggestionRow => ({
    name,
    current: current[name],
    suggested,
    rationale,
  })

  // 取数据
  let raw: FitnessScore[]
  if (opts?.scoresOverride) {
    raw = opts.scoresOverride
  } else {
    // LARGE_CAP: 先把 ledger 最近 50_000 条全部取回,再按窗口过滤
    raw = recentFitnessScores(50_000)
  }

  const now = opts?.nowMs ?? Date.now()
  const windowStart = now - windowDays * 24 * 3600 * 1000
  const windowStartIso = new Date(windowStart).toISOString()

  const inWindow = raw.filter(s => {
    const t = Date.parse(s.scoredAt)
    if (Number.isNaN(t)) return false
    return t >= windowStart
  })
  const dataPoints = inWindow.length
  const scores = inWindow.map(s => s.score)
  const positives = scores.filter(s => s > 0).sort((a, b) => a - b)
  const negatives = scores.filter(s => s < 0).sort((a, b) => a - b)

  const rows: ThresholdSuggestionRow[] = []

  // 数据不足 → 维持 current,给出 reason
  if (dataPoints < MIN_SAMPLES_FOR_TUNE) {
    rows.push(
      baseRow(
        'oracleAdverseAvg',
        current.oracleAdverseAvg,
        `insufficient samples (${dataPoints} < ${MIN_SAMPLES_FOR_TUNE}); keeping current`,
      ),
      baseRow(
        'organismWinThreshold',
        current.organismWinThreshold,
        `insufficient samples (${dataPoints} < ${MIN_SAMPLES_FOR_TUNE}); keeping current`,
      ),
      baseRow(
        'organismLossThreshold',
        current.organismLossThreshold,
        `insufficient samples (${dataPoints} < ${MIN_SAMPLES_FOR_TUNE}); keeping current`,
      ),
      baseRow(
        'goodhartPerfectAvgMin',
        current.goodhartPerfectAvgMin,
        `insufficient samples (${dataPoints} < ${MIN_SAMPLES_FOR_TUNE}); keeping current`,
      ),
    )
    return {
      dataPoints,
      positiveCount: positives.length,
      negativeCount: negatives.length,
      windowFrom: dataPoints > 0 ? windowStartIso : '',
      rows,
      insufficientReason: `fewer than ${MIN_SAMPLES_FOR_TUNE} scores in last ${windowDays} days`,
      current,
    }
  }

  // 1. oracleAdverseAvg ≈ 全体 p10,但钳在 [-1, -0.1](别太松也别太严)
  const allSorted = [...scores].sort((a, b) => a - b)
  const p10 = percentile(allSorted, 10, current.oracleAdverseAvg)
  const oracleAdverseSuggested = clamp2(p10, -1, -0.1)

  // 2. organismWinThreshold ≈ 正分段 median,钳在 [0.1, 0.8]
  let winSuggested = current.organismWinThreshold
  let winRationale: string
  if (positives.length === 0) {
    winRationale = `no positive scores in window; keeping current ${current.organismWinThreshold}`
  } else {
    const posMedian = percentile(positives, 50, current.organismWinThreshold)
    winSuggested = clamp2(posMedian, 0.1, 0.8)
    winRationale = `median of ${positives.length} positive scores (p50=${posMedian.toFixed(3)}), clamped to [0.1,0.8]`
  }

  // 3. organismLossThreshold ≈ 负分段 median,钳在 [-0.8, -0.1]
  let lossSuggested = current.organismLossThreshold
  let lossRationale: string
  if (negatives.length === 0) {
    lossRationale = `no negative scores in window; keeping current ${current.organismLossThreshold}`
  } else {
    const negMedian = percentile(negatives, 50, current.organismLossThreshold)
    lossSuggested = clamp2(negMedian, -0.8, -0.1)
    lossRationale = `median of ${negatives.length} negative scores (p50=${negMedian.toFixed(3)}), clamped to [-0.8,-0.1]`
  }

  // 4. goodhartPerfectAvgMin ≈ max(正分段 p99, 0.9),钳在 [0.9, 0.99]
  let perfectSuggested = current.goodhartPerfectAvgMin
  let perfectRationale: string
  if (positives.length === 0) {
    perfectRationale = `no positive scores in window; keeping current ${current.goodhartPerfectAvgMin}`
  } else {
    const posP99 = percentile(positives, 99, current.goodhartPerfectAvgMin)
    const raw = Math.max(posP99, 0.9)
    perfectSuggested = clamp2(raw, 0.9, 0.99)
    perfectRationale = `max(p99 of ${positives.length} positives=${posP99.toFixed(3)}, 0.9), clamped to [0.9,0.99]`
  }

  rows.push(
    baseRow(
      'oracleAdverseAvg',
      oracleAdverseSuggested,
      `p10 of ${dataPoints} scores (raw=${p10.toFixed(3)}), clamped to [-1,-0.1]`,
    ),
    baseRow('organismWinThreshold', winSuggested, winRationale),
    baseRow('organismLossThreshold', lossSuggested, lossRationale),
    baseRow('goodhartPerfectAvgMin', perfectSuggested, perfectRationale),
  )
  return {
    dataPoints,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    windowFrom: windowStartIso,
    rows,
    insufficientReason: '',
    current,
  }
}

/**
 * 便捷工具:把 suggestion.rows 折成一个完整 Next 对象,供 saveTunedThresholds
 * 直接用。若某行 suggested 与 current 一样,就原样保留 current。
 */
export function suggestionToNext(
  s: TuningSuggestion,
): Omit<TunedThresholds, 'version' | 'updatedAt'> {
  const byName = new Map(s.rows.map(r => [r.name, r.suggested]))
  return {
    oracleAdverseAvg:
      byName.get('oracleAdverseAvg') ?? s.current.oracleAdverseAvg,
    organismWinThreshold:
      byName.get('organismWinThreshold') ?? s.current.organismWinThreshold,
    organismLossThreshold:
      byName.get('organismLossThreshold') ?? s.current.organismLossThreshold,
    goodhartPerfectAvgMin:
      byName.get('goodhartPerfectAvgMin') ?? s.current.goodhartPerfectAvgMin,
  }
}

/**
 * 测试辅助:强制清空缓存。生产代码不应调;测试里 writeFileSync(mtime 同秒)
 * 可能让 mtimeMs 重复,手动 invalidate 最安全。
 */
export function _resetTunedThresholdsCacheForTest(): void {
  invalidateCache()
}
