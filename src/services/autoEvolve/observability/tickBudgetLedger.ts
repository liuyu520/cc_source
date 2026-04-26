/**
 * G10 Step 1 (2026-04-26) —— periodicMaintenance tick 耗时/成败 旁路观察层。
 *
 * 动机:
 *   13+ 后台 tick 任务(agentScheduler/background.ts 里就有 13 个 registerPeriodicTask)
 *   各自 setInterval 跑,没有统一 budget——CPU / API token / wall clock 无共享视图。
 *   接入全局 budget 调度器是个大动作;先落地"真实历史负载"ledger 观察层:
 *   - 每次 runTick 完成时(无论成功失败)旁路写一行 NDJSON;
 *   - 记 taskName / durationMs / success / error / tickCount;
 *   - 为未来 Step 2 (budgetCoordinator) 打底。
 *
 * 约束:
 *   - shadow-only:开关关闭时直接返回 false,不改 tick 行为;
 *   - fail-open:异常全吞,不影响 runTick 主路径;
 *   - 与其它 oracle ledger 共享 rotation/size 策略。
 */

import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import { getTickBudgetLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type TickOutcome = 'success' | 'error' | 'skipped'

export interface TickBudgetSample {
  /** periodic task 名,如 'agentStats' / 'adaptScheduler' / 'maybeRunSpeculation' */
  taskName: string
  /** 本次 tick 耗时(ms),skipped 时为 0 */
  durationMs: number
  /** 结果:success=tick 成功返回;error=tick 抛错;skipped=enabled() 返回 false 未执行 */
  outcome: TickOutcome
  /** error 时的 message;其它 undefined */
  errorMessage?: string
  /** 当前 tick 计数(成功后的值;error/skipped 为执行前计数) */
  tickCount: number
  /** 配置的 intervalMs,便于计算 duty cycle */
  intervalMs: number
}

function isLedgerEnabled(): boolean {
  const raw = (process.env.CLAUDE_TICK_BUDGET_LEDGER ?? '')
    .toString()
    .trim()
    .toLowerCase()
  return !(raw === 'off' || raw === '0' || raw === 'false')
}

/**
 * 记录单次 tick 样本。
 * @returns true=写入成功;false=关闭或失败(fail-open)
 */
export function recordTickSample(sample: TickBudgetSample): boolean {
  if (!isLedgerEnabled()) return false
  try {
    const payload = {
      at: new Date().toISOString(),
      taskName: sample.taskName,
      durationMs: Math.max(0, Math.round(sample.durationMs)),
      outcome: sample.outcome,
      errorMessage: sample.errorMessage,
      tickCount: sample.tickCount,
      intervalMs: sample.intervalMs,
      pid: process.pid,
    }
    return appendJsonLine(getTickBudgetLedgerPath(), payload)
  } catch (e) {
    logForDebugging(
      `[tickBudgetLedger] append failed: ${(e as Error).message}`,
    )
    return false
  }
}
