/**
 * SideQueryScheduler 入口聚合 (P0-1)
 *
 * 使用示例：
 *
 *   import { submitSideQuery } from 'src/services/sideQuery/index.js'
 *
 *   const result = await submitSideQuery({
 *     category: 'memory_recall',
 *     priority: 'P1_quality',
 *     source: 'side_question',
 *     dedupeKey: `memory_recall:${hash}`,
 *     run: async signal => callLlm(signal),
 *     fallback: () => localHeuristic(),
 *   })
 *
 *   if (result.status === 'ok') use(result.value)
 */

export type {
  SideQueryTask,
  SideQueryResult,
  SideQueryStatus,
  SideQueryPriority,
  SideQueryCategory,
} from './types.js'
export { sideQueryScheduler } from './scheduler.js'
export {
  isSideQuerySchedulerEnabled,
  isSideQueryCategoryEnabled,
} from './featureCheck.js'
export {
  onSideQueryEvent,
  sideQueryAggregator,
  type SideQueryTelemetryEvent,
} from './telemetry.js'

import { sideQueryScheduler } from './scheduler.js'
import type { SideQueryTask, SideQueryResult } from './types.js'

/** 便捷函数 */
export function submitSideQuery<T>(
  task: SideQueryTask<T>,
): Promise<SideQueryResult<T>> {
  return sideQueryScheduler.submit(task)
}
