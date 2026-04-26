/**
 * 预算守卫 — 控制侧查询总 token 消耗，避免超过主查询的 X%。
 *
 * 不依赖主循环内部状态，只在内存中累计：
 *   - 每次 submit 时按 estimatedTokens 预扣
 *   - 每次完成后按实际消耗修正（调用方可通过 telemetry 回传实际值）
 *
 * 窗口：按主查询轮次 (turn) 重置。若无法感知 turn，则按时间窗口(默认 60s)滚动。
 */

import type { SideQueryPriority, SideQueryTask } from './types.js'

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_BUDGET_TOKENS = 50_000 // 每窗口预算上限

/** 按 priority 推断的默认 token 预估 */
const DEFAULT_ESTIMATED_TOKENS: Record<SideQueryPriority, number> = {
  P0_blocking: 500,
  P1_quality: 2000,
  P2_method: 2000,
  P3_background: 5000,
}

export class BudgetGuard {
  private windowStart = Date.now()
  private consumed = 0

  constructor(
    private windowMs = DEFAULT_WINDOW_MS,
    private budgetTokens = DEFAULT_BUDGET_TOKENS,
  ) {}

  /** P0/P1 始终放行；P2/P3 检查预算 */
  allow(task: SideQueryTask): boolean {
    this.maybeRollWindow()
    if (task.priority === 'P0_blocking' || task.priority === 'P1_quality') {
      return true
    }
    const est = task.estimatedTokens ?? DEFAULT_ESTIMATED_TOKENS[task.priority]
    return this.consumed + est <= this.budgetTokens
  }

  charge(task: SideQueryTask, actualTokens?: number): void {
    this.maybeRollWindow()
    const tokens =
      actualTokens ?? task.estimatedTokens ?? DEFAULT_ESTIMATED_TOKENS[task.priority]
    this.consumed += tokens
  }

  snapshot(): { windowStart: number; consumed: number; budgetTokens: number } {
    this.maybeRollWindow()
    return {
      windowStart: this.windowStart,
      consumed: this.consumed,
      budgetTokens: this.budgetTokens,
    }
  }

  reset(): void {
    this.windowStart = Date.now()
    this.consumed = 0
  }

  private maybeRollWindow(): void {
    if (Date.now() - this.windowStart >= this.windowMs) {
      this.windowStart = Date.now()
      this.consumed = 0
    }
  }
}
