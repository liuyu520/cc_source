/**
 * ContextSignals · ContextAdmissionController —— Phase A shadow gate (2026-04-24)
 *
 * 目标:把现有 ContextSignals / BudgetLedger / RegretHunger 从"事后建议"推进到
 * "事前准入判定"的影子层。当前阶段只记录 shadow 决策,绝不改变真实上下文注入。
 *
 * 安全边界:
 *   - 默认只读、fail-open。任何异常都返回 full / keep-current。
 *   - admission ring 默认内存态;retirement 文件只有显式 env 开启时才落盘。
 *   - 只调用 advisoryHistory 的纯读取 chronic snapshot,不推进 streak generation。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { getBudgetLedgerSnapshot } from './budgetLedger.js'
import { computeSourceEconomics } from './regretHunger.js'
import { getContextSignalsSnapshot } from './telemetry.js'
import { getEvidenceOutcomeSummaryForContextItem, recordEvidenceEdge } from './evidenceGraph.js'
import { getChronicAdvisoryCandidates } from './advisoryHistory.js'
import { getContextItemRoiRow } from './itemRoiLedger.js'
import type { ContextSignalKind } from './types.js'

export type AdmissionDecision = 'skip' | 'index' | 'summary' | 'full'

export type AdmissionInput = {
  kind: ContextSignalKind
  /** 单条上下文 item 的稳定标识;没有 item 粒度时可用 kind 聚合 key */
  contextItemId?: string
  /** 当前决策点,例如 toolExecution.success / getRelevantMemoryAttachments */
  decisionPoint?: string
  estimatedTokens: number
  /** 调用方原本准备注入的层级;用于 shadow 对比,不改变真实行为 */
  currentLevel?: 'index' | 'summary' | 'full'
  /** prompt-cache 编排提示:稳定块尽量进 cache 前缀,volatile 放尾部 */
  cacheClass?: 'stable' | 'semi-stable' | 'volatile'
  anchors?: ReadonlyArray<string>
  meta?: Readonly<Record<string, string | number | boolean>>
}

export type AdmissionOutcome = {
  ts: number
  kind: ContextSignalKind
  contextItemId?: string
  decisionPoint?: string
  estimatedTokens: number
  currentLevel?: 'index' | 'summary' | 'full'
  cacheClass?: 'stable' | 'semi-stable' | 'volatile'
  decision: AdmissionDecision
  confidence: number
  reason: string
  shadowOnly: true
  metrics: {
    budgetRatio: number
    bias: -1 | 0 | 1
    utilizationRate: number
    sampledCount: number
  }
}

export type ContextAdmissionRetirementCandidate = {
  key: string
  kind: ContextSignalKind
  decision: AdmissionDecision
  count: number
  avgConfidence: number
  reason: string
  evidence: {
    positive: number
    negative: number
    neutral: number
  }
}

export type CacheClassAdmissionStats = {
  cacheClass: 'stable' | 'semi-stable' | 'volatile' | 'unknown'
  count: number
  tokens: number
  byDecision: Readonly<Record<AdmissionDecision, number>>
}

export type PromptCacheChurnRisk = {
  level: 'low' | 'medium' | 'high'
  volatileTokens: number
  volatileFullTokens: number
  volatileFullEvents: number
  stableTokens: number
  reason: string
}

export type PromptCacheChurnOffender = {
  key: string
  kind: ContextSignalKind
  count: number
  tokens: number
  decisionPoint?: string
}

export type ContextAdmissionSnapshot = {
  enabled: boolean
  toolResultExecutionEnabled: boolean
  autoMemoryExecutionEnabled: boolean
  fileAttachmentExecutionEnabled: boolean
  historyCompactExecutionEnabled: boolean
  sideQueryExecutionEnabled: boolean
  handoffManifestExecutionEnabled: boolean
  retirementPersistenceEnabled: boolean
  ringCapacity: number
  count: number
  recent: ReadonlyArray<AdmissionOutcome>
  byDecision: Readonly<Record<AdmissionDecision, number>>
  byCacheClass: ReadonlyArray<CacheClassAdmissionStats>
  promptCacheChurnRisk: PromptCacheChurnRisk
  promptCacheChurnOffenders: ReadonlyArray<PromptCacheChurnOffender>
  retirementCandidates: ReadonlyArray<ContextAdmissionRetirementCandidate>
  persistedRetirementCandidates: ReadonlyArray<PersistedContextAdmissionRetirementCandidate>
  // Phase G 闭环观测(2026-04-25):统计 ring 中被 evidence-informed 规则触发的 admission 次数。
  // 来源是 reason 前缀匹配(避免破坏性扩展 AdmissionOutcome 结构),仅用于 observability。
  evidenceInformed: {
    total: number
    byDecision: Readonly<Record<AdmissionDecision, number>>
    lastAt: number | null
  }
}

