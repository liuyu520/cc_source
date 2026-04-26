/**
 * periodicMaintenance —— 通用周期性维护任务注册表
 *
 * 使用方式(模块自行注册 tick):
 *
 *   registerPeriodicTask({
 *     name: 'my-cache-evict',
 *     intervalMs: 60_000,
 *     tick: () => evictExpiredSomething(),
 *     enabled: () => process.env.MY_FEATURE === '1', // 可选
 *   })
 *
 *   // 其中 registerPeriodicTask 从
 *   //   services/periodicMaintenance 模块导出(见下方 export 列表)
 *
 * 上层(通常是 REPL 启动路径)调用 startPeriodicMaintenance(projectDir)
 * 批量起所有已注册任务,stopPeriodicMaintenance() 停止。
 *
 * background.ts(agentScheduler)会在自身 start 时附带启动本注册表,
 * 并把 stats/adapt/speculation/cache-evict/tokenBudget-evict 等任务注册进来。
 */

export {
  __resetForTests,
  __setMinIntervalMsForTests,
  getPeriodicMaintenanceState,
  hasPeriodicTask,
  registerPeriodicTask,
  startPeriodicMaintenance,
  stopPeriodicMaintenance,
  unregisterPeriodicTask,
  type PeriodicMaintenanceSnapshot,
  type PeriodicTask,
  type PeriodicTaskContext,
  type PeriodicTaskRuntimeState,
} from './registry.js'
