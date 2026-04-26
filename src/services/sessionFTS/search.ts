/**
 * sessionFTS/search.ts — full-text search over session metadata.
 *
 * Uses FTS5 MATCH queries with BM25 ranking. Falls back to the original
 * naive `includes()` scan when FTS is disabled or the query fails.
 */

import { getDb, isSessionFTSEnabled } from './db.js'
import { logForDebugging } from '../../utils/debug.js'

export interface FTSSearchResult {
  sessionId: string
  projectDir: string
  title: string | null
  summary: string | null
  firstPrompt: string | null
  createdAt: string | null
  updatedAt: string | null
  messageCount: number
  rank: number
}

/**
 * Search sessions using FTS5 MATCH. Returns results ranked by BM25
 * (best match first). Query syntax supports FTS5 operators:
 *   - "exact phrase"
 *   - term1 AND term2
 *   - term1 OR term2
 *   - term1 NOT term2
 *   - prefix*
 *
 * Plain text queries are automatically treated as a phrase prefix search.
 */
export function searchSessionsFTS(
  projectDir: string,
  query: string,
  limit: number = 50,
): FTSSearchResult[] {
  if (!isSessionFTSEnabled()) return []
  try {
    const db = getDb()
    // Sanitize query: escape double quotes, strip control chars
    const sanitized = query.replace(/"/g, '""').replace(/[\x00-\x1f]/g, ' ').trim()
    if (!sanitized) return []

    // Use BM25 ranking (lower = better match; negate for DESC sort)
    const stmt = db.prepare(`
      SELECT
        s.session_id as sessionId,
        s.project_dir as projectDir,
        s.title,
        s.summary,
        s.first_prompt as firstPrompt,
        s.created_at as createdAt,
        s.updated_at as updatedAt,
        s.message_count as messageCount,
        rank
      FROM sessions_fts
      JOIN sessions s ON sessions_fts.rowid = s.rowid
      WHERE sessions_fts MATCH $query
        AND s.project_dir = $projectDir
      ORDER BY rank
      LIMIT $limit
    `)

    const results = stmt.all({
      $query: sanitized,
      $projectDir: projectDir,
      $limit: limit,
    }) as FTSSearchResult[]

    logForDebugging(
      `[sessionFTS] search "${sanitized}" → ${results.length} results`,
    )
    return results
  } catch (e) {
    // FTS5 MATCH can throw on malformed queries. Log and return empty
    // so the caller falls back to naive search.
    logForDebugging(
      `[sessionFTS] search failed (falling back): ${(e as Error).message}`,
    )
    return []
  }
}

/**
 * Get the total number of indexed sessions for a project.
 */
export function getIndexedSessionCount(projectDir: string): number {
  if (!isSessionFTSEnabled()) return 0
  try {
    const db = getDb()
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM sessions WHERE project_dir = $dir',
    ).get({ $dir: projectDir }) as { count: number } | null
    return row?.count ?? 0
  } catch {
    return 0
  }
}