export type PersistedContextAdmissionRetirementCandidate = ContextAdmissionRetirementCandidate & {
  firstSeenAt: string
  lastSeenAt: string
  seenCount: number
}

export type ContextAdmissionRetirementFile = {
  version: 1
  candidates: PersistedContextAdmissionRetirementCandidate[]
}

const RING_CAPACITY = 100
const RETIREMENT_FILE_LIMIT = 100
const CHRONIC_ADVISORY_RETIREMENT_STREAK = 5
const ring: AdmissionOutcome[] = []

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW ?? '')
    .trim()
    .toLowerCase()
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

function isOnValue(v: string): boolean {
  return v === 'on' || v === 'true' || v === '1' || v === 'yes'
}

function isOffValue(v: string): boolean {
  return v === 'off' || v === 'false' || v === '0' || v === 'no'
}

/**
 * 三态开关:显式 off > 显式 on > 默认值。
 * 用于 Phase B/C 等已经渡过 shadow+opt-in 期的执行型准入闸门,
 * 把"默认关闭"安全迁移到"默认开启但可显式关闭"。
 * 参见 feedback_signal_to_decision_priority_stack:
 *   显式 opts > env=off > auto-gate > env default。
 */
function resolveThreeStateFlag(rawEnv: string | undefined, defaultOn: boolean): boolean {
  const raw = (rawEnv ?? '').trim().toLowerCase()
  if (isOffValue(raw)) return false
  if (isOnValue(raw)) return true
  return defaultOn
}

/**
 * Phase B tool-result admission 执行闸门。
 * 历史:2026-04-24 以 opt-in 形式落地(env=on 才执行)。
 * 2026-04-25 经 shadow+opt-in soak 后提升为 default-on:
 *   - 决策路径包裹 try/catch, 异常 fail-open 到原有 Ph56 refinery。
 *   - admission=full 路径只"恢复原始内容"(用更多 token, 安全方向)。
 *   - admission!=full 路径只对已 >8KB 的输出做 summary, 与既有裁剪阈值一致。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT=off 回退后门。
 */
export function isToolResultAdmissionExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT, true)
}

/**
 * Phase C auto-memory admission 执行闸门。
 * 2026-04-25 从 opt-in 提升为 default-on:
 *   - 只过滤 itemRoiLedger/memoryUtilityLedger 累计的 dead-weight(served≥3 & used=0)。
 *   - 若全部被过滤,强制保留 memories[0] 作为安全网。
 *   - admission 计算失败会 fall-through 到原 memories(fail-open)。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY=off 回退后门。
 */
export function isAutoMemoryAdmissionExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY, true)
}

/**
 * Phase C-G · file-attachment admission 执行闸门。
 * 2026-04-25 从 opt-in 提升为 default-on:
 *   - 入口 currentLevel='full'; admission 规则在 current=full 下只会降到 'summary',
 *     不会直接到 'index' 或 'skip'(Rule 1 full→summary; Rule 3a 要求 kind regret
 *     + budget≥85% + tokens≥800; Rule 4 要求 budget≥92% + tokens≥2000)。
 *   - 'summary' 走 buildFileAttachmentSummary,保留文件名、行数、符号表、前 40 行;
 *     对新文件(无 item ROI)所有规则都跳过,decision 保持 'full',无行为变化。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT=off 回退后门。
 */
export function isFileAttachmentAdmissionExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT, true)
}

/**
 * Phase C-G+ · history-compact admission 执行闸门。
 * 2026-04-25 从 opt-in 提升为 default-on:
 *   - 入口 currentLevel='summary'; Rule 1(harmful>0)对 history-compact 不触发
 *     (harmful 事件全局仅 handoff 失败时产生,其他 kind 恒 0)。
 *   - Rule 3b(regret + budget≥85% + tokens≥200 + current=summary)时降 'index',
 *     placeholder 里带 ContextRehydrate 提示 + 280 字 snippet(见 contextCollapse/index.ts)。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT=off 回退后门。
 */
export function isHistoryCompactAdmissionExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT, true)
}

export function isContextAdmissionRetirementPersistenceEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_ADMISSION_PERSIST_RETIREMENT ?? '')
    .trim()
    .toLowerCase()
  return isOnValue(raw)
}

/**
 * Phase E SideQuery admission 执行闸门。
 * 2026-04-25 从 opt-in 提升为 default-on:
 *   - admission 规则不产生 'skip' 决策(最多 summary/index/full),
 *     所以 SideQuery.submit 里的"skip P2/P3"分支在现网始终是 no-op。
 *   - 真正生效的只有 hunger→P1 提升 和 regret→P3 降级 两条路径,
 *     两者都是优先级平移,不会隐藏任何 SideQuery 结果,信息量守恒。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY=off 回退后门。
 */
export function isSideQueryAdmissionExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY, true)
}

/**
 * Phase F · Handoff Manifest 执行闸门。
 * 2026-04-25 从 opt-in 提升为 default-on:
 *   - 只在 AgentTool.call 主链上给子 agent prompt 追加一小段 <handoff-manifest>
 *     摘要(budget、top kinds、anchors + constraints/validation/return_contract),
 *     约 200 tokens,不剥离任何原有内容,纯"coaching"型指令。
 *   - failure 仍由 try/catch 包裹,抛错直接 fall-through 到原 prompt。
 *   - 仍保留 CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST=off 回退后门。
 */
export function isHandoffManifestExecutionEnabled(): boolean {
  return resolveThreeStateFlag(process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST, true)
}

function getClaudeConfigBaseDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export function getContextAdmissionRetirementPath(): string {
  return join(getClaudeConfigBaseDir(), 'autoEvolve', 'oracle', 'context-admission-retirement.json')
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function readPersistedRetirementFile(): ContextAdmissionRetirementFile {
  try {
    const path = getContextAdmissionRetirementPath()
    if (!existsSync(path)) return { version: 1, candidates: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContextAdmissionRetirementFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.candidates)) {
      return { version: 1, candidates: [] }
    }
    return {
      version: 1,
      candidates: parsed.candidates
        .filter(c => typeof c?.key === 'string')
        .map(c => ({
          ...c,
          evidence: c.evidence ?? { positive: 0, negative: 0, neutral: 0 },
        }) as PersistedContextAdmissionRetirementCandidate),
    }
  } catch {
    return { version: 1, candidates: [] }
  }
}

function persistRetirementCandidates(candidates: ReadonlyArray<ContextAdmissionRetirementCandidate>): PersistedContextAdmissionRetirementCandidate[] {
  const existing = readPersistedRetirementFile()
  const now = new Date().toISOString()
  const byKey = new Map<string, PersistedContextAdmissionRetirementCandidate>()
  for (const c of existing.candidates) byKey.set(c.key, c)
  for (const c of candidates) {
    const prev = byKey.get(c.key)
    byKey.set(c.key, {
      ...c,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenCount: (prev?.seenCount ?? 0) + 1,
    })
  }
  const merged = Array.from(byKey.values())
    .sort((a, b) => b.seenCount - a.seenCount || b.count - a.count || b.avgConfidence - a.avgConfidence)
    .slice(0, RETIREMENT_FILE_LIMIT)
  atomicWriteJson(getContextAdmissionRetirementPath(), { version: 1, candidates: merged })
  return merged
}

export function getPersistedContextAdmissionRetirementCandidates(limit = 8): PersistedContextAdmissionRetirementCandidate[] {
  return readPersistedRetirementFile().candidates.slice(0, limit)
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function normalizeTokens(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, v | 0)
}

function keepCurrent(level?: 'index' | 'summary' | 'full'): AdmissionDecision {
  return level ?? 'full'
}

function pushOutcome(outcome: AdmissionOutcome): void {
  ring.push(outcome)
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY)
  }
}

