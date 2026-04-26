/**
 * /evolve-phylogeny —— self-evolution-kernel v1.0 Phase 4(2026-04-24)
 *
 * 把 lineageBuilder 的血缘 forest 落盘成两份 md 报告:
 *   - PHYLOGENY.md(每次 --write 覆盖;当前血缘快照)
 *   - GENESIS.md(首次 --write 写入并锚定首代 commit;之后保留,--force 可重写)
 *
 * 子命令(互斥):
 *   /evolve-phylogeny --write [--max-depth N] [--no-kin] [--force-genesis]
 *       写盘两份 md,返回落盘路径 + 操作摘要。
 *
 *   /evolve-phylogeny --preview [--max-depth N] [--no-kin]
 *       只渲染不写盘,返回 PHYLOGENY.md 的完整内容;便于审阅要写什么。
 *
 *   /evolve-phylogeny --paths
 *       只打印将要写到哪里(诊断用);不读 forest、不写盘。
 *
 * 安全:
 *   - 纯本地 fs 操作,不触网、不动 memory、不改 skills。
 *   - 写入目标在 getPhylogenyDir() ≈ ~/.claude/autoEvolve/phylogeny/。
 *   - 所有 writer 都 fail-open,命令层直接贴 writer 的 summary。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-phylogeny --write [--max-depth N] [--no-kin] [--force-genesis]
      Write PHYLOGENY.md (always overwrites) + GENESIS.md (idempotent;
      re-anchor with --force-genesis).

  /evolve-phylogeny --preview [--max-depth N] [--no-kin]
      Dry-run: render PHYLOGENY.md content without touching disk.

  /evolve-phylogeny --paths
      Show target paths only; no forest scan, no disk writes.

Flags:
  --max-depth N   clamp ASCII tree depth in PHYLOGENY.md (default unlimited)
  --no-kin        hide kin sim / source tags on child nodes
  --force-genesis re-anchor GENESIS.md even if it already exists
                  (only meaningful with --write)

Read-only by default for --preview / --paths; --write touches phylogeny dir only.`

type Mode = 'write' | 'preview' | 'paths' | null

interface ParsedFlags {
  mode: Mode
  maxDepth: number | null
  showKin: boolean
  forceGenesis: boolean
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    mode: null,
    maxDepth: null,
    showKin: true,
    forceGenesis: false,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--write':
      case '--preview':
      case '--paths': {
        const next = t.slice(2) as Mode
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with ${t}`
          return out
        }
        out.mode = next
        break
      }
      case '--max-depth': {
        const nx = tokens[i + 1]
        if (!nx || nx.startsWith('--')) {
          out.error = '--max-depth requires a positive integer'
          return out
        }
        const n = Number.parseInt(nx, 10)
        if (!Number.isFinite(n) || n < 1 || n > 64) {
          out.error = `--max-depth must be 1..64 (got "${nx}")`
          return out
        }
        out.maxDepth = n
        i++
        break
      }
      case '--no-kin':
        out.showKin = false
        break
      case '--force-genesis':
        out.forceGenesis = true
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
  if (!out.mode) out.error = `no mode specified\n\n${USAGE}`
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const writerMod = await import(
    '../../services/autoEvolve/phylogeny/phylogenyWriter.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --paths ─────────────────────────────────────────
  if (parsed.mode === 'paths') {
    const dir = pathsMod.getPhylogenyDir()
    const lines: string[] = []
    lines.push('## /evolve-phylogeny — target paths')
    lines.push('')
    lines.push(`phylogeny dir:   ${dir}`)
    lines.push(`PHYLOGENY.md:    ${dir}/PHYLOGENY.md`)
    lines.push(`GENESIS.md:      ${dir}/GENESIS.md`)
    lines.push('')
    lines.push('use `/evolve-phylogeny --write` to populate these files.')
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --preview ───────────────────────────────────────
  if (parsed.mode === 'preview') {
    const lineageMod = await import(
      '../../services/autoEvolve/arena/lineageBuilder.js'
    )
    const forest = lineageMod.buildLineageForest()
    const stats = lineageMod.summarizeLineage(forest)
    const md = writerMod.renderPhylogenyMarkdown(forest, stats, {
      maxDepth:
        parsed.maxDepth === null ? undefined : parsed.maxDepth,
      showKin: parsed.showKin,
    })
    return { type: 'text', value: md }
  }

  // ── --write ─────────────────────────────────────────
  // 同步写两份。GENESIS 若已存在且未 --force-genesis → already-present,
  // 不视为失败。任一步失败不阻塞另一步。
  const phResult = writerMod.writePhylogenyMarkdown({
    maxDepth: parsed.maxDepth === null ? undefined : parsed.maxDepth,
    showKin: parsed.showKin,
  })
  const genResult = writerMod.writeGenesisMarkdownIfMissing({
    force: parsed.forceGenesis,
  })
  const lines: string[] = []
  lines.push('## /evolve-phylogeny — write result')
  lines.push('')
  lines.push(`- PHYLOGENY: ${phResult.status}`)
  lines.push(`    path:    ${phResult.path}`)
  lines.push(`    summary: ${phResult.summary}`)
  lines.push(`- GENESIS:   ${genResult.status}`)
  lines.push(`    path:    ${genResult.path}`)
  lines.push(`    summary: ${genResult.summary}`)
  return { type: 'text', value: lines.join('\n') }
}

const evolvePhylogeny = {
  type: 'local',
  name: 'evolve-phylogeny',
  description:
    'self-evolution-kernel v1.0 Phase 4 phylogeny writer. Renders the lineage forest (from Phase 34 lineageBuilder) into PHYLOGENY.md (per-call overwrite) and anchors first-commit metadata into GENESIS.md (idempotent; --force-genesis re-writes). Subcommands: --write / --preview (dry-run markdown) / --paths (diagnostic paths only). Read-only for --preview|--paths; --write targets only the phylogeny dir under ~/.claude/autoEvolve/.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolvePhylogeny
