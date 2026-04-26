/**
 * /organism-invocation-check — G2 Step 1 观察命令。
 *
 * 展示:
 *   1. CLAUDE_ORGANISM_INVOCATION_LEDGER 开关状态 + ledger 路径;
 *   2. 最近 N 条 invocation 事件;
 *   3. 按 organismId 聚合的调用次数(这次会话内 ledger tail 样本)。
 *
 * 只读;不改 arena/skill/recordOrganismInvocation 行为。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /organism-invocation-check                show switch + recent events + top organisms
  /organism-invocation-check --recent N     tail last N events (1..200, default 20)
  /organism-invocation-check --json         emit JSON
  /organism-invocation-check --help         this message
`

interface ParsedFlags {
  recent: number
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let recent = 20
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
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return { recent, json, error: `--recent must be 1..200\n${USAGE}` }
      }
      recent = n
    } else {
      return { recent, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { recent, json }
}

interface InvocationEventRow {
  at?: string
  organismId?: string
  kind?: string
  status?: string
  source?: string
  pid?: number
  [k: string]: unknown
}

function tailNdjson(path: string, n: number): InvocationEventRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: InvocationEventRow[] = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as InvocationEventRow)
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
  const ledgerPath = pathsMod.getOrganismInvocationLedgerPath()

  const recent = tailNdjson(ledgerPath, parsed.recent)
  const switchRaw = (process.env.CLAUDE_ORGANISM_INVOCATION_LEDGER ?? '').toString()
  const switchOn = !['off', '0', 'false'].includes(
    switchRaw.trim().toLowerCase(),
  )

  // 按 organismId 聚合样本内调用次数
  const byOrganism = new Map<
    string,
    { count: number; kind?: string; lastAt?: string }
  >()
  for (const ev of recent) {
    if (!ev.organismId) continue
    const agg = byOrganism.get(ev.organismId) ?? { count: 0 }
    agg.count += 1
    agg.kind = ev.kind ?? agg.kind
    agg.lastAt = ev.at ?? agg.lastAt
    byOrganism.set(ev.organismId, agg)
  }
  const top = Array.from(byOrganism.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          switch: { env: switchRaw || '(unset)', enabled: switchOn },
          ledgerPath,
          recent,
          top,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push('Organism invocation ledger (G2 shadow)')
  lines.push(
    `  switch: CLAUDE_ORGANISM_INVOCATION_LEDGER=${switchRaw || '(unset)'}  → ${
      switchOn ? 'enabled' : 'DISABLED'
    }`,
  )
  lines.push(`  ledger: ${ledgerPath}`)
  lines.push('')
  if (recent.length === 0) {
    lines.push(
      '  (no events yet — skill organisms have not been invoked, or ledger is off)',
    )
  } else {
    lines.push(`  Recent ${recent.length} event(s):`)
    for (const ev of recent) {
      const at = ev.at ?? '?'
      const id = ev.organismId ?? '?'
      const kind = ev.kind ?? '?'
      const status = ev.status ?? '?'
      const source = ev.source ? ` src=${ev.source}` : ''
      lines.push(`  - ${at}  [${kind.padEnd(7)}] ${id}  ${status}${source}`)
    }
    lines.push('')
    lines.push(`  Top organisms in last ${recent.length}:`)
    for (const row of top) {
      const kind = row.kind ?? '?'
      const last = row.lastAt ?? '?'
      lines.push(`    ${row.count.toString().padStart(4)}×  [${kind}]  ${row.id}  (last ${last})`)
    }
  }
  lines.push('')
  lines.push(
    'Note: this is an observation-side NDJSON mirror of arenaController.recordOrganismInvocation (stable skills only). Shadow/canary/non-skill kinds are not yet wired.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const organismInvocationCheck = {
  type: 'local',
  name: 'organism-invocation-check',
  description:
    'G2 observation: show organism invocation NDJSON ledger (skill-loader callsite). Read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default organismInvocationCheck
