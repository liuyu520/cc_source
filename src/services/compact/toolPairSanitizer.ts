/**
 * Tool-Pair Sanitizer — universal defense against orphaned tool_use / tool_result
 * blocks after any compaction step (autoCompact, contextCollapse, snipCompact, etc).
 *
 * Ported from hermes-agent `context_compressor.py:506-562`. The only existing
 * defense in claude-code is `adjustIndexToPreserveAPIInvariants` in
 * `sessionMemoryCompact.ts`, which runs BEFORE slicing. This module runs AFTER
 * slicing on already-compressed message arrays and repairs any remaining
 * orphans by either dropping blocks or inserting a stub "result-from-summary"
 * block. Result is idempotent — running twice is a no-op on already-clean data.
 *
 * Goals:
 *   1. Provider API never rejects a compacted session due to dangling tool pairs.
 *   2. Preserve order and identity of all non-orphaned blocks.
 *   3. Report exactly what was changed so callers can log metrics.
 */

import type { Message } from '../../types/message.js'

export type SanitizationReport = {
  orphanedResults: number // tool_result with no matching tool_use
  orphanedCalls: number // tool_use with no matching tool_result
  emptyMessagesRemoved: number // user messages whose content became empty
  stubsInserted: number // synthesized tool_result stubs for orphaned calls
}

export type SanitizationResult = {
  messages: Message[]
  changes: SanitizationReport
}

type ContentBlock = {
  type?: string
  id?: string
  tool_use_id?: string
  [key: string]: unknown
}

/**
 * Stub text inserted as a tool_result for orphaned tool_use blocks. The
 * wording mirrors hermes-agent so the LLM recognizes it as summarized context.
 */
const STUB_RESULT_TEXT =
  '[Result from earlier conversation — see summary above]'

function isArrayContent(content: unknown): content is ContentBlock[] {
  return Array.isArray(content)
}

function collectToolUseIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!isArrayContent(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') {
        ids.add(block.id)
      }
    }
  }
  return ids
}

function collectToolResultIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!isArrayContent(content)) continue
    for (const block of content) {
      if (
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        ids.add(block.tool_use_id)
      }
    }
  }
  return ids
}

/**
 * Remove orphaned tool_result blocks from user messages. If a user message's
 * content becomes empty after removal (i.e. it held ONLY orphan results), the
 * whole message is dropped. Text/image/other blocks are untouched.
 */
function stripOrphanedResults(
  messages: Message[],
  validToolUseIds: Set<string>,
  report: SanitizationReport,
): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    if (msg.type !== 'user') {
      out.push(msg)
      continue
    }
    const content = msg.message?.content
    if (!isArrayContent(content)) {
      out.push(msg)
      continue
    }
    const filtered: ContentBlock[] = []
    for (const block of content) {
      if (
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !validToolUseIds.has(block.tool_use_id)
      ) {
        report.orphanedResults++
        continue // drop orphan
      }
      filtered.push(block)
    }
    if (filtered.length === 0) {
      // Message held only orphan tool_results — remove entire message.
      report.emptyMessagesRemoved++
      continue
    }
    // Rebuild message with filtered content; preserve all other fields.
    const rebuilt: Message = {
      ...msg,
      message: { ...msg.message, content: filtered },
    } as Message
    out.push(rebuilt)
  }
  return out
}

/**
 * Insert stub tool_result blocks immediately after assistant messages that
 * contain orphaned tool_use blocks (i.e. no matching tool_result anywhere
 * after them). The stub tells the model the call was answered earlier and
 * content was compressed into the summary.
 */
function insertStubResults(
  messages: Message[],
  validToolResultIds: Set<string>,
  report: SanitizationReport,
): Message[] {
  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    out.push(msg)
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!isArrayContent(content)) continue

    const orphanIds: string[] = []
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        !validToolResultIds.has(block.id)
      ) {
        orphanIds.push(block.id)
      }
    }
    if (orphanIds.length === 0) continue

    // Check if the very next message is a user message we can append to.
    const next = messages[i + 1]
    const stubBlocks: ContentBlock[] = orphanIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: STUB_RESULT_TEXT,
      is_error: false,
    }))
    report.orphanedCalls += orphanIds.length
    report.stubsInserted += orphanIds.length

    if (
      next &&
      next.type === 'user' &&
      isArrayContent(next.message?.content)
    ) {
      // Prepend stubs to the next user message so ordering stays tight.
      const merged: ContentBlock[] = [
        ...stubBlocks,
        ...(next.message.content as ContentBlock[]),
      ]
      const rebuilt: Message = {
        ...next,
        message: { ...next.message, content: merged },
      } as Message
      out.push(rebuilt)
      i++ // skip original next
    } else {
      // Inject a synthetic user message holding only the stubs.
      const synthetic: Message = {
        type: 'user',
        isVirtual: true,
        message: {
          role: 'user',
          content: stubBlocks,
        },
      } as unknown as Message
      out.push(synthetic)
    }
  }
  return out
}

