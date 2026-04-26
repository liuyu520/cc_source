/**
 * EvidenceLedger — 跨 domain 的统一证据存储
 *
 * 存储格式：append-only ndjson，每个 domain 独立文件。
 * 存储路径：{claudeConfigDir}/evidence/{domain}.ndjson
 *
 * 设计原则：
 *  - 零依赖：只用 node:fs + BufferedWriter，不引任何第三方库
 *  - 安全：如显式关闭 CLAUDE_CODE_HARNESS_PRIMITIVES(=0/false)，append()
 *    直接 no-op，不做任何磁盘 IO；默认开启以便复用统一证据轨迹
 *  - 缓冲：复用 src/utils/bufferedWriter.ts 的 createBufferedWriter
 *  - append-only：写入永远 append，查询默认只读尾部固定窗口
 *  - 小文件优先：兼容 full scan，供诊断 / gc / 快照使用
 */

import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  createBufferedWriter,
  type BufferedWriter,
} from '../../utils/bufferedWriter.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type {
  EvidenceDomain,
  EvidenceEntry,
  LedgerQueryOptions,
  LedgerSnapshot,
} from './evidenceLedgerTypes.js'
import { isHarnessPrimitivesEnabled } from './featureCheck.js'

const DEFAULT_TTL_DAYS = 30
const DEFAULT_TAIL_BYTES = 1_048_576
const DUPLICATE_DEBOUNCE_MS = 1_500

/** evidence 目录路径 */
function getEvidenceDir(): string {
  return join(getClaudeConfigHomeDir(), 'evidence')
}

/** 给定 domain 的 ndjson 文件路径 */
function getDomainFile(domain: EvidenceDomain): string {
  return join(getEvidenceDir(), `${domain}.ndjson`)
}

export function getEvidenceDomainFilePath(domain: EvidenceDomain): string {
  return getDomainFile(domain)
}

/** 确保 evidence 目录存在 */
function ensureEvidenceDir(): void {
  const dir = getEvidenceDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function makeEntryShape(entry: EvidenceEntry): string {
  try {
    return JSON.stringify({
      domain: entry.domain,
      kind: entry.kind,
      sessionId: entry.sessionId,
      ttlDays: entry.ttlDays ?? DEFAULT_TTL_DAYS,
      data: entry.data,
    })
  } catch {
    return `${entry.domain}:${entry.kind}:${entry.sessionId ?? ''}`
  }
}

function readFileTail(file: string, maxBytes: number): string {
  const stat = fs.statSync(file)
  if (stat.size <= 0) return ''

  const size = Math.min(stat.size, maxBytes)
  const offset = Math.max(0, stat.size - size)
  const buffer = Buffer.alloc(size)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, size, offset)
  } finally {
    fs.closeSync(fd)
  }

  let content = buffer.toString('utf-8')
  if (offset > 0) {
    const firstNewline = content.indexOf('\n')
    if (firstNewline >= 0) {
      content = content.slice(firstNewline + 1)
    } else {
      return ''
    }
  }
  return content
}

function readLedgerContent(
  file: string,
  opts: LedgerQueryOptions,
): string {
  try {
    if ((opts.scanMode ?? 'tail') === 'full') {
      return fs.readFileSync(file, 'utf-8')
    }
    return readFileTail(file, opts.tailBytes ?? DEFAULT_TAIL_BYTES)
  } catch {
    return ''
  }
}

function filterEntries(
  content: string,
  opts: LedgerQueryOptions,
): EvidenceEntry[] {
  const results: EvidenceEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue

    let entry: EvidenceEntry
    try {
      entry = JSON.parse(line) as EvidenceEntry
    } catch {
      continue
    }

    if (opts.since && entry.ts < opts.since) continue
    if (opts.until && entry.ts > opts.until) continue
    if (opts.kind && entry.kind !== opts.kind) continue
    results.push(entry)
  }

  if (opts.limit && opts.limit > 0 && results.length > opts.limit) {
    return results.slice(results.length - opts.limit)
  }
  return results
}

class EvidenceLedgerImpl {
  /** domain → BufferedWriter 的单例映射 */
  private writers = new Map<EvidenceDomain, BufferedWriter>()
  /** domain → 最近一次 shape，用于抑制毫秒级完全重复写入 */
  private lastShapes = new Map<EvidenceDomain, { shape: string; at: number }>()

  /**
   * 追加一条证据。
   * - 如果 CLAUDE_CODE_HARNESS_PRIMITIVES 被显式关闭(=0/false)，直接 no-op
   * - 写入失败不抛异常，只静默吞掉（避免影响主流程）
   */
  append(entry: EvidenceEntry): void {
    if (!isHarnessPrimitivesEnabled()) return
    try {
      const filled: EvidenceEntry = {
        ...entry,
        ts: entry.ts || new Date().toISOString(),
      }

      const shape = makeEntryShape(filled)
      const last = this.lastShapes.get(filled.domain)
      const now = Date.now()
      if (
        last &&
        last.shape === shape &&
        now - last.at <= DUPLICATE_DEBOUNCE_MS
      ) {
        return
      }

      ensureEvidenceDir()
      const writer = this.getOrCreateWriter(filled.domain)
      this.lastShapes.set(filled.domain, { shape, at: now })
      writer.write(JSON.stringify(filled) + '\n')
    } catch {
      // 证据写入失败不能影响主流程，静默吞掉
    }
  }

  appendEvent(
    domain: EvidenceDomain,
    kind: string,
    data: Record<string, unknown>,
    extra: Omit<Partial<EvidenceEntry>, 'domain' | 'kind' | 'data'> = {},
  ): void {
    this.append({
      ...extra,
      ts: extra.ts || new Date().toISOString(),
      domain,
      kind,
      data,
    })
  }

  /**
   * 兼容旧行为：默认 full scan。
   * 新代码应优先使用 queryByDomain()，默认只读尾部 1MB。
   */
  query(
    domain: EvidenceDomain,
    opts: LedgerQueryOptions = {},
  ): EvidenceEntry[] {
    return this.queryByDomain(domain, {
      ...opts,
      scanMode: 'full',
    })
  }

  queryByDomain(
    domain: EvidenceDomain,
    opts: LedgerQueryOptions = {},
  ): EvidenceEntry[] {
    const file = getDomainFile(domain)
    if (!fs.existsSync(file)) return []
    this.writers.get(domain)?.flush()
    return filterEntries(readLedgerContent(file, opts), opts)
  }

  queryByDomains(
    domains: ReadonlyArray<EvidenceDomain>,
    opts: LedgerQueryOptions = {},
  ): EvidenceEntry[] {
    const merged = domains
      .flatMap((domain) => this.queryByDomain(domain, opts))
      .sort((a, b) => a.ts.localeCompare(b.ts))

    if (opts.limit && opts.limit > 0 && merged.length > opts.limit) {
      return merged.slice(merged.length - opts.limit)
    }
    return merged
  }

  /**
   * 清理过期条目（重写文件）。
   * 返回删除条目数。
   */
  gc(domain: EvidenceDomain): number {
    const file = getDomainFile(domain)
    if (!fs.existsSync(file)) return 0
    this.writers.get(domain)?.flush()

    const content = readLedgerContent(file, { scanMode: 'full' })
    if (!content) return 0

    const now = Date.now()
    const kept: string[] = []
    let deleted = 0
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as EvidenceEntry
        const ttlDays = entry.ttlDays ?? DEFAULT_TTL_DAYS
        const expireAt = new Date(entry.ts).getTime() + ttlDays * 86400_000
        if (expireAt < now) {
          deleted++
          continue
        }
        kept.push(line)
      } catch {
        deleted++
      }
    }

    try {
      fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '', 'utf-8')
    } catch {
      return 0
    }
    return deleted
  }

  /** 获取 domain 的统计快照 */
  snapshot(domain: EvidenceDomain): LedgerSnapshot {
    const entries = this.query(domain)
    if (entries.length === 0) {
      return { domain, totalEntries: 0, oldestTs: '', newestTs: '' }
    }
    let oldestTs = entries[0].ts
    let newestTs = entries[0].ts
    for (const entry of entries) {
      if (entry.ts < oldestTs) oldestTs = entry.ts
      if (entry.ts > newestTs) newestTs = entry.ts
    }
    return { domain, totalEntries: entries.length, oldestTs, newestTs }
  }

  /** flush 所有 domain 的 buffer */
  flushAll(): void {
    for (const writer of this.writers.values()) {
      writer.flush()
    }
  }

  /** 获取或创建指定 domain 的 BufferedWriter */
  private getOrCreateWriter(domain: EvidenceDomain): BufferedWriter {
    const existing = this.writers.get(domain)
    if (existing) return existing
    const file = getDomainFile(domain)
    const writer = createBufferedWriter({
      writeFn: (content: string) => {
        try {
          fs.appendFileSync(file, content)
        } catch {
          // 静默吞
        }
      },
      flushIntervalMs: 1000,
      maxBufferSize: 50,
    })
    this.writers.set(domain, writer)
    return writer
  }
}

/** 单例，跨调用方共享 */
export const EvidenceLedger = new EvidenceLedgerImpl()

export function appendEvidence(
  domain: EvidenceDomain,
  kind: string,
  data: Record<string, unknown>,
  extra: Omit<Partial<EvidenceEntry>, 'domain' | 'kind' | 'data'> = {},
): void {
  EvidenceLedger.appendEvent(domain, kind, data, extra)
}
