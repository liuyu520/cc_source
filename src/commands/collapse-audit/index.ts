/**
 * /collapse-audit — G4 Step 1 观察命令。
 *
 * 展示:
 *   1. CLAUDE_PRECOLLAPSE_AUDIT 开关状态 + ledger 路径;
 *   2. 最近 N 条 collapse-audit 事件(含 victim 风险分布摘要);
 *   3. ROI ledger 的 tracked 数量(辅助判断有没有足够数据打分)。
 *
 * 只读;不改任何 compact / collapse 行为。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /collapse-audit                show audit switch + recent drop events
  /collapse-audit --recent N     tail last N events (1..100, default 10)
  /collapse-audit --json         emit JSON
  /collapse-audit --help         this message
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

interface AuditEventRow {
  at?: string
  decisionPoint?: string
  victimCount?: number
  keepCount?: number
  highRiskCount?: number
  unknownCount?: number
  victims?: Array<{
    id?: string
    label?: string
    risk?: string
    reason?: string
    served?: number
    used?: number
    ageHours?: number
  }>
  pid?: number
  [k: string]: unknown
}

function tailNdjson(path: string, n: number): AuditEventRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: AuditEventRow[] = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as AuditEventRow)
      } catch {
        /* skip malformed */
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
  const roiMod = await import('../../services/contextSignals/itemRoiLedger.js')

  const ledgerPath = pathsMod.getCollapseAuditLedgerPath()
  const recent = tailNdjson(ledgerPath, parsed.recent)
  const switchRaw = (process.env.CLAUDE_PRECOLLAPSE_AUDIT ?? '').toString()
  const switchOn = !['off', '0', 'false'].includes(switchRaw.trim().toLowerCase())

  let roiTracked = 0
  try {
    const snap = roiMod.getContextItemRoiSnapshot(1)
    roiTracked = snap.tracked
  } catch {
    roiTracked = 0
  }

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          switch: { env: switchRaw || '(unset)', enabled: switchOn },
          ledgerPath,
          roiTracked,
          recent,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push('Collapse audit (G4 shadow)')
  lines.push(
    `  switch: CLAUDE_PRECOLLAPSE_AUDIT=${switchRaw || '(unset)'}  → ${
      switchOn ? 'enabled' : 'DISABLED'
    }`,
  )
  lines.push(`  ledger: ${ledgerPath}`)
  lines.push(`  ROI tracked items: ${roiTracked}`)
  lines.push('')
  if (recent.length === 0) {
    lines.push('  (no events yet — collapse-audit is not wired into compact.ts)')
  } else {
    lines.push(`  Recent ${recent.length} event(s):`)
    for (const ev of recent) {
      const at = ev.at ?? '?'
      const dp = ev.decisionPoint ?? '?'
      const vc = ev.victimCount ?? 0
      const kc = ev.keepCount ?? 0
      const hr = ev.highRiskCount ?? 0
      const un = ev.unknownCount ?? 0
      lines.push(
        `  - ${at}  ${dp}  victims=${vc} keeps=${kc} highRisk=${hr} unknown=${un}`,
      )
      const vs = Array.isArray(ev.victims) ? ev.victims : []
      for (const v of vs.slice(0, 5)) {
        const id = v.id ?? '?'
        const risk = v.risk ?? '?'
        const reason = v.reason ?? ''
        lines.push(`      · [${risk}] ${id}  — ${reason}`)
      }
      if (vs.length > 5) {
        lines.push(`      · … (${vs.length - 5} more victims truncated)`)
      }
    }
  }
  lines.push('')
  lines.push(
    'Note: this is observation-only. Drop decisions are still made by compact.ts using token-gap heuristic; ROI-aware scoring is not yet wired into the decision path.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const collapseAudit = {
  type: 'local',
  name: 'collapse-audit',
  description:
    'G4 observation: show pre-collapse drop decisions scored against item-ROI ledger. Read-only; does not alter compact/collapse behavior.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default collapseAudit
