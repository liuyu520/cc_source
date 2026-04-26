/**
 * Provider 共享基础设施
 *
 * 新 Provider 接入时可直接导入这些工具，避免重复实现：
 *
 * import {
 *   parseSSE,              // SSE 字节流 → 事件
 *   createFakeStream,      // 非流式 Message → 流式事件序列
 *   translateHttpError,    // HTTP status → StandardApiError
 *   fetchWithRetry,        // 带重试+超时的 fetch
 * } from '../shared/index.js'
 *
 * 新 Provider 最小实现只需：
 *   index.ts     — detect() + createClient() + capabilityDeclaration  (~50 行)
 *   translator/  — 该 Provider 的消息格式特殊处理  (~130 行)
 */

export { parseSSE, parseSSEEventData, type ParsedSSEEvent } from './sseParser.js'
export { createFakeStream } from './fakeStream.js'
export {
  translateHttpError,
  defaultServerError,
  extractHttpStatus,
  extractNetworkCode,
} from './translateErrorBase.js'
export { fetchWithRetry, type RetryConfig } from './withRetryAndTimeout.js'
