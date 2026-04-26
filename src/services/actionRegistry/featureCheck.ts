/**
 * Unified Action Registry 特性开关
 *
 *   CLAUDE_CODE_UNIFIED_ACTIONS=1  → 启用统一 registry（行为不变，只是把数据集中）
 *   CLAUDE_CODE_COMMAND_RECALL=1   → 让 slash commands 参与 skill recall
 *   CLAUDE_CODE_MACROS=1           → 启用 macro 支持（~/.claude/macros/*.json）
 *
 * 默认全 OFF。
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isUnifiedActionsEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_UNIFIED_ACTIONS
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isCommandRecallEnabled(): boolean {
  if (!isUnifiedActionsEnabled()) return false
  const v = process.env.CLAUDE_CODE_COMMAND_RECALL
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isMacrosEnabled(): boolean {
  if (!isUnifiedActionsEnabled()) return false
  const v = process.env.CLAUDE_CODE_MACROS
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}
