/**
 * /evolve-tune-joint <subcommand>
 *
 * autoEvolve(v1.0) — Phase 36:Phase 24 + Phase 27 联合调优协调器的命令壳。
 *
 * 背景
 * ────
 * /evolve-tune 单独调阈值,/evolve-meta 单独调权重 —— 两者都从 fitness
 * ledger 读数。问题是当用户先后 apply 两边,阈值变了会立刻改变权重的
 * SNR 输入(见 jointTuningCoordinator.ts 文件头),下一窗口的信号就混
 * 了两个变量的移动。本命令把两个调优视为**一次规划**:
 *
 *   1. 调用 planJointTuning —— 算阈值建议 + 权重建议,归类 interaction
 *      (both-insufficient / threshold-only / weights-only / cooperative /
 *      big-shake)。
 *   2. dry-run(默认):把 plan 渲染成一张可读的表 —— 阈值 rows、权重 rows、
 *      strategy、damp factor、notes,不动磁盘。
 *   3. --apply:在 env gate 放行后执行 applyJointTuningPlan;打印实际
 *      wrote* / damped* 结果。
 *   4. --reset:删 tuned-thresholds.json + tuned-oracle-weights.json 两份,
 *      回到 DEFAULTS。需要确认。
 *
 * 子命令:
 *   /evolve-tune-joint                 dry-run 默认 30 天窗
 *   /evolve-tune-joint --window 14     自定义窗口
 *   /evolve-tune-joint --apply         真写
 *   /evolve-tune-joint --apply --window 7
 *   /evolve-tune-joint --reset --confirm  重置(需要 --confirm)
 *
 * env gate(写入类动作 = --apply / --reset):
 *   CLAUDE_EVOLVE_JOINT=on(最强)
 *     或 CLAUDE_EVOLVE_TUNE + CLAUDE_EVOLVE_META 都 on
 *     或 CLAUDE_EVOLVE=on 兜底
 *   默认 off —— 联合写 blast radius 比单边大,保守。
 *
 * dry-run 不吃 gate(纯读,审计友好)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune-joint [--window N]
      dry-run: plan the joint tuning (both thresholds + oracle weights)
      over the last N days of fitness ledger. Always read-only.
      default N=30

  /evolve-tune-joint --apply [--window N]
      actually write tuned-thresholds.json and/or tuned-oracle-weights.json
      according to the plan. Requires CLAUDE_EVOLVE_JOINT=on, or both
      CLAUDE_EVOLVE_TUNE=on AND CLAUDE_EVOLVE_META=on, or CLAUDE_EVOLVE=on.

  /evolve-tune-joint --reset --confirm
      delete both tuned files, restore DEFAULT_TUNED_THRESHOLDS +
      DEFAULT_TUNED_ORACLE_WEIGHTS. Requires --confirm and gate on.

  Pass --help to see this again.`

interface ParsedFlags {
  apply: boolean
  reset: boolean
  confirm: boolean
  windowDays: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    reset: false,
    confirm: false,
    windowDays: 30,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--apply':
        out.apply = true
        break
      case '--reset':
        out.reset = true
        break
      case '--confirm':
        out.confirm = true
        break
      case '--window': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--window requires a positive integer (days)'
          return out
        }
        const n = Number(next)
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 3650) {
          out.error = `--window must be a positive integer in [1..3650], got "${next}"`
          return out
        }
        out.windowDays = n
        i++
        break
      }
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        out.error = `Unknown flag "${t}"\n\n${USAGE}`
        return out
    }
  }
  if (out.apply && out.reset) {
    out.error = '--apply and --reset cannot be combined'
  }
  return out
}

/** 把数字格式化到 3 位小数;NaN / null 打印 "-" */
function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return n.toFixed(3)
}

/** 把带符号 delta 格式化(+0.123 / -0.045) */
function fmtDelta(d: number): string {
  if (!Number.isFinite(d)) return '-'
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d.toFixed(3)}`
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 动态 import —— 匹配现有 evolve-* 命令模式,便于 bundler tree-shake 测试模块
  const coord = await import(
    '../../services/autoEvolve/oracle/jointTuningCoordinator.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  const lines: string[] = []
  lines.push(`## autoEvolve Joint Tuning — Phase 36`)
  lines.push('')

  // ── --reset ─────────────────────────────────────────
  if (parsed.reset) {
    if (!parsed.confirm) {
      lines.push(
        `reset requires --confirm (it deletes tuned-thresholds.json and tuned-oracle-weights.json).`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    if (!coord.isJointTuneWriteEnabled()) {
      lines.push(
        `attempted: false  |  reason: env gate is off (need CLAUDE_EVOLVE_JOINT=on, or both CLAUDE_EVOLVE_TUNE=on + CLAUDE_EVOLVE_META=on, or CLAUDE_EVOLVE=on)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    const fs = await import('node:fs')
    const tPath = pathsMod.getTunedThresholdsPath()
    const wPath = pathsMod.getTunedOracleWeightsPath()
    let removedT = false
    let removedW = false
    try {
      if (fs.existsSync(tPath)) {
        fs.rmSync(tPath)
        removedT = true
      }
    } catch (e) {
      lines.push(`failed to remove ${tPath}: ${e}`)
    }
    try {
      if (fs.existsSync(wPath)) {
        fs.rmSync(wPath)
        removedW = true
      }
    } catch (e) {
      lines.push(`failed to remove ${wPath}: ${e}`)
    }
    lines.push(
      `reset: thresholds=${removedT ? 'removed' : 'not present'}  |  weights=${removedW ? 'removed' : 'not present'}`,
    )
    lines.push(
      `hint: next /evolve-tune-joint will re-plan from DEFAULT_TUNED_THRESHOLDS + DEFAULT_TUNED_ORACLE_WEIGHTS.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // ── 规划 ─────────────────────────────────────────
  const plan = coord.planJointTuning(parsed.windowDays)

  lines.push(
    `window: last ${plan.windowDays} day(s)  |  interaction: ${plan.interaction}  |  strategy: ${plan.strategy}  |  damp=${plan.dampFactor.toFixed(2)}`,
  )
  lines.push('')

  // thresholds block
  lines.push('### thresholds (Phase 24)')
  lines.push(
    `  dataPoints=${plan.thresholdSuggestion.dataPoints}  positives=${plan.thresholdSuggestion.positiveCount}  negatives=${plan.thresholdSuggestion.negativeCount}  insufficient=${plan.thresholdSuggestion.insufficientReason ? 'yes' : 'no'}`,
  )
  if (plan.thresholdSuggestion.insufficientReason) {
    lines.push(`  reason: ${plan.thresholdSuggestion.insufficientReason}`)
  }
  if (plan.thresholdSuggestion.rows.length > 0) {
    lines.push(
      `  ${'name'.padEnd(24)}  ${'current'.padStart(8)}  ${'suggested'.padStart(10)}  ${'delta'.padStart(8)}  rationale`,
    )
    lines.push(
      '  ' + '-'.repeat(24) + '  ' + '-'.repeat(8) + '  ' + '-'.repeat(10) + '  ' + '-'.repeat(8) + '  ' + '-'.repeat(30),
    )
    for (const r of plan.thresholdSuggestion.rows) {
      lines.push(
        `  ${r.name.padEnd(24)}  ${fmt(r.current).padStart(8)}  ${fmt(r.suggested).padStart(10)}  ${fmtDelta(r.suggested - r.current).padStart(8)}  ${r.rationale}`,
      )
    }
  }
  lines.push(
    `  norms: deltaNorm=${plan.thresholdDeltaNorm.toFixed(4)}  deltaMax=${plan.thresholdDeltaMax.toFixed(4)}  ready=${plan.thresholdReady}`,
  )
  lines.push('')

  // weights block
  lines.push('### oracle weights (Phase 27)')
  lines.push(
    `  dataPoints=${plan.weightSuggestion.dataPoints}  wins=${plan.weightSuggestion.winCount}  losses=${plan.weightSuggestion.lossCount}  insufficient=${plan.weightSuggestion.insufficientReason ? 'yes' : 'no'}`,
  )
  if (plan.weightSuggestion.insufficientReason) {
    lines.push(`  reason: ${plan.weightSuggestion.insufficientReason}`)
  }
  if (plan.weightSuggestion.rows.length > 0) {
    lines.push(
      `  ${'name'.padEnd(18)}  ${'current'.padStart(8)}  ${'suggested'.padStart(10)}  ${'delta'.padStart(8)}  ${'snr'.padStart(7)}  rationale`,
    )
    lines.push(
      '  ' + '-'.repeat(18) + '  ' + '-'.repeat(8) + '  ' + '-'.repeat(10) + '  ' + '-'.repeat(8) + '  ' + '-'.repeat(7) + '  ' + '-'.repeat(30),
    )
    for (const r of plan.weightSuggestion.rows) {
      lines.push(
        `  ${r.name.padEnd(18)}  ${fmt(r.current).padStart(8)}  ${fmt(r.suggested).padStart(10)}  ${fmtDelta(r.suggested - r.current).padStart(8)}  ${fmt(r.snr).padStart(7)}  ${r.rationale}`,
      )
    }
  }
  lines.push(
    `  norms: deltaNorm=${plan.weightDeltaNorm.toFixed(4)}  deltaMax=${plan.weightDeltaMax.toFixed(4)}  ready=${plan.weightReady}`,
  )
  lines.push('')

  // notes block
  lines.push('### plan notes')
  for (const n of plan.notes) lines.push(`  - ${n}`)
  lines.push('')

  // ── --apply ─────────────────────────────────────
  if (parsed.apply) {
    if (!coord.isJointTuneWriteEnabled()) {
      lines.push(
        `attempted: false  |  reason: env gate is off (need CLAUDE_EVOLVE_JOINT=on, or both CLAUDE_EVOLVE_TUNE=on + CLAUDE_EVOLVE_META=on, or CLAUDE_EVOLVE=on)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    const result = coord.applyJointTuningPlan(plan)
    lines.push('### apply result')
    lines.push(
      `  actualStrategy=${result.strategy}  wroteThresholds=${result.wroteThresholds}  wroteWeights=${result.wroteWeights}`,
    )
    for (const n of result.notes) lines.push(`  - ${n}`)
    if (result.dampedWeights && result.dampedWeights.length > 0) {
      lines.push('')
      lines.push('  damped weights (raw → damped):')
      for (const d of result.dampedWeights) {
        lines.push(
          `    ${d.name.padEnd(20)} raw=${d.raw.toFixed(3)}  damped=${d.damped.toFixed(3)}`,
        )
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // dry-run 末尾 hint
  lines.push(
    `hint: pass --apply to execute the plan. Requires CLAUDE_EVOLVE_JOINT=on (or both TUNE+META on, or CLAUDE_EVOLVE=on).`,
  )
  return { type: 'text', value: lines.join('\n') }
}

const evolveTuneJoint = {
  type: 'local',
  name: 'evolve-tune-joint',
  description:
    'Phase 36 joint tuning coordinator. Plans thresholds (Phase 24) + oracle weights (Phase 27) in a single call, detects big-shake rounds (both sides moving fast) and applies damping on the weight side. --window picks the fitness-ledger window (default 30 days); --apply writes per the plan; --reset deletes both tuned files (needs --confirm). Requires CLAUDE_EVOLVE_JOINT=on (or CLAUDE_EVOLVE_TUNE+META, or CLAUDE_EVOLVE=on) for writes; dry-run is always read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTuneJoint
