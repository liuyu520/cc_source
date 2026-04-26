/**
 * /evolve-rollback-check [--apply] [--limit N]
 *
 * autoEvolve(v1.0) — Phase 40:Promotion rollback watchdog 命令入口。
 *
 * 目的
 * ────
 * 手工/cron 触发 rollbackWatchdog.scanRollbackCandidates(),扫 canary+stable
 * 两层 organism 并打印谁在阈值下(dry-run);--apply 时对 decision=rollback
 * 的逐个执行 applyRollback(走 promoteOrganism → FSM 反向边 → shadow)。
 *
 * 阈值
 * ────
 * Phase 40 v1 硬编码:
 *   canary: avg≤-0.3  trials≥3   minAge≥3d
 *   stable: avg≤-0.2  trials≥5   minAge≥7d
 * 三重门槛任一不满足都 hold。后续可抽出 tuner(Phase 4x),v1 先观察用户对
 * 误降级/漏降级的反馈再决定。
 *
 * 用法
 * ────
 *   /evolve-rollback-check
 *       → dry-run,打印 scan 摘要 + 每条 evaluation 的 decision/rationale
 *   /evolve-rollback-check --apply
 *       → 对 decision=rollback 的组织执行 applyRollback,回 shadow
 *   /evolve-rollback-check --limit 50
 *       → 只显示前 N 条 evaluation(scan 全量但输出截断,避免刷屏)
 *
 * 安全
 * ────
 *   - dry-run 纯读
 *   - --apply 每条 rollback 都走 FSM (signed transition),失败捕获显示
 *   - 不删数据:organism 搬回 shadow 目录,invocationCount / fitness 累积保留
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-rollback-check [--apply] [--limit N]
    - (no flags):    dry-run scan, print candidates and decisions
    - --apply:       execute rollback (demote canary/stable → shadow) for decision=rollback
    - --limit N:     truncate output to first N evaluations (default 20, 1..500)`

interface ParsedFlags {
  apply: boolean
  limit: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    limit: 20,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--limit' || t === '-l') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = `--limit requires a number (e.g. --limit 50)`
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
    } else {
      out.error = `Unknown flag "${t}"\n\n${USAGE}`
      return out
    }
  }
  return out
}

function formatEvaluation(
  ev: {
    organismId: string
    name: string
    fromStatus: string
    aggregate: { trials: number; avg: number }
    ageSincePromotionDays: number | null
    thresholds: { avgMax: number; minTrials: number; minAgeDays: number }
    decision: string
    rationale: string
  },
  idx: number,
): string[] {
  const lines: string[] = []
  const age =
    ev.ageSincePromotionDays == null
      ? 'unknown'
      : `${ev.ageSincePromotionDays.toFixed(1)}d`
  lines.push(
    `  ${idx}. [${ev.decision.toUpperCase()}] ${ev.fromStatus}/${ev.name} (${ev.organismId})`,
  )
  lines.push(
    `       avg=${ev.aggregate.avg.toFixed(3)} trials=${ev.aggregate.trials} age=${age}  thr{avg≤${ev.thresholds.avgMax}, trials≥${ev.thresholds.minTrials}, age≥${ev.thresholds.minAgeDays}d}`,
  )
  lines.push(`       rationale: ${ev.rationale}`)
  return lines
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) {
    return { type: 'text', value: parsed.error }
  }

  const watchdogMod = await import(
    '../../services/autoEvolve/emergence/rollbackWatchdog.js'
  )

  const scan = watchdogMod.scanRollbackCandidates()

  const lines: string[] = []
  lines.push(`## autoEvolve Promotion Rollback Watchdog (Phase 40)`)
  lines.push('')
  lines.push(`mode: ${parsed.apply ? '**APPLY** (will demote rollback candidates to shadow)' : 'dry-run (no write)'}`)
  lines.push(`scanned: canary=${scan.scannedCanary} stable=${scan.scannedStable}`)
  lines.push(`decisions: rollback=${scan.rollbackCount} hold=${scan.holdCount}`)
  lines.push('')

  if (scan.evaluations.length === 0) {
    lines.push(`  (no canary/stable organisms to evaluate)`)
    return { type: 'text', value: lines.join('\n') }
  }

  // 优先展示 rollback,hold 放后面;同类按 avg 升序(最差的最上面)
  const sorted = [...scan.evaluations].sort((a, b) => {
    if (a.decision !== b.decision) return a.decision === 'rollback' ? -1 : 1
    return a.aggregate.avg - b.aggregate.avg
  })
  const truncated = sorted.slice(0, parsed.limit)

  lines.push(`Evaluations (showing ${truncated.length}/${sorted.length}):`)
  for (let i = 0; i < truncated.length; i++) {
    for (const ln of formatEvaluation(truncated[i], i + 1)) lines.push(ln)
  }
  lines.push('')

  if (!parsed.apply) {
    lines.push(`To execute rollback on all decision=rollback candidates: re-run with \`--apply\`.`)
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply:逐条执行
  lines.push('Apply result:')
  let applied = 0
  let failed = 0
  for (const ev of scan.evaluations) {
    if (ev.decision !== 'rollback') continue
    const res = watchdogMod.applyRollback(ev)
    if (res.ok) {
      applied++
      lines.push(`  ✓ ${ev.fromStatus}→shadow: ${ev.name} (${ev.organismId})`)
    } else {
      failed++
      lines.push(`  ✗ ${ev.fromStatus}→shadow failed: ${ev.name} (${ev.organismId}) — ${res.reason}`)
    }
  }
  lines.push('')
  lines.push(`  applied=${applied} failed=${failed}`)
  return { type: 'text', value: lines.join('\n') }
}

const evolveRollbackCheck = {
  type: 'local',
  name: 'evolve-rollback-check',
  description:
    'Phase 40 promotion rollback watchdog. Scans canary+stable and demotes organisms whose Phase 39 weighted fitness.avg has regressed below threshold (canary: ≤-0.3/trials≥3/age≥3d; stable: ≤-0.2/trials≥5/age≥7d). Rollback goes to shadow (data preserved; second chance). Dry-run by default; --apply executes.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveRollbackCheck
