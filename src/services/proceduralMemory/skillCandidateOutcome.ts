/**
 * G6 Step 4(2026-04-26)skill candidate emit outcome tracker
 *
 *   用途:把 /skill-candidates --emit --apply 成功落盘的 shadow organism 记录下来,
 *         再与 organism-invocation ledger 做 join,统计 N 天后 emitted shadow 是否
 *         被调用,产出"emit → 真实使用率"闭环数据,喂给 miner/promoter 决策。
 *
 *   设计:
 *     - recordSkillCandidateEmit:每个 manifest 写一行 {at, manifestId, kind,
 *       candidateName, support, successRate, confidence, score, status, pid}。
 *     - summarizeSkillCandidateOutcomes:读 emit ledger + organism-invocation ledger,
 *       以 manifestId 为 join key,计算每条 emitted shadow 的 invokedCount、
 *       firstInvokedAt、lastInvokedAt、ageDays、dormant(age≥阈值且 invokedCount=0)。
 *
 *   约束:
 *     - 默认写入,但 CLAUDE_SKILL_CANDIDATE_EMIT_LEDGER=off 关闭;
 *     - shadow-only:不改现有 emit/apply 流程行为;
 *     - fail-open:所有异常吞掉,不影响主调用;
 *     - 不改 arenaController/compileCandidates 主流程,仅追加旁路。
 *
 *   与 G2 organism-invocation ledger 的关系:
 *     - G2 记的是每次 invoke 的时序事件(organismId + status + kind);
 *     - 本模块记的是 shadow 被生产(emit)的时序事件;
 *     - 组合后可回答:"近 N 天 emit 的 shadow,有多少被调用过?"
 */

import * as fs from 'node:fs'
import { appendJsonLine } from '../autoEvolve/oracle/ndjsonLedger.js'
import {
  getSkillCandidateEmitLedgerPath,
  getOrganismInvocationLedgerPath,
} from '../autoEvolve/paths.js'
import { logForDebugging } from '../../utils/debug.js'

export interface SkillCandidateEmitRecord {
  manifestId: string
  kind: string
  candidateName: string
  support: number
  successRate: number
  confidence: number
  score: number
  status: string
}

/** 环境开关:off/0/false 时完全不写。默认写入。*/
function isEmitLedgerEnabled(): boolean {
  const raw = (process.env.CLAUDE_SKILL_CANDIDATE_EMIT_LEDGER ?? '')
    .toString()
    .trim()
    .toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}

/**
 * 写一条 emit 事件到 skill-candidate-emit.ndjson。
 * 返回 true 表示已追加,false 表示被开关关闭或写失败。永远不抛。
 */
export function recordSkillCandidateEmit(
  ev: SkillCandidateEmitRecord,
): boolean {
  if (!isEmitLedgerEnabled()) return false
  try {
    const payload = {
      at: new Date().toISOString(),
      manifestId: ev.manifestId,
      kind: ev.kind,
      candidateName: ev.candidateName,
      support: ev.support,
      successRate: ev.successRate,
      confidence: ev.confidence,
      score: ev.score,
      status: ev.status,
      pid: process.pid,
    }
    return appendJsonLine(getSkillCandidateEmitLedgerPath(), payload)
  } catch (e) {
    logForDebugging(
      `[skillCandidateOutcome] emit append failed: ${(e as Error).message}`,
    )
    return false
  }
}

export interface SkillCandidateOutcomeRow {
  manifestId: string
  kind: string
  candidateName: string
  emittedAt: string
  ageHours: number
  invokedCount: number
  firstInvokedAt: string | null
  lastInvokedAt: string | null
  dormant: boolean
}

export interface SkillCandidateOutcomeSummary {
  windowHours: number
  dormantAgeHours: number
  totalEmitted: number
  totalInvoked: number
  totalDormant: number
  rows: SkillCandidateOutcomeRow[]
}

function parseNdjson(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  try {
    if (!fs.existsSync(path)) return out
    const raw = fs.readFileSync(path, 'utf-8')
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        const o = JSON.parse(s)
        if (o && typeof o === 'object') out.push(o as Record<string, unknown>)
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    /* fail-open */
  }
  return out
}

/**
 * 读 emit ledger × organism-invocation ledger,返回每条 emitted shadow 的 outcome。
 *
 * @param opts.windowHours    emit 过滤窗口(小时);默认 168h (7d)
 * @param opts.dormantAgeHours 判定 dormant 的最小 age;默认 72h (3d)
 * @param opts.now            注入用于测试的"当前时间"(毫秒);默认 Date.now()
 * @param opts.maxRows        最多返回多少 emit 行;默认 200
 */
export function summarizeSkillCandidateOutcomes(opts?: {
  windowHours?: number
  dormantAgeHours?: number
  now?: number
  maxRows?: number
}): SkillCandidateOutcomeSummary {
  const windowHours = Math.max(1, opts?.windowHours ?? 168)
  const dormantAgeHours = Math.max(1, opts?.dormantAgeHours ?? 72)
  const nowMs = opts?.now ?? Date.now()
  const maxRows = Math.max(1, Math.floor(opts?.maxRows ?? 200))
  const emitCutoff = nowMs - windowHours * 3600 * 1000

  // 1) 读 emit ledger,过滤进窗,manifestId 去重保留最后一次 emit(同 id 重 emit 时以最新为准)。
  const emits = parseNdjson(getSkillCandidateEmitLedgerPath())
  const latestEmit = new Map<string, Record<string, unknown>>()
  for (const r of emits) {
    const atStr = typeof r.at === 'string' ? r.at : null
    const manifestId = typeof r.manifestId === 'string' ? r.manifestId : null
    if (!atStr || !manifestId) continue
    const atMs = Date.parse(atStr)
    if (!Number.isFinite(atMs) || atMs < emitCutoff) continue
    const prev = latestEmit.get(manifestId)
    const prevAt = prev ? Date.parse(String(prev.at ?? '')) : -Infinity
    if (!prev || atMs > prevAt) latestEmit.set(manifestId, r)
  }

  // 2) 读 organism-invocation ledger,按 organismId 聚合 count / first / last。
  const invokes = parseNdjson(getOrganismInvocationLedgerPath())
  const invokeAgg = new Map<
    string,
    { count: number; first: number; last: number }
  >()
  for (const r of invokes) {
    const organismId = typeof r.organismId === 'string' ? r.organismId : null
    const atStr = typeof r.at === 'string' ? r.at : null
    if (!organismId || !atStr) continue
    const atMs = Date.parse(atStr)
    if (!Number.isFinite(atMs)) continue
    const cur = invokeAgg.get(organismId)
    if (!cur) {
      invokeAgg.set(organismId, { count: 1, first: atMs, last: atMs })
    } else {
      cur.count++
      if (atMs < cur.first) cur.first = atMs
      if (atMs > cur.last) cur.last = atMs
    }
  }

  // 3) join — emit × invoke。dormant 仅对 age ≥ dormantAgeHours 的记录做判定。
  const rows: SkillCandidateOutcomeRow[] = []
  for (const [manifestId, emit] of latestEmit) {
    const atStr = String(emit.at ?? '')
    const atMs = Date.parse(atStr)
    const ageHours =
      Number.isFinite(atMs) && atMs > 0
        ? Math.max(0, (nowMs - atMs) / 3600 / 1000)
        : 0
    const agg = invokeAgg.get(manifestId)
    const invokedCount = agg?.count ?? 0
    const firstInvokedAt = agg ? new Date(agg.first).toISOString() : null
    const lastInvokedAt = agg ? new Date(agg.last).toISOString() : null
    const dormant = invokedCount === 0 && ageHours >= dormantAgeHours
    rows.push({
      manifestId,
      kind: String(emit.kind ?? ''),
      candidateName: String(emit.candidateName ?? ''),
      emittedAt: atStr,
      ageHours: Math.round(ageHours * 10) / 10,
      invokedCount,
      firstInvokedAt,
      lastInvokedAt,
      dormant,
    })
  }

  // 4) 排序:dormant 优先(暴露问题),其次按 age 降序。
  rows.sort((a, b) => {
    if (a.dormant !== b.dormant) return a.dormant ? -1 : 1
    return b.ageHours - a.ageHours
  })

  const capped = rows.slice(0, maxRows)
  const totalInvoked = rows.filter(r => r.invokedCount > 0).length
  const totalDormant = rows.filter(r => r.dormant).length

  return {
    windowHours,
    dormantAgeHours,
    totalEmitted: rows.length,
    totalInvoked,
    totalDormant,
    rows: capped,
  }
}
