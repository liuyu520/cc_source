/**
 * MemoryManager — routes memory operations to the appropriate provider.
 *
 * Ported from hermes-agent `memory/manager.py:15-82`.
 *
 * The manager holds a registry of MemoryProviders keyed by memory type.
 * When a caller asks to read/write/search type "User", the manager looks
 * up which provider handles "User" and delegates. If no provider is
 * registered for a type, the operation is a no-op (returns null/empty).
 *
 * ENV gate:
 *   CLAUDE_CODE_MEMORY_PROVIDER=1  → enable (default OFF)
 *   When off, all operations return null/empty, preserving existing
 *   direct-fs memory paths.
 */

import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchResult,
  ListOptions,
  SearchOptions,
} from './types.js'
import { logForDebugging } from '../../utils/debug.js'

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_MEMORY_PROVIDER ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export class MemoryManager {
  private providers = new Map<string, MemoryProvider>()
  private typeToProvider = new Map<string, MemoryProvider>()

  /**
   * Register a provider. The provider's `types` array determines which
   * memory types it handles. Later registrations override earlier ones
   * for the same type (last-write-wins).
   */
  register(provider: MemoryProvider): void {
    this.providers.set(provider.name, provider)
    for (const type of provider.types) {
      this.typeToProvider.set(type, provider)
    }
    logForDebugging(
      `[MemoryManager] registered provider "${provider.name}" for types: ${provider.types.join(', ')}`,
    )
  }

  /**
   * Unregister a provider by name.
   */
  unregister(name: string): void {
    const provider = this.providers.get(name)
    if (!provider) return
    this.providers.delete(name)
    for (const type of provider.types) {
      if (this.typeToProvider.get(type) === provider) {
        this.typeToProvider.delete(type)
      }
    }
  }

  private getProvider(type: string): MemoryProvider | null {
    if (!isEnabled()) return null
    return this.typeToProvider.get(type) ?? null
  }

  async read(type: string, id: string): Promise<MemoryEntry | null> {
    const p = this.getProvider(type)
    if (!p) return null
    return p.read(type, id)
  }

  async write(
    type: string,
    entry: Omit<MemoryEntry, 'updatedAt'>,
  ): Promise<MemoryEntry | null> {
    const p = this.getProvider(type)
    if (!p) return null
    return p.write(type, entry)
  }

  async delete(type: string, id: string): Promise<boolean> {
    const p = this.getProvider(type)
    if (!p) return false
    return p.delete(type, id)
  }

  async list(type: string, options?: ListOptions): Promise<MemoryEntry[]> {
    const p = this.getProvider(type)
    if (!p) return []
    return p.list(type, options)
  }

  async search(
    type: string,
    query: string,
    options?: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    const p = this.getProvider(type)
    if (!p) return []
    return p.search(type, query, options)
  }

  /**
   * Search across ALL registered types. Merges and re-ranks results.
   */
  async searchAll(
    query: string,
    options?: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    if (!isEnabled()) return []
    const results: MemorySearchResult[] = []
    const seen = new Set<string>()
    for (const [type, provider] of this.typeToProvider) {
      if (seen.has(provider.name + ':' + type)) continue
      seen.add(provider.name + ':' + type)
      const typeResults = await provider.search(type, query, options)
      results.push(...typeResults)
    }
    // Sort by score descending
    results.sort((a, b) => b.score - a.score)
    return options?.limit ? results.slice(0, options.limit) : results
  }

  /** List all registered provider names */
  getRegisteredProviders(): string[] {
    return [...this.providers.keys()]
  }
}

// Singleton
let instance: MemoryManager | null = null

export function getMemoryManager(): MemoryManager {
  if (!instance) {
    instance = new MemoryManager()
  }
  return instance
}
