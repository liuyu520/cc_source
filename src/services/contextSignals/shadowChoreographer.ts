/**
 * ContextSignals · Shadow Choreographer —— Phase 57(suggest-only)
 *
 * 定位: 把"上下文编舞"方法论以 **只读建议** 的形式先跑起来。
 *   不改真正的 prompt 拼接(那是 Phase 7x 的工作);
 *   只在现有账本基础上回答一个问题:
 *   "如果下次 turn budget 继续紧张, 应该先降级哪家 source?"
 *
 * 设计复用:
 * - 输入数据: getBudgetLedgerSnapshot() + getContextSignalsSnapshot()
 *   (Phase 55 + Phase 54 已产出)
 * - 行为模式: 同 services/contextCollapse/ 的 broker-shadow 口径, 只记事件不执行
 *
 * 建议规则(极简 v1, 后续 Phase 59 让 selector 自进化接替):
 *   R1. 若 latest budget ratio >= 阈值(默认 0.85) && 某 kind util < 50% && servedTokens 显著 → 建议 demote
 *   R2. 若 某 kind util >= 80% && tokens 极小(<100) → 建议 upgrade(目前没用,留位)
 *   R3. 其他 → no-op
 */

import { getBudgetLedgerSnapshot } from './budgetLedger.js'
import { getContextSignalsSnapshot } from './telemetry.js'
import type { ContextSignalKind } from './types.js'

export type ChoreographySuggestionKind = 'demote' | 'upgrade' | 'noop'

export type ChoreographySuggestion = {
  /** 目标 signal 家族 */
  target: ContextSignalKind
  kind: ChoreographySuggestionKind
  /** 0..1; 越接近 1 越建议执行 */
  confidence: number
  /** 规则可读说明, 给 /kernel-status 一眼看明白 */
  reason: string
  /** 生成时的关键度量 */
  metrics: {
    budgetRatio: number
    kindServedCount: number
    kindTokens: number
    kindUtilRate: number
  }
}

export type ShadowChoreographerState = {
  enabled: boolean
  /** 累计评估次数(每次 evaluate 调用 +1) */
  evaluated: number
  /** 最新一次建议列表(按 confidence 倒序) */
  lastSuggestions: ReadonlyArray<ChoreographySuggestion>
  lastEvaluatedAt: number
  /** 分规则命中累计 */
  ruleHits: Readonly<Record<'demote' | 'upgrade' | 'noop', number>>
}

// 环境开关
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_CHOREOGRAPHY_SHADOW ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

const BUDGET_PRESSURE_RATIO = 0.85
const LOW_UTIL_RATE = 0.5
const LOW_UTIL_MIN_SAMPLED = 3
const UPGRADE_HIGH_UTIL_RATE = 0.8
const UPGRADE_SMALL_TOKENS = 100

let evaluatedCount = 0
let lastSuggestions: ChoreographySuggestion[] = []
let lastEvaluatedAt = 0
const ruleHits = { demote: 0, upgrade: 0, noop: 0 }

// Phase 59(2026-04-24)—— Shadow 建议的跨 turn 聚合账本。
// 为 Pattern Miner 的 context-selector 源提供"某 kind 在最近窗口被反复要求 demote/upgrade"
// 的可验证证据;仅当累计次数跨过阈值才进入 Pattern Miner 三道门。
//
// 口径:
//   - aggKey = `${target}::${kind}`,忽略 noop(那是 non-signal)
//   - totalConfidence 用于算 avg conf;last* 字段供 Miner 产出 rationale。
//   - 上限 SUGGESTION_AGG_MAX,溢出按 lastEmittedAt 最旧淘汰(LRU by last write)。
export type ShadowSuggestionAggregate = {
  target: ContextSignalKind
  kind: Exclude<ChoreographySuggestionKind, 'noop'>
  totalEmitted: number
  totalConfidence: number
  firstEmittedAt: number
  lastEmittedAt: number
  lastConfidence: number
  lastReason: string
}

const SUGGESTION_AGG_MAX = 64
const suggestionAggregates = new Map<string, ShadowSuggestionAggregate>()

function aggKey(
  target: ContextSignalKind,
  kind: Exclude<ChoreographySuggestionKind, 'noop'>,
): string {
  return `${target}::${kind}`
}

function recordSuggestionAggregate(s: ChoreographySuggestion): void {
  if (s.kind === 'noop') return
  const key = aggKey(s.target, s.kind)
  const now = Date.now()
  const prev = suggestionAggregates.get(key)
  if (prev) {
    prev.totalEmitted += 1
    prev.totalConfidence += s.confidence
    prev.lastEmittedAt = now
    prev.lastConfidence = s.confidence
    prev.lastReason = s.reason
    return
  }
  if (suggestionAggregates.size >= SUGGESTION_AGG_MAX) {
    // LRU-by-lastEmittedAt eviction;Map 迭代有序但是按插入序,所以遍历找最旧
    let evictKey: string | null = null
    let evictAt = Number.POSITIVE_INFINITY
    for (const [k, v] of suggestionAggregates) {
      if (v.lastEmittedAt < evictAt) {
        evictAt = v.lastEmittedAt
        evictKey = k
      }
    }
    if (evictKey !== null) suggestionAggregates.delete(evictKey)
  }
  suggestionAggregates.set(key, {
    target: s.target,
    kind: s.kind,
    totalEmitted: 1,
    totalConfidence: s.confidence,
    firstEmittedAt: now,
    lastEmittedAt: now,
    lastConfidence: s.confidence,
    lastReason: s.reason,
  })
}

