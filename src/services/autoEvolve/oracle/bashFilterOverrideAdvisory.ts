/**
 * G8 Step 3(2026-04-26)—— bashFilter override advisory detector。
 *
 * 纯只读:
 *   - 读 `oracle/bash-filter-override.ndjson`(ledger 写入方在
 *     `src/tools/BashTool/bashPermissions.ts#maybeAuditBashAllowOverride`);
 *   - 按 windowHours (默认 24) 聚合 total / byPrefix / bySource;
 *   - 三档阈值对齐 G8 Step 2 sandboxOverrideAdvisory
 *     (none / flip_low / flip_medium / flip_high);
 *   - fail-open:任何异常退回 kind='none',外层 advisor 继续跑。
 *
 * 与 advisor Rule 15 (sandbox.override.*) 对称,由新的
 * Rule (bash.filter.override.*) 消费。
 */

import { readFileSync } from 'node:fs'

import { getBashFilterOverrideLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type BashFilterOverrideAdvisoryKind =
  | 'none'
  | 'flip_low'
  | 'flip_medium'
  | 'flip_high'

export interface BashFilterOverrideStats {
  windowHours: number
  total: number
  /** 聚合:规则 prefix → 次数 */
  byPrefix: Record<string, number>
  /** 聚合:规则来源(userSettings/projectSettings/…) → 次数 */
  bySource: Record<string, number>
  lastPrefix?: string
  lastSource?: string
  lastAt?: string
}

export interface BashFilterOverrideAdvisory {
  kind: BashFilterOverrideAdvisoryKind
  message?: string
  stats: BashFilterOverrideStats
  windowLabel: string
}

interface LedgerRow {
  at: string
  commandPrefix?: string
  commandSample?: string
  ruleSource?: string
  ruleBehavior?: string
  pid?: number
}

function emptyStats(windowHours: number): BashFilterOverrideStats {
  return {
    windowHours,
    total: 0,
    byPrefix: {},
    bySource: {},
  }
}

function tailLedger(path: string, n: number): LedgerRow[] {
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-n)
    const out: LedgerRow[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as LedgerRow
        if (obj && typeof obj.at === 'string') out.push(obj)
      } catch {
        /* skip malformed line */
      }
    }
    return out
  } catch {
    return []
  }
}

export function computeBashFilterOverrideStats(opts?: {
  windowHours?: number
  maxRows?: number
  now?: number
}): BashFilterOverrideStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 500
  try {
    const path = getBashFilterOverrideLedgerPath()
    const rows = tailLedger(path, maxRows)
    const cutoff = anchor - windowHours * 60 * 60 * 1000
    const stats = emptyStats(windowHours)
    for (const r of rows) {
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff) continue
      stats.total += 1
      const prefix = r.commandPrefix ?? '(no-prefix)'
      const source = r.ruleSource ?? 'unknown'
      stats.byPrefix[prefix] = (stats.byPrefix[prefix] ?? 0) + 1
      stats.bySource[source] = (stats.bySource[source] ?? 0) + 1
      stats.lastPrefix = prefix
      stats.lastSource = source
      stats.lastAt = r.at
    }
    return stats
  } catch (e) {
    logForDebugging(
      `[bashFilterOverrideAdvisory] computeStats failed: ${(e as Error).message}`,
    )
    return emptyStats(windowHours)
  }
}

export function detectBashFilterOverrideAdvisory(opts?: {
  windowHours?: number
}): BashFilterOverrideAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  let stats: BashFilterOverrideStats
  try {
    stats = computeBashFilterOverrideStats({ windowHours })
  } catch (e) {
    logForDebugging(
      `[bashFilterOverrideAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      stats: emptyStats(windowHours),
      windowLabel,
    }
  }

  if (stats.total <= 0) {
    return { kind: 'none', stats, windowLabel }
  }
  // 对齐 sandbox advisor 三档:
  //   flip_high   ≥6  (或 ≥3 个不同 prefix & ≥4)
  //   flip_medium ≥3
  //   flip_low    ≥1
  const distinctPrefixes = Object.keys(stats.byPrefix).length
  if (stats.total >= 6 || (distinctPrefixes >= 3 && stats.total >= 4)) {
    return {
      kind: 'flip_high',
      message:
        `${stats.total} bash allow-rule override(s) in ${windowLabel}` +
        ` across ${distinctPrefixes} prefix(es)` +
        (stats.lastPrefix ? ` · last='${stats.lastPrefix}'` : '') +
        `. Audit user bash allow rules — consider tightening scope.`,
      stats,
      windowLabel,
    }
  }
  if (stats.total >= 3) {
    return {
      kind: 'flip_medium',
      message:
        `${stats.total} bash allow-rule override(s) in ${windowLabel}` +
        ` across ${distinctPrefixes} prefix(es). ` +
        `Review whether these user rules are still needed.`,
      stats,
      windowLabel,
    }
  }
  return {
    kind: 'flip_low',
    message:
      `${stats.total} bash allow-rule override(s) in ${windowLabel}` +
      (stats.lastPrefix ? ` (last='${stats.lastPrefix}')` : '') +
      `. Observational only.`,
    stats,
    windowLabel,
  }
}
