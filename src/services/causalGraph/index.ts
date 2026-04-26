/**
 * causalGraph · 公共 API(前置基建)
 *
 * 设计原则:
 *   - **fail-open**:所有 mutation 失败返回 null/false,查询失败返回 [],绝不抛
 *   - **env-gated**:off 时所有 API no-op,零 IO
 *   - **shadow-first**:shadow 模式正常读写,决策层尚未消费(E 线未接入)
 *   - **稳定去重**:同 kind + 同 text 只产生一个 node(sha1 前 16 位做 id)
 *
 * 使用入口(未来 E 线接入):
 *   - scheduler.ts 子 agent 启动前:queryRelatedFacts(taskDescription)
 *   - 子 agent 完成回调:addFact(fact) + addEdge(factId, taskId, 'supports')
 */

import { createHash } from 'node:crypto'
import type { Statement } from 'bun:sqlite'
import { isCausalGraphEnabled, getCausalGraphMode } from './featureCheck.js'
import { getDb } from './db.js'
import { logForDebugging } from '../../utils/debug.js'
import type {
  AddEdgeOpts,
  AddFactOpts,
  CausalEdgeKind,
  CausalNode,
  CausalNodeKind,
  GraphStats,
} from './types.js'

/** kind + text 的 sha1 前 16 位,作为 node id */
function computeNodeId(kind: CausalNodeKind, text: string): string {
  const h = createHash('sha1')
  h.update(`${kind}\u0000${text}`)
  return h.digest('hex').slice(0, 16)
}

/**
 * 添加或 upsert 一个语义节点。
 * @returns nodeId;off / 失败返回 null
 */
export function addFact(text: string, opts: AddFactOpts = {}): string | null {
  try {
    if (!isCausalGraphEnabled()) return null
    const normalized = (text ?? '').trim()
    if (!normalized) return null
    const db = getDb()
    if (!db) return null
    const kind: CausalNodeKind = opts.kind ?? 'fact'
    const id = computeNodeId(kind, normalized)
    const now = new Date().toISOString()
    // INSERT OR IGNORE 保证幂等(稳定 id 去重)
    db.run(
      `INSERT OR IGNORE INTO nodes (id, text, kind, session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, normalized, kind, opts.sessionId ?? null, now],
    )
    return id
  } catch (err) {
    logForDebugging(`[causalGraph] addFact failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * 添加一条有向边。from/to 必须是已存在或刚 addFact 返回的 id。
 * @returns 边 id (自增整数);off / 失败返回 null
 */
export function addEdge(
  fromId: string,
  toId: string,
  opts: AddEdgeOpts = {},
): number | null {
  try {
    if (!isCausalGraphEnabled()) return null
    if (!fromId || !toId) return null
    if (fromId === toId) return null // 不允许自环,直接忽略
    const db = getDb()
    if (!db) return null
    const kind: CausalEdgeKind = opts.kind ?? 'related'
    const weight = Number.isFinite(opts.weight) ? Number(opts.weight) : 1.0
    const now = new Date().toISOString()
    const stmt = db.query(
      `INSERT INTO edges (from_id, to_id, kind, weight, session_id, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    const row = stmt.get(
      fromId,
      toId,
      kind,
      weight,
      opts.sessionId ?? null,
      opts.metaJson ?? null,
      now,
    ) as { id: number } | null
    return row?.id ?? null
  } catch (err) {
    logForDebugging(`[causalGraph] addEdge failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * 按文本做粗糙相关查询:先 LIKE 匹配 nodes.text,再取 1-hop 邻居。
 *
 * 语义:
 *   1. seed = nodes WHERE text LIKE '%q%' (按 created_at DESC)
 *   2. 扩展 = 沿 edges 取 seed 的 1-hop 邻居(fromId 或 toId 命中均算)
 *   3. 合并去重,按 created_at DESC 截断到 limit
 *
 * 不做向量/语义相似度 — 本层只是基建,文本匹配已足以验证 wiring。
 */
export function queryRelatedFacts(
  query: string,
  limit = 5,
): CausalNode[] {
  try {
    if (!isCausalGraphEnabled()) return []
    const normalized = (query ?? '').trim()
    if (!normalized) return []
    const db = getDb()
    if (!db) return []
    const cap = Math.max(1, Math.min(50, Math.floor(limit)))
    // 用 % 转义简单通配,极低技术门槛
    const like = `%${normalized.replace(/[%_]/g, s => '\\' + s)}%`

    // 1. seed
    const seedStmt: Statement = db.query(
      `SELECT id, text, kind, session_id, created_at FROM nodes
       WHERE text LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    const seeds = seedStmt.all(like, cap) as Array<{
      id: string
      text: string
      kind: string
      session_id: string | null
      created_at: string
    }>
    if (seeds.length === 0) return []

    // 2. 1-hop 邻居(from→to 或 to→from 都算)
    const seedIds = seeds.map(s => s.id)
    const placeholders = seedIds.map(() => '?').join(',')
    const neighborStmt: Statement = db.query(
      `SELECT DISTINCT n.id, n.text, n.kind, n.session_id, n.created_at
       FROM nodes n
       JOIN edges e ON (e.from_id = n.id OR e.to_id = n.id)
       WHERE (e.from_id IN (${placeholders}) OR e.to_id IN (${placeholders}))
         AND n.id NOT IN (${placeholders})
       ORDER BY n.created_at DESC
       LIMIT ?`,
    )
    const neighbors = neighborStmt.all(
      ...seedIds,
      ...seedIds,
      ...seedIds,
      cap,
    ) as typeof seeds

    // 3. 合并 + 总 cap
    const merged = [...seeds, ...neighbors].slice(0, cap)
    return merged.map(row => ({
      id: row.id,
      text: row.text,
      kind: row.kind as CausalNodeKind,
      sessionId: row.session_id,
      createdAt: row.created_at,
    }))
  } catch (err) {
    logForDebugging(
      `[causalGraph] queryRelatedFacts failed: ${(err as Error).message}`,
    )
    return []
  }
}

/** 最近 N 条 fact(可选 sessionId 过滤) */
export function getRecentFacts(
  limit = 10,
  sessionId?: string | null,
): CausalNode[] {
  try {
    if (!isCausalGraphEnabled()) return []
    const db = getDb()
    if (!db) return []
    const cap = Math.max(1, Math.min(200, Math.floor(limit)))
    const stmt = sessionId
      ? db.query(
          `SELECT id, text, kind, session_id, created_at FROM nodes
           WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
      : db.query(
          `SELECT id, text, kind, session_id, created_at FROM nodes
           ORDER BY created_at DESC LIMIT ?`,
        )
    const rows = (
      sessionId ? stmt.all(sessionId, cap) : stmt.all(cap)
    ) as Array<{
      id: string
      text: string
      kind: string
      session_id: string | null
      created_at: string
    }>
    return rows.map(r => ({
      id: r.id,
      text: r.text,
      kind: r.kind as CausalNodeKind,
      sessionId: r.session_id,
      createdAt: r.created_at,
    }))
  } catch (err) {
    logForDebugging(
      `[causalGraph] getRecentFacts failed: ${(err as Error).message}`,
    )
    return []
  }
}

/** 图规模快照,供 /kernel-status / memory-audit 展示 */
export function getGraphStats(): GraphStats {
  const empty: GraphStats = { nodes: 0, edges: 0, byKind: {} }
  try {
    if (!isCausalGraphEnabled()) return empty
    const db = getDb()
    if (!db) return empty
    const nodesRow = db
      .query(`SELECT COUNT(*) AS c FROM nodes`)
      .get() as { c: number } | null
    const edgesRow = db
      .query(`SELECT COUNT(*) AS c FROM edges`)
      .get() as { c: number } | null
    const byKindRows = db
      .query(`SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind`)
      .all() as Array<{ kind: string; c: number }>
    const byKind: Record<string, number> = {}
    for (const r of byKindRows) byKind[r.kind] = r.c
    return {
      nodes: nodesRow?.c ?? 0,
      edges: edgesRow?.c ?? 0,
      byKind,
    }
  } catch (err) {
    logForDebugging(
      `[causalGraph] getGraphStats failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * 最早 node created_at(ISO 字符串)。供 shadow cutover readiness 计算
 * bake 时长,单查询 MIN,失败返回 null(fail-open)。
 */
export function getCausalGraphFirstSampleAt(): string | null {
  try {
    if (!isCausalGraphEnabled()) return null
    const db = getDb()
    if (!db) return null
    const row = db
      .query(`SELECT MIN(created_at) AS t FROM nodes`)
      .get() as { t: string | null } | null
    return row?.t ?? null
  } catch (err) {
    logForDebugging(
      `[causalGraph] getCausalGraphFirstSampleAt failed: ${(err as Error).message}`,
    )
    return null
  }
}

// ──────────────────────────────────────────────────────────────
// 消费者闭环 · E 线:getGraphStats + 最近事实 → /kernel-status 区块
// 设计:
//   - getCausalGraphSummary 做一次读取聚合,包含 mode + stats + 最近 N 条事实数
//   - formatCausalGraphSummaryLines 返回 string[],给 /kernel-status lines.push(...)
//   - 关闭且 stats 为 0 → 返回空数组(零回归)
//   - 任何异常 fail-open 返回空数组
// 与 memoryAudit Q10 的展示相比,这里只渲染核心指标,避免 /kernel-status 被刷屏
// ──────────────────────────────────────────────────────────────

export interface CausalGraphSummary {
  mode: 'off' | 'shadow' | 'on'
  enabled: boolean
  stats: GraphStats
  recentFactsCount: number
  recentEdgesCount: number
  /** 最近一条 fact 的 createdAt,便于判断是否仍活跃 */
  newestCreatedAt: string | null
}

export function getCausalGraphSummary(
  recentLimit = 20,
): CausalGraphSummary {
  const mode = getCausalGraphMode()
  const enabled = isCausalGraphEnabled()
  const empty: CausalGraphSummary = {
    mode,
    enabled,
    stats: { nodes: 0, edges: 0, byKind: {} },
    recentFactsCount: 0,
    recentEdgesCount: 0,
    newestCreatedAt: null,
  }
  try {
    if (!enabled) return empty
    const stats = getGraphStats()
    let recentFactsCount = 0
    let recentEdgesCount = 0
    let newestCreatedAt: string | null = null
    const db = getDb()
    if (db) {
      const cap = Math.max(1, Math.floor(recentLimit))
      const factsRow = db
        .query(
          `SELECT COUNT(*) AS c, MAX(created_at) AS t FROM nodes
           WHERE id IN (SELECT id FROM nodes ORDER BY created_at DESC LIMIT ?)`,
        )
        .get(cap) as { c: number; t: string | null } | null
      recentFactsCount = factsRow?.c ?? 0
      newestCreatedAt = factsRow?.t ?? null
      const edgesRow = db
        .query(
          `SELECT COUNT(*) AS c FROM edges
           WHERE id IN (SELECT id FROM edges ORDER BY created_at DESC LIMIT ?)`,
        )
        .get(cap) as { c: number } | null
      recentEdgesCount = edgesRow?.c ?? 0
    }
    return { mode, enabled, stats, recentFactsCount, recentEdgesCount, newestCreatedAt }
  } catch (err) {
    logForDebugging(
      `[causalGraph] getCausalGraphSummary failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * /kernel-status 消费者用:
 *   - off 且 nodes=0 → []
 *   - 否则渲染 1-3 行(标题 + byKind 分布 + 最新时间)
 *   - 异常统一返回空数组(fail-open)
 */
export function formatCausalGraphSummaryLines(
  opts: { indent?: string; recentLimit?: number } = {},
): string[] {
  try {
    const indent = opts.indent ?? '  '
    const s = getCausalGraphSummary(opts.recentLimit ?? 20)
    if (!s.enabled && s.stats.nodes === 0) return []
    const lines: string[] = []
    lines.push('### 🧠 Causal Graph (E-line shadow)')
    const kindParts = Object.entries(s.stats.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `${k}=${c}`)
    const kindStr = kindParts.length > 0 ? kindParts.join(', ') : 'n/a'
    lines.push(
      `${indent}mode: ${s.mode}  nodes=${s.stats.nodes}  edges=${s.stats.edges}  byKind: ${kindStr}`,
    )
    if (s.newestCreatedAt) {
      lines.push(
        `${indent}recent window(${opts.recentLimit ?? 20}): facts=${s.recentFactsCount}, edges=${s.recentEdgesCount}, newest=${s.newestCreatedAt}`,
      )
    }
    return lines
  } catch {
    return []
  }
}

// Re-exports 方便外部 import 单点
export { isCausalGraphEnabled, isCausalGraphOn, getCausalGraphMode } from './featureCheck.js'
export { closeDb as _closeCausalGraphDbForTesting } from './db.js'
export type {
  CausalNode,
  CausalEdge,
  CausalNodeKind,
  CausalEdgeKind,
  AddFactOpts,
  AddEdgeOpts,
  GraphStats,
} from './types.js'
