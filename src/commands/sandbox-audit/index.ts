/**
 * /sandbox-audit — G8 Step 2.5 只读命令。
 *
 * 展示:
 *   1. CLAUDE 开关状态(shadow-sandbox ledger 始终 on,不带 env gate);
 *   2. ledger 路径 + tail 最近 N 条 override 事件;
 *   3. 24h 窗内按 toolName 聚合 flip 次数;
 *   4. advisor Rule 15 当前判定(none / flip_low / flip_medium / flip_high)。
 *
 * 只读;不改 sandboxFilter.evaluateShadowSandboxTool 行为,也不修改 user 规则。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /sandbox-audit                  show advisory + recent + aggregate (24h)
  /sandbox-audit --recent N       tail last N events (1..500, default 30)
  /sandbox-audit --window H       aggregate window hours (1..168, default 24)
  /sandbox-audit --json           emit JSON
  /sandbox-audit --help           this message
`

interface ParsedFlags {
  recent: number
  window: number
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let recent = 30
  let window = 24
  let json = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      return { recent, window, json, error: USAGE }
    } else if (t === '--json') {
      json = true
    } else if (t === '--recent') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return {
          recent,
          window,
          json,
          error: `--recent must be 1..500\n${USAGE}`,
        }
      }
      recent = n
    } else if (t === '--window') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 168) {
        return {
          recent,
          window,
          json,
          error: `--window must be 1..168\n${USAGE}`,
        }
      }
      window = n
    } else {
      return { recent, window, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { recent, window, json }
}

interface LedgerRow {
  at?: string
  toolName?: string
  userDecision?: string
  defaultBaseline?: string
  rationale?: string
  pid?: number
}

function tailNdjson(path: string, n: number): LedgerRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: LedgerRow[] = []
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

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const pathsMod = await import('../../services/autoEvolve/paths.js')
  const ledgerPath = pathsMod.getShadowSandboxOverrideLedgerPath()

  const advMod = await import(
    '../../services/autoEvolve/oracle/sandboxOverrideAdvisory.js'
  )
  const advisory = advMod.detectSandboxOverrideAdvisory({
    windowHours: parsed.window,
  })

  const recent = tailNdjson(ledgerPath, parsed.recent)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          ledgerPath,
          windowHours: parsed.window,
          advisory,
          recent,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push(
    `/sandbox-audit (G8 Step 2.5 — shadow sandbox override observability)`,
  )
  lines.push('')
  lines.push(`ledger: ${ledgerPath}`)
  lines.push(`window: ${parsed.window}h`)
  lines.push('')
  // advisory block
  lines.push(`advisory: ${advisory.kind}`)
  if (advisory.message) {
    lines.push(`  ${advisory.message}`)
  }
  lines.push(
    `  total=${advisory.stats.total} maxPerTool=${advisory.stats.maxPerTool}` +
      (advisory.stats.lastTool
        ? ` lastTool=${advisory.stats.lastTool}`
        : ''),
  )
  const byToolEntries = Object.entries(advisory.stats.byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
  if (byToolEntries.length > 0) {
    lines.push(`  byTool (top 20):`)
    for (const [tool, count] of byToolEntries) {
      lines.push(`    ${tool.padEnd(40)} ${count}`)
    }
  }
  lines.push('')
  if (recent.length === 0) {
    lines.push(`(ledger empty — no override events recorded yet)`)
  } else {
    lines.push(`Most recent ${Math.min(recent.length, 10)} events:`)
    const last = recent.slice(-10)
    for (const ev of last) {
      const when = ev.at ?? '?'
      const name = ev.toolName ?? '?'
      const baseline = ev.defaultBaseline ?? '?'
      const decision = ev.userDecision ?? '?'
      const rationale = ev.rationale
        ? ' :: ' + ev.rationale.slice(0, 60)
        : ''
      lines.push(
        `  ${when}  ${name.padEnd(30)} ${baseline}→${decision}${rationale}`,
      )
    }
  }
  lines.push('')
  lines.push(
    'Note: ledger is shadow-only — user override is NOT blocked, only recorded. See advisor Rule 15.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const sandboxAudit = {
  type: 'local',
  name: 'sandbox-audit',
  description:
    'G8 observation: show shadow-sandbox user override NDJSON ledger + Rule 15 advisory. Read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default sandboxAudit
