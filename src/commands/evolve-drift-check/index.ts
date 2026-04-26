/**
 * `/evolve-drift-check` — self-evolution-kernel v1.0 §6.2 Goodhart #2 入口
 *
 * 角色定位
 * ────────
 * 这是 **Oracle 权重随机漂移** (oracleDrift.ts) 的 user-facing 调度器。
 * 默认 dry-run:只展示"下一次漂移会把 4 维度权重改成什么",不落盘、
 * 不覆盖 tuned-oracle-weights.json。显式加 `--propose` 才追加一条
 * proposal 到 oracle-drift.ndjson。
 *
 * 为什么不自动应用?
 *   §6.2 的 Goodhart 对抗从来不是"让权重自己飞",而是**强制给 Oracle 一个
 *    反套利扰动**。自动应用会让 aggregator/metaOracle/autoPromotionEngine
 *    都读到"被谁改过的"权重——审计链会断。所以落盘写权重这一步必须走
 *    既有 `saveOracleWeights` 或 `/evolve-meta --apply`,由人工 review。
 *
 * 所有模式
 * ────────
 *   --status (默认)   : 打印 cadence / lastAt / magnitude 预算
 *   --propose          : 立刻追加一条 DriftProposal 到 ledger(shadow-only)
 *   --force            : 配合 --propose,忽略 cadence gate
 *   --history [N=10]   : 展示最近 N 条 proposal(精简行)
 *   --dry-run          : 明确 dry-run(等同 default,不 propose)
 *
 * 安全:本命令**绝不直接改 tuned-oracle-weights.json**。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-drift-check
  /evolve-drift-check --status
      (default) show cadence + last proposal + derived magnitude budget

  /evolve-drift-check --propose [--force] [--seed <int>]
      append one DriftProposal to oracle-drift.ndjson (shadow-only; does NOT
      change tuned-oracle-weights.json). --force bypasses the cadence gate.

  /evolve-drift-check --history [--limit 10]
      show recent proposals (newest last)

  --dry-run
      alias of --status; never writes

Env:
  CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS (default 14)
  CLAUDE_EVOLVE_ORACLE_DRIFT_MAGNITUDE    (default mutationRate * 0.05)
`

type Mode = 'status' | 'propose' | 'history' | null

interface ParsedFlags {
  mode: Mode
  force: boolean
  seed?: number
  limit: number
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let mode: Mode = null
  let force = false
  let seed: number | undefined
  let limit = 10

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--status' || t === '--dry-run') {
      if (mode !== null) return { mode: null, force, limit, error: USAGE }
      mode = 'status'
    } else if (t === '--propose') {
      if (mode !== null) return { mode: null, force, limit, error: USAGE }
      mode = 'propose'
    } else if (t === '--history') {
      if (mode !== null) return { mode: null, force, limit, error: USAGE }
      mode = 'history'
    } else if (t === '--force') {
      force = true
    } else if (t === '--seed') {
      const v = Number(tokens[++i])
      if (Number.isFinite(v)) seed = v | 0
    } else if (t === '--limit') {
      const v = Number(tokens[++i])
      if (Number.isFinite(v) && v > 0) limit = v | 0
    } else if (t === '--help' || t === '-h') {
      return { mode: null, force, limit, error: USAGE }
    } else if (t.length > 0) {
      return { mode: null, force, limit, error: `Unknown flag: ${t}\n\n${USAGE}` }
    }
  }

  if (mode === null) mode = 'status'
  return { mode, force, seed, limit }
}

function fmtDim(n: number): string {
  // 4 位小数,可辨识 0.001 级漂移
  return (Math.round(n * 10000) / 10000).toFixed(4)
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 懒加载,避免冷启动多读
  const driftMod = await import(
    '../../services/autoEvolve/oracle/oracleDrift.js'
  )
  const weightsMod = await import(
    '../../services/autoEvolve/oracle/fitnessOracle.js'
  )
  const genomeMod = await import(
    '../../services/autoEvolve/metaEvolve/metaGenome.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  const mg = genomeMod.loadMetaGenome()
  const mag = driftMod.deriveDriftMagnitude(mg.mutationRate)
  const cadence = (() => {
    const env = process.env.CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS
    if (env !== undefined && env !== '' && Number.isFinite(Number(env))) {
      return Math.max(1, Number(env))
    }
    return driftMod.DEFAULT_DRIFT_CADENCE_DAYS
  })()
  const gate = driftMod.shouldProposeDrift()

  // ── --history ──────────────────────────────────────────────
  if (parsed.mode === 'history') {
    const recent = driftMod.recentDriftProposals(parsed.limit)
    const out: string[] = []
    out.push(`## Oracle Drift History (kernel v1.0 §6.2 #2)`)
    out.push('')
    out.push(`path: ${pathsMod.getOracleDriftLedgerPath()}`)
    out.push('')
    if (recent.length === 0) {
      out.push(`(no proposals yet — run \`/evolve-drift-check --propose\` to seed the ledger)`)
    } else {
      out.push(`| at | reason | mag | Δ userSat | Δ taskSucc | Δ codeQ | Δ perf | applied |`)
      out.push(`|---|---|---|---|---|---|---|---|`)
      for (const p of recent) {
        const dUS = p.after.userSatisfaction - p.before.userSatisfaction
        const dTS = p.after.taskSuccess - p.before.taskSuccess
        const dCQ = p.after.codeQuality - p.before.codeQuality
        const dPF = p.after.performance - p.before.performance
        out.push(
          `| ${p.at} | ${p.reason} | ${p.magnitude.toFixed(4)} | ${fmtDim(dUS)} | ${fmtDim(dTS)} | ${fmtDim(dCQ)} | ${fmtDim(dPF)} | ${p.applied ? 'Y' : 'N'} |`,
        )
      }
    }
    return { type: 'text', value: out.join('\n') }
  }

  // ── --propose ──────────────────────────────────────────────
  if (parsed.mode === 'propose') {
    // 前置 gate(除非 --force)
    if (!parsed.force && !gate.should) {
      return {
        type: 'text',
        value: [
          `## Oracle Drift Proposal — skipped`,
          '',
          `reason: ${gate.reason}`,
          `last proposal at: ${gate.lastAt ?? '(none)'}`,
          `age: ${gate.ageDays === Infinity ? 'Infinity' : gate.ageDays.toFixed(2)}d`,
          `cadence: ${cadence}d`,
          '',
          `rerun with \`--force\` to override the cadence gate.`,
        ].join('\n'),
      }
    }
    const r = driftMod.proposeOracleDrift({
      force: parsed.force,
      seed: parsed.seed,
      mutationRate: mg.mutationRate,
    })
    if (!r.ok) {
      return { type: 'text', value: `Drift proposal rejected: ${r.reason}` }
    }
    const p = r.proposal
    const out: string[] = []
    out.push(`## Oracle Drift Proposal — appended`)
    out.push('')
    out.push(`at: ${p.at}`)
    out.push(`reason: ${p.reason}  seed: ${p.seed === -1 ? '(Math.random)' : p.seed}`)
    out.push(`magnitude: ${p.magnitude.toFixed(4)} (max ${driftMod.MAX_DRIFT_MAGNITUDE})`)
    out.push('')
    out.push(`| dim | before | after | Δ |`)
    out.push(`|---|---|---|---|`)
    for (const d of driftMod.DRIFT_DIMS) {
      const b = p.before[d]
      const a = p.after[d]
      out.push(`| ${d} | ${fmtDim(b)} | ${fmtDim(a)} | ${fmtDim(a - b)} |`)
    }
    out.push('')
    out.push(`ledger: ${pathsMod.getOracleDriftLedgerPath()}`)
    out.push(
      `note: tuned-oracle-weights.json was NOT modified. To actually apply, review this proposal then use \`/evolve-meta --apply\` with matching weights.`,
    )
    return { type: 'text', value: out.join('\n') }
  }

  // ── --status (default) ─────────────────────────────────────
  const weights = weightsMod.loadOracleWeights()
  const out: string[] = []
  out.push(`## Oracle Drift Status (kernel v1.0 §6.2 #2)`)
  out.push('')
  out.push(`cadence: ${cadence}d`)
  out.push(
    `last proposal: ${gate.lastAt ?? '(none)'}  age: ${gate.ageDays === Infinity ? '∞' : gate.ageDays.toFixed(2) + 'd'}`,
  )
  out.push(`should propose now: ${gate.should ? 'YES' : 'no'}  (reason: ${gate.reason})`)
  out.push('')
  out.push(`## Magnitude Budget`)
  out.push(`metaGenome.mutationRate: ${mg.mutationRate}`)
  out.push(
    `derived magnitude: ${mag.toFixed(4)}  (max ${driftMod.MAX_DRIFT_MAGNITUDE}, min ${driftMod.MIN_DRIFT_MAGNITUDE})`,
  )
  if (mag <= driftMod.MIN_DRIFT_MAGNITUDE) {
    out.push(
      `(magnitude below MIN ⇒ drift proposal will be a no-op; raise mutationRate or set CLAUDE_EVOLVE_ORACLE_DRIFT_MAGNITUDE)`,
    )
  }
  out.push('')
  out.push(`## Current Oracle Weights`)
  out.push(`version: ${weights.version}  updatedAt: ${weights.updatedAt}`)
  out.push(`- userSatisfaction: ${fmtDim(weights.userSatisfaction)}`)
  out.push(`- taskSuccess:      ${fmtDim(weights.taskSuccess)}`)
  out.push(`- codeQuality:      ${fmtDim(weights.codeQuality)}`)
  out.push(`- performance:      ${fmtDim(weights.performance)}`)
  out.push(`- safetyVetoEnabled: ${weights.safetyVetoEnabled}`)
  out.push('')
  out.push(`next action:`)
  if (gate.should) {
    out.push(`  /evolve-drift-check --propose         # append one proposal (shadow-only)`)
  } else {
    out.push(`  wait ≈${(cadence - gate.ageDays).toFixed(2)}d or use --force to override`)
  }
  out.push(`  /evolve-drift-check --history         # review past proposals`)
  return { type: 'text', value: out.join('\n') }
}

const evolveDriftCheck = {
  type: 'local',
  name: 'evolve-drift-check',
  description:
    'Kernel v1.0 §6.2 Goodhart #2 entry. --status shows cadence / magnitude budget / current weights; --propose appends a shadow-only DriftProposal to oracle-drift.ndjson (does NOT change tuned-oracle-weights.json). Use `/evolve-meta --apply` to actually adopt a proposal after review.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveDriftCheck
