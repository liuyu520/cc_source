/**
 * /memory-stats — 认知记忆系统诊断命令
 *
 * 展示：技能使用统计、知识图谱规模、情景记忆数量、
 * 自适应压缩阈值、向量索引文档数。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone) => {
  const lines: string[] = ['## Cognitive Memory System Diagnostics\n']

  // 0. 运行模式(Runtime Mode)—— 放最前便于排查环境问题
  try {
    const { getResolvedRuntimeMode } = await import('../../utils/model/runtimeMode.js')
    const mode = getResolvedRuntimeMode()
    const explicit = process.env.CLAUDE_CODE_RUNTIME_MODE ? ' (via CLAUDE_CODE_RUNTIME_MODE)' : ' (inferred)'
    lines.push('### Runtime Mode')
    lines.push(`Current: ${mode}${explicit}`)
    lines.push('')
  } catch {
    lines.push('### Runtime Mode')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 1. 技能使用统计
  try {
    const { getUsageSummary } = await import('../../skills/skillUsageTracker.js')
    const summary = await getUsageSummary()
    lines.push('### Skill Usage Stats')
    lines.push(summary)
    lines.push('')
  } catch (e) {
    lines.push('### Skill Usage Stats')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2. 自适应压缩阈值
  try {
    const { getProtectionThreshold, getConsecutiveRetriggers } =
      await import('../../services/compact/importanceScoring.js')
    lines.push('### Adaptive Compression')
    lines.push(`Protection threshold: ${getProtectionThreshold().toFixed(2)} (default: 0.60)`)
    lines.push(`Consecutive retriggers: ${getConsecutiveRetriggers()}`)
    lines.push('')
  } catch {
    lines.push('### Adaptive Compression')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 3. 知识图谱统计
  try {
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const { loadGraph, getGraphStats } = await import('../../memdir/knowledgeGraph.js')
    const memDir = getAutoMemPath()
    const graph = await loadGraph(memDir)
    const stats = getGraphStats(graph)
    lines.push('### Knowledge Graph')
    lines.push(`Nodes: ${stats.nodeCount}`)
    lines.push(`Edges: ${stats.edgeCount}`)
    lines.push(`Avg connections: ${stats.avgConnections.toFixed(1)}`)
    lines.push('')
  } catch {
    lines.push('### Knowledge Graph')
    lines.push('(no graph data)')
    lines.push('')
  }

  // 4. 情景记忆数量
  try {
    const { getSessionId } = await import('../../bootstrap/state.js')
    const { getMemoryPath } = await import('../../utils/sessionStorage.js')
    const { loadSessionEpisodes } = await import('../../services/episodicMemory/episodicMemory.js')
    const sessionId = getSessionId()
    const projectDir = getMemoryPath()
    if (sessionId && projectDir) {
      const episodes = await loadSessionEpisodes(projectDir, sessionId)
      lines.push('### Episodic Memory')
      lines.push(`Current session episodes: ${episodes.length}`)
      // 按类型统计
      const typeCount: Record<string, number> = {}
      for (const ep of episodes) {
        typeCount[ep.type] = (typeCount[ep.type] || 0) + 1
      }
      for (const [type, count] of Object.entries(typeCount)) {
        lines.push(`  ${type}: ${count}`)
      }
      lines.push('')
    }
  } catch {
    lines.push('### Episodic Memory')
    lines.push('(no episodic data)')
    lines.push('')
  }

  // 5. 向量索引文档数
  try {
    const { getAutoMemPath } = await import('../../memdir/paths.js')
    const { loadVectorCache } = await import('../../memdir/vectorIndex.js')
    const memDir = getAutoMemPath()
    const cache = await loadVectorCache(memDir)
    const docCount = Object.keys(cache.documents).length
    const idfTerms = Object.keys(cache.idfMap).length
    lines.push('### Vector Index')
    lines.push(`Documents: ${docCount}`)
    lines.push(`IDF terms: ${idfTerms}`)
    lines.push('')
  } catch {
    lines.push('### Vector Index')
    lines.push('(no vector data)')
    lines.push('')
  }

  const report = lines.join('\n')
  onDone(report)
  return null
}
