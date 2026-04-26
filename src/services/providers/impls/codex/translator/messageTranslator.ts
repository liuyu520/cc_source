/**
 * 消息格式转换器 — Anthropic messages[] -> OpenAI input[] (ResponseItem[])
 *
 * 将 Anthropic Messages API 的对话历史转换为 OpenAI Responses API 的 input 格式。
 *
 * 核心映射：
 * - user text message → MessageItem(role=user, content=[InputTextPart])
 * - assistant text → MessageItem(role=assistant, content=[OutputTextPart])
 * - tool_use block → FunctionCallItem
 * - tool_result block → FunctionCallOutputItem
 * - thinking block → ReasoningItem
 * - image block → InputImagePart
 */

import type {
  ResponseItem,
  MessageItem,
  FunctionCallItem,
  FunctionCallOutputItem,
  ReasoningItem,
  MessageContentPart,
  InputTextPart,
  OutputTextPart,
  InputImagePart,
} from '../types.js'

// ==================== Anthropic 消息类型（简化） ====================

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | AnthropicContentBlock[]; is_error?: boolean; [k: string]: unknown }
  | { type: 'thinking'; thinking: string; signature?: string; [k: string]: unknown }
  | { type: 'image'; source: { type: string; media_type: string; data: string }; [k: string]: unknown }
  | { type: 'server_tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | { type: string; [k: string]: unknown }

/**
 * 将 Anthropic messages 数组转换为 OpenAI ResponseItem 数组
 */
export function translateMessages(messages: AnthropicMessage[]): ResponseItem[] {
  const result: ResponseItem[] = []

  for (const msg of messages) {
    const items = translateSingleMessage(msg)
    result.push(...items)
  }

  return result
}

/**
 * 单条消息转换 — 一条 Anthropic 消息可能产生多个 ResponseItem
 * （例如 assistant 消息中同时包含 text 和 tool_use）
 */
function translateSingleMessage(msg: AnthropicMessage): ResponseItem[] {
  // 纯字符串内容
  if (typeof msg.content === 'string') {
    return [createMessageItem(msg.role, [
      msg.role === 'user'
        ? { type: 'input_text' as const, text: msg.content }
        : { type: 'output_text' as const, text: msg.content },
    ])]
  }

  const items: ResponseItem[] = []
  const textParts: MessageContentPart[] = []
  const imageParts: MessageContentPart[] = []

  for (const block of msg.content) {
    switch (block.type) {
      case 'text': {
        const textBlock = block as { type: 'text'; text: string }
        if (msg.role === 'user') {
          textParts.push({ type: 'input_text', text: textBlock.text })
        } else {
          textParts.push({ type: 'output_text', text: textBlock.text })
        }
        break
      }

      case 'tool_use': {
        // 先flush已有的文本parts
        if (textParts.length > 0 || imageParts.length > 0) {
          items.push(createMessageItem(msg.role, [...textParts, ...imageParts]))
          textParts.length = 0
          imageParts.length = 0
        }
        const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: unknown }
        items.push(createFunctionCallItem(toolBlock))
        break
      }

      case 'server_tool_use': {
        // Anthropic server_tool_use（如 advisor）在 OpenAI 中无对应，跳过
        break
      }

      case 'tool_result': {
        const resultBlock = block as {
          type: 'tool_result'
          tool_use_id: string
          content?: string | AnthropicContentBlock[]
          is_error?: boolean
        }
        items.push(createFunctionCallOutputItem(resultBlock))
        break
      }

      case 'thinking': {
        const thinkingBlock = block as { type: 'thinking'; thinking: string }
        items.push(createReasoningItem(thinkingBlock))
        break
      }

      case 'image': {
        const imageBlock = block as {
          type: 'image'
          source: { type: string; media_type: string; data: string }
        }
        imageParts.push(createInputImagePart(imageBlock))
        break
      }

      default:
        // 未知 block 类型，尝试提取文本
        if ('text' in block && typeof block.text === 'string') {
          textParts.push(
            msg.role === 'user'
              ? { type: 'input_text' as const, text: block.text }
              : { type: 'output_text' as const, text: block.text },
          )
        }
        break
    }
  }

  // flush 剩余的文本和图片 parts
  if (textParts.length > 0 || imageParts.length > 0) {
    items.push(createMessageItem(msg.role, [...textParts, ...imageParts]))
  }

  return items
}

// ==================== 工厂函数 ====================

function createMessageItem(
  role: 'user' | 'assistant',
  content: MessageContentPart[],
): MessageItem {
  return {
    type: 'message',
    role,
    content,
  }
}

function createFunctionCallItem(block: {
  id: string
  name: string
  input: unknown
}): FunctionCallItem {
  return {
    type: 'function_call',
    call_id: block.id,
    name: block.name,
    arguments: typeof block.input === 'string'
      ? block.input
      : JSON.stringify(block.input),
  }
}

function createFunctionCallOutputItem(block: {
  tool_use_id: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
}): FunctionCallOutputItem {
  let output: string
  if (typeof block.content === 'string') {
    output = block.content
  } else if (Array.isArray(block.content)) {
    // 提取嵌套内容：文本拼接，图片尝试完整传递 data URL
    output = block.content
      .map(c => {
        if (c.type === 'text' && 'text' in c) return (c as { text: string }).text
        if (c.type === 'image' && 'source' in c) {
          const src = (c as { source: { type: string; media_type?: string; data?: string; url?: string } }).source
          if (src.type === 'url' && src.url) return `[image: ${src.url}]`
          if (src.data && src.media_type) {
            // 超大图片（base64 > 10MB）截断并警告
            if (src.data.length > 10_000_000) {
              console.error(`[codex-translator] Image in tool result exceeds 10MB (${Math.round(src.data.length / 1_000_000)}MB), truncating`)
              return `[image: data:${src.media_type};base64,${src.data.slice(0, 50)}... (truncated, ${Math.round(src.data.length / 1_000_000)}MB)]`
            }
            return `data:${src.media_type};base64,${src.data}`
          }
          return '[image]'
        }
        return JSON.stringify(c)
      })
      .join('\n')
  } else {
    output = ''
  }

  // 如果是错误结果，添加前缀标识
  if (block.is_error) {
    output = `[ERROR] ${output}`
  }

  return {
    type: 'function_call_output',
    call_id: block.tool_use_id,
    output,
  }
}

function createReasoningItem(block: { thinking: string }): ReasoningItem {
  // OpenAI ReasoningItem 仅支持 summary 字段，但我们传入的是完整推理过程（非摘要）
  // 加前缀让模型明确区分：这是上一轮的完整推理 trace，而非压缩后的摘要
  return {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: `[Full reasoning trace]\n${block.thinking}` }],
  }
}

function createInputImagePart(block: {
  source: { type: string; media_type?: string; data?: string; url?: string }
}): InputImagePart {
  // URL 类型图片：直接传递 URL
  if (block.source.type === 'url' && block.source.url) {
    return {
      type: 'input_image',
      image_url: block.source.url,
      detail: 'auto',
    }
  }
  // base64 类型图片：拼接 data URL
  return {
    type: 'input_image',
    image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    detail: 'auto',
  }
}
