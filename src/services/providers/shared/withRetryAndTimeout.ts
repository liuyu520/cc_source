/**
 * 通用重试与超时包装器
 *
 * 为 Provider 的 API 请求提供统一的重试和超时策略。
 * 可复用于所有 Provider 的 fetch 调用。
 *
 * 策略：
 * - 超时：通过 AbortController 实现（不依赖 AbortSignal.timeout 兼容性）
 * - 重试：指数退避 + 抖动，仅重试可重试错误（5xx/429/网络错误）
 * - 上层 abort：外部 AbortSignal 联动内部 controller
 *
 * 举一反三：
 *   新 Provider 无需自己实现 retry/timeout，直接：
 *   ```
 *   const response = await fetchWithRetry(url, init, {
 *     maxRetries: 2,
 *     timeoutMs: 120000,
 *     externalSignal: options.signal,
 *   })
 *   ```
 */

export interface RetryConfig {
  maxRetries?: number
  timeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterFactor?: number
  externalSignal?: AbortSignal
  /** 自定义可重试判断（默认：5xx/429/网络错误） */
  isRetryable?: (err: unknown) => boolean
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529])
const RETRYABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'])

function defaultIsRetryable(err: unknown): boolean {
  const status = (err as Record<string, unknown>)?.status as number | undefined
  if (status && RETRYABLE_STATUS_CODES.has(status)) return true
  const code = (err as Record<string, unknown>)?.code as string | undefined
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true
  if ((err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError') return true
  return false
}

/**
 * 带重试和超时的 fetch 包装器
 *
 * @returns { response, controller } — controller 可用于后续流式请求的取消
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: RetryConfig = {},
): Promise<{ response: Response; controller: AbortController }> {
  const maxRetries = config.maxRetries ?? 2
  const timeoutMs = config.timeoutMs ?? 120_000
  const initialDelayMs = config.initialDelayMs ?? 1000
  const maxDelayMs = config.maxDelayMs ?? 30_000
  const jitterFactor = config.jitterFactor ?? 0.25
  const isRetryable = config.isRetryable ?? defaultIsRetryable

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const abortController = new AbortController()

    // 超时计时器
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    // 联动外部 signal
    if (config.externalSignal) {
      config.externalSignal.addEventListener(
        'abort',
        () => abortController.abort(config.externalSignal!.reason),
        { once: true },
      )
    }

    try {
      const response = await fetch(url, {
        ...init,
        signal: abortController.signal,
      })

      if (!response.ok) {
        clearTimeout(timeoutId)

        // 构建错误对象供 isRetryable 判断
        const error = new Error(`HTTP ${response.status}`) as Record<string, unknown>
        error.status = response.status

        if (isRetryable(error) && attempt < maxRetries) {
          const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs)
          const jitter = delay * jitterFactor * Math.random()
          await new Promise(r => setTimeout(r, delay + jitter))
          continue
        }

        // 不可重试或已用尽重试，返回错误 response 让调用方处理
        return { response, controller: abortController }
      }

      clearTimeout(timeoutId)
      return { response, controller: abortController }
    } catch (err) {
      clearTimeout(timeoutId)

      if (isRetryable(err) && attempt < maxRetries) {
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs)
        const jitter = delay * jitterFactor * Math.random()
        await new Promise(r => setTimeout(r, delay + jitter))
        continue
      }

      throw err
    }
  }

  throw new Error('fetchWithRetry: exhausted all retries')
}
