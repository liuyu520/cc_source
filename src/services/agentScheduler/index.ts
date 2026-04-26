/**
 * AgentScheduler 公共 API 聚合
 *
 * 统一导出调度器和缓存的公共接口，供 AgentTool 等外部模块使用。
 */

// 调度器核心 API
export {
  acquireSlot,
  adaptScheduler,
  getMaxConcurrent,
  getSchedulerState,
  isAdaptiveQuotaEnabled,
  resetScheduler,
  subscribeSchedulerState,
  updateSchedulerConfig,
} from './scheduler.js'

// 结果缓存 API
export {
  clearCache,
  computePromptSignature,
  getCachedResult,
  getCacheSize,
  getSignatureIndexSize,
  setCachedResult,
} from './cache.js'

// 统计聚合 API(P1 学习回路)
export {
  clearAgentStatsCache,
  computeAgentStats,
  getAgentStats,
  getCachedAgentStatsSnapshot,
  setAgentStatsCacheTTL,
  // #2 跨会话持久化
  deleteAgentStatsSnapshotFile,
  hydrateAgentStatsFromDisk,
  persistAgentStatsToDisk,
  type AgentStat,
  type AgentStatsSnapshot,
} from './agentStats.js'

// Tool 运行统计(in-memory ring buffer,#1 镜像 AgentStat 形状)
// 数据点由 services/tools/toolExecution.ts 在 success/error/abort 三处吐入
export {
  clearToolStats,
  getToolStatsRecordCount,
  getToolStatsSnapshot,
  recordToolCall,
  // #2 跨会话持久化
  deleteToolStatsSnapshotFile,
  hydrateToolStatsFromDisk,
  persistToolStatsToDisk,
  type ToolCallOutcome,
  type ToolStat,
  type ToolStatsSnapshot,
} from './toolStats.js'

// 后台驱动(周期刷新 + 自适应)
export {
  getAgentSchedulerBackgroundState,
  startAgentSchedulerBackground,
  stopAgentSchedulerBackground,
} from './background.js'

// 周期维护注册表观测 API —— 供 /kernel-status 等诊断命令消费
// (background.ts 会在启动时把 stats/adapt/speculation/cache-evict/tokenBudget-evict
//  这 5 个任务注册到此通用注册表;其它模块也可自行 registerPeriodicTask)
export {
  getPeriodicMaintenanceState,
  type PeriodicMaintenanceSnapshot,
  type PeriodicTaskRuntimeState,
} from '../periodicMaintenance/index.js'

// P3 推测执行(speculation pre-run)
export {
  getSpeculationMode,
  getSpeculationState,
  isSpeculationEnabled,
  maybeRunSpeculation,
  predictNextAgentCalls,
  recordSpeculationHit,
  registerSpeculationRunner,
  resetSpeculationState,
  setColdStartProvider,
  unregisterSpeculationRunner,
  type ColdStartPredictionProvider,
  type SpeculationMode,
  type SpeculationPrediction,
  type SpeculationRunner,
  type SpeculationState,
} from './speculation.js'

// #5 冷启动预跑:候选注册表 + burst 触发
export {
  clearColdStartCandidates,
  getColdStartState,
  listColdStartCandidates,
  pickColdStartPrediction,
  registerColdStartCandidate,
  scheduleColdStartBurst,
  stopColdStartBurst,
  unregisterColdStartCandidate,
  __resetColdStartForTests,
  type ColdStartAppliesWhen,
  type ColdStartBurstOptions,
  type ColdStartCandidate,
  type ColdStartCandidateSnapshot,
  type ColdStartRuntimeState,
} from './coldStart.js'

// P5 token budget(输入 token/min 滑窗限流)
export {
  canCharge as canChargeTokens,
  charge as chargeTokens,
  estimateInputTokens,
  getCurrentTokenUsage,
  getTokenBudgetLimit,
  getTokenBudgetSnapshot,
  isTokenBudgetEnabled,
  resetTokenBudget,
  tryCharge as tryChargeTokens,
  type TokenBudgetSnapshot,
} from './tokenBudget.js'

// P0 影子并行:shadow store(独立于主 cache,存外部 agent 预跑结果)
export {
  clearShadowStore,
  evictExpiredShadow,
  getShadowResult,
  getShadowStoreConfig,
  getShadowStoreSize,
  listShadowResults,
  putShadowResult,
  updateShadowStoreConfig,
  type ShadowEntry,
} from './shadowStore.js'

// P0 影子并行:Codex 预跑驱动(由 background.ts 周期调用)
export {
  getShadowRunnerState,
  isShadowEpisodeWritebackEnabled,
  isShadowRunnerEnabled,
  resetShadowRunnerState,
  resolveShadowAgentName,
  runShadowTick,
  type ShadowRunnerState,
} from './codexShadowRunner.js'

// 类型导出
export type {
  AgentPriority,
  CachedAgentResult,
  SchedulerConfig,
  SchedulerState,
  SlotHandle,
} from './types.js'
