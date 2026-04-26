/**
 * 通用 SSE (Server-Sent Events) 解析器
 *
 * 将 ReadableStream<Uint8Array> 解析为独立的 SSE 事件。
 * 可复用于所有基于 SSE 的 Provider（OpenAI、DeepSeek、Moonshot 等）。
 *
 * SSE 格式：
 *   event: <event-type>
 *   data: <json-payload>
 *   \n（空行 = 事件边界）
 *
 * 举一反三：
 *   任何新的 OpenAI 兼容 Provider 直接使用此解析器，
 *   无需再自己实现 SSE 行缓冲逻辑。
 */

export interface ParsedSSEEvent {
  event: string
  data: string
}

/**
 * 将 SSE 字节流解析为独立事件
 *
 * 处理：行缓冲、incomplete 行、多 data 行拼接、空行事件边界
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let currentData = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      // 最后一个元素可能是不完整的行，保留到 buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        // SSE 规范：以 ':' 开头的行为注释（常用于 keep-alive），显式跳过
        if (line.startsWith(':')) {
          continue
        }
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          const dataContent = line.slice(6)
          // OpenAI SSE 流以 data: [DONE] 作为终止哨兵，显式跳过
          if (dataContent === '[DONE]') {
            continue
          }
          // 支持多 data 行拼接（SSE 规范允许）
          currentData += (currentData ? '\n' : '') + dataContent
        } else if (line === '') {
          // 空行 = 事件边界
          if (currentData) {
            // 容错：部分 OpenAI 兼容端点省略 event: 行，此时用 data 中的 type 字段
            yield { event: currentEvent || 'message', data: currentData }
          }
          currentEvent = ''
          currentData = ''
        }
      }
    }

    // 处理最后可能残留的事件
    if (currentData) {
      yield { event: currentEvent || 'message', data: currentData }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 通用 SSE 事件 JSON 解析
 * @returns 解析后的对象（带 type 字段），解析失败返回 null
 */
export function parseSSEEventData<T extends { type: string }>(
  sse: ParsedSSEEvent,
): T | null {
  try {
    const data = JSON.parse(sse.data)
    return { type: sse.event, ...data } as T
  } catch {
    return null
  }
}
