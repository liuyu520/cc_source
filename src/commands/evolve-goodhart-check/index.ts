/**
 * /evolve-goodhart-check — self-evolution-kernel v1.0 §6.2 Goodhart 三件套综合视图 + 闸门视图
 *
 * 三源(drift / rareSample / benchmark)的综合健康评级,外加闸门事件 ledger 与 advisory。
 * 仅观察,不改任何文件。
 *
 * 模式
 * ────
 *   --status (默认)     : compact 版;一行 verdict + 三源简要
 *   --detail             : 展开三源分项 + hint
 *   --gate               : compact 版;最近 goodhart gate 事件统计 + advisory badge
 *   --gate --detail      : 多行 breakdown(four outcomes + advisor)
 *   --advisory           : 仅 advisory detector 输出(kind + message + stats 窗口)
 *   --json               : 合并 JSON:health report + gate stats + advisory
 *
 * 不接受任何会修改 ledger/tuned weights 的参数。
 *
 * 2026-04-25 增补 gate/advisory 视图:把 §6.2 分散的"整体健康 / 闸门拦放 / 行动建议"
 * 三个维度收敛成同一命令,免得用户要在 /kernel-status、/evolve-status、digest 之间
 * 手动拼接。所有新模式都走 fail-open:数据源炸了给一行友好提示,不抛异常。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-goodhart-check
  /evolve-goodhart-check --status
      (default) compact verdict + 3-source summary

  /evolve-goodhart-check --detail
      full per-source breakdown

  /evolve-goodhart-check --gate
      compact goodhart-gate ledger stats + advisory badge

  /evolve-goodhart-check --gate --detail
      multi-line gate breakdown (blocked/bypassed/passed/fail-open + advisor)

  /evolve-goodhart-check --advisory
      only the advisory detector output (stalled / fail_open_spike / bypass_heavy)

  /evolve-goodhart-check --json
      merged JSON: { health, gate, advisory }

All modes are read-only. To remediate, use:
  /evolve-drift-check --propose     (Goodhart #2 — shadow drift proposal)
  /evolve-rare-check --analyze       (Goodhart #3 — fresh rare-sample snapshot)
  /evolve-bench --drift              (Goodhart #1 — benchmark drift detail)
  /evolve-meta --apply               (human-gated adoption of any proposal)
`

type Mode = 'status' | 'detail' | 'gate' | 'gate-detail' | 'advisory' | 'json'

function parseFlags(args: string): { mode: Mode; error?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let mode: Mode = 'status'
  let gate = false
  let detail = false
  let advisory = false
  let json = false
  for (const t of tokens) {
    if (t === '' || t === '--status') {
      // status 默认档
    } else if (t === '--detail') {
      detail = true
    } else if (t === '--gate') {
      gate = true
    } else if (t === '--advisory') {
      advisory = true
    } else if (t === '--json') {
      json = true
    } else if (t === '-h' || t === '--help') {
      return { mode, error: USAGE }
    } else {
      return { mode, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  // 互斥与组合:
  //   --json 覆盖其它所有档位(合并 JSON 出口)
  //   --gate + --detail → 'gate-detail';--gate 单独 → 'gate'
  //   --advisory 与 gate 互斥(advisory 是 gate 的子集且已含 message)
  //   --detail 单独 → 'detail' (health 多行);与 gate 组合见上
  if (json) {
    if (gate || advisory) {
      return {
        mode,
        error: `--json cannot combine with --gate/--advisory (already merged)\n${USAGE}`,
      }
    }
    return { mode: 'json' }
  }
  if (advisory && gate) {
    return {
      mode,
      error: `--advisory cannot combine with --gate (use --gate for full stats)\n${USAGE}`,
    }
  }
  if (advisory) return { mode: 'advisory' }
  if (gate) return { mode: detail ? 'gate-detail' : 'gate' }
  return { mode: detail ? 'detail' : 'status' }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // health 与 gate 两个模块独立动态 import:
  //   - 允许 gate ledger 缺失而不阻 health 视图,反之亦然
  //   - 与既有 isHidden/非交互 命令保持懒加载风格
  const mod = await import(
    '../../services/autoEvolve/oracle/goodhartHealth.js'
  )
  const gateMod = await import(
    '../../services/autoEvolve/oracle/goodhartGateLedger.js'
  )

  // --json: 合并出口,含 health report + gate stats + advisory。
  // 不再只输出 GoodhartHealthReport — 2026-04-25 扩展后,统一 JSON 更便于管道。
  if (parsed.mode === 'json') {
    let health: unknown = null
    try {
      health = mod.computeGoodhartHealth()
    } catch (e) {
      health = { error: (e as Error).message }
    }
    let gate: unknown = null
    try {
      gate = gateMod.computeGoodhartGateStats()
    } catch (e) {
      gate = { error: (e as Error).message }
    }
    let advisory: unknown = null
    try {
      advisory = gateMod.detectGoodhartGateAdvisory()
    } catch (e) {
      advisory = { error: (e as Error).message }
    }
    return {
      type: 'text',
      value: JSON.stringify({ health, gate, advisory }, null, 2),
    }
  }

  // --advisory:只取 detector 输出。kind='none' 给一行 reassuring 文案,
  // 免得用户以为命令坏了。
  if (parsed.mode === 'advisory') {
    try {
      const adv = gateMod.detectGoodhartGateAdvisory()
      if (adv.kind === 'none') {
        return {
          type: 'text',
          value:
            `Goodhart gate advisory: none (window=${adv.windowLabel}, ` +
            `blocked=${adv.stats.blocked}, bypassed=${adv.stats.bypassed}, ` +
            `passed=${adv.stats.passed}, fail-open=${adv.stats.failOpen}).`,
        }
      }
      return {
        type: 'text',
        value: `Goodhart gate advisory [${adv.kind}] (${adv.windowLabel}): ${adv.message}`,
      }
    } catch (e) {
      return {
        type: 'text',
        value: `Goodhart gate advisory: unavailable (${(e as Error).message}).`,
      }
    }
  }

  // --gate / --gate --detail:仅渲染 gate 摘要。
  if (parsed.mode === 'gate' || parsed.mode === 'gate-detail') {
    try {
      const gateLines = gateMod.buildGoodhartGateSummaryLines({
        compact: parsed.mode === 'gate',
      })
      if (gateLines.length === 0) {
        return {
          type: 'text',
          value:
            'Goodhart gate: no events recorded yet.\n' +
            'Events land here after promoteOrganism hits the §6.2 gate (blocked/bypassed/passed/fail-open).',
        }
      }
      return { type: 'text', value: gateLines.join('\n') }
    } catch (e) {
      return {
        type: 'text',
        value: `Goodhart gate: unavailable (${(e as Error).message}).`,
      }
    }
  }

  // status / detail:原有 health 视图。
  const compact = parsed.mode === 'status'
  const lines = mod.buildGoodhartHealthSummaryLines({ compact })
  if (lines.length === 0) {
    return {
      type: 'text',
      value:
        'Goodhart health: unavailable (no source has emitted data yet).\n' +
        'Run /evolve-rare-check --analyze or /evolve-drift-check --status to seed ledgers.',
    }
  }
  return { type: 'text', value: lines.join('\n') }
}

const evolveGoodhartCheck = {
  type: 'local',
  name: 'evolve-goodhart-check',
  description:
    'Kernel v1.0 §6.2 unified view. Combines oracle drift cadence, rare-sample guard, benchmark drift (health), gate ledger events, and advisory detector into one read-only command. Use --gate for gate stats, --advisory for just the advisory, --json for merged output.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveGoodhartCheck
