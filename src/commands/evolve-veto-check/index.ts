/**
 * /evolve-veto-check —— self-evolution-kernel v1.0 §6.3 veto-window 观测命令。
 *
 * 与 /evolve-goodhart-check 并列:后者管 §6.2 Goodhart(health + gate + advisory),
 * 本命令管 §6.3 veto-window ledger(stats + advisory)。
 *
 * 与 §6.3 三观测点(kernel-status / evolve-status compact + dailyDigest multi-line)互补:
 *   - 三观测点被动:用户看 status 时顺带看到
 *   - 本命令主动:专门定位 bake 时长/bypass/fail-open 异常
 *
 * 铁律:
 *   - 纯只读,不改 ledger/manifest
 *   - fail-open:任何一段失败都降级为 unavailable,其它段仍输出
 *   - 无新事件时给出明确 reassurance,而不是空白
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-veto-check              (compact stats)
  /evolve-veto-check --detail     (multi-line breakdown)
  /evolve-veto-check --advisory   (only advisory — stalled/bypass_heavy/fail_open_spike)
  /evolve-veto-check --json       (merged stats + advisory, for piping)

Notes:
  - Observation command, read-only. Never mutates ledger or manifests.
  - Window defaults: stats=recent 200, advisory=24h.
  - Use /evolve-tune to adjust veto-window bake floor if advisory=stalled.`

type Mode = 'status' | 'detail' | 'advisory' | 'json'

function parseFlags(args: string): { mode: Mode; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let mode: Mode = 'status'
  let detail = false
  let advisory = false
  let json = false
  for (const t of tokens) {
    if (t === '') continue
    if (t === '--detail') detail = true
    else if (t === '--advisory') advisory = true
    else if (t === '--json') json = true
    else if (t === '--help' || t === '-h') {
      return { mode, error: USAGE }
    } else {
      return { mode, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  // mutex:--json 已经包含 stats+advisory,不再与 --detail/--advisory 组合
  if (json && (detail || advisory)) {
    return {
      mode,
      error: `--json cannot combine with --detail/--advisory (already merged)\n${USAGE}`,
    }
  }
  if (json) return { mode: 'json' }
  if (advisory) return { mode: 'advisory' }
  if (detail) return { mode: 'detail' }
  return { mode: 'status' }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 动态 import,与 /evolve-goodhart-check 一致的懒加载风格
  const vwMod = await import(
    '../../services/autoEvolve/oracle/vetoWindowLedger.js'
  )

  // --json: 合并出口,stats + advisory + recent 片段。便于管道处理。
  if (parsed.mode === 'json') {
    let stats: unknown
    let advisory: unknown
    let recent: unknown
    try {
      stats = vwMod.computeVetoWindowStats()
    } catch (e) {
      stats = { error: (e as Error).message }
    }
    try {
      advisory = vwMod.detectVetoWindowAdvisory()
    } catch (e) {
      advisory = { error: (e as Error).message }
    }
    try {
      recent = vwMod.recentVetoWindowEvents(10)
    } catch (e) {
      recent = { error: (e as Error).message }
    }
    return {
      type: 'text',
      value: JSON.stringify({ stats, advisory, recent }, null, 2),
    }
  }

  // --advisory: 只出 advisory。kind=none 时给明确 reassurance。
  if (parsed.mode === 'advisory') {
    let adv: ReturnType<typeof vwMod.detectVetoWindowAdvisory>
    try {
      adv = vwMod.detectVetoWindowAdvisory()
    } catch (e) {
      return {
        type: 'text',
        value: `Veto-window advisory: unavailable (${(e as Error).message}).`,
      }
    }
    if (adv.kind === 'none') {
      return {
        type: 'text',
        value:
          'Veto-window advisory: kind=none (no stalled / bypass_heavy / fail_open_spike in recent window).',
      }
    }
    const lines = [`Veto-window advisory: ${adv.kind}`]
    if (adv.message) lines.push(`  ${adv.message}`)
    if (adv.windowLabel) lines.push(`  window: ${adv.windowLabel}`)
    if (adv.stats) {
      lines.push(
        `  stats: blocked=${adv.stats.blocked}  bypassed=${adv.stats.bypassed}  ` +
          `passed=${adv.stats.passed}  failOpen=${adv.stats.failOpen}`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // status / detail: 走共享 summary builder。空时给 reassurance。
  let summary: string[]
  try {
    summary = vwMod.buildVetoWindowSummaryLines({
      compact: parsed.mode === 'status',
    })
  } catch (e) {
    return {
      type: 'text',
      value: `Veto-window: unavailable (${(e as Error).message}).`,
    }
  }
  if (summary.length === 0) {
    return {
      type: 'text',
      value:
        'Veto-window: no events recorded yet.\n' +
        'Events are appended when promoteOrganism runs against shadow→canary / canary→stable.',
    }
  }
  return { type: 'text', value: summary.join('\n') }
}

const evolveVetoCheck = {
  type: 'local',
  name: 'evolve-veto-check',
  description:
    'Kernel v1.0 §6.3 veto-window ledger view. Combines bake-time gate stats (blocked/bypassed/passed/fail-open) with advisory detector. Use --detail for multi-line, --advisory for just the advisory, --json for merged output.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveVetoCheck
