/**
 * messageSegmenter — 消息分段器
 *
 * 将对话消息序列切分为语义段落（segment），每个段落代表一个
 * 连贯的任务/话题。分段依据：
 *   1. 用户明确的话题切换（新的指令/问题）
 *   2. 工具调用模式变化（从读取变为编辑，或工具类型切换）
 *   3. 时间间隔（消息之间超过一定间隔）
 *
 * 分段结果用于 shortTermBuffer 的结构化压缩。
 */

import type { BufferSegment, Decision, CodeRef } from './shortTermBuffer.js'
import { generateSegmentId } from './shortTermBuffer.js'

// 工具分类
const EXPLORATION_TOOLS = new Set([
  'FileReadTool', 'Read', 'GlobTool', 'Glob', 'GrepTool', 'Grep', 'LS', 'LSP',
  'WebFetchTool', 'WebFetch', 'WebSearchTool', 'WebSearch',
])

const IMPLEMENTATION_TOOLS = new Set([
  'FileEditTool', 'Edit', 'FileWriteTool', 'Write', 'NotebookEdit',
])

const DEBUG_TOOLS = new Set([
  'Bash', 'Shell', 'BashTool',
])

interface MessageInfo {
  index: number
  role: 'user' | 'assistant' | 'system'
  text: string
  toolUses: { name: string; input: string }[]
  toolResults: { toolName: string; content: string; isError: boolean }[]
  timestamp?: number
  filesReferenced: string[]
}

/**
 * 从原始消息中提取结构化信息
 */
function extractMessageInfo(msg: unknown, index: number): MessageInfo {
  const m = msg as {
    type?: string
    message?: { role?: string; content?: unknown }
    createdAt?: number
  }

  const role = (m.type === 'user' || m.message?.role === 'user') ? 'user'
    : (m.type === 'assistant' || m.message?.role === 'assistant') ? 'assistant'
    : 'system'

  const text: string[] = []
  const toolUses: { name: string; input: string }[] = []
  const toolResults: { toolName: string; content: string; isError: boolean }[] = []
  const filesReferenced: string[] = []

  const content = m.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>

      if (b.type === 'text' && typeof b.text === 'string') {
        text.push(b.text as string)
        // 提取文件路径引用
        const pathMatches = (b.text as string).match(/(?:\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,6}/g)
        if (pathMatches) filesReferenced.push(...pathMatches)
      } else if (b.type === 'tool_use') {
        const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? '').slice(0, 200)
        toolUses.push({ name: b.name as string || 'unknown', input })
        // 从工具输入提取文件路径
        if (b.input && typeof b.input === 'object') {
          const inp = b.input as Record<string, unknown>
          if (typeof inp.file_path === 'string') filesReferenced.push(inp.file_path)
          if (typeof inp.path === 'string') filesReferenced.push(inp.path)
          if (typeof inp.command === 'string') {
            const cmdPaths = (inp.command as string).match(/(?:\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,6}/g)
            if (cmdPaths) filesReferenced.push(...cmdPaths)
          }
        }
      } else if (b.type === 'tool_result') {
        const contentStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '').slice(0, 200)
        toolResults.push({
          toolName: '', // 会后续填充
          content: contentStr,
          isError: !!b.is_error,
        })
      }
    }
  } else if (typeof content === 'string') {
    text.push(content)
  }

  return {
    index,
    role,
    text: text.join(' '),
    toolUses,
    toolResults,
    timestamp: m.createdAt ?? undefined,
    filesReferenced: [...new Set(filesReferenced)],
  }
}

/**
 * 判断活动类型
 */
function classifyActivity(
  toolUses: { name: string }[],
): BufferSegment['type'] {
  if (toolUses.length === 0) return 'conversation'

  let explore = 0, implement = 0, debug = 0
  for (const t of toolUses) {
    if (EXPLORATION_TOOLS.has(t.name)) explore++
    else if (IMPLEMENTATION_TOOLS.has(t.name)) implement++
    else if (DEBUG_TOOLS.has(t.name)) debug++
  }

  if (implement > 0 && debug > 0) return 'debugging'
  if (implement > 0) return 'implementation'
  if (debug > explore) return 'debugging'
  if (explore > 0) return 'exploration'
  return 'conversation'
}

/**
 * 检测是否是话题切换边界
 */
function isTopicBoundary(prev: MessageInfo, curr: MessageInfo): boolean {
  // 用户消息通常是新指令的开始
  if (curr.role === 'user' && prev.role === 'assistant') {
    // 用户消息长度 > 50字符 更可能是新话题
    if (curr.text.length > 50) return true
  }

  // 工具模式从探索切换到实现（或反过来）
  const prevTools = prev.toolUses.map(t => t.name)
  const currTools = curr.toolUses.map(t => t.name)
  const prevIsExplore = prevTools.some(t => EXPLORATION_TOOLS.has(t))
  const currIsImplement = currTools.some(t => IMPLEMENTATION_TOOLS.has(t))
  if (prevIsExplore && currIsImplement) return true

  return false
}

