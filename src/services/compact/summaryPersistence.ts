/**
 * Summary persistence — save/load the latest compaction summary to disk so
 * subsequent compactions can do iterative updates (信息守恒) rather than
 * building a new summary from scratch every time.
 *
 * Ported from hermes-agent `context_compressor.py:380-422`.
 *
 * Storage location: <session-dir>/.compact-summary.md
 * The file lives next to the JSONL transcript so it's automatically scoped
 * to the current session and cleaned up with session GC.
 *
 * ENV gates:
 *   CLAUDE_CODE_ITERATIVE_SUMMARY=1  → enable (default OFF)
 *   CLAUDE_CODE_ITERATIVE_SUMMARY=shadow → read previous summary for logging
 *     but do NOT inject into the prompt (observe-only mode)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { logForDebugging } from '../../utils/debug.js'

type IterativeMode = 'off' | 'shadow' | 'on'

function getMode(): IterativeMode {
  const raw = (process.env.CLAUDE_CODE_ITERATIVE_SUMMARY ?? '').trim().toLowerCase()
  if (raw === 'shadow') return 'shadow'
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return 'on'
  return 'off'
}

export function isIterativeSummaryEnabled(): boolean {
  return getMode() !== 'off'
}

export function isIterativeSummaryPromoteEnabled(): boolean {
  return getMode() === 'on'
}

export function isIterativeSummaryShadowMode(): boolean {
  return getMode() === 'shadow'
}

/**
 * Derive the summary persistence path from the transcript path.
 * Returns null if the transcript path is not available (e.g. non-persistent
 * sessions or in-memory-only mode).
 */
function getSummaryPath(): string | null {
  try {
    const transcript = getTranscriptPath()
    if (!transcript) return null
    return join(dirname(transcript), '.compact-summary.md')
  } catch {
    return null
  }
}

/**
 * Save the latest compaction summary to disk. Called after a successful
 * compaction in both autoCompact and manual /compact paths.
 *
 * The persisted file uses a simple envelope with a timestamp header so we
 * can detect staleness (e.g. session was resumed after days).
 */
export function persistSummary(summary: string): void {
  if (!isIterativeSummaryEnabled()) return
  const path = getSummaryPath()
  if (!path) return
  try {
    const envelope = [
      `<!-- compact-summary persisted at ${new Date().toISOString()} -->`,
      summary,
    ].join('\n')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, envelope, 'utf-8')
    logForDebugging(
      `[summaryPersistence] wrote ${summary.length} chars to ${path}`,
    )
  } catch (e) {
    logForDebugging(
      `[summaryPersistence] write failed (ignored): ${(e as Error).message}`,
    )
  }
}

/**
 * Load the most recent persisted summary. Returns null if:
 *   - Feature is off
 *   - No persisted file exists
 *   - File is older than maxAgeSec (default 24h)
 *   - Read error
 *
 * The maxAgeSec guard prevents injecting a stale summary from a days-old
 * session that was resumed. Better to build from scratch than pollute with
 * irrelevant context.
 */
export function loadPreviousSummary(
  maxAgeSec: number = 24 * 3600,
): string | null {
  if (!isIterativeSummaryEnabled()) return null
  const path = getSummaryPath()
  if (!path || !existsSync(path)) return null
  try {
    const stat = statSync(path)
    const ageSec = (Date.now() - stat.mtimeMs) / 1000
    if (ageSec > maxAgeSec) {
      logForDebugging(
        `[summaryPersistence] stale summary (${Math.round(ageSec)}s old, max=${maxAgeSec}s), skipping`,
      )
      return null
    }
    const raw = readFileSync(path, 'utf-8')
    // Strip the envelope header (first line if it starts with <!--)
    const lines = raw.split('\n')
    const body = lines[0]?.startsWith('<!--')
      ? lines.slice(1).join('\n').trim()
      : raw.trim()
    if (!body) return null
    logForDebugging(
      `[summaryPersistence] loaded previous summary (${body.length} chars, ${Math.round(ageSec)}s old)`,
    )
    return body
  } catch (e) {
    logForDebugging(
      `[summaryPersistence] read failed (ignored): ${(e as Error).message}`,
    )
    return null
  }
}
