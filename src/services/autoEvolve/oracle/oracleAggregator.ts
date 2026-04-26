/**
 * Oracle Aggregator — Phase 7
 *
 * 职责:
 *   把 Phase 3 写入 fitness.ndjson 的 session 级 FitnessScore,
 *   通过 Phase 7 的 session-organisms.ndjson 反查,
 *   分摊到在该 session 中被触发过的每个 stable organism。
 *
 * 数据流:
 *   fitness.ndjson          ─┐
 *     { subjectId: sessionId, score, scoredAt, signature, ... }
 *                            ├─► aggregateOrganismFitness(id)
 *   session-organisms.ndjson─┘    按 score 分桶 → { wins, losses, neutrals, avg, lastAt }
 *
 * 为什么不直接改 fitnessOracle.ts?
 *   - Phase 3 的打分契约稳定(subjectId=session,权重固定),不要污染主路径
 *   - 聚合是旁路读操作,放单独文件方便 Phase 8+ 换算法/加缓存
 *   - 与 sessionOrganismLedger 的粒度对齐(一个职责一个文件)
 *
 * 复用纪律:
 *   - 读 fitness.ndjson 走 fitnessOracle.recentFitnessScores(很大 limit)
 *     → 保留已有的文件读 + 坏行跳过 + 失败静默逻辑,不重复实现
 *   - 读 session-organisms 走 sessionOrganismLedger.readSessionOrganismLinks()
 *   - 阈值与 autoPromotionEngine 解耦:engine 想用就 import,不想用也不破坏这里
 */

import type { FitnessScore } from '../types.js'
import { recentFitnessScores } from './fitnessOracle.js'
import { readSessionOrganismLinks } from './sessionOrganismLedger.js'
import { loadTunedThresholds } from './thresholdTuner.js'
// Phase 39:Oracle 权重时间衰减。halfLifeDays=0(sentinel)时 decayWeight
// 恒返回 1,聚合逻辑等价于 Phase 1-38。
import { decayWeight, loadTunedOracleDecay } from './oracleDecayTuner.js'

/**
 * 分桶阈值 —— Phase 7 保守取值:|score|<0.3 视为中性。
 *
 * 选 0.3 的理由:默认 Oracle 权重(0.4/0.3/0.15/0.1)下,
 * 单项 userConfirm=1 其它全 0 归一 ≈ 0.44 → win;
 * 单项 taskCompleted=1 其它全 0 归一 ≈ 0.33 → win;
 * 若只有 retries 惩罚或 1 次 revert,归一会落在 [-0.3, 0],算 neutral。
 * 这样 wins / losses 更像"明确的信号",不会被噪声淹没。
 */
export const ORGANISM_WIN_THRESHOLD = 0.3
export const ORGANISM_LOSS_THRESHOLD = -0.3

/** 默认扫描窗口:最近 500 条 fitness 打分。Phase 7 规模可控。 */
export const DEFAULT_FITNESS_WINDOW = 500

/**
 * 单个 organism 的 fitness 聚合结果。
 * trials === wins + losses + neutrals(定义)。
 */
export interface OrganismFitnessAggregate {
  organismId: string
  trials: number
  wins: number
  losses: number
  neutrals: number
  /** 归属到该 organism 的所有 score 的算术平均;trials=0 时为 0 */
  avg: number
  /** 最近一次相关 score 的 scoredAt,trials=0 时为 null */
  lastAt: string | null
  /** 最近一次相关 score 的签名,方便写回 manifest.fitness.lastScoreSignature */
  lastScoreSignature?: string
}

/**
 * 给定 organism,在 fitness.ndjson 最近 window 条里,
 * 找出属于该 organism 参与过的 session 的打分,聚合统计。
 *
 * 失败(读文件/解析)返回空结果(trials=0),不抛异常。
 */
export function aggregateOrganismFitness(
  organismId: string,
  opts?: { window?: number },
): OrganismFitnessAggregate {
  const window = opts?.window ?? DEFAULT_FITNESS_WINDOW
  const empty: OrganismFitnessAggregate = {
    organismId,
    trials: 0,
    wins: 0,
    losses: 0,
    neutrals: 0,
    avg: 0,
    lastAt: null,
  }

  // 1. 拿到该 organism 在哪些 session 中被触发过
  // Phase 26:links 可能完全为空(用户从不用 legacy 反查层);sessionSet
  // 也可能因为该 organism 从未被写入 session-organisms.ndjson 而为 0 条 —
  // 此时仍然要走到 scores 循环,FitnessScore.organismId 直接归属就能命中。
  // 所以删掉 Phase 7 的两处早退,把判空交给最终的 trials 判断。
  const links = readSessionOrganismLinks()
  const sessionSet = new Set<string>()
  for (const l of links) {
    if (l.organismId === organismId) sessionSet.add(l.sessionId)
  }

  // 2. 在最近 window 条 fitness 打分里,挑 subjectId 命中的
  const scores = recentFitnessScores(window)
  if (scores.length === 0) return empty

  // Phase 24:bucket 阈值改从 tuned-thresholds.json 读,未调整时等于默认常量。
  const tuned = loadTunedThresholds()
  const winT = tuned.organismWinThreshold
  const lossT = tuned.organismLossThreshold

  // Phase 39:oracle 权重时间衰减。halfLifeDays=0(sentinel)时 decayWeight
  // 恒返回 1,weightedSum / weightSum 与老路径 sum / trials 数值等价 ——
  // 100% 向后兼容。halfLifeDays>0 时,老样本按 0.5^(age/halfLife) 加权,
  // avg 成为加权平均(但 trials/wins/losses/neutrals 保持整数,下游
  // autoPromotionEngine 的 MIN_INVOCATIONS 对比不受影响)。
  const decay = loadTunedOracleDecay()

  let wins = 0
  let losses = 0
  let neutrals = 0
  let weightedSum = 0
  let weightSum = 0
  let lastAt: string | null = null
  let lastSig: string | undefined
  let lastTs = -Infinity

  // Phase 26:先做"是否可以走直接归属"的判断。
  // FitnessScore.organismId 由 fitnessObserver 在命中 `.autoevolve-organism`
  // marker 时填写,命中时直接按 id 计数,不依赖 session-organisms.ndjson。
  // 两路互斥判定:organismId 匹配 OR sessionSet.has(subjectId) 匹配就算命中,
  // 避免 Phase 7 反查里漏 link 的 organism 还能补上,也不会因为同一条 score
  // 走两条路被重复计数(for 循环每条 score 只判一次)。
  for (const s of scores) {
    const directHit = s.organismId === organismId
    const sessionHit = sessionSet.has(s.subjectId)
    if (!directHit && !sessionHit) continue
    // 分桶(不受衰减影响,仍按整条样本计数)
    if (s.score >= winT) wins++
    else if (s.score <= lossT) losses++
    else neutrals++
    // Phase 39:weight = decayWeight(scoredAt, halfLifeDays);halfLife=0 → 1
    const w = decayWeight(s.scoredAt, decay.halfLifeDays)
    weightedSum += s.score * w
    weightSum += w
    // 取最近时间戳(scoredAt 是 ISO,按 Date.parse 比较)
    const ts = Date.parse(s.scoredAt)
    if (Number.isFinite(ts) && ts > lastTs) {
      lastTs = ts
      lastAt = s.scoredAt
      lastSig = s.signature
    }
  }

  const trials = wins + losses + neutrals
  if (trials === 0) return empty

  return {
    organismId,
    trials,
    wins,
    losses,
    neutrals,
    // Phase 39:weighted average;weightSum>0 保证除法安全,halfLife=0 时
    // weightSum=trials 且 weightedSum=sum → 结果等同 sum/trials。
    avg: weightSum > 0 ? weightedSum / weightSum : 0,
    lastAt,
    lastScoreSignature: lastSig,
  }
}

/**
 * 一次性聚合所有在 session-organisms.ndjson 里出现过的 organism。
 *
 * 相比对每个 id 调 aggregateOrganismFitness:
 *   - 只读一次 fitness.ndjson 和一次 session-organisms.ndjson
 *   - 适合 refreshAllOrganismFitness 批量写回 manifest 用
 *
 * 返回 Map<organismId, aggregate>,只包含 trials>0 的 organism。
 */
