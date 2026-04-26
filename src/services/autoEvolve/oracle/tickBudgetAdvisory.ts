/**
 * G10 Step 2 (2026-04-26) —— tick budget advisory (纯只读诊断)。
 *
 * 动机:
 *   Step 1 已持续收集 periodicMaintenance runTick 的耗时/成败样本到
 *   `oracle/tick-budget.ndjson`。Step 2 给 advisor 补一个消费者,把三类
 *   "tick 健康异常" 以 advisory 的形式暴露出来(与 Rule 10/11/12/15 对称):
 *
 *     1. slow         任一 task 的 24h p95 >= slowP95Ms (默认 5000ms)
 *     2. error_burst  任一 task 24h errorRate >= errorRateMin (默认 0.3) 且 count >= 3
 *     3. chronic      任一 task 最近 N(=5) 条 outcome 全为 error (连续错误簇)
 *
 * 约束:
 *   - shadow-only 读取:读失败/文件不存在全都返回 none;
 *   - fail-open:异常全吞,调用方不受影响;
 *   - 不改 Step 1 ledger 格式,不改 runTick 行为,不引入写操作。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getTickBudgetLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type TickBudgetAdvisoryKind =
  | 'none'
  | 'slow'
  | 'error_burst'
  | 'chronic'

export type TickBudgetAdvisorySeverity = 'low' | 'medium' | 'high'

export interface TickBudgetTaskStats {
  taskName: string
  count: number
  successCount: number
  errorCount: number
  skippedCount: number
  totalDurationMs: number
  p95DurationMs: number
  avgDurationMs: number
  errorRate: number
  lastOutcome?: string
  lastErrorStreak: number
}

export interface TickBudgetStats {
  windowHours: number
  totalSamples: number
  byTask: Record<string, TickBudgetTaskStats>
}

export interface TickBudgetAdvisory {
  kind: TickBudgetAdvisoryKind
  severity: TickBudgetAdvisorySeverity
  message?: string
  stats: TickBudgetStats
  /** 触发此 advisory 的 task 名 —— none 时为 undefined */
  offendingTask?: string
  windowLabel: string
}

interface LedgerRow {
  at?: string
  taskName?: string
  durationMs?: number
  outcome?: 'success' | 'error' | 'skipped'
  errorMessage?: string
  tickCount?: number
  intervalMs?: number
  pid?: number
}

function emptyStats(windowHours: number): TickBudgetStats {
  return { windowHours, totalSamples: 0, byTask: {} }
}

function readLedger(path: string, maxRows: number): LedgerRow[] {
  try {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-maxRows)
    const out: LedgerRow[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip 损坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 单独暴露便于 probe / 外部工具直接调 */
export function computeTickBudgetStats(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
}): TickBudgetStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 2000
  try {
    const rows = readLedger(getTickBudgetLedgerPath(), maxRows)
    const cutoff = anchor - windowHours * 3600 * 1000
    const buckets = new Map<
      string,
      {
        durations: number[]
        successCount: number
        errorCount: number
        skippedCount: number
        lastOutcome?: string
        /** 最近一串连续 error 计数(逆序扫): */
        lastErrorStreak: number
        /** 标记:一旦遇到非 error 就停止累加 streak */
        streakLocked: boolean
        rowsInWindow: LedgerRow[]
      }
    >()
    const inWindow: LedgerRow[] = []
    for (const r of rows) {
      if (!r.at || !r.taskName) continue
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff) continue
      inWindow.push(r)
    }
    // 按时间正序遍历,记录 last outcome;然后再从尾部扫连续 error streak
    for (const r of inWindow) {
      const name = r.taskName!
      let b = buckets.get(name)
      if (!b) {
        b = {
          durations: [],
          successCount: 0,
          errorCount: 0,
          skippedCount: 0,
          lastErrorStreak: 0,
          streakLocked: false,
          rowsInWindow: [],
        }
        buckets.set(name, b)
      }
      const dur = Number.isFinite(r.durationMs) && r.durationMs! >= 0 ? r.durationMs! : 0
      if (r.outcome === 'success') {
        b.successCount++
        b.durations.push(dur)
      } else if (r.outcome === 'error') {
        b.errorCount++
        b.durations.push(dur)
      } else if (r.outcome === 'skipped') {
        b.skippedCount++
      }
      b.lastOutcome = r.outcome
      b.rowsInWindow.push(r)
    }
    // 第二遍:每个 bucket 从尾部扫连续 error
    for (const [, b] of buckets) {
      for (let i = b.rowsInWindow.length - 1; i >= 0; i--) {
        const o = b.rowsInWindow[i]!.outcome
        if (o === 'error') b.lastErrorStreak++
        else break
      }
    }

    const byTask: Record<string, TickBudgetTaskStats> = {}
    for (const [name, b] of buckets) {
      const count = b.successCount + b.errorCount + b.skippedCount
      const total = b.durations.reduce((a, v) => a + v, 0)
      const avg = b.durations.length > 0 ? total / b.durations.length : 0
      const denom = b.successCount + b.errorCount
      const errRate = denom > 0 ? b.errorCount / denom : 0
      byTask[name] = {
        taskName: name,
        count,
        successCount: b.successCount,
        errorCount: b.errorCount,
        skippedCount: b.skippedCount,
        totalDurationMs: total,
        p95DurationMs: p95(b.durations),
        avgDurationMs: avg,
        errorRate: errRate,
        lastOutcome: b.lastOutcome,
        lastErrorStreak: b.lastErrorStreak,
      }
    }
    return {
      windowHours,
      totalSamples: inWindow.length,
      byTask,
    }
  } catch (e) {
    logForDebugging(`[tickBudgetAdvisory] computeStats failed: ${(e as Error).message}`)
    return emptyStats(windowHours)
  }
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.floor(s.length * 0.95)
  return s[Math.min(idx, s.length - 1)] ?? 0
}

/**
 * 根据 24h 窗内 tick 数据产 advisory。
 * 优先级:chronic > error_burst > slow > none。任一触发即返回该档(不叠加)。
 */
export function detectTickBudgetAdvisory(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  /** slow 的 p95 阈值(ms),默认 5000 */
  slowP95Ms?: number
  /** error_burst 的 errorRate 阈值,默认 0.3 */
  errorRateMin?: number
  /** error_burst 至少 total(success+error) 数,默认 3 */
  errorBurstMinCount?: number
  /** chronic:连续 error streak 触发阈值,默认 3 */
  chronicStreakMin?: number
}): TickBudgetAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  try {
    const stats = computeTickBudgetStats({
      now: opts?.now,
      windowHours,
      maxRows: opts?.maxRows,
    })
    const slowMs = opts?.slowP95Ms ?? 5000
    const errRateMin = opts?.errorRateMin ?? 0.3
    const errBurstMin = opts?.errorBurstMinCount ?? 3
    const chronicMin = opts?.chronicStreakMin ?? 3

    if (stats.totalSamples === 0) {
      return { kind: 'none', severity: 'low', stats, windowLabel }
    }

    // 1. chronic —— 最严重,直接返回 high
    const chronic = Object.values(stats.byTask).find(
      t => t.lastErrorStreak >= chronicMin,
    )
    if (chronic) {
      return {
        kind: 'chronic',
        severity: 'high',
        offendingTask: chronic.taskName,
        message:
          `tick '${chronic.taskName}' had ${chronic.lastErrorStreak} consecutive errors ` +
          `in ${windowLabel}. Investigate root cause via /tick-budget.`,
        stats,
        windowLabel,
      }
    }

    // 2. error_burst —— medium / high 依 count
    const burstCandidates = Object.values(stats.byTask).filter(
      t =>
        t.errorRate >= errRateMin &&
        t.successCount + t.errorCount >= errBurstMin,
    )
    if (burstCandidates.length > 0) {
      // 取最坏的(errorRate 最大,然后 errorCount 最大)
      burstCandidates.sort((a, b) => {
        if (b.errorRate !== a.errorRate) return b.errorRate - a.errorRate
        return b.errorCount - a.errorCount
      })
      const worst = burstCandidates[0]!
      const severity: TickBudgetAdvisorySeverity =
        worst.errorCount >= 5 ? 'high' : 'medium'
      return {
        kind: 'error_burst',
        severity,
        offendingTask: worst.taskName,
        message:
          `tick '${worst.taskName}' errorRate=${(worst.errorRate * 100).toFixed(0)}% ` +
          `(${worst.errorCount}/${worst.successCount + worst.errorCount}) in ${windowLabel}. ` +
          `Run /tick-budget to drill down.`,
        stats,
        windowLabel,
      }
    }

    // 3. slow —— low / medium 依 p95 相对 slowMs 倍数
    const slowCandidates = Object.values(stats.byTask).filter(
      t => t.p95DurationMs >= slowMs,
    )
    if (slowCandidates.length > 0) {
      slowCandidates.sort((a, b) => b.p95DurationMs - a.p95DurationMs)
      const worst = slowCandidates[0]!
      const severity: TickBudgetAdvisorySeverity =
        worst.p95DurationMs >= slowMs * 3 ? 'medium' : 'low'
      return {
        kind: 'slow',
        severity,
        offendingTask: worst.taskName,
        message:
          `tick '${worst.taskName}' p95=${Math.round(worst.p95DurationMs)}ms ` +
          `(>= ${slowMs}ms) in ${windowLabel}. Consider pushing heavy work off the tick.`,
        stats,
        windowLabel,
      }
    }

    return { kind: 'none', severity: 'low', stats, windowLabel }
  } catch (e) {
    logForDebugging(
      `[tickBudgetAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      severity: 'low',
      stats: emptyStats(windowHours),
      windowLabel,
    }
  }
}
