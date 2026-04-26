/**
 * SideQueryScheduler — 统一侧查询调度器（P0-1 核心）。
 *
 * 职责：
 *   1. 去重：同 dedupeKey 正在执行的任务复用同一个 Promise
 *   2. 预算检查：P2/P3 超预算直接 skip
 *   3. 熔断检查：熔断打开时走 fallback
 *   4. 优先级队列 + 并发控制（blocking=2, background=1）
 *   5. 超时与 AbortSignal 支持
 *   6. 统一埋点
 *
 * 实现选择：优先级 + 并发槽位用 "按优先级的 semaphore" 而非单一 PriorityQueue，
 * 这样阻塞型任务永远不会被后台任务的并发槽位挤压。
 */

import { randomUUID } from 'crypto'
import { BudgetGuard } from './budget.js'
import { CircuitBreaker } from './circuitBreaker.js'
import { emitSideQueryEvent } from './telemetry.js'
import type {
  SideQueryCategory,
  SideQueryPriority,
  SideQueryResult,
  SideQueryStatus,
  SideQueryTask,
} from './types.js'

interface Slot {
  max: number
  inflight: number
  waiters: Array<() => void>
}

const DEFAULT_TIMEOUT_MS = 15_000

class SideQueryScheduler {
  private budget = new BudgetGuard()
  private breakers = new Map<SideQueryCategory, CircuitBreaker>()
  private inflightByDedupe = new Map<string, Promise<SideQueryResult<unknown>>>()

  /**
   * 双槽位：阻塞型(P0/P1)与后台型(P2/P3)相互隔离。
   * 保证后台任务洪水不会饿死阻塞型任务。
   */
  private blockingSlot: Slot = { max: 2, inflight: 0, waiters: [] }
  private backgroundSlot: Slot = { max: 1, inflight: 0, waiters: [] }

  /** 主入口 */
  async submit<T>(task: SideQueryTask<T>): Promise<SideQueryResult<T>> {
    const taskId = task.id ?? randomUUID()
    let normalized: SideQueryTask<T> = { ...task, id: taskId }
    const submittedAt = Date.now()

    // Phase E+ · hunger/regret-aware SideQuery 调度。
    // 默认只在 shadow 中体现在 admission;显式 SIDE_QUERY opt-in 后才调整 P2/P3 优先级。
    try {
      const contextSignals = await import('../contextSignals/index.js')
      if (contextSignals.isSideQueryAdmissionExecutionEnabled()) {
        const snap = contextSignals.getContextSignalsSnapshot()
        const economics = contextSignals.computeSourceEconomics(snap)
        const memoryBias = economics.find(e => e.kind === 'auto-memory')?.bias ?? 0
        const sideBias = economics.find(e => e.kind === 'side-query')?.bias ?? 0
        if (
          memoryBias === 1
          && (normalized.category === 'memory_recall' || normalized.category === 'context_rehydrate')
          && (normalized.priority === 'P2_method' || normalized.priority === 'P3_background')
        ) {
          normalized = { ...normalized, priority: 'P1_quality' }
        } else if (sideBias === -1 && normalized.priority === 'P2_method') {
          normalized = { ...normalized, priority: 'P3_background' }
        }
      }
    } catch { /* priority 调节 best-effort,失败保持原任务 */ }

    // 1. dedupe
    if (normalized.dedupeKey) {
      const cached = this.inflightByDedupe.get(normalized.dedupeKey)
      if (cached) {
        const res = (await cached) as SideQueryResult<T>
        return { ...res, dedupeHit: true }
      }
    }

    // Phase E · ContextAdmissionController 把 SideQuery 纳入上下文供应链。
    // 默认只记录 shadow;显式 opt-in 时只允许跳过 P2/P3,不影响阻塞/质量查询。
    try {
      const contextSignals = await import('../contextSignals/index.js')
      const estimatedTokens = normalized.estimatedTokens ?? this.defaultEstimatedTokens(normalized.priority)
      const sideQueryContextItemId = `side-query:${normalized.category}:${normalized.dedupeKey ?? taskId}`
      const admission = contextSignals.evaluateContextAdmission({
        kind: 'side-query',
        contextItemId: sideQueryContextItemId,
        decisionPoint: 'SideQueryScheduler.submit',
        estimatedTokens,
        currentLevel: normalized.priority === 'P3_background' ? 'index' : 'summary',
        cacheClass: 'volatile',
        anchors: [normalized.category, normalized.priority],
        meta: { category: normalized.category, priority: normalized.priority },
      })
      contextSignals.recordContextItemRoiEvent({
        contextItemId: sideQueryContextItemId,
        kind: 'side-query',
        anchors: [normalized.category, normalized.priority],
        decisionPoint: 'SideQueryScheduler.submit',
        admission: admission.decision,
        outcome: 'served',
      })
      contextSignals.recordSignalServed({
        kind: 'side-query',
        decisionPoint: 'SideQueryScheduler.submit',
        tokens: estimatedTokens,
        itemCount: 1,
        level: normalized.priority === 'P3_background' ? 'index' : 'summary',
        anchors: [normalized.category, normalized.priority],
        meta: { category: normalized.category, priority: normalized.priority },
      })
      if (
        contextSignals.isSideQueryAdmissionExecutionEnabled()
        && admission.decision === 'skip'
        && (normalized.priority === 'P2_method' || normalized.priority === 'P3_background')
      ) {
        const result = this.buildResult<T>({
          status: 'skipped',
          tookMs: 0,
          queueWaitMs: 0,
        })
        contextSignals.recordContextItemRoiEvent({
          contextItemId: sideQueryContextItemId,
          kind: 'side-query',
          anchors: [normalized.category, normalized.priority],
          decisionPoint: 'SideQueryScheduler.submit',
          admission: admission.decision,
          outcome: 'unused',
        })
        emitSideQueryEvent(normalized, result)
        return result
      }
    } catch { /* context admission best-effort, 不影响 sideQuery 主链路 */ }

    // 2. budget
    if (!this.budget.allow(normalized)) {
      const result = this.buildResult<T>({
        status: 'skipped',
        tookMs: 0,
        queueWaitMs: 0,
      })
      emitSideQueryEvent(normalized, result)
      return result
    }

    // 3. circuit breaker
    const breaker = this.getBreaker(normalized.category)
    const breakerOpen = !breaker.allow()
    if (breakerOpen) {
      const result = await this.runFallback(normalized, {
        circuitBreakerOpen: true,
        queueWaitMs: 0,
      })
      emitSideQueryEvent(normalized, result)
      return result
    }

    // 4. 并发槽位 + 执行
    const promise = (async (): Promise<SideQueryResult<T>> => {
      const slot = this.pickSlot(normalized.priority)
      await this.acquire(slot)
      const queueWaitMs = Date.now() - submittedAt
      try {
        const result = await this.runWithTimeout(normalized, queueWaitMs)
        if (result.status === 'ok') {
          breaker.recordSuccess()
          this.budget.charge(normalized)
        } else if (result.status === 'error') {
          breaker.recordFailure()
        }
        try {
          const contextSignals = await import('../contextSignals/index.js')
          const sideQueryContextItemId = `side-query:${normalized.category}:${normalized.dedupeKey ?? taskId}`
          const valuePreview = typeof result.value === 'string'
            ? result.value.slice(0, 512)
            : result.value == null
              ? ''
              : JSON.stringify(result.value).slice(0, 512)
          const resultTokens = Math.ceil(valuePreview.length / 4)
          const resultAdmission = contextSignals.evaluateContextAdmission({
            kind: 'side-query',
            contextItemId: `${sideQueryContextItemId}:result`,
            decisionPoint: 'SideQueryScheduler.result',
            estimatedTokens: resultTokens,
            currentLevel: normalized.priority === 'P3_background' ? 'index' : 'summary',
            cacheClass: 'volatile',
            anchors: [normalized.category, normalized.priority, result.status],
            meta: { category: normalized.category, priority: normalized.priority, status: result.status },
          })
          contextSignals.recordContextItemRoiEvent({
            contextItemId: sideQueryContextItemId,
            kind: 'side-query',
            anchors: [normalized.category, normalized.priority],
            decisionPoint: 'SideQueryScheduler.runWithTimeout',
            admission: resultAdmission.decision,
            outcome: result.status === 'ok' ? 'used' : 'unused',
          })
          contextSignals.recordEvidenceEdge({
            from: sideQueryContextItemId,
            to: result.status,
            fromKind: 'source',
            toKind: 'outcome',
            relation: 'completed-as',
            contextItemId: sideQueryContextItemId,
            sourceKind: 'side-query',
          })
          contextSignals.recordEvidenceEdge({
            from: `${sideQueryContextItemId}:result`,
            to: sideQueryContextItemId,
            fromKind: 'source',
            toKind: 'entity',
            relation: 'result-of',
            contextItemId: `${sideQueryContextItemId}:result`,
            sourceKind: 'side-query',
          })
        } catch { /* ROI/Evidence 失败不影响 sideQuery */ }
        emitSideQueryEvent(normalized, result)
        return result
      } finally {
        this.release(slot)
      }
    })()

    if (normalized.dedupeKey) {
      this.inflightByDedupe.set(
        normalized.dedupeKey,
        promise as Promise<SideQueryResult<unknown>>,
      )
      promise.finally(() => {
        if (normalized.dedupeKey)
          this.inflightByDedupe.delete(normalized.dedupeKey)
      })
    }
    return promise
  }