/**
 * 从一组消息中提取决策
 */
function extractDecisions(messages: MessageInfo[]): Decision[] {
  const decisions: Decision[] = []
  const decisionKeywords = /(?:decide|chose|going with|选择|决定|方案|采用)/i

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (decisionKeywords.test(msg.text)) {
      // 提取包含决策关键词的句子
      const sentences = msg.text.split(/[.。!！\n]/).filter(s => decisionKeywords.test(s))
      for (const s of sentences.slice(0, 2)) { // 每条消息最多2个决策
        decisions.push({
          what: s.trim().slice(0, 200),
          why: '', // 简化：从上下文推断原因较复杂，留空
        })
      }
    }
  }

  return decisions.slice(0, 5) // 每段最多5个决策
}

/**
 * 从一组消息中提取代码引用
 */
function extractCodeRefs(messages: MessageInfo[]): CodeRef[] {
  const refs = new Map<string, CodeRef>()

  for (const msg of messages) {
    for (const tool of msg.toolUses) {
      if (IMPLEMENTATION_TOOLS.has(tool.name)) {
        // 尝试从 input 中提取文件路径
        try {
          const input = JSON.parse(tool.input)
          if (input.file_path) {
            refs.set(input.file_path, {
              file: input.file_path,
              action: tool.name.includes('Edit') ? 'modified' : 'created',
            })
          }
        } catch { /* 忽略解析失败 */ }
      }
    }

    for (const file of msg.filesReferenced) {
      if (!refs.has(file)) {
        refs.set(file, { file, action: 'read' })
      }
    }
  }

  return [...refs.values()].slice(0, 10)
}

/**
 * 从一组消息中提取关键洞察
 */
function extractKeyInsights(messages: MessageInfo[]): string[] {
  const insights: string[] = []
  const insightPatterns = [
    /(?:found|discovered|noticed|realized|关键|发现|注意到)/i,
    /(?:the (?:issue|problem|root cause) (?:is|was)|问题是|原因是)/i,
    /(?:important|critical|crucial|注意|重要)/i,
  ]

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const pattern of insightPatterns) {
      if (pattern.test(msg.text)) {
        const sentences = msg.text.split(/[.。!！\n]/).filter(s => pattern.test(s))
        for (const s of sentences.slice(0, 1)) {
          const trimmed = s.trim().slice(0, 200)
          if (trimmed.length > 20) insights.push(trimmed)
        }
      }
    }
  }

  return [...new Set(insights)].slice(0, 5)
}

export interface MessageSegment {
  messages: MessageInfo[]
  startIndex: number
  endIndex: number
}

/**
 * 将消息序列切分为语义段落
 */
export function segmentMessages(messages: readonly unknown[]): MessageSegment[] {
  if (messages.length === 0) return []

  const infos = messages.map((msg, i) => extractMessageInfo(msg, i))
  const segments: MessageSegment[] = []
  let currentSegment: MessageInfo[] = [infos[0]]

  for (let i = 1; i < infos.length; i++) {
    if (isTopicBoundary(infos[i - 1], infos[i]) && currentSegment.length >= 2) {
      segments.push({
        messages: currentSegment,
        startIndex: currentSegment[0].index,
        endIndex: currentSegment[currentSegment.length - 1].index,
      })
      currentSegment = []
    }
    currentSegment.push(infos[i])
  }

  // 最后一个 segment
  if (currentSegment.length > 0) {
    segments.push({
      messages: currentSegment,
      startIndex: currentSegment[0].index,
      endIndex: currentSegment[currentSegment.length - 1].index,
    })
  }

  return segments
}

/**
 * 将消息段落转换为 BufferSegment
 */
export function segmentToBufferSegment(
  segment: MessageSegment,
  originalTokenCount: number,
): BufferSegment {
  const msgs = segment.messages
  const allToolUses = msgs.flatMap(m => m.toolUses)
  const allFiles = [...new Set(msgs.flatMap(m => m.filesReferenced))]

  // 生成概要 — 取第一条用户消息的前100字符
  const firstUserMsg = msgs.find(m => m.role === 'user')
  const summary = firstUserMsg
    ? firstUserMsg.text.slice(0, 200)
    : msgs[0].text.slice(0, 200)

  return {
    id: generateSegmentId(),
    timeRange: {
      start: msgs[0].timestamp ?? Date.now(),
      end: msgs[msgs.length - 1].timestamp ?? Date.now(),
    },
    type: classifyActivity(allToolUses),
    summary,
    decisions: extractDecisions(msgs),
    filesModified: allFiles.filter(f =>
      msgs.some(m => m.toolUses.some(t => IMPLEMENTATION_TOOLS.has(t.name)))
    ).slice(0, 10),
    keyInsights: extractKeyInsights(msgs),
    openQuestions: [], // 由 compact prompt 填充
    codeContext: extractCodeRefs(msgs),
    importanceScore: 0.5, // 默认值，后续可由 importanceScoring 增强
    compressedFromTokens: originalTokenCount,
    compressedToTokens: 0, // appendSegment 会计算
  }
}
