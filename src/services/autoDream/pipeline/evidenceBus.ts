/**
 * Evidence Convergence Bus — 跨域证据汇聚总线
 *
 * 设计理念（睡眠巩固理论）：
 * 大脑中的海马体在睡眠时将分散的短期记忆轨迹（episodic traces）
 * 统一回放给新皮层进行长期巩固。本模块是 auto-dream 系统的"海马体"，
 * 将 RCA、PEV、Router、Context 等分散的证据流统一汇入 EvidenceLedger，
 * 为后续的 triage 评分和 micro/full dream 巩固提供统一数据源。
 *
 * 解决的问题：
 *   1. RCA 证据 (~/.claude/rca/evidence.ndjson) 与 EvidenceLedger 完全隔离
 *   2. Dream Journal (~/.claude/dream/journal.ndjson) 独立于 EvidenceLedger
 *   3. PEV blast radius 仅存内存，不持久化
 *   4. 跨域无法关联查询
 *
 * 策略：双写兼容 — 同时写入原有独立存储（向后兼容）+ EvidenceLedger（统一查询）
 */

import { logForDebugging } from '../../../utils/debug.js'
import type { EvidenceEntry } from '../../harness/evidenceLedgerTypes.js'
import type { DreamEvidence } from './types.js'

// 延迟加载 EvidenceLedger（避免循环依赖，失败静默）
let _ledger: { append: (entry: EvidenceEntry) => void } | null | undefined

async function getLedger() {
  if (_ledger !== undefined) return _ledger
  try {
    const mod = await import('../../harness/index.js')
    _ledger = mod.EvidenceLedger
    return _ledger
  } catch {
    _ledger = null
    return null
  }
}

/**
 * 将 DreamEvidence 同时写入 Dream Journal（原有路径）和 EvidenceLedger（新增路径）
 */
export async function convergeDreamEvidence(ev: DreamEvidence): Promise<void> {
  try {
    // 路径 1：原有 Dream Journal（向后兼容）
    const { captureEvidence } = await import('./journal.js')
    captureEvidence(ev)

    // 路径 2：EvidenceLedger dream domain（新增统一入口）
    const ledger = await getLedger()
    if (ledger) {
      ledger.append({
        ts: ev.endedAt || new Date().toISOString(),
        domain: 'dream',
        kind: 'session_evidence',
        sessionId: ev.sessionId,
        data: {
          durationMs: ev.durationMs,
          novelty: ev.novelty,
          conflicts: ev.conflicts,
          userCorrections: ev.userCorrections,
          surprise: ev.surprise,
          toolErrorRate: ev.toolErrorRate,
          filesTouched: ev.filesTouched,
          memoryTouched: ev.memoryTouched,
          hasEpisodicPayload: Boolean(ev.episodicPayload),
        },
      })
    }
    // 路径 3:autoEvolve Fitness Oracle(Phase 3 新增)
    //   纯观察:把 DreamEvidence 映射成 FitnessInput,追加一条带签名的
    //   FitnessScore 到 ~/.claude/autoEvolve/oracle/fitness.ndjson。
    //   失败内部消化,绝不影响 Dream 主路径。
    try {
      const { observeDreamEvidence } = await import(
        '../../autoEvolve/oracle/fitnessObserver.js'
      )
      await observeDreamEvidence(ev)
    } catch (e) {
      logForDebugging(
        `[EvidenceBus] observeDreamEvidence skipped: ${(e as Error).message}`,
      )
    }
  } catch (e) {
    logForDebugging(`[EvidenceBus] convergeDreamEvidence failed: ${(e as Error).message}`)
  }
}

/**
 * 将 RCA 证据桥接写入 EvidenceLedger 的 rca domain
 * （原有 rca/evidenceStore.ts 的写入继续保留）
 */
export async function convergeRCAEvidence(evidence: {
  id: string
  kind: string
  summary: string
  toolName?: string
  turnIdx: number
  supports: string[]
  contradicts: string[]
  sessionId: string
}): Promise<void> {
  try {
    const ledger = await getLedger()
    if (!ledger) return

    ledger.append({
      ts: new Date().toISOString(),
      domain: 'dream', // RCA 证据也流入 dream domain，作为 triage 的输入信号
      kind: 'rca_observation',
      sessionId: evidence.sessionId,
      data: {
        evidenceId: evidence.id,
        evidenceKind: evidence.kind,
        summary: evidence.summary,
        toolName: evidence.toolName,
        turnIdx: evidence.turnIdx,
        supportsCount: evidence.supports.length,
        contradictsCount: evidence.contradicts.length,
      },
    })
  } catch (e) {
    logForDebugging(`[EvidenceBus] convergeRCAEvidence failed: ${(e as Error).message}`)
  }
}

/**
 * 将 PEV blast radius 分析结果写入 EvidenceLedger
 * （补全现有 PEV 不写 EvidenceLedger 的缺口）
 */
export async function convergePEVBlastRadius(radius: {
  command: string
  reversibility: string
  effects: string[]
  affectedPaths: string[]
  sessionId?: string
}): Promise<void> {
  try {
    const ledger = await getLedger()
    if (!ledger) return

    ledger.append({
      ts: new Date().toISOString(),
      domain: 'pev',
      kind: 'blast_radius_preview',
      sessionId: radius.sessionId,
      data: {
        command: radius.command.slice(0, 200), // 截断防止过大
        reversibility: radius.reversibility,
        effectCount: radius.effects.length,
        effects: radius.effects.slice(0, 5),
        affectedPathCount: radius.affectedPaths.length,
      },
    })
  } catch (e) {
    logForDebugging(`[EvidenceBus] convergePEVBlastRadius failed: ${(e as Error).message}`)
  }
}

/**
 * 跨域关联查询：聚合指定 session 在所有 domain 的证据摘要
 * 供 microDream 的 focused consolidation 使用
 */
export async function querySessionEvidenceSummary(sessionId: string): Promise<{
  dreamEvents: number
  rcaObservations: number
  pevPreviews: number
  routerDecisions: number
  contextRehydrates: number
} | null> {
  try {
    const ledger = await getLedger()
    if (!ledger) return null

    const mod = await import('../../harness/evidenceLedger.js')
    const impl = mod.EvidenceLedger as {
      query: (domain: string, opts?: { kind?: string }) => Array<{ sessionId?: string }>
    }

    const countInDomain = (domain: string, kind?: string) => {
      try {
        const entries = impl.query(domain, kind ? { kind } : {})
        return entries.filter(e => e.sessionId === sessionId).length
      } catch {
        return 0
      }
    }

    return {
      dreamEvents: countInDomain('dream', 'session_evidence'),
      rcaObservations: countInDomain('dream', 'rca_observation'),
      pevPreviews: countInDomain('pev', 'blast_radius_preview'),
      routerDecisions: countInDomain('router', 'route_decision'),
      contextRehydrates: countInDomain('context', 'rehydrate'),
    }
  } catch {
    return null
  }
}
