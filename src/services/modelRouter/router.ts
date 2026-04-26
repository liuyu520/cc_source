/**
 * ModelRouter — 核心决策器（单例）
 *
 * decide() 流程：
 *   1. 读取 providerMatrix
 *   2. 做 route intent 分类（intent-first-routing）
 *   3. 按显式 staircase 依次挑选候选集合
 *   4. 对候选做动态打分（能力 / 健康 / 复杂度 / 成本）
 *   5. 记录 route_decision / fallback-chosen / route_outcome 证据
 *
 * shadow 模式只记录决策，不改变主路径；enforce 模式才会真实改路由。
 */

import { getTotalCostUSD } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { appendEvidence } from '../harness/index.js'
import {
  classifyIntent,
  shouldSuppressEscalationForIntent,
} from '../skillSearch/intentRouter.js'
import {
  isModelRouterEnabled,
  isModelRouterEnforceMode,
  isModelRouterFallbackEnabled,
} from './featureCheck.js'
import { costTracker } from './costTracker.js'
import { healthTracker } from './healthTracker.js'
import { getProviderMatrix } from './providerMatrix.js'
import type {
  ProviderConfig,
  ProviderHealth,
  ProviderTier,
  RouteContext,
  RouteDecision,
  RouteIntentResult,
  TaskComplexity,
} from './types.js'

const ROUTE_FALLBACK_STAIRCASE = [
  'intent-scored-healthy-capability',
  'intent-scored-capability',
  'intent-scored-healthy-any',
  'priority-only',
] as const

type RouteFallbackStep = (typeof ROUTE_FALLBACK_STAIRCASE)[number]

type ScoredCandidate = {
  provider: ProviderConfig
  score: number
}

class ModelRouterImpl {
  /**
   * 做一次路由决策。
   * 注意：即便本函数被调用，只要 enforce 模式未开，decision.shadow = true
   * 且调用方应该忽略返回的 provider，继续走原路径。
   */
  decide(context: RouteContext = {}): RouteDecision | null {
    if (!isModelRouterEnabled()) return null

    const matrix = getProviderMatrix()
    if (matrix.length === 0) return null

    const normalizedContext = normalizeContext(context)
    const intent = classifyRouteIntent(normalizedContext)
    const required = normalizedContext.requiredCapabilities ?? []

    const capabilityCandidates = matrix.filter((provider) =>
      required.every((capability) => provider.capabilities.includes(capability)),
    )

    const allowByProvider = new Map<string, boolean>()
    for (const provider of matrix) {
      allowByProvider.set(provider.name, healthTracker.getBreaker(provider.name).allow())
    }

    const healthyCapability = capabilityCandidates.filter(
      (provider) => allowByProvider.get(provider.name) === true,
    )
    const healthyAny = matrix.filter(
      (provider) => allowByProvider.get(provider.name) === true,
    )

    const staircase: Array<{
      name: RouteFallbackStep
      candidates: ScoredCandidate[]
    }> = [
      {
        name: 'intent-scored-healthy-capability',
        candidates: scoreCandidates(healthyCapability, normalizedContext, intent),
      },
      {
        name: 'intent-scored-capability',
        candidates: scoreCandidates(capabilityCandidates, normalizedContext, intent),
      },
      {
        name: 'intent-scored-healthy-any',
        candidates: scoreCandidates(healthyAny, normalizedContext, intent),
      },
      {
        name: 'priority-only',
        candidates: sortByPriority(matrix).map((provider) => ({
          provider,
          score: 100 - provider.priority * 10,
        })),
      },
    ]

    const selected =
      staircase.find((stage) => stage.candidates.length > 0) ?? null
    if (!selected) return null

    const fallbackRank = staircase.findIndex(
      (stage) => stage.name === selected.name,
    )
    const chosen = selected.candidates[0]!.provider
    const fallbackChain = selected.candidates
      .slice(1)
      .map((candidate) => candidate.provider.name)

    const decision: RouteDecision = {
      provider: chosen,
      reason: buildReason(
        chosen,
        normalizedContext,
        selected.name,
        selected.candidates,
        intent,
      ),
      fallbackChain,
      fallbackRank,
      intent,
      candidateScores: selected.candidates.map((candidate) => ({
        provider: candidate.provider.name,
        score: Math.round(candidate.score * 100) / 100,
      })),
      shadow: !isModelRouterEnforceMode(),
    }

    appendEvidence('router', 'route_decision', {
      provider: chosen.name,
      model: chosen.model,
      shadow: decision.shadow,
      fallbackChain,
      fallbackRank,
      fallbackStep: selected.name,
      fallbackEnabled: isModelRouterFallbackEnabled(),
      intent: intent.class,
      intentConfidence: intent.confidence,
      intentEvidence: intent.evidence,
      candidateScores: decision.candidateScores,
      context: serializeContext(normalizedContext),
      reason: decision.reason,
    })

    if (fallbackRank > 0 || fallbackChain.length > 0) {
      appendEvidence('router', 'fallback-chosen', {
        provider: chosen.name,
        fallbackRank,
        fallbackStep: selected.name,
        fallbackChain,
        intent: intent.class,
      })
    }

    logForDebugging(
      `[ModelRouter] decision provider=${chosen.name} tier=${inferProviderTier(chosen)} intent=${intent.class} shadow=${decision.shadow} staircase=${selected.name} fallbackRank=${fallbackRank} fallback=[${fallbackChain.join(',')}]`,
    )

    return decision
  }

