/**
 * autoEvolve — self-evolution-kernel v1.0 §5 Phase 5.2 · MetaOracle(种群级 fitness)
 *
 * 定位:
 *   blueprint §2 支柱 VI 把"元进化"描述为外层观察 —— 它不直接决策,而是
 *   回答"当前种群健康吗?"这个问题。本模块产出一个只读 snapshot,供:
 *     - /kernel-status / /evolve-status 展示
 *     - Phase 5.4 灰度期将 verdict 喂给 metaGenome.mutationRate 自调
 *     - 将来的 dashboard
 *
 * 复用(零新增存储):
 *   - arenaController.listOrganismIds        → populationSize / paretoCandidates
 *   - oracle.recentFitnessScores             → avgFitness / paretoWidth
 *   - kinshipIndex.computeDiversity          → diversity (= 1 - meanSim)
 *
 * 纯函数,fail-open,不修改任何状态。
 *
 * verdict 规则(阈值均可通过 env 覆盖):
 *   - populationSize < minPopulation                       → 'insufficient-data'
 *   - 既无 fitness 样本也无 diversity 样本                 → 'insufficient-data'
 *   - diversity != null 且 < convergeDiversityMax          → 'converging'
 *   - diversity != null 且 > divergeDiversityMax           → 'diverging'
 *   - avgFitness != null 且 < divergeFitnessMax            → 'diverging'
 *   - avgFitness != null 且 >= healthyAvgFitnessMin        → 'healthy'
 *   - 其他(信号中性)                                     → 'healthy'
 *
 * 为什么把"信号中性"归 healthy:否则用户只要拿到一份平均 fitness 中等的
 * 种群就永远停在"未知",实践中 noise。verdict 本身只是引导注意力,不硬
 * 阻断任何进化行为,保守默认即可。
 */

import type { OrganismStatus, FitnessScore } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  listOrganismIds,
} from '../arena/arenaController.js'
import { recentFitnessScores } from '../oracle/fitnessOracle.js'
import { computeDiversity } from '../arena/kinshipIndex.js'
import type { DiversityResult } from '../arena/kinshipIndex.js'

/** 所有 alive 的状态(不含 archived / vetoed)。用来计算 populationSize。 */
export const ALIVE_STATUSES: OrganismStatus[] = [
  'proposal',
  'shadow',
  'canary',
  'stable',
]

/**
 * MetaOracle 判定结果。
 */
export type MetaOracleVerdict =
  | 'healthy'          // 种群稳定,继续正常演化
  | 'converging'       // 多样性过低,需要提升变异率/注入新种
  | 'diverging'        // 多样性过高或平均 fitness 过低,种群不稳定
  | 'insufficient-data' // 样本不足,无法判断

export interface MetaOracleSnapshot {
  capturedAt: string
  /** 所有 alive 状态之和(stable + canary + shadow + proposal) */
  populationSize: number
  /** 分状态计数,便于诊断 */
  populationByStatus: Record<OrganismStatus, number>
  /** 平均 fitness(已映射到 [0,1],score=(s+1)/2);样本不足 → null */
  avgFitness: number | null
  fitnessSampleSize: number
  /** 多样性 ∈ [0,1];=1-meanJaccard。样本不足 → null */
  diversity: number | null
  diversityMeanSim: number | null
  diversitySampleSize: number
  /** stable 组里非被支配的 organism 数量(帕累托前沿宽度) */
  paretoWidth: number
  paretoCandidates: number
  verdict: MetaOracleVerdict
  verdictReason: string
  /** 本次生效的阈值快照,便于 /evolve-status 对照 */
  thresholds: MetaOracleThresholds
}

/**
 * 阈值族。每项都支持 env 覆盖 & clamp。
 */
export interface MetaOracleThresholds {
  minPopulation: number
  minFitnessSamples: number
  healthyAvgFitnessMin: number
  convergeDiversityMax: number
  divergeDiversityMax: number
  divergeFitnessMax: number
  fitnessSampleCap: number
  diversityMaxSample: number
}

export const DEFAULT_META_ORACLE_THRESHOLDS: MetaOracleThresholds = {
  minPopulation: 3,
  minFitnessSamples: 10,
  healthyAvgFitnessMin: 0.55,
  convergeDiversityMax: 0.3,
  divergeDiversityMax: 0.8,
  divergeFitnessMax: 0.35,
  fitnessSampleCap: 2000,
  diversityMaxSample: 64,
}

function readEnvNumber(key: string): number | undefined {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

function clampPositiveInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.trunc(v)))
}

/**
 * 读取当前生效的阈值(env > default),并 clamp。
 */
