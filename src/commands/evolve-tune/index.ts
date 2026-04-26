/**
 * /evolve-tune [--apply] [--window DAYS] [--reset]
 *
 * autoEvolve(v1.0) — Phase 24:threshold auto-tuner 入口。
 *
 * 目的:
 *   autoPromotionEngine / oracleAggregator / goodhartGuard 的 4 个硬编码阈值
 *   (oracleAdverseAvg / organismWinThreshold / organismLossThreshold /
 *   goodhartPerfectAvgMin)可能与当前用户、当前模型 的真实 fitness 分布
 *   脱节。本命令允许按"最近 N 天的 fitness.ndjson 分位数"推断更合理的
 *   阈值,并把结果落盘到 oracle/tuned-thresholds.json。所有消费模块都通过
 *   loadTunedThresholds() 热读这份 JSON。
 *
 * 用法:
 *   /evolve-tune
 *       → 默认 30 天窗口的 dry-run,打印建议表 + 每条建议的 rationale,
 *         **不写盘**。这是"看看新阈值合不合理"的标准姿势。
 *   /evolve-tune --window 14
 *       → 把窗口收窄到 14 天(比如模型刚换,老数据没参考意义)
 *   /evolve-tune --apply
 *       → 把当前建议真正写入 tuned-thresholds.json,同时 invalidate 缓存
 *   /evolve-tune --reset
 *       → 删除 tuned-thresholds.json,让所有消费模块回退到硬编码 default
 *
 * 安全:
 *   - dry-run 是 **读-only** 的,绝不写盘
 *   - 数据点不足(<MIN_SAMPLES_FOR_TUNE)时自动降级:print insufficient
 *     reason 并把 suggested=current,即使带 --apply 也不会动 current value
 *   - /evolve-accept 仍能绕过 Goodhart,tuned 不会加严人工通道
 *   - 所有数值都被 clamp 在安全区间(见 thresholdTuner 里的每个 rationale),
 *     避免一次滑坡到 "0.01 就算 win" 之类的退化态
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune [--apply] [--window DAYS] [--reset]
    - (no flags):      dry-run with 30-day window, print suggested thresholds
    - --window DAYS:   width of the fitness history window (default 30)
    - --apply:         persist the suggestion to oracle/tuned-thresholds.json
    - --reset:         delete tuned-thresholds.json (revert to hardcoded defaults)`

interface ParsedFlags {
  apply: boolean
  reset: boolean
  windowDays: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    reset: false,
    windowDays: 30,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--reset') {
      out.reset = true
    } else if (t === '--window' || t === '-w') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = `--window requires a number (e.g. --window 14)`
        return out
      }
      const n = Number.parseInt(next, 10)
      if (!Number.isFinite(n) || n <= 0 || n > 365) {
        out.error = `--window must be a positive integer 1..365 (got "${next}")`
        return out
      }
      out.windowDays = n
      i++
    } else if (t === '--help' || t === '-h') {
      out.error = USAGE
      return out
    } else {
      out.error = `Unknown flag "${t}"\n\n${USAGE}`
      return out
    }
  }
  if (out.apply && out.reset) {
    out.error = '--apply and --reset are mutually exclusive'
  }
  return out
}

/** 把 suggestion 行渲染成固定宽度对齐表,方便 diff 阅读 */
function renderSuggestionTable(
  rows: Array<{
    name: string
    current: number
    suggested: number
    rationale: string
  }>,
): string[] {
  const NAMES = rows.map(r => r.name)
  const maxName = Math.max(...NAMES.map(n => n.length), 12)
  const lines: string[] = []
  // 表头
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
          ? `+${deltaRaw.toFixed(2)}`
          : `${deltaRaw.toFixed(2)}`
    lines.push(
      `  ${r.name.padEnd(maxName)}  ${r.current
        .toFixed(2)
        .padStart(8)}  ${r.suggested.toFixed(2).padStart(10)}  ${delta}`,
    )
  }
  return lines
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) {
    return { type: 'text', value: parsed.error }
  }

  // 懒加载,保持命令 load 成本低
  const tunerMod = await import(
    '../../services/autoEvolve/oracle/thresholdTuner.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --reset 分支:删除 tuned-thresholds.json,回退默认 ─────────────
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedThresholdsPath()
    const lines: string[] = []
    lines.push(`## autoEvolve Threshold Auto-Tuner — Reset (Phase 24)`)
    lines.push('')
    if (!existsSync(path)) {
      lines.push(`  no tuned-thresholds.json at ${path}; nothing to reset.`)
      lines.push(
        `  all consumers are already using DEFAULT_TUNED_THRESHOLDS.`,
      )
    } else {
      try {
        unlinkSync(path)
        tunerMod._resetTunedThresholdsCacheForTest()
        lines.push(`  removed ${path}`)
        lines.push(
          `  all consumers will now fall back to DEFAULT_TUNED_THRESHOLDS on next read.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── suggestion dry-run / --apply 共用计算 ────────────────────────
  const suggestion = tunerMod.computeTuningSuggestion(parsed.windowDays)

  const lines: string[] = []
  lines.push(`## autoEvolve Threshold Auto-Tuner (Phase 24)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-thresholds.json)' : 'dry-run (no write)'}`,
  )
  lines.push(`window: last ${parsed.windowDays} day(s)`)
  lines.push(
    `data points: ${suggestion.dataPoints} ` +
      `(positive=${suggestion.positiveCount}, negative=${suggestion.negativeCount})`,
  )
  if (suggestion.windowFrom) {
    lines.push(`window start: ${suggestion.windowFrom}`)
  }
  lines.push('')

  if (suggestion.insufficientReason) {
    lines.push(`!! insufficient data: ${suggestion.insufficientReason}`)
    lines.push(`   suggested = current for every row; nothing to apply.`)
    lines.push('')
  }

  lines.push('Suggestion:')
  const tableRows = suggestion.rows.map(r => ({
    name: r.name,
    current: r.current,
    suggested: r.suggested,
    rationale: r.rationale,
  }))
  for (const ln of renderSuggestionTable(tableRows)) lines.push(ln)
  lines.push('')
  lines.push('Rationale:')
  for (const r of suggestion.rows) {
    lines.push(`  - ${r.name}: ${r.rationale}`)
  }
  lines.push('')

  if (!parsed.apply) {
    lines.push(
      `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedThresholdsPath()}).`,
    )
    lines.push(
      `To wipe existing tuned values and fall back to hardcoded defaults: \`--reset\`.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply:即便 insufficient 也允许写(写进去的 == current,幂等),
  // 但我们更明智地跳过 —— 避免"空写"把用户手改过的老 tuned 文件覆盖成 default。
  if (suggestion.insufficientReason) {
    lines.push(
      `--apply skipped due to insufficient data; existing tuned-thresholds.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  const next = tunerMod.suggestionToNext(suggestion)
  const res = tunerMod.saveTunedThresholds(next)
  lines.push('Apply result:')
  if (res.ok) {
    lines.push(`  wrote ${res.path}`)
    lines.push(`  updatedAt: ${res.value?.updatedAt}`)
    lines.push(
      `  consumers (autoPromotionEngine / oracleAggregator / goodhartGuard) ` +
        `will pick up the new values on next read (mtime cache).`,
    )
  } else {
    lines.push(`  !! write failed: ${res.error}`)
    lines.push(`  path: ${res.path}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveTune = {
  type: 'local',
  name: 'evolve-tune',
  description:
    'Phase 24 threshold auto-tuner. Suggests percentile-based values for oracleAdverseAvg / organismWin / organismLoss / goodhartPerfectAvgMin from recent fitness history. Dry-run by default; --apply writes oracle/tuned-thresholds.json; --reset deletes it.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTune
