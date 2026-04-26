/**
 * CodexAnthropicAdapter — 伪装为 Anthropic SDK Client 的 OpenAI Responses API 客户端
 *
 * 核心设计：模拟 Anthropic SDK 的接口链
 *   anthropic.beta.messages.create(params, options).withResponse()
 *
 * 内部流程：
 *   1. requestTranslator 将 Anthropic 参数转换为 OpenAI Responses API 请求
 *   2. 通过 fetch() 发送 SSE 请求到 /v1/responses 端点（带重试和超时）
 *   3. streaming.ts 将 SSE 响应解析并转换为 Anthropic 兼容流
 *
 * Phase 4 增强：
 *   - 请求级超时（默认 120s，CODEX_REQUEST_TIMEOUT_MS 可配置）
 *   - 可重试错误自动重试（5xx/429/网络错误，指数退避）
 *   - 翻译管道遥测指标（--verbose 模式下输出）
 *
 * 对外完全透明——claude.ts 的流处理逻辑零改动。
 */

import { APIError } from '@anthropic-ai/sdk'
import { translateRequest } from './translator/requestTranslator.js'
import {
  createAnthropicCompatibleStream,
  createAnthropicMessageFromResponse,
} from './streaming.js'
import type { CodexCredentials } from './auth.js'
import { loadCodexCredentials } from './auth.js'

// ==================== 配置 ====================

export interface CodexAdapterConfig {
  /** API base URL (e.g., https://api.openai.com/v1) */
  baseUrl: string
  /** 预加载的凭证（可选，为空时按需加载） */
  credentials?: CodexCredentials | null
  /** 模型名称覆盖 */
  model?: string
  /** ChatGPT Account ID（OAuth 模式需要） */
  accountId?: string
  /** 最大重试次数 */
  maxRetries?: number
}

// ==================== 遥测指标 ====================

interface TranslationMetrics {
  requestTranslateMs: number
  totalRequestMs: number
  responseEvents: number
  retries: number
  errors: string[]
}

const CODEX_REQUEST_TIMEOUT_MS = parseInt(
  process.env.CODEX_REQUEST_TIMEOUT_MS ?? '120000', 10,
)
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529])
const INITIAL_RETRY_DELAY_MS = 1000
const RETRY_JITTER_FACTOR = 0.25

// ==================== 适配器实现 ====================

/**
 * 创建伪装为 Anthropic SDK Client 的适配器实例
 */
export function createCodexAdapter(config: CodexAdapterConfig): Record<string, unknown> {
  const adapter = new CodexAnthropicAdapterImpl(config)
  return adapter as unknown as Record<string, unknown>
}

class CodexAnthropicAdapterImpl {
  private config: CodexAdapterConfig
  private maxRetries: number

  beta: {
    messages: {
      create: (params: Record<string, unknown>, options?: Record<string, unknown>) => PromiseWithResponse
    }
  }

  messages: {
    create: (params: Record<string, unknown>, options?: Record<string, unknown>) => PromiseWithResponse
  }

  constructor(config: CodexAdapterConfig) {
    this.config = config
    this.maxRetries = config.maxRetries ?? 0
    // 重试由外层 withRetry 统一管理，adapter 默认不做内部重试

    const createFn = (params: Record<string, unknown>, options?: Record<string, unknown>) => {
      return this._createWithResponseChain(params, options)
    }

    this.beta = {
      messages: { create: createFn },
    }

    this.messages = {
      create: createFn,
    }
  }

  private _createWithResponseChain(
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): PromiseWithResponse {
    const basePromise = this._executeWithRetry(params, options)
    const enhanced = basePromise.then(result => result.data) as PromiseWithResponse
    enhanced.withResponse = () => basePromise
    return enhanced
  }

