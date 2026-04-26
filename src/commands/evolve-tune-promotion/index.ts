/**
 * /evolve-tune-promotion [--apply] [--window DAYS] [--reset]
 *
 * autoEvolve(v1.0) — Phase 37:promotion-tier auto-tuner 入口。
 *
 * 目的
 * ────
 * autoPromotionEngine 的 4 个 tier 阈值长期硬编码:
 *   SHADOW_TO_CANARY_MIN_INVOCATIONS = 3
 *   SHADOW_TO_CANARY_MIN_AGE_DAYS    = 1
 *   CANARY_TO_STABLE_MIN_INVOCATIONS = 10
 *   CANARY_TO_STABLE_MIN_AGE_DAYS    = 3
 *
 * 真实数据往往告诉我们:
 *   - 好 organism 在 3 次调用就被晋升,导致**晋升后被 vetoed** 的回归率高
 *     → 阈值应该**收紧**
 *   - 或者 10 次 canary 才 stable 太慢,好 organism 早早稳了 → **放宽**
 *
 * 信号:从 promotions.ndjson 按 tier(shadow→canary / canary→stable)分桶,
 * 计算 "promoted-then-vetoed" 的比例:
 *   - 比例 ≥ 0.3 → 该 tier 阈值 +1(invocations 或 ageDays)
 *   - 比例 ≤ 0.05 且样本 ≥ 5 → 阈值 -1
 *   - 其它 → hold
 *
 * 用法
 * ────
 *   /evolve-tune-promotion
 *       → 默认 30 天窗口 dry-run,读 promotions.ndjson,打印每个 tier 的
 *         promoted/regressed 统计 + 4 条 tier-field 建议(不写盘)
 *   /evolve-tune-promotion --window 14
 *       → 窗口 14 天(用 promotion 事件近期趋势)
 *   /evolve-tune-promotion --apply
 *       → 将 suggestion 写入 oracle/tuned-promotion-thresholds.json,
 *         autoPromotionEngine 的 mtime 缓存会在下次 evaluate 时自动 pickup
 *   /evolve-tune-promotion --reset
 *       → 删 tuned-promotion-thresholds.json,回退到 DEFAULT = 原硬编码
 *
 * 安全
 * ────
 *   - dry-run 纯读,从不写盘
 *   - 样本不足(< MIN_SAMPLES_FOR_PROMO_TUNE = 5)→ insufficient,即使
 *     --apply 也跳过,已有文件不动
 *   - 所有 suggested 值都被夹紧在 [INVOCATIONS_MIN/MAX] 和 [AGE_DAYS_MIN/MAX],
 *     防止一次滑到极端值
 *   - 调整幅度始终 ±1,不激进
 *
 * 与其它 /evolve-tune*:
 *   - /evolve-tune:管 oracle 侧阈值(win/loss/adv/perfect)
 *   - /evolve-tune-joint:联合调 /evolve-tune + /evolve-meta
 *   - /evolve-tune-promotion:管 promotion tier 阈值(本命令)
 *   三者职责清晰分片,写入各自的 tuned-*.json。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune-promotion [--apply] [--window DAYS] [--reset]
    - (no flags):      dry-run with 30-day window, print suggestions
    - --window DAYS:   width of the promotion-ledger window (default 30)
    - --apply:         persist suggestion to oracle/tuned-promotion-thresholds.json
    - --reset:         delete the tuned file (revert to hardcoded defaults 3/1/10/3)`

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

/** 把 suggestion 行渲染成对齐表 */
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

  // 懒加载,保持命令 load 成本低
  const tunerMod = await import(
    '../../services/autoEvolve/emergence/promotionThresholdTuner.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --reset 分支:删除 tuned-promotion-thresholds.json ─────────────
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedPromotionThresholdsPath()
    const lines: string[] = []
    lines.push(`## autoEvolve Promotion Threshold Auto-Tuner — Reset (Phase 37)`)
    lines.push('')
    if (!existsSync(path)) {
      lines.push(
        `  no tuned-promotion-thresholds.json at ${path}; nothing to reset.`,
      )
      lines.push(
        `  autoPromotionEngine is already using DEFAULT_TUNED_PROMOTION_THRESHOLDS (3/1/10/3).`,
      )
    } else {
      try {
        unlinkSync(path)
        tunerMod._resetTunedPromotionThresholdsCacheForTest()
        lines.push(`  removed ${path}`)
        lines.push(
          `  autoPromotionEngine will fall back to DEFAULT_TUNED_PROMOTION_THRESHOLDS on next evaluate.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── suggestion dry-run / --apply 共用计算 ────────────────────────
  const suggestion = tunerMod.computePromotionTuningSuggestion(parsed.windowDays)

  const lines: string[] = []
  lines.push(`## autoEvolve Promotion Threshold Auto-Tuner (Phase 37)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-promotion-thresholds.json)' : 'dry-run (no write)'}`,
  )
  lines.push(`window: last ${parsed.windowDays} day(s)`)
  lines.push(`total transitions in ledger: ${suggestion.totalTransitions}`)
  lines.push('')
  lines.push(
    `shadow→canary: promoted=${suggestion.shadowToCanaryCount}  regressed(vetoed)=${suggestion.shadowToCanaryRegressed}` +
      (suggestion.shadowToCanaryCount > 0
        ? `  rate=${(suggestion.shadowToCanaryRegressed / suggestion.shadowToCanaryCount).toFixed(3)}`
        : ''),
  )
  lines.push(
    `canary→stable: promoted=${suggestion.canaryToStableCount}  regressed(vetoed)=${suggestion.canaryToStableRegressed}` +
      (suggestion.canaryToStableCount > 0
        ? `  rate=${(suggestion.canaryToStableRegressed / suggestion.canaryToStableCount).toFixed(3)}`
        : ''),
  )
  lines.push('')

  if (suggestion.insufficientReason) {
    lines.push(`!! insufficient data: ${suggestion.insufficientReason}`)
    // 2026-04-25 —— bake-stall 逃生:rows 会有一条 override,就不要说"nothing to apply"
    if (suggestion.bakeStallOverride) {
      lines.push(
        `   bake-stall override active — see Suggestion below; --apply will still persist.`,
      )
    } else {
      lines.push(`   nothing to apply; existing tuned file (if any) untouched.`)
    }
    lines.push('')
  }

  // 2026-04-25 —— bake-stall override 额外展示 ledger 统计,让用户明白信号来源
  if (suggestion.bakeStallOverride) {
    const s = suggestion.bakeStallOverride.stats
    lines.push(
      `bake-stall signal: blocked=${s.blocked}  bypassed=${s.bypassed}  ` +
        `passed=${s.passed}  failOpen=${s.failOpen}  (veto-window.ndjson, 24h)`,
    )
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
      `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedPromotionThresholdsPath()}).`,
    )
    lines.push(
      `To wipe existing tuned values and fall back to hardcoded defaults: \`--reset\`.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply:insufficient 时跳过,避免把用户手改的文件覆盖成 default
  //   2026-04-25 —— 但 bakeStallOverride 触发的 rows 是有效建议,不能被 insufficient 语义挡住
  if (suggestion.insufficientReason && !suggestion.bakeStallOverride) {
    lines.push(
      `--apply skipped due to insufficient data; existing tuned-promotion-thresholds.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  const next = tunerMod.suggestionToNext(suggestion)
  try {
    tunerMod.saveTunedPromotionThresholds(next)
    lines.push('Apply result:')
    lines.push(`  wrote ${pathsMod.getTunedPromotionThresholdsPath()}`)
    lines.push(`  updatedAt: ${next.updatedAt}`)
    lines.push(
      `  new values: shadow→canary inv=${next.shadowToCanaryMinInvocations} age=${next.shadowToCanaryMinAgeDays}d, ` +
        `canary→stable inv=${next.canaryToStableMinInvocations} age=${next.canaryToStableMinAgeDays}d`,
    )
    lines.push(
      `  autoPromotionEngine will pick up new values on next evaluate (mtime cache).`,
    )
  } catch (e) {
    lines.push(`  !! write failed: ${(e as Error).message}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveTunePromotion = {
  type: 'local',
  name: 'evolve-tune-promotion',
  description:
    'Phase 37 promotion-tier auto-tuner. Reads promotions.ndjson, computes promoted-then-vetoed regression rate per tier (shadow→canary, canary→stable), and suggests ±1 adjustments to SHADOW_TO_CANARY_MIN_INVOCATIONS/AGE_DAYS and CANARY_TO_STABLE_MIN_INVOCATIONS/AGE_DAYS. Dry-run by default; --apply writes oracle/tuned-promotion-thresholds.json; --reset deletes it. Values are clamped and adjusted conservatively (±1 per run).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTunePromotion
