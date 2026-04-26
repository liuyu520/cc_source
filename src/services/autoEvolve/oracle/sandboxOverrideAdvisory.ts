/**
 * G8 Step 2.5 (2026-04-26) —— shadow-sandbox override advisory。
 *
 * 动机(v1.0 §6.1 Lock #3):
 *   sandboxFilter.ts 已落 shadow-sandbox-overrides.ndjson ledger(user 翻转 DEFAULT_DENY → allow 的事件),
 *   但 advisor 层缺 Rule 15——没有阈值告警,24h 累积 flip 不会被 /evolve-status 看到。
 *
 * 这里做的:
 *   - 纯读 ledger,tail 最近 N 行(默认 500);
 *   - 24h 窗内按 toolName 聚合 flip 次数;
 *   - kind:
 *       none       → 0 flip,或 ledger 缺失
 *       flip_low   → [1,2] flip(low severity,说明用户显式授权过,提示存在)
 *       flip_medium→ [3,5] flip(medium severity,建议 review 配置)
 *       flip_high  → ≥6 flip(high severity,或单 tool ≥3 flip,疑似 policy 失守)
 *
 * 约束:
 *   - shadow-only:不阻止 user override,只出 advisory;
 *   - fail-open:任何读盘/解析异常一律返回 {kind: 'none'};
 *   - no-op default:ledger 空时 kind='none'(对齐 vetoWindowLedger 风格)。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getShadowSandboxOverrideLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export interface SandboxOverrideStats {
  /** 24h 窗内的 flip 事件总数 */
  total: number
  /** 按 toolName 聚合:{toolName: count},count 为翻转次数 */
  byTool: Record<string, number>
  /** 最后一次 flip 的 timestamp(ISO 字符串);无则 null */
  lastAt: string | null
  /** 最后一次 flip 的 toolName;无则 null */
  lastTool: string | null
  /** 单 tool 最高 flip 次数,用于触发 flip_high */
  maxPerTool: number
}

export type SandboxOverrideAdvisoryKind =
  | 'none'
  | 'flip_low'
  | 'flip_medium'
  | 'flip_high'

export interface SandboxOverrideAdvisory {
  kind: SandboxOverrideAdvisoryKind
  message?: string
  stats: SandboxOverrideStats
  windowLabel: string
}

function emptyStats(): SandboxOverrideStats {
  return {
    total: 0,
    byTool: {},
    lastAt: null,
    lastTool: null,
    maxPerTool: 0,
  }
}

interface LedgerRow {
  at?: string
  toolName?: string
  userDecision?: string
  defaultBaseline?: string
}

function tailLedger(path: string, n: number): LedgerRow[] {
  try {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-n)
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

/**
 * 计算 24h(可覆盖)窗内 flip 统计。
 * @param opts.windowHours 窗口小时数,默认 24
 * @param opts.now 时间锚点(测试注入),默认 Date.now()
 * @param opts.maxRows tail 行数上限,默认 500
 */
export function computeSandboxOverrideStats(opts?: {
  windowHours?: number
  now?: number
  maxRows?: number
}): SandboxOverrideStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 500
  try {
    const path = getShadowSandboxOverrideLedgerPath()
    const rows = tailLedger(path, maxRows)
    if (rows.length === 0) return emptyStats()
    const cutoff = anchor - windowHours * 60 * 60 * 1000
    const stats = emptyStats()
    for (const r of rows) {
      if (!r.toolName || !r.at) continue
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff) continue
      stats.total += 1
      stats.byTool[r.toolName] = (stats.byTool[r.toolName] ?? 0) + 1
      stats.lastAt = r.at
      stats.lastTool = r.toolName
    }
    for (const v of Object.values(stats.byTool)) {
      if (v > stats.maxPerTool) stats.maxPerTool = v
    }
    return stats
  } catch (e) {
    logForDebugging(
      `[sandboxOverrideAdvisory] computeStats failed: ${(e as Error).message}`,
    )
    return emptyStats()
  }
}

export function detectSandboxOverrideAdvisory(opts?: {
  windowHours?: number
  now?: number
  maxRows?: number
}): SandboxOverrideAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  let stats: SandboxOverrideStats
  try {
    stats = computeSandboxOverrideStats(opts)
  } catch (e) {
    logForDebugging(
      `[sandboxOverrideAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      stats: emptyStats(),
      windowLabel,
    }
  }
  if (stats.total === 0) {
    return { kind: 'none', stats, windowLabel }
  }
  // flip_high:总次数 ≥ 6 或单 tool ≥ 3 次
  if (stats.total >= 6 || stats.maxPerTool >= 3) {
    return {
      kind: 'flip_high',
      message:
        `${stats.total} sandbox override(s) in ${windowLabel}; ` +
        `max per tool=${stats.maxPerTool}` +
        (stats.lastTool ? ` (last=${stats.lastTool})` : '') +
        `. Policy may be too permissive — review ~/.claude/shadow-sandbox.json.`,
      stats,
      windowLabel,
    }
  }
  // flip_medium:[3,5] flip
  if (stats.total >= 3) {
    return {
      kind: 'flip_medium',
      message:
        `${stats.total} sandbox override(s) in ${windowLabel}; ` +
        `across ${Object.keys(stats.byTool).length} tool(s). ` +
        `Consider reviewing user sandbox rules.`,
      stats,
      windowLabel,
    }
  }
  // flip_low:[1,2] flip,提示存在,不建议 action
  return {
    kind: 'flip_low',
    message:
      `${stats.total} sandbox override(s) in ${windowLabel}` +
      (stats.lastTool ? ` (last=${stats.lastTool})` : '') +
      `. Observational only.`,
    stats,
    windowLabel,
  }
}
