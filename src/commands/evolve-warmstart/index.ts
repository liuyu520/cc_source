/**
 * /evolve-warmstart <subcommand>
 *
 * autoEvolve(v1.0) — Phase 35:冷启动 warmstart 策略库。
 *
 * 背景:新用户装好 autoEvolve 后 shadow/ 是空的 —— pattern miner 要攒
 * 够 feedback memories + dreams 才能产出候选,冷启动期间 /evolve-status /
 * /evolve-lineage / arena 全是空树。Phase 35 提供一组 curated baseline
 * pattern(review-guard / safe-rm-guard / commit-msg-guard / ...),一键
 * 种到 shadow/,让所有下游命令立即有 organism 可跑。
 *
 * 子命令(互斥):
 *   /evolve-warmstart --list [--tags tag1,tag2]
 *       只读模式,列出库里所有 baseline(slug / pitch / kind / tags);
 *       任何时候都能跑(不吃任何 feature flag)
 *   /evolve-warmstart --seed [--include slug1,slug2] [--exclude slug3]
 *                     [--dry-run] [--force]
 *       把 baseline 合成到 shadow/;include/exclude 精确选/排;dry-run 只打印
 *       计划;force 时 existing organism 会被 overwrite。
 *
 * 安全:
 *   --seed 默认需要 CLAUDE_EVOLVE_WARMSTART=on 或 CLAUDE_EVOLVE=on(和
 *   /evolve-tune 同款软 gate);未放行时返回 attempted=false 并提示。
 *   --dry-run 模式绕开 gate(计划本身不动磁盘,审计友好)。
 *   --list 永远只读,不吃 gate。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-warmstart --list [--tags tag1,tag2]
      list all curated baselines in the warmstart library (read-only;
      always available). --tags filters to entries whose tags include
      at least one of the listed values.

  /evolve-warmstart --seed [--include slug1,slug2] [--exclude slug3]
                    [--dry-run] [--force]
      seed the shadow/ genome with curated baseline organisms.
      --include  only seed the listed slugs (comma-separated)
      --exclude  drop the listed slugs from the full set
      --dry-run  print what would be seeded, touch no disk (bypasses
                 CLAUDE_EVOLVE gate for safe audit)
      --force    overwrite existing shadow organisms instead of skipping
      Requires CLAUDE_EVOLVE_WARMSTART=on or CLAUDE_EVOLVE=on to write.

  Exactly one mode flag (--list / --seed) is required.`

type Mode = 'list' | 'seed' | null

interface ParsedFlags {
  mode: Mode
  tags: string[] | null
  include: string[] | null
  exclude: string[] | null
  dryRun: boolean
  force: boolean
  error: string | null
}

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    mode: null,
    tags: null,
    include: null,
    exclude: null,
    dryRun: false,
    force: false,
    error: null,
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--list':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --list`
          return out
        }
        out.mode = 'list'
        break
      case '--seed':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --seed`
          return out
        }
        out.mode = 'seed'
        break
      case '--tags': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--tags requires a comma-separated list of tag values'
          return out
        }
        out.tags = parseCsv(next)
        if (out.tags.length === 0) {
          out.error = '--tags cannot be empty'
          return out
        }
        i++
        break
      }
      case '--include': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--include requires a comma-separated list of slugs'
          return out
        }
        out.include = parseCsv(next)
        if (out.include.length === 0) {
          out.error = '--include cannot be empty'
          return out
        }
        i++
        break
      }
      case '--exclude': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--exclude requires a comma-separated list of slugs'
          return out
        }
        out.exclude = parseCsv(next)
        if (out.exclude.length === 0) {
          out.error = '--exclude cannot be empty'
          return out
        }
        i++
        break
      }
      case '--dry-run':
        out.dryRun = true
        break
      case '--force':
        out.force = true
        break
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        out.error = `Unknown flag "${t}"\n\n${USAGE}`
        return out
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

  const lib = await import(
    '../../services/autoEvolve/emergence/warmstartLibrary.js'
  )

  // ── --list ────────────────────────────────────────────
  if (parsed.mode === 'list') {
    let baselines = lib.listBaselines()
    if (parsed.tags && parsed.tags.length > 0) {
      const wanted = new Set(parsed.tags)
      baselines = baselines.filter(b =>
        b.tags.some((tag: string) => wanted.has(tag)),
      )
    }
    const lines: string[] = []
    lines.push(`## autoEvolve Warmstart — library (Phase 35)`)
    lines.push('')
    lines.push(
      `total baselines: ${baselines.length}${parsed.tags ? ` (filtered by tags=${parsed.tags.join(',')})` : ''}`,
    )
    lines.push('')
    if (baselines.length === 0) {
      lines.push(
        parsed.tags
          ? `(no baselines match tags=${parsed.tags.join(',')})`
          : `(library is empty)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'slug'.padEnd(26)}  ${'kind'.padEnd(8)}  ${'tags'.padEnd(28)}  pitch`,
    )
    lines.push(
      '  ' + '-'.repeat(26) + '  ' + '-'.repeat(8) + '  ' + '-'.repeat(28) + '  ' + '-'.repeat(40),
    )
    for (const b of baselines) {
      lines.push(
        `  ${b.slug.padEnd(26)}  ${b.kind.padEnd(8)}  ${b.tags.join(',').padEnd(28)}  ${b.pitch}`,
      )
    }
    lines.push('')
    lines.push(
      `hint: use \`/evolve-warmstart --seed\` to plant them; pair with --dry-run to preview first.`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --seed ────────────────────────────────────────────
  if (parsed.mode === 'seed') {
    const lines: string[] = []
    lines.push(`## autoEvolve Warmstart — seed (Phase 35)`)
    lines.push('')

    // env gate —— --dry-run 时绕开,计划不动盘
    if (!parsed.dryRun && !lib.isWarmstartWriteEnabled()) {
      lines.push(
        `attempted: false  |  reason: CLAUDE_EVOLVE_WARMSTART is off (or CLAUDE_EVOLVE=off).`,
      )
      lines.push(
        `hint: set CLAUDE_EVOLVE_WARMSTART=on (or CLAUDE_EVOLVE=on) and retry, or use --dry-run to preview the plan.`,
      )
      return { type: 'text', value: lines.join('\n') }
    }

    const result = lib.seedWarmstart({
      include: parsed.include ?? undefined,
      exclude: parsed.exclude ?? undefined,
      dryRun: parsed.dryRun,
      force: parsed.force,
    })

    lines.push(
      `attempted: ${result.attempted}  |  dryRun: ${result.dryRun}  |  seeded=${result.counts.seeded}  skipped=${result.counts.skipped}  planned=${result.counts.planned}  filtered=${result.counts.filtered}`,
    )
    lines.push('')
    if (result.entries.length === 0) {
      lines.push(`(no baselines selected)`)
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'status'.padEnd(8)}  ${'slug'.padEnd(26)}  ${'organismId'.padEnd(14)}  reason`,
    )
    lines.push(
      '  ' + '-'.repeat(8) + '  ' + '-'.repeat(26) + '  ' + '-'.repeat(14) + '  ' + '-'.repeat(40),
    )
    for (const e of result.entries) {
      // status 列加 badge:seeded=✓ skipped=· filtered=— planned=✎
      const badge =
        e.status === 'seeded'
          ? '✓'
          : e.status === 'planned'
            ? '✎'
            : e.status === 'skipped'
              ? '·'
              : '—'
      lines.push(
        `  ${(badge + ' ' + e.status).padEnd(8)}  ${e.slug.padEnd(26)}  ${e.organismId.padEnd(14)}  ${e.reason}`,
      )
    }
    if (result.counts.seeded > 0) {
      lines.push('')
      lines.push(
        `next: run \`/evolve-status\` to see the new shadow organisms, or \`/evolve-lineage --tree\` for the lineage view.`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: USAGE }
}

const evolveWarmstart = {
  type: 'local',
  name: 'evolve-warmstart',
  description:
    'Phase 35 cold-start warmstart library. Two mutually-exclusive modes: `--list` (always read-only) enumerates curated baselines (slug/kind/tags/pitch) with optional `--tags` filter; `--seed` materializes selected baselines as shadow organisms via the skillCompiler pipeline. `--include` / `--exclude` pick slugs, `--dry-run` previews the plan (bypasses env gate), `--force` overwrites existing organisms. Writes require CLAUDE_EVOLVE_WARMSTART=on or CLAUDE_EVOLVE=on.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveWarmstart
