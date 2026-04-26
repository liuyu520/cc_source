/**
 * SideQuery 埋点 — 复用 services/analytics + utils/debug 两套既有通道。
 *
 * 任何分析消费者（/doctor 面板、调试日志）都可通过这里注入 hook。
 */

import { logForDebugging } from '../../utils/debug.js'
import type {
  SideQueryCategory,
  SideQueryPriority,
  SideQueryResult,
  SideQueryStatus,
  SideQueryTask,
} from './types.js'

export interface SideQueryTelemetryEvent {
  id: string
  category: SideQueryCategory
  priority: SideQueryPriority
  source: string
  status: SideQueryStatus
  tookMs: number
  queueWaitMs: number
  circuitBreakerOpen: boolean
  fallbackUsed: boolean
  dedupeHit: boolean
  errorMessage?: string
}

type Listener = (ev: SideQueryTelemetryEvent) => void

const listeners = new Set<Listener>()

export function onSideQueryEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitSideQueryEvent(
  task: SideQueryTask,
  result: SideQueryResult,
): void {
  const ev: SideQueryTelemetryEvent = {
    id: task.id ?? 'anon',
    category: task.category,
    priority: task.priority,
    source: task.source,
    status: result.status,
    tookMs: result.tookMs,
    queueWaitMs: result.queueWaitMs,
    circuitBreakerOpen: result.circuitBreakerOpen,
    fallbackUsed: result.fallbackUsed,
    dedupeHit: result.dedupeHit,
    errorMessage: result.error?.message,
  }
  logForDebugging(
    `[SideQuery] ${ev.category} prio=${ev.priority} status=${ev.status} took=${ev.tookMs}ms wait=${ev.queueWaitMs}ms dedupe=${ev.dedupeHit} fallback=${ev.fallbackUsed}${
      ev.errorMessage ? ' err=' + ev.errorMessage : ''
    }`,
  )
  for (const l of listeners) {
    try {
      l(ev)
    } catch {
      // listener 不允许影响主流程
    }
  }
}

/** 累计统计 — 供 /doctor 面板展示 */
class Aggregator {
  private byCategory = new Map<
    SideQueryCategory,
    {
      total: number
      ok: number
      error: number
      fallback: number
      skipped: number
      totalMs: number
    }
  >()

  record(ev: SideQueryTelemetryEvent): void {
    const e = this.byCategory.get(ev.category) ?? {
      total: 0,
      ok: 0,
      error: 0,
      fallback: 0,
      skipped: 0,
      totalMs: 0,
    }
    e.total += 1
    e.totalMs += ev.tookMs
    if (ev.status === 'ok') e.ok += 1
    else if (ev.status === 'error') e.error += 1
    else if (ev.status === 'fallback') e.fallback += 1
    else if (ev.status === 'skipped') e.skipped += 1
    this.byCategory.set(ev.category, e)
  }

  snapshot() {
    return Object.fromEntries(this.byCategory.entries())
  }

  reset(): void {
    this.byCategory.clear()
  }
}

export const sideQueryAggregator = new Aggregator()
onSideQueryEvent(ev => sideQueryAggregator.record(ev))