function computePromptCacheChurnRisk(events: ReadonlyArray<AdmissionOutcome>): PromptCacheChurnRisk {
  let volatileTokens = 0
  let volatileFullTokens = 0
  let volatileFullEvents = 0
  let stableTokens = 0
  for (const ev of events) {
    if (ev.cacheClass === 'volatile') {
      volatileTokens += ev.estimatedTokens
      if (ev.decision === 'full') {
        volatileFullTokens += ev.estimatedTokens
        volatileFullEvents += 1
      }
    } else if (ev.cacheClass === 'stable' || ev.cacheClass === 'semi-stable') {
      stableTokens += ev.estimatedTokens
    }
  }
  const fullRatio = volatileTokens > 0 ? volatileFullTokens / volatileTokens : 0
  const level = volatileFullTokens >= 4000 || fullRatio >= 0.7
    ? 'high'
    : volatileFullTokens >= 1200 || fullRatio >= 0.35
      ? 'medium'
      : 'low'
  return {
    level,
    volatileTokens,
    volatileFullTokens,
    volatileFullEvents,
    stableTokens,
    reason: `volatileFull=${volatileFullTokens} tokens across ${volatileFullEvents} events; volatile/full ratio=${(fullRatio * 100).toFixed(0)}%`,
  }
}

function computePromptCacheChurnOffenders(events: ReadonlyArray<AdmissionOutcome>): PromptCacheChurnOffender[] {
  const buckets = new Map<string, PromptCacheChurnOffender>()
  for (const ev of events) {
    if (ev.cacheClass !== 'volatile' || ev.decision !== 'full') continue
    const key = `${ev.kind}:${ev.contextItemId ?? ev.decisionPoint ?? '(unknown)'}`
    const prev = buckets.get(key) ?? {
      key,
      kind: ev.kind,
      count: 0,
      tokens: 0,
      decisionPoint: ev.decisionPoint,
    }
    prev.count += 1
    prev.tokens += ev.estimatedTokens
    buckets.set(key, prev)
  }
  return [...buckets.values()]
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, 5)
}

function getChronicAdvisoryRetirementCandidates(): ContextAdmissionRetirementCandidate[] {
  try {
    return getChronicAdvisoryCandidates(CHRONIC_ADVISORY_RETIREMENT_STREAK).map(c => ({
      key: `advisory:${c.ruleId}:skip`,
      kind: 'advisory',
      decision: 'skip',
      count: c.streak,
      avgConfidence: clamp01(0.55 + Math.min(0.4, (c.streak - CHRONIC_ADVISORY_RETIREMENT_STREAK + 1) * 0.05)),
      reason:
        `chronic advisory '${c.ruleId}' persisted for ${c.streak} consecutive generations ` +
        `— quarantine or retire the corresponding advisory shadow if it keeps resurfacing`,
      evidence: { positive: 0, negative: c.streak, neutral: 0 },
    }))
  } catch {
    return []
  }
}

/**
 * Phase A 核心入口:给一个即将注入的上下文 item 生成 shadow admission 决策。
 * 调用方只记录 outcome,不得在 Phase A 根据 decision 改变真实 content。
 */
export function evaluateContextAdmission(input: AdmissionInput): AdmissionOutcome {
  const fallback: AdmissionOutcome = {
    ts: Date.now(),
    kind: input.kind,
    contextItemId: input.contextItemId,
    decisionPoint: input.decisionPoint,
    estimatedTokens: normalizeTokens(input.estimatedTokens),
    currentLevel: input.currentLevel,
    cacheClass: input.cacheClass,
    decision: keepCurrent(input.currentLevel),
    confidence: 0,
    reason: 'admission shadow disabled or fail-open; keep current behavior',
    shadowOnly: true,
    metrics: {
      budgetRatio: 0,
      bias: 0,
      utilizationRate: 0,
      sampledCount: 0,
    },
  }

  if (!isEnabled()) return fallback

  try {
    const budget = getBudgetLedgerSnapshot()
    const signals = getContextSignalsSnapshot()
    const econ = computeSourceEconomics(signals).find(e => e.kind === input.kind)
    const budgetRatio = budget.latest?.ratio ?? budget.avgRatio ?? 0
    const estimatedTokens = normalizeTokens(input.estimatedTokens)
    const sampledCount = econ?.sampledCount ?? 0
    const utilizationRate = econ?.utilizationRate ?? 0
    const bias = econ?.bias ?? 0
    const current = keepCurrent(input.currentLevel)
    const itemRoi = getContextItemRoiRow(input.contextItemId)
    // used 事件可能来自采样/证据回填,不一定成对记录 served;用最大观测数避免 usedRate > 1。
    const itemObservationCount = itemRoi ? Math.max(itemRoi.servedCount, itemRoi.usedCount) : 0
    const itemUsedRate = itemRoi && itemObservationCount > 0 ? itemRoi.usedCount / itemObservationCount : 0

    // Phase G 闭环(2026-04-25):当 itemRoi 仍是空白(新 item 或尚未被观测)时,
    // 退到 evidence graph 的 outcome summary 作二级信号,让 admission 更早享受过往证据。
    // 依然保留 fail-open:getEvidenceOutcomeSummaryForContextItem 抛错直接忽略。
    let itemEvidence: { positive: number; negative: number; neutral: number } = { positive: 0, negative: 0, neutral: 0 }
    if (input.contextItemId) {
      try {
        itemEvidence = getEvidenceOutcomeSummaryForContextItem(input.contextItemId)
      } catch {
        itemEvidence = { positive: 0, negative: 0, neutral: 0 }
      }
    }
    const hasItemRoi = !!itemRoi && (itemRoi.servedCount > 0 || itemRoi.usedCount > 0 || itemRoi.harmfulCount > 0)
    const evidenceNegBias = itemEvidence.negative - itemEvidence.positive

    let decision: AdmissionDecision = current
    let confidence = 0.2
    let reason = `keep current level=${current}; insufficient admission pressure`

    // item 级 ROI 优先于 kind 级 bias:同一个 source kind 内,具体 item 的好坏差异最大。
    if (itemRoi && itemRoi.harmfulCount > 0 && current !== 'index') {
      decision = current === 'full' ? 'summary' : 'index'
      confidence = clamp01(0.65 + Math.min(0.25, itemRoi.harmfulCount * 0.05))
      reason = `item ROI harmful=${itemRoi.harmfulCount}, downgrade ${current}→${decision}`
    } else if (itemRoi && itemRoi.servedCount >= 3 && itemRoi.usedCount === 0 && current === 'full') {
      decision = 'summary'
      confidence = clamp01(0.5 + Math.min(0.25, (itemRoi.servedCount - 3) * 0.05) + (budgetRatio >= 0.75 ? 0.05 : 0))
      reason = `item ROI dead-weight served=${itemRoi.servedCount} used=0, downgrade full→summary`
    } else if (itemRoi && itemRoi.usedCount >= 2 && itemUsedRate >= 0.5 && current !== 'full') {
      decision = 'full'
      confidence = clamp01(0.55 + Math.min(0.3, itemUsedRate * 0.2))
      reason = `item ROI used=${itemRoi.usedCount}/${itemObservationCount}, protect high-value item as full`
    // Phase G 闭环:itemRoi 尚未积累时,让 evidence graph 的负面累积推动保守降级;
    // 阈值保底(negative-positive ≥ 2 且 negative ≥ 2)避免单条噪声触发。
    } else if (!hasItemRoi && itemEvidence.negative >= 2 && evidenceNegBias >= 2 && current === 'full') {
      decision = 'summary'
      confidence = clamp01(0.45 + Math.min(0.25, evidenceNegBias * 0.05))
      reason = `evidence graph negative=${itemEvidence.negative} positive=${itemEvidence.positive}, no itemRoi yet, downgrade full→summary`
    } else if (!hasItemRoi && itemEvidence.negative >= 2 && evidenceNegBias >= 2 && current === 'summary') {
      decision = 'index'
      confidence = clamp01(0.4 + Math.min(0.25, evidenceNegBias * 0.05))
      reason = `evidence graph negative=${itemEvidence.negative} positive=${itemEvidence.positive}, no itemRoi yet, downgrade summary→index`
    // cache-aware choreography: volatile 大块在预算紧张时更适合摘要,避免 cache bust。
    } else if (input.cacheClass === 'volatile' && budgetRatio >= 0.8 && estimatedTokens >= 1200 && current === 'full') {
      decision = 'summary'
      confidence = clamp01(0.5 + (budgetRatio - 0.8))
      reason = `volatile context under budget pressure ${(budgetRatio * 100).toFixed(0)}%, prefer summary to reduce cache churn`
    // 规则 1: Hunger 优先放大。模型已证明该 kind 供应不足时,shadow 建议 full。
    } else if (bias === 1) {
      decision = 'full'
      confidence = 0.65
      reason = `hunger bias for kind='${input.kind}', prefer fuller context`
    // 规则 2: Regret + 高预算压力时降级。先保守降一级,避免 shadow 过激。
    } else if (bias === -1 && budgetRatio >= 0.85) {
      if (estimatedTokens >= 800 && current === 'full') {
        decision = 'summary'
        confidence = clamp01(0.55 + (budgetRatio - 0.85) * 2)
        reason = `regret bias + budget pressure ${(budgetRatio * 100).toFixed(0)}%, downgrade full→summary`
      } else if (estimatedTokens >= 200 && current === 'summary') {
        decision = 'index'
        confidence = clamp01(0.5 + (budgetRatio - 0.85) * 2)
        reason = `regret bias + budget pressure ${(budgetRatio * 100).toFixed(0)}%, downgrade summary→index`
      } else {
        decision = current
        confidence = 0.35
        reason = `regret bias observed, but item is small enough to keep level=${current}`
      }
    // 规则 3: 极大 item 在预算紧张时即便没有采样也建议 summary。
    } else if (budgetRatio >= 0.92 && estimatedTokens >= 2000 && current === 'full') {
      decision = 'summary'
      confidence = clamp01(0.45 + (budgetRatio - 0.92) * 2)
      reason = `large item under high budget pressure ${(budgetRatio * 100).toFixed(0)}%, prefer summary`
    // 规则 4: 已经是 index 且没有 hunger,保持 index。
    } else if (current === 'index') {
      decision = 'index'
      confidence = 0.3
      reason = 'already index level and no hunger signal'
    }

    const outcome: AdmissionOutcome = {
      ts: Date.now(),
      kind: input.kind,
      contextItemId: input.contextItemId,
      decisionPoint: input.decisionPoint,
      estimatedTokens,
      currentLevel: input.currentLevel,
      cacheClass: input.cacheClass,
      decision,
      confidence,
      reason,
      shadowOnly: true,
      metrics: {
        budgetRatio,
        bias,
        utilizationRate,
        sampledCount,
      },
    }
    try {
      if (input.contextItemId && reason.startsWith('item ROI ')) {
        recordEvidenceEdge({
          from: input.contextItemId,
          to: `admission:${decision}`,
          fromKind: 'source',
          toKind: 'outcome',
          relation: 'item-roi-admission-decision',
          contextItemId: input.contextItemId,
          sourceKind: input.kind,
        })
      }
    } catch {
      // evidence graph 是观测层,不得影响 admission 主路径
    }
    pushOutcome(outcome)
    return outcome
  } catch {
    pushOutcome(fallback)
    return fallback
  }
}