export function getEffectiveMetaOracleThresholds(): MetaOracleThresholds {
  const d = DEFAULT_META_ORACLE_THRESHOLDS
  const get = (k: string, def: number) => readEnvNumber(k) ?? def
  return {
    minPopulation: clampPositiveInt(
      get('CLAUDE_EVOLVE_META_MIN_POP', d.minPopulation),
      1, 1000,
    ),
    minFitnessSamples: clampPositiveInt(
      get('CLAUDE_EVOLVE_META_MIN_FITNESS_SAMPLES', d.minFitnessSamples),
      1, 100000,
    ),
    healthyAvgFitnessMin: clamp01(
      get('CLAUDE_EVOLVE_META_HEALTHY_FITNESS', d.healthyAvgFitnessMin),
    ),
    convergeDiversityMax: clamp01(
      get('CLAUDE_EVOLVE_META_CONVERGE_DIV', d.convergeDiversityMax),
    ),
    divergeDiversityMax: clamp01(
      get('CLAUDE_EVOLVE_META_DIVERGE_DIV', d.divergeDiversityMax),
    ),
    divergeFitnessMax: clamp01(
      get('CLAUDE_EVOLVE_META_DIVERGE_FITNESS', d.divergeFitnessMax),
    ),
    fitnessSampleCap: clampPositiveInt(
      get('CLAUDE_EVOLVE_META_FITNESS_SAMPLE_CAP', d.fitnessSampleCap),
      50, 100000,
    ),
    diversityMaxSample: clampPositiveInt(
      get('CLAUDE_EVOLVE_META_DIVERSITY_MAX_SAMPLE', d.diversityMaxSample),
      2, 512,
    ),
  }
}

/**
 * 把 [-1, +1] 的 FitnessScore.score 线性映射到 [0, 1]。
 * 与 diversity 同域,便于后续加权。
 */
function normalizeScore(s: number): number {
  if (!Number.isFinite(s)) return 0
  return clamp01((s + 1) / 2)
}

/**
 * 聚合每个 organism 的平均 dimensions(Phase 5.2 内部用,不导出)。
 * 只有 stable 状态且有 organismId 的 score 才会进 pareto 池。
 */
function aggregateDimensionsByOrganism(
  scores: FitnessScore[],
  keepIds: Set<string>,
): Map<string, { userSatisfaction: number; taskSuccess: number; codeQuality: number; performance: number; n: number }> {
  const acc = new Map<string, { userSatisfaction: number; taskSuccess: number; codeQuality: number; performance: number; n: number }>()
  for (const s of scores) {
    const oid = s.organismId
    if (!oid || !keepIds.has(oid)) continue
    const d = s.dimensions
    if (!d) continue
    const prev = acc.get(oid) ?? {
      userSatisfaction: 0, taskSuccess: 0, codeQuality: 0, performance: 0, n: 0,
    }
    prev.userSatisfaction += clamp01(d.userSatisfaction)
    prev.taskSuccess += clamp01(d.taskSuccess)
    prev.codeQuality += clamp01(d.codeQuality)
    prev.performance += clamp01(d.performance)
    prev.n += 1
    acc.set(oid, prev)
  }
  // 取平均
  for (const [k, v] of acc.entries()) {
    if (v.n === 0) continue
    acc.set(k, {
      userSatisfaction: v.userSatisfaction / v.n,
      taskSuccess: v.taskSuccess / v.n,
      codeQuality: v.codeQuality / v.n,
      performance: v.performance / v.n,
      n: v.n,
    })
  }
  return acc
}

/**
 * 非支配集合大小(帕累托前沿宽度)。
 * 对于每对 (a, b),若 b 的所有维度 >= a 且至少一维 > a,则 a 被支配。
 */
function paretoFrontSize(
  perOrganism: Map<string, { userSatisfaction: number; taskSuccess: number; codeQuality: number; performance: number; n: number }>,
): number {
  const arr = Array.from(perOrganism.values())
  if (arr.length === 0) return 0
  const DIMS: Array<keyof typeof arr[0]> = ['userSatisfaction', 'taskSuccess', 'codeQuality', 'performance']
  let frontCount = 0
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i]
    let dominated = false
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue
      const b = arr[j]
      // b dominates a?
      let allGeq = true
      let strictGreater = false
      for (const dim of DIMS) {
        const av = a[dim] as number
        const bv = b[dim] as number
        if (bv < av) { allGeq = false; break }
        if (bv > av) strictGreater = true
      }
      if (allGeq && strictGreater) { dominated = true; break }
    }
    if (!dominated) frontCount += 1
  }
  return frontCount
}

export interface ComputeMetaOracleSnapshotOptions {
  /** 覆盖默认的阈值(对应 getEffectiveMetaOracleThresholds) */
  thresholds?: Partial<MetaOracleThresholds>
  /** 注入自定义 diversityResult(主要用于测试) */
  diversityOverride?: DiversityResult
  /** 注入自定义 fitness scores(主要用于测试) */
  fitnessOverride?: FitnessScore[]
}

