/**
 * SideQueryScheduler 运行时开关 — 与 services/skillSearch/featureCheck.ts 风格对齐。
 *
 * 环境变量：
 *   CLAUDE_CODE_SIDE_QUERY_SCHEDULER=1  → 启用
 *   CLAUDE_CODE_SIDE_QUERY_SCHEDULER=0  → 禁用
 *   未设置                               → 默认禁用（影子模式期保持零风险）
 *
 * 未来可按 category 提供子开关（SIDE_QUERY_MEMORY_RECALL 等）。
 */

import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import type { SideQueryCategory } from './types.js'

export function isSideQuerySchedulerEnabled(): boolean {
  const v = process.env.CLAUDE_CODE_SIDE_QUERY_SCHEDULER
  if (isEnvDefinedFalsy(v)) return false
  if (isEnvTruthy(v)) return true
  return false
}

/** 细分 category 子开关；默认与主开关一致 */
export function isSideQueryCategoryEnabled(category: SideQueryCategory): boolean {
  if (!isSideQuerySchedulerEnabled()) return false
  const envKey = `CLAUDE_CODE_SIDE_QUERY_${category.toUpperCase()}`
  const v = process.env[envKey]
  if (isEnvDefinedFalsy(v)) return false
  return true
}
