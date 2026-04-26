import type { QuerySource } from '../../constants/querySource.js'
import type { APIProvider } from '../../utils/model/providers.js'
import type { IntentClass, TaskMode } from '../skillSearch/intentRouter.js'

export type ExecutionMode =
  | 'direct_answer'
  | 'direct_execute'
  | 'inspect_then_execute'
  | 'plan_then_execute'
  | 'delegate_agents'
  | 'clarify_first'

export type ExecutionComplexity = 'trivial' | 'simple' | 'moderate' | 'hard'

export type ExecutionRisk = 'low' | 'medium' | 'high'

export type ExecutionRouteIntent =
  | 'latency'
  | 'balanced'
  | 'quality'
  | 'reliability'

export interface ExecutionModeContext {
  requestText: string
  querySource: QuerySource
  provider: APIProvider
  hasActivePlanMode?: boolean
  hasExitedPlanModeInSession?: boolean
  hasToolResultsInRecentMessages?: boolean
  /**
   * Phase 2 Shot 5:kernel 推入的开假说 tag 列表(约定 `${tool}:${errorClass}`)。
   * 当前仅用于 shouldSuppressEscalationWithKernel —— 若 query 命中任一 tag,
   * 取消 simple_task 抑制。空数组 / undefined 时行为与旧版完全一致。
   */
  openHypothesisTags?: ReadonlyArray<string>
}

export interface ExecutionModeDecision {
  mode: ExecutionMode
  intentClass: IntentClass
  taskMode: TaskMode
  complexity: ExecutionComplexity
  risk: ExecutionRisk
  confidence: number
  suppressSkillRecall: boolean
  suppressPlanMode: boolean
  suppressAttachments: boolean
  suppressTaskState: boolean
  suppressAgentDelegation: boolean
  routeIntent: ExecutionRouteIntent
  preferredExecutionStyle: 'minimal' | 'normal' | 'deliberate'
  /**
   * 统一执行模式层给出的 effort / reasoning 档位建议。
   * 当前主要用于 codex 场景复用已有 effort 透传链路。
   */
  preferredEffortLevel?: 'low' | 'medium' | 'high' | 'max'
  evidence: string[]
}
