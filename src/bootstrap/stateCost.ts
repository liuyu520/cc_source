/**
 * 成本/用量追踪领域状态 (Cost & Usage Domain State)
 *
 * 从 bootstrap/state.ts 中提取的成本、token 用量、时间追踪相关状态。
 *
 * 遵守 bootstrap-isolation 规则：此模块是 DAG 叶节点。
 */

import sumBy from 'lodash-es/sumBy.js'
import type { ModelUsage } from 'src/entrypoints/agentSdkTypes.js'

type CostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  modelUsage: { [modelName: string]: ModelUsage }
}

export function getInitialCostState(): CostState {
  return {
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    modelUsage: {},
  }
}

// 模块级单例
const COST: CostState = getInitialCostState()

// ===== Duration Tracking =====

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  COST.totalAPIDuration += duration
  COST.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  COST.totalAPIDuration = 0
  COST.totalAPIDurationWithoutRetries = 0
  COST.totalCostUSD = 0
}

export function getTotalAPIDuration(): number {
  return COST.totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - COST.startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return COST.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return COST.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  COST.totalToolDuration += duration
  COST.turnToolDurationMs += duration
  COST.turnToolCount++
}

// ===== Turn Tracking =====

export function getTurnHookDurationMs(): number {
  return COST.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  COST.turnHookDurationMs += duration
  COST.turnHookCount++
}

export function resetTurnHookDuration(): void {
  COST.turnHookDurationMs = 0
  COST.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return COST.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return COST.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  COST.turnToolDurationMs = 0
  COST.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return COST.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return COST.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  COST.turnClassifierDurationMs += duration
  COST.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  COST.turnClassifierDurationMs = 0
  COST.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return COST.turnClassifierCount
}

// ===== Cost Tracking =====

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  COST.modelUsage[model] = modelUsage
  COST.totalCostUSD += cost
}

export function getTotalCostUSD(): number {
  return COST.totalCostUSD
}

export function setHasUnknownModelCost(): void {
  COST.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return COST.hasUnknownModelCost
}

// ===== Lines Changed =====

export function addToTotalLinesChanged(added: number, removed: number): void {
  COST.totalLinesAdded += added
  COST.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return COST.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return COST.totalLinesRemoved
}

// ===== Token Usage =====

export function getTotalInputTokens(): number {
  return sumBy(Object.values(COST.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(COST.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(COST.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(COST.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(COST.modelUsage), 'webSearchRequests')
}

// Turn-level output token tracking
let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
let budgetContinuationCount = 0

export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}

export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}

export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}

export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}

export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

// ===== Model Usage =====

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return COST.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return COST.modelUsage[model]
}

// ===== Reset =====

export function resetCostState(): void {
  COST.totalCostUSD = 0
  COST.totalAPIDuration = 0
  COST.totalAPIDurationWithoutRetries = 0
  COST.totalToolDuration = 0
  COST.startTime = Date.now()
  COST.totalLinesAdded = 0
  COST.totalLinesRemoved = 0
  COST.hasUnknownModelCost = false
  COST.modelUsage = {}
}

export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  COST.totalCostUSD = totalCostUSD
  COST.totalAPIDuration = totalAPIDuration
  COST.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  COST.totalToolDuration = totalToolDuration
  COST.totalLinesAdded = totalLinesAdded
  COST.totalLinesRemoved = totalLinesRemoved
  if (modelUsage) {
    COST.modelUsage = modelUsage
  }
  if (lastDuration) {
    COST.startTime = Date.now() - lastDuration
  }
}

export function resetCostStateForTests(): void {
  Object.assign(COST, getInitialCostState())
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
}
