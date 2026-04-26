/**
 * /evolve-rare-check — self-evolution-kernel v1.0 §6.2 Goodhart 对抗 #3 入口
 *
 * 稀有样本保护:让 Oracle 把长尾任务的权重保持在 ≥ 30% 以上。
 * 本命令只做**观察与提示**,不直接改任何权重文件。
 *
 * 模式
 * ────
 *   --status (默认)   : 打印最近一次 snapshot 摘要 + target floor + 当前 share
 *   --analyze          : 立刻跑一次 analyzeRareSamples,追加 rare-sample.ndjson
 *   --history [N=10]   : 展示最近 N 条 snapshot(精简行)
 *   --dry-run          : 同 --status,不落盘
 *
 * Env:
 *   CLAUDE_EVOLVE_RARE_SAMPLE_TARGET     (default 0.30)
 *   CLAUDE_EVOLVE_RARE_SAMPLE_THRESHOLD  (default 2   — frequency ≤ 视为稀有)
 *   CLAUDE_EVOLVE_RARE_SAMPLE_WINDOW     (default 500)
 *
 * 安全:本命令**绝不直接改 tuned-oracle-weights.json**。
 *       如果快照显示 below-floor,请走 `/evolve-meta --apply` 人工复核。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-rare-check
  /evolve-rare-check --status
      (default) show the most recent rare-sample snapshot + target floor

  /evolve-rare-check --analyze
      run a fresh analyze, appending one snapshot to rare-sample.ndjson
      (shadow-only; does NOT change tuned-oracle-weights.json)

  /evolve-rare-check --history [--limit 10]
      show recent snapshots (newest last)

  --dry-run
      alias of --status; never writes

Env:
  CLAUDE_EVOLVE_RARE_SAMPLE_TARGET      (default 0.30)
  CLAUDE_EVOLVE_RARE_SAMPLE_THRESHOLD   (default 2)
  CLAUDE_EVOLVE_RARE_SAMPLE_WINDOW      (default 500)
`

type Mode = 'status' | 'analyze' | 'history' | null

interface ParsedFlags {
  mode: Mode
  limit: number
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let mode: Mode = null
  let limit = 10

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--status' || t === '--dry-run' || t === '') {
      mode = mode ?? 'status'
    } else if (t === '--analyze') {
      mode = 'analyze'
    } else if (t === '--history') {
      mode = 'history'
    } else if (t === '--limit') {
      const v = Number(tokens[++i])
      if (Number.isFinite(v) && v > 0) limit = Math.floor(v)
    } else if (t === '-h' || t === '--help') {
      return { mode: null, limit, error: USAGE }
    } else {
      return { mode: null, limit, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { mode: mode ?? 'status', limit }
}

function fmtShare(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function fmtAvg(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(3)
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 动态 import 避免冷启动 Oracle 全家桶
  const guardMod = await import(
    '../../services/autoEvolve/oracle/rareSampleGuard.js'
  )

  if (parsed.mode === 'history') {
    const recent = guardMod.recentRareSampleSnapshots(parsed.limit)
    const out: string[] = []
    out.push(`rare-sample snapshots history (limit=${parsed.limit})`)
    if (recent.length === 0) {
      out.push('  (no snapshots yet — run /evolve-rare-check --analyze to create one)')
    } else {
      for (const s of recent) {
        const badge = s.belowFloor ? 'below-floor⚠' : 'ok'
        out.push(
          `  · ${s.ts}  share=${fmtShare(s.rareShare)}/${fmtShare(s.targetShare)}  ` +
            `rare=${s.rareSubjects}/${s.totalSubjects}  rareAvg=${fmtAvg(s.rareAvgScore)}  ` +
            `nonRareAvg=${fmtAvg(s.nonRareAvgScore)}  [${badge}]  reason=${s.reason}`,
        )
      }
    }
    return { type: 'text', value: out.join('\n') }
  }

  if (parsed.mode === 'analyze') {
    // persist=true 追加 ndjson
    const snap = guardMod.analyzeRareSamples({
      reason: 'manual',
      persist: true,
    })
    if (!snap) {
      return {
        type: 'text',
        value:
          'analyzeRareSamples returned null (fail-open). Check logs for details.',
      }
    }
    const out: string[] = []
    out.push(`rare-sample analysis complete`)
    out.push(`  ts            : ${snap.ts}`)
    out.push(
      `  share         : ${fmtShare(snap.rareShare)} vs target ≥${fmtShare(
        snap.targetShare,
      )}   ${snap.belowFloor ? '[below-floor⚠]' : '[ok]'}`,
    )
    out.push(
      `  window        : ${snap.windowSize}  rare-records=${snap.rareRecords}`,
    )
    out.push(
      `  subjects      : rare=${snap.rareSubjects}/${snap.totalSubjects}  threshold=≤${snap.rareThreshold}`,
    )
    out.push(
      `  avg score     : rare=${fmtAvg(snap.rareAvgScore)}  non-rare=${fmtAvg(
        snap.nonRareAvgScore,
      )}`,
    )
    if (snap.topRareSamples.length > 0) {
      out.push(`  top rare (worst-first):`)
      for (const r of snap.topRareSamples) {
        out.push(
          `    - ${r.subjectIdHash}  count=${r.count}  avgScore=${r.avgScore.toFixed(3)}`,
        )
      }
    }
    out.push('')
    out.push(
      `shadow-only: snapshot appended to rare-sample.ndjson; tuned weights unchanged.`,
    )
    if (snap.belowFloor) {
      out.push(
        `next step   : consider /evolve-meta --apply if the advisor proposes a rebalanced weight set.`,
      )
    }
    return { type: 'text', value: out.join('\n') }
  }

  // default --status
  const recent = guardMod.recentRareSampleSnapshots(1)
  const out: string[] = []
  out.push('rare-sample status (shadow-only)')
  if (recent.length === 0) {
    out.push(
      '  (no snapshot yet — run /evolve-rare-check --analyze to create one)',
    )
    return { type: 'text', value: out.join('\n') }
  }
  const last = recent[recent.length - 1]!
  const badge = last.belowFloor ? 'below-floor⚠' : 'ok'
  out.push(`  last snapshot : ${last.ts}`)
  out.push(
    `  share         : ${fmtShare(last.rareShare)} vs target ≥${fmtShare(
      last.targetShare,
    )}   [${badge}]`,
  )
  out.push(`  window        : ${last.windowSize}  rare-records=${last.rareRecords}`)
  out.push(
    `  subjects      : rare=${last.rareSubjects}/${last.totalSubjects}  threshold=≤${last.rareThreshold}`,
  )
  out.push(
    `  avg score     : rare=${fmtAvg(last.rareAvgScore)}  non-rare=${fmtAvg(last.nonRareAvgScore)}`,
  )
  if (last.belowFloor) {
    out.push('')
    out.push(
      `advisor       : rare share below target — long-tail tasks are underweighted.`,
    )
    out.push(
      `next step     : run /evolve-rare-check --analyze for fresh snapshot,`,
    )
    out.push(
      `                then /evolve-meta --apply after weight rebalance proposal.`,
    )
  }
  return { type: 'text', value: out.join('\n') }
}

const evolveRareCheck = {
  type: 'local',
  name: 'evolve-rare-check',
  description:
    'Kernel v1.0 §6.2 Goodhart #3 entry. --status shows the last rare-sample snapshot; --analyze runs a fresh analyze and appends to rare-sample.ndjson (shadow-only; does NOT change tuned-oracle-weights.json). Use `/evolve-meta --apply` to actually adopt a rebalanced weight proposal.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveRareCheck
