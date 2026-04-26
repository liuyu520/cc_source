/**
 * BudgetGovernor · 纯函数评估层
 *
 * 把 "session 累计成本 + 配置阈值" 映射为 BudgetVerdict,不访问任何 I/O,
 * 不写 evidence,不广播事件 —— 便于单测,也让上层 index.ts 负责副作用。
 */

/** 预算配置,由 index.ts 从 settings.json 读出并传入 */
export interface BudgetConfig {
  /** 单会话总预算(USD),例如 2.0 */
  perSessionUsd: number
  /** 软警告阈值比例(0-1),超过即 soft_warn,例如 0.8 */
  softWarnRatio: number
  /** 硬限阈值比例(>=1.0),超过即 force_summary_and_halt,例如 1.5 */
  forceHaltRatio: number
}

/** 评估档位 */
export type BudgetLevel = 'ok' | 'soft_warn' | 'stop_sub_agents' | 'force_summary_and_halt'

export interface BudgetVerdict {
  /** 档位 */
  level: BudgetLevel
  /** 当前花费(USD) */
  currentUsd: number
  /** 单会话预算(USD) */
  perSessionUsd: number
  /** 已消耗的预算比例,保留两位小数 */
  spentRatio: number
  /** 触发 level 的人类可读原因 */
  reason: string
}

/** 默认配置,与文档 §5.3 对齐 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  perSessionUsd: 2.0,
  softWarnRatio: 0.8,
  forceHaltRatio: 1.5,
}

/**
 * 纯函数评估:给定当前 session 累计 cost + 配置,返回 verdict。
 * level 升序:ok < soft_warn < stop_sub_agents < force_summary_and_halt。
 */
export function evaluateBudget(
  currentUsd: number,
  config: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): BudgetVerdict {
  // fail-open:任何非法输入都当作 ok
  const safePerSession =
    Number.isFinite(config.perSessionUsd) && config.perSessionUsd > 0
      ? config.perSessionUsd
      : DEFAULT_BUDGET_CONFIG.perSessionUsd
  const safeSoftRatio =
    Number.isFinite(config.softWarnRatio) && config.softWarnRatio > 0
      ? config.softWarnRatio
      : DEFAULT_BUDGET_CONFIG.softWarnRatio
  const safeForceRatio =
    Number.isFinite(config.forceHaltRatio) && config.forceHaltRatio > 1
      ? config.forceHaltRatio
      : DEFAULT_BUDGET_CONFIG.forceHaltRatio

  const safeCurrent =
    Number.isFinite(currentUsd) && currentUsd >= 0 ? currentUsd : 0
  const ratio = safeCurrent / safePerSession
  const spentRatio = Math.round(ratio * 100) / 100

  let level: BudgetLevel = 'ok'
  let reason = `cost=$${safeCurrent.toFixed(4)} within budget $${safePerSession.toFixed(2)}`

  if (ratio >= safeForceRatio) {
    level = 'force_summary_and_halt'
    reason = `cost=$${safeCurrent.toFixed(4)} exceeded ${Math.round(safeForceRatio * 100)}% of $${safePerSession.toFixed(2)}`
  } else if (ratio >= 1.0) {
    level = 'stop_sub_agents'
    reason = `cost=$${safeCurrent.toFixed(4)} exceeded 100% of $${safePerSession.toFixed(2)}`
  } else if (ratio >= safeSoftRatio) {
    level = 'soft_warn'
    reason = `cost=$${safeCurrent.toFixed(4)} exceeded ${Math.round(safeSoftRatio * 100)}% of $${safePerSession.toFixed(2)}`
  }

  return {
    level,
    currentUsd: safeCurrent,
    perSessionUsd: safePerSession,
    spentRatio,
    reason,
  }
}
