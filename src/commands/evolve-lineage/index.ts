/**
 * /evolve-lineage <subcommand>
 *
 * autoEvolve(v1.0) — Phase 34:血缘链可视化。
 *
 * 背景:Phase 32 给每个 organism 的 manifest 塞了 `kinSeed.stableId`
 * 指明它是从哪个 stable 父节点借种来的;Phase 34 把这条链条画成 ASCII
 * 血缘树,让用户能审计整个 genome 进化谱系:
 *
 *   - 谁是"祖先"(无 kinSeed 的 stable root)
 *   - 谁是"后代"(shadow/canary/archived 借种而来)
 *   - 谁是"孤儿"(kinSeed 指向一个已经不存在的 stableId —— 父被
 *     archive 了 / 手动删了,后代留下断链)
 *   - 每个节点挂 status / trials / wins / losses / ageDays,一眼看
 *     成熟度分布
 *
 * 子命令(互斥):
 *   /evolve-lineage --tree [root-id] [--max-depth N] [--no-kin]
 *       打印整棵 forest(不给 root-id)或单棵子树(给 root-id);可限深度
 *   /evolve-lineage --stats
 *       打印聚合统计:总节点数 / roots / orphans / maxDepth / byStatus /
 *       kinnedNodes / kinDisabled / largestFamily
 *   /evolve-lineage --json [root-id]
 *       输出机器可读的 JSON(整个 forest 或单棵子树)
 *
 * 安全:
 *   纯只读,不依赖任何 feature flag,任何时候都能跑(审计友好)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-lineage --tree [root-id] [--max-depth N] [--no-kin]
      ASCII forest (no root-id) or single subtree (with root-id).
      --max-depth N  clamp depth (default unlimited); children beyond are
                     collapsed with a "subtree(s) hidden" hint
      --no-kin       hide kin sim / source tags on child nodes

  /evolve-lineage --stats
      aggregate genome stats: total / roots / orphans / maxDepth /
      byStatus / kinnedNodes / kinDisabled / largestFamily

  /evolve-lineage --json [root-id]
      JSON dump of the forest (or a single subtree when root-id is given);
      children are nested; cycle/orphan flags surface in each node

  Read-only; does not touch disk; works regardless of CLAUDE_EVOLVE_* flags.
  Exactly one mode (--tree / --stats / --json) is required.`

type Mode = 'tree' | 'stats' | 'json' | null

interface ParsedFlags {
  mode: Mode
  rootId: string | null
  maxDepth: number | null
  showKin: boolean
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = {
    mode: null,
    rootId: null,
    maxDepth: null,
    showKin: true,
    error: null,
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--tree':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --tree`
          return out
        }
        out.mode = 'tree'
        break
      case '--stats':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --stats`
          return out
        }
        out.mode = 'stats'
        break
      case '--json':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --json`
          return out
        }
        out.mode = 'json'
        break
      case '--max-depth': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--max-depth requires a positive integer'
          return out
        }
        const n = Number.parseInt(next, 10)
        if (!Number.isFinite(n) || n < 1 || n > 64) {
          out.error = `--max-depth must be 1..64 (got "${next}")`
          return out
        }
        out.maxDepth = n
        i++
        break
      }
      case '--no-kin':
        out.showKin = false
        break
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        if (t.startsWith('--')) {
          out.error = `Unknown flag "${t}"\n\n${USAGE}`
          return out
        }
        // 非 flag token → root-id(只在 --tree / --json 下有意义)
        if (out.rootId) {
          out.error = `only one root-id is allowed (already have "${out.rootId}", got "${t}")`
          return out
        }
        out.rootId = t
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

  const lineageMod = await import(
    '../../services/autoEvolve/arena/lineageBuilder.js'
  )

  const forest = lineageMod.buildLineageForest()

  // ── --stats ──────────────────────────────────────────
  if (parsed.mode === 'stats') {
    const s = lineageMod.summarizeLineage(forest)
    const lines: string[] = []
    lines.push(`## autoEvolve Lineage — stats (Phase 34)`)
    lines.push('')
    lines.push(`total organisms:     ${s.total}`)
    lines.push(`roots (no kinSeed):  ${s.roots}`)
    lines.push(
      `orphans (kinSeed →   ${s.orphans}   (kin parent not found in repo)`,
    )
    lines.push(`max depth:           ${s.maxDepth}`)
    lines.push(`kinned nodes:        ${s.kinnedNodes}   (kinSeed → real parent)`)
    lines.push(`kin disabled:        ${s.kinDisabled}   (kinSeed=null; Phase 32 explicitly off)`)
    lines.push('')
    lines.push(`by status:`)
    for (const [status, count] of Object.entries(s.byStatus)) {
      lines.push(`  ${status.padEnd(10)}  ${count}`)
    }
    if (s.largestFamily) {
      lines.push('')
      lines.push(
        `largest family:      ${s.largestFamily.rootId}  (${s.largestFamily.size} nodes in subtree)`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --json ──────────────────────────────────────────
  if (parsed.mode === 'json') {
    // 去掉 parent 循环引用,只保留纯前向(children 递归)
    function stripForJson(n: any): any {
      return {
        id: n.id,
        status: n.status,
        name: n.name,
        kind: n.kind,
        kinSeed: n.kinSeed,
        maturity: n.maturity,
        depth: n.depth,
        orphanOfId: n.orphanOfId,
        cycle: n.cycle,
        children: n.children.map(stripForJson),
      }
    }
    if (parsed.rootId) {
      const sub = forest.byId[parsed.rootId]
      if (!sub) {
        return {
          type: 'text',
          value: `no organism with id="${parsed.rootId}"\n\nhint: use \`/evolve-status\` to list known ids`,
        }
      }
      return {
        type: 'text',
        value: JSON.stringify(stripForJson(sub), null, 2),
      }
    }
    return {
      type: 'text',
      value: JSON.stringify(
        {
          stats: forest.stats,
          trees: forest.trees.map(stripForJson),
        },
        null,
        2,
      ),
    }
  }

  // ── --tree ──────────────────────────────────────────
  if (parsed.mode === 'tree') {
    const lines: string[] = []
    lines.push(`## autoEvolve Lineage — tree (Phase 34)`)
    lines.push('')

    if (parsed.rootId) {
      const sub = forest.byId[parsed.rootId]
      if (!sub) {
        return {
          type: 'text',
          value: `no organism with id="${parsed.rootId}"\n\nhint: use \`/evolve-status\` to list known ids`,
        }
      }
      lines.push(`subtree rooted at: ${parsed.rootId}`)
      lines.push('')
      const body = lineageMod.renderLineageAscii([sub], {
        maxDepth:
          parsed.maxDepth === null ? undefined : parsed.maxDepth,
        showKin: parsed.showKin,
      })
      lines.push(body)
      return { type: 'text', value: lines.join('\n') }
    }

    if (forest.trees.length === 0) {
      lines.push(
        `(no organisms — run /evolve-sense to start the genome repository)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }

    lines.push(
      `total=${forest.stats.total}  roots=${forest.stats.roots}  orphans=${forest.stats.orphans}  maxDepth=${forest.stats.maxDepth}`,
    )
    lines.push('')
    const body = lineageMod.renderLineageAscii(forest.trees, {
      maxDepth: parsed.maxDepth === null ? undefined : parsed.maxDepth,
      showKin: parsed.showKin,
    })
    lines.push(body)
    lines.push('')
    lines.push(
      `legend: [status] (name)  winRate  trials  age | child tags: sim=<jaccard> src=<file> / ORPHAN→<id> / CYCLE!`,
    )
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: USAGE }
}

const evolveLineage = {
  type: 'local',
  name: 'evolve-lineage',
  description:
    'Phase 34 lineage visualizer. Traces organism → kin → grandkin chain via Phase 32 manifest.kinSeed + Phase 11 retro maturity signals. Modes --tree [root-id] / --stats / --json are strictly read-only (no disk writes, no flag gating). --tree prints ASCII forest or subtree with status + winRate + trials + ageDays per node; --stats aggregates byStatus / roots / orphans / kinnedNodes / largestFamily; --json emits machine-readable dump.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveLineage
