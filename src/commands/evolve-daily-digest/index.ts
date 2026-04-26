/**
 * /evolve-daily-digest —— self-evolution-kernel v1.0 §6.3 观测层命令。
 *
 * 把当日 autoEvolve 的 promotion / fitness / forbidden-zone / ledger-integrity
 * 聚合成 markdown 摘要。
 *
 * 行为矩阵:
 *   无 flag            → 默认 --preview:渲染不落盘,直接回显给用户。
 *   --apply            → 真写盘到 ~/.claude/autoEvolve/daily-digest/<date>.md,
 *                        幂等(同日覆盖)。输出仍含 markdown 主体 + path。
 *   --path             → 只打印目标路径,不读任何数据源,不写盘。
 *   --date=YYYY-MM-DD  → 聚合该日的数据(UTC 日界),默认今天。
 *   --json             → 结构化 summary(不渲染 markdown)。
 *
 * 铁律:
 *   - --apply 之外的 flag 都是纯只读,不触 ledger / manifest。
 *   - fail-open:数据源异常不抛出,相关段落打印 (unavailable: ...) 。
 *   - 不自动回补历史日期,只处理显式传入的 date 或当天。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-daily-digest                       Preview (no disk write)
  /evolve-daily-digest --apply               Write to ~/.claude/autoEvolve/daily-digest/<date>.md
  /evolve-daily-digest --path                Print target path only (no scan, no write)
  /evolve-daily-digest --date=YYYY-MM-DD     Aggregate a specific UTC day (default: today)
  /evolve-daily-digest --json                Structured summary only (no markdown)

Flags:
  --apply           Write markdown to disk (idempotent; same day overwrites).
  --path            Print resolved path; no data-source reads.
  --date=YYYY-MM-DD Target UTC day. Default = today.
  --json            Emit DailyDigestSummary as JSON (no markdown).

Read-only by default. --apply only writes under autoEvolve/daily-digest/.`

type Mode = 'preview' | 'apply' | 'path'

interface ParsedFlags {
  mode: Mode
  date?: string
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const out: ParsedFlags = { mode: 'preview', json: false }
  const tokens = (args ?? '').trim().split(/\s+/).filter(t => t.length > 0)
  for (const t of tokens) {
    if (t === '--apply') out.mode = 'apply'
    else if (t === '--path') out.mode = 'path'
    else if (t === '--preview') out.mode = 'preview'
    else if (t === '--json') out.json = true
    else if (t === '--help' || t === '-h') {
      out.error = USAGE
      return out
    } else if (t.startsWith('--date=')) {
      const v = t.slice('--date='.length).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        out.error = `--date must be YYYY-MM-DD (got: ${v})\n\n${USAGE}`
        return out
      }
      out.date = v
    } else {
      out.error = `Unknown flag: ${t}\n\n${USAGE}`
      return out
    }
  }
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 懒加载(与 /genealogy、/fossil 一致,保持命令注册时的解耦)
  const { getDailyDigestPath } = await import(
    '../../services/autoEvolve/paths.js'
  )
  const {
    buildDailyDigestSummary,
    renderDailyDigest,
    writeDailyDigest,
  } = await import(
    '../../services/autoEvolve/observability/dailyDigest.js'
  )

  // 计算目标日期(纯展示用;真实聚合里 buildDailyDigestSummary 会再 normalize 一次)
  const ymd =
    parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
      ? parsed.date
      : (() => {
          const d = new Date()
          const y = d.getUTCFullYear()
          const m = String(d.getUTCMonth() + 1).padStart(2, '0')
          const day = String(d.getUTCDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        })()

  // ── --path:零成本模式,不扫 ledger。
  if (parsed.mode === 'path') {
    const path = getDailyDigestPath(ymd)
    if (parsed.json) {
      return { type: 'text', value: JSON.stringify({ date: ymd, path }, null, 2) }
    }
    return { type: 'text', value: `date=${ymd}\npath=${path}` }
  }

  // 聚合数据(--preview/--apply/--json 都走这里)
  let summary
  try {
    summary = buildDailyDigestSummary(parsed.date)
  } catch (e) {
    return {
      type: 'text',
      value: `error: failed to build daily digest: ${(e as Error).message}`,
    }
  }

  // --json:返回结构化 summary
  if (parsed.json) {
    return { type: 'text', value: JSON.stringify(summary, null, 2) }
  }

  const md = renderDailyDigest(summary)

  // --preview:只回显
  if (parsed.mode === 'preview') {
    return {
      type: 'text',
      value: md + `\n(preview only — re-run with --apply to persist)`,
    }
  }

  // --apply:真写盘
  const result = writeDailyDigest(parsed.date)
  const note =
    result.bytes > 0
      ? `✔ ${result.overwrote ? 'overwrote' : 'wrote'} ${result.bytes} bytes → ${result.path}`
      : `✗ write failed (see debug log) → ${result.path}`
  return { type: 'text', value: md + `\n${note}` }
}

const evolveDailyDigest = {
  type: 'local',
  name: 'evolve-daily-digest',
  description:
    'self-evolution-kernel v1.0 §6.3 observability. Aggregates the day\'s autoEvolve activity (promotions, fitness top/bottom, forbidden-zone audit hits, ledger integrity) into a markdown digest. Default: preview; --apply writes ~/.claude/autoEvolve/daily-digest/<YYYY-MM-DD>.md (idempotent, same-day overwrite). Accepts --date=YYYY-MM-DD, --json, --path.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveDailyDigest
