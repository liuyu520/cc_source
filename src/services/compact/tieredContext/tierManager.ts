/**
 * ContextTierManager — Tiered Context 核心管理器
 *
 * 职责：
 *  1. indexCompactedTurns(): compact 完成后，对每条被压缩的 turn 算一条
 *     TierEntry 并写入 L4 索引（~/.claude/projects/{cwd}/{sessionId}.tier-index.jsonl）
 *  2. rehydrate(): 按 turnId 从 L4 精确读回原 turn；优先查 L2 内存缓存
 *  3. searchRehydrateCandidates(): 按关键词搜索可 rehydrate 的 turn，供
 *     RehydrateTool / auto-rehydrate 使用
 *
 * 设计：
 *  - L4 写入用 nd json append-only
 *  - byte offset 通过"全扫 transcript + JSON.parse 匹配 uuid"获取。单次 compact
 *    只跑一次全扫，摊销成本可接受；大 transcript 可以后续加索引优化。
 *  - L2 LRU 缓存用简单 Map + 访问时间，容量 128 条
 *  - 所有事件写 EvidenceLedger domain='context'
 */

import * as fs from 'node:fs'
import { EvidenceLedger } from '../../harness/index.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { RehydrateResult, TierEntry } from './types.js'

const L2_MAX_SIZE = 128

interface L2Entry {
  content: string
  accessedAt: number
}

interface LooseMessage {
  uuid?: string
  type?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  timestamp?: string
}

class ContextTierManagerImpl {
  /** L2 write-through 内存缓存：turnId → raw content */
  private l2Cache = new Map<string, L2Entry>()

  /**
   * Compact 完成后调用，记录被压缩的 turn 的位置信息。
   *
   * @param sessionId 当前会话 id
   * @param transcriptPath 原始 transcript JSONL 文件路径
   * @param compactedMessages 被压缩掉的原始消息数组
   * @param importanceScores 对应的 importance 分数（与 messages 一一对应）
   */
  indexCompactedTurns(
    sessionId: string,
    transcriptPath: string,
    compactedMessages: LooseMessage[],
    importanceScores: number[],
  ): void {
    if (!fs.existsSync(transcriptPath)) {
      logForDebugging(
        `[TieredContext] transcript not found, skip indexing: ${transcriptPath}`,
      )
      return
    }
    // 扫描 transcript 构建 uuid → {offset, length} 映射
    const locMap = this.buildLocationMap(transcriptPath)
    if (locMap.size === 0) return

    const nowIso = new Date().toISOString()
    const entries: TierEntry[] = []
    for (let i = 0; i < compactedMessages.length; i++) {
      const m = compactedMessages[i]
      const uuid =
        typeof m?.uuid === 'string' && m.uuid.length > 0 ? m.uuid : undefined
      if (!uuid) continue
      const loc = locMap.get(uuid)
      if (!loc) continue
      const role = this.extractRole(m)
      const snippet = this.extractSnippet(m)
      const score = importanceScores[i] ?? 0
      entries.push({
        turnId: uuid,
        role,
        byteOffset: loc.offset,
        byteLength: loc.length,
        tokenEstimate: Math.max(1, Math.floor(loc.length / 4)),
        importanceScore: score,
        compactedAt: nowIso,
        summarySnippet: snippet,
      })
    }

    if (entries.length === 0) return

    // 写索引文件（append-only ndjson）
    const indexPath = this.getIndexPath(sessionId, transcriptPath)
    try {
      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      fs.appendFileSync(indexPath, lines)
    } catch (e) {
      logForDebugging(
        `[TieredContext] failed to write index ${indexPath}: ${(e as Error).message}`,
      )
      return
    }

    EvidenceLedger.append({
      ts: nowIso,
      domain: 'context',
      kind: 'tier_indexed',
      sessionId,
      data: { count: entries.length, indexPath },
    })
    logForDebugging(
      `[TieredContext] indexed ${entries.length} turns → ${indexPath}`,
    )
  }

  /**
   * 从 L4/L2 取回指定 turn 的原始内容。
   * 返回 null 表示索引中找不到或读取失败。
   */
  rehydrate(
    sessionId: string,
    transcriptPath: string,
    turnId: string,
  ): RehydrateResult | null {
    const start = Date.now()
    // 1. L2 cache
    const cached = this.l2Cache.get(turnId)
    if (cached) {
      cached.accessedAt = Date.now()
      EvidenceLedger.append({
        ts: new Date().toISOString(),
        domain: 'context',
        kind: 'rehydrated',
        sessionId,
        data: { turnId, source: 'l2_cache' },
      })
      return {
        turnId,
        content: cached.content,
        tokenCount: Math.max(1, Math.floor(cached.content.length / 4)),
        source: 'l2_cache',
        tookMs: Date.now() - start,
      }
    }

    // 2. L4 disk: 查 index 文件拿到 offset/length
    const indexPath = this.getIndexPath(sessionId, transcriptPath)
    if (!fs.existsSync(indexPath)) return null
    const entry = this.findEntryInIndex(indexPath, turnId)
    if (!entry) return null

    // 精确读取 transcript
    let content = ''
    try {
      const fd = fs.openSync(transcriptPath, 'r')
      try {
        const buf = Buffer.alloc(entry.byteLength)
        fs.readSync(fd, buf, 0, entry.byteLength, entry.byteOffset)
        content = buf.toString('utf-8')
      } finally {
        fs.closeSync(fd)
      }
    } catch (e) {
      logForDebugging(
        `[TieredContext] rehydrate read failed: ${(e as Error).message}`,
      )
      return null
    }

    // 写入 L2 缓存（LRU 简单替换）
    this.l2Put(turnId, content)

    EvidenceLedger.append({
      ts: new Date().toISOString(),
      domain: 'context',
      kind: 'rehydrated',
      sessionId,
      data: {
        turnId,
        source: 'l4_disk',
        bytes: entry.byteLength,
      },
    })

    return {
      turnId,
      content,
      tokenCount: entry.tokenEstimate,
      source: 'l4_disk',
      tookMs: Date.now() - start,
    }
  }

  /** 按关键词 + importance 在 L4 索引里搜候选 */
  searchRehydrateCandidates(
    sessionId: string,
    transcriptPath: string,
    query: string,
    limit = 5,
  ): TierEntry[] {
    const indexPath = this.getIndexPath(sessionId, transcriptPath)
    if (!fs.existsSync(indexPath)) return []
    let raw: string
    try {
      raw = fs.readFileSync(indexPath, 'utf-8')
    } catch {
      return []
    }
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2)
    if (terms.length === 0) return []
    const scored: Array<{ entry: TierEntry; score: number }> = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let e: TierEntry
      try {
        e = JSON.parse(line) as TierEntry
      } catch {
        continue
      }
      const snippet = (e.summarySnippet || '').toLowerCase()
      let keywordHit = 0
      for (const t of terms) {
        if (snippet.includes(t)) keywordHit += 1
      }
      if (keywordHit === 0) continue
      const score = e.importanceScore * 0.5 + keywordHit * 0.5
      scored.push({ entry: e, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.entry)
  }

  /** 获取当前索引统计（诊断用） */
  getIndexStats(sessionId: string, transcriptPath: string): {
    totalEntries: number
    totalTokens: number
  } {
    const indexPath = this.getIndexPath(sessionId, transcriptPath)
    if (!fs.existsSync(indexPath)) {
      return { totalEntries: 0, totalTokens: 0 }
    }
    let totalEntries = 0
    let totalTokens = 0
    try {
      const raw = fs.readFileSync(indexPath, 'utf-8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as TierEntry
          totalEntries += 1
          totalTokens += e.tokenEstimate
        } catch {
          continue
        }
      }
    } catch {
      // ignore
    }
    return { totalEntries, totalTokens }
  }

  // ========== 私有辅助 ==========

  /** 根据 sessionId + transcriptPath 计算 index 文件路径 */
  private getIndexPath(sessionId: string, transcriptPath: string): string {
    // transcript 如 ~/.claude/projects/{cwd}/{sessionId}.jsonl
    // index 放到同目录 {sessionId}.tier-index.jsonl
    const dot = transcriptPath.lastIndexOf('.')
    const base = dot > 0 ? transcriptPath.slice(0, dot) : transcriptPath
    return `${base}.tier-index.jsonl`
  }

  /** 扫 transcript，建 uuid → offset/length 映射 */
  private buildLocationMap(
    transcriptPath: string,
  ): Map<string, { offset: number; length: number }> {
    const map = new Map<string, { offset: number; length: number }>()
    let content: string
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8')
    } catch {
      return map
    }
    let offset = 0
    for (const line of content.split('\n')) {
      const bytes = Buffer.byteLength(line, 'utf-8')
      if (line.trim()) {
        try {
          const obj = JSON.parse(line) as { uuid?: string }
          if (obj?.uuid) {
            map.set(obj.uuid, { offset, length: bytes })
          }
        } catch {
          // 坏行跳过
        }
      }
      offset += bytes + 1 // +1 for '\n'
    }
    return map
  }

  /** 在 index 文件里查指定 turnId 的 entry */
  private findEntryInIndex(
    indexPath: string,
    turnId: string,
  ): TierEntry | null {
    let raw: string
    try {
      raw = fs.readFileSync(indexPath, 'utf-8')
    } catch {
      return null
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as TierEntry
        if (e.turnId === turnId) return e
      } catch {
        continue
      }
    }
    return null
  }

  private extractRole(m: LooseMessage): 'user' | 'assistant' {
    const role = m?.message?.role
    if (role === 'user' || role === 'assistant') return role
    if (m?.type === 'user') return 'user'
    return 'assistant'
  }

  private extractSnippet(m: LooseMessage): string {
    const c = m?.message?.content ?? m?.content
    if (typeof c === 'string') return c.slice(0, 100)
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text
          if (typeof t === 'string') return t.slice(0, 100)
        }
      }
    }
    return ''
  }

  /** L2 cache 放入（简单 LRU 淘汰：容量满删最老） */
  private l2Put(turnId: string, content: string): void {
    if (this.l2Cache.size >= L2_MAX_SIZE) {
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [k, v] of this.l2Cache.entries()) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt
          oldestKey = k
        }
      }
      if (oldestKey) this.l2Cache.delete(oldestKey)
    }
    this.l2Cache.set(turnId, { content, accessedAt: Date.now() })
  }
}

export const contextTierManager = new ContextTierManagerImpl()
