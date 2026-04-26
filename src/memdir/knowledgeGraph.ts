/**
 * knowledgeGraph — 记忆知识图谱
 *
 * 在现有 memdir 记忆系统之上构建关联图谱：
 *   - 节点 = 每个记忆文件
 *   - 边 = 记忆之间的关联关系（related_to, derived_from, supersedes 等）
 *
 * 升级现有 detectAndAddRelated() 从"只记录日志"到"实际构建和使用图谱"。
 * 图谱用于：
 *   1. 检索时通过图遍历扩展结果
 *   2. 写入时自动检测并建立关联
 *   3. 主动推荐相关记忆注入上下文
 *
 * 存储: ~/.claude/memory/knowledge_graph.json
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../utils/debug.js'

export type RelationType =
  | 'related_to'     // 内容相关
  | 'derived_from'   // 由此蒸馏而来
  | 'contradicts'    // 内容矛盾
  | 'supersedes'     // 替代了旧记忆
  | 'depends_on'     // 依赖关系

export interface KnowledgeEdge {
  source: string       // 源记忆文件名
  target: string       // 目标记忆文件名
  relation: RelationType
  weight: number       // 0-1 关联强度
  createdAt: number
}

export interface KnowledgeNode {
  filename: string
  type?: string        // 记忆类型
  importance: number   // 节点重要性（由连接数和边权重决定）
  connections: number  // 连接数
  lastUpdated: number
}

export interface KnowledgeGraph {
  version: number
  nodes: Record<string, KnowledgeNode>
  edges: KnowledgeEdge[]
  updatedAt: number
}

const GRAPH_VERSION = 1
const GRAPH_FILENAME = 'knowledge_graph.json'

// 边权重时间衰减参数
// 半衰期：30 天后有效权重降为一半
// 地板：0.05（低于此值基本没意义，用于截断）
// 老化剪枝阈值：创建后 180 天仍未被重新加强 → 剪掉，避免图谱无限膨胀
const EDGE_HALF_LIFE_MS = 30 * 86_400_000
const EDGE_WEIGHT_FLOOR = 0.05
const EDGE_PRUNE_AGE_MS = 180 * 86_400_000

/**
 * 按时间衰减计算边的"有效权重"
 * factor = 0.5 ^ (age / halfLife),地板 EDGE_WEIGHT_FLOOR
 *
 * 设计原则："use it or lose it"：addEdge 在命中已存在边时会刷新 createdAt，
 * 因此只要边被持续复用就保持强势；放着不动的老边自然弱化。
 * 纯函数，不改动边本身，便于读时计算、写时合并两用。
 */
export function getEdgeEffectiveWeight(
  edge: KnowledgeEdge,
  nowMs: number = Date.now(),
): number {
  const age = Math.max(0, nowMs - edge.createdAt)
  const factor = Math.pow(0.5, age / EDGE_HALF_LIFE_MS)
  return Math.max(EDGE_WEIGHT_FLOOR, edge.weight * factor)
}

/**
 * 创建空图谱
 */
export function createEmptyGraph(): KnowledgeGraph {
  return {
    version: GRAPH_VERSION,
    nodes: {},
    edges: [],
    updatedAt: Date.now(),
  }
}

/**
 * 从磁盘加载图谱
 */
export async function loadGraph(memoryDir: string): Promise<KnowledgeGraph> {
  const graphPath = path.join(memoryDir, GRAPH_FILENAME)
  try {
    const data = await fs.promises.readFile(graphPath, 'utf-8')
    const graph = JSON.parse(data) as KnowledgeGraph
    if (graph.version !== GRAPH_VERSION) {
      logForDebugging(`[knowledgeGraph] version mismatch, recreating`)
      return createEmptyGraph()
    }
    return graph
  } catch {
    return createEmptyGraph()
  }
}

/**
 * 持久化图谱到磁盘
 */
/**
 * 保存图谱到磁盘（带老化剪枝）
 * 每次 save 时顺带清理"创建后 180 天仍没被加强过"的边,避免长期膨胀。
 * 节点即便没边也保留（节点 importance 由 recomputeImportance 重算）。
 */
export async function saveGraph(memoryDir: string, graph: KnowledgeGraph): Promise<void> {
  const graphPath = path.join(memoryDir, GRAPH_FILENAME)
  try {
    const now = Date.now()
    const beforeCount = graph.edges.length
    graph.edges = graph.edges.filter(e => now - e.createdAt <= EDGE_PRUNE_AGE_MS)
    const prunedCount = beforeCount - graph.edges.length
    if (prunedCount > 0) {
      // 剪枝后连接数失真,顺手重算节点 connections 字段
      for (const node of Object.values(graph.nodes)) node.connections = 0
      for (const edge of graph.edges) {
        if (graph.nodes[edge.source]) graph.nodes[edge.source].connections++
        if (graph.nodes[edge.target]) graph.nodes[edge.target].connections++
      }
      logForDebugging(
        `[knowledgeGraph] pruned ${prunedCount} stale edges (age > ${EDGE_PRUNE_AGE_MS / 86_400_000}d)`,
      )
    }
    graph.updatedAt = now
    await fs.promises.writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(`[knowledgeGraph] save failed: ${(e as Error).message}`)
  }
}

/**
 * 确保节点存在
 */
export function ensureNode(
  graph: KnowledgeGraph,
  filename: string,
  type?: string,
): KnowledgeNode {
  if (!graph.nodes[filename]) {
    graph.nodes[filename] = {
      filename,
      type,
      importance: 0,
      connections: 0,
      lastUpdated: Date.now(),
    }
  }
  if (type) graph.nodes[filename].type = type
  return graph.nodes[filename]
}

/**
 * 添加一条边（去重：同source+target+relation只保留权重最高的）
 */
export function addEdge(
  graph: KnowledgeGraph,
  source: string,
  target: string,
  relation: RelationType,
  weight: number = 0.5,
): void {
  // 确保节点存在
  ensureNode(graph, source)
  ensureNode(graph, target)

  // 检查是否已存在相同的边
  const existing = graph.edges.find(
    e => e.source === source && e.target === target && e.relation === relation,
  )

  if (existing) {
    // 更新权重（取较大值）+ 刷新 createdAt,等效重新加盖时间戳
    // ("use it or lose it"：持续被使用的边保持新鲜,放着不动的边走 saveGraph 剪枝)
    existing.weight = Math.max(existing.weight, weight)
    existing.createdAt = Date.now()
    return
  }

  graph.edges.push({
    source,
    target,
    relation,
    weight,
    createdAt: Date.now(),
  })

  // 更新连接数
  graph.nodes[source]!.connections++
  graph.nodes[target]!.connections++

  // 重新计算重要性
  recalculateImportance(graph, source)
  recalculateImportance(graph, target)
}

/**
 * 删除与指定文件相关的所有边和节点
 */
export function removeNode(graph: KnowledgeGraph, filename: string): void {
  // 删除所有相关的边
  const affectedNodes = new Set<string>()
  graph.edges = graph.edges.filter(e => {
    if (e.source === filename || e.target === filename) {
      affectedNodes.add(e.source === filename ? e.target : e.source)
      return false
    }
    return true
  })

  // 删除节点
  delete graph.nodes[filename]

  // 重新计算受影响节点的连接数和重要性
  for (const node of affectedNodes) {
    if (graph.nodes[node]) {
      graph.nodes[node].connections = graph.edges.filter(
        e => e.source === node || e.target === node,
      ).length
      recalculateImportance(graph, node)
    }
  }
}

/**
 * 重新计算节点重要性（简化的 PageRank）
 * importance = 0.15 + 0.85 * sum(neighbor.importance * edge.weight / neighbor.connections)
 */
function recalculateImportance(graph: KnowledgeGraph, filename: string): void {
  const node = graph.nodes[filename]
  if (!node) return

  const incomingEdges = graph.edges.filter(e => e.target === filename)
  if (incomingEdges.length === 0) {
    node.importance = 0.15 // 基础分
    return
  }

  // 使用"有效权重"(时间衰减后)参与 PageRank 计算,
  // 这样 session-level 的老边也不会持续抬高节点重要性。
  const now = Date.now()
  let sum = 0
  for (const edge of incomingEdges) {
    const sourceNode = graph.nodes[edge.source]
    if (sourceNode && sourceNode.connections > 0) {
      sum +=
        ((sourceNode.importance || 0.15) * getEdgeEffectiveWeight(edge, now)) /
        sourceNode.connections
    }
  }

  node.importance = 0.15 + 0.85 * sum
}

