/**
 * /shadow-history [--line X] [--limit N] [--since ISO] [--json]
 *
 * 纯只读考古命令:读 shadow-promote.ndjson(Phase 8/25 新 domain)
 * 把 readiness_snapshot + cutover-applied 合成按时间序的时间线。
 *
 * 与 /shadow-promote 分工:
 *   /shadow-promote → 现在这一刻 8 条线的 verdict + 写新条目
 *   /shadow-history → 过去每条线 verdict 如何漂移 + 什么时候被 cutover
 *
 * 设计原则:
 *   1. 纯读:不写任何文件/ledger
 *   2. 默认去重:仅显示同一 line 上 verdict 发生变化的 snapshot
 *     (不然每次 /shadow-promote 都是一条,噪声太大)
 *   3. cutover-applied 始终全量显示(审计必要)
 *   4. fail-open:ledger 不存在就返回空提示
 */

import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /shadow-history                     # transitions for all 9 lines
  /shadow-history --line G            # only one line
  /shadow-history --limit 20          # max events shown (default 50)
  /shadow-history --since 2026-04-20  # only events on/after this date
  /shadow-history --json              # machine-readable output
  /shadow-history --help              # this text`

type LineCode = 'G' | 'Q9' | 'D' | 'E' | 'F' | 'A' | 'C' | 'B'
const VALID_LINES: readonly LineCode[] = ['G', 'Q9', 'D', 'E', 'F', 'A', 'C', 'B']

interface ParsedFlags {
  lineFilter: LineCode | null
  limit: number
  since: string | null
  json: boolean
  help: boolean
  unknown: string | null
}

// 轻量 tokenize —— 与 shadow-promote.ts 同构
function tokenize(args: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (quote) {
      if (c === quote) {
        quote = null
        continue
      }
      buf += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += c
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function parseFlags(tokens: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    lineFilter: null,
    limit: 50,
    since: null,
    json: false,
    help: false,
    unknown: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--help':
      case '-h':
        flags.help = true
        break
      case '--json':
        flags.json = true
        break
      case '--line': {
        const v = (tokens[++i] ?? '').toUpperCase() as LineCode
        if (VALID_LINES.includes(v)) flags.lineFilter = v
        else flags.unknown = `--line ${v || '(missing)'}`
        break
      }
      case '--limit': {
        const v = tokens[++i]
        const n = Number.parseInt(v ?? '', 10)
        if (Number.isFinite(n) && n > 0) flags.limit = n
        else flags.unknown = `--limit ${v ?? '(missing)'}`
        break
      }
      case '--since': {
        const v = tokens[++i]
        if (v) flags.since = v
        else flags.unknown = '--since (missing)'
        break
      }
      default:
        flags.unknown = t
    }
  }
  return flags
}

interface TimelineEvent {
  ts: string
  line: LineCode
  kind: 'transition' | 'cutover'
  // 对 transition:from/to 是 verdict(ready/hold/…);对 cutover:from/to 是 env mode
  from: string
  to: string
  /** 额外细节:transition 下是 samples/bakeHours;cutover 下是 envVar + scope */
  meta: Record<string, unknown>
}

/**
 * 从 shadow-promote domain 的 ndjson 读所有条目,按 ts 升序再提炼时间线。
 * transition 事件:同一 line 相邻 snapshot 之间 verdict 变化时才生一条。
 */
