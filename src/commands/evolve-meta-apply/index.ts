/**
 * /evolve-meta-apply [--apply] [--window DAYS] [--oracle-only] [--param NAME]
 *
 * autoEvolve(v1.0) — Phase 6.1:把 Phase 5.9/6 的 metaActionPlan 提升为真正可执行命令。
 *
 * 设计原则:
 *   - 默认 dry-run,只打印 plan 与预期写入,不改磁盘
 *   - 尽量复用已有 Phase 5 逻辑:MetaOracle + 4 个 advisor + Phase 27 metaEvolver
 *   - 真正 apply 时直接写 meta-genome.json / tuned-oracle-weights.json,不引入新存储
 *   - mixed signals 继续 fail-closed 为 manual review;不擅自执行
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  pickActionableMetaParams,
  renderMetaApplyPlanLines,
} from '../../services/autoEvolve/index.js'

const USAGE = `Usage:
  /evolve-meta-apply [--apply] [--window DAYS] [--oracle-only] [--param NAME]
    - (no flags):        dry-run; print metaAction + execution plan
    - --apply:           execute the current actionable plan
    - --window DAYS:     oracleWeights suggestion window (default 30)
    - --oracle-only:     ignore param knobs; only consider oracleWeights apply
    - --param NAME:      apply a single meta knob only
                         NAME ∈ mutationRate | arenaShadowCount | learningRate | selectionPressure
    - --help:            show this help`

type MetaParamName =
  | 'mutationRate'
  | 'arenaShadowCount'
  | 'learningRate'
  | 'selectionPressure'

interface ParsedFlags {
  apply: boolean
  windowDays: number
  oracleOnly: boolean
  param: MetaParamName | null
  error: string | null
}

interface ParamDecision {
  name: MetaParamName
  current: number
  suggested: number
  direction: 'up' | 'down' | 'hold'
  reason: string
}

interface MetaExecutionPlan {
  metaAdvisor: 'explore' | 'stabilize' | 'hold'
  metaAction: string
  paramDecisions: ParamDecision[]
  oracle: {
    actionable: boolean
    path: string
    currentLabel: string
    nextLabel: string | null
    nextPayload: Record<string, unknown> | null
    reason: string
  }
  sharedSnapshot: Awaited<ReturnType<typeof import('../../services/autoEvolve/index.js')['buildMetaActionPlanSnapshot']>>
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    windowDays: 30,
    oracleOnly: false,
    param: null,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--window' || t === '-w') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--window requires a number (e.g. --window 14)'
        return out
      }
      const n = Number.parseInt(next, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 365) {
        out.error = `--window must be a positive integer 1..365 (got "${next}")`
        return out
      }
      out.windowDays = n
      i++
    } else if (t === '--oracle-only') {
      out.oracleOnly = true
    } else if (t === '--param') {
      const next = tokens[i + 1] as MetaParamName | undefined
      if (!next) {
        out.error = '--param requires a name'
        return out
      }
      if (
        next !== 'mutationRate' &&
        next !== 'arenaShadowCount' &&
        next !== 'learningRate' &&
        next !== 'selectionPressure'
      ) {
        out.error = `--param must be one of mutationRate | arenaShadowCount | learningRate | selectionPressure (got "${next}")`
        return out
      }
      out.param = next
      i++
    } else if (t === '--help' || t === '-h') {
      out.error = USAGE
      return out
    } else {
      out.error = `Unknown flag "${t}"\n\n${USAGE}`
      return out
    }
  }
  if (out.oracleOnly && out.param) {
    out.error = '--oracle-only and --param are mutually exclusive'
  }
  return out
}

async function buildPlan(windowDays: number): Promise<MetaExecutionPlan> {
  const autoEvolve = await import('../../services/autoEvolve/index.js')
  const snapshot = autoEvolve.buildMetaActionPlanSnapshot(windowDays)
  return {
    metaAdvisor: snapshot.metaAdvisor,
    metaAction: snapshot.metaAction,
    paramDecisions: snapshot.paramDecisions.map(item => ({
      name: item.name,
      current: item.current,
      suggested: item.suggested,
      direction: item.direction,
      reason: item.reason,
    })),
    oracle: {
      actionable: snapshot.oracle.actionable,
      path: snapshot.oracle.path,
      currentLabel: snapshot.oracle.currentLabel,
      nextLabel: snapshot.oracle.nextLabel,
      nextPayload: snapshot.oracle.nextPayload,
      reason: snapshot.oracle.reason,
    },
    sharedSnapshot: snapshot,
  }
}

function fmtValue(name: MetaParamName, value: number): string {
  if (name === 'arenaShadowCount') return String(value)
  if (name === 'selectionPressure') return value.toFixed(2)
  if (name === 'learningRate') return value.toFixed(4)
  return value.toFixed(3)
}

function toSharedScopedParams(plan: MetaExecutionPlan, scopedParams: ParamDecision[]) {
  return plan.sharedSnapshot.paramDecisions.filter(item =>
    scopedParams.some(scoped => scoped.name === item.name),
  )
}

function renderPlan(parsed: ParsedFlags, plan: MetaExecutionPlan, scopedParams: ParamDecision[]): string {
  const lines: string[] = []
  lines.push('## autoEvolve Meta Apply (Phase 6.1)')
  lines.push('')
  lines.push(`mode: ${parsed.apply ? '**APPLY**' : 'dry-run (no write)'}`)
  lines.push(`window: last ${parsed.windowDays} day(s)`)
  lines.push(`metaAdvisor: ${plan.metaAdvisor}`)
  lines.push(`metaAction: ${plan.metaAction}`)
  if (parsed.oracleOnly) lines.push('scope: oracleWeights only')
  if (parsed.param) lines.push(`scope: single param (${parsed.param})`)
  lines.push('')
  lines.push('Param decisions:')
  for (const item of plan.paramDecisions) {
    const inExplicitScope = parsed.param ? item.name === parsed.param : scopedParams.some(_ => _.name === item.name)
    const scoped = inExplicitScope ? '' : ' (out of scope)'
    lines.push(
      `  - ${item.name}: ${item.direction} ${fmtValue(item.name, item.current)} → ${fmtValue(item.name, item.suggested)}${scoped}`,
    )
    lines.push(`    reason: ${item.reason}`)
  }
  lines.push('')
  lines.push('Oracle decision:')
  if (!plan.oracle.actionable) {
    lines.push(`  - hold (${plan.oracle.reason})`)
  } else {
    lines.push(`  - write ${plan.oracle.path}`)
    lines.push(`    next: ${plan.oracle.nextLabel}`)
    lines.push(`    basis: ${plan.oracle.currentLabel}`)
  }
  lines.push('')
  lines.push(
    ...renderMetaApplyPlanLines(plan.sharedSnapshot, {
      apply: parsed.apply,
      oracleOnly: parsed.oracleOnly,
      param: parsed.param,
      scopedParams: toSharedScopedParams(plan, scopedParams),
    }),
  )
  return lines.join('\n')
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) {
    return { type: 'text', value: parsed.error }
  }

  const plan = await buildPlan(parsed.windowDays)
  const autoEvolve = await import('../../services/autoEvolve/index.js')
  const metaEvolver = await import('../../services/autoEvolve/oracle/metaEvolver.js')

  const allActionableParams = pickActionableMetaParams(plan.sharedSnapshot.paramDecisions).map(item => ({
    name: item.name,
    current: item.current,
    suggested: item.suggested,
    direction: item.direction,
    reason: item.reason,
  }))
  const scopedParams = parsed.oracleOnly
    ? []
    : parsed.param
      ? allActionableParams.filter(item => item.name === parsed.param)
      : plan.metaAction === 'apply exploration bundle' ||
          plan.metaAction === 'apply stabilization bundle' ||
          (plan.metaAction.startsWith('apply ') && plan.metaAction.endsWith(' only'))
        ? allActionableParams
        : []

  if (!parsed.apply) {
    return { type: 'text', value: renderPlan(parsed, plan, scopedParams) }
  }

  const lines: string[] = [renderPlan(parsed, plan, scopedParams), '', 'Apply result:']
  let wroteCount = 0
  let skippedCount = 0
  let failedCount = 0
  let refused = false

  if (!parsed.oracleOnly && !parsed.param && plan.metaAction === 'manual review') {
    refused = true
    lines.push('  refused: mixed signals require manual scoping via --param or --oracle-only')
    lines.push('')
    lines.push('Summary: refused (manual review)')
    return { type: 'text', value: lines.join('\n') }
  }

  if (!parsed.oracleOnly) {
    if (scopedParams.length > 0) {
      const current = autoEvolve.getEffectiveMetaGenome()
      const patch: Record<string, unknown> = {}
      for (const item of scopedParams) patch[item.name] = item.suggested
      const res = autoEvolve.saveMetaGenome({ ...current, ...patch })
      if (res.ok) {
        wroteCount++
        lines.push(`  wrote ${res.path}`)
        for (const item of scopedParams) {
          lines.push(`  metaGenome.${item.name} = ${fmtValue(item.name, item.suggested)}`)
        }
      } else {
        failedCount++
        lines.push(`  metaGenome write failed: ${res.error}`)
        lines.push(`  path: ${res.path}`)
      }
    } else if (parsed.param) {
      skippedCount++
      lines.push(`  skipped: ${parsed.param} not actionable right now`)
    }
  }

  if (
    (parsed.oracleOnly || (!parsed.param && plan.metaAction !== 'manual review')) &&
    plan.oracle.actionable &&
    plan.oracle.nextPayload
  ) {
    const res = metaEvolver.saveTunedOracleWeights(plan.oracle.nextPayload as any)
    if (res.ok) {
      wroteCount++
      lines.push(`  wrote ${res.path}`)
      lines.push(`  oracleWeights: ${plan.oracle.nextLabel}`)
    } else {
      failedCount++
      lines.push(`  oracleWeights write failed: ${res.error}`)
      lines.push(`  path: ${res.path}`)
    }
  } else if (parsed.oracleOnly && !plan.oracle.actionable) {
    skippedCount++
    lines.push(`  skipped: oracleWeights not actionable (${plan.oracle.reason})`)
  }

  let summary: string
  if (refused) {
    summary = 'refused (manual review)'
  } else if (failedCount > 0 && wroteCount > 0) {
    summary = `partial success (wrote=${wroteCount}, failed=${failedCount}, skipped=${skippedCount})`
  } else if (failedCount > 0) {
    summary = `failed (failed=${failedCount}, skipped=${skippedCount})`
  } else if (wroteCount > 0) {
    summary = `success (wrote=${wroteCount}, skipped=${skippedCount})`
  } else {
    summary = `no-op (skipped=${skippedCount})`
  }

  lines.push('')
  lines.push(`Summary: ${summary}`)
  return { type: 'text', value: lines.join('\n') }
}

const evolveMetaApply = {
  type: 'local',
  name: 'evolve-meta-apply',
  description:
    'Phase 6.1 metaAction executor. Dry-run by default; reuses MetaOracle + 4 advisors + Phase 27 oracle meta-evolver to preview or apply metaGenome/oracleWeights changes.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveMetaApply
