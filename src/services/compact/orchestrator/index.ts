/**
 * CompactOrchestrator (P1-1) — 单例入口
 *
 * 使用方式：
 *
 *   const plan = compactOrchestrator.decide({
 *     messageCount: msgs.length,
 *     stats: { usedTokens, maxTokens, ratio },
 *     signal: { kind: 'token_pressure' },
 *     heavyToolResultCount: 2,
 *   })
 *   if (plan.strategy !== 'noop') {
 *     await compactOrchestrator.execute(plan, context)
 *   }
 *
 * 影子模式下 execute() 只打印决策日志，不调用真实压缩，保持零回归。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  isCompactOrchestratorEnabled,
  isCompactOrchestratorShadowMode,
} from './featureCheck.js'
import { plan as planInternal } from './planner.js'
import type {
  CompactPlan,
  TokenStats,
  TriggerSignal,
} from './types.js'

export interface DecideInput {
  messageCount: number
  stats: TokenStats
  signal: TriggerSignal
  heavyToolResultCount: number
  messageScores?: number[]
  /**
   * Phase 2 Shot 6:过去 10min compact 次数,驱动 planner 做 anti-thrash。
   * 由调用方(query.ts / autoCompact.ts)从 kernel.compactBurst 推入。
   */
  recentCompactCount?: number
}

export interface ExecuteContext {
  /** 真实执行时由调用方注入，分派给 compact.ts / microCompact.ts 等 */
  runFullCompact?: () => Promise<void>
  runMicroCompact?: () => Promise<void>
  runSessionMemory?: () => Promise<void>
}

class CompactOrchestrator {
  /** 决策入口 — 纯函数，无副作用 */
  decide(input: DecideInput): CompactPlan {
    return planInternal(input)
  }

  /**
   * 执行 plan。若处于影子模式仅打印日志。
   * 否则按 strategy 分派给 ExecuteContext 中注入的闭包（复用既有实现）。
   * 注意：snip / micro 的轻量阶段由 query.ts 读取 plan.runSnip/runMicro
   * 直接驱动，不走此 execute —— 它只负责 autoCompact 阶段的重量级路径。
   */
  async execute(plan: CompactPlan, ctx: ExecuteContext): Promise<void> {
    if (!isCompactOrchestratorEnabled()) return
    logForDebugging(
      `[CompactOrchestrator] decide strategy=${plan.strategy} reason="${plan.reason}" est=${plan.estimatedTokensSaved}`,
    )
    if (isCompactOrchestratorShadowMode()) {
      // 影子模式：只决策不执行
      return
    }
    switch (plan.strategy) {
      case 'full_compact':
        await ctx.runFullCompact?.()
        return
      case 'micro_compact':
        await ctx.runMicroCompact?.()
        return
      case 'session_memory':
        await ctx.runSessionMemory?.()
        return
      case 'noop':
      default:
        return
    }
  }
}

export const compactOrchestrator = new CompactOrchestrator()

/**
 * #6 修复：统一的 "enable + shadow + decide + log" 三段式样板。
 * 所有接入点（query.ts / autoCompact.ts / 未来的其他位置）都只调用这一个
 * 函数，避免 try/catch + flag + logForDebugging 样板扩散。
 *
 * 返回值：
 *   - null  — 未启用 orchestrator，调用方走 legacy 行为
 *   - { plan, shadow } — 已决策；shadow=true 表示调用方仍应走 legacy
 */
export function decideAndLog(
  site: string,
  input: DecideInput,
): { plan: CompactPlan; shadow: boolean } | null {
  try {
    if (!isCompactOrchestratorEnabled()) return null
    const shadow = isCompactOrchestratorShadowMode()
    const plan = compactOrchestrator.decide(input)
    logForDebugging(
      `[CompactOrchestrator:${site}] strategy=${plan.strategy} runSnip=${plan.runSnip} runMicro=${plan.runMicro} shadow=${shadow} reason="${plan.reason}"`,
    )
    return { plan, shadow }
  } catch (e) {
    logForDebugging(
      `[CompactOrchestrator:${site}] decide failed, falling back to legacy: ${(e as Error).message}`,
    )
    return null
  }
}

export type {
  CompactPlan,
  CompactStrategy,
  TriggerSignal,
  CompactTriggerKind,
  TokenStats,
} from './types.js'
export {
  isCompactOrchestratorEnabled,
  isCompactOrchestratorShadowMode,
} from './featureCheck.js'
export {
  buildRelevanceHint,
  scoreMessage,
  scoreMessages,
  scoreMessagesAgainstCurrentTask,
} from './importance.js'
