/**
 * G1 Step 3 (2026-04-26) —— plan-fidelity advisory (纯只读诊断)。
 *
 * 动机:
 *   Step 2 已在 ExitPlanMode 成功路径旁路采样,把每次 plan↔artifact 核对
 *   结果落 `oracle/plan-fidelity.ndjson`。Step 3 给 advisor 补一个消费者,
 *   把 "mismatch 率异常" 以 advisory 暴露(与 Rule 10/11/12/15/16 对称):
 *
 *     1. high    24h mismatchRate >= highRate  (默认 0.30) 且 sampleCount >= minCount
 *     2. medium  24h mismatchRate >= mediumRate(默认 0.15) 且 sampleCount >= minCount
 *     3. low     最近一次 snapshot mismatched >= 1(弱提醒)
 *
 *   mismatchRate = mismatched / (matched + mismatched)
 *   undetermined 不计入分母(无法核验的条目不误判)。
 *
 * 约束:
 *   - 纯读:文件不存在 / 读失败 / 解析失败 → kind='none';
 *   - fail-open:异常全吞;
 *   - 不改 Step 2 ledger 格式,不改 recordPlanFidelitySnapshot 行为。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getPlanFidelityLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type PlanFidelityAdvisoryKind = 'none' | 'low' | 'medium' | 'high'
export type PlanFidelityAdvisorySeverity = 'low' | 'medium' | 'high'

export interface PlanFidelityStats {
  windowHours: number
  totalSnapshots: number
  totalItems: number
  matched: number
  mismatched: number
  undetermined: number
  mismatchRate: number
  lastSnapshotAt?: string
  lastMismatched: number
  lastPhase?: string
}

export interface PlanFidelityAdvisory {
  kind: PlanFidelityAdvisoryKind
  severity: PlanFidelityAdvisorySeverity
  message?: string
  stats: PlanFidelityStats
  windowLabel: string
}

interface LedgerRow {
  at?: string
  phase?: string
  planPath?: string
  total?: number
  matched?: number
  mismatched?: number
  undetermined?: number
  sample?: unknown
  pid?: number
}

function emptyStats(windowHours: number): PlanFidelityStats {
  return {
    windowHours,
    totalSnapshots: 0,
    totalItems: 0,
    matched: 0,
    mismatched: 0,
    undetermined: 0,
    mismatchRate: 0,
    lastMismatched: 0,
  }
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

/** 便于 probe / 外部工具直调 */
export function computePlanFidelityStats(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
}): PlanFidelityStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 2000
  try {
    const rows = readLedger(getPlanFidelityLedgerPath(), maxRows)
    const cutoff = anchor - windowHours * 3600 * 1000
    let matched = 0
    let mismatched = 0
    let undetermined = 0
    let totalItems = 0
    let totalSnapshots = 0
    let lastSnapshotAt: string | undefined
    let lastMismatched = 0
    let lastPhase: string | undefined
    for (const r of rows) {
      if (!r.at) continue
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff) continue
      totalSnapshots++
      matched += numOr0(r.matched)
      mismatched += numOr0(r.mismatched)
      undetermined += numOr0(r.undetermined)
      totalItems += numOr0(r.total)
      // 记录最新(rows 按时间升序 append)
      lastSnapshotAt = r.at
      lastMismatched = numOr0(r.mismatched)
      lastPhase = typeof r.phase === 'string' ? r.phase : undefined
    }
    const denom = matched + mismatched
    const mismatchRate = denom > 0 ? mismatched / denom : 0
    return {
      windowHours,
      totalSnapshots,
      totalItems,
      matched,
      mismatched,
      undetermined,
      mismatchRate,
      lastSnapshotAt,
      lastMismatched,
      lastPhase,
    }
  } catch (e) {
    logForDebugging(
      `[planFidelityAdvisory] computeStats failed: ${(e as Error).message}`,
    )
    return emptyStats(windowHours)
  }
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/**
 * 根据 24h 窗内 plan-fidelity 数据产 advisory。
 * 优先级:high > medium > low > none。
 */
export function detectPlanFidelityAdvisory(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  /** high 档 mismatchRate 阈值,默认 0.3 */
  highRate?: number
  /** medium 档 mismatchRate 阈值,默认 0.15 */
  mediumRate?: number
  /** 触发 high/medium 所需最少核验条目数(matched+mismatched),默认 3 */
  minCount?: number
}): PlanFidelityAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  try {
    const stats = computePlanFidelityStats({
      now: opts?.now,
      windowHours,
      maxRows: opts?.maxRows,
    })
    const highRate = opts?.highRate ?? 0.3
    const mediumRate = opts?.mediumRate ?? 0.15
    const minCount = opts?.minCount ?? 3

    if (stats.totalSnapshots === 0) {
      return { kind: 'none', severity: 'low', stats, windowLabel }
    }

    const denom = stats.matched + stats.mismatched
    if (denom >= minCount && stats.mismatchRate >= highRate) {
      return {
        kind: 'high',
        severity: 'high',
        stats,
        windowLabel,
        message:
          `plan-fidelity mismatch rate ${(stats.mismatchRate * 100).toFixed(0)}% ` +
          `(${stats.mismatched}/${denom}) in ${windowLabel}. ` +
          `Run /plan-check to audit the latest plan claims.`,
      }
    }
    if (denom >= minCount && stats.mismatchRate >= mediumRate) {
      return {
        kind: 'medium',
        severity: 'medium',
        stats,
        windowLabel,
        message:
          `plan-fidelity mismatch rate ${(stats.mismatchRate * 100).toFixed(0)}% ` +
          `(${stats.mismatched}/${denom}) in ${windowLabel}. ` +
          `Consider reviewing plan artifacts via /plan-check.`,
      }
    }
    // low:最新一次 snapshot 里仍有至少一个 mismatch — 弱提示
    if (stats.lastMismatched >= 1) {
      return {
        kind: 'low',
        severity: 'low',
        stats,
        windowLabel,
        message:
          `latest plan snapshot reported ${stats.lastMismatched} mismatched item(s)` +
          (stats.lastPhase ? ` (phase=${stats.lastPhase})` : '') +
          `. Review via /plan-check.`,
      }
    }

    return { kind: 'none', severity: 'low', stats, windowLabel }
  } catch (e) {
    logForDebugging(
      `[planFidelityAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      severity: 'low',
      stats: emptyStats(windowHours),
      windowLabel,
    }
  }
}
