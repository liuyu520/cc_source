import {
  classifyIntent,
  shouldSuppressEscalationWithKernel,
  type IntentResult,
} from '../skillSearch/intentRouter.js'
import { isConservativeExecutionProvider } from '../../utils/model/providers.js'
import type {
  ExecutionComplexity,
  ExecutionMode,
  ExecutionModeContext,
  ExecutionModeDecision,
  ExecutionRisk,
  ExecutionRouteIntent,
} from './types.js'

const INSPECT_HINT =
  /\b(review|inspect|check|read|explain|understand|analyze|analyse|look at|look into|show|find|trace|看看|看下|检查|解释|说明|分析|确认|定位|排查|查看|阅读)\b/iu
const EXECUTE_HINT =
  /\b(fix|update|modify|change|rename|add|remove|delete|move|implement|write|run|set|修复|修改|更新|重命名|添加|删除|移动|实现|编写|运行|设置)\b/iu
const MULTI_TARGET_HINT = /(\b(and|also|plus|then|meanwhile|同时|并且|顺便|另外|统一|整体|彻底)\b|，.*，|、)/iu
const HARD_COMPLEXITY_HINT =
  /\b(systematic|systemwide|architecture|architectural|pipeline|protocol|migration|migrate|rewrite|redesign|infra|infrastructure|auth|compliance|state management|routing layer|全链路|系统性|架构|重构|迁移|协议|基础设施|鉴权|认证|合规|状态管理|路由层)\b/iu
const HIGH_RISK_HINT =
  /\b(auth|authentication|authorization|migration|protocol|routing layer|state management|compliance|security|rewrite|redesign|replace existing|鉴权|认证|授权|迁移|协议|路由层|状态管理|合规|安全|重写|重构)\b/iu
const AGENT_RESEARCH_HINT =
  /\b(parallel|compare|comparison|investigate|research|survey|independent|multiple directions|多方向|并行|对比|调查|研究|搜集)\b/iu
const PLAN_HINT =
  /\b(plan|design|proposal|approach|systematic|root cause|root-level|先方案|先设计|系统性|根本上|全链路|整体方案)\b/iu
const EXTRA_REASONING_HINT =
  /(深入(?:分析|思考|研究|审视|阐述|挖掘)|深度(?:分析|思考|研究)?|详细分析|详细思考|详细研究|上帝视角|超强大脑)/u

export function decideExecutionMode(
  context: ExecutionModeContext,
): ExecutionModeDecision {
  const requestText = (context.requestText ?? '').trim()
  const intent = classifyIntent(requestText)
  const evidence = [...intent.evidence]

  const complexity = inferExecutionComplexity(requestText, intent, evidence)
  const risk = inferExecutionRisk(requestText, intent, complexity, evidence)
  let mode = pickExecutionMode(
    requestText,
    intent,
    complexity,
    risk,
    evidence,
    context.openHypothesisTags ?? [],
  )

  if (isConservativeExecutionProvider(context.provider)) {
    evidence.push(`provider:${context.provider}`)
    if (
      mode === 'delegate_agents' &&
      (complexity !== 'hard' || risk !== 'high')
    ) {
      mode = 'inspect_then_execute'
      evidence.push('conservative:agent_downgraded')
    }
    if (
      mode === 'plan_then_execute' &&
      complexity !== 'hard' &&
      risk !== 'high'
    ) {
      mode = intent.taskMode === 'review' || intent.taskMode === 'debug'
        ? 'inspect_then_execute'
        : 'direct_execute'
      evidence.push('conservative:plan_downgraded')
    }
  }

  const routeIntent = deriveRouteIntent(mode, intent, risk)
  const preferredExecutionStyle = deriveExecutionStyle(mode)
  const suppressions = deriveSuppressionFlags(mode, complexity)
  const preferredEffortLevel = derivePreferredEffortLevel(
    context.provider,
    requestText,
  )

  return {
    mode,
    intentClass: intent.class,
    taskMode: intent.taskMode,
    complexity,
    risk,
    confidence: intent.confidence,
    routeIntent,
    preferredExecutionStyle,
    preferredEffortLevel,
    evidence,
    ...suppressions,
  }
}

function derivePreferredEffortLevel(
  provider: ExecutionModeContext['provider'],
  requestText: string,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  // Codex 默认走 high；当用户显式要求“深入”时，再升级到内部最高档 max。
  // 后续继续复用已有 effort 透传链路，并由 provider translator 负责把 max 映射为 xhigh / Extra high。
  if (provider !== 'codex') {
    return undefined
  }

  if (EXTRA_REASONING_HINT.test(requestText)) {
    return 'max'
  }

  return 'high'
}

function inferExecutionComplexity(
  requestText: string,
  intent: IntentResult,
  evidence: string[],
): ExecutionComplexity {
  const trimmed = requestText.trim()
  const tokenCount = trimmed ? trimmed.split(/\s+/).length : 0

  if (HARD_COMPLEXITY_HINT.test(trimmed)) {
    evidence.push('complexity:hard_keyword')
    return 'hard'
  }

  if (MULTI_TARGET_HINT.test(trimmed) && tokenCount >= 10) {
    evidence.push('complexity:multi_target')
    return 'moderate'
  }

  if (
    intent.taskMode === 'review' ||
    intent.taskMode === 'debug' ||
    intent.taskMode === 'refactor' ||
    intent.taskMode === 'test'
  ) {
    if (intent.class === 'simple_task' && tokenCount <= 12) {
      evidence.push('complexity:simple_inspection')
      return 'simple'
    }
    evidence.push('complexity:moderate_task_mode')
    return 'moderate'
  }

  if (intent.class === 'simple_task') {
    if (tokenCount <= 8) {
      evidence.push('complexity:trivial_simple_task')
      return 'trivial'
    }
    evidence.push('complexity:simple_task')
    return 'simple'
  }

  if (intent.class === 'ambiguous') {
    evidence.push('complexity:ambiguous_simple')
    return tokenCount <= 4 ? 'trivial' : 'simple'
  }

  if (tokenCount >= 24) {
    evidence.push('complexity:long_request')
    return 'moderate'
  }

  evidence.push('complexity:simple_default')
  return 'simple'
}

function inferExecutionRisk(
  requestText: string,
  intent: IntentResult,
  complexity: ExecutionComplexity,
  evidence: string[],
): ExecutionRisk {
  const trimmed = requestText.trim()

  if (HIGH_RISK_HINT.test(trimmed)) {
    evidence.push('risk:high_keyword')
    return 'high'
  }

  if (complexity === 'hard') {
    evidence.push('risk:high_complexity')
    return 'high'
  }

  if (
    intent.taskMode === 'debug' ||
    intent.taskMode === 'review' ||
    intent.taskMode === 'refactor' ||
    intent.taskMode === 'test'
  ) {
    evidence.push('risk:medium_task_mode')
    return 'medium'
  }

  evidence.push('risk:low_default')
  return 'low'
}

function pickExecutionMode(
  requestText: string,
  intent: IntentResult,
  complexity: ExecutionComplexity,
  risk: ExecutionRisk,
  evidence: string[],
  openHypothesisTags: ReadonlyArray<string>,
): ExecutionMode {
  const trimmed = requestText.trim()

  if (trimmed.startsWith('/')) {
    evidence.push('mode:slash_direct_execute')
    return 'direct_execute'
  }

  if (intent.class === 'chitchat') {
    evidence.push('mode:chitchat_direct_answer')
    return 'direct_answer'
  }

  if (intent.class === 'ambiguous' && trimmed.length <= 24) {
    evidence.push('mode:clarify_ambiguous')
    return 'clarify_first'
  }

  if (
    AGENT_RESEARCH_HINT.test(trimmed) &&
    complexity !== 'trivial' &&
    risk !== 'high'
  ) {
    evidence.push('mode:delegate_agents')
    return 'delegate_agents'
  }

  if (complexity === 'hard' || risk === 'high' || PLAN_HINT.test(trimmed)) {
    evidence.push('mode:plan_then_execute')
    return 'plan_then_execute'
  }

  if (
    intent.taskMode === 'review' ||
    intent.taskMode === 'debug' ||
    intent.taskMode === 'refactor' ||
    intent.taskMode === 'test'
  ) {
    evidence.push('mode:inspect_then_execute')
    return 'inspect_then_execute'
  }

  if (shouldSuppressEscalationWithKernel(intent, trimmed, openHypothesisTags)) {
    if (INSPECT_HINT.test(trimmed) && !EXECUTE_HINT.test(trimmed)) {
      evidence.push('mode:simple_inspect_then_execute')
      return 'inspect_then_execute'
    }
    if (INSPECT_HINT.test(trimmed) && EXECUTE_HINT.test(trimmed)) {
      evidence.push('mode:simple_inspect_then_execute_mixed')
      return 'inspect_then_execute'
    }
    if (EXECUTE_HINT.test(trimmed)) {
      evidence.push('mode:simple_direct_execute')
      return 'direct_execute'
    }
    evidence.push('mode:simple_direct_answer')
    return 'direct_answer'
  }

  if (INSPECT_HINT.test(trimmed) && !EXECUTE_HINT.test(trimmed)) {
    evidence.push('mode:inspect_then_execute_default')
    return 'inspect_then_execute'
  }

  evidence.push('mode:direct_execute_default')
  return 'direct_execute'
}

function deriveRouteIntent(
  mode: ExecutionMode,
  intent: IntentResult,
  risk: ExecutionRisk,
): ExecutionRouteIntent {
  if (mode === 'direct_answer') return 'latency'
  if (mode === 'clarify_first') return 'balanced'
  if (mode === 'plan_then_execute') return 'quality'
  if (mode === 'delegate_agents') return risk === 'high' ? 'quality' : 'balanced'
  if (intent.taskMode === 'test') return 'reliability'
  if (
    intent.taskMode === 'review' ||
    intent.taskMode === 'debug' ||
    intent.taskMode === 'refactor'
  ) {
    return 'quality'
  }
  return mode === 'direct_execute' ? 'balanced' : 'balanced'
}

function deriveExecutionStyle(
  mode: ExecutionMode,
): 'minimal' | 'normal' | 'deliberate' {
  if (mode === 'direct_answer' || mode === 'clarify_first') return 'minimal'
  if (mode === 'plan_then_execute' || mode === 'delegate_agents') {
    return 'deliberate'
  }
  return 'normal'
}

function deriveSuppressionFlags(
  mode: ExecutionMode,
  complexity: ExecutionComplexity,
) {
  switch (mode) {
    case 'direct_answer':
    case 'direct_execute':
    case 'clarify_first':
      return {
        suppressSkillRecall: true,
        suppressPlanMode: true,
        suppressAttachments: true,
        suppressTaskState: true,
        suppressAgentDelegation: true,
      }
    case 'inspect_then_execute':
      return {
        suppressSkillRecall: complexity === 'simple' || complexity === 'trivial',
        suppressPlanMode: true,
        suppressAttachments: complexity !== 'moderate',
        suppressTaskState: true,
        suppressAgentDelegation: true,
      }
    case 'plan_then_execute':
      return {
        suppressSkillRecall: false,
        suppressPlanMode: false,
        suppressAttachments: false,
        suppressTaskState: false,
        suppressAgentDelegation: false,
      }
    case 'delegate_agents':
      return {
        suppressSkillRecall: false,
        suppressPlanMode: complexity !== 'hard',
        suppressAttachments: false,
        suppressTaskState: false,
        suppressAgentDelegation: false,
      }
  }
}
