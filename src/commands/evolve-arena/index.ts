/**
 * /evolve-arena <subcommand>
 *
 * autoEvolve(v1.0) — Phase 30 + Phase 33:并行多-arena worktree 控制器 + 调度器。
 *
 * 背景:Phase 25 一次 proposal 只能 spawn 一个 worktree,多 organism 只能
 * 串行走 shadow → canary → stable,测试链墙钟时间被单体 spawn 吃掉。Phase 30
 * 的 arenaController.spawnOrganismWorktreesBatch 允许一批 organism 同时
 * spawn 到独立 worktree,每个走独立分支;Phase 33 的 arenaScheduler 再在
 * shadow/ 池上加一层 breadth-first 优先级排序,让调用方不用自己挑 id。
 *
 * 子命令(互斥):
 *   /evolve-arena --list
 *       打印当前磁盘上仍活跃的 arena/worktrees/<id>/ 条目(markerExists 标注)
 *   /evolve-arena --spawn <id> [<id> ...] [--max-parallel N]
 *       批量 spawn,超过 MAX_PARALLEL_ARENAS=8 时整体拒绝(语义干净,不做半拉)
 *   /evolve-arena --spawn-auto N [--max-parallel N]    (Phase 33)
 *       让 arenaScheduler 从 shadow/ 中挑 top-N 自动 spawn
 *   /evolve-arena --schedule [N]                       (Phase 33)
 *       打印当前 shadow/ 的优先级队列(read-only,不依赖 CLAUDE_EVOLVE_ARENA)
 *   /evolve-arena --cleanup <id> [<id> ...]
 *       批量 cleanup(rm 目录 + 删 branch + 删 worktree registration)
 *   /evolve-arena --cleanup-all
 *       对 listActiveArenaWorktrees() 的全量 cleanup,方便批次结束后一键收尾
 *
 * 安全:
 *   CLAUDE_EVOLVE_ARENA 关闭时所有写入模式(--spawn/--spawn-auto/--cleanup/--cleanup-all)
 *   静默返回 attempted=false;--list / --schedule 仍可读(便于审计)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-arena --list
      list active arena/worktrees/<id>/ directories (read-only; works even if
      CLAUDE_EVOLVE_ARENA is off, so you can audit historical residue)

  /evolve-arena --schedule [N]                                   (Phase 33)
      show the shadow/ priority queue with component breakdown
      (read-only; never touches disk; N defaults to all entries)

  /evolve-arena --spawn <id> [<id> ...] [--max-parallel N]
      spawn one git worktree + dedicated branch per id; capped at
      MAX_PARALLEL_ARENAS=8 (batch is refused whole-hog if the projected
      active count would exceed the cap); requires CLAUDE_EVOLVE_ARENA=on

  /evolve-arena --spawn-auto N [--max-parallel N]                (Phase 33/42)
      let the Phase 33 scheduler pick top-N ids from shadow/ and batch-spawn
      them; same cap semantics as --spawn; requires CLAUDE_EVOLVE_ARENA=on
      optional Phase 42 shadow-run inputs:
        --query-text TEXT
        --target-files a,b,c
        --grep-needle TEXT
        --web-url URL

  /evolve-arena --cleanup <id> [<id> ...]
      rm worktree + branch for each id (failures don't contaminate siblings);
      requires CLAUDE_EVOLVE_ARENA=on

  /evolve-arena --cleanup-all
      cleanup every entry returned by listActiveArenaWorktrees(); handy for
      end-of-batch teardown

  Exactly one mode flag (--list / --schedule / --spawn / --spawn-auto /
  --cleanup / --cleanup-all) is required.`

type Mode =
  | 'list'
  | 'schedule'
  | 'spawn'
  | 'spawn-auto'
  | 'cleanup'
  | 'cleanup-all'
  | null

interface ParsedFlags {
  mode: Mode
  ids: string[]
  maxParallel?: number
  /** Phase 33: --schedule [N] / --spawn-auto N 的 N */
  scheduleCount?: number
  /** Phase 42: shadow runner dynamic inputs (currently only used by --spawn-auto) */
  queryText?: string
  targetFiles?: string[]
  grepNeedle?: string
  webUrl?: string
  error: string | null
}

function pushShadowSandboxSummary(
  lines: string[],
  profile: { allow: string[]; warn: string[]; deny: string[] },
): void {
  lines.push('shadow sandbox (Phase 42):')
  lines.push(
    `  allow[${profile.allow.length}]: ${profile.allow.join(', ') || '(none)'}`,
  )
  lines.push(
    `  deny[${profile.deny.length}]: ${profile.deny.join(', ') || '(none)'}`,
  )
  if (profile.warn.length > 0) {
    lines.push(`  warn[${profile.warn.length}]: ${profile.warn.join(', ')}`)
  }
  lines.push(
    '  note: current arena worktrees are isolated git dirs; Phase 42 read-only shadow runs can still plan against a derived path even before the arena worktree is spawned.',
  )
  lines.push('')
}

function renderArenaWorktreeHint(args: {
  markerExists: boolean
}): string {
  return args.markerExists
    ? 'bound on disk'
    : 'path present but marker missing (partial residue or manual directory)'
}

function renderSpawnEntryHint(entry: {
  attempted: boolean
  success: boolean
  reason: string
}): string | null {
  if (!entry.attempted) return 'spawn skipped'
  if (entry.success) {
    if (entry.reason.includes('arena worktree already bound on disk')) {
      return 'worktree already bound on disk'
    }
    if (entry.reason.includes('arena worktree created on existing branch')) {
      return 'worktree bound on existing branch'
    }
    return 'worktree spawned/bound'
  }
  if (entry.reason.includes('arena path conflict:')) {
    return 'path conflict: directory exists but is not a registered git worktree'
  }
  if (entry.reason.includes('arena spawn failed: git worktree add reuse failed')) {
    return 'git worktree add (branch reuse) failed'
  }
  if (entry.reason.includes('arena spawn failed: git worktree add failed')) {
    return 'git worktree add failed'
  }
  if (entry.reason.includes('arena root prepare failed:')) {
    return 'arena root directory could not be prepared'
  }
  if (entry.reason.includes('arena spawn gated: CLAUDE_EVOLVE_ARENA is off')) {
    return 'spawn gated: arena feature flag is off'
  }
  return null
}

function renderBatchReasonHint(args: {
  reason: string
  mode: 'spawn' | 'spawn-auto' | 'cleanup' | 'cleanup-all'
}): string | null {
  if (args.reason.includes('arena spawn gated: CLAUDE_EVOLVE_ARENA is off')) {
    return 'hint: arena spawning is gated off, so later shadow plans may still report arena-derived-missing until a real worktree is spawned'
  }
  if (args.reason.includes('arena cleanup gated: CLAUDE_EVOLVE_ARENA is off')) {
    return 'hint: cleanup is gated off because arena write operations are disabled'
  }
  if (args.reason.includes('arena spawn capped:')) {
    return 'hint: batch refused whole-hog; free an existing worktree with /evolve-arena --cleanup-all or raise --max-parallel'
  }
  if (args.reason.includes('arena spawn skipped: no valid organism ids')) {
    return 'hint: no non-empty ids survived dedup — double-check the --spawn args'
  }
  if (args.reason.includes('arena cleanup skipped: no valid organism ids')) {
    return 'hint: no non-empty ids survived dedup — double-check the --cleanup args'
  }
  if (args.reason.startsWith('arena spawn finished:')) {
    if (/\b0\/\d+\b/.test(args.reason)) {
      return 'hint: batch attempted but 0 worktrees became ready — inspect per-entry reason lines below'
    }
    return null
  }
  if (args.reason.startsWith('arena cleanup finished:')) {
    if (/\b0\/\d+\b/.test(args.reason)) {
      return 'hint: batch attempted but 0 worktrees were removed — inspect per-entry reason lines below'
    }
    return null
  }
  return null
}

