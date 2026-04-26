/**
 * Dream Triage —— evidence → 分档决策
 *
 * 评分公式（Phase B1 升级后）：
 *   score = Σ(
 *     novelty * w.novelty +
 *     conflicts * w.conflict +
 *     userCorrections * w.correction +
 *     surprise * w.surprise +
 *     toolErrorRate * w.error +
 *     graphImportance * w.graph +            ← 新增：知识图谱重要性
 *     conceptualNovelty * w.concept          ← 新增：idf-based 概念新颖度
 *   )
 *
 * 分档：
 *   score < 5            → skip
 *   5 ≤ score < 15       → micro  （只 replay top-3 focus sessions）
 *   score ≥ 15           → full   （走现有 autoDream 路径）
 *
 * Phase A 关键升级：权重来自 feedbackLoop.loadWeights()（闭合反馈回路）。
 * 权重文件不存在或老格式时自动回退到 DEFAULT_WEIGHTS。
 */

import type { DreamEvidence, TriageDecision, TriageTier } from './types.js'
import {
  DEFAULT_WEIGHTS,
  loadWeights,
  type TriageWeights,
} from './feedbackLoop.js'

const MICRO_THRESHOLD = 5
const FULL_THRESHOLD = 15
const FOCUS_TOP_K = 3

function scoreEvidence(ev: DreamEvidence, w: TriageWeights): number {
  return (
    ev.novelty * w.novelty +
    ev.conflicts * w.conflict +
    ev.userCorrections * w.correction +
    ev.surprise * w.surprise +
    ev.toolErrorRate * w.error +
    // Phase B1：可选字段，缺失时当作 0，保持与老 evidence 向后兼容。
    (ev.graphImportance ?? 0) * w.graph +
    (ev.conceptualNovelty ?? 0) * w.concept
  )
}

/**
 * 计算 triage 决策。
 *
 * @param evidences 最近窗口内的 evidence 列表
 * @param weights  可选：调用方已加载好的权重（避免重复 IO）。
 *                  缺省时自动 loadWeights() ← Phase A 核心升级。
 *
 * 保持异步签名以便未来注入其它 IO（如基于 EvidenceLedger 的 novelty baseline）。
 */
export async function triage(
  evidences: DreamEvidence[],
  weights?: TriageWeights,
): Promise<TriageDecision> {
  const w = weights ?? (await loadWeights().catch(() => ({ ...DEFAULT_WEIGHTS })))

  const breakdown = {
    novelty: 0,
    conflict: 0,
    correction: 0,
    surprise: 0,
    error: 0,
    graph: 0,
    concept: 0,
  }
  let total = 0
  const scored: Array<{ ev: DreamEvidence; s: number }> = []

  for (const ev of evidences) {
    const s = scoreEvidence(ev, w)
    total += s
    breakdown.novelty += ev.novelty * w.novelty
    breakdown.conflict += ev.conflicts * w.conflict
    breakdown.correction += ev.userCorrections * w.correction
    breakdown.surprise += ev.surprise * w.surprise
    breakdown.error += ev.toolErrorRate * w.error
    breakdown.graph += (ev.graphImportance ?? 0) * w.graph
    breakdown.concept += (ev.conceptualNovelty ?? 0) * w.concept
    scored.push({ ev, s })
  }

  let tier: TriageTier = 'skip'
  if (total >= FULL_THRESHOLD) tier = 'full'
  else if (total >= MICRO_THRESHOLD) tier = 'micro'

  const focusSessions = scored
    .sort((a, b) => b.s - a.s)
    .slice(0, FOCUS_TOP_K)
    .map(x => x.ev.sessionId)

  const round = (n: number) => Math.round(n * 100) / 100

  return {
    tier,
    score: round(total),
    evidenceCount: evidences.length,
    breakdown: {
      novelty: round(breakdown.novelty),
      conflict: round(breakdown.conflict),
      correction: round(breakdown.correction),
      surprise: round(breakdown.surprise),
      error: round(breakdown.error),
      graph: round(breakdown.graph),
      concept: round(breakdown.concept),
    },
    focusSessions,
    // 权重快照：让 /memory-map 能直接看到本次用的 learned weights。
    weightsUsed: {
      novelty: w.novelty,
      conflict: w.conflict,
      correction: w.correction,
      surprise: w.surprise,
      error: w.error,
      graph: w.graph,
      concept: w.concept,
    },
  }
}

/**
 * 同步简化版 triage：供老调用方（dispatchDream 同步路径）/ 快照打印使用。
 * 使用 DEFAULT_WEIGHTS，不涉及 IO。新代码请优先用 async triage。
 */
export function triageSync(evidences: DreamEvidence[]): TriageDecision {
  const w: TriageWeights = { ...DEFAULT_WEIGHTS }
  const breakdown = {
    novelty: 0,
    conflict: 0,
    correction: 0,
    surprise: 0,
    error: 0,
    graph: 0,
    concept: 0,
  }
  let total = 0
  const scored: Array<{ ev: DreamEvidence; s: number }> = []
  for (const ev of evidences) {
    const s = scoreEvidence(ev, w)
    total += s
    breakdown.novelty += ev.novelty * w.novelty
    breakdown.conflict += ev.conflicts * w.conflict
    breakdown.correction += ev.userCorrections * w.correction
    breakdown.surprise += ev.surprise * w.surprise
    breakdown.error += ev.toolErrorRate * w.error
    breakdown.graph += (ev.graphImportance ?? 0) * w.graph
    breakdown.concept += (ev.conceptualNovelty ?? 0) * w.concept
    scored.push({ ev, s })
  }
  let tier: TriageTier = 'skip'
  if (total >= FULL_THRESHOLD) tier = 'full'
  else if (total >= MICRO_THRESHOLD) tier = 'micro'
  const focusSessions = scored
    .sort((a, b) => b.s - a.s)
    .slice(0, FOCUS_TOP_K)
    .map(x => x.ev.sessionId)
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    tier,
    score: round(total),
    evidenceCount: evidences.length,
    breakdown: {
      novelty: round(breakdown.novelty),
      conflict: round(breakdown.conflict),
      correction: round(breakdown.correction),
      surprise: round(breakdown.surprise),
      error: round(breakdown.error),
      graph: round(breakdown.graph),
      concept: round(breakdown.concept),
    },
    focusSessions,
    weightsUsed: {
      novelty: w.novelty,
      conflict: w.conflict,
      correction: w.correction,
      surprise: w.surprise,
      error: w.error,
      graph: w.graph,
      concept: w.concept,
    },
  }
}
