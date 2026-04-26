/**
 * /evolve-forbidden-zones-check [--status shadow|canary|stable|proposal|archived|vetoed] [--limit N] [id]
 *
 * Phase 42 — Forbidden Zone Guard reviewer entry.
 *
 * 只读命令:扫描指定 status 下 organism 目录里的产物文件,看是否命中 hard-block
 * / warn 规则。默认扫 shadow + canary(最相关的晋升候选)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { listOrganismIds, readOrganism } from '../../services/autoEvolve/arena/arenaController.js'
import { evaluateForbiddenZones } from '../../services/autoEvolve/arena/forbiddenZones.js'
import type { OrganismStatus } from '../../services/autoEvolve/types.js'

const USAGE = `Usage:
  /evolve-forbidden-zones-check [--status STATUS] [--limit N] [id]
    - no args:      scan shadow + canary organisms
    - --status S:   one of proposal|shadow|canary|stable|vetoed|archived
    - --limit N:    output cap (default 50, range 1..500)
    - id:           only scan one organism id under the chosen status(es)`

interface ParsedFlags {
  statuses: OrganismStatus[]
  limit: number
  organismId: string | null
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    statuses: ['shadow', 'canary'],
    limit: 50,
    organismId: null,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--status' || t === '-s') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--status requires a value'
        return out
      }
      if (
        next !== 'proposal' &&
        next !== 'shadow' &&
        next !== 'canary' &&
        next !== 'stable' &&
        next !== 'vetoed' &&
        next !== 'archived'
      ) {
        out.error = `invalid --status "${next}"\n\n${USAGE}`
        return out
      }
      out.statuses = [next]
      i++
    } else if (t === '--limit' || t === '-l') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--limit requires a number'
        return out
      }
      const n = Number.parseInt(next, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 500) {
        out.error = `--limit must be a positive integer 1..500 (got "${next}")`
        return out
      }
      out.limit = n
      i++
    } else if (t === '--help' || t === '-h') {
      out.error = USAGE
      return out
    } else if (t.startsWith('-')) {
      out.error = `Unknown flag "${t}"\n\n${USAGE}`
      return out
    } else if (!out.organismId) {
      out.organismId = t
    } else {
      out.error = `Unexpected extra arg "${t}"\n\n${USAGE}`
      return out
    }
  }
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const rows: string[] = []
  for (const status of parsed.statuses) {
    const ids = parsed.organismId
      ? listOrganismIds(status).filter(id => id === parsed.organismId)
      : listOrganismIds(status)
    for (const id of ids) {
      const m = readOrganism(status, id)
      if (!m) continue
      const verdict = evaluateForbiddenZones(m, status)
      rows.push(
        [
          verdict.status === 'block'
            ? 'BLOCK'
            : verdict.status === 'warn'
              ? 'WARN '
              : 'PASS ',
          status,
          m.name,
          `(${m.id})`,
          `hits=${verdict.hits.length}`,
        ].join(' '),
      )
      for (const hit of verdict.hits.slice(0, 6)) {
        rows.push(
          `    - [${hit.severity}] ${hit.ruleId} @ ${hit.path} :: ${hit.snippet}`,
        )
      }
      if (verdict.hits.length > 6) {
        rows.push(`    - ... ${verdict.hits.length - 6} more hit(s)`)
      }
    }
  }

  const lines: string[] = []
  lines.push('## autoEvolve Forbidden Zones Check (Phase 42)')
  lines.push('')
  lines.push(`statuses: ${parsed.statuses.join(', ')}`)
  lines.push(`limit: ${parsed.limit}`)
  lines.push(`organism: ${parsed.organismId ?? '(all)'}`)
  lines.push('')
  if (rows.length === 0) {
    lines.push('(no organisms matched)')
    return { type: 'text', value: lines.join('\n') }
  }
  for (const row of rows.slice(0, parsed.limit)) lines.push(row)
  if (rows.length > parsed.limit) {
    lines.push('')
    lines.push(`... truncated ${rows.length - parsed.limit} line(s); re-run with --limit`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveForbiddenZonesCheck = {
  type: 'local',
  name: 'evolve-forbidden-zones-check',
  description:
    'Phase 42 forbidden-zone reviewer check. Read-only scan of organism artifacts for auth/permission/.env/bin/build-binary path hits and destructive shell patterns (rm -rf, git reset --hard, push --force). Defaults to shadow+canary; supports --status, --limit, and single organism id filter.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveForbiddenZonesCheck
