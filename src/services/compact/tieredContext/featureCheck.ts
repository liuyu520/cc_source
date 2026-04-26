/**
 * Tiered Context Rehydration 特性开关
 *
 *   CLAUDE_CODE_TIERED_CONTEXT=1           → 建 L4 索引（compact 时写 TierEntry）
 *   CLAUDE_CODE_TIERED_CONTEXT_REHYDRATE=1 → RehydrateTool 对 LLM 可见
 *   CLAUDE_CODE_TIERED_CONTEXT_AUTO=1      → 自动触发 rehydrate（检测 LLM 引用旧 turnId）
 *
 * 默认全 OFF，零回归。
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../../utils/envUtils.js'

export function isTieredContextEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_TIERED_CONTEXT
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isRehydrateEnabled(): boolean {
  if (!isTieredContextEnabled()) return false
  const v = process.env.CLAUDE_CODE_TIERED_CONTEXT_REHYDRATE
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isAutoRehydrateEnabled(): boolean {
  if (!isRehydrateEnabled()) return false
  const v = process.env.CLAUDE_CODE_TIERED_CONTEXT_AUTO
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}