function tokenizeArgs(args: string): string[] {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return tokens.map(token => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1)
    }
    return token
  })
}

function parseFlags(args: string): ParsedFlags {
  const tokens = tokenizeArgs(args.trim())
  const out: ParsedFlags = { mode: null, ids: [], error: null }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--list':
      case '-l':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --list`
          return out
        }
        out.mode = 'list'
        break
      case '--spawn':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --spawn`
          return out
        }
        out.mode = 'spawn'
        break
      case '--spawn-auto': {
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --spawn-auto`
          return out
        }
        out.mode = 'spawn-auto'
        // --spawn-auto 后必须跟一个正整数 N
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--spawn-auto requires a positive integer N (top-N from scheduler)'
          return out
        }
        const n = Number.parseInt(next, 10)
        if (!Number.isFinite(n) || n < 1 || n > 64) {
          out.error = `--spawn-auto N must be 1..64 (got "${next}")`
          return out
        }
        out.scheduleCount = n
        i++
        break
      }
      case '--schedule': {
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --schedule`
          return out
        }
        out.mode = 'schedule'
        // --schedule 后可选 N(默认全量)
        const next = tokens[i + 1]
        if (next && !next.startsWith('--')) {
          const n = Number.parseInt(next, 10)
          if (!Number.isFinite(n) || n < 1 || n > 500) {
            out.error = `--schedule N must be 1..500 (got "${next}")`
            return out
          }
          out.scheduleCount = n
          i++
        }
        break
      }
      case '--cleanup':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --cleanup`
          return out
        }
        out.mode = 'cleanup'
        break
      case '--cleanup-all':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --cleanup-all`
          return out
        }
        out.mode = 'cleanup-all'
        break
      case '--max-parallel': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--max-parallel requires a positive integer'
          return out
        }
        const n = Number.parseInt(next, 10)
        if (!Number.isFinite(n) || n < 1 || n > 64) {
          out.error = `--max-parallel must be 1..64 (got "${next}")`
          return out
        }
        out.maxParallel = n
        i++
        break
      }
      case '--query-text': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--query-text requires a value'
          return out
        }
        out.queryText = next
        i++
        break
      }
      case '--target-files': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--target-files requires a comma-separated list'
          return out
        }
        out.targetFiles = next.split(',').map(x => x.trim()).filter(Boolean)
        i++
        break
      }
      case '--grep-needle': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--grep-needle requires a value'
          return out
        }
        out.grepNeedle = next
        i++
        break
      }
      case '--web-url': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--web-url requires a value'
          return out
        }
        out.webUrl = next
        i++
        break
      }
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        // 非 flag 的 token 视为 id(只 --spawn / --cleanup 消费)
        if (t.startsWith('--')) {
          out.error = `Unknown flag "${t}"\n\n${USAGE}`
          return out
        }
        out.ids.push(t)
    }
  }

  if (!out.mode) {
    out.error = `no mode specified\n\n${USAGE}`
  }
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const arenaMod = await import(
    '../../services/autoEvolve/arena/arenaController.js'
  )
  const featMod = await import(
    '../../services/autoEvolve/featureCheck.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')
  const sandboxMod = await import(
    '../../services/autoEvolve/arena/sandboxFilter.js'
  )
  const shadowRunnerMod = await import(
    '../../services/autoEvolve/arena/shadowRunner.js'
  )
  const sandboxProfile = sandboxMod.getDefaultShadowSandboxProfile()

  // ── --list ────────────────────────────────────────────
  if (parsed.mode === 'list') {
    const active = arenaMod.listActiveArenaWorktrees()
    const lines: string[] = []
    lines.push(`## autoEvolve Arena Worktrees (Phase 30)`)
    lines.push('')
    lines.push(`root: ${pathsMod.getArenaWorktreesDir()}`)
    lines.push(
      `CLAUDE_EVOLVE_ARENA: ${featMod.isAutoEvolveArenaEnabled() ? 'on' : 'off (spawn/cleanup gated; list is always allowed)'}`,
    )
    lines.push(`MAX_PARALLEL_ARENAS: ${arenaMod.MAX_PARALLEL_ARENAS}`)
    lines.push('')
    pushShadowSandboxSummary(lines, sandboxProfile)
    if (active.length === 0) {
      lines.push(
        `(no active worktrees — use \`/evolve-arena --spawn <id> [<id> ...]\` to create)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'id'.padEnd(40)}  marker  state                                  worktreePath`,
    )
    lines.push(
      '  ' + '-'.repeat(40) + '  ------  ' + '-'.repeat(36) + '  ' + '-'.repeat(40),
    )
    for (const w of active) {
      lines.push(
        `  ${w.id.padEnd(40)}  ${w.markerExists ? 'yes   ' : 'NO    '}  ${renderArenaWorktreeHint({ markerExists: w.markerExists }).padEnd(36)}  ${w.worktreePath}`,
      )
    }
    lines.push('')
    const stale = active.filter(w => !w.markerExists).length
    if (stale > 0) {
      lines.push(
        `note: ${stale} worktree(s) lack a .autoevolve-organism marker — likely partial residue. Consider \`/evolve-arena --cleanup-all\` if CLAUDE_EVOLVE_ARENA is on.`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --spawn ───────────────────────────────────────────
  if (parsed.mode === 'spawn') {
    if (parsed.ids.length === 0) {
      return {
        type: 'text',
        value: `--spawn requires at least one <id>\n\n${USAGE}`,
      }
    }
    const result = arenaMod.spawnOrganismWorktreesBatch(parsed.ids, {
      maxParallel: parsed.maxParallel,
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Arena — spawn batch (Phase 30)`)
    lines.push('')
    lines.push(
      `attempted: ${result.attempted}  |  reason: ${result.reason}`,
    )
    const reasonHint = renderBatchReasonHint({
      reason: result.reason,
      mode: 'spawn',
    })
    if (reasonHint) {
      lines.push(reasonHint)
    }
    lines.push('')
    pushShadowSandboxSummary(lines, sandboxProfile)
    if (result.capHit) {
      lines.push(
        `cap hit: activeBefore=${result.capHit.activeBefore}, requested=${result.capHit.requested}, cap=${result.capHit.cap}`,
      )
      lines.push(
        `hint: cleanup idle worktrees with \`/evolve-arena --cleanup-all\` or raise --max-parallel (hard cap=${arenaMod.MAX_PARALLEL_ARENAS}).`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push('')
    for (const e of result.entries) {
      const badge = e.success ? '✓' : e.attempted ? '✗' : '·'
      const hint = renderSpawnEntryHint(e)
      lines.push(
        `  ${badge} ${e.id.padEnd(40)}  ${e.success ? e.worktreePath ?? '' : e.reason}`,
      )
      if (hint) {
        lines.push(`      state: ${hint}`)
      }
      if (e.success && e.branch) {
        lines.push(`      branch: ${e.branch}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --schedule (Phase 33) ────────────────────────────
  if (parsed.mode === 'schedule') {
    const schedMod = await import(
      '../../services/autoEvolve/arena/arenaScheduler.js'
    )
    const entries = schedMod.listShadowPriority({
      topN: parsed.scheduleCount,
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Arena — schedule (Phase 33)`)
    lines.push('')
    lines.push(
      `CLAUDE_EVOLVE_ARENA: ${featMod.isAutoEvolveArenaEnabled() ? 'on' : 'off (schedule is always read-only; spawn-auto still gated)'}`,
    )
    lines.push(
      `shadow/ candidates: ${entries.length}${typeof parsed.scheduleCount === 'number' ? ` (topN=${parsed.scheduleCount})` : ''}`,
    )
    lines.push('')
    pushShadowSandboxSummary(lines, sandboxProfile)
    if (entries.length === 0) {
      lines.push(
        `(no shadow organisms — compile a PatternCandidate first via emergence pipeline)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'#'.padStart(2)}  ${'id'.padEnd(32)}  ${'prio'.padStart(5)}  ${'trials'.padStart(6)}  ${'ageDays'.padStart(7)}  ${'stale'.padStart(5)}  kin  name`,
    )
    lines.push(
      '  ' + '-'.repeat(2) + '  ' + '-'.repeat(32) + '  ' + '-'.repeat(5) + '  ' + '-'.repeat(6) + '  ' + '-'.repeat(7) + '  ' + '-'.repeat(5) + '  ---  ' + '-'.repeat(40),
    )
    entries.forEach((e, idx) => {
      const kinBadge =
        e.summary.kinSeed && typeof e.summary.kinSeed === 'object'
          ? 'yes'
          : e.summary.kinSeed === null
            ? 'off'
            : ' no'
      const staleStr =
        e.summary.staleDays === null
          ? 'never'
          : e.summary.staleDays.toFixed(1)
      lines.push(
        `  ${String(idx + 1).padStart(2)}  ${e.id.padEnd(32)}  ${e.priority.toFixed(3).padStart(5)}  ${String(e.summary.shadowTrials).padStart(6)}  ${e.summary.ageDays.toFixed(1).padStart(7)}  ${staleStr.padStart(5)}  ${kinBadge}  ${e.summary.name}`,
      )
    })
    lines.push('')
    lines.push(
      `priority components (weighted sum, each ∈ [0, 1]):` +
        ` trials×${0.45.toFixed(2)} + stale×${0.3.toFixed(2)} + age×${0.15.toFixed(2)} + kin×${0.1.toFixed(2)}`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --spawn-auto (Phase 33) ──────────────────────────
  if (parsed.mode === 'spawn-auto') {
    if (!parsed.scheduleCount) {
      return {
        type: 'text',
        value: `--spawn-auto requires a positive integer N\n\n${USAGE}`,
      }
    }
    const schedMod = await import(
      '../../services/autoEvolve/arena/arenaScheduler.js'
    )
    const picked = schedMod.pickNextShadowIds(parsed.scheduleCount, {})
    const lines: string[] = []
    lines.push(`## autoEvolve Arena — spawn-auto (Phase 33)`)
    lines.push('')
    lines.push(
      `scheduler picked ${picked.length} id(s) for top-${parsed.scheduleCount}: ${picked.length === 0 ? '(none — shadow/ empty or all active)' : picked.join(', ')}`,
    )
    if (picked.length === 0) {
      return { type: 'text', value: lines.join('\n') }
    }
    const result = arenaMod.spawnOrganismWorktreesBatch(picked, {
      maxParallel: parsed.maxParallel,
    })
    lines.push('')
    lines.push(
      `attempted: ${result.attempted}  |  reason: ${result.reason}`,
    )
    const reasonHint = renderBatchReasonHint({
      reason: result.reason,
      mode: 'spawn-auto',
    })
    if (reasonHint) {
      lines.push(reasonHint)
    }
    lines.push('')
    pushShadowSandboxSummary(lines, sandboxProfile)
    if (result.capHit) {
      lines.push(
        `cap hit: activeBefore=${result.capHit.activeBefore}, requested=${result.capHit.requested}, cap=${result.capHit.cap}`,
      )
      lines.push(
        `hint: cleanup idle worktrees with \`/evolve-arena --cleanup-all\` or raise --max-parallel (hard cap=${arenaMod.MAX_PARALLEL_ARENAS}).`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push('')
    for (const e of result.entries) {
      const badge = e.success ? '✓' : e.attempted ? '✗' : '·'
      const hint = renderSpawnEntryHint(e)
      lines.push(
        `  ${badge} ${e.id.padEnd(40)}  ${e.success ? e.worktreePath ?? '' : e.reason}`,
      )
      if (hint) {
        lines.push(`      state: ${hint}`)
      }
      if (e.success && e.branch) {
        lines.push(`      branch: ${e.branch}`)
      }
    }

    const sharedInputs = {
      queryText: parsed.queryText,
      targetFiles: parsed.targetFiles,
      grepNeedle: parsed.grepNeedle,
      webUrl: parsed.webUrl,
    }

    const planned = result.entries
      .filter(e => e.success)
      .map(e =>
        shadowRunnerMod.planShadowRun({
          organismId: e.id,
          status: 'shadow',
          requestedTools: sandboxProfile.allow,
          inputs: sharedInputs,
        }),
      )
      .filter(Boolean)

    if (planned.length > 0) {
      lines.push('')
      lines.push(...shadowRunnerMod.renderArenaShadowPlanBlock(planned))

      const executions = await Promise.all(
        planned.map(plan =>
          shadowRunnerMod.startShadowRun({
            organismId: plan.organismId,
            status: 'shadow',
            requestedTools: plan.requestedTools,
            inputs: plan.inputs,
            executeReadOnly: true,
          }),
        ),
      )

      lines.push('')
      lines.push(...shadowRunnerMod.renderArenaShadowExecutionBlock(executions))
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --cleanup ─────────────────────────────────────────
  if (parsed.mode === 'cleanup') {
    if (parsed.ids.length === 0) {
      return {
        type: 'text',
        value: `--cleanup requires at least one <id>\n\n${USAGE}`,
      }
    }
    const result = arenaMod.cleanupOrganismWorktreesBatch(parsed.ids)
    const lines: string[] = []
    lines.push(`## autoEvolve Arena — cleanup batch (Phase 30)`)
    lines.push('')
    lines.push(
      `attempted: ${result.attempted}  |  reason: ${result.reason}`,
    )
    const reasonHint = renderBatchReasonHint({
      reason: result.reason,
      mode: 'cleanup',
    })
    if (reasonHint) {
      lines.push(reasonHint)
    }
    lines.push('')
    for (const e of result.entries) {
      const badge = e.success ? '✓' : e.attempted ? '✗' : '·'
      lines.push(`  ${badge} ${e.id.padEnd(40)}  ${e.reason}`)
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --cleanup-all ─────────────────────────────────────
  if (parsed.mode === 'cleanup-all') {
    const active = arenaMod.listActiveArenaWorktrees()
    if (active.length === 0) {
      return {
        type: 'text',
        value: `## autoEvolve Arena — cleanup-all (Phase 30)\n\n(no active worktrees to clean up)`,
      }
    }
    const result = arenaMod.cleanupOrganismWorktreesBatch(
      active.map(a => a.id),
    )
    const lines: string[] = []
    lines.push(`## autoEvolve Arena — cleanup-all (Phase 30)`)
    lines.push('')
    lines.push(
      `attempted: ${result.attempted}  |  reason: ${result.reason}`,
    )
    const reasonHint = renderBatchReasonHint({
      reason: result.reason,
      mode: 'cleanup-all',
    })
    if (reasonHint) {
      lines.push(reasonHint)
    }
    lines.push('')
    for (const e of result.entries) {
      const badge = e.success ? '✓' : e.attempted ? '✗' : '·'
      lines.push(`  ${badge} ${e.id.padEnd(40)}  ${e.reason}`)
    }
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: USAGE }
}

const evolveArena = {
  type: 'local',
  name: 'evolve-arena',
  description:
    'Phase 30+33 parallel multi-arena worktree controller + scheduler. Subcommands --list / --schedule / --spawn / --spawn-auto / --cleanup / --cleanup-all manage concurrent organism worktrees (capped at MAX_PARALLEL_ARENAS=8). --schedule shows the shadow/ priority queue; --spawn-auto N lets the scheduler pick top-N. Requires CLAUDE_EVOLVE_ARENA=on for spawn/spawn-auto/cleanup; --list and --schedule are always read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveArena
