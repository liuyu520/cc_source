import {
  getEffectiveMetaGenome,
  computeMetaOracleSnapshot,
  advocateMutationRate,
  advocateArenaShadowCount,
  advocateLearningRate,
  advocateSelectionPressure,
} from '../index.js'
import {
  computeWeightSuggestion,
  loadTunedOracleWeights,
  suggestionToNext,
} from '../oracle/metaEvolver.js'
import { DEFAULT_ORACLE_WEIGHTS } from '../oracle/fitnessOracle.js'
import { getTunedOracleWeightsPath } from '../paths.js'

export type MetaParamName =
  | 'mutationRate'
  | 'arenaShadowCount'
  | 'learningRate'
  | 'selectionPressure'

export interface MetaParamDecision {
  name: MetaParamName
  current: number
  suggested: number
  direction: 'up' | 'down' | 'hold'
  reason: string
  applyHint: string | null
}

export interface MetaOracleDecision {
  actionable: boolean
  reason: string
  path: string
  currentLabel: string
  nextLabel: string | null
  nextPayload: Record<string, unknown> | null
  weightSuggestion: ReturnType<typeof computeWeightSuggestion>
  tunedWeights: ReturnType<typeof loadTunedOracleWeights>
  currentWeights: {
    version: 1
    updatedAt: string
    userSatisfaction: number
    taskSuccess: number
    codeQuality: number
    performance: number
  }
}

export interface MetaActionPlanSnapshot {
  metaGenome: ReturnType<typeof getEffectiveMetaGenome>
  snapshot: ReturnType<typeof computeMetaOracleSnapshot>
  paramDecisions: MetaParamDecision[]
  exploreVotes: number
  stabilizeVotes: number
  actionableParamLabels: MetaParamName[]
  metaAdvisor: 'explore' | 'stabilize' | 'hold'
  metaAction: string
  oracle: MetaOracleDecision
}

export function pickActionableMetaParams(
  decisions: MetaParamDecision[],
): MetaParamDecision[] {
  return decisions.filter(item => item.direction !== 'hold')
}

export function getSingleActionableMetaParamName(
  decisions: MetaParamDecision[],
): MetaParamName | null {
  return (
    decisions.find(item => item.direction !== 'hold')?.name ?? null
  )
}

export interface RenderMetaActionPlanOptions {
  indent?: string
}

export interface RenderMetaOracleAdviceOptions {
  indent?: string
  labelPrefix?: string
}

export interface RenderMetaParamAdviceOptions {
  indent?: string
  labelPrefix?: string
  includeApplyHint?: boolean
}

export interface RenderMetaApplyPlanOptions {
  indent?: string
  apply?: boolean
  oracleOnly?: boolean
  param?: MetaParamName | null
  scopedParams?: MetaParamDecision[]
}

export function renderMetaActionPlanLines(
  plan: MetaActionPlanSnapshot,
  opts: RenderMetaActionPlanOptions = {},
): string[] {
  const indent = opts.indent ?? ''
  const lines: string[] = []
  lines.push(`${indent}metaActionPlan:`)
  if (plan.metaAction === 'hold') {
    lines.push(`${indent}  1. hold — no actionable meta knobs right now`)
  } else if (plan.metaAction === 'manual review') {
    lines.push(
      `${indent}  1. manual review — mixed signals (${plan.actionableParamLabels.join(', ') || 'none'}${plan.oracle.actionable ? '; oracleWeights actionable' : ''})`,
    )
  } else if (
    plan.metaAction === 'apply exploration bundle' ||
    plan.metaAction === 'apply stabilization bundle'
  ) {
    const scopeHint = plan.oracle.actionable
      ? ''
      : ' --oracle-only is not needed right now'
    lines.push(`${indent}  1. /evolve-meta-apply${scopeHint}`)
    lines.push(`${indent}  2. /evolve-meta-apply --apply`)
  } else if (plan.metaAction === 'apply oracleWeights only') {
    lines.push(`${indent}  1. /evolve-meta-apply --oracle-only`)
    lines.push(`${indent}  2. /evolve-meta-apply --oracle-only --apply`)
  } else {
    const singleName = getSingleActionableMetaParamName(plan.paramDecisions)
    lines.push(
      `${indent}  1. ${singleName ? `/evolve-meta-apply --param ${singleName}` : 'manual review'}`,
    )
    if (singleName) {
      lines.push(`${indent}  2. /evolve-meta-apply --param ${singleName} --apply`)
    }
  }
  return lines
}

export function renderMetaApplyPlanLines(
  plan: MetaActionPlanSnapshot,
  opts: RenderMetaApplyPlanOptions = {},
): string[] {
  const indent = opts.indent ?? ''
  const apply = opts.apply ?? false
  const oracleOnly = opts.oracleOnly ?? false
  const param = opts.param ?? null
  const scopedParams = opts.scopedParams ?? []
  const lines: string[] = []
  lines.push(`${indent}Execution plan:`)

  if (oracleOnly) {
    if (plan.oracle.actionable) {
      lines.push(`${indent}  1. ${apply ? 'write' : 'would write'} oracleWeights snapshot`)
    } else {
      lines.push(`${indent}  1. hold — oracleWeights not actionable right now`)
    }
    return lines
  }

  if (param) {
    const hit = scopedParams[0]
    if (!hit) {
      lines.push(`${indent}  1. hold — ${param} not actionable right now`)
    } else {
      lines.push(
        `${indent}  1. ${apply ? 'write' : 'would write'} metaGenome.${hit.name} = ${formatMetaParamValue(hit.name, hit.suggested)}`,
      )
    }
    return lines
  }

  if (plan.metaAction === 'hold') {
    lines.push(`${indent}  1. hold — no actionable meta knobs right now`)
  } else if (plan.metaAction === 'manual review') {
    lines.push(`${indent}  1. manual review — mixed signals, command refuses implicit apply`)
  } else {
    let step = 1
    for (const item of scopedParams) {
      lines.push(
        `${indent}  ${step++}. ${apply ? 'write' : 'would write'} metaGenome.${item.name} = ${formatMetaParamValue(item.name, item.suggested)}`,
      )
    }
    if (plan.oracle.actionable) {
      lines.push(`${indent}  ${step}. ${apply ? 'write' : 'would write'} oracleWeights snapshot`)
    }
  }
  return lines
}

export function renderMetaParamAdviceLines(
  decision: MetaParamDecision,
  opts: RenderMetaParamAdviceOptions = {},
): string[] {
  const indent = opts.indent ?? ''
  const labelPrefix = opts.labelPrefix ?? decision.name
  const includeApplyHint = opts.includeApplyHint ?? true
  const lines: string[] = []
  const fmt = (n: number) => formatMetaParamValue(decision.name, n)

  if (decision.direction === 'hold') {
    lines.push(
      `${indent}${labelPrefix}: ⏸ hold ${fmt(decision.current)}  (${decision.reason})`,
    )
    return lines
  }

  const arrow = decision.direction === 'up' ? '⬆️' : '⬇️'
  lines.push(
    `${indent}${labelPrefix}: ${arrow} ${fmt(decision.current)} → ${fmt(decision.suggested)}  (${decision.reason})`,
  )
  if (includeApplyHint && decision.applyHint) {
    lines.push(`${indent}  apply: ${decision.applyHint}`)
  }
  return lines
}

export function renderMetaOracleAdviceLines(
  plan: MetaActionPlanSnapshot,
  opts: RenderMetaOracleAdviceOptions = {},
): string[] {
  const indent = opts.indent ?? ''
  const labelPrefix = opts.labelPrefix ?? 'advice · oracleWeights'
  const lines: string[] = []
  const weightSuggestion = plan.oracle.weightSuggestion

  if (weightSuggestion.insufficientReason) {
    lines.push(`${indent}${labelPrefix}: ⏸ hold (${weightSuggestion.insufficientReason})`)
    return lines
  }

  const topRows = [...weightSuggestion.rows]
    .sort((a, b) => Math.abs(b.suggested - b.current) - Math.abs(a.suggested - a.current))
    .slice(0, 2)
  const summary = topRows.map(r => {
    const dir = r.suggested > r.current ? '⬆️' : r.suggested < r.current ? '⬇️' : '⏸'
    const short =
      r.name === 'userSatisfaction'
        ? 'user'
        : r.name === 'taskSuccess'
          ? 'task'
          : r.name === 'codeQuality'
            ? 'code'
            : 'perf'
    return `${dir}${short} ${r.current.toFixed(3)}→${r.suggested.toFixed(3)} (snr=${r.snr.toFixed(2)})`
  }).join(', ')

  lines.push(
    `${indent}${labelPrefix}: ${summary}  [30d points=${weightSuggestion.dataPoints}, win=${weightSuggestion.winCount}, loss=${weightSuggestion.lossCount}]`,
  )
  lines.push(
    `${indent}apply: /evolve-meta-apply --oracle-only --apply  # writes ${plan.oracle.path} with ${plan.oracle.nextLabel}`,
  )
  if (plan.metaAction === 'apply oracleWeights only') {
    lines.push(`${indent}tip: oracleWeights is the only actionable knob right now`)
  }
  return lines
}

function formatMetaParamValue(name: MetaParamName, value: number): string {
  if (name === 'arenaShadowCount') return String(value)
  if (name === 'selectionPressure') return value.toFixed(2)
  if (name === 'learningRate') return value.toFixed(4)
  return value.toFixed(3)
}

export function buildMetaActionPlanSnapshot(
  windowDays = 30,
): MetaActionPlanSnapshot {
  const metaGenome = getEffectiveMetaGenome()
  const snapshot = computeMetaOracleSnapshot()
  const mutationRate = advocateMutationRate({
    snapshot,
    currentOverride: metaGenome.mutationRate,
  })
  const arenaShadowCount = advocateArenaShadowCount({
    snapshot,
    currentOverride: metaGenome.arenaShadowCount,
  })
  const learningRate = advocateLearningRate({
    snapshot,
    currentOverride: metaGenome.learningRate,
  })
  const selectionPressure = advocateSelectionPressure({
    snapshot,
    currentOverride: metaGenome.selectionPressure,
  })

  const paramDecisions: MetaParamDecision[] = [
    {
      name: 'mutationRate',
      current: mutationRate.current,
      suggested: mutationRate.suggested,
      direction: mutationRate.direction,
      reason: mutationRate.reason,
      applyHint: mutationRate.applyHint,
    },
    {
      name: 'arenaShadowCount',
      current: arenaShadowCount.current,
      suggested: arenaShadowCount.suggested,
      direction: arenaShadowCount.direction,
      reason: arenaShadowCount.reason,
      applyHint: arenaShadowCount.applyHint,
    },
    {
      name: 'learningRate',
      current: learningRate.current,
      suggested: learningRate.suggested,
      direction: learningRate.direction,
      reason: learningRate.reason,
      applyHint: learningRate.applyHint,
    },
    {
      name: 'selectionPressure',
      current: selectionPressure.current,
      suggested: selectionPressure.suggested,
      direction: selectionPressure.direction,
      reason: selectionPressure.reason,
      applyHint: selectionPressure.applyHint,
    },
  ]

  const exploreVotes = [
    mutationRate.direction === 'up',
    arenaShadowCount.direction === 'up',
    learningRate.direction === 'up',
    selectionPressure.direction === 'down',
  ].filter(Boolean).length
  const stabilizeVotes = [
    mutationRate.direction === 'down',
    arenaShadowCount.direction === 'down',
    learningRate.direction === 'down',
    selectionPressure.direction === 'up',
  ].filter(Boolean).length

  const metaAdvisor =
    exploreVotes > stabilizeVotes
      ? 'explore'
      : stabilizeVotes > exploreVotes
        ? 'stabilize'
        : 'hold'

  const actionableParamLabels = pickActionableMetaParams(paramDecisions).map(
    item => item.name,
  )

  const weightSuggestion = computeWeightSuggestion(windowDays)
  const oracleActionable = !weightSuggestion.insufficientReason
  const tunedWeights = loadTunedOracleWeights()
  const currentWeights = tunedWeights ?? {
    version: 1 as const,
    updatedAt: DEFAULT_ORACLE_WEIGHTS.updatedAt,
    userSatisfaction: DEFAULT_ORACLE_WEIGHTS.userSatisfaction,
    taskSuccess: DEFAULT_ORACLE_WEIGHTS.taskSuccess,
    codeQuality: DEFAULT_ORACLE_WEIGHTS.codeQuality,
    performance: DEFAULT_ORACLE_WEIGHTS.performance,
  }
  const nextWeights = oracleActionable ? suggestionToNext(weightSuggestion) : null

  const metaAction =
    metaAdvisor === 'explore' && exploreVotes >= 3
      ? 'apply exploration bundle'
      : metaAdvisor === 'stabilize' && stabilizeVotes >= 3
        ? 'apply stabilization bundle'
        : actionableParamLabels.length === 1 && !oracleActionable
          ? `apply ${actionableParamLabels[0]} only`
          : actionableParamLabels.length === 0 && oracleActionable
            ? 'apply oracleWeights only'
            : actionableParamLabels.length === 0 && !oracleActionable
              ? 'hold'
              : 'manual review'

  return {
    metaGenome,
    snapshot,
    paramDecisions,
    exploreVotes,
    stabilizeVotes,
    actionableParamLabels,
    metaAdvisor,
    metaAction,
    oracle: {
      actionable: oracleActionable,
      reason: weightSuggestion.insufficientReason ?? 'oracleWeights actionable',
      path: getTunedOracleWeightsPath(),
      currentLabel: `points=${weightSuggestion.dataPoints} wins=${weightSuggestion.winCount} losses=${weightSuggestion.lossCount}`,
      nextLabel: nextWeights
        ? `user=${nextWeights.userSatisfaction.toFixed(6)} task=${nextWeights.taskSuccess.toFixed(6)} code=${nextWeights.codeQuality.toFixed(6)} perf=${nextWeights.performance.toFixed(6)}`
        : null,
      nextPayload: nextWeights,
      weightSuggestion,
      tunedWeights,
      currentWeights,
    },
  }
}
