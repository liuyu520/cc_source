/**
 * /evolve-tune-rollback-thresholds [--apply] [--reset] [--limit N]
 *
 * autoEvolve(v1.0) — Phase 41:Rollback 阈值自适应 tuner 命令入口。
 *
 * 目的
 * ────
 * Phase 40 的 rollbackWatchdog 硬编码 6 个阈值(canary -0.3/3/3d;
 * stable -0.2/5/7d)。长期使用后会出现两类偏差:
 *   - 误降级(FP):rollback 的 organism 回 shadow 后很快 fitness 回升
 *   - 漏降级(FN):canary/stable 里 avg 低于阈值但被 trials/age 门槛挡住
 *
 * Phase 41 命令扫 promotions.ndjson 的 auto-rollback 历史 + 对应时段
 * fitness.ndjson 的 score,算 FP rate;再调 scanRollbackCandidates 拿
 * 当前 evaluation,算 FN rate;综合两路信号给出每 status 的 tighten/
 * relax/hold/insufficient 决策,dry-run 打印,--apply 写盘。
 *
 * 信号
 * ────
 *   FP:每条 rollback 事件在窗口 [rollbackAt, rollbackAt+14d] 找该
 *       organismId 的 FitnessScore,avg > 0 → false positive
 *   FN:当前 canary/stable 的 decision=hold 里,avg 已过线(≤ avgMax)但
 *       trials/age 门槛拦下的组织占比
 *
 *   决策规则:
 *     样本 < 5(MIN_SAMPLES_TO_TUNE) → insufficient
 *     fpRate ≥ 0.5 且 fnRate < 0.3  → tighten(avgMax -=0.05, trials+=1, age+=1)
 *     fpRate ≤ 0.1 且 fnRate ≥ 0.3  → relax (avgMax +=0.05, trials-=1, age-=1)
 *     其他                           → hold
 *
 *   clamp:avgMax∈[-0.7,-0.05]  trials∈[1,20]  ageDays∈[1,30]
 *
 * 用法
 * ────
 *   /evolve-tune-rollback-thresholds
 *       → dry-run;打印 canary + stable 两个 band 的信号 + 决策 + 新值
 *   /evolve-tune-rollback-thresholds --limit 2000
 *       → 缩小 transitions/fitness 读取窗口(默认 5000)
 *   /evolve-tune-rollback-thresholds --apply
 *       → 写 oracle/tuned-rollback-thresholds.json;rollbackWatchdog 下次
 *         evaluate 立即 pickup(mtime 缓存)
 *   /evolve-tune-rollback-thresholds --reset
 *       → 删 tuned-rollback-thresholds.json;watchdog 回 DEFAULT
 *         (= Phase 40 硬编码值)
 *
 * 安全
 * ────
 *   - dry-run 纯读
 *   - insufficient 时 --apply 跳过,保护已有文件
 *   - tighten/relax 步长极小(avgMax ±0.05,trials ±1,ageDays ±1),
 *     避免单次 tuning 过度偏移;连续跑能逐步逼近最优
 *   - clamp 护栏确保即使 runaway 也不会退化到荒谬值
 *   - DEFAULT 与 Phase 40 硬编码一致,--reset 与从未运行过 tuner 行为相同
 *
 * 与其它 /evolve-tune*:
 *   - /evolve-tune:oracle 阈值(win/loss/adv/perfect)—— 离散
 *   - /evolve-tune-promotion:promotion tier 阈值(shadow→canary→stable)—— 离散
 *   - /evolve-tune-archive:auto-stale 阈值(stable→archived)—— 离散
 *   - /evolve-tune-oracle-decay:oracle 聚合连续加权(halfLifeDays)
 *   - /evolve-tune-rollback-thresholds:rollback 阈值(canary/stable→shadow)—— 离散(本命令)
 *   五者职责清晰分片,写各自的 tuned-*.json。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune-rollback-thresholds [--apply] [--reset] [--limit N]
    - (no flags):    dry-run, print signals + suggestion for canary/stable
    - --limit N:     transitions/fitness read window (default 5000, 1..20000)
    - --apply:       persist suggestion to oracle/tuned-rollback-thresholds.json
    - --reset:       delete tuned file (revert to Phase 40 hardcoded DEFAULT)`

interface ParsedFlags {
  apply: boolean
  reset: boolean
  limit: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    reset: false,
    limit: 5000,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--reset') {
      out.reset = true
    } else if (t === '--limit' || t === '-l') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = `--limit requires a number (e.g. --limit 2000)`
        return out
      }
      const n = Number.parseInt(next, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 20000) {
        out.error = `--limit must be a positive integer 1..20000 (got "${next}")`
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
  // 互斥校验
  if (out.apply && out.reset) {
    out.error = '--apply and --reset are mutually exclusive'
  }
  return out
}

interface BandForRender {
  status: 'canary' | 'stable'
  decision: string
  current: { avgMax: number; minTrials: number; minAgeDays: number }
  next: { avgMax: number; minTrials: number; minAgeDays: number }
  signals: {
    rollbackSamples: number
    fpCount: number
    fpRate: number
    fnCandidates: number
    fnRate: number
  }
  rationale: string
}

function renderBand(b: BandForRender): string[] {
  const deltaAvg = b.next.avgMax - b.current.avgMax
  const deltaTrials = b.next.minTrials - b.current.minTrials
  const deltaAge = b.next.minAgeDays - b.current.minAgeDays
  const fmtDelta = (v: number, digits = 2) => {
    if (Math.abs(v) < 1e-6) return '(unchanged)'
    const s = v > 0 ? `+${v.toFixed(digits)}` : v.toFixed(digits)
    return s
  }
  const lines: string[] = []
  lines.push(`  [${b.status.toUpperCase()}]  decision=${b.decision}`)
  lines.push(
    `       signals: rollbackSamples=${b.signals.rollbackSamples}  fpCount=${b.signals.fpCount}  fpRate=${b.signals.fpRate.toFixed(2)}  fnCandidates=${b.signals.fnCandidates}  fnRate=${b.signals.fnRate.toFixed(2)}`,
  )
  lines.push(
    `       avgMax:     ${b.current.avgMax.toFixed(2).padStart(6)}  →  ${b.next.avgMax.toFixed(2).padStart(6)}   ${fmtDelta(deltaAvg)}`,
  )
  lines.push(
    `       minTrials:  ${String(b.current.minTrials).padStart(6)}  →  ${String(b.next.minTrials).padStart(6)}   ${fmtDelta(deltaTrials, 0)}`,
  )
  lines.push(
    `       minAgeDays: ${String(b.current.minAgeDays).padStart(6)}  →  ${String(b.next.minAgeDays).padStart(6)}   ${fmtDelta(deltaAge, 0)}`,
  )
  lines.push(`       rationale: ${b.rationale}`)
  return lines
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) {
    return { type: 'text', value: parsed.error }
  }

  const tunerMod = await import(
    '../../services/autoEvolve/oracle/rollbackThresholdTuner.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')
  const watchdogMod = await import(
    '../../services/autoEvolve/emergence/rollbackWatchdog.js'
  )
  const fsmMod = await import('../../services/autoEvolve/arena/promotionFsm.js')
  const fitnessMod = await import(
    '../../services/autoEvolve/oracle/fitnessOracle.js'
  )

  // ── --reset 分支 ────────────────────────────────────────────────
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedRollbackThresholdsPath()
    const lines: string[] = []
    lines.push(
      `## autoEvolve Rollback Threshold Auto-Tuner — Reset (Phase 41)`,
    )
    lines.push('')
    if (!existsSync(path)) {
      lines.push(
        `  no tuned-rollback-thresholds.json at ${path}; nothing to reset.`,
      )
      lines.push(
        `  rollbackWatchdog is already using Phase 40 DEFAULT (-0.3/3/3d & -0.2/5/7d).`,
      )
    } else {
      try {
        unlinkSync(path)
        tunerMod.clearTunedRollbackThresholdsCache()
        lines.push(`  removed ${path}`)
        lines.push(
          `  rollbackWatchdog will fall back to Phase 40 DEFAULT on next evaluate.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── dry-run / --apply 共用计算 ──────────────────────────────────

  // 1) 读当前 tuned + 历史 transitions + fitness
  const currentTuned = tunerMod.loadTunedRollbackThresholds()
  const transitions = fsmMod.readRecentTransitions(parsed.limit)
  const fitnessScores = fitnessMod.recentFitnessScores(parsed.limit)

  // 2) 跑当前 scan 拿 evaluations(FN 信号源)
  const scan = watchdogMod.scanRollbackCandidates()

  // 3) 送进 tuner 算 suggestion
  const suggestion = tunerMod.computeRollbackThresholdTuningSuggestion({
    currentTuned,
    rollbackTransitions: transitions,
    fitnessScores,
    evaluations: scan.evaluations.map(e => ({
      fromStatus: e.fromStatus,
      aggregate: { avg: e.aggregate.avg, trials: e.aggregate.trials },
      ageSincePromotionDays: e.ageSincePromotionDays,
      thresholds: e.thresholds,
      decision: e.decision,
    })),
  })

  const lines: string[] = []
  lines.push(`## autoEvolve Rollback Threshold Auto-Tuner (Phase 41)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-rollback-thresholds.json)' : 'dry-run (no write)'}`,
  )
  lines.push(
    `data window: transitions=${transitions.length} (limit=${parsed.limit}), fitnessScores=${fitnessScores.length} (limit=${parsed.limit})`,
  )
  lines.push(
    `current scan: canary=${scan.scannedCanary} stable=${scan.scannedStable} (rollback=${scan.rollbackCount} hold=${scan.holdCount})`,
  )
  lines.push('')
  lines.push('Current tuned file:')
  lines.push(
    `  canary{avgMax=${currentTuned.canary.avgMax}, minTrials=${currentTuned.canary.minTrials}, minAgeDays=${currentTuned.canary.minAgeDays}}`,
  )
  lines.push(
    `  stable{avgMax=${currentTuned.stable.avgMax}, minTrials=${currentTuned.stable.minTrials}, minAgeDays=${currentTuned.stable.minAgeDays}}`,
  )
  lines.push(`  updatedAt: ${currentTuned.updatedAt}`)
  lines.push('')
  lines.push('Suggestion:')
  for (const ln of renderBand(suggestion.canary as BandForRender)) lines.push(ln)
  for (const ln of renderBand(suggestion.stable as BandForRender)) lines.push(ln)
  lines.push('')

  const anyChange =
    suggestion.canary.decision === 'tighten' ||
    suggestion.canary.decision === 'relax' ||
    suggestion.stable.decision === 'tighten' ||
    suggestion.stable.decision === 'relax'

  if (!parsed.apply) {
    if (anyChange) {
      lines.push(
        `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedRollbackThresholdsPath()}).`,
      )
    } else {
      lines.push(
        `No band recommends change (both insufficient/hold); nothing to apply.`,
      )
    }
    lines.push(`To wipe existing tuned file: \`--reset\`.`)
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply
  if (!anyChange) {
    lines.push(
      `--apply skipped: both bands insufficient/hold; existing tuned-rollback-thresholds.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  try {
    tunerMod.saveTunedRollbackThresholds(suggestion.nextTuned)
    lines.push('Apply result:')
    lines.push(`  wrote ${pathsMod.getTunedRollbackThresholdsPath()}`)
    lines.push(`  updatedAt: ${suggestion.nextTuned.updatedAt}`)
    lines.push(
      `  new canary: avgMax=${suggestion.nextTuned.canary.avgMax} minTrials=${suggestion.nextTuned.canary.minTrials} minAgeDays=${suggestion.nextTuned.canary.minAgeDays}`,
    )
    lines.push(
      `  new stable: avgMax=${suggestion.nextTuned.stable.avgMax} minTrials=${suggestion.nextTuned.stable.minTrials} minAgeDays=${suggestion.nextTuned.stable.minAgeDays}`,
    )
    lines.push(
      `  rollbackWatchdog will pick up new thresholds on next evaluateRollback (mtime cache).`,
    )
  } catch (e) {
    lines.push(`  !! write failed: ${(e as Error).message}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveTuneRollbackThresholds = {
  type: 'local',
  name: 'evolve-tune-rollback-thresholds',
  description:
    'Phase 41 rollback threshold auto-tuner. Reads past auto-rollback transitions + post-rollback fitness scores (false-positive rate) and current canary/stable evaluations (false-negative rate) to tighten/relax the 6 rollbackWatchdog thresholds (canary avgMax/minTrials/minAgeDays; stable ditto). Dry-run by default; --apply writes oracle/tuned-rollback-thresholds.json; --reset deletes the file (revert to Phase 40 hardcoded DEFAULT -0.3/3/3d & -0.2/5/7d). Step: ±0.05 avg, ±1 trials, ±1 days per run; clamp [-0.7..-0.05] × [1..20] × [1..30].',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTuneRollbackThresholds
