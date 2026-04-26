/**
 * FileMemoryProvider — wraps existing filesystem-based memory paths.
 *
 * This provider re-uses all existing memory directory conventions
 * (getAutoMemPath, getMemoryPath, etc.) and provides a MemoryProvider
 * interface on top. Zero behavior change — just a facade.
 *
 * Handles types: User, Project, Local, Managed, AutoMem
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import type {
  MemoryProvider,
  MemoryEntry,
  MemorySearchResult,
  ListOptions,
  SearchOptions,
} from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

export class FileMemoryProvider implements MemoryProvider {
  readonly name = 'file'
  readonly types = ['User', 'Project', 'Local', 'Managed', 'AutoMem'] as const

  constructor(private readonly memoryRoot: string) {}

  private getTypeDir(type: string): string {
    return join(this.memoryRoot, type.toLowerCase())
  }

  isAvailable(): boolean {
    return existsSync(this.memoryRoot)
  }

  async read(type: string, id: string): Promise<MemoryEntry | null> {
    const filePath = join(this.getTypeDir(type), id)
    if (!existsSync(filePath)) return null
    try {
      const content = readFileSync(filePath, 'utf-8')
      const stat = statSync(filePath)
      return {
        id,
        title: extractTitle(content),
        content,
        type,
        updatedAt: stat.mtime.toISOString(),
        metadata: extractFrontmatter(content),
      }
    } catch {
      return null
    }
  }

  async write(type: string, entry: Omit<MemoryEntry, 'updatedAt'>): Promise<MemoryEntry> {
    const dir = this.getTypeDir(type)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, entry.id)
    writeFileSync(filePath, entry.content, 'utf-8')
    return {
      ...entry,
      updatedAt: new Date().toISOString(),
    }
  }

  async delete(type: string, id: string): Promise<boolean> {
    const filePath = join(this.getTypeDir(type), id)
    if (!existsSync(filePath)) return false
    try {
      unlinkSync(filePath)
      return true
    } catch {
      return false
    }
  }

  async list(type: string, options?: ListOptions): Promise<MemoryEntry[]> {
    const dir = this.getTypeDir(type)
    if (!existsSync(dir)) return []
    try {
      const files = readdirSync(dir).filter(
        (f) => f.endsWith('.md') || f.endsWith('.txt'),
      )
      const entries: MemoryEntry[] = []
      for (const file of files) {
        const entry = await this.read(type, file)
        if (entry) {
          if (options?.since && entry.updatedAt < options.since) continue
          entries.push(entry)
        }
      }
      entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return options?.limit ? entries.slice(0, options.limit) : entries
    } catch {
      return []
    }
  }

  async search(
    type: string,
    query: string,
    options?: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    const entries = await this.list(type)
    const lowerQuery = query.toLowerCase()
    const results: MemorySearchResult[] = []
    for (const entry of entries) {
      const text = (entry.title + ' ' + entry.content).toLowerCase()
      if (!text.includes(lowerQuery)) continue
      // Simple relevance: title match scores higher than content match
      const titleMatch = entry.title.toLowerCase().includes(lowerQuery)
      const score = titleMatch ? 0.9 : 0.5
      if (options?.minScore && score < options.minScore) continue
      results.push({
        ...entry,
        score,
        snippet: extractSnippet(entry.content, lowerQuery),
      })
    }
    results.sort((a, b) => b.score - a.score)
    return options?.limit ? results.slice(0, options.limit) : results
  }
}

function extractTitle(content: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('---')) continue
    if (trimmed.startsWith('#')) return trimmed.replace(/^#+\s*/, '')
    if (trimmed.startsWith('name:')) return trimmed.replace(/^name:\s*/, '').replace(/^['"]|['"]$/g, '')
    if (trimmed.length > 0) return trimmed.slice(0, 80)
  }
  return '(untitled)'
}

function extractFrontmatter(content: string): Record<string, unknown> | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return undefined
  const result: Record<string, unknown> = {}
  for (const line of match[1]!.split('\n')) {
    const [key, ...rest] = line.split(':')
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join(':').trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return result
}

function extractSnippet(content: string, query: string, radius: number = 80): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(query)
  if (idx === -1) return content.slice(0, radius * 2)
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + query.length + radius)
  let snippet = content.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < content.length) snippet = snippet + '...'
  return snippet
}
