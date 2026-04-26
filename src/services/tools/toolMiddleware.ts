import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
} from '@opentelemetry/api'
import { getMeter, getStatsStore } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  sanitizeToolNameForAnalytics,
} from '../../services/analytics/metadata.js'
import type {
  AnyObject,
  Tool,
  ToolCallProgress,
  ToolProgressData,
  ToolResult,
  ToolUseContext,
} from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import type { AssistantMessage } from '../../types/message.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { AbortError, getErrnoCode } from '../../utils/errors.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getTelemetryAttributes } from '../../utils/telemetryAttributes.js'
import { getMaxToolUseConcurrency } from './toolConcurrency.js'

// 原生 TS 工具中间件层。它运行在 runPreToolUseHooks / runPostToolUseHooks
// 之间，只负责共享执行能力，不替换每个工具自己的 validate/checkPermissions。
const TOOL_RESULT_CACHE_MAX_ENTRIES = 128
const TOOL_RESULT_CACHE_TTL_MS = 2_000

type ToolExecutionResult = ToolResult<unknown>

export type ToolMiddlewareState = {
  cacheHit: boolean
  concurrencyWaitMs: number
}

export type ToolExecutionRequest<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  assistantMessage: AssistantMessage
  canUseTool: CanUseToolFn
  callInput: Input
  observableInput: Record<string, unknown>
  onProgress?: ToolCallProgress<ToolProgressData>
  tool: Tool<AnyObject, unknown, ToolProgressData>
  toolUseContext: ToolUseContext
  toolUseID: string
}

export type ToolExecutionMiddlewareContext<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = ToolExecutionRequest<Input> & {
  state: ToolMiddlewareState
}

type ToolExecutionNext = () => Promise<ToolExecutionResult>

export type ToolExecutionMiddleware = (
  context: ToolExecutionMiddlewareContext,
  next: ToolExecutionNext,
) => Promise<ToolExecutionResult>

type ToolMetricInstruments = {
  callCounter: Counter
  durationHistogram: Histogram
  errorCounter: Counter
  meter: Meter
}

type ToolResultCacheEntry = {
  expiresAt: number
  result: ToolExecutionResult
}

export class ToolExecutionResultCache {
  private readonly entries = new Map<string, ToolResultCacheEntry>()

  constructor(private readonly maxEntries: number) {}

  get(key: string, now: number): ToolExecutionResult | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: ToolExecutionResult, ttlMs: number, now: number) {
    this.entries.delete(key)
    this.entries.set(key, {
      result,
      expiresAt: now + ttlMs,
    })
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) {
        break
      }
      this.entries.delete(oldestKey)
    }
  }

  clear() {
    this.entries.clear()
  }
}

export class ToolExecutionSemaphore {
  private activeCount = 0
  private readonly waiters: Array<{
    onGrant: () => void
    onAbort?: () => void
  }> = []

  constructor(private readonly maxConcurrency: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new AbortError('Tool execution cancelled before acquiring slot')
    }

    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1
      return this.createRelease()
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        onGrant: () => {
          cleanup()
          this.activeCount += 1
          resolve(this.createRelease())
        },
        onAbort: () => {
          cleanup()
          reject(
            new AbortError('Tool execution cancelled while waiting for slot'),
          )
        },
      }

      const cleanup = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
        }
        if (signal && waiter.onAbort) {
          signal.removeEventListener('abort', waiter.onAbort)
        }
      }

      this.waiters.push(waiter)
      if (signal && waiter.onAbort) {
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.drain()
    }
  }

  private drain() {
    while (this.activeCount < this.maxConcurrency && this.waiters.length > 0) {
      const nextWaiter = this.waiters.shift()
      nextWaiter?.onGrant()
    }
  }
}

let cachedInstruments: ToolMetricInstruments | null = null

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