/**
 * Phase 59 读取点 —— 供 Pattern Miner 的 context-selector 源使用。
 * windowMs<=0 或 undefined → 返回所有已知 aggregate(不做时间过滤)。
 */
export function getShadowSuggestionAggregates(
  windowMs?: number,
): ReadonlyArray<ShadowSuggestionAggregate> {
  const now = Date.now()
  const cutoff = windowMs && windowMs > 0 ? now - windowMs : -1
  const out: ShadowSuggestionAggregate[] = []
  for (const v of suggestionAggregates.values()) {
    if (cutoff > 0 && v.lastEmittedAt < cutoff) continue
    // 返回副本,避免调用方就地改动账本
    out.push({ ...v })
  }
  return out
}

/**
 * 触发一次 shadow 评估。幂等调用; 可由 /kernel-status 拉动, 也可由
 * 未来 Phase 59 周期任务主动拉动。
 *
 * 返回本次生成的 suggestions(按 confidence 倒序)。
 */
export function evaluateShadowChoreography(): ReadonlyArray<ChoreographySuggestion> {
  if (!isEnabled()) return []
  try {
    evaluatedCount += 1
    lastEvaluatedAt = Date.now()
    const budget = getBudgetLedgerSnapshot()
    const signals = getContextSignalsSnapshot()

    const ratio = budget.latest?.ratio ?? 0
    const suggestions: ChoreographySuggestion[] = []

    for (const k of signals.byKind) {
      const sampled = k.utilizedCount + k.notUtilizedCount
      const metrics = {
        budgetRatio: ratio,
        kindServedCount: k.servedCount,
        kindTokens: k.totalTokens,
        kindUtilRate: sampled > 0 ? k.utilizationRate : -1,
      }
      // R1: 降级建议 —— 预算紧张 + 利用率低 + 占用 tokens 显著
      if (
        ratio >= BUDGET_PRESSURE_RATIO &&
        sampled >= LOW_UTIL_MIN_SAMPLED &&
        k.utilizationRate < LOW_UTIL_RATE &&
        k.totalTokens >= 500
      ) {
        // confidence 与 budget 紧张程度、token 占用、低利用率三者相关
        const confidence = Math.min(
          1,
          0.4 +
            (ratio - BUDGET_PRESSURE_RATIO) * 2 +
            (LOW_UTIL_RATE - k.utilizationRate) * 0.5 +
            Math.min(0.2, k.totalTokens / 10000),
        )
        suggestions.push({
          target: k.kind,
          kind: 'demote',
          confidence,
          reason:
            `budget ratio=${(ratio * 100).toFixed(0)}% >= ${(BUDGET_PRESSURE_RATIO * 100).toFixed(0)}% ` +
            `and kind='${k.kind}' util=${(k.utilizationRate * 100).toFixed(0)}% (sampled=${sampled}) ` +
            `but costs ${k.totalTokens} tokens across ${k.servedCount} served`,
          metrics,
        })
        ruleHits.demote += 1
        continue
      }
      // R2: 升级建议 —— 利用率高 + tokens 极小(说明只送了索引, 可以多给)
      if (
        sampled >= LOW_UTIL_MIN_SAMPLED &&
        k.utilizationRate >= UPGRADE_HIGH_UTIL_RATE &&
        k.totalTokens > 0 &&
        k.totalTokens < UPGRADE_SMALL_TOKENS
      ) {
        const confidence = Math.min(
          1,
          0.3 + (k.utilizationRate - UPGRADE_HIGH_UTIL_RATE) * 2,
        )
        suggestions.push({
          target: k.kind,
          kind: 'upgrade',
          confidence,
          reason:
            `kind='${k.kind}' util=${(k.utilizationRate * 100).toFixed(0)}% (sampled=${sampled}) ` +
            `but only ${k.totalTokens} tokens — worth sending more detail`,
          metrics,
        })
        ruleHits.upgrade += 1
        continue
      }
      // R3: no-op
      ruleHits.noop += 1
    }

    suggestions.sort((a, b) => b.confidence - a.confidence)
    lastSuggestions = suggestions
    // Phase 59:累计到 aggregate 账本,供 Pattern Miner 跨 turn 看齐。
    for (const s of suggestions) recordSuggestionAggregate(s)
    return suggestions
  } catch {
    return []
  }
}

export function getShadowChoreographerState(): ShadowChoreographerState {
  return {
    enabled: isEnabled(),
    evaluated: evaluatedCount,
    lastSuggestions,
    lastEvaluatedAt,
    ruleHits: { ...ruleHits },
  }
}

export function __resetShadowChoreographerForTests(): void {
  evaluatedCount = 0
  lastSuggestions = []
  lastEvaluatedAt = 0
  ruleHits.demote = 0
  ruleHits.upgrade = 0
  ruleHits.noop = 0
  suggestionAggregates.clear()
}