export function aggregateAllOrganisms(opts?: {
  window?: number
}): Map<string, OrganismFitnessAggregate> {
  const window = opts?.window ?? DEFAULT_FITNESS_WINDOW
  const out = new Map<string, OrganismFitnessAggregate>()

  const links = readSessionOrganismLinks()
  if (links.length === 0) return out

  // session → organismSet 反查表(多对多,一个 session 可被多个 organism 触发)
  const sessionToOrganisms = new Map<string, Set<string>>()
  const allOrganisms = new Set<string>()
  for (const l of links) {
    allOrganisms.add(l.organismId)
    let s = sessionToOrganisms.get(l.sessionId)
    if (!s) {
      s = new Set<string>()
      sessionToOrganisms.set(l.sessionId, s)
    }
    s.add(l.organismId)
  }

  const scores = recentFitnessScores(window)
  if (scores.length === 0) return out

  // Phase 24:bucket 阈值读 tuned-thresholds.json(同 aggregateOrganismFitness)。
  const tuned = loadTunedThresholds()
  const winT = tuned.organismWinThreshold
  const lossT = tuned.organismLossThreshold

  // Phase 39:oracle 权重时间衰减;与 aggregateOrganismFitness 同构。
  // halfLifeDays=0(sentinel)时 decayWeight≡1,weightedSum/weightSum
  // 退化为 sum/trials,100% 向后兼容。
  const decay = loadTunedOracleDecay()

  // organism → 累加器
  type Acc = {
    wins: number
    losses: number
    neutrals: number
    weightedSum: number
    weightSum: number
    lastAt: string | null
    lastSig?: string
    lastTs: number
  }
  const acc = new Map<string, Acc>()
  function ensure(id: string): Acc {
    let a = acc.get(id)
    if (!a) {
      a = {
        wins: 0,
        losses: 0,
        neutrals: 0,
        weightedSum: 0,
        weightSum: 0,
        lastAt: null,
        lastSig: undefined,
        lastTs: -Infinity,
      }
      acc.set(id, a)
    }
    return a
  }

  for (const s of scores) {
    // Phase 26:先尝试直接归属(score.organismId 由 fitnessObserver 从
    // `.autoevolve-organism` marker 写入),未命中再退回 Phase 7 的
    // sessionToOrganisms 反查。两者 union 后进 Set,保证同一 organism 对同
    // 一条 score 只计一次(即使两条路都命中,也不会重复计分桶)。
    const hits = new Set<string>()
    if (s.organismId) hits.add(s.organismId)
    const orgs = sessionToOrganisms.get(s.subjectId)
    if (orgs) {
      for (const id of orgs) hits.add(id)
    }
    if (hits.size === 0) continue
    const ts = Date.parse(s.scoredAt)
    // Phase 39:每条 score 只算一次 weight(两个命中 organism 共享同一份
    // 时间权重 —— 避免对同一个 session 事件按命中 organism 数量放大)。
    const w = decayWeight(s.scoredAt, decay.halfLifeDays)
    for (const id of hits) {
      const a = ensure(id)
      if (s.score >= winT) a.wins++
      else if (s.score <= lossT) a.losses++
      else a.neutrals++
      a.weightedSum += s.score * w
      a.weightSum += w
      if (Number.isFinite(ts) && ts > a.lastTs) {
        a.lastTs = ts
        a.lastAt = s.scoredAt
        a.lastSig = s.signature
      }
    }
  }

  for (const [id, a] of acc) {
    const trials = a.wins + a.losses + a.neutrals
    if (trials === 0) continue
    out.set(id, {
      organismId: id,
      trials,
      wins: a.wins,
      losses: a.losses,
      neutrals: a.neutrals,
      avg: a.weightSum > 0 ? a.weightedSum / a.weightSum : 0,
      lastAt: a.lastAt,
      lastScoreSignature: a.lastSig,
    })
  }

  return out
}

/**
 * 小工具:纯计算,给 FitnessScore 分桶。
 * 暴露给 autoPromotionEngine / /evolve-status 等复用分桶语义。
 *
 * Phase 24:阈值来自 tuned-thresholds.json,未调整时等于 0.3 / -0.3。
 */
export function bucketScore(score: number): 'win' | 'loss' | 'neutral' {
  const tuned = loadTunedThresholds()
  if (score >= tuned.organismWinThreshold) return 'win'
  if (score <= tuned.organismLossThreshold) return 'loss'
  return 'neutral'
}

/** 便捷:一批 FitnessScore 的平均 score(trials=0 返回 0)。 */
export function avgScore(scores: FitnessScore[]): number {
  if (scores.length === 0) return 0
  let s = 0
  for (const x of scores) s += x.score
  return s / scores.length
}
