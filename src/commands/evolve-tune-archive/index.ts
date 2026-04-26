/**
 * /evolve-tune-archive [--apply] [--window DAYS] [--reset]
 *
 * autoEvolve(v1.0) — Phase 38:archive 阈值自调(Archive auto-tuner)入口。
 *
 * 目的
 * ────
 * autoArchiveEngine 的 2 个 stable-unused 阈值长期硬编码:
 *   STALE_STABLE_UNUSED_DAYS  = 45
 *   STALE_STABLE_MIN_AGE_DAYS = 14
 *
 * 真实数据往往告诉我们:
 *   - 太多"刚过 45d 线"的 dsli 归档 → 可能过紧,给更长窗口再判定
 *   - 太多"躺尸 90d+ 才被 auto-stale"的归档 → 阈值过松,早该清理
 *
 * 信号源(Phase 38 创新点):从 promotions.ndjson 读窗口内 trigger='auto-stale'
 * 的 transition,正则提取 rationale 里的 dsli(days since last invoke),
 * 分桶 borderline(刚过线)/ longAbandoned(早已躺尸)/ healthy。
 *
 *   - borderlineRate ≥ 0.4 → 阈值 relax(UNUSED +5, MIN_AGE +2)
 *   - longAbandonedRate ≥ 0.6 → 阈值 tighten(UNUSED -5, MIN_AGE -2)
 *   - 其它 → hold
 *
 * 用法
 * ────
 *   /evolve-tune-archive
 *       → 默认 30 天窗口 dry-run,读 promotions.ndjson 的 auto-stale 事件,
 *         打印 total/parsed/borderline/longAbandoned 统计 + 2 条建议(不写盘)
 *   /evolve-tune-archive --window 14
 *       → 窗口 14 天
 *   /evolve-tune-archive --apply
 *       → 将 suggestion 写入 oracle/tuned-archive-thresholds.json,
 *         autoArchiveEngine 的 mtime 缓存会在下次 evaluate 时自动 pickup
 *   /evolve-tune-archive --reset
 *       → 删 tuned-archive-thresholds.json,回退到 DEFAULT = 原硬编码 45/14
 *
 * 安全
 * ────
 *   - dry-run 纯读,从不写盘
 *   - 样本不足(< MIN_SAMPLES_ARCHIVE_TUNE = 5)→ insufficient,
 *     即使 --apply 也跳过,已有文件不动
 *   - 所有 suggested 值都被夹紧在 [UNUSED_DAYS_MIN=7..MAX=365] 和
 *     [MIN_AGE_DAYS_MIN=1..MAX=90]
 *   - 调整幅度:UNUSED ±5, MIN_AGE ±2(noise < 1d 不要,极端值也不要)
 *
 * 与其它 /evolve-tune*:
 *   - /evolve-tune:管 oracle 侧阈值(win/loss/adv/perfect)
 *   - /evolve-tune-joint:联合调 /evolve-tune + /evolve-meta
 *   - /evolve-tune-promotion:管 promotion tier 阈值
 *   - /evolve-tune-archive:管 archive stable-unused 阈值(本命令)
 *   四者职责清晰分片,写入各自的 tuned-*.json,关闭 Phase 14 候选项剩余一半。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-tune-archive [--apply] [--window DAYS] [--reset]
    - (no flags):      dry-run with 30-day window, print suggestions
    - --window DAYS:   width of the promotion-ledger window (default 30)
    - --apply:         persist suggestion to oracle/tuned-archive-thresholds.json
    - --reset:         delete the tuned file (revert to hardcoded defaults 45/14)`

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
    '../../services/autoEvolve/emergence/archiveThresholdTuner.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --reset 分支:删除 tuned-archive-thresholds.json ─────────────
  if (parsed.reset) {
    const { existsSync, unlinkSync } = await import('node:fs')
    const path = pathsMod.getTunedArchiveThresholdsPath()
    const lines: string[] = []
    lines.push(`## autoEvolve Archive Threshold Auto-Tuner — Reset (Phase 38)`)
    lines.push('')
    if (!existsSync(path)) {
      lines.push(
        `  no tuned-archive-thresholds.json at ${path}; nothing to reset.`,
      )
      lines.push(
        `  autoArchiveEngine is already using DEFAULT_TUNED_ARCHIVE_THRESHOLDS (45/14).`,
      )
    } else {
      try {
        unlinkSync(path)
        tunerMod._resetTunedArchiveThresholdsCacheForTest()
        lines.push(`  removed ${path}`)
        lines.push(
          `  autoArchiveEngine will fall back to DEFAULT_TUNED_ARCHIVE_THRESHOLDS on next evaluate.`,
        )
      } catch (e) {
        lines.push(`  unlink failed: ${(e as Error).message}`)
        lines.push(`  path: ${path}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── suggestion dry-run / --apply 共用计算 ────────────────────────
  const suggestion = tunerMod.computeArchiveTuningSuggestion(parsed.windowDays)

  const lines: string[] = []
  lines.push(`## autoEvolve Archive Threshold Auto-Tuner (Phase 38)`)
  lines.push('')
  lines.push(
    `mode: ${parsed.apply ? '**APPLY** (will write tuned-archive-thresholds.json)' : 'dry-run (no write)'}`,
  )
  lines.push(`window: last ${parsed.windowDays} day(s)`)
  lines.push(`total transitions in ledger: ${suggestion.totalTransitions}`)
  lines.push('')
  lines.push(
    `auto-stale events (in window): ${suggestion.autoStaleCount}  dsli-parsed: ${suggestion.parsedCount}`,
  )
  if (suggestion.parsedCount > 0) {
    const bRate = suggestion.borderlineCount / suggestion.parsedCount
    const lRate = suggestion.longAbandonedCount / suggestion.parsedCount
    lines.push(
      `borderline(dsli≤thr·1.2): ${suggestion.borderlineCount}  rate=${bRate.toFixed(3)}`,
    )
    lines.push(
      `longAbandoned(dsli≥thr·2): ${suggestion.longAbandonedCount}  rate=${lRate.toFixed(3)}`,
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
      `To commit these values: re-run with \`--apply\` (writes ${pathsMod.getTunedArchiveThresholdsPath()}).`,
    )
    lines.push(
      `To wipe existing tuned values and fall back to hardcoded defaults: \`--reset\`.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // --apply:insufficient 时跳过
  if (suggestion.insufficientReason) {
    lines.push(
      `--apply skipped due to insufficient data; existing tuned-archive-thresholds.json (if any) is untouched.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  const next = tunerMod.suggestionToNext(suggestion)
  try {
    tunerMod.saveTunedArchiveThresholds(next)
    lines.push('Apply result:')
    lines.push(`  wrote ${pathsMod.getTunedArchiveThresholdsPath()}`)
    lines.push(`  updatedAt: ${next.updatedAt}`)
    lines.push(
      `  new values: unused=${next.staleStableUnusedDays}d  minAge=${next.staleStableMinAgeDays}d`,
    )
    lines.push(
      `  autoArchiveEngine will pick up new values on next evaluate (mtime cache).`,
    )
  } catch (e) {
    lines.push(`  !! write failed: ${(e as Error).message}`)
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveTuneArchive = {
  type: 'local',
  name: 'evolve-tune-archive',
  description:
    'Phase 38 archive threshold auto-tuner. Reads auto-stale transitions in promotions.ndjson, extracts dsli from rationale, computes borderline/longAbandoned rate, and suggests ±5/±2 adjustments to STALE_STABLE_UNUSED_DAYS / STALE_STABLE_MIN_AGE_DAYS. Dry-run by default; --apply writes oracle/tuned-archive-thresholds.json; --reset deletes it. Values clamped to [7..365] / [1..90].',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveTuneArchive
