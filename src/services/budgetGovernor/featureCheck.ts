/**
 * BudgetGovernor 特性开关
 *
 * CLAUDE_BUDGET_GOVERNOR=off     → 完全禁用,不评估也不写 evidence
 * CLAUDE_BUDGET_GOVERNOR=shadow  → 评估 + 写 evidence,不广播任何行为(默认)
 * CLAUDE_BUDGET_GOVERNOR=warn    → shadow + 未来用于 UI 软提示
 * CLAUDE_BUDGET_GOVERNOR=on      → warn + 未来用于真阻止新 fan-out
 *
 * shadow / warn / on 都需要 CLAUDE_CODE_HARNESS_PRIMITIVES 同时开启(默认开)
 * 才会真正写入 evidence ledger。
 */

export type BudgetGovernorMode = 'off' | 'shadow' | 'warn' | 'on'

/** 读取 CLAUDE_BUDGET_GOVERNOR 环境变量,默认 'shadow' */
export function getBudgetGovernorMode(): BudgetGovernorMode {
  const raw = (process.env.CLAUDE_BUDGET_GOVERNOR ?? '').trim().toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off'
  if (raw === 'warn') return 'warn'
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes') return 'on'
  // 显式 shadow 或未设置 → shadow
  return 'shadow'
}

export function isBudgetGovernorEnabled(): boolean {
  return getBudgetGovernorMode() !== 'off'
}

export function isBudgetGovernorWarnOrAbove(): boolean {
  const m = getBudgetGovernorMode()
  return m === 'warn' || m === 'on'
}

export function isBudgetGovernorOn(): boolean {
  return getBudgetGovernorMode() === 'on'
}