  /** 调用结束后回调，用于健康 + 成本追踪 */
  recordOutcome(
    decision: RouteDecision,
    outcome: {
      success: boolean
      latencyMs: number
      tokensUsed?: number
      error?: unknown
    },
  ): void {
    if (outcome.success) {
      healthTracker.recordSuccess(decision.provider.name, outcome.latencyMs)
      if (outcome.tokensUsed && outcome.tokensUsed > 0) {
        costTracker.recordUsage(decision.provider.name, outcome.tokensUsed)
      }
    } else {
      healthTracker.recordFailure(decision.provider.name, outcome.error)
    }

    appendEvidence('router', 'route_outcome', {
      provider: decision.provider.name,
      model: decision.provider.model,
      success: outcome.success,
      latencyMs: outcome.latencyMs,
      tokensUsed: outcome.tokensUsed ?? 0,
      error:
        outcome.error instanceof Error
          ? outcome.error.message
          : outcome.error
            ? String(outcome.error)
            : undefined,
      fallbackRank: decision.fallbackRank,
      fallbackChain: decision.fallbackChain,
      fallbackEnabled: isModelRouterFallbackEnabled(),
      intent: decision.intent.class,
      candidateScores: decision.candidateScores,
      shadow: decision.shadow,
    })
  }

  /** 获取所有 provider 的健康快照 */
  getHealthSnapshot(): ProviderHealth[] {
    return healthTracker.getAllHealth()
  }
}

function normalizeContext(context: RouteContext): RouteContext {
  return {
    ...context,
    sessionCostUsd: context.sessionCostUsd ?? getTotalCostUSD(),
  }
}

