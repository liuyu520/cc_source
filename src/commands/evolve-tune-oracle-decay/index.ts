/**
 * /evolve-tune-oracle-decay [--apply] [--window N] [--reset] [--disable]
 *
 * autoEvolve(v1.0) — Phase 39:Oracle 权重时间衰减 auto-tuner 入口。
 *
 * 目的
 * ────
 * oracleAggregator 老行为是算术平均:老样本和新样本同权。几个月前的 session
 * 与昨天的同等拉高/压低 manifest.fitness,stable organism 被历史锁死。
 * Phase 39 在 aggregator 接入指数半衰期衰减:
 *   weight(score) = 0.5 ^ ((now - scoredAt) / halfLifeDays)
 * halfLifeDays=0 是 sentinel(关闭衰减,100% 向后兼容),用户通过本命令
 * 主动 opt-in 到正值。
 *
 * 信号
 * ────
 * 从 fitness.ndjson 读窗口内 score,算每条 age,取 p75(75 分位):
 *   - 当前 halfLife = 0:
 *       p75 ≥ 14d → first opt-in,suggested = round_to_step(p75)
 *       p75 < 14d → hold(样本还太新)
 *   - 当前 halfLife > 0:
 *       ratio = p75 / halfLife
 *       ≥ 2.0 → relax +15d
 *       ≤ 0.3 → tighten -15d
 *       中间 → hold
 *
 * 全部 clamp 在 [HALF_LIFE_MIN=7, HALF_LIFE_MAX=365];样本不足
 * (count < 10)→ insufficient。
 *
 * 用法
 * ────
 *   /evolve-tune-oracle-decay
 *       → dry-run(默认 500 样本窗口),打印统计 + 建议
 *   /evolve-tune-oracle-decay --window 200
 *       → 缩小样本窗口(只看近 200 条 score)
 *   /evolve-tune-oracle-decay --apply
 *       → 写 oracle/tuned-oracle-decay.json,oracleAggregator 下次
 *         aggregate 立即 pickup(mtime 缓存)
 *   /evolve-tune-oracle-decay --disable
 *       → 写入 halfLifeDays=0(等价关闭衰减,保留文件作为 audit 记录)
 *   /evolve-tune-oracle-decay --reset
 *       → 删 tuned-oracle-decay.json,回退 DEFAULT(halfLifeDays=0)
 *
 * 安全
 * ────
 *   - dry-run 纯读
 *   - insufficient 时 --apply 跳过,保护已有文件
 *   - suggested 值 clamp + step-aligned(HALF_LIFE_STEP=15)
 *   - halfLifeDays=0 即关闭衰减,随时可 --disable 或 --reset 回退
 *
 * 与其它 /evolve-tune*:
 *   - /evolve-tune:oracle 阈值(win/loss/adv/perfect)—— 离散
 *   - /evolve-tune-joint:联合调 /evolve-tune + /evolve-meta
 *   - /evolve-tune-promotion:promotion tier 阈值 —— 离散
 *   - /evolve-tune-archive:auto-stale 阈值 —— 离散
 *   - /evolve-tune-oracle-decay:oracle 聚合的连续加权函数(本命令)
 *   五者职责清晰分片,写各自的 tuned-*.json。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune-oracle-decay [--apply] [--window N] [--reset] [--disable]
    - (no flags):    dry-run with 500-sample window, print suggestion
    - --window N:    sample window size (default 500, 1..10000)
    - --apply:       persist suggestion to oracle/tuned-oracle-decay.json
    - --disable:     explicit opt-out: write halfLifeDays=0 (keeps audit record)
    - --reset:       delete tuned file (revert to DEFAULT sentinel halfLifeDays=0)`

interface ParsedFlags {
  apply: boolean
  reset: boolean
  disable: boolean
  windowSamples: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    reset: false,
    disable: false,
    windowSamples: 500,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--reset') {
      out.reset = true
    } else if (t === '--disable') {
      out.disable = true
    } else if (t === '--window' || t === '-w') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = `--window requires a number (e.g. --window 500)`
        return out
      }
      const n = Number.parseInt(next, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 10000) {
        out.error = `--window must be a positive integer 1..10000 (got "${next}")`
        return out
      }
      out.windowSamples = n
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
  const exclusiveCount = [out.apply, out.reset, out.disable].filter(Boolean).length
  if (exclusiveCount > 1) {
    out.error = '--apply / --reset / --disable are mutually exclusive'
  }
  return out
}

function renderSuggestionTable(
  rows: Array<{
    name: string
    current: number
    suggested: number
    rationale: string
  }>,
): string[] {
  if (rows.length === 0) return ['  (no rows)']
  const NAMES = rows.map(r => r.name)
  const maxName = Math.max(...NAMES.map(n => n.length), 12)
  const lines: string[] = []
  lines.push(
    `  ${'name'.padEnd(maxName)}  ${'current'.padStart(8)}  ${'suggested'.padStart(10)}  delta`,
  )
  lines.push('  ' + '-'.repeat(maxName) + '  --------  ----------  -----')
  for (const r of rows) {
    const deltaRaw = r.suggested - r.current
    const delta =
      Math.abs(deltaRaw) < 1e-6
        ? '(unchanged)'
        : deltaRaw > 0
          ? `+${deltaRaw.toFixed(0)}`
          : `${deltaRaw.toFixed(0)}`
    lines.push(
      `  ${r.name.padEnd(maxName)}  ${String(r.current).padStart(8)}  ${String(r.suggested).padStart(10)}  ${delta}`,
    )
  }
  return lines
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) {
    return { type: 'text', value: parsed.error }
  }

  const tunerMod = await import(
    '../../services/autoEvolve/oracle/oracleDecayTuner.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --reset 分支 ────────────────────────────────────────────────
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedOracleDecayPath()
    const lines: string[] = []
    lines.push(`## autoEvolve Oracle Decay Auto-Tuner — Reset (Phase 39)`)
    lines.push('')
    if (!existsSync(path)) {
      lines.push(`  no tuned-oracle-decay.json at ${path}; nothing to reset.`)
      lines.push(
        `  oracleAggregator is already using DEFAULT (halfLifeDays=0, feature off).`,
      )
    } else {
      try {
        unlinkSync(path)
        tunerMod._resetTunedOracleDecayCacheForTest()
        lines.push(`  removed ${path}`)
        lines.push(
          `  oracleAggregator will fall back to DEFAULT sentinel (halfLifeDays=0) on next aggregate.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --disable 分支 ──────────────────────────────────────────────
  if (parsed.disable) {
    const lines: string[] = []
    lines.push(`## autoEvolve Oracle Decay Auto-Tuner — Disable (Phase 39)`)
    lines.push('')
    try {
      tunerMod.saveTunedOracleDecay({
        version: 1,
        updatedAt: new Date().toISOString(),
        halfLifeDays: 0,
      })
      lines.push(`  wrote halfLifeDays=0 to ${pathsMod.getTunedOracleDecayPath()}`)
      lines.push(
        `  time-decay is now explicitly OFF; oracleAggregator uses arithmetic mean again.`,
      )
      lines.push(
        `  audit: file kept (not deleted) so "explicit opt-out" is distinguishable from "never touched". Run --reset to wipe.`,
      )
    } catch (e) {
      lines.push(`  !! write failed: ${(e as Error).message}`)
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── suggestion dry-run / --apply 共用计算 ───────────────────────
  const suggestion = tunerMod.computeOracleDecayTuningSuggestion(
    parsed.windowSamples,
  )

  const lines: string[] = []
  lines.push(`## autoEvolve Oracle Decay Auto-Tuner (Phase 39)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-oracle-decay.json)' : 'dry-run (no write)'}`,
  )
  lines.push(`sample window: last ${parsed.windowSamples} score(s)`)
  lines.push(`actual count: ${suggestion.windowSampleCount}`)
  lines.push(
    `current halfLifeDays: ${suggestion.currentHalfLife}${suggestion.currentHalfLife === 0 ? ' (sentinel: decay OFF)' : 'd'}`,
  )
  if (suggestion.windowSampleCount > 0) {
    lines.push(
      `sample age p25=${suggestion.p25AgeDays.toFixed(1)}d  p50=${suggestion.p50AgeDays.toFixed(1)}d  p75=${suggestion.p75AgeDays.toFixed(1)}d`,
    )
  }
  lines.push('')

  if (suggestion.insufficientReason) {
    lines.push(`!! insufficient data: ${suggestion.insufficientReason}`)
    lines.push(`   nothing to apply; existing tuned file (if any) untouched.`)
    lines.push('')
  }

  if (suggestion.rows.length > 0) {
    lines.push('Suggestion:')
    for (const ln of renderSuggestionTable(suggestion.rows)) lines.push(ln)
    lines.push('')
    lines.push('Rationale:')
    for (const r of suggestion.rows) {
      lines.push(`  - ${r.name}: ${r.rationale}`)
    }
    lines.push('')
  }

  if (!parsed.apply) {
    lines.push(
      `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedOracleDecayPath()}).`,
    )
    lines.push(`To explicit opt-out (decay OFF, keep audit): \`--disable\`.`)
    lines.push(`To wipe existing tuned file: \`--reset\`.`)
    return { type: 'text', value: lines.join('\n') }
  }

  if (suggestion.insufficientReason) {
    lines.push(
      `--apply skipped due to insufficient data; existing tuned-oracle-decay.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  const next = tunerMod.suggestionToNext(suggestion)
  try {
    tunerMod.saveTunedOracleDecay(next)
    lines.push('Apply result:')
    lines.push(`  wrote ${pathsMod.getTunedOracleDecayPath()}`)
    lines.push(`  updatedAt: ${next.updatedAt}`)
    lines.push(`  new halfLifeDays: ${next.halfLifeDays}d`)
    lines.push(
      `  oracleAggregator will pick up new weighting on next aggregate (mtime cache).`,
    )
  } catch (e) {
    lines.push(`  !! write failed: ${(e as Error).message}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveTuneOracleDecay = {
  type: 'local',
  name: 'evolve-tune-oracle-decay',
  description:
    'Phase 39 oracle time-decay auto-tuner. Injects exponential half-life weighting into oracleAggregator so recent samples dominate manifest.fitness.avg while old samples fade. Reads recent FitnessScore from fitness.ndjson, computes p75 age, suggests halfLifeDays via first-opt-in or ±15d adjustment. halfLifeDays=0 is backward-compat sentinel (decay OFF). Dry-run by default; --apply writes tuned-oracle-decay.json; --disable writes 0 (explicit opt-out, audit kept); --reset deletes the file.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTuneOracleDecay
