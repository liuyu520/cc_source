/**
 * CompactOrchestrator 运行时开关 (P1-1)
 *
 *   CLAUDE_CODE_COMPACT_ORCHESTRATOR=1 → 启用（影子或切流）
 *   CLAUDE_CODE_COMPACT_ORCHESTRATOR_SHADOW=1 → 仅打印决策日志不真的执行
 *   未设置 → 默认禁用
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../../utils/envUtils.js'

export function isCompactOrchestratorEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_COMPACT_ORCHESTRATOR
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isCompactOrchestratorShadowMode(): boolean {
  return (
    isCompactOrchestratorEnabled() &&
    isEnvTruthy(process.env.CLAUDE_CODE_COMPACT_ORCHESTRATOR_SHADOW)
  )
}
