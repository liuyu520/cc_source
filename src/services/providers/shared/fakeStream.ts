/**
 * 通用 Fake Stream 生成器
 *
 * 将非流式的完整 Message 对象包装为 AsyncIterable，
 * 发出完整的 Anthropic content_block 三段式事件序列。
 *
 * 可复用于所有 Provider 的非流式响应路径，确保：
 * - claude.ts 的流处理逻辑无需区分流式/非流式
 * - 所有 content block 都有 start / delta / stop 生命周期
 *
 * 举一反三：
 *   新 Provider 的非流式路径只需调用 createFakeStream(message, controller)，
 *   无需自己手写事件序列（之前每个 Provider 都容易漏掉 content_block 事件）。
 */

/**
 * 将 Anthropic BetaMessage-like 对象包装为 AsyncIterable 流
 *
 * @param message  完整的消息对象（需要有 content, stop_reason, usage 字段）
 * @param controller  AbortController（挂载到返回的流对象上，供 claude.ts 检测）
 */
export function createFakeStream(
  message: Record<string, unknown>,
  controller: AbortController,
): AsyncIterable<Record<string, unknown>> & { controller: AbortController } {
  const stream = {
    async *[Symbol.asyncIterator]() {
      const content = (message.content ?? []) as Array<Record<string, unknown>>

      // message_start（content 置空，后续通过 block 事件逐个发出）
      yield { type: 'message_start', message: { ...message, content: [] } }

      // 为每个 content block 发出 start / delta / stop 三段式事件
      for (let i = 0; i < content.length; i++) {
        const block = content[i]
        yield { type: 'content_block_start', index: i, content_block: block }

        if (block.type === 'text') {
          yield {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'text_delta', text: block.text },
          }
        } else if (block.type === 'tool_use') {
          yield {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          }
        } else if (block.type === 'thinking') {
          yield {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'thinking_delta', thinking: block.thinking },
          }
        }

        yield { type: 'content_block_stop', index: i }
      }

      yield {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason ?? 'end_turn', stop_sequence: null },
        usage: message.usage,
      }
      yield { type: 'message_stop' }
    },
    controller,
  }

  return stream
}
