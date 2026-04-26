/**
 * Phase 42 — Shadow Runner (minimal API).
 *
 * 背景
 * ────
 * 目前 autoEvolve arena 已有 worktree spawn/schedule/list/cleanup,但还没有
 * 一个“真的在 shadow worktree 里跑任务”的统一薄层。为了把 sandboxFilter 从
 * 纯策略推进到“可执行 API”,这里先实现一个**最小 dry-run runner**:
 *
 *   planShadowRun(...)          → 只做计划,不执行任何工具
 *   startShadowRun(...)         → 当前版本等同 dry-run,返回 attempted=false
 *
 * 这样后续接入真实 QueryEngine / worker runtime 时,只需要在 startShadowRun 的
 * execute 分支里接上真正 runner,不必再改命令层/状态层/沙箱策略层。
 *
 * 当前版本故意保守:
 * - 不启动子进程
 * - 不调用 Agent / QueryEngine
 * - 不改 worktree 文件
 * - 只产出“如果真执行,会带哪些 allow/deny tool”的计划
 */

import { existsSync } from 'node:fs'

import { getArenaWorktreeDir } from '../paths.js'
import { readOrganism } from './arenaController.js'
import { explainShadowSandboxPolicy } from './sandboxFilter.js'
import {
  getShadowWorkerAllowedTools,
  runShadowWorkerPlan,
} from './shadowWorkerAdapter.js'
import type { OrganismManifest } from '../types.js'

export interface ShadowRunInputs {
  queryText?: string
  targetFiles?: string[]
  globPattern?: string
  grepNeedle?: string
  grepIsRegex?: boolean
  grepHeadLimit?: number
  webUrl?: string
}

export type ShadowWorktreeState =
  | 'manifest-bound'
  | 'arena-derived-missing'
  | 'path-missing'

export interface ShadowRunPlan {
  organismId: string
  status: 'shadow' | 'canary'
  worktreePath: string
  worktreeState: ShadowWorktreeState
  requestedTools: string[]
  allowedTools: string[]
  deniedTools: string[]
  deniedVerdicts: Array<{
    toolName: string
    decision: 'warn' | 'deny'
    rationale: string
    matchedBy: 'default' | 'user' | 'fallback'
  }>
  rationale: string
  inputs: ShadowRunInputs
  manifest: Pick<OrganismManifest, 'id' | 'name' | 'kind' | 'status'>
}

export interface ShadowRunExecution {
  toolName: 'Read' | 'Glob' | 'Grep' | 'WebFetch'
  ok: boolean
  summary: string
  input: Record<string, unknown>
  outputPreview: string
}

export interface ShadowRunStartResult {
  attempted: boolean
  runnerMode: 'dry-run-only' | 'read-only-executor'
  reason: string
  plan: ShadowRunPlan | null
  executions?: ShadowRunExecution[]
}

export function planShadowRun(opts: {
  organismId: string
  status?: 'shadow' | 'canary'
  requestedTools: string[]
  inputs?: ShadowRunInputs
}): ShadowRunPlan | null {
  const status = opts.status ?? 'shadow'
  const manifest = readOrganism(status, opts.organismId)
  if (!manifest) return null

  const worktreePath = manifest.worktreePath || getArenaWorktreeDir(opts.organismId)
  const worktreeExists = existsSync(worktreePath)
  const worktreeState = manifest.worktreePath
    ? (worktreeExists ? 'manifest-bound' : 'path-missing')
    : 'arena-derived-missing'
  const requestedTools = [...new Set(opts.requestedTools.filter(Boolean))]
  const allowedTools = getShadowWorkerAllowedTools(requestedTools)
  const deniedVerdicts = explainShadowSandboxPolicy(requestedTools).filter(
    v => v.decision !== 'allow',
  )
  const deniedTools = deniedVerdicts.map(v => v.toolName)

  return {
    organismId: manifest.id,
    status,
    worktreePath,
    worktreeState,
    requestedTools,
    allowedTools,
    deniedTools,
    deniedVerdicts,
    rationale: getShadowPlanRationale(worktreeState),
    inputs: opts.inputs ?? {},
    manifest: {
      id: manifest.id,
      name: manifest.name,
      kind: manifest.kind,
      status: manifest.status,
    },
  }
}

function getShadowPlanRationale(worktreeState: ShadowWorktreeState): string {
  if (worktreeState === 'arena-derived-missing') {
    return 'arena worktree not spawned yet; using derived path only'
  }
  if (worktreeState === 'path-missing') {
    return 'manifest worktreePath points to a missing directory'
  }
  return 'sandbox-filtered plan ready for dry-run/read-only execution'
}

