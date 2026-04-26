import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { formatPromptCacheSummary } from '../../utils/promptCacheMetrics.js'
import { formatPromptCacheOrderingSummary } from '../../utils/promptCacheOrdering.js'
import { formatBudgetGovernorSummary } from '../../services/budgetGovernor/index.js'
import { formatBudgetLedgerSummary } from '../../services/contextSignals/budgetLedger.js'

/**
 * 附加 shadow subsystem 摘要(多条消费者闭环):
 *   - G 线: CLAUDE_PROMPT_CACHE_METRICS=shadow|on 且有样本 → 命中率
 *   - Q9:   CLAUDE_PROMPT_CACHE_ORDER=shadow|on 且有样本 → attachment 逆序率
 *   - D 线: CLAUDE_BUDGET_GOVERNOR=shadow|warn|on 且有 evidence → budget 档位
 *   - Phase 55: context budget ledger 有样本 → system/tools/history/output footprint
 *   - 任一子项为空皆静默忽略,/cost 在未开 shadow 时体感无回归
 */
function appendShadowSummaries(base: string): string {
  const metrics = formatPromptCacheSummary(50)
  const ordering = formatPromptCacheOrderingSummary(50)
  const budget = formatBudgetGovernorSummary(50)
  const footprint = formatBudgetLedgerSummary()
  if (!metrics && !ordering && !budget && !footprint) return base
  const parts = [base]
  if (metrics) parts.push('', metrics)
  if (ordering) parts.push(ordering)
  if (budget) parts.push(budget)
  if (footprint) parts.push(footprint)
  return parts.join('\n')
}

export const call: LocalCommandCall = async () => {
  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value: appendShadowSummaries(value) }
  }
  return { type: 'text', value: appendShadowSummaries(formatTotalCost()) }
}
