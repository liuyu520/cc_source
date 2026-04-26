/**
 * ContextSignals · budgetLedger —— Phase 55 token budget 账本
 *
 * 目的:
 * - 把既有 `services/compact/contextBudget.ts` 每次估算的结果(system/tools/
 *   history/output 四段预算 + ratio + shouldPrefetch)快照到一张 ring buffer,
 *   供 /kernel-status 展示"当前 turn 的上下文经济学分布"。
 * - **零计算开销**:不重复跑 estimator,只在既有调用点之后复制一次 allocation。
 * - 纯内存,进程退出清零,与 Phase 54 telemetry 风格一致。
 *
 * 设计拒绝:
 * - 不自己算 budget —— 复用现有 estimateContextBudgetAllocation。
 * - 不做"裁剪建议" —— 那是 Phase 57 Choreographer 的职责。
 */

import {
  buildTokenEfficiencyFootprintPlan,
  formatTokenEfficiencyPlanItem,
} from '../tokenEfficiency/autoplan.js'
import type { ContextBudgetAllocation } from '../compact/contextBudget.js'

export type BudgetLedgerEntry = {
  ts: number
  /** 决策点人类可读标识, 如 'query' / 'auto-compact' / 'sub-agent' */
  decisionPoint?: string
  /** 上下文窗口总额 */
  totalWindowTokens: number
  /** 输入侧总预算 = totalWindow - output 预留 */
  inputBudgetTokens: number
  outputBudgetTokens: number
  /** 各 section 估算用量 */
  sectionTokens: {
    system: number
    tools: number
    history: number
    output: number
  }
  /** 总用量 / 总预算 */
  ratio: number
  usedTokens: number
  maxTokens: number
  /** estimator 的预取建议 */
  shouldPrefetch: boolean
  /** estimator 给出的原因 */
  reason: string
  /** 最热 section(system|tools|history|none) */
  hottestSection: string
}

export type BudgetLedgerSnapshot = {
  enabled: boolean
  ringCapacity: number
  count: number
  /** 最近一次(最新) entry */
  latest?: BudgetLedgerEntry
  /** 最近若干条(倒序) */
  recent: ReadonlyArray<BudgetLedgerEntry>
  /** 聚合统计 */
  avgRatio: number
  prefetchRate: number
}

// ── 环境开关 ────────────────────────────────────────────
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_SIGNALS ?? '').trim().toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

const RING_CAPACITY = 50
const ring: BudgetLedgerEntry[] = []

/**
 * 写入路径:调用方只需把 estimateContextBudgetAllocation 的返回值原样传进来。
 * 失败静默, 零阻塞。
 */
export function recordBudgetAllocation(
  alloc: ContextBudgetAllocation,
  opts?: { decisionPoint?: string; ts?: number },
): void {
  if (!isEnabled()) return
  try {
    const entry: BudgetLedgerEntry = {
      ts: opts?.ts ?? Date.now(),
      decisionPoint: opts?.decisionPoint,
      totalWindowTokens: alloc.totalWindowTokens | 0,
      inputBudgetTokens: alloc.inputBudgetTokens | 0,
      outputBudgetTokens: alloc.outputBudgetTokens | 0,
      sectionTokens: {
        system: alloc.sections.system.estimatedTokens | 0,
        tools: alloc.sections.tools.estimatedTokens | 0,
        history: alloc.sections.history.estimatedTokens | 0,
        output: alloc.sections.output.estimatedTokens | 0,
      },
      ratio: alloc.stats.ratio,
      usedTokens: alloc.stats.usedTokens | 0,
      maxTokens: alloc.stats.maxTokens | 0,
      shouldPrefetch: !!alloc.shouldPrefetch,
      reason: String(alloc.reason ?? ''),
      hottestSection: String(alloc.volatility?.hottestSection ?? 'none'),
    }
    ring.push(entry)
    if (ring.length > RING_CAPACITY) {
      ring.splice(0, ring.length - RING_CAPACITY)
    }
  } catch {
    // 账本只读, 吞异常, 不影响 estimator 调用链
  }
}

export function getBudgetLedgerSnapshot(): BudgetLedgerSnapshot {
  const enabled = isEnabled()
  const count = ring.length
  const latest = count > 0 ? ring[count - 1] : undefined
  const recent = ring.slice(-5).reverse()
  const avgRatio =
    count > 0 ? ring.reduce((s, e) => s + (e.ratio || 0), 0) / count : 0
  const prefetchCount = ring.reduce((s, e) => s + (e.shouldPrefetch ? 1 : 0), 0)
  const prefetchRate = count > 0 ? prefetchCount / count : 0
  return {
    enabled,
    ringCapacity: RING_CAPACITY,
    count,
    latest,
    recent,
    avgRatio,
    prefetchRate,
  }
}

/** /cost 用的人类可读 prompt footprint 摘要,无样本时静默不展示。 */
export function formatBudgetLedgerSummary(): string | null {
  const snapshot = getBudgetLedgerSnapshot()
  const latest = snapshot.latest
  if (!snapshot.enabled || !latest) return null
  const ratio = (latest.ratio * 100).toFixed(1)
  const avgRatio = (snapshot.avgRatio * 100).toFixed(1)
  const prefetchRate = (snapshot.prefetchRate * 100).toFixed(1)
  const { system, tools, history, output } = latest.sectionTokens
  const plan = buildTokenEfficiencyFootprintPlan({
    ratio: latest.ratio,
    avgRatio: snapshot.avgRatio,
    prefetchRate: snapshot.prefetchRate,
    hottestSection: latest.hottestSection,
    sectionTokens: latest.sectionTokens,
  })
  const action = plan
    ? formatTokenEfficiencyPlanItem(plan)
    : '[info/prompt-footprint] Prompt footprint is within the current read-only threshold. No action needed.'
  return `Prompt footprint: latest=${ratio}% avg=${avgRatio}% hottest=${latest.hottestSection} prefetch=${prefetchRate}%\nsections: system=${system}, tools=${tools}, history=${history}, output=${output}\nautoplan: ${action}`
}

/** 仅供测试/诊断, 生产路径不调用 */
export function __resetBudgetLedgerForTests(): void {
  ring.length = 0
}
