/**
 * ContextSignals · itemRoiLedger —— Phase D item 级 ROI 通用账本
 *
 * 目的:把 per-memory utility 的模式泛化到 file/tool/history/handoff/sideQuery 等
 * context item。当前提供轻量 item 级 ROI 累计、磁盘持久化和 admission 决策输入。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { AdmissionDecision } from './contextAdmissionController.js'
import type { ContextSignalKind } from './types.js'

export type ContextItemOutcome = 'served' | 'used' | 'unused' | 'missed' | 'harmful'

export type ContextItemRoiEvent = {
  ts: number
  contextItemId: string
  kind: ContextSignalKind
  anchors: ReadonlyArray<string>
  decisionPoint?: string
  admission?: AdmissionDecision
  outcome: ContextItemOutcome
}

export type ContextItemRoiRow = {
  contextItemId: string
  kind: ContextSignalKind
  servedCount: number
  usedCount: number
  harmfulCount: number
  lastOutcome: ContextItemOutcome
  lastSeenAt: number
}

export type ContextItemRoiSnapshot = {
  enabled: boolean
  persist: {
    enabled: boolean
    loaded: boolean
    path: string
  }
  tracked: number
  recent: ReadonlyArray<ContextItemRoiEvent>
  topUsed: ReadonlyArray<ContextItemRoiRow>
  deadWeight: ReadonlyArray<ContextItemRoiRow>
  admissionCount: number
  admissionByDecision: Readonly<Record<AdmissionDecision, number>>
  recentAdmission: ReadonlyArray<ContextItemRoiEvent>
}

const RING_CAPACITY = 200
const ring: ContextItemRoiEvent[] = []
const rows = new Map<string, ContextItemRoiRow>()

type PersistedFormat = {
  version: 1
  rows: ContextItemRoiRow[]
}
const PERSIST_VERSION = 1
let loadedFromDisk = false
let saveScheduled = false
let saveGeneration = 0

function getPersistPath(): string {
  return join(getClaudeConfigHomeDir(), 'context-item-roi-ledger.json')
}

function isPersistEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_ITEM_ROI_PERSIST ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_ITEM_ROI ?? '')
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
    if (!parsed || parsed.version !== PERSIST_VERSION || !Array.isArray(parsed.rows)) return
    for (const r of parsed.rows) {
      if (typeof r?.contextItemId !== 'string' || typeof r?.kind !== 'string') continue
      rows.set(r.contextItemId, {
        contextItemId: r.contextItemId,
        kind: r.kind,
        servedCount: Math.max(0, r.servedCount | 0),
        usedCount: Math.max(0, r.usedCount | 0),
        harmfulCount: Math.max(0, r.harmfulCount | 0),
        lastOutcome: r.lastOutcome,
        lastSeenAt: typeof r.lastSeenAt === 'number' ? r.lastSeenAt : 0,
      })
    }
  } catch {
    rows.clear()
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
      rows: [...rows.values()],
    }
    const path = getPersistPath()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
  } catch {
    // fail-open
  }
}

export function flushContextItemRoiLedgerNow(): void {
  flushToDisk()
}

export function recordContextItemRoiEvent(
  event: Omit<ContextItemRoiEvent, 'ts'> & { ts?: number },
): void {
  if (!isEnabled()) return
  ensureLoaded()
  try {
    if (!event.contextItemId || !event.kind) return
    const ev: ContextItemRoiEvent = {
      ts: event.ts ?? Date.now(),
      contextItemId: event.contextItemId,
      kind: event.kind,
      anchors: event.anchors ?? [],
      decisionPoint: event.decisionPoint,
      admission: event.admission,
      outcome: event.outcome,
    }
    ring.push(ev)
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY)

    const prev = rows.get(ev.contextItemId)
    const row: ContextItemRoiRow = prev ?? {
      contextItemId: ev.contextItemId,
      kind: ev.kind,
      servedCount: 0,
      usedCount: 0,
      harmfulCount: 0,
      lastOutcome: ev.outcome,
      lastSeenAt: ev.ts,
    }
    if (ev.outcome === 'served') row.servedCount += 1
    if (ev.outcome === 'used') row.usedCount += 1
    if (ev.outcome === 'harmful') row.harmfulCount += 1
    row.lastOutcome = ev.outcome
    row.lastSeenAt = ev.ts
    rows.set(ev.contextItemId, row)
    scheduleSave()
  } catch {
    // best-effort
  }
}

export function getContextItemRoiRow(contextItemId: string | undefined): ContextItemRoiRow | null {
  if (!contextItemId || !isEnabled()) return null
  ensureLoaded()
  return rows.get(contextItemId) ?? null
}

export function getContextItemRoiSnapshot(limit = 8): ContextItemRoiSnapshot {
  ensureLoaded()
  const all = [...rows.values()]
  const topUsed = [...all]
    .filter(r => r.usedCount > 0)
    .sort((a, b) => b.usedCount - a.usedCount || b.servedCount - a.servedCount)
    .slice(0, limit)
  const deadWeight = [...all]
    .filter(r => r.servedCount >= 3 && r.usedCount === 0)
    .sort((a, b) => b.servedCount - a.servedCount)
    .slice(0, limit)
  const admissionByDecision: Record<AdmissionDecision, number> = {
    skip: 0,
    index: 0,
    summary: 0,
    full: 0,
  }
  const admissionEvents = ring.filter(ev => ev.admission != null)
  for (const ev of admissionEvents) {
    if (!ev.admission) continue
    admissionByDecision[ev.admission] += 1
  }
  return {
    enabled: isEnabled(),
    persist: {
      enabled: isPersistEnabled(),
      loaded: loadedFromDisk,
      path: getPersistPath(),
    },
    tracked: rows.size,
    recent: ring.slice(-limit).reverse(),
    topUsed,
    deadWeight,
    admissionCount: admissionEvents.length,
    admissionByDecision,
    recentAdmission: admissionEvents.slice(-limit).reverse(),
  }
}

export function clearContextItemRoiLedger(): void {
  ring.length = 0
  rows.clear()
  loadedFromDisk = true
  saveScheduled = false
  saveGeneration += 1
}

export function getContextItemRoiLedgerPersistPath(): string {
  return getPersistPath()
}

export function __resetContextItemRoiLedgerForTests(): void {
  ring.length = 0
  rows.clear()
  loadedFromDisk = false
  saveScheduled = false
  saveGeneration += 1
}

export function __getContextItemRoiLedgerPersistPathForTests(): string {
  return getContextItemRoiLedgerPersistPath()
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
    // 注册失败不影响账本
  }
}
registerShutdownHook()
