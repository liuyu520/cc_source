/**
 * Model Router 特性开关 — 三档发布节奏
 *
 *   CLAUDE_CODE_MODEL_ROUTER=1           → shadow 模式，只记录决策不改变实际路由
 *   CLAUDE_CODE_MODEL_ROUTER_ENFORCE=1   → 真路由，按决策覆盖 provider 选择
 *   CLAUDE_CODE_MODEL_ROUTER_FALLBACK=1  → 失败自动降级到 fallbackChain
 *
 * 默认全 OFF，零回归。
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'

export function isModelRouterEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_MODEL_ROUTER
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isModelRouterEnforceMode(): boolean {
  if (!isModelRouterEnabled()) return false
  const v = process.env.CLAUDE_CODE_MODEL_ROUTER_ENFORCE
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isModelRouterFallbackEnabled(): boolean {
  if (!isModelRouterEnabled()) return false
  const v = process.env.CLAUDE_CODE_MODEL_ROUTER_FALLBACK
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}