function classifyRouteIntent(context: RouteContext): RouteIntentResult {
  if (context.executionModeDecision) {
    return {
      class: context.executionModeDecision.routeIntent,
      confidence: context.executionModeDecision.confidence,
      evidence: [
        ...context.executionModeDecision.evidence,
        `execution_mode:${context.executionModeDecision.mode}`,
      ],
    }
  }

  if (context.intentHint) {
    return {
      class: context.intentHint,
      confidence: 1,
      evidence: [`intent_hint:${context.intentHint}`],
    }
  }

  const evidence: string[] = []
  const requestText = context.requestText?.trim()
  if (requestText) {
    const skillIntent = classifyIntent(requestText)
    evidence.push(`skill:${skillIntent.class}`)
    evidence.push(`mode:${skillIntent.taskMode}`)

    if (skillIntent.class === 'command') {
      return { class: 'latency', confidence: 0.9, evidence }
    }
    if (shouldSuppressEscalationForIntent(skillIntent)) {
      evidence.push('escalation:suppressed')
      return {
        class: skillIntent.class === 'simple_task' ? 'balanced' : 'latency',
        confidence: 0.88,
        evidence,
      }
    }
    if (
      skillIntent.taskMode === 'review' ||
      skillIntent.taskMode === 'debug' ||
      skillIntent.taskMode === 'refactor'
    ) {
      return { class: 'quality', confidence: 0.82, evidence }
    }
    if (skillIntent.taskMode === 'test') {
      return { class: 'reliability', confidence: 0.72, evidence }
    }
    return { class: 'balanced', confidence: 0.6, evidence }
  }

  const taskType = (context.taskType ?? '').toLowerCase()
  if (taskType) {
    evidence.push(`task:${taskType}`)
    if (
      /summary|suggest|prompt_suggestion|tool_use_summary|status/.test(
        taskType,
      )
    ) {
      return { class: 'latency', confidence: 0.78, evidence }
    }
    if (/review|debug|refactor|agent|planner|rca/.test(taskType)) {
      return { class: 'quality', confidence: 0.75, evidence }
    }
    if (/retry|recover|fallback|health|test/.test(taskType)) {
      return { class: 'reliability', confidence: 0.74, evidence }
    }
  }

  if (context.requiredCapabilities?.includes('extended_thinking')) {
    evidence.push('cap:extended_thinking')
    return { class: 'quality', confidence: 0.7, evidence }
  }

  if (
    context.remainingBudgetUsd !== undefined &&
    context.remainingBudgetUsd < 0.2
  ) {
    evidence.push('budget:low')
    return { class: 'latency', confidence: 0.8, evidence }
  }

  evidence.push('default:balanced')
  return { class: 'balanced', confidence: 0.45, evidence }
}

