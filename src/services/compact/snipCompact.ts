/**
 * snipCompact — token-efficient layered compression for the live message
 * window. Originally a pass-through stub; now implements three-tier age-based
 * compression specifically for third-party APIs without prompt cache.
 *
 * Layers (counted from end of conversation):
 *   - "recent" (last RECENT_KEEP messages, ~3 turns): kept verbatim
 *   - "middle" (between recent and OLD_BOUNDARY): tool_result content
 *     truncated to head HEAD_KEEP_CHARS + length marker; tool_use input untouched
 *   - "old" (everything older): tool_result replaced with elision stub;
 *     tool_use input replaced with `{...}` placeholder
 *
 * After compression, toolPairSanitizer is invoked to repair any orphaned
 * tool_use/tool_result pairs (defensive — this implementation only edits
 * block content, never removes pairs, but sanitizer is idempotent).
 *
 * Gate (precedence high → low):
 *   1. CLAUDE_CODE_SNIP_LAYERED=0/false/no/off → force OFF (legacy stub)
 *   2. CLAUDE_CODE_SNIP_LAYERED=1/true/yes/on → force ON
 *   3. otherwise: ON for getAPIProvider() === 'thirdParty', OFF first-party
 *
 * Always returns { messages, changed, tokensFreed, boundaryMessage? } so
 * existing callers (query.ts:497, QueryEngine.ts:1281) don't need adapting.
 *
 * shadow scan path (CLAUDE_CODE_SNIP_SANITIZE_SHADOW=1) is preserved for
 * observability — still runs even when layered compression is off.
 */

import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { sanitizeToolPairs, hasChanges } from './toolPairSanitizer.js'
import { scoreMessages, decideCompressionLevel } from './importanceScoring.js'
import { summarizeToolResult, findToolNameForResult } from './localSummary.js'

// 各层边界（按消息索引从末尾倒数）。3 轮 ≈ 6 条消息（user+assistant 成对）。
const RECENT_KEEP = 6
// "middle" 与 "old" 之间的边界：超过这个数量的"较老"消息进入重压缩。
// 20 条 ≈ 10 轮历史，与方法论文档中"3-10 轮 / 10+ 轮"两档划分一致。
const OLD_BOUNDARY = 20
// 中间层 tool_result 截留头部字符数（保留前 200 字 + "[+N truncated]" 标记）。
const HEAD_KEEP_CHARS = 200
// 老层占位文本（与 toolPairSanitizer.STUB_RESULT_TEXT 风格一致）。
const OLD_RESULT_STUB = '[old tool_result elided to save tokens]'
const OLD_USE_INPUT_STUB = '{...elided...}'
// 智能压缩模式下，middle 层的 tool_result 最大 token 预算
const MIDDLE_TOOL_RESULT_MAX_TOKENS = 150
// 是否启用基于重要性评分的智能压缩（默认在第三方 API 上启用）
function isSmartCompressionEnabled(): boolean {
  const flag = readEnvFlag('CLAUDE_CODE_SMART_COMPRESSION')
  if (flag === 'off') return false
  if (flag === 'on') return true
  return isLayeredEnabled()
}

type SnipResult<T> = {
  messages: T
  changed: boolean
  tokensFreed: number
  boundaryMessage?: unknown
}

type SnipOptions = { force?: boolean }

type ContentBlock = {
  type?: string
  id?: string
  tool_use_id?: string
  content?: unknown
  input?: unknown
  text?: string
  [key: string]: unknown
}

type MessageLike = {
  type?: string
  message?: { content?: unknown; [k: string]: unknown }
  [k: string]: unknown
}

function readEnvFlag(name: string): 'on' | 'off' | 'unset' {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return 'unset'
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return 'off'
  return 'on'
}

function isLayeredEnabled(): boolean {
  const flag = readEnvFlag('CLAUDE_CODE_SNIP_LAYERED')
  if (flag === 'off') return false
  if (flag === 'on') return true
  // 默认：第三方 API 启用，first-party 关闭（保留 cache 友好的 stub 行为）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAPIProvider } = require('../../utils/model/providers.js') as {
      getAPIProvider: () => string
    }
    return getAPIProvider() === 'thirdParty'
  } catch {
    return false
  }
}

function approxChars(content: unknown): number {
  if (content == null) return 0
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    let total = 0
    for (const item of content) total += approxChars(item)
    return total
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content).length
    } catch {
      return 0
    }
  }
  return String(content).length
}

/**
 * Truncate a tool_result content payload. Handles:
 *   - string: head HEAD_KEEP_CHARS + marker
 *   - array of {type:'text', text} blocks: only truncate text inside each
 *   - other shapes (image, etc.): pass through untouched
 */
