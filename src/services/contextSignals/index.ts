/**
 * ContextSignals — 上下文信号记账服务(Phase 54)
 *
 * 目标: 把任意"送进 LLM 上下文的片段"统一归到一张账本, 为后续:
 *   - Phase 55 token budget 账本
 *   - Phase 57 Choreographer 决策
 *   - Phase 58 Regret/Hunger 反馈环
 *   - Phase 59 context-selector 自进化
 * 提供共享度量底座。
 *
 * 本阶段仅对外暴露"只读记账"能力, 调用方:
 *   recordSignalServed({ kind, tokens, itemCount, ... })
 *   recordSignalUtilization({ kind, used, evidence })
 *
 * /kernel-status 通过 getContextSignalsSnapshot() 展示聚合视图。
 *
 * 与既有基础设施的关系:
 *   - 既有 findRelevantMemories / tier-manager / contextCollapse 的检索与压缩逻辑
 *     全部保留不变; 本服务只在它们对外投递上下文时打一次点。
 *   - 与 services/compact/contextBudget.ts 层级互补:
 *       contextBudget: "各 section 预算分配"(system/tools/history/output)
 *       contextSignals: "具体每次被送进去的是哪家 source"(跨 section 横切)
 */

export {
  recordSignalServed,
  recordSignalUtilization,
  getContextSignalsSnapshot,
  drainUnsampledServedEvents,
  __resetContextSignalsForTests,
} from './telemetry.js'

// Phase 54(v2, 2026-04-24)· ContextSignalSource 接口抽象
// 薄层封装 recordSignalServed/Utilization, 让新调用点用 `.serve(...)` 代替硬编码 kind。
// 既有散写点保留不变(向后兼容)。
export {
  ContextSignalSource,
  ToolResultSignalSource,
  AutoMemorySignalSource,
  HistoryCompactSignalSource,
  TierIndexSignalSource,
  FileAttachmentSignalSource,
  UserInputSignalSource,
  PatternMinerSignalSource,
  AgentHandoffSignalSource,
  DreamArtifactSignalSource,
  signalSourceFor,
} from './signalSources.js'
export type {
  SignalServePayload,
  SignalUtilizePayload,
} from './signalSources.js'

export type {
  ContextSignalKind,
  ContextSignalKindSnapshot,
  ContextSignalsSnapshot,
  SignalServedEvent,
  SignalUtilizationEvent,
} from './types.js'

// Phase 55 · token budget 账本
export {
  recordBudgetAllocation,
  getBudgetLedgerSnapshot,
  __resetBudgetLedgerForTests,
} from './budgetLedger.js'
export type {
  BudgetLedgerEntry,
  BudgetLedgerSnapshot,
} from './budgetLedger.js'

// Phase 58 · utilization 反向采样
export {
  sampleUtilizationByOverlap,
  autoSampleSinceLastCall,
} from './utilizationSampler.js'
export type {
  UtilizationSampleInput,
  UtilizationSampleResult,
} from './utilizationSampler.js'

// Phase 58 深化(2026-04-24)· Regret/Hunger 派生指标
// 纯函数,从 ContextSignalsSnapshot 计算 per-kind bias,不写账本。
export {
  computeSourceEconomics,
  getBiasedSources,
} from './regretHunger.js'
export type {
  SourceBias,
  SourceEconomics,
  ComputeSourceEconomicsOptions,
} from './regretHunger.js'

// Phase 57 · Shadow Choreographer (suggest-only)
// Phase 59 · 暴露 getShadowSuggestionAggregates 供 Pattern Miner 读账本
export {
  evaluateShadowChoreography,
  getShadowChoreographerState,
  getShadowSuggestionAggregates,
  __resetShadowChoreographerForTests,
} from './shadowChoreographer.js'
export type {
  ChoreographySuggestion,
  ChoreographySuggestionKind,
  ShadowChoreographerState,
  ShadowSuggestionAggregate,
} from './shadowChoreographer.js'

// Phase 60 深化 · Cross-agent Handoff Manifest
// Phase 78 · 持久化: closed 条目跨 session 累积, 喂 Ph71/73 advisor
export {
  recordHandoffManifest,
  getHandoffLedgerSnapshot,
  findHandoffManifestById,
  formatHandoffManifestContract,
  recordHandoffReturn,
  getHandoffRoiBySubagentType,
  __resetHandoffLedgerForTests,
  __getHandoffLedgerPersistPathForTests,
  flushHandoffLedgerNow,
} from './handoffLedger.js'
export type {
  HandoffManifest,
  HandoffLedgerSnapshot,
  RecordHandoffOptions,
  HandoffReturnRecord,
  RecordHandoffReturnOptions,
  HandoffRoiBySubagent,
} from './handoffLedger.js'

// Phase 61 · Per-memory Utility Ledger
// Phase 77 · 持久化: surfacedCount/usedCount 跨 session 累加, 喂 Ph75 advisor
export {
  recordSurfacedMemory,
  observeModelOutputForMemoryUsage,
  getMemoryUtilityLedgerSnapshot,
  __resetMemoryUtilityLedgerForTests,
  __getMemoryLedgerPersistPathForTests,
  flushMemoryUtilityLedgerNow,
} from './memoryUtilityLedger.js'
export type {
  MemoryUtilityRow,
  MemoryUtilityLedgerSnapshot,
} from './memoryUtilityLedger.js'

// Phase 64 · Dream artifact utilization tracker
export {
  trackDreamArtifact,
  observeModelOutputForDreamArtifacts,
  getDreamArtifactTrackerSnapshot,
  __resetDreamArtifactTrackerForTests,
} from './dreamArtifactTracker.js'
export type { DreamArtifactTrackerSnapshot } from './dreamArtifactTracker.js'

// Phase 71 · Advisor: 读所有账本 → 输出 actionable 建议(纯读取, 零行为变更)
// Phase 74 · getActiveAdvisoriesForSubagent 供决策点消费
export { generateAdvisories, getActiveAdvisoriesForSubagent } from './advisor.js'
export type { Advisory, AdvisorySeverity } from './advisor.js'

// Phase 72 · Advisor History: streak / firstSeenAt 标注连续命中
// Phase 76 · 持久化: streak 跨 session 累加
export {
  generateAdvisoriesWithHistory,
  getAdvisoryHistorySnapshot,
  getChronicAdvisoryCandidates,
  __resetAdvisoryHistoryForTests,
  __getAdvisoryHistoryPersistPathForTests,
} from './advisoryHistory.js'
export type { AdvisoryWithHistory, ChronicAdvisoryCandidate } from './advisoryHistory.js'

// Phase A(2026-04-24) · ContextAdmissionController shadow gate
// 在上下文真正注入前给出 skip/index/summary/full 影子判定;当前阶段只观测不执行。
export {
  evaluateContextAdmission,
  getContextAdmissionSnapshot,
  isToolResultAdmissionExecutionEnabled,
  isAutoMemoryAdmissionExecutionEnabled,
  isFileAttachmentAdmissionExecutionEnabled,
  isHistoryCompactAdmissionExecutionEnabled,
  isContextAdmissionRetirementPersistenceEnabled,
  isSideQueryAdmissionExecutionEnabled,
  isHandoffManifestExecutionEnabled,
  getContextAdmissionRetirementPath,
  getPersistedContextAdmissionRetirementCandidates,
  __resetContextAdmissionForTests,
} from './contextAdmissionController.js'
export type {
  AdmissionDecision,
  AdmissionInput,
  AdmissionOutcome,
  ContextAdmissionRetirementCandidate,
  ContextAdmissionSnapshot,
  CacheClassAdmissionStats,
  PromptCacheChurnRisk,
  PromptCacheChurnOffender,
  PersistedContextAdmissionRetirementCandidate,
  ContextAdmissionRetirementFile,
} from './contextAdmissionController.js'

// Phase D · 通用 item 级 ROI 账本
export {
  recordContextItemRoiEvent,
  getContextItemRoiRow,
  getContextItemRoiSnapshot,
  flushContextItemRoiLedgerNow,
  clearContextItemRoiLedger,
  getContextItemRoiLedgerPersistPath,
  __resetContextItemRoiLedgerForTests,
  __getContextItemRoiLedgerPersistPathForTests,
} from './itemRoiLedger.js'
export type {
  ContextItemOutcome,
  ContextItemRoiEvent,
  ContextItemRoiRow,
  ContextItemRoiSnapshot,
} from './itemRoiLedger.js'

// Evidence Graph · source→entity→action→outcome 轻量证据图(持久化 + admission/retirement 证据输入)
export {
  recordEvidenceEdge,
  getEvidenceGraphSnapshot,
  getEvidenceOutcomeSummaryForContextItem,
  flushEvidenceGraphNow,
  clearEvidenceGraph,
  getEvidenceGraphPersistPath,
  __resetEvidenceGraphForTests,
  __getEvidenceGraphPersistPathForTests,
} from './evidenceGraph.js'
export type {
  EvidenceEdge,
  EvidenceGraphSnapshot,
  EvidenceNodeKind,
  EvidenceOutcomeSummary,
} from './evidenceGraph.js'