/**
 * Main entry point — sanitize all tool_use / tool_result pairs in a message
 * array. Two-pass algorithm:
 *   Pass 1 — drop orphaned tool_result blocks (result without call)
 *   Pass 2 — insert stub results for orphaned tool_use blocks (call without result)
 * The order matters: dropping fake results first shrinks the valid-id set so
 * stubs are inserted where truly needed, and it also avoids the degenerate
 * case of "stubbing for a call that already had a bogus orphan result".
 */
export function sanitizeToolPairs(messages: Message[]): SanitizationResult {
  const report: SanitizationReport = {
    orphanedResults: 0,
    orphanedCalls: 0,
    emptyMessagesRemoved: 0,
    stubsInserted: 0,
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages ?? [], changes: report }
  }

  // Pass 1: gather all valid tool_use ids and drop orphan results.
  const toolUseIds = collectToolUseIds(messages)
  const afterDrop = stripOrphanedResults(messages, toolUseIds, report)

  // Pass 2: gather all valid tool_result ids (after drop) and stub orphan calls.
  const toolResultIds = collectToolResultIds(afterDrop)
  const afterStub = insertStubResults(afterDrop, toolResultIds, report)

  return { messages: afterStub, changes: report }
}

/**
 * Align a boundary index backward so the cut does not land between a
 * tool_use and its matching tool_result. Returns a (potentially earlier)
 * index safe for slicing `messages.slice(0, idx)`.
 *
 * If the slice would leave a user message containing tool_result blocks
 * whose tool_use lives at or after idx, we push idx backward past the user
 * message. Symmetric to Anthropic's API invariant: every tool_result must
 * have a preceding tool_use in the same conversation slice.
 */
export function alignBoundaryBackward(
  messages: Message[],
  idx: number,
): number {
  if (idx <= 0 || idx > messages.length) return Math.max(0, Math.min(idx, messages.length))
  let boundary = idx
  // Walk backward while the immediately-preceding message is a user message
  // whose tool_result references a tool_use living AT-OR-AFTER boundary.
  while (boundary > 0) {
    const prev = messages[boundary - 1]!
    if (prev.type !== 'user') break
    const content = prev.message?.content
    if (!isArrayContent(content)) break
    const hasDanglingResult = content.some(
      block =>
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !hasPrecedingToolUse(
          messages.slice(0, boundary - 1),
          block.tool_use_id,
        ),
    )
    if (!hasDanglingResult) break
    boundary--
  }
  return boundary
}

/**
 * Align a boundary index forward so the cut does not land between an
 * assistant tool_use and its matching tool_result. Safe for slicing
 * `messages.slice(idx)`.
 */
export function alignBoundaryForward(
  messages: Message[],
  idx: number,
): number {
  if (idx <= 0 || idx >= messages.length) return Math.max(0, Math.min(idx, messages.length))
  let boundary = idx
  // If the message at boundary is a user message holding tool_results whose
  // tool_use lives BEFORE boundary, we cannot split there — advance past it.
  while (boundary < messages.length) {
    const here = messages[boundary]!
    if (here.type !== 'user') break
    const content = here.message?.content
    if (!isArrayContent(content)) break
    const hasDanglingResult = content.some(
      block =>
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        hasPrecedingToolUse(messages.slice(0, boundary), block.tool_use_id),
    )
    if (!hasDanglingResult) break
    boundary++
  }
  return boundary
}

function hasPrecedingToolUse(slice: Message[], id: string): boolean {
  for (const msg of slice) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!isArrayContent(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_use' && block.id === id) return true
    }
  }
  return false
}

/**
 * True if any non-zero sanitization actions were taken. Convenient for
 * shadow-mode logging where we only want to surface meaningful deltas.
 */
export function hasChanges(report: SanitizationReport): boolean {
  return (
    report.orphanedResults > 0 ||
    report.orphanedCalls > 0 ||
    report.emptyMessagesRemoved > 0 ||
    report.stubsInserted > 0
  )
}