export function getContextAdmissionSnapshot(): ContextAdmissionSnapshot {
  const byDecision: Record<AdmissionDecision, number> = {
    skip: 0,
    index: 0,
    summary: 0,
    full: 0,
  }
  // Phase G observability:统计 evidence-informed 规则触发次数。
  // reason 以 'evidence graph negative=' 开头即视为被该规则触发。
  const evidenceInformedByDecision: Record<AdmissionDecision, number> = {
    skip: 0,
    index: 0,
    summary: 0,
    full: 0,
  }
  let evidenceInformedTotal = 0
  let evidenceInformedLastAt: number | null = null
  const aggregates = new Map<string, { kind: ContextSignalKind; decision: AdmissionDecision; count: number; totalConfidence: number }>()
  const cacheStats = new Map<'stable' | 'semi-stable' | 'volatile' | 'unknown', { count: number; tokens: number; byDecision: Record<AdmissionDecision, number> }>()
  for (const ev of ring) {
    byDecision[ev.decision] += 1
    if (typeof ev.reason === 'string' && ev.reason.startsWith('evidence graph negative=')) {
      evidenceInformedTotal += 1
      evidenceInformedByDecision[ev.decision] += 1
      if (evidenceInformedLastAt === null || ev.ts > evidenceInformedLastAt) {
        evidenceInformedLastAt = ev.ts
      }
    }
    const cacheClass = ev.cacheClass ?? 'unknown'
    const prevCache = cacheStats.get(cacheClass) ?? {
      count: 0,
      tokens: 0,
      byDecision: { skip: 0, index: 0, summary: 0, full: 0 },
    }
    prevCache.count += 1
    prevCache.tokens += ev.estimatedTokens
    prevCache.byDecision[ev.decision] += 1
    cacheStats.set(cacheClass, prevCache)
    const key = `${ev.kind}:${ev.contextItemId ?? ev.decisionPoint ?? '(unknown)'}:${ev.decision}`
    const prev = aggregates.get(key)
    if (prev) {
      prev.count += 1
      prev.totalConfidence += ev.confidence
    } else {
      aggregates.set(key, {
        kind: ev.kind,
        decision: ev.decision,
        count: 1,
        totalConfidence: ev.confidence,
      })
    }
  }
  const retirementCandidates: ContextAdmissionRetirementCandidate[] = []
  for (const [key, a] of aggregates) {
    const avgConfidence = a.totalConfidence / Math.max(1, a.count)
    const contextItemId = key.split(':').slice(1, -1).join(':')
    let evidenceBoost = 0
    let evidenceNote = ''
    let evidence = { positive: 0, negative: 0, neutral: 0 }
    if (contextItemId) {
      try {
        evidence = getEvidenceOutcomeSummaryForContextItem(contextItemId)
        if (evidence.negative > evidence.positive) {
          evidenceBoost = Math.min(0.2, (evidence.negative - evidence.positive) * 0.05)
          evidenceNote = `; evidence negative=${evidence.negative} positive=${evidence.positive} neutral=${evidence.neutral}`
        }
      } catch {
        evidenceBoost = 0
      }
    }
    const adjustedConfidence = clamp01(avgConfidence + evidenceBoost)
    if (a.count >= 5 && adjustedConfidence >= 0.6 && a.decision !== 'full') {
      retirementCandidates.push({
        key,
        kind: a.kind,
        decision: a.decision,
        count: a.count,
        avgConfidence: adjustedConfidence,
        reason: `repeated ${a.decision} admission (${a.count}x, avgConf=${(adjustedConfidence * 100).toFixed(0)}%)${evidenceNote} — consider quarantine/demotion`,
        evidence,
      })
    }
  }
  retirementCandidates.push(...getChronicAdvisoryRetirementCandidates())
  retirementCandidates.sort((a, b) => b.count - a.count || b.avgConfidence - a.avgConfidence)
  const topRetirementCandidates = retirementCandidates.slice(0, 5)
  let persistedRetirementCandidates: PersistedContextAdmissionRetirementCandidate[] = []
  if (isContextAdmissionRetirementPersistenceEnabled() && topRetirementCandidates.length > 0) {
    try {
      persistedRetirementCandidates = persistRetirementCandidates(topRetirementCandidates).slice(0, 5)
    } catch {
      persistedRetirementCandidates = getPersistedContextAdmissionRetirementCandidates(5)
    }
  } else {
    persistedRetirementCandidates = getPersistedContextAdmissionRetirementCandidates(5)
  }
  const byCacheClass = [...cacheStats.entries()]
    .map(([cacheClass, stats]) => ({
      cacheClass,
      count: stats.count,
      tokens: stats.tokens,
      byDecision: stats.byDecision,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
  return {
    enabled: isEnabled(),
    toolResultExecutionEnabled: isToolResultAdmissionExecutionEnabled(),
    autoMemoryExecutionEnabled: isAutoMemoryAdmissionExecutionEnabled(),
    fileAttachmentExecutionEnabled: isFileAttachmentAdmissionExecutionEnabled(),
    historyCompactExecutionEnabled: isHistoryCompactAdmissionExecutionEnabled(),
    sideQueryExecutionEnabled: isSideQueryAdmissionExecutionEnabled(),
    handoffManifestExecutionEnabled: isHandoffManifestExecutionEnabled(),
    retirementPersistenceEnabled: isContextAdmissionRetirementPersistenceEnabled(),
    ringCapacity: RING_CAPACITY,
    count: ring.length,
    recent: ring.slice(-8).reverse(),
    byDecision,
    byCacheClass,
    promptCacheChurnRisk: computePromptCacheChurnRisk(ring),
    promptCacheChurnOffenders: computePromptCacheChurnOffenders(ring),
    retirementCandidates: topRetirementCandidates,
    persistedRetirementCandidates,
    evidenceInformed: {
      total: evidenceInformedTotal,
      byDecision: evidenceInformedByDecision,
      lastAt: evidenceInformedLastAt,
    },
  }
}

export function __resetContextAdmissionForTests(): void {
  ring.length = 0
}
