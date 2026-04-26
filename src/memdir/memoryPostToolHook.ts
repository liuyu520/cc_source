// src/memdir/memoryPostToolHook.ts
// PostToolUse 后的记忆文件处理：统一触发索引自动化、向量更新、质量门控、关联检测
// 由 toolHooks.ts 的 runPostToolUseHooks 调用

import { basename, join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { logForDebugging } from '../utils/debug.js'
import { isAutoMemPath, getAutoMemPath, getAutoMemEntrypoint } from './paths.js'
import {
  loadVectorCache,
  saveVectorCache,
  updateDocumentVector,
  findSimilarMemories,
} from './vectorIndex.js'
import {
  checkMemoryQuality,
  formatQualityReminder,
  findRelatedSuggestions,
} from './writeQualityGate.js'

const VECTOR_CACHE_FILENAME = 'memory_vectors.json'

/**
 * PostToolUse 记忆处理结果
 */
export type MemoryHookResult = {
  /** 需要追加的 system-reminder 文本（质量问题提醒），null 表示无问题 */
  qualityReminder: string | null
  /** 是否触发了索引更新 */
  indexUpdated: boolean
  /** 是否触发了向量更新 */
  vectorUpdated: boolean
}

/**
 * 检测写入的文件是否为记忆文件，执行索引自动化 + 向量更新 + 质量门控
 *
 * 应当在 PostToolUse(FileWrite/FileEdit) 之后调用
 * 仅当文件路径在 autoMemPath 范围内时生效
 *
 * @param filePath 写入的文件绝对路径
 * @returns 处理结果，包含可能的质量提醒
 */
export async function handleMemoryFileWrite(
  filePath: string,
): Promise<MemoryHookResult> {
  const result: MemoryHookResult = {
    qualityReminder: null,
    indexUpdated: false,
    vectorUpdated: false,
  }

  // 快速检查：是否为记忆路径下的 .md 文件
  if (!shouldProcess(filePath)) {
    return result
  }

  const memoryDir = getAutoMemPath()
  const filename = getRelativeFilename(filePath, memoryDir)

  try {
    const content = await readFile(filePath, 'utf-8')

    // 并行执行三个操作
    const [, , qualityIssues] = await Promise.all([
      // 操作1：更新 MEMORY.md 索引
      updateMemoryIndex(filePath, content, memoryDir).then(() => {
        result.indexUpdated = true
      }).catch(e => {
        logForDebugging(`[memdir-hook] index update failed: ${e}`, { level: 'warn' })
      }),

      // 操作2：更新向量缓存
      updateVectorForFile(content, filename, memoryDir).then(() => {
        result.vectorUpdated = true
      }).catch(e => {
        logForDebugging(`[memdir-hook] vector update failed: ${e}`, { level: 'warn' })
      }),

      // 操作3：质量检查（需要向量缓存进行重复检测）
      runQualityCheck(content, filename, memoryDir),
    ])

    // 如果有质量问题，生成提醒
    if (qualityIssues && qualityIssues.length > 0) {
      result.qualityReminder = formatQualityReminder(filename, qualityIssues)
    }

    // 操作4：关联检测 — 自动建立 related 关系
    await detectAndAddRelated(content, filename, memoryDir).catch(e => {
      logForDebugging(`[memdir-hook] related detection failed: ${e}`, { level: 'warn' })
    })

  } catch (e) {
    logForDebugging(`[memdir-hook] handleMemoryFileWrite failed: ${e}`, { level: 'warn' })
  }

  return result
}

/**
 * 判断是否需要处理该文件
 */
function shouldProcess(filePath: string): boolean {
  return (
    isAutoMemPath(filePath) &&
    filePath.endsWith('.md') &&
    !filePath.endsWith('MEMORY.md') &&
    !filePath.endsWith(VECTOR_CACHE_FILENAME)
  )
}

/**
 * 获取相对于记忆目录的文件名
 */
function getRelativeFilename(filePath: string, memoryDir: string): string {
  if (filePath.startsWith(memoryDir)) {
    return filePath.slice(memoryDir.length)
  }
  return basename(filePath)
}

/**
 * 更新 MEMORY.md 索引
 * 解析新文件的 frontmatter，在 MEMORY.md 中添加或更新条目
 */
async function updateMemoryIndex(
  filePath: string,
  content: string,
  memoryDir: string,
): Promise<void> {
  const { frontmatter } = parseFrontmatter(content, filePath)
  const name = frontmatter.name || basename(filePath, '.md')
  const description = frontmatter.description || ''
  const filename = getRelativeFilename(filePath, memoryDir)

  const entrypoint = getAutoMemEntrypoint()
  let indexContent: string
  try {
    indexContent = await readFile(entrypoint, 'utf-8')
  } catch {
    indexContent = ''
  }

  const lines = indexContent.split('\n')
  const newEntry = `- [${name}](${filename}) — ${description}`

  // 查找已有条目（匹配文件名）
  const existingIndex = lines.findIndex(
    line => line.includes(`(${filename})`) || line.includes(`](${filename})`)
  )

  if (existingIndex >= 0) {
    // 更新已有条目
    lines[existingIndex] = newEntry
  } else {
    // 追加新条目
    // 找到最后一个非空行之后添加
    let insertAt = lines.length
    while (insertAt > 0 && lines[insertAt - 1]!.trim() === '') {
      insertAt--
    }
    lines.splice(insertAt, 0, newEntry)
  }

  // 行数控制：超过 180 行时不自动截断（留给 truncateEntrypointContent 处理）
  const updatedContent = lines.join('\n')
  await writeFile(entrypoint, updatedContent, 'utf-8')

  logForDebugging(`[memdir-hook] MEMORY.md updated: ${filename}`)
}

/**
 * 更新单个文件的向量缓存
 */
async function updateVectorForFile(
  content: string,
  filename: string,
  memoryDir: string,
): Promise<void> {
  const cache = await loadVectorCache(memoryDir)
  const mtimeMs = Date.now()
  updateDocumentVector(content, filename, mtimeMs, cache)

  // 重算全局 IDF
  const docCount = Object.keys(cache.documents).length
  if (docCount > 0) {
    const df: Record<string, number> = {}
    for (const doc of Object.values(cache.documents)) {
      for (const term of Object.keys(doc.vector)) {
        df[term] = (df[term] ?? 0) + 1
      }
    }
    for (const [term, count] of Object.entries(df)) {
      cache.idfMap[term] = Math.log(docCount / (count + 1))
    }
  }

  await saveVectorCache(memoryDir, cache)
  logForDebugging(`[memdir-hook] vector updated: ${filename}`)
}

/**
 * 运行质量检查
 */
async function runQualityCheck(
  content: string,
  filename: string,
  memoryDir: string,
): ReturnType<typeof checkMemoryQuality> {
  // 尝试加载向量缓存用于重复检测
  let vectorCache
  try {
    vectorCache = await loadVectorCache(memoryDir)
  } catch {
    // 无缓存时跳过重复检测
  }
  return checkMemoryQuality(content, filename, vectorCache)
}

/**
 * 关联检测：自动在新记忆和相关现有记忆之间建立 related 引用，
 * 并将关联关系写入知识图谱
 */
async function detectAndAddRelated(
  content: string,
  filename: string,
  memoryDir: string,
): Promise<void> {
  const cache = await loadVectorCache(memoryDir)
  const relatedFiles = findRelatedSuggestions(content, filename, cache)

  if (relatedFiles.length === 0) return

  // 在新文件的 frontmatter 中添加 related（如果还没有）
  const { frontmatter } = parseFrontmatter(content, filename)
  const existingRelated = new Set<string>(
    Array.isArray(frontmatter.related) ? frontmatter.related : []
  )

  const newRelated = relatedFiles.filter(f => !existingRelated.has(f))
  if (newRelated.length === 0) return

  logForDebugging(
    `[memdir-hook] related suggestions for ${filename}: ${newRelated.join(', ')}`,
  )

  // 将关联关系写入知识图谱（实际构建图谱而非仅记录日志）
  try {
    const { loadGraph, saveGraph, addEdge, ensureNode, detectRelation } =
      await import('./knowledgeGraph.js')
    const graph = await loadGraph(memoryDir)

    // 确保当前节点存在
    ensureNode(graph, filename, frontmatter.type as string | undefined)

    // 为每个关联文件添加边
    for (const relatedFile of newRelated) {
      // 尝试检测具体关系类型
      try {
        const fs = await import('fs')
        const path = await import('path')
        const relatedContent = await fs.promises.readFile(
          path.join(memoryDir, relatedFile), 'utf-8',
        )
        const relatedFm = parseFrontmatter(relatedContent, relatedFile)
        const relation = detectRelation(
          content, relatedContent,
          frontmatter.type as string | undefined,
          relatedFm.frontmatter.type as string | undefined,
        )
        if (relation) {
          addEdge(graph, filename, relatedFile, relation.relation, relation.confidence)
        } else {
          addEdge(graph, filename, relatedFile, 'related_to', 0.5)
        }
      } catch {
        // 读取失败时使用默认关联
        addEdge(graph, filename, relatedFile, 'related_to', 0.5)
      }
    }

    // 异步保存图谱
    saveGraph(memoryDir, graph).catch(() => {})
  } catch (e) {
    logForDebugging(`[memdir-hook] knowledge graph update failed: ${e}`)
  }
}
