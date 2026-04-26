/**
 * ContextSignals · Evidence Graph —— 轻量 source→entity→action→outcome 证据图
 *
 * 用途:把"是否被复述"升级为"是否推动了动作/结果"的观测层。
 * 当前提供 ring 证据记录、磁盘持久化、状态页可视化,并作为 admission/retirement 的证据输入。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { ContextSignalKind } from './types.js'

export type EvidenceNodeKind = 'source' | 'entity' | 'action' | 'outcome'

export type EvidenceEdge = {
  ts: number
  from: string
  to: string
  fromKind: EvidenceNodeKind
  toKind: EvidenceNodeKind
  relation: string
  contextItemId?: string
  sourceKind?: ContextSignalKind
}

export type EvidenceOutcomeBySourceKind = {
  sourceKind: ContextSignalKind | 'unknown'
  positive: number
  negative: number
  neutral: number
  topOutcomes: ReadonlyArray<{ outcome: string; count: number }>
}

export type EvidenceOutcomeSummary = {
  positive: number
  negative: number
  neutral: number
}

export type EvidenceGraphSnapshot = {
  enabled: boolean
  persist: {
    enabled: boolean
    loaded: boolean
    path: string
  }
  edgeCount: number
  recent: ReadonlyArray<EvidenceEdge>
  topRelations: ReadonlyArray<{ relation: string; count: number }>
  outcomeBySourceKind: ReadonlyArray<EvidenceOutcomeBySourceKind>
}

const RING_CAPACITY = 300
const edges: EvidenceEdge[] = []

type PersistedFormat = {
  version: 1
  edges: EvidenceEdge[]
}
const PERSIST_VERSION = 1
let loadedFromDisk = false
let saveScheduled = false
let saveGeneration = 0

function getPersistPath(): string {
  return join(getClaudeConfigHomeDir(), 'context-evidence-graph.json')
}

function isPersistEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_EVIDENCE_GRAPH_PERSIST ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_EVIDENCE_GRAPH ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

function ensureLoaded(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  if (!isPersistEnabled()) return
  try {
    const path = getPersistPath()
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedFormat
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.edges)) return
    for (const e of parsed.edges.slice(-RING_CAPACITY)) {
      if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || typeof e.relation !== 'string') continue
      edges.push({
        ts: typeof e.ts === 'number' ? e.ts : Date.now(),
        from: e.from,
        to: e.to,
        fromKind: e.fromKind,
        toKind: e.toKind,
        relation: e.relation,
        contextItemId: e.contextItemId,
        sourceKind: e.sourceKind,
      })
    }
  } catch {
    edges.length = 0
  }
}

function scheduleSave(): void {
  if (!isPersistEnabled()) return
  if (saveScheduled) return
  saveScheduled = true
  const generation = saveGeneration
  queueMicrotask(() => {
    saveScheduled = false
    if (generation !== saveGeneration) return
    flushToDisk()
  })
}

function flushToDisk(): void {
  if (!isPersistEnabled()) return
  if (!loadedFromDisk) return
  try {
    const payload: PersistedFormat = {
      version: PERSIST_VERSION,
      edges: edges.slice(-RING_CAPACITY),
    }
    const path = getPersistPath()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
  } catch {
    // fail-open
  }
}

export function flushEvidenceGraphNow(): void {
  flushToDisk()
}

export function recordEvidenceEdge(
  edge: Omit<EvidenceEdge, 'ts'> & { ts?: number },
): void {
  if (!isEnabled()) return
  ensureLoaded()
  try {
    if (!edge.from || !edge.to || !edge.relation) return
    edges.push({
      ts: edge.ts ?? Date.now(),
      from: edge.from,
      to: edge.to,
      fromKind: edge.fromKind,
      toKind: edge.toKind,
      relation: edge.relation,
      contextItemId: edge.contextItemId,
      sourceKind: edge.sourceKind,
    })
    if (edges.length > RING_CAPACITY) edges.splice(0, edges.length - RING_CAPACITY)
    scheduleSave()
  } catch {
    // best-effort
  }
}

function classifyOutcome(outcome: string): 'positive' | 'negative' | 'neutral' {
  if (/\b(ok|used|present|completed|success|verified)\b/i.test(outcome)) return 'positive'
  if (/\b(error|failed|missing|unused|aborted|skipped|harmful)\b/i.test(outcome)) return 'negative'
  return 'neutral'
}

export function getEvidenceOutcomeSummaryForContextItem(contextItemId: string): EvidenceOutcomeSummary {
  ensureLoaded()
  const summary: EvidenceOutcomeSummary = { positive: 0, negative: 0, neutral: 0 }
  for (const e of edges) {
    if (e.contextItemId !== contextItemId || e.toKind !== 'outcome') continue
    const cls = classifyOutcome(e.to)
    summary[cls] += 1
  }
  return summary
}

export function getEvidenceGraphSnapshot(limit = 8): EvidenceGraphSnapshot {
  ensureLoaded()
  const counts = new Map<string, number>()
  const outcomeBuckets = new Map<string, { positive: number; negative: number; neutral: number; outcomes: Map<string, number> }>()
  for (const e of edges) {
    counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1)
    if (e.toKind === 'outcome') {
      const sourceKind = e.sourceKind ?? 'unknown'
      const bucket = outcomeBuckets.get(sourceKind) ?? { positive: 0, negative: 0, neutral: 0, outcomes: new Map<string, number>() }
      const outcome = e.to
      bucket.outcomes.set(outcome, (bucket.outcomes.get(outcome) ?? 0) + 1)
      const cls = classifyOutcome(outcome)
      bucket[cls]++
      outcomeBuckets.set(sourceKind, bucket)
    }
  }
  const topRelations = [...counts.entries()]
    .map(([relation, count]) => ({ relation, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
  const outcomeBySourceKind = [...outcomeBuckets.entries()]
    .map(([sourceKind, bucket]) => ({
      sourceKind: sourceKind as ContextSignalKind | 'unknown',
      positive: bucket.positive,
      negative: bucket.negative,
      neutral: bucket.neutral,
      topOutcomes: [...bucket.outcomes.entries()]
        .map(([outcome, count]) => ({ outcome, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    }))
    .sort((a, b) => (b.positive + b.negative + b.neutral) - (a.positive + a.negative + a.neutral))
    .slice(0, limit)
  return {
    enabled: isEnabled(),
    persist: {
      enabled: isPersistEnabled(),
      loaded: loadedFromDisk,
      path: getPersistPath(),
    },
    edgeCount: edges.length,
    recent: edges.slice(-limit).reverse(),
    topRelations,
    outcomeBySourceKind,
  }
}

export function clearEvidenceGraph(): void {
  edges.length = 0
  loadedFromDisk = true
  saveScheduled = false
  saveGeneration += 1
}

export function getEvidenceGraphPersistPath(): string {
  return getPersistPath()
}

export function __resetEvidenceGraphForTests(): void {
  edges.length = 0
  loadedFromDisk = false
  saveScheduled = false
  saveGeneration += 1
}

export function __getEvidenceGraphPersistPathForTests(): string {
  return getEvidenceGraphPersistPath()
}

let shutdownHookRegistered = false
function registerShutdownHook(): void {
  if (shutdownHookRegistered) return
  shutdownHookRegistered = true
  try {
    registerCleanup(async () => {
      flushToDisk()
    })
    process.on('exit', () => {
      try { flushToDisk() } catch { /* fail-open */ }
    })
  } catch {
    // 注册失败不影响 evidence graph
  }
}
registerShutdownHook()