function getToolMetricInstruments(): ToolMetricInstruments | null {
  const meter = getMeter()
  if (!meter) {
    return null
  }
  if (cachedInstruments?.meter === meter) {
    return cachedInstruments
  }
  cachedInstruments = {
    meter,
    callCounter: meter.createCounter('claude_code.tool.middleware.calls', {
      description:
        'Count of tool middleware executions, tagged by result/call type',
    }),
    durationHistogram: meter.createHistogram(
      'claude_code.tool.middleware.duration',
      {
        description: 'Duration of tool middleware executions',
        unit: 'ms',
      },
    ),
    errorCounter: meter.createCounter('claude_code.tool.middleware.errors', {
      description: 'Count of tool middleware execution failures',
    }),
  }
  return cachedInstruments
}

function getBaseToolAttributes(
  context: ToolExecutionMiddlewareContext,
): Attributes {
  return {
    ...getTelemetryAttributes(),
    tool_name: sanitizeToolNameForAnalytics(context.tool.name),
    is_mcp: context.tool.isMcp ?? false,
    is_read_only: safeIsReadOnly(context),
  }
}

function getResultAttributes(
  context: ToolExecutionMiddlewareContext,
  result: 'success' | 'cache_hit' | 'error',
): Attributes {
  return {
    ...getBaseToolAttributes(context),
    result,
    cache_hit: context.state.cacheHit,
  }
}

function getErrorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError'
  }
  const errnoCode = getErrnoCode(error)
  if (errnoCode) {
    return `Error:${errnoCode}`
  }
  return error.name || 'Error'
}

function safeIsReadOnly(context: ToolExecutionMiddlewareContext): boolean {
  try {
    return Boolean(context.tool.isReadOnly(context.observableInput))
  } catch {
    return false
  }
}

function isCacheableTool(context: ToolExecutionMiddlewareContext): boolean {
  if (!safeIsReadOnly(context)) {
    return false
  }
  return (
    context.tool.name === FILE_READ_TOOL_NAME ||
    context.tool.name === GLOB_TOOL_NAME
  )
}

function buildToolCacheKey(context: ToolExecutionMiddlewareContext): string {
  let resolvedPath: string | undefined
  try {
    resolvedPath = context.tool.getPath?.(context.observableInput)
  } catch {
    resolvedPath = undefined
  }

  return `${context.tool.name}:${jsonStringify(
    sortKeysDeep({
      ...context.observableInput,
      ...(resolvedPath ? { __resolved_path: resolvedPath } : {}),
    }),
  )}`
}

let globalSemaphore:
  | {
      maxConcurrency: number
      semaphore: ToolExecutionSemaphore
    }
  | undefined

const globalResultCache = new ToolExecutionResultCache(
  TOOL_RESULT_CACHE_MAX_ENTRIES,
)

function getGlobalSemaphore(): ToolExecutionSemaphore {
  const maxConcurrency = getMaxToolUseConcurrency()
  if (
    !globalSemaphore ||
    globalSemaphore.maxConcurrency !== maxConcurrency
  ) {
    globalSemaphore = {
      maxConcurrency,
      semaphore: new ToolExecutionSemaphore(maxConcurrency),
    }
  }
  return globalSemaphore.semaphore
}

export function createMetricsMiddleware(): ToolExecutionMiddleware {
  return async (context, next) => {
    const startTime = Date.now()
    try {
      const result = await next()
      const durationMs = Date.now() - startTime
      const resultType = context.state.cacheHit ? 'cache_hit' : 'success'
      const attributes = getResultAttributes(context, resultType)
      const instruments = getToolMetricInstruments()
      instruments?.callCounter.add(1, attributes)
      instruments?.durationHistogram.record(durationMs, attributes)
      getStatsStore()?.observe('tool_middleware_duration_ms', durationMs)
      return result
    } catch (error) {
      const durationMs = Date.now() - startTime
      const attributes = {
        ...getResultAttributes(context, 'error'),
        error_kind: getErrorKind(error),
      }
      const instruments = getToolMetricInstruments()
      instruments?.callCounter.add(1, attributes)
      instruments?.errorCounter.add(1, attributes)
      instruments?.durationHistogram.record(durationMs, attributes)
      getStatsStore()?.observe('tool_middleware_duration_ms', durationMs)
      throw error
    }
  }
}

export function createAuditMiddleware(): ToolExecutionMiddleware {
  return async (context, next) => {
    const startTime = Date.now()
    const baseFields = {
      tool_name: sanitizeToolNameForAnalytics(context.tool.name),
      tool_use_id: context.toolUseID,
      is_mcp: context.tool.isMcp ?? false,
      is_read_only: safeIsReadOnly(context),
    }
    logForDiagnosticsNoPII('info', 'tool_middleware_start', baseFields)
    try {
      const result = await next()
      logForDiagnosticsNoPII('info', 'tool_middleware_complete', {
        ...baseFields,
        duration_ms: Date.now() - startTime,
        cache_hit: context.state.cacheHit,
        concurrency_wait_ms: context.state.concurrencyWaitMs,
      })
      return result
    } catch (error) {
      logForDiagnosticsNoPII('error', 'tool_middleware_failed', {
        ...baseFields,
        duration_ms: Date.now() - startTime,
        cache_hit: context.state.cacheHit,
        concurrency_wait_ms: context.state.concurrencyWaitMs,
        error_kind: getErrorKind(error),
      })
      throw error
    }
  }
}

export function createCachingMiddleware({
  cache = globalResultCache,
  now = () => Date.now(),
  ttlMs = TOOL_RESULT_CACHE_TTL_MS,
}: {
  cache?: ToolExecutionResultCache
  now?: () => number
  ttlMs?: number
} = {}): ToolExecutionMiddleware {
  return async (context, next) => {
    if (isCacheableTool(context)) {
      const key = buildToolCacheKey(context)
      const cachedResult = cache.get(key, now())
      if (cachedResult) {
        context.state.cacheHit = true
        logForDiagnosticsNoPII('info', 'tool_middleware_cache_hit', {
          tool_name: sanitizeToolNameForAnalytics(context.tool.name),
          tool_use_id: context.toolUseID,
          is_mcp: context.tool.isMcp ?? false,
        })
        return cachedResult
      }

      const result = await next()
      cache.set(key, result, ttlMs, now())
      return result
    }

    const result = await next()
    if (!safeIsReadOnly(context)) {
      cache.clear()
    }
    return result
  }
}

export function createConcurrencyMiddleware({
  getSemaphore = getGlobalSemaphore,
}: {
  getSemaphore?: () => ToolExecutionSemaphore
} = {}): ToolExecutionMiddleware {
  return async (context, next) => {
    const waitStart = Date.now()
    const release = await getSemaphore().acquire(
      context.toolUseContext.abortController.signal,
    )
    const waitMs = Date.now() - waitStart
    context.state.concurrencyWaitMs += waitMs
    if (waitMs > 0) {
      getStatsStore()?.observe('tool_middleware_concurrency_wait_ms', waitMs)
    }
    try {
      return await next()
    } finally {
      release()
    }
  }
}

const defaultMiddlewares: ToolExecutionMiddleware[] = [
  createMetricsMiddleware(),
  createAuditMiddleware(),
  createCachingMiddleware(),
  createConcurrencyMiddleware(),
]

export function getDefaultToolExecutionMiddlewares(): ToolExecutionMiddleware[] {
  return defaultMiddlewares
}

export async function executeToolMiddlewareChain(
  request: ToolExecutionRequest,
  middlewares: ToolExecutionMiddleware[] = getDefaultToolExecutionMiddlewares(),
): Promise<{
  result: ToolExecutionResult
  state: ToolMiddlewareState
}> {
  const context: ToolExecutionMiddlewareContext = {
    ...request,
    state: {
      cacheHit: false,
      concurrencyWaitMs: 0,
    },
  }

  let currentIndex = -1

  const dispatch = async (index: number): Promise<ToolExecutionResult> => {
    if (index <= currentIndex) {
      throw new Error('Tool middleware next() called multiple times')
    }
    currentIndex = index

    const middleware = middlewares[index]
    if (!middleware) {
      return request.tool.call(
        request.callInput,
        request.toolUseContext,
        request.canUseTool,
        request.assistantMessage,
        request.onProgress,
      )
    }

    return middleware(context, () => dispatch(index + 1))
  }

  return {
    result: await dispatch(0),
    state: context.state,
  }
}
