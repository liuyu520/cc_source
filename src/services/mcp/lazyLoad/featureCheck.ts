/**
 * MCP LazyLoad 运行时开关 (P1-2)
 *
 *   CLAUDE_CODE_MCP_LAZY_LOAD=1   → 启用懒加载（使用 manifest 缓存冷启动）
 *   CLAUDE_CODE_MCP_ONDEMAND_PROMPT=1 → 系统提示按需注入（需先启用 LAZY_LOAD）
 *   CLAUDE_CODE_MCP_HEALTH_ISOLATION=1 → 启用熔断隔离
 *   未设置                         → 默认禁用
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../../utils/envUtils.js'

export function isMcpLazyLoadEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_MCP_LAZY_LOAD
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

export function isMcpOnDemandPromptEnabled(): boolean {
  if (!isMcpLazyLoadEnabled()) return false
  return isEnvTruthy(process.env.CLAUDE_CODE_MCP_ONDEMAND_PROMPT)
}

export function isMcpHealthIsolationEnabled(): boolean {
  if (!isMcpLazyLoadEnabled()) return false
  const v = process.env.CLAUDE_CODE_MCP_HEALTH_ISOLATION
  if (isEnvDefinedFalsy(v)) return false
  return true
}