  private async runWithTimeout<T>(
    task: SideQueryTask<T>,
    queueWaitMs: number,
  ): Promise<SideQueryResult<T>> {
    const started = Date.now()
    const controller = new AbortController()
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const value = await task.run(controller.signal)
      return this.buildResult<T>({
        status: 'ok',
        value,
        tookMs: Date.now() - started,
        queueWaitMs,
      })
    } catch (err) {
      const aborted = controller.signal.aborted
      if (task.fallback) {
        // 主路径失败 → 尝试本地 fallback，仍记录失败（供熔断计数）
        const fallbackResult = await this.runFallback(task, { queueWaitMs })
        return { ...fallbackResult, tookMs: Date.now() - started }
      }
      return this.buildResult<T>({
        status: aborted ? 'aborted' : 'error',
        error: err as Error,
        tookMs: Date.now() - started,
        queueWaitMs,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async runFallback<T>(
    task: SideQueryTask<T>,
    meta: { circuitBreakerOpen?: boolean; queueWaitMs: number },
  ): Promise<SideQueryResult<T>> {
    if (!task.fallback) {
      return this.buildResult<T>({
        status: 'skipped',
        tookMs: 0,
        queueWaitMs: meta.queueWaitMs,
        circuitBreakerOpen: meta.circuitBreakerOpen,
      })
    }
    const started = Date.now()
    try {
      const value = await task.fallback()
      return this.buildResult<T>({
        status: 'fallback',
        value,
        tookMs: Date.now() - started,
        queueWaitMs: meta.queueWaitMs,
        fallbackUsed: true,
        circuitBreakerOpen: meta.circuitBreakerOpen,
      })
    } catch (err) {
      return this.buildResult<T>({
        status: 'error',
        error: err as Error,
        tookMs: Date.now() - started,
        queueWaitMs: meta.queueWaitMs,
        fallbackUsed: true,
        circuitBreakerOpen: meta.circuitBreakerOpen,
      })
    }
  }

  private defaultEstimatedTokens(priority: SideQueryPriority): number {
    if (priority === 'P0_blocking') return 500
    if (priority === 'P1_quality') return 2000
    if (priority === 'P2_method') return 2000
    return 5000
  }

  private buildResult<T>(partial: {
    status: SideQueryStatus
    value?: T
    error?: Error
    tookMs: number
    queueWaitMs: number
    circuitBreakerOpen?: boolean
    fallbackUsed?: boolean
  }): SideQueryResult<T> {
    return {
      status: partial.status,
      value: partial.value,
      error: partial.error,
      tookMs: partial.tookMs,
      queueWaitMs: partial.queueWaitMs,
      dedupeHit: false,
      circuitBreakerOpen: partial.circuitBreakerOpen ?? false,
      fallbackUsed: partial.fallbackUsed ?? false,
    }
  }

  private pickSlot(priority: SideQueryPriority): Slot {
    return priority === 'P0_blocking' || priority === 'P1_quality'
      ? this.blockingSlot
      : this.backgroundSlot
  }

  private acquire(slot: Slot): Promise<void> {
    if (slot.inflight < slot.max) {
      slot.inflight += 1
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      slot.waiters.push(() => {
        slot.inflight += 1
        resolve()
      })
    })
  }

  private release(slot: Slot): void {
    slot.inflight -= 1
    const next = slot.waiters.shift()
    if (next) next()
  }

  private getBreaker(category: SideQueryCategory): CircuitBreaker {
    let b = this.breakers.get(category)
    if (!b) {
      b = new CircuitBreaker()
      this.breakers.set(category, b)
    }
    return b
  }

  /** 诊断：当前槽位与熔断快照 */
  snapshot() {
    return {
      budget: this.budget.snapshot(),
      blocking: { max: this.blockingSlot.max, inflight: this.blockingSlot.inflight },
      background: {
        max: this.backgroundSlot.max,
        inflight: this.backgroundSlot.inflight,
      },
      breakers: Object.fromEntries(
        Array.from(this.breakers.entries()).map(([k, v]) => [k, v.getState()]),
      ),
    }
  }
}

export const sideQueryScheduler = new SideQueryScheduler()
