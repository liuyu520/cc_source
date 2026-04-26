import { extname } from 'path'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  getLastAssistantMessage,
  getUserMessageText,
} from '../../utils/messages.js'

export type DiscoverySignal =
  | {
      type: 'user_message'
      query: string
      mentionedPaths: string[]
      recentTools: string[]
      activeFileExtensions: string[]
    }
  | {
      type: 'write_pivot'
      query: string
      mentionedPaths: string[]
      recentTools: string[]
      activeFileExtensions: string[]
    }

const PIVOT_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  BASH_TOOL_NAME,
])

function normalizeQuery(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractAtMentionedPaths(content: string): string[] {
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g
  const paths = new Set<string>()

  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = quotedAtMentionRegex.exec(content)) !== null) {
    const value = quotedMatch[2]
    if (value && !value.endsWith(' (agent)')) {
      paths.add(value)
    }
  }

  let regularMatch: RegExpExecArray | null
  while ((regularMatch = regularAtMentionRegex.exec(content)) !== null) {
    const value = regularMatch[2]
    if (value && !value.startsWith('"') && !value.startsWith('agent-')) {
      paths.add(value)
    }
  }

  return [...paths]
}

function getAssistantText(message: Message | undefined): string {
  if (!message || message.type !== 'assistant') {
    return ''
  }

  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim()
}

function getRecentTools(message: Message | undefined): string[] {
  if (!message || message.type !== 'assistant') {
    return []
  }

  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) {
    return []
  }

  const toolNames = new Set<string>()
  for (const block of content) {
    if (block.type === 'tool_use' && 'name' in block) {
      toolNames.add(String(block.name))
    }
  }

  return [...toolNames]
}

function hasEnoughSignal(text: string): boolean {
  if (text.length >= 12) {
    return true
  }
  return /\s/.test(text)
}

/**
 * 从assistant消息的tool_use blocks中提取操作文件的扩展名
 */
function extractFileExtensions(message: Message | undefined): string[] {
  if (!message || message.type !== 'assistant') return []
  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) return []

  const extensions = new Set<string>()
  for (const block of content) {
    if (block.type === 'tool_use' && 'input' in block) {
      const input = block.input as Record<string, unknown>
      const filePath = input?.file_path as string | undefined
      if (filePath) {
        const ext = extname(filePath)
        if (ext) extensions.add(ext)
        // 检测 .test. / .spec. 模式
        const base = filePath.toLowerCase()
        if (base.includes('.test.') || base.includes('.spec.')) {
          extensions.add('.test.')
        }
      }
    }
  }
  return [...extensions]
}

/**
 * 从@引用路径中提取文件扩展名
 */
function extractExtensionsFromPaths(paths: string[]): string[] {
  const extensions = new Set<string>()
  for (const p of paths) {
    const ext = extname(p)
    if (ext) extensions.add(ext)
  }
  return [...extensions]
}

export function createSkillSearchSignal(
  input: string | null,
  messages: Message[],
  _toolUseContext?: ToolUseContext,
): DiscoverySignal | null {
  if (input !== null) {
    const query = normalizeQuery(input)
    if (!query || query.startsWith('/')) {
      return null
    }
    if (!hasEnoughSignal(query)) {
      return null
    }
    return {
      type: 'user_message',
      query,
      mentionedPaths: extractAtMentionedPaths(input),
      recentTools: [],
      activeFileExtensions: extractExtensionsFromPaths(extractAtMentionedPaths(input)),
    }
  }

  const lastUserMessage = messages.findLast(
    message => message.type === 'user' && !message.isMeta,
  )
  if (!lastUserMessage) {
    return null
  }

  const lastAssistantMessage = getLastAssistantMessage(messages)
  const recentTools = getRecentTools(lastAssistantMessage)
  if (!recentTools.some(name => PIVOT_TOOLS.has(name))) {
    return null
  }

  const lastUserText = normalizeQuery(getUserMessageText(lastUserMessage))
  const assistantText = normalizeQuery(getAssistantText(lastAssistantMessage))
  const query = normalizeQuery(
    [lastUserText, assistantText].filter(Boolean).join(' '),
  )
  if (!query || !hasEnoughSignal(query)) {
    return null
  }

  return {
    type: 'write_pivot',
    query,
    mentionedPaths: extractAtMentionedPaths(lastUserText),
    recentTools,
    activeFileExtensions: extractFileExtensions(lastAssistantMessage),
  }
}
