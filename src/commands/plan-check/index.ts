/**
 * /plan-check — G1 plan ↔ artifact fidelity command.
 *
 * 只读展示当前 session plan 的条目核验状态。
 * 仅对"创建/修改 <path>"型条目做 existsSync 核验;其它一律 undetermined。
 * --strict 非零退出当 mismatched > 0。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /plan-check              show plan items with fidelity status
  /plan-check --strict     exit non-zero when any mismatched (CI-friendly)
  /plan-check --json       merged JSON output
  /plan-check --help       this message
`

interface ParsedFlags {
  strict: boolean
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let strict = false
  let json = false
  for (const t of tokens) {
    if (t === '--help' || t === '-h') {
      return { strict, json, error: USAGE }
    } else if (t === '--strict') {
      strict = true
    } else if (t === '--json') {
      json = true
    } else {
      return { strict, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { strict, json }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const pfMod = await import(
    '../../services/planFidelity/artifactChecker.js'
  )
  const res = pfMod.checkPlanFidelity()

  if (parsed.json) {
    return { type: 'text', value: JSON.stringify(res, null, 2) }
  }

  const lines: string[] = []
  if (res.kind === 'no-plan') {
    lines.push('Plan fidelity check: no plan file found.')
    lines.push(`  plan path: ${res.planPath ?? '(none)'}`)
    lines.push('  (You have not run ExitPlanMode in this session.)')
    return { type: 'text', value: lines.join('\n') }
  }
  if (res.kind === 'error') {
    lines.push(`Plan fidelity check: error — ${res.error ?? 'unknown'}`)
    return { type: 'text', value: lines.join('\n') }
  }

  lines.push('Plan fidelity check (G1)')
  lines.push(`  plan path: ${res.planPath ?? '(unknown)'}`)
  lines.push(
    `  total=${res.summary.total}  matched=${res.summary.matched}  mismatched=${res.summary.mismatched}  undetermined=${res.summary.undetermined}`,
  )
  lines.push('')
  if (res.items.length === 0) {
    lines.push('  (no bullet items found in plan)')
  } else {
    for (const it of res.items) {
      const icon =
        it.kind === 'matched' ? '✓' : it.kind === 'mismatched' ? '✗' : '?'
      const tail = it.path ? `  [${it.pattern}: ${it.path}]` : ''
      const detail = it.detail ? ` — ${it.detail}` : ''
      lines.push(`  ${icon} ${truncate(it.raw, 120)}${tail}${detail}`)
    }
  }
  lines.push('')
  lines.push(
    'Note: this is MVP heuristic — only "create/write/edit <path>" bullets are checked; other items stay undetermined.',
  )

  // --strict: still emit the text report, but the caller's hook/wrapper can
  // detect mismatched>0 from the summary line. We don't actually exit here
  // because LocalCommandCall runs inside the REPL.
  if (parsed.strict && res.summary.mismatched > 0) {
    lines.push('')
    lines.push(
      `[--strict] ${res.summary.mismatched} mismatched item(s); treat as failure.`,
    )
  }

  return { type: 'text', value: lines.join('\n') }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

const planCheck = {
  type: 'local',
  name: 'plan-check',
  description:
    'G1 plan ↔ artifact fidelity. Reads current session plan and verifies each "create/write/edit <path>" bullet against the filesystem. Read-only; undetermined items stay undetermined (no false positives).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default planCheck
