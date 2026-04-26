// src/memdir/vectorIndex.ts
// TF-IDF 稀疏向量索引：为记忆文件维护向量缓存，支持预过滤
// 缓存文件 memory_vectors.json 存储在记忆目录下

import { readFile, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  cosineSimilarity,
  computeTfIdf,
  tokenize,
} from '../services/skillSearch/tokenizer.js'
import type { MemoryHeader } from './memoryScan.js'
import {
  computeDecayScore,
  getLifecycleState,
  type VectorDocument,
} from './memoryLifecycle.js'

const VECTOR_CACHE_VERSION = 1
const VECTOR_CACHE_FILENAME = 'memory_vectors.json'
// 索引文本最大字符数（frontmatter description + 正文前500字）
const MAX_INDEX_CHARS = 500

/**
 * 向量缓存数据结构
 * 存储在 memory_vectors.json 中
 */
export type VectorCache = {
  version: number
  idfMap: Record<string, number>
  documents: Record<string, VectorDocument>
}

/**
 * 创建空的向量缓存
 */
function createEmptyCache(): VectorCache {
  return {
    version: VECTOR_CACHE_VERSION,
    idfMap: {},
    documents: {},
  }
}

/**
 * 加载向量缓存，如果不存在或版本不匹配则返回空缓存
 */
export async function loadVectorCache(memoryDir: string): Promise<VectorCache> {
  try {
    const cachePath = join(memoryDir, VECTOR_CACHE_FILENAME)
    const raw = await readFile(cachePath, 'utf-8')
    const cache: VectorCache = JSON.parse(raw)
    if (cache.version !== VECTOR_CACHE_VERSION) {
      return createEmptyCache()
    }
    return cache
  } catch {
    return createEmptyCache()
  }
}

/**
 * 保存向量缓存到磁盘
 */
export async function saveVectorCache(
  memoryDir: string,
  cache: VectorCache,
): Promise<void> {
  const cachePath = join(memoryDir, VECTOR_CACHE_FILENAME)
  await writeFile(cachePath, JSON.stringify(cache), 'utf-8')
}

/**
 * 重新计算全局 IDF 值
 * IDF = log(文档总数 / (包含该词的文档数 + 1))
 */
function recomputeIDF(cache: VectorCache): void {
  const docCount = Object.keys(cache.documents).length
  if (docCount === 0) {
    cache.idfMap = {}
    return
  }

  // 统计每个词出现在多少个文档中
  const df: Record<string, number> = {}
  for (const doc of Object.values(cache.documents)) {
    for (const term of Object.keys(doc.vector)) {
      df[term] = (df[term] ?? 0) + 1
    }
  }

  // 计算 IDF
  const idfMap: Record<string, number> = {}
  for (const [term, count] of Object.entries(df)) {
    idfMap[term] = Math.log(docCount / (count + 1))
  }
  cache.idfMap = idfMap
}

/**
 * 为单个文件更新向量索引
 * @param content 文件内容（frontmatter + 正文前500字）
 * @param filename 相对路径
 * @param mtimeMs 文件修改时间
 * @param cache 向量缓存（会被就地修改）
 */
export function updateDocumentVector(
  content: string,
  filename: string,
  mtimeMs: number,
  cache: VectorCache,
): void {
  // 截取前 MAX_INDEX_CHARS 字符用于索引
  const indexText = content.slice(0, MAX_INDEX_CHARS)
  const terms = tokenize(indexText)
  const vector = computeTfIdf(terms, cache.idfMap)

  const existing = cache.documents[filename]
  cache.documents[filename] = {
    mtimeMs,
    vector,
    // 保留已有的访问统计
    decayScore: existing?.decayScore,
    accessCount: existing?.accessCount ?? 0,
    lastAccessMs: existing?.lastAccessMs,
  }
}

/**
 * 增量更新向量索引：对比 mtimeMs，只更新变化的文件
 * @param memories 当前所有记忆文件的 headers
 * @param cache 向量缓存（会被就地修改）
 * @param readContent 读取文件内容的回调
 * @returns 是否有任何更新
 */
export async function incrementalUpdate(
  memories: MemoryHeader[],
  cache: VectorCache,
  readContent: (filePath: string) => Promise<string>,
): Promise<boolean> {
  let hasUpdates = false

  // 找出需要更新的文件（新文件或 mtime 变化）
  const toUpdate: MemoryHeader[] = []
  const currentFilenames = new Set<string>()

  for (const mem of memories) {
    currentFilenames.add(mem.filename)
    const existing = cache.documents[mem.filename]
    if (!existing || existing.mtimeMs !== mem.mtimeMs) {
      toUpdate.push(mem)
    }
  }

  // 移除已删除的文件
  for (const filename of Object.keys(cache.documents)) {
    if (!currentFilenames.has(filename)) {
      delete cache.documents[filename]
      hasUpdates = true
    }
  }

  // 更新变化的文件
  if (toUpdate.length > 0) {
    hasUpdates = true
    await Promise.allSettled(
      toUpdate.map(async mem => {
        try {
          const content = await readContent(mem.filePath)
          updateDocumentVector(content, mem.filename, mem.mtimeMs, cache)
        } catch {
          // 读取失败的文件跳过
        }
      }),
    )
    // 重算全局 IDF
    recomputeIDF(cache)
    // 重新计算所有文档的衰减分数
    for (const doc of Object.values(cache.documents)) {
      doc.decayScore = computeDecayScore(doc)
    }
  }

  return hasUpdates
}

/**
 * 向量预过滤：用 TF-IDF 余弦相似度筛选 top-K 记忆
 * 最终排序分 = 余弦相似度 * 0.7 + 衰减分数 * 0.3
 *
 * archive_candidate 抑制（decay < 0.1）：
 *   默认把 archive 档位文件从召回池踢出 — 只要剩余非 archive 结果 >= topK/2，
 *   或者 total 中非 archive 的数量本身足够填满 topK * 0.5。
 *   如果绝大多数记忆都进入了 archive 档位（新仓库尚未建立索引、全量老化等
 *   边缘场景），退化到不过滤，避免空召回。
 */
export function vectorPreFilter(
  query: string,
  memories: MemoryHeader[],
  cache: VectorCache,
  topK: number = 20,
): MemoryHeader[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return memories.slice(0, topK)

  const queryVector = computeTfIdf(queryTerms, cache.idfMap)

  // 预判 archive 抑制是否安全：非 archive 数量 >= topK/2 才启用过滤
  // （小语料或全员老化时不启用，避免把仅剩的几条也吃掉）
  let nonArchiveCount = 0
  for (const m of memories) {
    const doc = cache.documents[m.filename]
    if (!doc) {
      nonArchiveCount++ // 未索引文件视作 active，保留
      continue
    }
    const score = doc.decayScore ?? computeDecayScore(doc)
    if (getLifecycleState(score) !== 'archive_candidate') nonArchiveCount++
  }
  const suppressArchive = nonArchiveCount >= Math.max(1, Math.floor(topK / 2))

  const scored = memories
    .map(m => {
      const doc = cache.documents[m.filename]
      if (!doc || Object.keys(doc.vector).length === 0) {
        // 没有向量的文件给一个基础分，确保不被完全排除
        return { memory: m, score: 0.1, isArchive: false }
      }
      const decay = doc.decayScore ?? computeDecayScore(doc)
      const isArchive = getLifecycleState(decay) === 'archive_candidate'
      const sim = cosineSimilarity(queryVector, doc.vector)
      // 融合分 = 余弦相似度 * 0.7 + 衰减分数 * 0.3
      return { memory: m, score: sim * 0.7 + decay * 0.3, isArchive }
    })
    .filter(s => !(suppressArchive && s.isArchive))

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.memory)
}

/**
 * 更新访问统计：被召回的记忆增加 accessCount 和 lastAccessMs
 */
export function updateAccessStats(
  selectedPaths: string[],
  cache: VectorCache,
): void {
  for (const path of selectedPaths) {
    const filename = basename(path)
    // 也尝试在 documents 中直接查找（可能是相对路径）
    const doc = cache.documents[filename]
    if (doc) {
      doc.accessCount = (doc.accessCount ?? 0) + 1
      doc.lastAccessMs = Date.now()
      doc.decayScore = computeDecayScore(doc)
    }
  }
}

/**
 * 查找与给定文本最相似的记忆文件
 * 用于写入门控的重复检测
 *
 * archive_candidate 跳过：已老化到归档档位的记忆不该阻止新记忆写入
 * （老规则可能已被新记忆替代，retire 掉的内容不应作为重复判定基线）。
 *
 * @returns 相似度 >= threshold 的文件列表，按相似度降序
 */
export function findSimilarMemories(
  text: string,
  cache: VectorCache,
  threshold: number = 0.7,
  excludeFilename?: string,
): Array<{ filename: string; similarity: number }> {
  const terms = tokenize(text)
  if (terms.length === 0) return []

  const queryVector = computeTfIdf(terms, cache.idfMap)
  const results: Array<{ filename: string; similarity: number }> = []

  for (const [filename, doc] of Object.entries(cache.documents)) {
    if (filename === excludeFilename) continue
    if (Object.keys(doc.vector).length === 0) continue
    // 跳过归档档位的记忆（它们的存在不应阻止新记忆写入）
    const decay = doc.decayScore ?? computeDecayScore(doc)
    if (getLifecycleState(decay) === 'archive_candidate') continue

    const sim = cosineSimilarity(queryVector, doc.vector)
    if (sim >= threshold) {
      results.push({ filename, similarity: sim })
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity)
}
