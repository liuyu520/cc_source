/**
 * SessionIndexService - In-memory caching service for session metadata.
 *
 * Provides fast access to session lists with metadata by caching results
 * from the file system scan. Cache expires after 5 minutes to balance
 * performance with freshness.
 *
 * This is the "hybrid approach" from the design plan:
 * - Metadata stored in JSONL files (no separate index file)
 * - In-memory cache for fast queries
 * - Lazy loading on first access
 */

import type { UUID } from 'crypto'
import type { LogOption } from '../types/logs.js'
import {
  getSessionFilesLite,
  saveSessionCategory,
  saveSessionPinned,
  saveSessionArchived,
  enrichLogs,
} from '../utils/sessionStorage.js'

export type SessionMetadata = LogOption

export class SessionIndexService {
  private cache: Map<string, SessionMetadata> = new Map()
  private cacheExpiry: number = 5 * 60 * 1000 // 5 minutes
  private lastScan: number = 0

  /**
   * List all sessions for a project directory.
   * Uses cached results if available and not expired.
   */
  async listSessions(
    projectDir: string,
    options: {
      forceRefresh?: boolean
      category?: 'feature' | 'bugfix' | 'refactor' | 'exploration' | 'custom'
      pinned?: boolean
      archived?: boolean
      tag?: string
    } = {},
  ): Promise<SessionMetadata[]> {
    const now = Date.now()

    // Use cache if valid and not force refresh
    if (
      !options.forceRefresh &&
      now - this.lastScan < this.cacheExpiry &&
      this.cache.size > 0
    ) {
      return this.filterSessions(Array.from(this.cache.values()), options)
    }

    // Scan file system and enrich with metadata
    const liteSessions = await getSessionFilesLite(projectDir)
    const { logs: enrichedSessions } = await enrichLogs(
      liteSessions,
      0,
      liteSessions.length,
    )

    // Update cache
    this.cache.clear()
    enrichedSessions.forEach((s) => {
      if (s.sessionId) {
        this.cache.set(s.sessionId, s)
      }
    })
    this.lastScan = now

    return this.filterSessions(enrichedSessions, options)
  }

  /**
   * Filter sessions based on criteria.
   */
  private filterSessions(
    sessions: SessionMetadata[],
    options: {
      category?: 'feature' | 'bugfix' | 'refactor' | 'exploration' | 'custom'
      pinned?: boolean
      archived?: boolean
      tag?: string
    },
  ): SessionMetadata[] {
    let filtered = sessions

    // Filter by category
    if (options.category !== undefined) {
      filtered = filtered.filter((s) => s.category === options.category)
    }

    // Filter by pinned status
    if (options.pinned !== undefined) {
      filtered = filtered.filter((s) => s.pinned === options.pinned)
    }

    // Filter by archived status
    if (options.archived !== undefined) {
      filtered = filtered.filter((s) => s.archived === options.archived)
    } else {
      // By default, exclude archived sessions
      filtered = filtered.filter((s) => !s.archived)
    }

    // Filter by tag
    if (options.tag !== undefined) {
      filtered = filtered.filter((s) => s.tag === options.tag)
    }

    return filtered
  }

  /**
   * Get a single session by ID.
   */
  async getSession(
    projectDir: string,
    sessionId: string,
  ): Promise<SessionMetadata | undefined> {
    // Try cache first
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId)
    }

    // Refresh cache and try again
    await this.listSessions(projectDir, { forceRefresh: true })
    return this.cache.get(sessionId)
  }

  /**
   * Update session metadata and refresh cache.
   */
  async updateMetadata(
    sessionId: UUID,
    updates: {
      category?: 'feature' | 'bugfix' | 'refactor' | 'exploration' | 'custom'
      customCategory?: string
      pinned?: boolean
      archived?: boolean
    },
    fullPath?: string,
  ): Promise<void> {
    // Write to JSONL
    if (updates.category !== undefined) {
      await saveSessionCategory(
        sessionId,
        updates.category,
        updates.customCategory,
        fullPath,
      )
    }
    if (updates.pinned !== undefined) {
      await saveSessionPinned(sessionId, updates.pinned, fullPath)
    }
    if (updates.archived !== undefined) {
      await saveSessionArchived(sessionId, updates.archived, fullPath)
    }

    // Update in-memory cache
    const cached = this.cache.get(sessionId)
    if (cached) {
      if (updates.category !== undefined) cached.category = updates.category
      if (updates.customCategory !== undefined)
        cached.customCategory = updates.customCategory
      if (updates.pinned !== undefined) cached.pinned = updates.pinned
      if (updates.archived !== undefined) cached.archived = updates.archived
    }
  }

  /**
   * Clear the cache (useful for testing or manual refresh).
   */
  clearCache(): void {
    this.cache.clear()
    this.lastScan = 0
  }

  /**
   * Search sessions by title, summary, or first prompt.
   */
  async searchSessions(
    projectDir: string,
    query: string,
  ): Promise<SessionMetadata[]> {
    // Fast path: FTS5 full-text search when CLAUDE_CODE_SESSION_FTS=1.
    // Falls through to the original naive scan on failure or when disabled.
    try {
      const { isSessionFTSEnabled, searchSessionsFTS } = await import(
        './sessionFTS/index.js'
      )
      if (isSessionFTSEnabled()) {
        const ftsResults = searchSessionsFTS(projectDir, query)
        if (ftsResults.length > 0) {
          return ftsResults.map((r) => ({
            sessionId: r.sessionId,
            customTitle: r.title ?? undefined,
            firstPrompt: r.firstPrompt ?? undefined,
            summary: r.summary ?? undefined,
            createdAt: r.createdAt ?? undefined,
            updatedAt: r.updatedAt ?? undefined,
          }))
        }
        // FTS returned 0 results — fall through to naive scan in case the
        // index is stale or the query uses characters FTS5 doesn't tokenize.
      }
    } catch {
      // FTS module not available or failed — fall through to naive scan
    }

    // Original naive scan (preserved as fallback)
    const sessions = await this.listSessions(projectDir)
    const lowerQuery = query.toLowerCase()

    return sessions.filter((s) => {
      const title = (s.customTitle || s.firstPrompt || '').toLowerCase()
      const summary = (s.summary || '').toLowerCase()
      return title.includes(lowerQuery) || summary.includes(lowerQuery)
    })
  }
}

// Singleton instance
let instance: SessionIndexService | null = null

export function getSessionIndexService(): SessionIndexService {
  if (!instance) {
    instance = new SessionIndexService()
  }
  return instance
}
