import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'
import {
  loadVectorCache,
  vectorPreFilter,
  incrementalUpdate,
  updateAccessStats,
  saveVectorCache,
} from './vectorIndex.js'
import { loadGraph, findNeighbors } from './knowledgeGraph.js'
import { computeDecayScore, getLifecycleState } from './memoryLifecycle.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking Sonnet to select the most relevant ones.
 *
 * 升级流程：
 * 1. scanMemoryFiles → 200 个 MemoryHeader
 * 2. 向量预过滤 → top 20（TF-IDF 相似度 + 衰减分数）
 * 3. Sonnet sideQuery → top 5（从 20 条中精选）
 * 4. 图谱扩展 → 最终 ≤ 7 条（一度遍历 related 字段）
 * 5. 更新访问统计 → 异步写回 memory_vectors.json
 *
 * 降级：如果向量缓存不可用，回退到原始全量 200 条 → Sonnet 方式
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const allMemories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (allMemories.length === 0) {
    return []
  }

  // Phase 67(2026-04-24):dead-weight 反哺 retrieval ——
  //   Phase 61 的 memoryUtilityLedger 已经观察出"surfacedCount>=3 但 usedCount=0"
  //   的持续赔付候选, 这里 opt-in 把它们从 vectorPreFilter / Sonnet 的候选池里劣后。
  //   注意:只剔出 candidatePool, 保留 allMemories 供 expandWithGraph 用 ——
  //   这样 dead-weight 仍可通过"图谱邻居"被重新召回(active 节点关联它时),
  //   给它"继续赚回 used 的机会",不是硬性封印。
  //   env 默认关闭(保留旧行为),opt-in 打开后:只在 pool>20 时生效(防误清空)。
  let candidatePool = allMemories
  let demotedCount = 0
  const demoteEnabled =
    (process.env.CLAUDE_CODE_MEMORY_USAGE_DEMOTE ?? '').trim().toLowerCase() === '1' ||
    (process.env.CLAUDE_CODE_MEMORY_USAGE_DEMOTE ?? '').trim().toLowerCase() === 'on' ||
    (process.env.CLAUDE_CODE_MEMORY_USAGE_DEMOTE ?? '').trim().toLowerCase() === 'true'
  if (demoteEnabled && allMemories.length > 20) {
    try {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getMemoryUtilityLedgerSnapshot } =
        require('../services/contextSignals/memoryUtilityLedger.js') as typeof import('../services/contextSignals/memoryUtilityLedger.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      // 读取足够多的 dead-weight 保证全量覆盖(Phase 61 默认 limit=8, 这里放大)
      const snap = getMemoryUtilityLedgerSnapshot(100)
      const deadBasenames = new Set<string>(snap.deadWeight.map(r => r.basename))
      if (deadBasenames.size > 0) {
        const before = candidatePool.length
        candidatePool = candidatePool.filter(m => !deadBasenames.has(m.filename))
        demotedCount = before - candidatePool.length
        if (demotedCount > 0) {
          logForDebugging(
            `[memdir] Phase 67 demote: ${before} → ${candidatePool.length} (dead-weight basenames: ${deadBasenames.size}, demoted: ${demotedCount})`,
          )
        }
        // 防误清空:若过滤到 < 10, 回退到全量。这属于保护阀, 几乎不会触发。
        if (candidatePool.length < 10) {
          logForDebugging(
            `[memdir] Phase 67 demote reverted: candidatePool fell to ${candidatePool.length}, restoring full pool`,
          )
          candidatePool = allMemories
          demotedCount = 0
        }
      }
    } catch {
      // ledger 不可用时保持原语义, 不影响 retrieval
    }
  }

  // 步骤1:加载/更新向量缓存,进行预过滤
  let memoriesForSonnet: MemoryHeader[]
  let vectorCache = await loadVectorCache(memoryDir)

  try {
    // 增量更新向量索引 —— 仍用 allMemories, 图谱/向量索引本身不应因 demote 收缩
    const hasUpdates = await incrementalUpdate(
      allMemories,
      vectorCache,
      async (filePath: string) => {
        const { content } = await readFileInRange(filePath, 0, 30, undefined, signal)
        return content
      },
    )

    if (hasUpdates) {
      // 异步写回缓存,不阻塞召回
      void saveVectorCache(memoryDir, vectorCache).catch(() => {})
    }

    // 向量预过滤:candidatePool → 20(Phase 67: 若开启 demote 则 pool 已剔出 dead-weight)
    memoriesForSonnet = vectorPreFilter(query, candidatePool, vectorCache, 20)
    logForDebugging(
      `[memdir] vectorPreFilter: ${candidatePool.length} → ${memoriesForSonnet.length}`,
    )
  } catch (e) {
    // 向量索引异常,降级到全量(仍用 candidatePool 口径)
    logForDebugging(
      `[memdir] vectorPreFilter failed, fallback to full list: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    memoriesForSonnet = candidatePool
  }

  // 步骤2：Sonnet 精选 top 5
  const selectedFilenames = await selectRelevantMemories(
    query,
    memoriesForSonnet,
    signal,
    recentTools,
  )
  const byFilename = new Map(allMemories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // 步骤3：图谱扩展（related 字段 + 知识图谱双路径）
  const expandedSelected = expandWithGraph(
    selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs })),
    allMemories,
    vectorCache,
    2,
    memoryDir,
  )

  // Fires even on empty selection: selection-rate needs the denominator
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(allMemories, selected)
  }

  // 步骤4：更新访问统计
  updateAccessStats(
    expandedSelected.map(m => m.path),
    vectorCache,
  )
  void saveVectorCache(memoryDir, vectorCache).catch(() => {})

  // 记忆召回遥测 — 非阻塞
  try {
    const { logEvent } =
      require('../services/analytics/index.js') as typeof import('../services/analytics/index.js')
    logEvent('tengu_memory_recall', {
      totalMemories: allMemories.length,
      vectorPreFilterCount: memoriesForSonnet.length,
      sonnetSelectedCount: selected.length,
      graphExpandedCount: expandedSelected.length,
      // Phase 67:dead-weight demote 观察字段。demoted>0 说明本轮确实剔出了持续赔付候选。
      phase67Demoted: demotedCount,
      phase67DemoteEnabled: demoteEnabled,
    })
  } catch { /* telemetry is best-effort */ }

  return expandedSelected
}

/**
 * 图谱扩展：从已选记忆的 related 字段 + 知识图谱中找到关联记忆
 * 按综合分数排序，最多追加 2 条，最终总数 ≤ 7
 *
 * 两条扩展路径：
 *   路径A: frontmatter 的 related 字段（轻量，无IO）
 *   路径B: knowledgeGraph.json 的 findNeighbors（一度遍历，带关系权重）
 * 两路结果合并去重后按分数排序
 *
 * archive_candidate 抑制：图谱邻居里属于归档档位的记忆跳过，避免"老节点
 * 通过结构分蹭车"回流到召回列表（与 vectorPreFilter 的过滤策略对齐）。
 */
function expandWithGraph(
  selected: RelevantMemory[],
  allMemories: MemoryHeader[],
  cache: { documents: Record<string, { decayScore?: number; mtimeMs?: number; accessCount?: number; lastAccessMs?: number }> },
  maxExpand: number = 2,
  memoryDir?: string,
): RelevantMemory[] {
  const selectedPaths = new Set(selected.map(s => s.path))
  const byFilename = new Map(allMemories.map(m => [m.filename, m]))

  // 判断某文件是否归档档位；无索引视作 active（与 vectorPreFilter 口径一致）
  const isArchive = (filename: string): boolean => {
    const doc = cache.documents[filename]
    if (!doc || typeof doc.mtimeMs !== 'number') return false
    const score =
      doc.decayScore ??
      computeDecayScore({
        mtimeMs: doc.mtimeMs,
        accessCount: doc.accessCount,
        lastAccessMs: doc.lastAccessMs,
      })
    return getLifecycleState(score) === 'archive_candidate'
  }

  // 候选记忆及其来源分数
  const candidateScores = new Map<string, { header: MemoryHeader; score: number }>()

  // 路径A: frontmatter related 字段
  for (const sel of selected) {
    const header = allMemories.find(m => m.filePath === sel.path)
    if (header?.related) {
      for (const relName of header.related) {
        const rel = byFilename.get(relName)
        if (rel && !selectedPaths.has(rel.filePath) && !isArchive(rel.filename)) {
          const decayScore = cache.documents[rel.filename]?.decayScore ?? 0.5
          const existing = candidateScores.get(rel.filename)
          if (!existing || decayScore > existing.score) {
            candidateScores.set(rel.filename, { header: rel, score: decayScore })
          }
        }
      }
    }
  }

  // 路径B: 知识图谱遍历（异步加载转同步尝试）
  if (memoryDir) {
    try {
      // 获取已选记忆的文件名用于图谱查询
      const selectedFilenames = selected
        .map(s => allMemories.find(m => m.filePath === s.path)?.filename)
        .filter((f): f is string => f !== undefined)

      // 同步尝试读取已缓存的图谱（loadGraph 是 async，这里做 best-effort）
      // 实际由调用方传入已加载的图谱，或在此处尝试同步读取
      const graphPath = require('path').join(memoryDir, 'knowledge_graph.json')
      const graphData = require('fs').readFileSync(graphPath, 'utf-8')
      const graph = JSON.parse(graphData)

      if (graph && graph.edges) {
        for (const selFilename of selectedFilenames) {
          const neighbors = findNeighbors(graph, selFilename, 1)
          for (const neighbor of neighbors) {
            const rel = byFilename.get(neighbor.filename)
            if (rel && !selectedPaths.has(rel.filePath) && !isArchive(rel.filename)) {
              // 综合分数 = 图谱边权重 * 0.6 + 衰减分数 * 0.4
              const decayScore = cache.documents[rel.filename]?.decayScore ?? 0.5
              const graphScore = neighbor.weight * 0.6 + decayScore * 0.4
              const existing = candidateScores.get(rel.filename)
              if (!existing || graphScore > existing.score) {
                candidateScores.set(rel.filename, { header: rel, score: graphScore })
              }
            }
          }
        }
      }
    } catch {
      // 图谱不可用时静默降级，路径A的结果仍然有效
    }
  }

  if (candidateScores.size === 0) return selected

  // 按综合分数排序，取 top-maxExpand
  const expanded = [...candidateScores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExpand)
    .map(({ header }) => ({ path: header.filePath, mtimeMs: header.mtimeMs }))

  logForDebugging(
    `[memdir] expandWithGraph: ${selected.length} → ${selected.length + expanded.length} (graph candidates: ${candidateScores.size})`,
  )

  return [...selected, ...expanded]
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  // When Claude Code is actively using a tool (e.g. mcp__X__spawn),
  // surfacing that tool's reference docs is noise — the conversation
  // already contains working usage.  The selector otherwise matches
  // on keyword overlap ("spawn" in query + "spawn" in a memory
  // description → false positive).
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
