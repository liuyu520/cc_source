/**
 * G3 Step 1 (2026-04-26) —— /tool-bandit 只读命令。
 *
 * 用途:查看 tool bandit shadow reward ledger 聚合 —— 每个 tool 的
 * count / totalReward / avgReward / avgDuration / p95Duration / successRate /
 * lastAt,按 totalReward 降序展示 top 20。
 *
 * 这仍是纯观察:**不**对外暴露 policy 建议、**不**改 tool 选择,只做数据面板。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /tool-bandit                     show 24h aggregate + recent 30
  /tool-bandit --recent N          tail last N events (1..500, default 30)
  /tool-bandit --window H          aggregate window hours (1..168, default 24)
  /tool-bandit --json              emit JSON
  /tool-bandit --help              this message
`

interface ParsedFlags {
  recent: number
  window: number
  json: boolean
  help: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let recent = 30
  let window = 24
  let json = false
  let help = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      help = true
      continue
    }
    if (t === '--json') {
      json = true
      continue
    }
    if (t === '--recent') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return { recent, window, json, help, error: `--recent must be 1..500\n${USAGE}` }
      }
      recent = n
      continue
    }
    if (t === '--window') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 168) {
        return { recent, window, json, help, error: `--window must be 1..168\n${USAGE}` }
      }
      window = n
      continue
    }
    return { recent, window, json, help, error: `unknown flag: ${t}\n${USAGE}` }
  }
  return { recent, window, json, help }
}

interface RewardRow {
  at?: string
  toolName?: string
  outcome?: 'success' | 'error' | 'abort'
  durationMs?: number
  reward?: number
  pid?: number
}

function tailNdjson(path: string, n: number): RewardRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: RewardRow[] = []
    for (const line of tail) {
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

function readAllRecent(path: string, withinMs: number): RewardRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const cutoff = Date.now() - withinMs
    const out: RewardRow[] = []
    for (const line of lines) {
      try {
        const row: RewardRow = JSON.parse(line)
        const t = row.at ? Date.parse(row.at) : 0
        if (t && t >= cutoff) out.push(row)
      } catch {
        /* skip */
      }
    }
    return out
  } catch {
    return []
  }
}

interface ToolAggregate {
  toolName: string
  count: number
  success: number
  error: number
  abort: number
  totalReward: number
  totalDuration: number
  durations: number[]
  lastAt?: string
}

function aggregate(rows: RewardRow[]): ToolAggregate[] {
  const buckets = new Map<string, ToolAggregate>()
  for (const r of rows) {
    const name = r.toolName ?? '(unknown)'
    let b = buckets.get(name)
    if (!b) {
      b = {
        toolName: name,
        count: 0,
        success: 0,
        error: 0,
        abort: 0,
        totalReward: 0,
        totalDuration: 0,
        durations: [],
      }
      buckets.set(name, b)
    }
    b.count++
    if (r.outcome === 'success') b.success++
    else if (r.outcome === 'error') b.error++
    else if (r.outcome === 'abort') b.abort++
    if (Number.isFinite(r.reward)) b.totalReward += r.reward!
    if (Number.isFinite(r.durationMs) && r.durationMs! >= 0) {
      b.totalDuration += r.durationMs!
      b.durations.push(r.durationMs!)
    }
    if (!b.lastAt || (r.at && r.at > b.lastAt)) b.lastAt = r.at
  }
  return [...buckets.values()]
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.95)
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0
}

function call(args: string): LocalCommandCall {
  const parsed = parseFlags(args)
  if (parsed.help) return { type: 'text', value: USAGE }
  if (parsed.error) return { type: 'text', value: parsed.error }

  const { getToolBanditRewardLedgerPath } = require(
    '../../services/autoEvolve/paths.js',
  ) as typeof import('../../services/autoEvolve/paths.js')
  const ledgerPath = getToolBanditRewardLedgerPath()

  const windowMs = parsed.window * 3600 * 1000
  const windowRows = readAllRecent(ledgerPath, windowMs)
  const agg = aggregate(windowRows)
    .map(a => ({
      ...a,
      avgReward: a.count > 0 ? a.totalReward / a.count : 0,
      avgDuration: a.count > 0 ? a.totalDuration / a.count : 0,
      p95Duration: p95(a.durations),
      successRate: a.count > 0 ? a.success / a.count : 0,
    }))
    .sort((x, y) => y.totalReward - x.totalReward)
    .slice(0, 20)

  const recentRows = tailNdjson(ledgerPath, parsed.recent)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          ledgerPath,
          windowHours: parsed.window,
          windowTotalSamples: windowRows.length,
          aggregate: agg,
          recent: recentRows,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push(`tool-bandit ledger: ${ledgerPath}`)
  lines.push(`window=${parsed.window}h  samples=${windowRows.length}  (top 20 by totalReward)`)
  if (agg.length === 0) {
    lines.push('(no samples in window — run some tools or check CLAUDE_TOOL_BANDIT_LEDGER env)')
  } else {
    lines.push('tool                         n   ok   err   abort  totRew   avgRew   avgMs   p95Ms')
    for (const a of agg) {
      const row =
        a.toolName.padEnd(28).slice(0, 28) +
        ' ' + String(a.count).padStart(3) +
        ' ' + String(a.success).padStart(4) +
        '  ' + String(a.error).padStart(4) +
        '  ' + String(a.abort).padStart(5) +
        '  ' + a.totalReward.toFixed(1).padStart(6) +
        '  ' + a.avgReward.toFixed(2).padStart(6) +
        '  ' + String(Math.round(a.avgDuration)).padStart(5) +
        '   ' + String(Math.round(a.p95Duration)).padStart(5)
      lines.push(row)
    }
  }
  lines.push('')
  lines.push(`recent ${recentRows.length} events:`)
  if (recentRows.length === 0) {
    lines.push('  (none)')
  } else {
    for (const r of recentRows) {
      lines.push(
        `  ${r.at ?? '?'}  ${r.toolName ?? '?'}  ${r.outcome ?? '?'}  ` +
          `dur=${r.durationMs ?? '?'}ms  reward=${r.reward ?? '?'}`,
      )
    }
  }
  lines.push('')
  lines.push('Note: shadow-only reward ledger — no bandit policy is consuming this yet. See docs §G3.')
  return { type: 'text', value: lines.join('\n') }
}

const toolBandit = {
  type: 'local',
  name: 'tool-bandit',
  description:
    'G3 observation: show tool bandit shadow reward ledger aggregate. Read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default toolBandit
