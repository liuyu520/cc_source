/**
 * RCA Orchestrator — 单例状态机
 *
 * 与 CompactOrchestrator 完全同构的 decideAndLog 范式：
 *   - null → 未启用，调用方忽略
 *   - { active, shadow } → shadow=true 只记日志
 *   - { active, shadow, suggestion } → 正式模式带建议
 *
 * 模块级状态：currentSession 保存当前 RCA 会话。
 */

import { logForDebugging } from '../../utils/debug.js'
import { appendEvidence } from './evidenceStore.js'
import { isRCAEnabled, isRCAShadowMode } from './featureCheck.js'
import {
  checkConvergence,
  updatePosteriors,
  type ConvergenceResult,
} from './hypothesisBoard.js'
import type { Evidence, Hypothesis, RCASession } from './types.js'

// ---- 模块级状态 ----

let currentSession: RCASession | null = null

// ---- 对外接口 ----

/**
 * 启动一个新的 RCA 会话
 * 由 /rca start 命令或自动检测触发
 */
export function startRCA(problemStatement: string, turnIdx: number): RCASession {
  const sessionId = `rca_${Date.now()}`
  currentSession = {
    sessionId,
    problemStatement,
    hypotheses: [],
    evidences: [],
    convergenceScore: 0,
    status: 'investigating',
    startTurn: turnIdx,
    turnCounter: turnIdx,
    hypothesisCounter: 0,
    evidenceCounter: 0,
  }
  logForDebugging(
    `[RCA] Session started: ${sessionId}, problem="${problemStatement.slice(0, 80)}"`,
  )
  return currentSession
}

/**
 * 向当前 session 添加假设（通常在 startRCA 之后由 hypothesisBoard 生成）
 */
export function addHypotheses(
  rawHypotheses: Pick<Hypothesis, 'claim' | 'prior'>[],
): void {
  if (!currentSession) return
  for (const raw of rawHypotheses) {
    currentSession.hypothesisCounter++
    const id = `h_${String(currentSession.hypothesisCounter).padStart(3, '0')}`
    currentSession.hypotheses.push({
      id,
      claim: raw.claim,
      prior: raw.prior,
      posterior: raw.prior, // 初始后验 = 先验
      evidenceRefs: [],
      status: 'active',
      createdAtTurn: currentSession.turnCounter,
    })
  }
  logForDebugging(
    `[RCA] Added ${rawHypotheses.length} hypotheses, total=${currentSession.hypotheses.length}`,
  )
}

/**
 * 观测到新证据 → 更新后验 + 检查收敛 + 持久化
 */
export function onObservation(evidence: Evidence): {
  updated: boolean
  convergence: ConvergenceResult
} {
  if (!currentSession || currentSession.status !== 'investigating') {
    return {
      updated: false,
      convergence: { converged: false, topHypothesis: null, convergenceScore: 0 },
    }
  }

  // 分配 ID 并记录
  currentSession.evidenceCounter++
  evidence.id = `e_${String(currentSession.evidenceCounter).padStart(3, '0')}`
  evidence.sessionId = currentSession.sessionId
  currentSession.evidences.push(evidence)

  // 持久化到 NDJSON（fire-and-forget）
  appendEvidence(evidence)

  // 贝叶斯更新
  updatePosteriors(currentSession, evidence)

  // 收敛检查
  const convergence = checkConvergence(currentSession)
  if (convergence.converged) {
    currentSession.status = 'converged'
    logForDebugging(
      `[RCA] Converged! top="${convergence.topHypothesis?.claim?.slice(0, 60)}" score=${convergence.convergenceScore.toFixed(3)}`,
    )
  }

  return { updated: true, convergence }
}

/**
 * decideAndLog — 与 CompactOrchestrator 同构的三段式样板
 * 返回 null 表示 RCA 未启用，调用方忽略
 */
export function decideAndLog(
  site: string,
): { active: boolean; shadow: boolean; suggestion?: string } | null {
  try {
    if (!isRCAEnabled()) return null
    const shadow = isRCAShadowMode()
    const active = currentSession !== null && currentSession.status === 'investigating'

    logForDebugging(
      `[RCA:${site}] active=${active} shadow=${shadow} session=${currentSession?.sessionId ?? 'none'} convergence=${currentSession?.convergenceScore?.toFixed(3) ?? 'N/A'}`,
    )

    return { active, shadow }
  } catch (e) {
    logForDebugging(
      `[RCA:${site}] decideAndLog failed: ${(e as Error).message}`,
    )
    return null
  }
}

/**
 * 获取当前 RCA session（供 /rca 命令使用）
 */
export function getSession(): RCASession | null {
  return currentSession
}

/**
 * 结束当前 RCA session
 */
export function endRCA(): void {
  if (currentSession) {
    currentSession.status = currentSession.convergenceScore > 0.5 ? 'converged' : 'abandoned'
    logForDebugging(
      `[RCA] Session ended: ${currentSession.sessionId} status=${currentSession.status}`,
    )
    // 同步写入 EvidenceLedger 'rca' domain,kind='session_end'
    // 作为 shadow-promote readiness 的采样源;fail-open,不阻塞。
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { EvidenceLedger } = require('../harness/evidenceLedger.js') as typeof import('../harness/evidenceLedger.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      EvidenceLedger.appendEvent('rca', 'session_end', {
        sessionId: currentSession.sessionId,
        status: currentSession.status,
        convergenceScore: currentSession.convergenceScore,
        hypothesesCount: currentSession.hypotheses.length,
        evidencesCount: currentSession.evidences.length,
        shadow: isRCAShadowMode(),
      })
    } catch { /* best-effort */ }
    currentSession = null
  }
}