function truncateMiddleResult(content: unknown): { content: unknown; freed: number } {
  if (typeof content === 'string') {
    if (content.length <= HEAD_KEEP_CHARS) {
      return { content, freed: 0 }
    }
    const head = content.slice(0, HEAD_KEEP_CHARS)
    const marker = `\n[+${content.length - HEAD_KEEP_CHARS} chars truncated by snipCompact]`
    return { content: head + marker, freed: content.length - head.length - marker.length }
  }
  if (Array.isArray(content)) {
    let totalFreed = 0
    const next: unknown[] = []
    for (const blk of content) {
      if (
        blk &&
        typeof blk === 'object' &&
        (blk as ContentBlock).type === 'text' &&
        typeof (blk as ContentBlock).text === 'string'
      ) {
        const text = (blk as ContentBlock).text as string
        if (text.length <= HEAD_KEEP_CHARS) {
          next.push(blk)
          continue
        }
        const head = text.slice(0, HEAD_KEEP_CHARS)
        const marker = `\n[+${text.length - HEAD_KEEP_CHARS} chars truncated by snipCompact]`
        next.push({ ...(blk as ContentBlock), text: head + marker })
        totalFreed += text.length - head.length - marker.length
      } else {
        next.push(blk)
      }
    }
    return { content: next, freed: totalFreed }
  }
  return { content, freed: 0 }
}

/**
 * Compress a single tool_result block to the OLD layer (full elision).
 * Preserves tool_use_id and is_error for API validity.
 */
function elideOldResult(block: ContentBlock): { block: ContentBlock; freed: number } {
  const beforeChars = approxChars(block.content)
  const next: ContentBlock = {
    ...block,
    content: OLD_RESULT_STUB,
  }
  const afterChars = OLD_RESULT_STUB.length
  return { block: next, freed: Math.max(0, beforeChars - afterChars) }
}

/**
 * Compress a single tool_use block to the OLD layer (input → "{...elided...}").
 * Keeps id + name so subsequent tool_result still pairs cleanly. Skipped if
 * input already small (< 80 chars serialized) — would inflate, not compress.
 */
function elideOldToolUse(block: ContentBlock): { block: ContentBlock; freed: number } {
  const beforeChars = approxChars(block.input)
  if (beforeChars < 80) return { block, freed: 0 }
  const next: ContentBlock = {
    ...block,
    input: { _elided: OLD_USE_INPUT_STUB, _originalChars: beforeChars },
  }
  const afterChars = approxChars(next.input)
  return { block: next, freed: Math.max(0, beforeChars - afterChars) }
}

/**
 * Apply layered compression to a single message. Returns rebuilt message +
 * chars freed. age = total - index (1-based from end). 'recent' age <= RECENT_KEEP.
 *
 * 当启用智能压缩时，compressionLevel 来自 importanceScoring 模块
 * 而非纯粹的 age 阈值。
 */
function compressMessage(
  msg: MessageLike,
  age: number,
  compressionLevel?: 'keep' | 'light' | 'heavy' | 'elide',
  allMessages?: readonly unknown[],
): { msg: MessageLike; freed: number } {
  // 'keep' 或最近消息：不压缩
  if (compressionLevel === 'keep' || (!compressionLevel && age <= RECENT_KEEP)) {
    return { msg, freed: 0 }
  }
  const content = msg.message?.content
  if (!Array.isArray(content)) return { msg, freed: 0 }

  // 决定压缩层级：智能模式用 compressionLevel，传统模式用 age 阈值
  const effectiveLevel = compressionLevel
    || (age > OLD_BOUNDARY ? 'elide' : 'light')

  let totalFreed = 0
  const nextContent: ContentBlock[] = []
  for (const blk of content as ContentBlock[]) {
    if (!blk || typeof blk !== 'object') {
      nextContent.push(blk)
      continue
    }
    if (blk.type === 'tool_result') {
      if (effectiveLevel === 'elide') {
        const r = elideOldResult(blk)
        nextContent.push(r.block)
        totalFreed += r.freed
      } else if (effectiveLevel === 'heavy' && allMessages) {
        // 重度压缩：使用智能摘要而非简单截断
        const toolName = findToolNameForResult(blk.tool_use_id || '', allMessages)
        const r = summarizeToolResult(blk.content, toolName, MIDDLE_TOOL_RESULT_MAX_TOKENS)
        if (r.freed > 0) {
          nextContent.push({ ...blk, content: r.content })
          totalFreed += r.freed
        } else {
          nextContent.push(blk)
        }
      } else {
        // 轻度压缩：传统截断
        const r = truncateMiddleResult(blk.content)
        if (r.freed > 0) {
          nextContent.push({ ...blk, content: r.content })
          totalFreed += r.freed
        } else {
          nextContent.push(blk)
        }
      }
    } else if (blk.type === 'tool_use' && effectiveLevel === 'elide') {
      const r = elideOldToolUse(blk)
      nextContent.push(r.block)
      totalFreed += r.freed
    } else {
      nextContent.push(blk)
    }
  }
  if (totalFreed === 0) return { msg, freed: 0 }
  const rebuilt: MessageLike = {
    ...msg,
    message: { ...(msg.message ?? {}), content: nextContent },
  }
  return { msg: rebuilt, freed: totalFreed }
}

