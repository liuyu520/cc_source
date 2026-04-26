/**
 * Frozen Snapshot Memory — stabilize session memory content for prompt cache.
 *
 * Ported from hermes-agent `session_memory.py:148-196`.
 *
 * Problem: session memory is re-extracted every N turns. Each extraction
 * changes the content → system prompt changes → prompt cache misses.
 * Anthropic's prompt cache has a 5-minute TTL. If a session does 3 turns
 * inside that window but the memory file changed between turns 1 and 2,
 * turns 2 & 3 both miss cache = wasted money.
 *
 * Solution: after each extraction, "freeze" the content. All reads within
 * the same cache window return the frozen bytes. On the next extraction
 * (or compaction), the snapshot thaws and re-freezes with the new content.
 *
 * ENV gate:
 *   CLAUDE_CODE_FROZEN_MEMORY=1  → enable (default OFF)
 *   CLAUDE_CODE_FROZEN_MEMORY=shadow → freeze + log delta, but still return
 *     live content (observe cache-miss frequency without changing behaviour)
 */

import { logForDebugging } from '../../utils/debug.js'

type FrozenMode = 'off' | 'shadow' | 'on'

let frozenContent: string | null = null
let frozenAt: number = 0
let freezeCount = 0

function getMode(): FrozenMode {
  const raw = (process.env.CLAUDE_CODE_FROZEN_MEMORY ?? '').trim().toLowerCase()
  if (raw === 'shadow') return 'shadow'
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return 'on'
  return 'off'
}

export function isFrozenMemoryEnabled(): boolean {
  return getMode() !== 'off'
}

/**
 * Freeze the current memory content. Called after each successful
 * session memory extraction. Replaces any previous frozen snapshot.
 */
export function freezeSnapshot(content: string | null): void {
  if (!isFrozenMemoryEnabled()) return
  frozenContent = content
  frozenAt = Date.now()
  freezeCount++
  logForDebugging(
    `[frozenSnapshot] frozen (#${freezeCount}, ${content?.length ?? 0} chars)`,
  )
}

/**
 * Thaw (invalidate) the frozen snapshot. Called before compaction so the
 * compaction prompt sees the latest memory, and after compaction so the
 * next turn re-freezes with fresh content.
 */
export function thawSnapshot(): void {
  if (frozenContent !== null) {
    logForDebugging('[frozenSnapshot] thawed')
  }
  frozenContent = null
  frozenAt = 0
}

/**
 * Read the frozen snapshot if available, otherwise return null (caller
 * falls through to reading from disk). The shadow mode logs a diff but
 * still returns null so the live path is taken.
 *
 * @param liveContent - the freshly-read-from-disk content (passed by
 *   the caller so shadow mode can compute the delta without reading again)
 */
export function readFrozenOrNull(liveContent: string | null): string | null {
  const mode = getMode()
  if (mode === 'off') return null
  if (frozenContent === null) return null

  if (mode === 'shadow') {
    // Observe only: log whether the frozen snapshot differs from live.
    const delta = (liveContent?.length ?? 0) - (frozenContent?.length ?? 0)
    const changed = liveContent !== frozenContent
    if (changed) {
      logForDebugging(
        `[frozenSnapshot] shadow: frozen content differs from live (delta=${delta > 0 ? '+' : ''}${delta} chars, age=${Math.round((Date.now() - frozenAt) / 1000)}s)`,
      )
    }
    return null // shadow → still serve live content
  }

  // mode === 'on': return frozen content
  return frozenContent
}

/**
 * Get diagnostic info for debugging/telemetry.
 */
export function getFrozenSnapshotStats(): {
  mode: FrozenMode
  hasFrozen: boolean
  frozenAgeMs: number
  freezeCount: number
} {
  return {
    mode: getMode(),
    hasFrozen: frozenContent !== null,
    frozenAgeMs: frozenAt > 0 ? Date.now() - frozenAt : 0,
    freezeCount,
  }
}