function scoreCandidates(
  candidates: ProviderConfig[],
  context: RouteContext,
  intent: RouteIntentResult,
): ScoredCandidate[] {
  return candidates
    .map((provider) => ({
      provider,
      score: scoreCandidate(provider, context, intent),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.provider.priority - b.provider.priority
    })
}

function scoreCandidate(
  provider: ProviderConfig,
  context: RouteContext,
  intent: RouteIntentResult,
): number {
  const tier = inferProviderTier(provider)
  const health = healthTracker.getHealth(provider.name)
  const usage = costTracker.getDailyUsage(provider.name)

  let score = 100 - provider.priority * 10

  if (context.preferredModel && provider.model === context.preferredModel) {
    score += 25
  } else if (
    context.preferredModel &&
    provider.model.includes(context.preferredModel)
  ) {
    score += 10
  }

  if (
    context.requiredCapabilities &&
    context.requiredCapabilities.every((capability) =>
      provider.capabilities.includes(capability),
    )
  ) {
    score += 15
  }

  switch (intent.class) {
    case 'latency':
      if (tier === 'haiku') score += 35
      if (tier === 'sonnet') score += 10
      if (tier === 'opus') score -= 20
      break
    case 'balanced':
      if (tier === 'haiku') score += 5
      if (tier === 'sonnet') score += 15
      if (tier === 'opus') score += 8
      break
    case 'quality':
      if (tier === 'haiku') score -= 35
      if (tier === 'sonnet') score += 20
      if (tier === 'opus') score += 35
      break
    case 'reliability':
      if (tier === 'haiku') score += 10
      if (tier === 'sonnet') score += 18
      if (tier === 'opus') score += 12
      break
  }

  applyComplexityScore(context.taskComplexity, tier, (delta) => {
    score += delta
  })

  if (context.estimatedToolCallCount !== undefined) {
    if (context.estimatedToolCallCount <= 2 && tier === 'haiku') score += 8
    if (context.estimatedToolCallCount >= 8 && tier === 'opus') score += 12
    if (context.estimatedToolCallCount >= 8 && tier === 'haiku') score -= 20
  }

  switch (context.rcaPhase) {
    case 'hypothesis_gen':
      if (tier === 'sonnet') score += 20
      if (tier === 'opus') score += 10
      break
    case 'evidence_gather':
      if (tier === 'haiku') score += 15
      if (tier === 'sonnet') score += 10
      break
    case 'converging':
      if (tier === 'opus') score += 25
      if (tier === 'sonnet') score += 15
      break
  }

  if (
    context.rcaConvergenceScore !== undefined &&
    context.rcaConvergenceScore >= 0.8 &&
    tier === 'opus'
  ) {
    score += 10
  }

  if (context.sessionCostUsd !== undefined) {
    if (context.sessionCostUsd >= 1 && tier === 'opus') score -= 10
    if (context.sessionCostUsd >= 3 && tier === 'opus') score -= 15
  }

  if (context.remainingBudgetUsd !== undefined) {
    if (context.remainingBudgetUsd < 0.2) {
      if (tier === 'opus') score -= 60
      if (tier === 'sonnet') score -= 20
      if (tier === 'haiku') score += 20
    } else if (context.remainingBudgetUsd < 1 && tier === 'opus') {
      score -= 15
    }
  }

  if (provider.pricePerMToken !== undefined && provider.pricePerMToken > 0) {
    if (
      context.remainingBudgetUsd !== undefined &&
      context.remainingBudgetUsd < 1
    ) {
      score -= Math.min(20, provider.pricePerMToken)
    }
  }

  if (health.state === 'degraded') score -= 20
  if (health.state === 'down') score -= 100
  if (health.p99LatencyMs > 5_000) score -= 10
  if (health.errorRate > 0.3) score -= 10

  if (intent.class === 'reliability' && health.state === 'healthy') {
    score += 15
  }

  if (usage.calls > 20) {
    score -= Math.min(10, usage.calls / 3)
  }

  return score
}

function applyComplexityScore(
  complexity: TaskComplexity | undefined,
  tier: ProviderTier,
  add: (delta: number) => void,
): void {
  switch (complexity) {
    case 'trivial':
      if (tier === 'haiku') add(25)
      if (tier === 'opus') add(-10)
      break
    case 'simple':
      if (tier === 'haiku') add(10)
      if (tier === 'sonnet') add(8)
      break
    case 'moderate':
      if (tier === 'sonnet') add(12)
      if (tier === 'opus') add(6)
      break
    case 'hard':
      if (tier === 'haiku') add(-40)
      if (tier === 'sonnet') add(18)
      if (tier === 'opus') add(25)
      break
  }
}

function inferProviderTier(provider: ProviderConfig): ProviderTier {
  if (provider.tier) return provider.tier
  const source = `${provider.name} ${provider.model}`.toLowerCase()
  if (source.includes('haiku')) return 'haiku'
  if (source.includes('opus')) return 'opus'
  if (source.includes('sonnet')) return 'sonnet'
  return 'unknown'
}

function sortByPriority(candidates: ProviderConfig[]): ProviderConfig[] {
  return [...candidates].sort((a, b) => a.priority - b.priority)
}

function buildReason(
  chosen: ProviderConfig,
  context: RouteContext,
  fallbackStep: RouteFallbackStep,
  candidates: ScoredCandidate[],
  intent: RouteIntentResult,
): string {
  const caps = context.requiredCapabilities?.join(',') || 'none'
  const complexity = context.taskComplexity ?? 'unknown'
  const candidateCount = candidates.length
  return (
    `picked ${chosen.name} (${inferProviderTier(chosen)}) via ${fallbackStep}; ` +
    `intent=${intent.class} conf=${intent.confidence.toFixed(2)} ` +
    `candidates=${candidateCount} requiredCaps=[${caps}] complexity=${complexity}`
  )
}

function serializeContext(
  context: RouteContext,
): Record<string, unknown> {
  return {
    taskType: context.taskType,
    requestText: context.requestText?.slice(0, 200),
    requiredCapabilities: context.requiredCapabilities,
    preferredModel: context.preferredModel,
    intentHint: context.intentHint,
    taskComplexity: context.taskComplexity,
    estimatedToolCallCount: context.estimatedToolCallCount,
    rcaPhase: context.rcaPhase,
    rcaConvergenceScore: context.rcaConvergenceScore,
    sessionCostUsd: context.sessionCostUsd,
    remainingBudgetUsd: context.remainingBudgetUsd,
  }
}

export const modelRouter = new ModelRouterImpl()
