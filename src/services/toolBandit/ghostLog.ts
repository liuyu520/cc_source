/**
 * G3 Step 3 — tool-bandit ghost recommendation ledger
 * -----------------------------------------------------------------
 *
 * 目的
 *   把 policy.recommendTool 的"若我是 bandit"结果落盘。shadow-only:
 *   用于后续 Step 4 advisor 计算 regret 或观察 policy 行为是否与实际分歧。
 *
 * 写盘时机
 *   仅当 env `CLAUDE_TOOL_BANDIT_GHOST=on|1|true|yes` 时才写;默认 OFF。
 *   这层是"有人关心再算",保持零开销承诺。
 *
 * 字段
 *   {
 *     at: ISO,
 *     actualTool, actualReward,
 *     recommendedTool, reason, epsilon, scoreGap?,
 *     candidates: [{toolName, count, avgReward, warm, effectiveScore}],
 *     isMatch  // actualTool === recommendedTool
 *   }
 *
 * Fail-open
 *   任何异常内部 catch,不向 caller 抛,避免污染 reward ledger 主路径。
 */

import { appendJsonLine } from '../autoEvolve/oracle/ndjsonLedger.js'
import { getToolBanditGhostLedgerPath } from '../autoEvolve/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import type { RecommendResult } from './policy.js'

/** env 开关 —— 默认 OFF(关)才写 ghost ledger */
function isGhostEnabled(): boolean {
  const raw = (process.env.CLAUDE_TOOL_BANDIT_GHOST ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

export interface ToolBanditGhostSample {
  actualTool: string
  /** 本次真实调用的 reward 值(success=+1/error=-1/abort=-0.5) */
  actualReward: number
  /** recommendTool 的完整返回 */
  recommendation: RecommendResult
}

/**
 * 写 ghost sample。默认 OFF;enabled 时 fail-open 写一行 ndjson。
 * 返回是否实际写入成功(便于 probe 断言)。
 */
export function recordToolBanditGhost(sample: ToolBanditGhostSample): boolean {
  if (!isGhostEnabled()) return false
  try {
    const rec = sample.recommendation
    // no-data / 空 pick 的 recommendation 不值得落盘(噪声),直接 skip
    if (!rec || !rec.pick) return false
    const payload = {
      at: new Date().toISOString(),
      actualTool: sample.actualTool,
      actualReward: sample.actualReward,
      recommendedTool: rec.pick,
      reason: rec.reason,
      epsilon: rec.epsilon,
      scoreGap: rec.scoreGap,
      candidates: rec.candidates.map(c => ({
        toolName: c.toolName,
        count: c.count,
        avgReward: c.avgReward,
        warm: c.warm,
        effectiveScore: c.effectiveScore,
      })),
      isMatch: sample.actualTool === rec.pick,
      pid: process.pid,
    }
    return appendJsonLine(getToolBanditGhostLedgerPath(), payload)
  } catch (e) {
    logForDebugging(
      `[toolBanditGhostLedger] append failed: ${(e as Error).message}`,
    )
    return false
  }
}

/** 便于 probe:手动检查是否启用 */
export function isToolBanditGhostEnabledForTest(): boolean {
  return isGhostEnabled()
}
