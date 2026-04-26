/**
 * SSE 解析器与 Anthropic 兼容流封装
 *
 * 将 OpenAI Responses API 的 text/event-stream 响应体解析为独立事件，
 * 经过 ResponseTranslator 转换后，封装为 AsyncIterable（兼容 Anthropic SDK 的 Stream 接口）。
 *
 * Phase 5: 使用 shared/sseParser 替代内联实现，复用通用基础设施。
 *
 * 关键接口兼容：
 * - claude.ts 通过 `for await (const part of stream)` 消费
 * - stream 需要有 .controller 属性（用于区分 stream 和 error message）
 */

import type { ResponseEvent } from './types.js'
import { ResponseTranslator } from './translator/responseTranslator.js'
import { parseSSE, parseSSEEventData } from '../../shared/sseParser.js'

/**
 * 将 OpenAI Responses API 的 SSE 响应体转换为 Anthropic 兼容的事件流
 *
 * 返回的对象兼容 claude.ts 中的消费方式：
 *   for await (const part of stream) { switch(part.type) { ... } }
 *
 * 同时提供 .controller 属性（AbortController），用于 claude.ts 区分
 * stream 对象和 error message 对象。
 */
export function createAnthropicCompatibleStream(
  responseBody: ReadableStream<Uint8Array>,
  abortController?: AbortController,
): AsyncIterable<Record<string, unknown>> & { controller: AbortController } {
  const controller = abortController ?? new AbortController()
  const translator = new ResponseTranslator()

  const asyncIterable: AsyncIterable<Record<string, unknown>> = {
    async *[Symbol.asyncIterator]() {
      for await (const sse of parseSSE(responseBody)) {
        if (controller.signal.aborted) return

        const responseEvent = parseSSEEventData<ResponseEvent>(sse)
        if (!responseEvent) continue

        // 通过翻译器转换为 Anthropic 事件
        const anthropicEvents = translator.translate(responseEvent)
        for (const event of anthropicEvents) {
          yield event
        }
      }
    },
  }

  // 添加 controller 属性，兼容 claude.ts 的检测逻辑
  return Object.assign(asyncIterable, { controller })
}

/**
 * 创建非流式响应的合成 Anthropic Message 对象
 *
 * 当 OpenAI Responses API 以非流式模式返回时，
 * 将完整的 Response 对象转换为 Anthropic BetaMessage 格式。
 */
export function createAnthropicMessageFromResponse(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const resp = response as {
    id?: string
    model?: string
    output?: Array<{
      type: string
      content?: Array<{ type: string; text?: string }>
      call_id?: string
      name?: string
      arguments?: string
    }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
    status?: string
  }

  const content: Array<Record<string, unknown>> = []
  let hasToolUse = false

  for (const item of resp.output ?? []) {
    switch (item.type) {
      case 'message': {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && part.text) {
            content.push({ type: 'text', text: part.text })
          }
        }
        break
      }
      case 'function_call': {
        hasToolUse = true
        let parsedInput: unknown = {}
        try {
          parsedInput = JSON.parse(item.arguments ?? '{}')
        } catch {
          parsedInput = {}
        }
        content.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input: parsedInput,
        })
        break
      }
      case 'reasoning': {
        // 从 reasoning item 的 summary 中提取思维文本
        const reasoningItem = item as {
          type: 'reasoning'
          summary?: Array<{ type: string; text?: string }>
        }
        const summaryTexts = (reasoningItem.summary ?? [])
          .filter(s => s.type === 'summary_text' && s.text)
          .map(s => s.text!)
        if (summaryTexts.length > 0) {
          content.push({
            type: 'thinking',
            thinking: summaryTexts.join('\n'),
            signature: '',
          })
        }
        break
      }
    }
  }

  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: resp.model ?? '',
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: resp.usage?.input_tokens_details?.cached_tokens ?? 0,
    },
  }
}
