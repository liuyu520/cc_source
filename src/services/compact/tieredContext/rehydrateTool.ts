/**
 * RehydrateTool — 轻量函数式接口
 *
 * 本文件只提供纯函数式 API，**不**把自己注册成 src/tools.ts 里的 LLM Tool。
 * 原因：
 *   1. Phase 2 所有特性默认 OFF，无需改动 tools.ts（避免对主循环 baseline 的任何影响）
 *   2. 未来若需暴露给 LLM，只需在 tools.ts 中 import { searchAndRehydrate }
 *      并按现有 Tool 规范包装即可
 *
 * 消费者（未来）：
 *   - PEV verify 失败时的自恢复路径
 *   - /rehydrate 命令（用户手动取回）
 *   - orchestrator planner 的 'rehydrate' 策略
 */

import { contextTierManager } from './tierManager.js'
import { isRehydrateEnabled } from './featureCheck.js'
import type { RehydrateResult, TierEntry } from './types.js'

/**
 * 组合操作：先按关键词搜候选，再 rehydrate top-1
 * 返回 null 表示找不到 / 未启用
 */
export function searchAndRehydrate(params: {
  sessionId: string
  transcriptPath: string
  query: string
}): RehydrateResult | null {
  if (!isRehydrateEnabled()) return null
  const candidates = contextTierManager.searchRehydrateCandidates(
    params.sessionId,
    params.transcriptPath,
    params.query,
    1,
  )
  if (candidates.length === 0) return null
  return contextTierManager.rehydrate(
    params.sessionId,
    params.transcriptPath,
    candidates[0].turnId,
  )
}

/** 按 turnId 精确取回 */
export function rehydrateByTurnId(params: {
  sessionId: string
  transcriptPath: string
  turnId: string
}): RehydrateResult | null {
  if (!isRehydrateEnabled()) return null
  return contextTierManager.rehydrate(
    params.sessionId,
    params.transcriptPath,
    params.turnId,
  )
}

/** 列出候选（不取回内容，只返回元数据） */
export function listRehydrateCandidates(params: {
  sessionId: string
  transcriptPath: string
  query: string
  limit?: number
}): TierEntry[] {
  if (!isRehydrateEnabled()) return []
  return contextTierManager.searchRehydrateCandidates(
    params.sessionId,
    params.transcriptPath,
    params.query,
    params.limit ?? 5,
  )
}