/**
 * 计算当前种群健康 snapshot。纯函数 + fail-open。
 *
 * 任何一路数据源失败 → 该字段回退到 null/0,verdict 不因此升级成 error。
 */
export function computeMetaOracleSnapshot(
  opts: ComputeMetaOracleSnapshotOptions = {},
): MetaOracleSnapshot {
  const base = getEffectiveMetaOracleThresholds()
  const thresholds: MetaOracleThresholds = { ...base, ...(opts.thresholds ?? {}) }

  const populationByStatus: Record<OrganismStatus, number> = {
    proposal: 0,
    shadow: 0,
    canary: 0,
    stable: 0,
    vetoed: 0,
    archived: 0,
  }
  let populationSize = 0
  const stableIds = new Set<string>()
  try {
    for (const st of ALIVE_STATUSES) {
      const ids = listOrganismIds(st)
      populationByStatus[st] = ids.length
      populationSize += ids.length
      if (st === 'stable') {
        for (const id of ids) stableIds.add(id)
      }
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaOracle] listOrganismIds failed: ${(e as Error).message}`,
    )
  }

  // avgFitness:最近 fitnessSampleCap 条,取 score 映射 [0,1]
  let fitnessSampleSize = 0
  let avgFitness: number | null = null
  let allScores: FitnessScore[] = []
  try {
    allScores = opts.fitnessOverride ?? recentFitnessScores(thresholds.fitnessSampleCap)
    fitnessSampleSize = allScores.length
    if (fitnessSampleSize >= thresholds.minFitnessSamples) {
      let sum = 0
      for (const s of allScores) sum += normalizeScore(s.score)
      avgFitness = clamp01(sum / fitnessSampleSize)
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaOracle] recentFitnessScores failed: ${(e as Error).message}`,
    )
  }

  // diversity
  let diversity: number | null = null
  let diversityMeanSim: number | null = null
  let diversitySampleSize = 0
  try {
    const div = opts.diversityOverride ?? computeDiversity({
      maxSample: thresholds.diversityMaxSample,
    })
    diversity = div.diversity
    diversityMeanSim = div.meanSimilarity
    diversitySampleSize = div.sampleSize
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaOracle] computeDiversity failed: ${(e as Error).message}`,
    )
  }

  // paretoWidth: 限于 stable 组
  let paretoWidth = 0
  let paretoCandidates = 0
  try {
    if (stableIds.size > 0 && allScores.length > 0) {
      const perOrg = aggregateDimensionsByOrganism(allScores, stableIds)
      paretoCandidates = perOrg.size
      paretoWidth = paretoFrontSize(perOrg)
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:metaOracle] pareto compute failed: ${(e as Error).message}`,
    )
  }

  // verdict
  let verdict: MetaOracleVerdict = 'healthy'
  let verdictReason = 'population signals within nominal band'
  if (populationSize < thresholds.minPopulation) {
    verdict = 'insufficient-data'
    verdictReason = `population ${populationSize} < minPopulation ${thresholds.minPopulation}`
  } else if (avgFitness === null && diversity === null) {
    verdict = 'insufficient-data'
    verdictReason = 'neither fitness nor diversity samples available'
  } else if (diversity !== null && diversity < thresholds.convergeDiversityMax) {
    verdict = 'converging'
    verdictReason = `diversity ${diversity.toFixed(3)} < converge threshold ${thresholds.convergeDiversityMax}`
  } else if (diversity !== null && diversity > thresholds.divergeDiversityMax) {
    verdict = 'diverging'
    verdictReason = `diversity ${diversity.toFixed(3)} > diverge threshold ${thresholds.divergeDiversityMax}`
  } else if (avgFitness !== null && avgFitness < thresholds.divergeFitnessMax) {
    verdict = 'diverging'
    verdictReason = `avgFitness ${avgFitness.toFixed(3)} < diverge fitness threshold ${thresholds.divergeFitnessMax}`
  } else if (avgFitness !== null && avgFitness >= thresholds.healthyAvgFitnessMin) {
    verdict = 'healthy'
    verdictReason = `avgFitness ${avgFitness.toFixed(3)} >= healthy threshold ${thresholds.healthyAvgFitnessMin}`
  }

  return {
    capturedAt: new Date().toISOString(),
    populationSize,
    populationByStatus,
    avgFitness,
    fitnessSampleSize,
    diversity,
    diversityMeanSim,
    diversitySampleSize,
    paretoWidth,
    paretoCandidates,
    verdict,
    verdictReason,
    thresholds,
  }
}
