/**
 * Memory Provider Interface — uniform abstraction over memory backends.
 *
 * Ported from hermes-agent `memory/provider.py:12-58`.
 *
 * Why: claude currently has 6+ memory types (User, Project, Local, Managed,
 * AutoMem, TeamMem) scattered across utils/memory, memdir/paths, auto-memory,
 * and session-memory — each with its own read/write/list/search patterns.
 * This interface unifies them behind a single contract so higher layers
 * (recall, prompt injection, compaction) can work with any backend.
 *
 * A provider manages ONE category of memories. The MemoryManager (manager.ts)
 * routes calls to the appropriate provider by type.
 */

export interface MemoryEntry {
  /** Unique identifier within this provider (typically filename or key) */
  id: string
  /** Human-readable title / first line of the memory */
  title: string
  /** Full content */
  content: string
  /** Memory type from MEMORY_TYPE_VALUES */
  type: string
  /** ISO 8601 timestamp of last modification */
  updatedAt: string
  /** Optional metadata (frontmatter, tags, etc.) */
  metadata?: Record<string, unknown>
}

export interface MemorySearchResult extends MemoryEntry {
  /** Relevance score (0-1, higher = more relevant) */
  score: number
  /** Matching snippet for display */
  snippet?: string
}

export interface ListOptions {
  /** Maximum number of entries to return */
  limit?: number
  /** Filter by modification time (ISO 8601) */
  since?: string
}

export interface SearchOptions extends ListOptions {
  /** Minimum relevance score threshold (0-1) */
  minScore?: number
}

/**
 * MemoryProvider — interface contract for all memory backends.
 *
 * Implementations:
 *   - FileMemoryProvider (builtin/file.ts) — fs-based, wraps existing paths
 *   - Future: SQLite, vector-store, remote API, etc.
 */
export interface MemoryProvider {
  /** Provider name for logging/routing (e.g. 'file', 'sqlite', 'remote') */
  readonly name: string

  /** Memory types this provider handles */
  readonly types: readonly string[]

  /** Read a single memory by id. Returns null if not found. */
  read(type: string, id: string): Promise<MemoryEntry | null>

  /** Write or update a memory. Returns the entry as persisted. */
  write(type: string, entry: Omit<MemoryEntry, 'updatedAt'>): Promise<MemoryEntry>

  /** Delete a memory. Returns true if the entry existed and was removed. */
  delete(type: string, id: string): Promise<boolean>

  /** List all memories of a given type, optionally filtered. */
  list(type: string, options?: ListOptions): Promise<MemoryEntry[]>

  /** Full-text search across all memories of a given type. */
  search(type: string, query: string, options?: SearchOptions): Promise<MemorySearchResult[]>

  /** Check if the provider is available / initialized. */
  isAvailable(): boolean
}
