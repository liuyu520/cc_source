import { join } from 'path'
import type { LocalCommandCall, LocalJSXCommandContext } from '../../types/command.js'
import type {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
} from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js'
// 复用 export 命令中的文件名生成工具函数
import {
  extractFirstPrompt,
  sanitizeFilename,
} from '../export/export.js'

/**
 * 格式化时间戳为 YYYY-MM-DD-HHmmss 格式
 * (与 export 命令保持一致)
 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`
}

/**
 * 格式化 ISO 时间戳为可读的日期时间字符串
 */
function formatDateTime(timestamp?: string): string {
  if (!timestamp) return ''
  try {
    const date = new Date(timestamp)
    return date.toLocaleString()
  } catch {
    return timestamp
  }
}

/**
 * 从 UserMessage 中提取文本内容
 */
function extractUserContent(msg: UserMessage): string {
  const content = msg.message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block.type === 'text' && block.text) return block.text
        if (block.type === 'image') return '[Image]'
        if (block.type === 'tool_result') {
          // tool_result 内容块,尝试提取其中的文本
          const resultContent = (block as any).content
          if (typeof resultContent === 'string') return resultContent
          if (Array.isArray(resultContent)) {
            return resultContent
              .map((item: any) => {
                if (item.type === 'text') return item.text || ''
                if (item.type === 'image') return '[Image]'
                return ''
              })
              .filter(Boolean)
              .join('\n')
          }
          return ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 从 AssistantMessage 中提取内容,包括文本和工具调用
 */
function extractAssistantContent(msg: AssistantMessage): string {
  const content = msg.message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as any[]) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text)
      } else if (block.type === 'thinking' && block.thinking) {
        // 思考过程,添加折叠区域
        parts.push(`<details>\n<summary>💭 Thinking</summary>\n\n${block.thinking}\n\n</details>`)
      } else if (block.type === 'tool_use') {
        // 工具调用,格式化为代码块
        const toolName = block.name || 'unknown'
        const toolInput = block.input
        let inputStr = ''
        if (toolInput) {
          try {
            inputStr = typeof toolInput === 'string'
              ? toolInput
              : JSON.stringify(toolInput, null, 2)
          } catch {
            inputStr = String(toolInput)
          }
        }
        parts.push(`**🔧 Tool Use: \`${toolName}\`**`)
        if (inputStr) {
          parts.push(`\`\`\`json\n${inputStr}\n\`\`\``)
        }
      }
    }
    return parts.join('\n\n')
  }
  return ''
}

/**
 * 将所有会话消息渲染为 Markdown 格式
 */
function renderMessagesToMarkdown(messages: Message[]): string {
  const sections: string[] = []
  const now = new Date()

  // 文档头部 - YAML frontmatter 和标题
  sections.push('---')
  sections.push(`title: Claude Code Session Export`)
  sections.push(`exported_at: "${now.toISOString()}"`)
  sections.push(`message_count: ${messages.length}`)
  sections.push('---')
  sections.push('')
  sections.push('# Claude Code Session Export')
  sections.push('')
  sections.push(`> Exported at: ${now.toLocaleString()}`)
  sections.push(`> Total messages: ${messages.length}`)
  sections.push('')
  sections.push('---')
  sections.push('')

  let turnIndex = 0

  for (const msg of messages) {
    const time = formatDateTime(msg.timestamp || msg.createdAt)
    const timeTag = time ? ` <sub>${time}</sub>` : ''

    switch (msg.type) {
      case 'user': {
        turnIndex++
        const text = extractUserContent(msg as UserMessage)
        if (!text) break
        sections.push(`## 🧑 User${timeTag}`)
        sections.push('')
        sections.push(text)
        sections.push('')
        sections.push('---')
        sections.push('')
        break
      }

      case 'assistant': {
        const text = extractAssistantContent(msg as AssistantMessage)
        if (!text) break
        sections.push(`## 🤖 Assistant${timeTag}`)
        sections.push('')
        sections.push(text)
        sections.push('')
        sections.push('---')
        sections.push('')
        break
      }

      case 'system': {
        const sysMsg = msg as SystemMessage
        // 跳过内部元数据类型的系统消息
        if (sysMsg.isMeta) break
        const sysText = sysMsg.message || ''
        if (!sysText) break
        const level = sysMsg.level || 'info'
        sections.push(`## ⚙️ System (${level})${timeTag}`)
        sections.push('')
        sections.push(`> ${sysText}`)
        sections.push('')
        sections.push('---')
        sections.push('')
        break
      }

      case 'progress': {
        // 进度消息通常不需要导出,跳过
        break
      }

      case 'tool_use_summary': {
        // 工具使用摘要
        sections.push(`## 📋 Tool Use Summary${timeTag}`)
        sections.push('')
        const summaryContent = (msg as any).message?.content
        if (typeof summaryContent === 'string') {
          sections.push(summaryContent)
        } else if (Array.isArray(summaryContent)) {
          for (const block of summaryContent) {
            if (block.type === 'text' && block.text) {
              sections.push(block.text)
            }
          }
        }
        sections.push('')
        sections.push('---')
        sections.push('')
        break
      }

      default:
        // 其他类型消息(attachment, hook_result, tombstone, grouped_tool_use)
        // 仅当有可展示内容时才输出
        break
    }
  }

  // 文档尾部
  sections.push('')
  sections.push(`*Total turns: ${turnIndex}*`)

  return sections.join('\n')
}

/**
 * 生成默认的 Markdown 导出文件名
 * 复用 export 命令的文件名生成逻辑
 */
function generateDefaultFilename(messages: Message[]): string {
  const firstPrompt = extractFirstPrompt(messages)
  const timestamp = formatTimestamp(new Date())
  if (firstPrompt) {
    const sanitized = sanitizeFilename(firstPrompt)
    return sanitized
      ? `${timestamp}-${sanitized}.md`
      : `conversation-${timestamp}.md`
  }
  return `conversation-${timestamp}.md`
}

/**
 * /export-md 命令入口
 * 将当前会话的完整历史导出为 Markdown 文件
 */
export const call: LocalCommandCall = async (
  args: string,
  context: LocalJSXCommandContext,
) => {
  const messages = context.messages
  if (!messages || messages.length === 0) {
    return { type: 'text', value: 'No messages to export.' }
  }

  // 渲染消息为 Markdown
  const markdownContent = renderMessagesToMarkdown(messages)

  // 确定文件名: 使用用户提供的参数或生成默认文件名
  const userFilename = args.trim()
  let finalFilename: string
  if (userFilename) {
    // 确保以 .md 结尾
    finalFilename = userFilename.endsWith('.md')
      ? userFilename
      : userFilename.replace(/\.[^.]+$/, '') + '.md'
  } else {
    finalFilename = generateDefaultFilename(messages)
  }

  const filepath = join(getCwd(), finalFilename)

  try {
    writeFileSync_DEPRECATED(filepath, markdownContent, {
      encoding: 'utf-8',
      flush: true,
    })
    return {
      type: 'text',
      value: `Conversation exported to Markdown: ${filepath}\n(${messages.length} messages, ${turnCount(messages)} user turns)`,
    }
  } catch (error) {
    return {
      type: 'text',
      value: `Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

/**
 * 计算用户发言轮次数
 */
function turnCount(messages: Message[]): number {
  return messages.filter(m => m.type === 'user').length
}
