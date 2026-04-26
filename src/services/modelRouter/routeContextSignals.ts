/**
 * ModelRouter · 运行时信号收集器
 *
 * 背景:RouteContext 类型早已预埋 rcaPhase / rcaConvergenceScore /
 * remainingBudgetUsd 三个字段,scoreCandidate 里也有对应打分分支,
 * 但实际调用 decide() 的 caller (client.ts / model.ts) 从未填入,
 * 导致 shadow 决策中这些分支长期空转。
 *
 * 本 helper 从 RCA + BudgetGovernor 两个既有子系统派生这三个信号,
 * 让 shadow evidence 的 candidateScores 真正反映运行时上下文。
 *
 * 设计约束:
 *   - **纯只读**:不改变任何子系统状态,只消费它们的观察点
 *   - **fail-open**:每个派生源独立 try/catch,单点失败不影响其他
 *   - **不覆盖 caller 已填值**:返回 Partial,caller 负责 spread 合并
 *   - **不写 evidence**:router 本身会写,避免双重记录
 */

import { DEFAULT_BUDGET_CONFIG } from '../budgetGovernor/governor.js'
import type { RouteContext, RouteRcaPhase, TaskComplexity } from './types.js'

/**
 * 从 request 文本派生 taskComplexity。
 * Q0(2026-04-25):jobs/classifier.ts 已填实 classifyTaskComplexity 纯函数,
 * 这里 require 之(绕过 feature('TEMPLATES') gate,因为纯函数不依赖 gate)。
 */
function deriveComplexitySignal(
  requestText: string | undefined,
): Partial<Pick<RouteContext, 'taskComplexity'>> {
  try {
    if (!requestText) return {}
    /* eslint-disable @typescript-eslint/no-require-imports */
    const classifier = require('../../jobs/classifier.js') as typeof import('../../jobs/classifier.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (typeof classifier.classifyTaskComplexity !== 'function') return {}
    const complexity: TaskComplexity = classifier.classifyTaskComplexity(requestText)
    return { taskComplexity: complexity }
  } catch {
    return {}
  }
}

/**
 * 从 RCA session 派生 rcaPhase + rcaConvergenceScore。
 * 未启用或无 session 时返回 {}。
 */
function deriveRcaSignals(): Partial<Pick<RouteContext, 'rcaPhase' | 'rcaConvergenceScore'>> {
  try {
    // 动态 require 避免循环依赖;require 比 dynamic import 同步,适合 decide() 同步上下文
    /* eslint-disable @typescript-eslint/no-require-imports */
    const rca = require('../rca/index.js') as typeof import('../rca/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (!rca.isRCAEnabled()) return {}
    const session = rca.getSession()
    if (!session) return { rcaPhase: 'idle' }

    const score = session.convergenceScore
    const rcaConvergenceScore = Number.isFinite(score) ? score : 0

    // status !== 'investigating' 时视为 idle(已收敛/已放弃)
    if (session.status !== 'investigating') {
      return { rcaPhase: 'idle', rcaConvergenceScore }
    }

    // 按 convergenceScore 映射三段
    let rcaPhase: RouteRcaPhase
    if (rcaConvergenceScore >= 0.7) {
      rcaPhase = 'converging'
    } else if (rcaConvergenceScore >= 0.3) {
      rcaPhase = 'evidence_gather'
    } else {
      rcaPhase = 'hypothesis_gen'
    }
    return { rcaPhase, rcaConvergenceScore }
  } catch {
    return {}
  }
}

/**
 * 从 BudgetGovernor 环境变量 + 当前 sessionCostUsd 派生 remainingBudgetUsd。
 * 不依赖 BudgetGovernor 是否启用 —— 预算配置本身是静态值。
 */
function deriveBudgetSignals(
  sessionCostUsd: number | undefined,
): Partial<Pick<RouteContext, 'remainingBudgetUsd'>> {
  try {
    if (sessionCostUsd === undefined || !Number.isFinite(sessionCostUsd)) return {}

    const rawBudget = process.env.CLAUDE_BUDGET_GOVERNOR_PER_SESSION_USD
    const parsed = rawBudget ? Number(rawBudget) : NaN
    const perSessionUsd =
      Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_BUDGET_CONFIG.perSessionUsd

    const remaining = perSessionUsd - sessionCostUsd
    // 预算可能已超支,允许负数(scoreCandidate 按 <0.2 阈值命中最严重档)
    return { remainingBudgetUsd: Math.round(remaining * 10000) / 10000 }
  } catch {
    return {}
  }
}

/**
 * 主入口:把 caller 的基础 ctx 与派生信号合并。
 *
 * 合并规则:caller 已显式填入的字段永远胜出(Partial.X !== undefined),
 * 仅在缺失时才使用派生值。这样 /evolve 或手动 override 始终有效。
 */
export function enrichRouteContext(base: RouteContext): RouteContext {
  const rcaSignals = deriveRcaSignals()
  const budgetSignals = deriveBudgetSignals(base.sessionCostUsd)
  const complexitySignals = deriveComplexitySignal(base.requestText)

  return {
    ...base,
    taskComplexity: base.taskComplexity ?? complexitySignals.taskComplexity,
    rcaPhase: base.rcaPhase ?? rcaSignals.rcaPhase,
    rcaConvergenceScore:
      base.rcaConvergenceScore ?? rcaSignals.rcaConvergenceScore,
    remainingBudgetUsd:
      base.remainingBudgetUsd ?? budgetSignals.remainingBudgetUsd,
  }
}
