/**
 * G6 Step 1 (2026-04-26) —— skill candidate miner (纯只读观察层)。
 *
 * 动机:
 *   docs §G6 指"procedural memory → skill 抽象化闭环断"——现在有 procedural candidates
 *   目录,但没人工/自动 review 入口告诉"哪些候选已经达到 skill-worthy 门槛"。
 *   Step 1 只做观察:基于已有 `listRecentProceduralCandidates()` 的结果,
 *   按更严格阈值过滤,并给出统一排序分数 score,不新建候选、不改已有数据。
 *
 * 默认阈值(比 procedural 内部 mine 阈值更严):
 *   minSupport=6       (sequence 内部 support 阈 3,skill 级再提一倍)
 *   minSuccessRate=0.9 (内部 0.8,skill 要求更稳)
 *   minConfidence=0.6  (内部 clamp 范围;0.6 约等于 60%)
 *
 * score 公式(单调于所有三个维度,用 log(support+1) 防止 support 过大 dominate):
 *   score = successRate * Math.log(support + 1) * confidence
 *
 * 非目标:
 *   - 不自动 promote 到 stable;
 *   - 不写 skill 目录;
 *   - 不改 procedural mine/promote 阈值;
 *   - 留给 Step 2:基于 tool-bandit reward ledger 交叉验证候选 "被重用后 reward 上升"。
 */

import {
  listRecentProceduralCandidates,
  type ProceduralCandidateInfo,
} from './index.js'

export interface SkillWorthyCandidate extends ProceduralCandidateInfo {
  /** 计算分数:successRate * log(support+1) * confidence */
  score: number
}

export interface FindSkillWorthyOptions {
  /** minimum support count; default 6 */
  minSupport?: number
  /** minimum successRate (0..1); default 0.9 */
  minSuccessRate?: number
  /** minimum confidence (0..1); default 0.6 */
  minConfidence?: number
  /** max 输出条数; default 20;超过会被切片 */
  limit?: number
}

const DEFAULT_LIMIT = 20

/**
 * 从 procedural candidates 目录中挑出 "skill-worthy" 候选。
 * - 纯 best-effort,永不抛;异常时返回空数组。
 * - 排序:score 降序;score 相同按 support 降序稳定次序。
 */
export function findSkillWorthyCandidates(
  opts: FindSkillWorthyOptions = {},
): SkillWorthyCandidate[] {
  try {
    const minSupport = Math.max(1, Math.floor(opts.minSupport ?? 6))
    const minRate = clamp01(opts.minSuccessRate ?? 0.9)
    const minConf = clamp01(opts.minConfidence ?? 0.6)
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT))

    // 上游 listRecentProceduralCandidates 默认只拉 10 条,这里传入 500 扩大候选池
    const pool = listRecentProceduralCandidates(500)
    const rows: SkillWorthyCandidate[] = []
    for (const c of pool) {
      if (c.support < minSupport) continue
      if (c.successRate < minRate) continue
      if (c.confidence < minConf) continue
      const score =
        c.successRate * Math.log(c.support + 1) * c.confidence
      rows.push({ ...c, score: roundScore(score) })
    }
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.support - a.support
    })
    return rows.slice(0, limit)
  } catch {
    return []
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 保留 4 位小数,避免 display 浮点噪声 */
function roundScore(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10000) / 10000
}