/**
 * 查找与指定节点直接相连的所有节点（一度遍历）
 *
 * 返回的 weight 为"有效权重"（原始 weight 按时间半衰期衰减 + 地板),
 * 排序也按有效权重降序。老关联自然退居二线,新被加强过的边排在前。
 */
export function findNeighbors(
  graph: KnowledgeGraph,
  filename: string,
  maxDepth: number = 1,
): Array<{ filename: string; relation: RelationType; weight: number; depth: number }> {
  const visited = new Set<string>([filename])
  const results: Array<{ filename: string; relation: RelationType; weight: number; depth: number }> = []
  const now = Date.now()

  let frontier = [filename]
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = []
    for (const node of frontier) {
      const edges = graph.edges.filter(
        e => e.source === node || e.target === node,
      )
      for (const edge of edges) {
        const neighbor = edge.source === node ? edge.target : edge.source
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          results.push({
            filename: neighbor,
            relation: edge.relation,
            weight: getEdgeEffectiveWeight(edge, now),
            depth,
          })
          nextFrontier.push(neighbor)
        }
      }
    }
    frontier = nextFrontier
  }

  // 按有效权重降序排列
  results.sort((a, b) => b.weight - a.weight)
  return results
}

/**
 * 检测两个文本内容之间的潜在关联
 * 返回关系类型和置信度
 */
export function detectRelation(
  sourceContent: string,
  targetContent: string,
  sourceType?: string,
  targetType?: string,
): { relation: RelationType; confidence: number } | null {
  const sourceLower = sourceContent.toLowerCase()
  const targetLower = targetContent.toLowerCase()

  // 检测矛盾关系：一个说"不要X"，另一个说"做X"
  const negationPatterns = [
    { positive: /(?:always|should|must|prefer)\s+(\w+)/g, negative: /(?:never|don't|avoid|stop)\s+(\w+)/g },
  ]
  for (const pattern of negationPatterns) {
    const posMatches = [...sourceLower.matchAll(pattern.positive)]
    const negMatches = [...targetLower.matchAll(pattern.negative)]
    for (const pos of posMatches) {
      for (const neg of negMatches) {
        if (pos[1] === neg[1]) {
          return { relation: 'contradicts', confidence: 0.6 }
        }
      }
    }
  }

  // 检测替代关系：同类型 + 相似主题
  if (sourceType === targetType) {
    // 提取主要名词/关键词
    const sourceWords = new Set(sourceLower.match(/\b[a-z]{4,}\b/g) || [])
    const targetWords = new Set(targetLower.match(/\b[a-z]{4,}\b/g) || [])
    const intersection = [...sourceWords].filter(w => targetWords.has(w))
    const overlap = intersection.length / Math.max(sourceWords.size, targetWords.size, 1)

    if (overlap > 0.5) {
      return { relation: 'supersedes', confidence: overlap }
    }
    if (overlap > 0.2) {
      return { relation: 'related_to', confidence: overlap }
    }
  }

  // 通用关联检测：共享文件路径或函数名
  const pathPattern = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/g
  const sourcePaths = new Set(sourceContent.match(pathPattern) || [])
  const targetPaths = new Set(targetContent.match(pathPattern) || [])
  const sharedPaths = [...sourcePaths].filter(p => targetPaths.has(p))

  if (sharedPaths.length > 0) {
    return { relation: 'related_to', confidence: Math.min(1, sharedPaths.length * 0.3) }
  }

  return null
}

/**
 * 获取图谱统计信息
 */
export function getGraphStats(graph: KnowledgeGraph): {
  nodeCount: number
  edgeCount: number
  avgConnections: number
  topNodes: Array<{ filename: string; importance: number }>
} {
  const nodeCount = Object.keys(graph.nodes).length
  const edgeCount = graph.edges.length
  const avgConnections = nodeCount > 0
    ? edgeCount * 2 / nodeCount  // 每条边贡献2个连接
    : 0

  const topNodes = Object.values(graph.nodes)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 10)
    .map(n => ({ filename: n.filename, importance: n.importance }))

  return { nodeCount, edgeCount, avgConnections, topNodes }
}
