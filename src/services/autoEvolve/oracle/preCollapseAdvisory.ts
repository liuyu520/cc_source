/**
 * G4 Step 3 (2026-04-26) —— preCollapse advisory (纯只读诊断)。
 *
 * 动机:
 *   Step 2 已在 compact PTL truncateHead 旁路采样 collapse-audit.ndjson
 *   (每次丢弃前把 victim/keep + 风险评分落一条)。Step 3 给 advisor 补一个
 *   消费者,把 "高风险丢弃比例过高 / 最近一次丢弃含高风险 item" 以 advisory
 *   暴露(对称 Rule 10/11/12/15/16/17):
 *
 *     1. high    24h 窗高风险丢弃率 ≥ 0.20 且 victim 总数 ≥ 3
 *     2. medium  24h 窗高风险丢弃率 ≥ 0.10 且 victim 总数 ≥ 3
 *     3. low     最近一次 snapshot highRiskCount ≥ 1(弱提醒)
 *
 *   highRiskRate = totalHighRisk / totalVictims
 *   unknown 不计入高风险(避免冤枉)。
 *
 * 约束:
 *   - 纯读:文件不存在 / 读失败 / 解析失败 → kind='none';
 *   - fail-open:异常全吞;
 *   - 不改 Step 2 ledger 格式,不改 preCollapseAudit 行为。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getCollapseAuditLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type PreCollapseAdvisoryKind = 'none' | 'low' | 'medium' | 'high'
export type PreCollapseAdvisorySeverity = 'low' | 'medium' | 'high'

export interface PreCollapseStats {
  windowHours: number
  totalSnapshots: number
  totalVictims: number
  totalKeeps: number
  totalHighRisk: number
  totalUnknown: number
  highRiskRate: number
  lastSnapshotAt?: string
  lastHighRiskCount: number
  lastDecisionPoint?: string
}

export interface PreCollapseAdvisory {
  kind: PreCollapseAdvisoryKind
  severity: PreCollapseAdvisorySeverity
  message?: string
  stats: PreCollapseStats
  windowLabel: string
}

interface LedgerRow {
  at?: string
  decisionPoint?: string
  victimCount?: number
  keepCount?: number
  highRiskCount?: number
  unknownCount?: number
  scores?: unknown
  meta?: unknown
  pid?: number
}

function emptyStats(windowHours: number): PreCollapseStats {
  return {
    windowHours,
    totalSnapshots: 0,
    totalVictims: 0,
    totalKeeps: 0,
    totalHighRisk: 0,
    totalUnknown: 0,
    highRiskRate: 0,
    lastHighRiskCount: 0,
  }
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
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
export function computePreCollapseStats(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
}): PreCollapseStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 2000
  try {
    const rows = readLedger(getCollapseAuditLedgerPath(), maxRows)
    const cutoff = anchor - windowHours * 3600 * 1000
    let totalVictims = 0
    let totalKeeps = 0
    let totalHighRisk = 0
    let totalUnknown = 0
    let totalSnapshots = 0
    let lastSnapshotAt: string | undefined
    let lastHighRiskCount = 0
    let lastDecisionPoint: string | undefined
    for (const r of rows) {
      if (!r.at) continue
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff) continue
      totalSnapshots++
      totalVictims += numOr0(r.victimCount)
      totalKeeps += numOr0(r.keepCount)
      totalHighRisk += numOr0(r.highRiskCount)
      totalUnknown += numOr0(r.unknownCount)
      // 记录最新 (rows 按时间升序 append)
      lastSnapshotAt = r.at
      lastHighRiskCount = numOr0(r.highRiskCount)
      lastDecisionPoint =
        typeof r.decisionPoint === 'string' ? r.decisionPoint : undefined
    }
    const highRiskRate =
      totalVictims > 0 ? totalHighRisk / totalVictims : 0
    return {
      windowHours,
      totalSnapshots,
      totalVictims,
      totalKeeps,
      totalHighRisk,
      totalUnknown,
      highRiskRate,
      lastSnapshotAt,
      lastHighRiskCount,
      lastDecisionPoint,
    }
  } catch (e) {
    logForDebugging(
      `[preCollapseAdvisory] computeStats failed: ${(e as Error).message}`,
    )
    return emptyStats(windowHours)
  }
}

/**
 * 根据 24h 窗内 collapse-audit 数据产 advisory。
 * 优先级:high > medium > low > none。
 */
export function detectPreCollapseAdvisory(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  /** high 档高风险丢弃率阈值,默认 0.20 */
  highRate?: number
  /** medium 档高风险丢弃率阈值,默认 0.10 */
  mediumRate?: number
  /** 触发 high/medium 所需最少 victim 总数,默认 3 */
  minCount?: number
}): PreCollapseAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  try {
    const stats = computePreCollapseStats({
      now: opts?.now,
      windowHours,
      maxRows: opts?.maxRows,
    })
    const highRate = opts?.highRate ?? 0.2
    const mediumRate = opts?.mediumRate ?? 0.1
    const minCount = opts?.minCount ?? 3

    if (stats.totalSnapshots === 0) {
      return { kind: 'none', severity: 'low', stats, windowLabel }
    }

    if (
      stats.totalVictims >= minCount &&
      stats.highRiskRate >= highRate
    ) {
      return {
        kind: 'high',
        severity: 'high',
        stats,
        windowLabel,
        message:
          `pre-collapse high-risk rate ${(stats.highRiskRate * 100).toFixed(0)}% ` +
          `(${stats.totalHighRisk}/${stats.totalVictims} victims) in ${windowLabel}. ` +
          `Run /collapse-audit to inspect the last drops.`,
      }
    }
    if (
      stats.totalVictims >= minCount &&
      stats.highRiskRate >= mediumRate
    ) {
      return {
        kind: 'medium',
        severity: 'medium',
        stats,
        windowLabel,
        message:
          `pre-collapse high-risk rate ${(stats.highRiskRate * 100).toFixed(0)}% ` +
          `(${stats.totalHighRisk}/${stats.totalVictims} victims) in ${windowLabel}. ` +
          `Review via /collapse-audit.`,
      }
    }
    // low:最新一次 snapshot 里仍有 ≥1 high-risk victim
    if (stats.lastHighRiskCount >= 1) {
      return {
        kind: 'low',
        severity: 'low',
        stats,
        windowLabel,
        message:
          `latest collapse reported ${stats.lastHighRiskCount} high-risk victim(s)` +
          (stats.lastDecisionPoint
            ? ` (${stats.lastDecisionPoint})`
            : '') +
          `. Review via /collapse-audit.`,
      }
    }

    return { kind: 'none', severity: 'low', stats, windowLabel }
  } catch (e) {
    logForDebugging(
      `[preCollapseAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      severity: 'low',
      stats: emptyStats(windowHours),
      windowLabel,
    }
  }
}
