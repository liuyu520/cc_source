/**
 * RCA (Root Cause Analysis) 子系统运行时开关
 *
 * 与 CompactOrchestrator 的 featureCheck 完全同构：
 *   CLAUDE_CODE_RCA=1         → 启用（影子或切流）
 *   CLAUDE_CODE_RCA_SHADOW=1  → 仅打印决策日志不真的执行
 *   未设置                     → 默认禁用
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isRCAEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_RCA
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isRCAShadowMode(): boolean {
  return isRCAEnabled() && isEnvTruthy(process.env.CLAUDE_CODE_RCA_SHADOW)
}
