/**
 * shortTermBuffer — 结构化短期缓冲区
 *
 * 替代 compact 后的纯自然语言摘要，用结构化数据保留关键信息：
 *   - decisions: 做了什么决策及原因
 *   - filesModified: 修改了哪些文件
 *   - keyInsights: 关键发现
 *   - openQuestions: 未解决的问题
 *
 * 缓冲区有 token 上限，超限时将最旧的 segment 沉淀到情景记忆。
 * 存储位置: ~/.claude/projects/<path>/buffers/<sessionId>.json
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../utils/debug.js'

// 缓冲区 token 预算
const DEFAULT_MAX_BUFFER_TOKENS = 15_000
const SEGMENT_ESTIMATE_RATIO = 4 // 每字符约 0.25 token

export interface Decision {
  what: string
  why: string
  alternatives?: string[]
}

export interface CodeRef {
  file: string
  lines?: string
  symbol?: string
  action: 'read' | 'modified' | 'created' | 'deleted'
}

export interface BufferSegment {
  id: string
  timeRange: { start: number; end: number }
  type: 'decision' | 'exploration' | 'implementation' | 'debugging' | 'conversation'
  summary: string
  decisions: Decision[]
  filesModified: string[]
  keyInsights: string[]
  openQuestions: string[]
  codeContext: CodeRef[]
  importanceScore: number
  compressedFromTokens: number
  compressedToTokens: number
}

export interface ShortTermBuffer {
  sessionId: string
  segments: BufferSegment[]
  totalTokens: number
  maxTokens: number
  createdAt: number
  updatedAt: number
}

function estimateSegmentTokens(segment: BufferSegment): number {
  const text = [
    segment.summary,
    ...segment.decisions.map(d => `${d.what}: ${d.why}`),
    ...segment.filesModified,
    ...segment.keyInsights,
    ...segment.openQuestions,
    ...segment.codeContext.map(c => `${c.file}:${c.lines || ''} ${c.action}`),
  ].join(' ')
  return Math.ceil(text.length / SEGMENT_ESTIMATE_RATIO)
}

/**
 * 创建空缓冲区
 */
export function createBuffer(sessionId: string, maxTokens?: number): ShortTermBuffer {
  return {
    sessionId,
    segments: [],
    totalTokens: 0,
    maxTokens: maxTokens ?? DEFAULT_MAX_BUFFER_TOKENS,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 向缓冲区追加 segment
 */
export function appendSegment(buffer: ShortTermBuffer, segment: BufferSegment): BufferSegment[] {
  segment.compressedToTokens = estimateSegmentTokens(segment)
  buffer.segments.push(segment)
  buffer.totalTokens += segment.compressedToTokens
  buffer.updatedAt = Date.now()

  // 如果超限，淘汰最旧的 segments（返回被淘汰的，用于沉淀到情景记忆）
  const evicted: BufferSegment[] = []
  while (buffer.totalTokens > buffer.maxTokens && buffer.segments.length > 1) {
    const oldest = buffer.segments.shift()!
    buffer.totalTokens -= oldest.compressedToTokens
    evicted.push(oldest)
  }

  if (evicted.length > 0) {
    logForDebugging(
      `[shortTermBuffer] evicted ${evicted.length} segments to stay within ${buffer.maxTokens} token budget`,
    )
  }

  return evicted
}

/**
 * 将缓冲区内容格式化为可注入上下文的文本
 */
export function formatBufferForContext(buffer: ShortTermBuffer): string {
  if (buffer.segments.length === 0) return ''

  const parts: string[] = ['<conversation-context type="structured-buffer">']

  for (const seg of buffer.segments) {
    parts.push(`\n## [${seg.type}] ${new Date(seg.timeRange.start).toISOString().slice(11, 19)} - ${new Date(seg.timeRange.end).toISOString().slice(11, 19)}`)
    parts.push(seg.summary)

    if (seg.decisions.length > 0) {
      parts.push('\nDecisions:')
      for (const d of seg.decisions) {
        parts.push(`- ${d.what} (reason: ${d.why})`)
      }
    }

    if (seg.filesModified.length > 0) {
      parts.push(`\nFiles: ${seg.filesModified.join(', ')}`)
    }

    if (seg.keyInsights.length > 0) {
      parts.push('\nInsights:')
      for (const insight of seg.keyInsights) {
        parts.push(`- ${insight}`)
      }
    }

    if (seg.openQuestions.length > 0) {
      parts.push('\nOpen questions:')
      for (const q of seg.openQuestions) {
        parts.push(`- ${q}`)
      }
    }
  }

  parts.push('\n</conversation-context>')
  return parts.join('\n')
}

/**
 * 获取缓冲区文件路径
 */
function getBufferPath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, 'buffers', `${sessionId}.json`)
}

/**
 * 持久化缓冲区到磁盘
 */
export async function saveBuffer(projectDir: string, buffer: ShortTermBuffer): Promise<void> {
  const bufferPath = getBufferPath(projectDir, buffer.sessionId)
  const dir = path.dirname(bufferPath)
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(bufferPath, JSON.stringify(buffer, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(`[shortTermBuffer] failed to save: ${(e as Error).message}`)
  }
}

/**
 * 从磁盘加载缓冲区
 */
export async function loadBuffer(projectDir: string, sessionId: string): Promise<ShortTermBuffer | null> {
  const bufferPath = getBufferPath(projectDir, sessionId)
  try {
    const data = await fs.promises.readFile(bufferPath, 'utf-8')
    return JSON.parse(data) as ShortTermBuffer
  } catch {
    return null
  }
}

/**
 * 生成唯一的 segment ID
 */
export function generateSegmentId(): string {
  return `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
