/**
 * /genealogy —— self-evolution-kernel v1.0 §2 支柱 V + §5 Phase 4 交付物
 *
 * 查某个 organism 的"代际身份":
 *   - 第几代(generation, root=0)
 *   - 祖先链(self → parent → grandparent → … → root)
 *   - 兄弟姊妹(同 parent 的其他 organism)
 *   - 子代摘要(kin-seeded 出来的后代)
 *   - 最近 promotion transitions(从 ledger 里找与该 id 相关的事件)
 *
 * 与既有命令的分工:
 *   - /fossil <uuid>          → 单节点化石卡(manifest + veto 教训 + fitness)
 *   - /evolve-lineage --tree  → 全森林或以某节点为根的子树 ASCII
 *   - /genealogy <id|name>    → 以某节点为中心的上下游"家谱片段",重点是"从哪来、
 *                               跟谁并肩、谁继承了我"
 *
 * 铁律:纯只读。不写 ledger / manifest / memory。fail-open(数据源炸了
 * 就打印错误段而不是整个命令崩溃)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /genealogy <id-or-name-prefix> [--json] [--no-transitions] [--no-children]
  /genealogy --find <keyword>   Search by name/id substring, print matching ids.

Flags:
  --json             Emit machine-readable JSON instead of markdown.
  --no-transitions   Hide recent promotion transitions section.
  --no-children      Hide children section (kin-seeded descendants).
  --max-transitions=N  Cap transitions rows (default 10).
  --max-siblings=N     Cap siblings rows (default 20).

Read-only. Does not touch ledger / manifest / memory files.`

type Mode = 'genealogy' | 'find' | null

interface ParsedFlags {
  mode: Mode
  query: string
  json: boolean
  showTransitions: boolean
  showChildren: boolean
  maxTransitions: number
  maxSiblings: number
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const out: ParsedFlags = {
    mode: null,
    query: '',
    json: false,
    showTransitions: true,
    showChildren: true,
    maxTransitions: 10,
    maxSiblings: 20,
  }
  const tokens = (args ?? '').trim().split(/\s+/).filter(t => t.length > 0)
  if (tokens.length === 0) {
    out.error = USAGE
    return out
  }
  let i = 0
  // 第一个位置参数:--find <kw> 或 <id-or-name>
  const first = tokens[0]!
  if (first === '--find') {
    out.mode = 'find'
    if (tokens.length < 2) {
      out.error = `--find requires a keyword\n\n${USAGE}`
      return out
    }
    out.query = tokens[1]!
    i = 2
  } else if (first === '--help' || first === '-h') {
    out.error = USAGE
    return out
  } else {
    out.mode = 'genealogy'
    out.query = first
    i = 1
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--json') out.json = true
    else if (t === '--no-transitions') out.showTransitions = false
    else if (t === '--no-children') out.showChildren = false
    else if (t.startsWith('--max-transitions=')) {
      const n = Number.parseInt(t.slice('--max-transitions='.length), 10)
      if (Number.isFinite(n) && n > 0) out.maxTransitions = n
    } else if (t.startsWith('--max-siblings=')) {
      const n = Number.parseInt(t.slice('--max-siblings='.length), 10)
      if (Number.isFinite(n) && n > 0) out.maxSiblings = n
    } else {
      out.error = `Unknown flag: ${t}\n\n${USAGE}`
      return out
    }
  }
  return out
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return '-'
    return d.toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return '-'
  }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  // 懒加载保持 /genealogy 与主流程解耦(和既有 evolve-lineage / fossil 一致)
  const { buildLineageForest } = await import(
    '../../services/autoEvolve/arena/lineageBuilder.js'
  )
  const { readRecentTransitions } = await import(
    '../../services/autoEvolve/arena/promotionFsm.js'
  )

  let forest
  try {
    forest = buildLineageForest()
  } catch (e) {
    return {
      type: 'text',
      value: `error: failed to build lineage forest: ${(e as Error).message}`,
    }
  }

  // ── --find 模式:按关键字列出候选 ─────────────────────
  if (parsed.mode === 'find') {
    const needle = parsed.query.toLowerCase()
    const hits = forest.allNodes.filter(
      n =>
        n.id.toLowerCase().includes(needle) ||
        n.name.toLowerCase().includes(needle),
    )
    if (parsed.json) {
      return {
        type: 'text',
        value: JSON.stringify(
          {
            query: parsed.query,
            count: hits.length,
            matches: hits.map(n => ({
              id: n.id,
              name: n.name,
              status: n.status,
              kind: n.kind,
              depth: n.depth,
            })),
          },
          null,
          2,
        ),
      }
    }
    if (hits.length === 0) {
      return { type: 'text', value: `No organism matches "${parsed.query}".` }
    }
    const lines: string[] = []
    lines.push(`### /genealogy --find "${parsed.query}"`)
    lines.push(`Found ${hits.length} match(es):`)
    for (const n of hits.slice(0, 50)) {
      lines.push(
        `- ${n.id}  ${n.name}  [${n.status}/${n.kind}]  gen=${n.depth}`,
      )
    }
    if (hits.length > 50) lines.push(`… (+${hits.length - 50} more, refine query)`)
    return { type: 'text', value: lines.join('\n') }
  }

  // ── genealogy 主模式 ───────────────────────────────────
  const needle = parsed.query
  // 允许 id 精确匹配,或 name 前缀/完整匹配。id 优先。
  let node = forest.byId[needle]
  if (!node) {
    const nameHits = forest.allNodes.filter(
      n =>
        n.name === needle ||
        n.name.startsWith(needle) ||
        n.id.startsWith(needle),
    )
    if (nameHits.length === 1) {
      node = nameHits[0]!
    } else if (nameHits.length > 1) {
      const hint = nameHits
        .slice(0, 10)
        .map(n => `  ${n.id}  ${n.name}  [${n.status}]`)
        .join('\n')
      return {
        type: 'text',
        value:
          `Ambiguous query "${needle}" — ${nameHits.length} matches:\n${hint}\n\n` +
          `Use full id, or try /genealogy --find <keyword>.`,
      }
    }
  }

  if (!node) {
    return {
      type: 'text',
      value:
        `No organism found for "${needle}".\n` +
        `Try /genealogy --find <keyword> to search by name substring.`,
    }
  }

  // 祖先链(self → parent → … → root)
  const ancestorChain: typeof forest.allNodes = []
  {
    let cur: typeof node | undefined = node
    const seen = new Set<string>()
    while (cur) {
      if (seen.has(cur.id)) break // 防环
      seen.add(cur.id)
      ancestorChain.push(cur)
      const parentId = cur.kinSeed?.stableId
      if (!parentId) break
      const parent = forest.byId[parentId]
      if (!parent) break // orphan 或指向已归档/清理的根
      cur = parent
    }
  }
  const root = ancestorChain[ancestorChain.length - 1]!
  const parent = ancestorChain.length >= 2 ? ancestorChain[1]! : null

  // 兄弟:同 parent 的其他节点(不含自己);node 若无 parent,就是"独立根",
  // 此时把 forest.trees 中同样 kinSeed=null 的 root 当作"同一代根"。
  const siblings = (() => {
    if (parent) {
      return parent.children.filter(c => c.id !== node.id)
    }
    // 无 parent:列出其它 root-level organism(kinSeed=null)
    return forest.trees
      .filter(t => t.id !== node.id)
      .slice(0, parsed.maxSiblings)
  })()

  // 子代(kin-seeded 出来的后代)—— 一层
  const children = parsed.showChildren ? node.children : []

  // 相关 transitions:扫一批近 transitions,过滤 organismId===node.id
  const nodeTransitions = parsed.showTransitions
    ? readRecentTransitions(500)
        .filter(t => t.organismId === node.id)
        .slice(0, parsed.maxTransitions)
    : []

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          self: {
            id: node.id,
            name: node.name,
            kind: node.kind,
            status: node.status,
            generation: node.depth,
            kinSeed: node.kinSeed ?? null,
            maturity: node.maturity,
            orphanOfId: node.orphanOfId,
            cycle: node.cycle,
          },
          root: root.id === node.id ? null : {
            id: root.id,
            name: root.name,
            status: root.status,
            kind: root.kind,
          },
          parent: parent
            ? {
                id: parent.id,
                name: parent.name,
                status: parent.status,
                kind: parent.kind,
              }
            : null,
          ancestorChain: ancestorChain.map(n => ({
            id: n.id,
            name: n.name,
            status: n.status,
            depth: n.depth,
          })),
          siblings: siblings.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            kind: s.kind,
          })),
          children: children.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            kind: c.kind,
            similarity: c.kinSeed?.similarity ?? null,
          })),
          transitions: nodeTransitions.map(t => ({
            at: t.at,
            from: t.from,
            to: t.to,
            trigger: t.trigger,
            rationale: t.rationale,
          })),
        },
        null,
        2,
      ),
    }
  }

  // 文本渲染
  const lines: string[] = []
  lines.push(`### /genealogy ${node.id}`)
  lines.push(
    `${node.name}  [${node.status}/${node.kind}]  generation=${node.depth}`,
  )
  if (node.cycle) lines.push(`⚠ kinSeed cycle detected — parent chain cut at self`)
  if (node.orphanOfId)
    lines.push(`⚠ orphan — kinSeed points to missing id: ${node.orphanOfId}`)
  lines.push('')

  lines.push('#### Ancestor chain (self → root)')
  if (ancestorChain.length === 1) {
    lines.push(`(self is root — no ancestors)`)
  } else {
    ancestorChain.forEach((n, idx) => {
      const marker = idx === 0 ? '●' : idx === ancestorChain.length - 1 ? '◎' : '○'
      const sim =
        idx > 0 && ancestorChain[idx - 1]!.kinSeed
          ? ` sim=${ancestorChain[idx - 1]!.kinSeed!.similarity.toFixed(2)}`
          : ''
      lines.push(
        `  ${'  '.repeat(idx)}${marker} ${n.id}  ${n.name}  [${n.status}]${sim}`,
      )
    })
  }
  lines.push('')

  lines.push(
    `#### Siblings${parent ? ` (share parent ${parent.id})` : ' (other roots)'}`,
  )
  if (siblings.length === 0) {
    lines.push('(none)')
  } else {
    for (const s of siblings.slice(0, parsed.maxSiblings)) {
      lines.push(`  - ${s.id}  ${s.name}  [${s.status}/${s.kind}]`)
    }
    if (siblings.length > parsed.maxSiblings) {
      lines.push(`  … (+${siblings.length - parsed.maxSiblings} more)`)
    }
  }
  lines.push('')

  if (parsed.showChildren) {
    lines.push(`#### Children (kin-seeded descendants)`)
    if (children.length === 0) {
      lines.push('(none)')
    } else {
      for (const c of children) {
        const sim = c.kinSeed ? ` sim=${c.kinSeed.similarity.toFixed(2)}` : ''
        lines.push(`  - ${c.id}  ${c.name}  [${c.status}/${c.kind}]${sim}`)
      }
    }
    lines.push('')
  }

  if (parsed.showTransitions) {
    lines.push(`#### Recent transitions`)
    if (nodeTransitions.length === 0) {
      lines.push('(none in last 500 ledger rows)')
    } else {
      for (const t of nodeTransitions) {
        lines.push(
          `  ${fmtTs(t.at)}  ${t.from} → ${t.to}  (${t.trigger})  ${t.rationale || ''}`.trimEnd(),
        )
      }
    }
    lines.push('')
  }

  return { type: 'text', value: lines.join('\n') }
}

const genealogy = {
  type: 'local',
  name: 'genealogy',
  description:
    'self-evolution-kernel v1.0 Phase 4 genealogy view. Given an organism id or name prefix, prints ancestor chain (self → parent → root via kinSeed), siblings (same parent), children (kin-seeded descendants), and recent promotion transitions. Read-only; reuses buildLineageForest + readRecentTransitions, no disk writes. Accepts --find <kw>, --json, --no-transitions, --no-children, --max-transitions=N, --max-siblings=N.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default genealogy
