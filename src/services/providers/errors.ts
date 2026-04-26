/**
 * 错误翻译工具 (P0-2) — 供各 provider 实现复用。
 *
 * 把 Anthropic SDK 原生 APIError / 网络错误 / provider 特有错误码
 * 统一映射为 StandardApiError。withRetry 只根据标准码决策重试、
 * backup-api 切换等。
 */

import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { StandardApiError, type ProviderId, type StandardErrorCode } from './types.js'

/**
 * 通用 HTTP status → StandardErrorCode 映射。
 * 各 provider 可在此基础上叠加自家错误码的特判。
 */
export function translateHttpStatus(
  status: number | undefined,
): { code: StandardErrorCode; retryable: boolean } | null {
  if (status === undefined) return null
  if (status === 401 || status === 403)
    return { code: 'auth', retryable: false }
  if (status === 429) return { code: 'rate_limit', retryable: true }
  if (status === 529) return { code: 'overloaded', retryable: true }
  if (status >= 500) return { code: 'server', retryable: true }
  if (status === 413) return { code: 'context_length', retryable: false }
  if (status >= 400) return { code: 'bad_request', retryable: false }
  return null
}

/** 通用翻译器 — 大多数 provider 可直接使用 */
export function translateAnthropicSdkError(
  err: unknown,
  providerId: ProviderId,
): StandardApiError {
  if (err instanceof StandardApiError) return err

  if (err instanceof APIConnectionError) {
    return new StandardApiError('network', true, providerId, err)
  }

  if (err instanceof APIError) {
    const mapped = translateHttpStatus(err.status)
    if (mapped) {
      return new StandardApiError(mapped.code, mapped.retryable, providerId, err)
    }
    return new StandardApiError('server', true, providerId, err)
  }

  // 未知错误按 server 可重试处理
  return new StandardApiError('server', true, providerId, err)
}

/**
 * 配额/余额类错误识别 — 对应 MiniMax 等第三方 "You've hit your limit"、
 * "insufficient balance"、特定错误码(如 10006) 的场景。
 *
 * 当前 withRetry.ts 依赖字符串匹配 "You've hit your limit" 触发 backup-api 切换。
 * 本函数把这类启发式集中到一处，未来可扩展更多 provider。
 */
export function looksLikeQuotaExceeded(err: unknown): boolean {
  if (!err) return false
  const anyErr = err as { message?: string; error?: { code?: number | string } }
  const msg = String(anyErr.message ?? '')
  if (msg.includes("You've hit your limit")) return true
  if (msg.toLowerCase().includes('insufficient balance')) return true
  if (msg.toLowerCase().includes('quota exceeded')) return true
  const code = anyErr.error?.code
  if (code === 10006 || code === '10006') return true
  return false
}