async function buildTimeline(
  lineFilter: LineCode | null,
  since: string | null,
): Promise<TimelineEvent[]> {
  const { EvidenceLedger } = await import(
    '../../services/harness/evidenceLedger.js'
  )
  const entries = EvidenceLedger.queryByDomain('shadow-promote' as never, {
    scanMode: 'full',
  })
  // 升序排序以便检测相邻 verdict 变化
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  const timeline: TimelineEvent[] = []
  const lastVerdict = new Map<LineCode, string>()

  for (const e of entries) {
    if (since && e.ts < since) continue

    if (e.kind === 'readiness_snapshot') {
      const rows = (e.data as { rows?: Array<Record<string, unknown>> }).rows ?? []
      for (const row of rows) {
        const line = row.line as LineCode
        if (!line || !VALID_LINES.includes(line)) continue
        if (lineFilter && line !== lineFilter) continue
        const verdict = String(row.verdict ?? 'unknown')
        const prev = lastVerdict.get(line)
        if (prev === undefined) {
          // 首次出现也记一条,方便用户看到初始状态
          timeline.push({
            ts: e.ts,
            line,
            kind: 'transition',
            from: '(new)',
            to: verdict,
            meta: {
              samples: row.samples ?? 0,
              bakeHours: row.bakeHours ?? null,
              currentMode: row.currentMode ?? '?',
            },
          })
        } else if (prev !== verdict) {
          timeline.push({
            ts: e.ts,
            line,
            kind: 'transition',
            from: prev,
            to: verdict,
            meta: {
              samples: row.samples ?? 0,
              bakeHours: row.bakeHours ?? null,
              currentMode: row.currentMode ?? '?',
            },
          })
        }
        lastVerdict.set(line, verdict)
      }
    } else if (e.kind === 'cutover-applied') {
      const d = e.data as {
        line?: string
        envVar?: string
        from?: string
        to?: string
        scope?: string
      }
      const line = d.line as LineCode
      if (!line || !VALID_LINES.includes(line)) continue
      if (lineFilter && line !== lineFilter) continue
      timeline.push({
        ts: e.ts,
        line,
        kind: 'cutover',
        from: d.from ?? '?',
        to: d.to ?? '?',
        meta: {
          envVar: d.envVar ?? '',
          scope: d.scope ?? '',
        },
      })
    }
  }
  return timeline
}

function formatTimeline(events: TimelineEvent[], limit: number): string {
  const lines: string[] = []
  lines.push('### Shadow Cutover History')
  lines.push('')
  if (events.length === 0) {
    lines.push('No events recorded. Run /shadow-promote at least once to start the audit trail.')
    return lines.join('\n')
  }

  // 显示最近 limit 条(倒序)
  const recent = events.slice(-limit).reverse()
  lines.push(
    `Showing ${recent.length} of ${events.length} events (newest first):`,
  )
  lines.push('')
  for (const ev of recent) {
    const icon = ev.kind === 'cutover' ? '🔀' : '↪️'
    if (ev.kind === 'cutover') {
      const meta = ev.meta as { envVar: string; scope: string }
      lines.push(
        `${icon} ${ev.ts}  ${ev.line}  CUTOVER  ${meta.envVar}: ${ev.from} → ${ev.to}  [scope=${meta.scope}]`,
      )
    } else {
      const meta = ev.meta as {
        samples: number
        bakeHours: number | null
        currentMode: string
      }
      const bake = meta.bakeHours !== null ? `${meta.bakeHours}h` : '-'
      lines.push(
        `${icon} ${ev.ts}  ${ev.line}  ${ev.from} → ${ev.to}  [samples=${meta.samples} bake=${bake} env=${meta.currentMode}]`,
      )
    }
  }
  lines.push('')
  const cutoverCount = events.filter(e => e.kind === 'cutover').length
  lines.push(
    `Summary: ${events.length - cutoverCount} verdict transitions · ${cutoverCount} cutover applied`,
  )
  return lines.join('\n')
}

export const call: LocalCommandCall = async (args: string) => {
  try {
    const tokens = tokenize(args ?? '')
    const flags = parseFlags(tokens)
    if (flags.help) return { type: 'text', value: USAGE }
    if (flags.unknown) {
      return {
        type: 'text',
        value: `Unknown or invalid flag: ${flags.unknown}\n\n${USAGE}`,
      }
    }
    const events = await buildTimeline(flags.lineFilter, flags.since)
    if (flags.json) {
      return {
        type: 'text',
        value: JSON.stringify(events.slice(-flags.limit), null, 2),
      }
    }
    return { type: 'text', value: formatTimeline(events, flags.limit) }
  } catch (err) {
    return {
      type: 'text',
      value: `### Shadow Cutover History\n\nFailed to read audit ledger: ${(err as Error).message}`,
    }
  }
}
