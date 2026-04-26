import { randomUUID } from 'crypto'

// --- OpenAI 类型 ---

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
}

interface OpenAIChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: { role?: string; content?: string }
    finish_reason: string | null
  }>
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// --- 请求转换：OpenAI → Anthropic ---

export function openaiRequestToAnthropic(body: OpenAIChatRequest): {
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream: boolean
} {
  // 提取 system message
  let system: string | undefined
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const msg of body.messages) {
    if (msg.role === 'system') {
      system = system ? system + '\n' + msg.content : msg.content
    } else {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
    }
  }

  // Anthropic 要求 messages 以 user 开头，若第一条是 assistant 则补空 user
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '.' })
  }

  // 若 messages 为空（只有 system），补一条 user
  if (messages.length === 0) {
    messages.push({ role: 'user', content: '.' })
  }

  return {
    model: body.model,
    ...(system ? { system } : {}),
    messages,
    max_tokens: body.max_tokens ?? 4096,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    stream: body.stream ?? false,
  }
}

// --- SSE 流转换：Anthropic stream events → OpenAI SSE lines ---

export async function* anthropicStreamToOpenaiSSE(
  stream: AsyncIterable<any>,
  model: string,
): AsyncIterable<string> {
  const requestId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  for await (const event of stream) {
    const type = event.type ?? event.event

    if (type === 'message_start') {
      const chunk: OpenAIChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }
      yield `data: ${JSON.stringify(chunk)}\n\n`
    } else if (type === 'content_block_delta') {
      const text = event.delta?.text ?? ''
      if (text) {
        const chunk: OpenAIChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }
        yield `data: ${JSON.stringify(chunk)}\n\n`
      }
    } else if (type === 'message_delta') {
      const stopReason = event.delta?.stop_reason
      if (stopReason) {
        const finishReason = stopReason === 'end_turn' ? 'stop' : stopReason === 'max_tokens' ? 'length' : 'stop'
        const chunk: OpenAIChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        }
        yield `data: ${JSON.stringify(chunk)}\n\n`
      }
    } else if (type === 'message_stop') {
      yield `data: [DONE]\n\n`
    }
  }
}

// --- 非 stream 响应聚合 ---

export async function anthropicStreamToOpenaiJson(
  stream: AsyncIterable<any>,
  model: string,
): Promise<OpenAIChatResponse> {
  const requestId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let content = ''
  let finishReason = 'stop'
  let inputTokens = 0
  let outputTokens = 0

  for await (const event of stream) {
    const type = event.type ?? event.event

    if (type === 'message_start') {
      inputTokens = event.message?.usage?.input_tokens ?? 0
    } else if (type === 'content_block_delta') {
      content += event.delta?.text ?? ''
    } else if (type === 'message_delta') {
      outputTokens = event.usage?.output_tokens ?? 0
      const sr = event.delta?.stop_reason
      if (sr === 'max_tokens') finishReason = 'length'
    }
  }

  return {
    id: requestId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  }
}
