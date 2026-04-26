/**
 * sessionFTS/indexer.ts — index session metadata into the FTS5 table.
 *
 * Called from bootstrap (lazy, background) to populate the index from
 * existing JSONL transcripts. Also called incrementally after each
 * session ends or after session memory extraction.
 */

import { getDb, isSessionFTSEnabled } from './db.js'
import { logForDebugging } from '../../utils/debug.js'

export interface SessionRecord {
  sessionId: string
  projectDir: string
  title?: string | null
  summary?: string | null
  firstPrompt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  messageCount?: number
}

/**
 * Upsert a single session into the FTS index. Idempotent — safe to call
 * repeatedly with the same session_id (UPDATE ON CONFLICT).
 */
export function indexSession(record: SessionRecord): void {
  if (!isSessionFTSEnabled()) return
  try {
    const db = getDb()
    db.exec(`
      INSERT INTO sessions (session_id, project_dir, title, summary, first_prompt, created_at, updated_at, message_count)
      VALUES ($sessionId, $projectDir, $title, $summary, $firstPrompt, $createdAt, $updatedAt, $messageCount)
      ON CONFLICT(session_id) DO UPDATE SET
        title = COALESCE($title, title),
        summary = COALESCE($summary, summary),
        first_prompt = COALESCE($firstPrompt, first_prompt),
        updated_at = COALESCE($updatedAt, updated_at),
        message_count = COALESCE($messageCount, message_count)
    `, {
      $sessionId: record.sessionId,
      $projectDir: record.projectDir,
      $title: record.title ?? null,
      $summary: record.summary ?? null,
      $firstPrompt: record.firstPrompt ?? null,
      $createdAt: record.createdAt ?? null,
      $updatedAt: record.updatedAt ?? new Date().toISOString(),
      $messageCount: record.messageCount ?? 0,
    })
  } catch (e) {
    logForDebugging(`[sessionFTS] indexSession failed: ${(e as Error).message}`)
  }
}

/**
 * Batch-index multiple sessions. Wrapped in a transaction for performance.
 */
export function indexSessionsBatch(records: SessionRecord[]): void {
  if (!isSessionFTSEnabled() || records.length === 0) return
  try {
    const db = getDb()
    const txn = db.transaction(() => {
      for (const record of records) {
        indexSession(record)
      }
    })
    txn()
    logForDebugging(`[sessionFTS] indexed ${records.length} sessions`)
  } catch (e) {
    logForDebugging(`[sessionFTS] batch index failed: ${(e as Error).message}`)
  }
}

/**
 * Remove a session from the index.
 */
export function removeSessionFromIndex(sessionId: string): void {
  if (!isSessionFTSEnabled()) return
  try {
    const db = getDb()
    db.exec('DELETE FROM sessions WHERE session_id = $id', { $id: sessionId })
  } catch (e) {
    logForDebugging(`[sessionFTS] remove failed: ${(e as Error).message}`)
  }
}