function getShadowRunReason(args: {
  executeReadOnly: boolean
  worktreeState: ShadowWorktreeState
}): string {
  if (!args.executeReadOnly) {
    if (args.worktreeState === 'arena-derived-missing') {
      return 'arena worktree not spawned yet; returning plan only'
    }
    if (args.worktreeState === 'path-missing') {
      return 'manifest worktreePath is missing on disk; returning plan only'
    }
    return 'real shadow execution is not wired yet; returning sandbox-filtered plan only'
  }

  if (args.worktreeState === 'arena-derived-missing') {
    return 'executed allow-listed read-only tools with derived arena path; worktree not spawned yet'
  }
  if (args.worktreeState === 'path-missing') {
    return 'executed allow-listed read-only tools with manifest-bound missing worktree path'
  }
  return 'executed allow-listed read-only tools only'
}

function getShadowExecutionSummary(plan: ShadowRunPlan): string {
  if (plan.worktreeState === 'arena-derived-missing') {
    return 'execution note: plan can run, but arena worktree has not been spawned yet'
  }
  if (plan.worktreeState === 'path-missing') {
    return 'execution note: plan can run, but manifest worktreePath is missing on disk'
  }
  return 'execution note: worktree path is present for read-only execution'
}

function renderInputSummary(input: ShadowRunInputs): string {
  const parts: string[] = []
  if (input.queryText) parts.push(`query=${JSON.stringify(input.queryText)}`)
  if (input.targetFiles && input.targetFiles.length > 0) {
    parts.push(`files=${input.targetFiles.join(',')}`)
  }
  if (input.globPattern) parts.push(`glob=${JSON.stringify(input.globPattern)}`)
  if (input.grepNeedle) parts.push(`grep=${JSON.stringify(input.grepNeedle)}`)
  if (typeof input.grepIsRegex === 'boolean') parts.push(`regex=${input.grepIsRegex}`)
  if (typeof input.grepHeadLimit === 'number') parts.push(`head=${input.grepHeadLimit}`)
  if (input.webUrl) parts.push(`url=${input.webUrl}`)
  return parts.join(' | ') || '(none)'
}

function renderExecutionInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}=${value.join(',')}`
      }
      if (typeof value === 'string') {
        return `${key}=${value}`
      }
      return `${key}=${JSON.stringify(value)}`
    })
  return entries.join(' | ') || '(none)'
}

async function executeReadOnlyPlan(plan: ShadowRunPlan): Promise<ShadowRunExecution[]> {
  return runShadowWorkerPlan(plan)
}

export function renderShadowRunInputSummary(input: ShadowRunInputs): string {
  return renderInputSummary(input)
}

export function renderShadowExecutionLine(ex: ShadowRunExecution): string {
  return `[${ex.ok ? 'ok' : 'fail'}] ${ex.toolName} | ${ex.summary} | input: ${renderExecutionInput(ex.input)} | preview: ${ex.outputPreview}`
}

export function renderShadowDeniedToolLine(v: {
  toolName: string
  decision: 'warn' | 'deny'
  rationale: string
  matchedBy: 'default' | 'user' | 'fallback'
}): string {
  return `${v.toolName} | ${v.decision} | ${v.matchedBy} | ${v.rationale}`
}

export function renderShadowToolPolicySection(plan: Pick<ShadowRunPlan, 'requestedTools' | 'allowedTools' | 'deniedTools' | 'deniedVerdicts'>): string[] {
  const lines: string[] = []
  lines.push(`requestedTools: ${plan.requestedTools.join(', ') || '(none)'}`)
  lines.push(`allowedTools:   ${plan.allowedTools.join(', ') || '(none)'}`)
  lines.push(`deniedTools:    ${plan.deniedTools.join(', ') || '(none)'}`)
  if (plan.deniedVerdicts.length > 0) {
    lines.push('denied details:')
    for (const verdict of plan.deniedVerdicts) {
      lines.push(`  - ${renderShadowDeniedToolLine(verdict)}`)
    }
  }
  return lines
}

export function indentLines(lines: readonly string[], prefix = '  '): string[] {
  return lines.map(line => `${prefix}${line}`)
}

export function renderShadowPlanHeader(plan: Pick<ShadowRunPlan, 'organismId' | 'status' | 'worktreePath' | 'worktreeState' | 'rationale' | 'inputs' | 'manifest' | 'requestedTools' | 'allowedTools' | 'deniedTools' | 'deniedVerdicts'>): string[] {
  return [
    `organism: ${plan.manifest.name} (${plan.organismId})`,
    `kind/status: ${plan.manifest.kind}/${plan.status}`,
    `worktreeState: ${plan.worktreeState}`,
    `worktreePath: ${plan.worktreePath}`,
    ...renderShadowToolPolicySection(plan),
    `inputs: ${renderShadowRunInputSummary(plan.inputs)}`,
    `plan rationale: ${plan.rationale}`,
    getShadowExecutionSummary(plan),
  ]
}

export function renderShadowExecutionSection(run: Pick<ShadowRunStartResult, 'attempted' | 'runnerMode' | 'reason' | 'plan' | 'executions'>): string[] {
  if (!run.plan) {
    return ['(no plan — organism not found)']
  }
  const lines: string[] = []
  lines.push(`organism: ${run.plan.manifest.name} (${run.plan.organismId})`)
  lines.push(`attempted: ${run.attempted}`)
  lines.push(`runnerMode: ${run.runnerMode}`)
  lines.push(`reason: ${run.reason}`)
  lines.push(`worktreeState: ${run.plan.worktreeState}`)
  lines.push(`worktreePath: ${run.plan.worktreePath}`)
  lines.push(getShadowExecutionSummary(run.plan))
  lines.push(`inputs: ${renderShadowRunInputSummary(run.plan.inputs)}`)
  if ((run.executions?.length ?? 0) === 0) {
    lines.push('(no read-only executions)')
    return lines
  }
  lines.push('executions:')
  for (const ex of run.executions ?? []) {
    lines.push(`  - ${renderShadowExecutionLine(ex)}`)
  }
  return lines
}

export function renderSingleShadowRunReport(result: Pick<ShadowRunStartResult, 'attempted' | 'runnerMode' | 'reason' | 'plan' | 'executions'>): string[] {
  if (!result.plan) {
    return [
      `attempted: ${result.attempted}`,
      `runnerMode: ${result.runnerMode}`,
      `reason: ${result.reason}`,
      '',
      ...renderShadowExecutionSection(result),
    ]
  }
  const lines: string[] = []
  lines.push(`attempted: ${result.attempted}`)
  lines.push(`runnerMode: ${result.runnerMode}`)
  lines.push(`reason: ${result.reason}`)
  lines.push('')
  lines.push(...renderShadowPlanHeader(result.plan))
  if (result.executions && result.executions.length > 0) {
    lines.push('')
    lines.push('### read-only executions')
    lines.push(...renderShadowExecutionSection(result).slice(7))
  }
  return lines
}

export function renderArenaShadowPlanBlock(plans: ReadonlyArray<ShadowRunPlan>): string[] {
  if (plans.length === 0) {
    return ['(no shadow plans)']
  }
  const lines: string[] = []
  lines.push('### shadow run plan (Phase 42)')
  lines.push('spawn-auto now runs the minimal read-only shadow executor after planning.')
  lines.push('')
  for (const plan of plans) {
    const planLines = renderShadowPlanHeader(plan)
    lines.push(`  - ${plan.manifest.name} (${plan.organismId})`)
    lines.push(...indentLines(planLines.slice(1), '      '))
  }
  return lines
}

export function renderArenaShadowExecutionBlock(executions: ReadonlyArray<Pick<ShadowRunStartResult, 'attempted' | 'runnerMode' | 'reason' | 'plan' | 'executions'>>): string[] {
  if (executions.length === 0) {
    return ['### shadow read-only executions (Phase 42)', '(no shadow executions)']
  }
  const lines: string[] = []
  lines.push('### shadow read-only executions (Phase 42)')
  for (const run of executions) {
    const executionLines = renderShadowExecutionSection(run)
    if (!run.plan) {
      lines.push(...indentLines(executionLines, '  '))
      continue
    }
    lines.push(`  - ${run.plan.manifest.name} (${run.plan.organismId})`)
    lines.push(...indentLines(executionLines.slice(1), '      '))
  }
  return lines
}

export async function startShadowRun(opts: {
  organismId: string
  status?: 'shadow' | 'canary'
  requestedTools: string[]
  inputs?: ShadowRunInputs
  executeReadOnly?: boolean
}): Promise<ShadowRunStartResult> {
  const plan = planShadowRun(opts)
  if (!plan) {
    return {
      attempted: false,
      runnerMode: 'dry-run-only',
      reason: 'organism not found',
      plan: null,
    }
  }
  if (!opts.executeReadOnly) {
    return {
      attempted: false,
      runnerMode: 'dry-run-only',
      reason: getShadowRunReason({
        executeReadOnly: false,
        worktreeState: plan.worktreeState,
      }),
      plan,
    }
  }
  const executions = await executeReadOnlyPlan(plan)
  return {
    attempted: true,
    runnerMode: 'read-only-executor',
    reason: getShadowRunReason({
      executeReadOnly: true,
      worktreeState: plan.worktreeState,
    }),
    plan,
    executions,
  }
}