export function snipCompactIfNeeded<T>(
  messages: T,
  options?: SnipOptions,
): SnipResult<T> {
  // 防御：非数组直通（例如 QueryEngine 传入的 store 形态可能不同）。
  if (!Array.isArray(messages)) {
    return { messages, changed: false, tokensFreed: 0 }
  }

  // shadow 模式保留：仅做 sanitizer 观测，不修改消息（与原 stub 行为一致）。
  // 与 layered 完全独立，可同时打开。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SNIP_SANITIZE_SHADOW)) {
    try {
      const { changes } = sanitizeToolPairs(messages as never)
      if (hasChanges(changes)) {
        logForDebugging(
          `[tool-pair-sanitizer] snipCompact shadow: orphanedResults=${changes.orphanedResults} orphanedCalls=${changes.orphanedCalls} emptyMsgsRemoved=${changes.emptyMessagesRemoved} stubsInserted=${changes.stubsInserted} (observe only)`,
        )
      }
    } catch {
      /* shadow scan must never throw */
    }
  }

  if (!isLayeredEnabled()) {
    return { messages, changed: false, tokensFreed: 0 }
  }

  const force = !!options?.force
  // 太短不压缩：避免对刚启动的会话做无意义工作。
  // recent 6 + 至少 4 条进入 middle，才有压缩收益。
  if (!force && messages.length <= RECENT_KEEP + 4) {
    return { messages, changed: false, tokensFreed: 0 }
  }

  const total = messages.length
  let totalFreed = 0
  let anyChanged = false
  const next: MessageLike[] = new Array(total)

  // 智能压缩模式：使用重要性评分决定压缩层级
  const useSmartCompression = isSmartCompressionEnabled()
  let importanceScores: ReturnType<typeof scoreMessages> | null = null
  if (useSmartCompression) {
    try {
      importanceScores = scoreMessages(messages)
    } catch (e) {
      logForDebugging(`[snipCompact] importance scoring failed, falling back to age-based: ${(e as Error).message}`)
    }
  }

  for (let i = 0; i < total; i++) {
    const age = total - i // 1-based from end (last = 1)
    const msg = messages[i] as MessageLike

    // 智能模式：根据重要性决定压缩层级
    let compressionLevel: 'keep' | 'light' | 'heavy' | 'elide' | undefined
    if (importanceScores && importanceScores[i]) {
      compressionLevel = decideCompressionLevel(importanceScores[i], age, RECENT_KEEP)
    }

    const { msg: rebuilt, freed } = compressMessage(msg, age, compressionLevel, messages)
    next[i] = rebuilt
    if (freed > 0) {
      totalFreed += freed
      anyChanged = true
    }
  }

  if (!anyChanged) {
    return { messages, changed: false, tokensFreed: 0 }
  }

  // 防御：层级压缩理论上不破坏 tool_use/tool_result 配对，但调用 sanitizer
  // 兜底任何边界异常（idempotent，无改动时零开销）。
  let finalMessages: MessageLike[] = next
  try {
    const sanitized = sanitizeToolPairs(next as never)
    finalMessages = sanitized.messages as unknown as MessageLike[]
  } catch (e) {
    logForDebugging(
      `[snipCompact] sanitizer failed, returning unsanitized layered output: ${(e as Error).message}`,
    )
  }

  // 估算 token 节省：4 chars ≈ 1 token（粗略）。
  const tokensFreed = Math.round(totalFreed / 4)
  logForDebugging(
    `[snipCompact] layered compress: ${total} msgs, ~${totalFreed} chars freed (~${tokensFreed} tokens), force=${force}`,
  )

  return {
    messages: finalMessages as unknown as T,
    changed: true,
    tokensFreed,
  }
}

// ---- 兼容性 stub 导出 ----
// 以下函数/常量被 Message.tsx, messages.ts, attachments.ts 通过
// require('snipCompact.js') 引用。原 stub 全部返回 false/空值，
// 新实现保持一致——这些是 HISTORY_SNIP feature flag 下的 ant-only 能力，
// 第三方 API 用户永远不会走到 true 分支。

/** Message.tsx:254 — 判断消息是否是 snip 标记 */
export function isSnipMarkerMessage(): boolean {
  return false
}

/** messages.ts:2354/2424, attachments.ts:4064 — snip 功能运行时是否激活 */
export function isSnipRuntimeEnabled(): boolean {
  return false
}

/** messages.ts:4188 — snip 上下文效率提示文本 */
export const SNIP_NUDGE_TEXT = ''

/** attachments.ts:4071 — 是否应该对当前消息集注入 snip 提示 */
export function shouldNudgeForSnips(): boolean {
  return false
}
