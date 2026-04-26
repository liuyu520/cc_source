/**
 * /tick-budget — G10 Step 1 观察命令。
 *
 * 展示:
 *   1. CLAUDE_TICK_BUDGET_LEDGER 开关状态 + ledger 路径;
 *   2. 最近 N 条 tick 样本(taskName / outcome / durationMs / error);
 *   3. 按 taskName 聚合(本次 tail 样本内):
 *      count / total / avg / p95 / success / error / skipped。
 *
 * 只读;不改 periodicMaintenance runTick 或 task.tick 行为。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /tick-budget                show switch + recent ticks + per-task aggregate
  /tick-budget --recent N     tail last N events (1..500, default 50)
  /tick-budget --json         emit JSON
  /tick-budget --help         this message
`

interface ParsedFlags {
  recent: number
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let recent = 50
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
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return { recent, json, error: `--recent must be 1..500\n${USAGE}` }
      }
      recent = n
    } else {
      return { recent, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { recent, json }
}

interface TickSampleRow {
  at?: string
  taskName?: string
  durationMs?: number
  outcome?: 'success' | 'error' | 'skipped'
  errorMessage?: string
  tickCount?: number
  intervalMs?: number
  pid?: number
}

function tailNdjson(path: string, n: number): TickSampleRow[] {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.slice(-n)
    const out: TickSampleRow[] = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

// 计算 95 分位(简单排序,粒度够用)
function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx] ?? 0
}

interface TaskAgg {
  count: number
  success: number
  error: number
  skipped: number
  /**
   * G10 Step 4:被 budgetCoordinator 限流的样本(skipped 且 errorMessage
   * 以 'throttled:' 前缀)。与 skipped 有重叠关系:throttled ⊆ skipped。
   */
  throttled: number
  totalMs: number
  durations: number[]
  lastAt?: string
  intervalMs?: number
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const pathsMod = await import('../../services/autoEvolve/paths.js')
  const ledgerPath = pathsMod.getTickBudgetLedgerPath()

  const recent = tailNdjson(ledgerPath, parsed.recent)
  const switchRaw = (process.env.CLAUDE_TICK_BUDGET_LEDGER ?? '').toString()
  const switchOn = !['off', '0', 'false'].includes(
    switchRaw.trim().toLowerCase(),
  )

  const byTask = new Map<string, TaskAgg>()
  for (const ev of recent) {
    if (!ev.taskName) continue
    const agg = byTask.get(ev.taskName) ?? {
      count: 0,
      success: 0,
      error: 0,
      skipped: 0,
      throttled: 0,
      totalMs: 0,
      durations: [],
    }
    agg.count += 1
    if (ev.outcome === 'success') agg.success += 1
    else if (ev.outcome === 'error') agg.error += 1
    else if (ev.outcome === 'skipped') {
      agg.skipped += 1
      // G10 Step 4:throttled 分列。budgetCoordinator deny 时旁路
      // 写 ledger outcome='skipped', errorMessage='throttled:<reason>';
      // 展示层把这类样本单独计数,用户能一眼看出"限流 vs 原生 skip"。
      if (ev.errorMessage && ev.errorMessage.startsWith('throttled:')) {
        agg.throttled += 1
      }
    }
    if (typeof ev.durationMs === 'number') {
      agg.totalMs += ev.durationMs
      if (ev.outcome !== 'skipped') agg.durations.push(ev.durationMs)
    }
    if (ev.at) agg.lastAt = ev.at
    if (typeof ev.intervalMs === 'number') agg.intervalMs = ev.intervalMs
    byTask.set(ev.taskName, agg)
  }

  interface TopRow {
    taskName: string
    count: number
    success: number
    error: number
    skipped: number
    /** throttled 是 skipped 的子集(详见 TaskAgg.throttled) */
    throttled: number
    totalMs: number
    avgMs: number
    p95Ms: number
    intervalMs?: number
    lastAt?: string
  }
  const top: TopRow[] = Array.from(byTask.entries())
    .map(([taskName, v]) => ({
      taskName,
      count: v.count,
      success: v.success,
      error: v.error,
      skipped: v.skipped,
      throttled: v.throttled,
      totalMs: v.totalMs,
      avgMs:
        v.durations.length > 0
          ? Math.round(
              v.durations.reduce((a, b) => a + b, 0) / v.durations.length,
            )
          : 0,
      p95Ms: p95(v.durations),
      intervalMs: v.intervalMs,
      lastAt: v.lastAt,
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 20)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          switch: { env: switchRaw || '(unset)', enabled: switchOn },
          ledgerPath,
          sampledRows: recent.length,
          top,
          recent: recent.slice(-10),
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push(`/tick-budget (G10 Step 1 — periodic maintenance observability)`)
  lines.push('')
  lines.push(
    `switch: CLAUDE_TICK_BUDGET_LEDGER=${switchRaw || '(unset)'} → ${
      switchOn ? 'ON' : 'OFF'
    }`,
  )
  lines.push(`ledger: ${ledgerPath}`)
  lines.push(`sampled rows (tail of recent N): ${recent.length}`)
  lines.push('')
  if (recent.length === 0) {
    lines.push(
      '(no samples yet — ledger empty. periodic tasks will write here as they tick.)',
    )
  } else {
    lines.push(`Top tasks by totalMs:`)
    for (const r of top) {
      // throttled 仅在 >0 时追加显示,避免干扰常规输出
      const throttledSuffix = r.throttled > 0 ? ` throttled=${r.throttled}` : ''
      lines.push(
        `  ${r.taskName.padEnd(30)} count=${r.count} ok=${r.success} err=${r.error} skip=${r.skipped}${throttledSuffix} total=${r.totalMs}ms avg=${r.avgMs}ms p95=${r.p95Ms}ms interval=${r.intervalMs ?? '?'}ms`,
      )
    }
    lines.push('')
    lines.push(`Most recent 10 events:`)
    const last = recent.slice(-10)
    for (const ev of last) {
      const when = ev.at ?? '?'
      const tag = ev.outcome ?? '?'
      const dur =
        typeof ev.durationMs === 'number' ? `${ev.durationMs}ms` : '?'
      lines.push(
        `  ${when}  ${tag.padEnd(7)} ${(ev.taskName ?? '?').padEnd(30)} ${dur}${
          ev.errorMessage ? '  err=' + ev.errorMessage.slice(0, 80) : ''
        }`,
      )
    }
  }
  lines.push('')
  lines.push(
    'Note: observation-only — no budget enforcement yet. Step 2 will consume this ledger to introduce budgetCoordinator.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const tickBudget = {
  type: 'local',
  name: 'tick-budget',
  description:
    'G10 observation: show periodic maintenance tick budget NDJSON ledger (duration/outcome by task). Read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default tickBudget
