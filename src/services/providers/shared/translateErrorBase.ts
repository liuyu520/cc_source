/**
 * 通用 HTTP 错误翻译器
 *
 * 将 HTTP status code 和网络错误码映射为 StandardApiError。
 * 可复用于所有 Provider 的 translateError() 方法，
 * 各 Provider 只需在基础之上添加自己的特殊处理。
 *
 * 举一反三：
 *   新 Provider 的 translateError 只需 3 行：
 *   ```
 *   translateError(err: unknown): StandardApiError {
 *     return translateHttpError(err, 'myProvider') ?? defaultServerError(err, 'myProvider')
 *   }
 *   ```
 */

import { StandardApiError } from '../types.js'
import type { ProviderId, StandardErrorCode } from '../types.js'

/**
 * 从错误对象中提取 HTTP status code
 */
export function extractHttpStatus(err: unknown): number | undefined {
  const e = err as Record<string, unknown>
  const status = e?.status ?? e?.statusCode
  return typeof status === 'number' ? status : undefined
}

/**
 * 从错误对象中提取网络错误码
 */
export function extractNetworkCode(err: unknown): string | undefined {
  const code = (err as Record<string, unknown>)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 将 HTTP status 翻译为 StandardApiError
 * @returns 翻译后的错误，无法识别返回 null
 */
export function translateHttpError(
  err: unknown,
  providerId: ProviderId,
): StandardApiError | null {
  const status = extractHttpStatus(err)

  if (typeof status === 'number') {
    const mapping: Record<number, { code: StandardErrorCode; retryable: boolean }> = {
      401: { code: 'auth', retryable: false },
      403: { code: 'auth', retryable: false },
      429: { code: 'rate_limit', retryable: true },
      500: { code: 'server', retryable: true },
      502: { code: 'server', retryable: true },
      503: { code: 'server', retryable: true },
      529: { code: 'overloaded', retryable: true },
    }

    const match = mapping[status]
    if (match) {
      return new StandardApiError(match.code, match.retryable, providerId, err,
        `[${providerId}] HTTP ${status}`)
    }

    if (status === 400) {
      const msg = String((err as Error)?.message ?? '')
      if (msg.includes('context_length') || msg.includes('max_tokens')) {
        return new StandardApiError('context_length', false, providerId, err)
      }
      return new StandardApiError('bad_request', false, providerId, err)
    }

    if (status >= 400 && status < 500) {
      return new StandardApiError('bad_request', false, providerId, err)
    }

    if (status >= 500) {
      return new StandardApiError('server', true, providerId, err)
    }
  }

  // 网络错误
  const code = extractNetworkCode(err)
  const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'])
  if (code && networkCodes.has(code)) {
    return new StandardApiError('network', true, providerId, err,
      `[${providerId}] Network error: ${code}`)
  }

  return null
}

/**
 * 默认的兜底 Server Error
 */
export function defaultServerError(
  err: unknown,
  providerId: ProviderId,
): StandardApiError {
  return new StandardApiError('server', true, providerId, err)
}
