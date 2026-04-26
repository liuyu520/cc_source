import { describe, expect, test } from 'bun:test'
import { computeContextBudgetAllocation } from './contextBudget.js'
import { scoreMessagesAgainstCurrentTask } from './orchestrator/importance.js'

describe('context budget allocation', () => {
  test('prefetches when history exceeds its independent budget', () => {
    const allocation = computeContextBudgetAllocation({
      totalWindowTokens: 100_000,
      outputBudgetTokens: 8_000,
      systemTokens: 5_000,
      toolsTokens: 12_000,
      historyTokens: 71_000,
      volatility: {
        system: 0.2,
        tools: 0.4,
        history: 1.6,
        hottestSection: 'history',
      },
    })

    expect(allocation.sections.output.budgetTokens).toBe(8_000)
    expect(allocation.sections.history.overflowTokens).toBeGreaterThan(0)
    expect(allocation.shouldPrefetch).toBe(true)
    expect(allocation.reason).toContain('history')
  })
})

describe('message relevance scoring', () => {
  test('ranks messages aligned with the current task above unrelated history', () => {
    const messages = [
      {
        type: 'user',
        message: {
          content:
            '继续实现 context budget allocator，重点看 src/query.ts 和 autoCompact.ts',
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Inspected src/query.ts and traced autoCompact threshold drift.',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Reviewed an unrelated Slack GIF workflow and export path.',
            },
          ],
        },
      },
    ]

    const scores = scoreMessagesAgainstCurrentTask(messages)

    expect(scores[1]).toBeGreaterThan(scores[2])
  })
})
