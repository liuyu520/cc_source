/**
 * /api-fallback-check — G5 observation command.
 *
 * 纯只读展示当前 ANTHROPIC_FALLBACK_CHAIN 配置 + 近 N 条 fallback 事件。
 * 数据来源:
 *   - 当前 chain: fallbackChain.parseFallbackChain(process.env.ANTHROPIC_FALLBACK_CHAIN)
 *   - 事件历史:  oracle/api-fallback.ndjson
 *
 * 无副作用;任何读盘异常都 fail-open。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /api-fallback-check                  show chain + last 10 fallback events
  /api-fallback-check --recent N       last N events (1..100, default 10)
  /api-fallback-check --json           merged JSON output
  /api-fallback-check --help           this message
`

interface ParsedFlags {
  recent: number
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let recent = 10
  let json = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      return { recent, json, error: USAGE }
    } else if (t === '--json') {
      json = true
    } else if (t === '--recent') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return { recent, json, error: `--recent must be 1..100\n${USAGE}` }
      }
      recent = n
    } else {
      return { recent, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { recent, json }
}

interface FallbackEventRow {
  at?: string
  originalModel?: string
  fallbackModel?: string
  reason?: string
  queryDepth?: number
  pid?: number
}

function tailNdjson(path: string, n: number): FallbackEventRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: FallbackEventRow[] = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as FallbackEventRow)
      } catch { /* skip malformed line */ }
    }
    return out
  } catch {
    return []
  }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const fcMod = await import('../../services/api/fallbackChain.js')
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  const chain = fcMod.parseFallbackChain()
  const ledgerPath = pathsMod.getApiFallbackLedgerPath()
  const recent = tailNdjson(ledgerPath, parsed.recent)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify({ chain, ledgerPath, recent }, null, 2),
    }
  }

  const lines: string[] = []
  lines.push('API Fallback Chain (G5, observation-only)')
  lines.push(
    `  ANTHROPIC_FALLBACK_CHAIN: ${chain.length ? chain.join(' → ') : '(unset)'}`,
  )
  lines.push(`  ledger path: ${ledgerPath}`)
  lines.push('')
  lines.push(`Recent ${recent.length} fallback event(s):`)
  if (recent.length === 0) {
    lines.push('  (none)')
  } else {
    for (const ev of recent) {
      const at = ev.at ?? '?'
      const from = ev.originalModel ?? '?'
      const to = ev.fallbackModel ?? '?'
      const reason = ev.reason ?? '?'
      const depth = ev.queryDepth === undefined ? '' : ` depth=${ev.queryDepth}`
      lines.push(`  ${at}  ${from} → ${to}  [${reason}]${depth}`)
    }
  }
  lines.push('')
  lines.push(
    'Note: chain is *observation-only* in this build; withRetry still uses the single --fallback-model CLI flag for real switching.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const apiFallbackCheck = {
  type: 'local',
  name: 'api-fallback-check',
  description:
    'G5 observation: show ANTHROPIC_FALLBACK_CHAIN config + recent fallback events from oracle/api-fallback.ndjson. Read-only; does not alter retry behavior.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default apiFallbackCheck