  /**
   * 带重试的请求执行器
   * 可重试条件：5xx / 429 / 网络错误（非流式请求）
   */
  private async _executeWithRetry(
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{
    data: AsyncIterable<Record<string, unknown>> & { controller: AbortController }
    response: Response
    request_id: string
  }> {
    const metrics: TranslationMetrics = {
      requestTranslateMs: 0,
      totalRequestMs: 0,
      responseEvents: 0,
      retries: 0,
      errors: [],
    }
    const startTime = Date.now()

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this._executeRequest(params, options, metrics)
        metrics.totalRequestMs = Date.now() - startTime
        this._logMetrics(metrics)
        return result
      } catch (err) {
        const status = (err as Record<string, unknown>)?.status as number | undefined
        const isRetryable = this._isRetryableError(err, status)

        if (!isRetryable || attempt >= this.maxRetries) {
          metrics.totalRequestMs = Date.now() - startTime
          metrics.errors.push(String((err as Error)?.message ?? err))
          this._logMetrics(metrics)
          throw err
        }

        metrics.retries++
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt),
          30_000,
        )
        const jitter = delay * RETRY_JITTER_FACTOR * Math.random()
        metrics.errors.push(`retry ${attempt + 1}: ${status ?? 'network'} (wait ${Math.round(delay + jitter)}ms)`)
        await new Promise(r => setTimeout(r, delay + jitter))
      }
    }

    throw new Error('[codex-adapter] Exhausted all retries')
  }

  private _isRetryableError(err: unknown, status?: number): boolean {
    if (status && RETRYABLE_STATUS_CODES.has(status)) return true
    const code = (err as Record<string, unknown>)?.code as string | undefined
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      return true
    }
    if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') {
      return true
    }
    return false
  }

  /**
   * 执行单次 API 请求（带超时）
   */
  private async _executeRequest(
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
    metrics?: TranslationMetrics,
  ): Promise<{
    data: AsyncIterable<Record<string, unknown>> & { controller: AbortController }
    response: Response
    request_id: string
  }> {
    // 1. 获取认证凭证
    const creds = this.config.credentials ?? await loadCodexCredentials()
    if (!creds) {
      throw new Error(
        '[codex-adapter] No credentials available. Set CODEX_API_KEY, OPENAI_API_KEY, or login via Codex CLI.',
      )
    }

    // 2. 转换请求参数（计时）
    const translateStart = Date.now()
    const isStreaming = params.stream !== false
    const openaiRequest = translateRequest(
      params as Parameters<typeof translateRequest>[0],
      this.config.model,
    )
    openaiRequest.stream = isStreaming
    if (metrics) {
      metrics.requestTranslateMs = Date.now() - translateStart
    }

    // 3. 构建请求 headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${creds.token}`,
    }

    if (creds.tokenType === 'oauth_access_token' && creds.accountId) {
      headers['ChatGPT-Account-ID'] = creds.accountId
    }

    if (isStreaming) {
      headers['Accept'] = 'text/event-stream'
    }

    const customHeaders = options?.headers as Record<string, string> | undefined
    if (customHeaders) {
      Object.assign(headers, customHeaders)
    }

    // 4. 构建请求 URL
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/responses`

    // 5. 构建 AbortSignal（组合上层 signal + 超时 signal）
    const externalSignal = options?.signal as AbortSignal | undefined
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`[codex-adapter] Request timeout after ${CODEX_REQUEST_TIMEOUT_MS}ms`))
    }, CODEX_REQUEST_TIMEOUT_MS)

    if (externalSignal) {
      externalSignal.addEventListener('abort', () => abortController.abort(externalSignal.reason), { once: true })
    }

    try {
      // 6. 发送请求
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiRequest),
        signal: abortController.signal,
      })

      // 7. 处理错误响应
      if (!response.ok) {
        let errorBody = ''
        try {
          errorBody = await response.text()
        } catch { /* ignore */ }

        // 解析错误 body 为结构化对象（withRetry 需要 error.message 字段）
        let errorObject: Record<string, unknown> | undefined
        try {
          errorObject = JSON.parse(errorBody) as Record<string, unknown>
        } catch {
          errorObject = errorBody ? { message: errorBody } : undefined
        }

        // 抛出 APIError 实例，使 withRetry 的 instanceof 检查通过
        // APIError 构造函数：constructor(status, error, message, headers)
        // headers 必须是 Headers 实例（withRetry 使用 .get() 方法）
        throw new APIError(
          response.status,
          errorObject,
          `[codex-adapter] API request failed: ${response.status} ${response.statusText}`,
          response.headers,
        )
      }

      // 8. 处理响应
      const requestId = response.headers.get('x-request-id')
        ?? response.headers.get('x-stainless-request-id')
        ?? `codex_${Date.now()}`

      if (isStreaming) {
        if (!response.body) {
          throw new Error('[codex-adapter] Streaming response has no body')
        }
        // 流式响应成功后清除超时（流的生命周期由上层管理）
        clearTimeout(timeoutId)
        const stream = createAnthropicCompatibleStream(response.body, abortController)
        return { data: stream, response, request_id: requestId }
      } else {
        const responseJson = await response.json()
        clearTimeout(timeoutId)
        const message = createAnthropicMessageFromResponse(responseJson as Record<string, unknown>)

        const fakeStream = {
          async *[Symbol.asyncIterator]() {
            const msg = message as Record<string, unknown>
            const content = (msg.content ?? []) as Array<Record<string, unknown>>

            yield { type: 'message_start', message: { ...msg, content: [] } }

            for (let i = 0; i < content.length; i++) {
              const block = content[i]
              yield { type: 'content_block_start', index: i, content_block: block }

              if (block.type === 'text') {
                yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }
              } else if (block.type === 'tool_use') {
                yield {
                  type: 'content_block_delta', index: i,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
                }
              } else if (block.type === 'thinking') {
                yield { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: block.thinking } }
              }

              yield { type: 'content_block_stop', index: i }
            }

            yield { type: 'message_delta', delta: { stop_reason: msg.stop_reason ?? 'end_turn', stop_sequence: null }, usage: msg.usage }
            yield { type: 'message_stop' }
          },
          controller: abortController,
        }
        return { data: fakeStream, response, request_id: requestId }
      }
    } catch (err) {
      clearTimeout(timeoutId)
      throw err
    }
  }

  // ==================== 遥测 ====================

  private _logMetrics(metrics: TranslationMetrics): void {
    // 仅在 verbose 模式下输出完整指标
    if (process.env.CLAUDE_CODE_VERBOSE !== '1' && !process.env.DEBUG?.includes('codex')) {
      return
    }
    const parts = [
      `translate=${metrics.requestTranslateMs}ms`,
      `total=${metrics.totalRequestMs}ms`,
      `retries=${metrics.retries}`,
    ]
    if (metrics.errors.length > 0) {
      parts.push(`errors=[${metrics.errors.join('; ')}]`)
    }
    console.debug(`[codex-metrics] ${parts.join(', ')}`)
  }
}

// ==================== 类型辅助 ====================

type PromiseWithResponse = Promise<unknown> & {
  withResponse: () => Promise<{
    data: AsyncIterable<Record<string, unknown>> & { controller: AbortController }
    response: Response
    request_id: string
  }>
}
