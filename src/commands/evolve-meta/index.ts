/**
 * /evolve-meta [--apply] [--window DAYS] [--reset]
 *
 * autoEvolve(v1.0) — Phase 27:meta-evolver(Oracle 权重 auto-tuner)入口。
 *
 * 目的:
 *   fitnessOracle 的 4 维加权(userSatisfaction / taskSuccess / codeQuality /
 *   performance)默认 0.4 / 0.3 / 0.15 / 0.1 是 2026-04-22 凭直觉拍的。
 *   不同用户的协作风格差异巨大(有的人几乎不 userConfirm,有的模型 blastRadius
 *   信号极其稳定),这几维对 win/loss 的信噪比(SNR)可能与默认严重不一致。
 *   本命令按"最近 N 天的 fitness.ndjson 里每维 SNR"推断更合理的权重,
 *   并把结果落盘到 oracle/tuned-oracle-weights.json。loadOracleWeights 会
 *   优先热读这份快照,失效后回退 base weights.json,再回退 DEFAULT。
 *
 * 用法:
 *   /evolve-meta
 *       → 30 天窗口 dry-run,打印建议表 + rationale(含 SNR),**不写盘**
 *   /evolve-meta --window 14
 *       → 把窗口收窄到 14 天(适合模型刚换、老数据无参考价值)
 *   /evolve-meta --apply
 *       → 把建议写入 tuned-oracle-weights.json,invalidate metaEvolver 缓存
 *   /evolve-meta --reset
 *       → 删除 tuned-oracle-weights.json,让 loadOracleWeights 回退到
 *         base weights.json 或 DEFAULT_ORACLE_WEIGHTS
 *
 * 安全:
 *   - dry-run 是 **读-only** 的,绝不写盘
 *   - 数据点不足(<MIN_SAMPLES_FOR_META)时自动降级:print insufficient reason
 *     并跳过 --apply 的写盘,避免把可能存在的人工 tuned 值覆盖成 default
 *   - safety 维永远保持 veto 开关,不参与权重加权演化
 *   - 每维在 [0.05, 0.7] 内 clamp:既防垄断也防饿死
 *   - tuned 与 base weights.json 解耦:--reset 只删 tuned,不碰用户手改的
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-meta [--apply] [--window DAYS] [--reset] [--force]
    - (no flags):      dry-run with 30-day window, print suggested oracle weights
    - --window DAYS:   width of the fitness history window (default 30)
    - --apply:         persist the suggestion to oracle/tuned-oracle-weights.json
    - --reset:         delete tuned-oracle-weights.json (revert to base/default weights)
    - --force:         (Phase 28) override the benchmark-drift soft gate on --apply`

interface ParsedFlags {
  apply: boolean
  reset: boolean
  force: boolean
  windowDays: number
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    apply: false,
    reset: false,
    force: false,
    windowDays: 30,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--apply' || t === '-a') {
      out.apply = true
    } else if (t === '--reset') {
      out.reset = true
    } else if (t === '--force') {
      out.force = true
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
    snr: number
  }>,
): string[] {
  const NAMES = rows.map(r => r.name)
  const maxName = Math.max(...NAMES.map(n => n.length), 18)
  const lines: string[] = []
  lines.push(
    `  ${'name'.padEnd(maxName)}  ${'current'.padStart(8)}  ${'suggested'.padStart(10)}  ${'delta'.padStart(9)}  ${'SNR'.padStart(6)}`,
  )
  lines.push(
    '  ' +
      '-'.repeat(maxName) +
      '  --------  ----------  ---------  ------',
  )
  for (const r of rows) {
    const deltaRaw = r.suggested - r.current
    const delta =
      Math.abs(deltaRaw) < 1e-6
        ? '(same)'
        : deltaRaw > 0
          ? `+${deltaRaw.toFixed(3)}`
          : `${deltaRaw.toFixed(3)}`
    lines.push(
      `  ${r.name.padEnd(maxName)}  ${r.current
        .toFixed(3)
        .padStart(8)}  ${r.suggested.toFixed(3).padStart(10)}  ${delta.padStart(9)}  ${r.snr.toFixed(3).padStart(6)}`,
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
  const metaMod = await import(
    '../../services/autoEvolve/oracle/metaEvolver.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --reset 分支:删除 tuned-oracle-weights.json,回退 base/default ───
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedOracleWeightsPath()
    const lines: string[] = []
    lines.push(`## autoEvolve Oracle Meta-Evolver — Reset (Phase 27)`)
    lines.push('')
    if (!existsSync(path)) {
      lines.push(`  no tuned-oracle-weights.json at ${path}; nothing to reset.`)
      lines.push(
        `  loadOracleWeights() already falls back to base weights.json or DEFAULT.`,
      )
    } else {
      try {
        unlinkSync(path)
        metaMod._resetTunedOracleWeightsCacheForTest()
        lines.push(`  removed ${path}`)
        lines.push(
          `  loadOracleWeights() will now fall back to base weights.json or DEFAULT on next read.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── suggestion dry-run / --apply 共用计算 ────────────────────────
  const suggestion = metaMod.computeWeightSuggestion(parsed.windowDays)

  const lines: string[] = []
  lines.push(`## autoEvolve Oracle Meta-Evolver (Phase 27)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-oracle-weights.json)' : 'dry-run (no write)'}`,
  )
  lines.push(`window: last ${parsed.windowDays} day(s)`)
  lines.push(
    `data points: ${suggestion.dataPoints} ` +
      `(wins=${suggestion.winCount}, losses=${suggestion.lossCount})`,
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
    snr: r.snr,
  }))
  for (const ln of renderSuggestionTable(tableRows)) lines.push(ln)
  lines.push('')
  lines.push('Rationale:')
  for (const r of suggestion.rows) {
    lines.push(`  - ${r.name}: ${r.rationale}`)
  }
  lines.push('')
  lines.push(
    `Note: safety dimension is a VETO switch, not a weight — never tuned here.`,
  )
  lines.push('')

  if (!parsed.apply) {
    lines.push(
      `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedOracleWeightsPath()}).`,
    )
    lines.push(
      `To wipe existing tuned weights and fall back to base/default: \`--reset\`.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply:数据不足时跳过写盘,避免覆盖已有的 tuned(或老 base)
  if (suggestion.insufficientReason) {
    lines.push(
      `--apply skipped due to insufficient data; existing tuned-oracle-weights.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // Phase 28:apply 前过 benchmark drift 软门禁。
  // 如果 /evolve-bench --record 攒够了数据且 drift suspicious,默认拒绝写入;
  // reviewer 确认后用 --force 覆盖。computeDrift 在数据不够时返回 suspicious=false,
  // 所以新用户第一次 apply 不会被误拦。
  try {
    const benchMod = await import(
      '../../services/autoEvolve/oracle/benchmarkLedger.js'
    )
    const drift = benchMod.computeDrift()
    if (drift.suspicious && !parsed.force) {
      lines.push(`!! benchmark drift gate triggered (Phase 28):`)
      lines.push(`   ${drift.reason}`)
      lines.push(
        `   suspicious rows: ${drift.suspiciousRows
          .map(r => `${r.benchmarkId}(Δ${r.delta.toFixed(2)})`)
          .join(', ')}`,
      )
      lines.push(
        `   Oracle-level auto-tuning is refused. Inspect via \`/evolve-bench --drift\`.`,
      )
      lines.push(
        `   If the drift is intentional (e.g., you've deliberately shifted Oracle focus),`,
      )
      lines.push(
        `   re-run with \`--apply --force\`; tuned-oracle-weights.json is left untouched otherwise.`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    if (drift.suspicious && parsed.force) {
      lines.push(
        `!! benchmark drift detected but overridden via --force; proceeding with write.`,
      )
      lines.push(`   rationale: ${drift.reason}`)
      lines.push('')
    }
  } catch (e) {
    // benchmark ledger 不可用 → 不拦截 apply(本期向后兼容旧安装)
    lines.push(
      `(benchmark drift gate skipped: ${(e as Error).message})`,
    )
  }

  const next = metaMod.suggestionToNext(suggestion)
  const res = metaMod.saveTunedOracleWeights(next)
  lines.push('Apply result:')
  if (res.ok) {
    lines.push(`  wrote ${res.path}`)
    lines.push(`  updatedAt: ${res.value?.updatedAt}`)
    lines.push(
      `  loadOracleWeights() will pick up the new weights on next read (mtime cache).`,
    )
    lines.push(
      `  safetyVetoEnabled remains untouched (still a hardcoded veto switch).`,
    )
  } else {
    lines.push(`  !! write failed: ${res.error}`)
    lines.push(`  path: ${res.path}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveMeta = {
  type: 'local',
  name: 'evolve-meta',
  description:
    'Phase 27 Oracle meta-evolver. Suggests SNR-based values for the 4 fitness weights (userSatisfaction / taskSuccess / codeQuality / performance) from recent fitness history. Dry-run by default; --apply writes oracle/tuned-oracle-weights.json; --reset deletes it. Safety is a veto, never tuned.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveMeta
