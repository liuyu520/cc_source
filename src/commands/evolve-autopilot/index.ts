/**
 * G2 Step 3 (2026-04-26) — /evolve-autopilot 只读 preview
 *
 * 目的
 * ----
 * metaActionPlan 已经很完整(oracle weights 建议、arenaShadowCount 步进、mutationRate、
 * selectionPressure、learningRate),但「自己关上门」仍要人 /evolve-meta-apply --apply。
 * 本命令不动执行逻辑,先把计划按风险分三档展示:
 *   auto-apply  — 白名单级,safe 且可回滚
 *   auto-propose — 需要 /evolve-accept 才生效
 *   manual-only  — 破坏性或 toStatus=stable
 *
 * 同时回显 CLAUDE_EVOLVE_AUTOPILOT_LEVEL,用户能看出「当前策略会放行哪些档」。
 *
 * 行为
 * ----
 *   /evolve-autopilot               preview(当前 windowDays=7)
 *   /evolve-autopilot --window N    改 windowDays(1..90,默认 7)
 *   /evolve-autopilot --json        结构化输出(items, level, allowed)
 *   /evolve-autopilot --help        说明
 *
 * 纯读、零副作用、不 apply、不落盘。下一阶段才基于 level 做 autopilot runner。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-autopilot                       preview tiers (auto-apply / auto-propose / manual-only)
  /evolve-autopilot --window N            windowDays (1..90, default 7)
  /evolve-autopilot --json                JSON payload
  /evolve-autopilot --run                 execute auto-apply items (requires LEVEL ≠ off)
  /evolve-autopilot --help                this message

Env:
  CLAUDE_EVOLVE_AUTOPILOT_LEVEL=safe|propose|off   (default off)
    - off:     preview only, --run refused
    - safe:    --run executes 'auto-apply' items (arenaShadowCount / oracleWeights)
    - propose: same as safe for --run; propose-tier items still need /evolve-accept

--run writes:
  - ~/.claude/autoEvolve/meta/genome.json     (arenaShadowCount patches)
  - ~/.claude/autoEvolve/oracle/tuned-weights.json   (oracleWeights)
  - ~/.claude/autoEvolve/oracle/autopilot-apply.ndjson   (audit ledger)

Preview is read-only. --run is the explicit write path.
`

interface ParsedFlags {
  json: boolean
  help: boolean
  run: boolean
  windowDays: number
  error?: string
}

function parseArgs(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = { json: false, help: false, run: false, windowDays: 7 }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') out.help = true
    else if (t === '--json') out.json = true
    else if (t === '--run') out.run = true
    else if (t === '--window') {
      const v = parseInt(tokens[++i] ?? '', 10)
      if (!Number.isFinite(v) || v < 1 || v > 90) {
        out.error = '--window 必须是 1..90 的整数'
      } else out.windowDays = v
    } else if (t.startsWith('--')) {
      out.error = `未知参数: ${t}`
    } else {
      out.error = `未知参数: ${t}`
    }
    if (out.error) break
  }
  return out
}

function call(args: string): LocalCommandCall {
  const parsed = parseArgs(args)
  if (parsed.help) return { type: 'text', value: USAGE }
  if (parsed.error) return { type: 'text', value: parsed.error }

  try {
    const autoEvolve = require(
      '../../services/autoEvolve/index.js',
    ) as typeof import('../../services/autoEvolve/index.js')
    const {
      classifyAutopilotItems,
      groupByTier,
      readAutopilotLevel,
      tiersAllowedByLevel,
    } = require(
      '../../services/autoEvolve/metaEvolve/autopilotTiers.js',
    ) as typeof import('../../services/autoEvolve/metaEvolve/autopilotTiers.js')

    const snapshot = autoEvolve.buildMetaActionPlanSnapshot(parsed.windowDays)
    const items = classifyAutopilotItems(snapshot)
    const grouped = groupByTier(items)
    const level = readAutopilotLevel()
    const allowed = tiersAllowedByLevel(level)

    // ── G2 Step 4: --run 真正执行 auto-apply 档 ─────────
    // 默认不执行,preview 即 Step 3 输出。--run 必须显式传,且 LEVEL ≠ off。
    if (parsed.run) {
      const { runAutopilot } = require(
        '../../services/autoEvolve/metaEvolve/autopilotRunner.js',
      ) as typeof import('../../services/autoEvolve/metaEvolve/autopilotRunner.js')
      // 把 snapshot 注入,避免重算(节约 api/io;且保证 preview/run 同一帧数据)
      const runResult = runAutopilot({ level, windowDays: parsed.windowDays, snapshot })
      if (parsed.json) {
        return {
          type: 'text',
          value: JSON.stringify(
            {
              mode: 'run',
              windowDays: parsed.windowDays,
              metaAdvisor: snapshot.metaAdvisor,
              metaAction: snapshot.metaAction,
              result: runResult,
              counts: {
                'auto-apply': grouped['auto-apply'].length,
                'auto-propose': grouped['auto-propose'].length,
                'manual-only': grouped['manual-only'].length,
              },
            },
            null,
            2,
          ),
        }
      }
      return { type: 'text', value: renderRunResult(parsed.windowDays, snapshot, runResult) }
    }

    if (parsed.json) {
      return {
        type: 'text',
        value: JSON.stringify(
          {
            windowDays: parsed.windowDays,
            metaAdvisor: snapshot.metaAdvisor,
            metaAction: snapshot.metaAction,
            level,
            allowedTiers: allowed,
            items,
            grouped,
            counts: {
              'auto-apply': grouped['auto-apply'].length,
              'auto-propose': grouped['auto-propose'].length,
              'manual-only': grouped['manual-only'].length,
            },
          },
          null,
          2,
        ),
      }
    }

    const out: string[] = []
    out.push('## autoEvolve Autopilot (G2 Step 3, preview-only)')
    out.push('')
    out.push(
      `window: last ${parsed.windowDays} day(s) · metaAdvisor: **${snapshot.metaAdvisor}** · metaAction: \`${snapshot.metaAction}\``,
    )
    out.push(
      `CLAUDE_EVOLVE_AUTOPILOT_LEVEL=**${level}** → will auto-run: ${allowed.length > 0 ? allowed.join(', ') : '(none, preview only)'}`,
    )
    out.push('')

    if (items.length === 0) {
      out.push('_No actionable items — oracle says hold, nothing to schedule._')
      out.push('')
      out.push('Note: this command is read-only. Apply via /evolve-meta-apply --apply.')
      return { type: 'text', value: out.join('\n') }
    }

    const tierTitle: Record<typeof items[number]['tier'], string> = {
      'auto-apply': '🟢 auto-apply (safe, revertible)',
      'auto-propose': '🟡 auto-propose (needs /evolve-accept)',
      'manual-only': '🔴 manual-only (keeps human in the loop)',
    }
    for (const tier of ['auto-apply', 'auto-propose', 'manual-only'] as const) {
      const rows = grouped[tier]
      if (rows.length === 0) continue
      out.push(`### ${tierTitle[tier]}`)
      out.push('')
      out.push('| id | label | direction | reason | applyHint |')
      out.push('|---|---|---|---|---|')
      for (const it of rows) {
        const hint = it.applyHint ? '`' + it.applyHint.replace(/\|/g, '\\|') + '`' : '_(none)_'
        out.push(
          `| \`${it.id}\` | ${it.label} | ${it.direction} | ${it.reason} | ${hint} |`,
        )
      }
      out.push('')
    }
    out.push(
      'Note: preview only. This step does not apply anything. Apply path: `/evolve-meta-apply --apply [--oracle-only|--param <name>]`.',
    )
    return { type: 'text', value: out.join('\n') }
  } catch (err) {
    // fail-open:snapshot 拿不到就友好降级
    return {
      type: 'text',
      value:
        'autopilot preview 不可用(metaActionPlan snapshot 失败): ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n(本命令是纯读,失败不影响主流程。先跑 /evolve-status 看诊断)',
    }
  }
}

// ─── G2 Step 4 run result renderer ─────────────────────────────────
function renderRunResult(
  windowDays: number,
  snapshot: import('../../services/autoEvolve/metaEvolve/metaActionPlan.js').MetaActionPlanSnapshot,
  result: import('../../services/autoEvolve/metaEvolve/autopilotRunner.js').RunAutopilotResult,
): string {
  const out: string[] = []
  out.push('## autoEvolve Autopilot — RUN (G2 Step 4)')
  out.push('')
  out.push(
    `window: last ${windowDays} day(s) · metaAdvisor: **${snapshot.metaAdvisor}** · metaAction: \`${snapshot.metaAction}\``,
  )
  out.push(`level: **${result.level}** · runId: \`${result.runId}\``)
  out.push('')
  if (!result.triggered) {
    out.push(`**Refused** — ${result.refusedReason}`)
    out.push('')
    out.push(
      'Nothing was written. Preview still available via `/evolve-autopilot` without --run.',
    )
    return out.join('\n')
  }
  const { wrote, failed, skipped } = result.summary
  let summaryLine: string
  if (failed > 0 && wrote > 0) summaryLine = `partial success (wrote=${wrote}, failed=${failed}, skipped=${skipped})`
  else if (failed > 0) summaryLine = `failed (failed=${failed}, skipped=${skipped})`
  else if (wrote > 0) summaryLine = `success (wrote=${wrote}, skipped=${skipped})`
  else summaryLine = `no-op (skipped=${skipped})`
  out.push(`**Summary: ${summaryLine}**`)
  out.push('')
  if (result.records.length === 0) {
    out.push('_No records — nothing classified as auto-apply._')
    return out.join('\n')
  }
  out.push('| itemId | tier | action | ok | path / reason |')
  out.push('|---|---|---|---|---|')
  for (const rec of result.records) {
    const detail = rec.ok
      ? rec.path ?? rec.skippedReason ?? ''
      : rec.error ?? ''
    const status = rec.ok ? (rec.action === 'skipped' ? '⏭' : '✅') : '❌'
    out.push(
      `| \`${rec.item.id}\` | ${rec.item.tier} | ${rec.action} | ${status} | ${String(detail).replace(/\|/g, '\\|')} |`,
    )
  }
  out.push('')
  out.push(
    'All events appended to `~/.claude/autoEvolve/oracle/autopilot-apply.ndjson`.',
  )
  return out.join('\n')
}

const evolveAutopilot = {
  type: 'local',
  name: 'evolve-autopilot',
  description:
    'G2 Step 3+4: preview (read-only) and --run (executes auto-apply tier) for metaActionPlan.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveAutopilot

