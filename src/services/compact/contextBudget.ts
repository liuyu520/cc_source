import type { QuerySource } from '../../constants/querySource.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { getPromptSectionVolatility } from '../api/promptCacheBreakDetection.js'
import {
  roughTokenCountEstimation,
  roughTokenCountEstimationForMessages,
} from '../tokenEstimation.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { appendSystemContext, toolToAPISchema } from '../../utils/api.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'

export type PromptSectionVolatility = ReturnType<
  typeof getPromptSectionVolatility
>

export type ContextBudgetSection = {
  budgetTokens: number
  estimatedTokens: number
  overflowTokens: number
}

export type ContextBudgetAllocation = {
  totalWindowTokens: number
  inputBudgetTokens: number
  outputBudgetTokens: number
  sections: {
    system: ContextBudgetSection
    tools: ContextBudgetSection
    history: ContextBudgetSection
    output: ContextBudgetSection
  }
  stats: {
    usedTokens: number
    maxTokens: number
    ratio: number
  }
  volatility: PromptSectionVolatility
  shouldPrefetch: boolean
  reason: string
}

type ComputeContextBudgetInput = {
  totalWindowTokens: number
  outputBudgetTokens: number
  systemTokens: number
  toolsTokens: number
  historyTokens: number
  volatility?: PromptSectionVolatility
}

type EstimateContextBudgetInput = {
  messages: readonly Message[]
  model: string
  systemPrompt: SystemPrompt
  systemContext: Record<string, string>
  userContext: Record<string, string>
  tools: Tools
  toolUseContext: Pick<ToolUseContext, 'getAppState' | 'options' | 'agentId'>
  querySource?: QuerySource
  maxOutputTokensOverride?: number
  toolTokenEstimateOverride?: number
}

const MIN_SYSTEM_BUDGET_TOKENS = 2_048
const MIN_TOOLS_BUDGET_TOKENS = 4_096
const MIN_HISTORY_SHARE = 0.45
const BASE_SYSTEM_SHARE = 0.11
const BASE_TOOLS_SHARE = 0.17
const PREFETCH_RATIO_BASE = 0.88
const PREFETCH_HISTORY_BASE = 0.92

const DEFAULT_VOLATILITY = {
  system: 0,
  tools: 0,
  history: 0,
  hottestSection: 'none',
} as const satisfies PromptSectionVolatility

const toolTokenEstimateCache = new Map<string, number>()

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function buildToolEstimateCacheKey(model: string, tools: Tools): string {
  return `${model}:${tools.map(tool => tool.name).sort().join('|')}`
}

function stringifyUserContext(context: Record<string, string>): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

async function estimateToolPromptTokens(
  tools: Tools,
  model: string,
  toolUseContext: Pick<ToolUseContext, 'getAppState' | 'options'>,
): Promise<number> {
  if (tools.length === 0) {
    return 0
  }

  const cacheKey = buildToolEstimateCacheKey(model, tools)
  const cached = toolTokenEstimateCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: async () => permissionContext,
        tools,
        agents: toolUseContext.options.agentDefinitions.activeAgents,
        model,
      }),
    ),
  )
  const estimated = roughTokenCountEstimation(jsonStringify(toolSchemas))
  toolTokenEstimateCache.set(cacheKey, estimated)
  return estimated
}

export function computeContextBudgetAllocation(
  input: ComputeContextBudgetInput,
): ContextBudgetAllocation {
  const volatility = input.volatility ?? DEFAULT_VOLATILITY
  const inputBudgetTokens = Math.max(
    1,
    input.totalWindowTokens - input.outputBudgetTokens,
  )

  const hottestIs = {
    system: volatility.hottestSection === 'system',
    tools: volatility.hottestSection === 'tools',
    history: volatility.hottestSection === 'history',
  }

  let systemBudgetTokens = Math.round(
    inputBudgetTokens *
      (BASE_SYSTEM_SHARE +
        Math.min(0.04, volatility.system * 0.015) +
        (hottestIs.system ? 0.02 : 0)),
  )
  let toolsBudgetTokens = Math.round(
    inputBudgetTokens *
      (BASE_TOOLS_SHARE +
        Math.min(0.06, volatility.tools * 0.02) +
        (hottestIs.tools ? 0.03 : 0)),
  )

  const maxSystemBudget = Math.floor(inputBudgetTokens * 0.24)
  const maxToolsBudget = Math.floor(inputBudgetTokens * 0.30)
  const minSystemBudget = Math.min(MIN_SYSTEM_BUDGET_TOKENS, maxSystemBudget)
  const minToolsBudget = Math.min(MIN_TOOLS_BUDGET_TOKENS, maxToolsBudget)
  systemBudgetTokens = clamp(
    systemBudgetTokens,
    minSystemBudget,
    maxSystemBudget,
  )
  toolsBudgetTokens = clamp(
    toolsBudgetTokens,
    minToolsBudget,
    maxToolsBudget,
  )

  const minHistoryBudget = Math.floor(inputBudgetTokens * MIN_HISTORY_SHARE)
  let historyBudgetTokens =
    inputBudgetTokens - systemBudgetTokens - toolsBudgetTokens

  if (historyBudgetTokens < minHistoryBudget) {
    let deficit = minHistoryBudget - historyBudgetTokens

    const reducibleTools = Math.max(
      0,
      toolsBudgetTokens - minToolsBudget,
    )
    const toolsReduction = Math.min(deficit, reducibleTools)
    toolsBudgetTokens -= toolsReduction
    deficit -= toolsReduction

    const reducibleSystem = Math.max(
      0,
      systemBudgetTokens - minSystemBudget,
    )
    const systemReduction = Math.min(deficit, reducibleSystem)
    systemBudgetTokens -= systemReduction
    deficit -= systemReduction

    historyBudgetTokens = inputBudgetTokens - systemBudgetTokens - toolsBudgetTokens
  }

  const systemOverflow = Math.max(0, input.systemTokens - systemBudgetTokens)
  const toolsOverflow = Math.max(0, input.toolsTokens - toolsBudgetTokens)
  const historyOverflow = Math.max(0, input.historyTokens - historyBudgetTokens)
  const usedTokens = input.systemTokens + input.toolsTokens + input.historyTokens
  const ratio = usedTokens / inputBudgetTokens

  const historyVolatilityBias =
    Math.min(0.06, volatility.history * 0.02) + (hottestIs.history ? 0.03 : 0)
  const prefetchRatio = Math.max(0.72, PREFETCH_RATIO_BASE - historyVolatilityBias)
  const prefetchHistoryRatio = Math.max(
    0.78,
    PREFETCH_HISTORY_BASE - historyVolatilityBias,
  )

  const shouldPrefetch =
    historyOverflow > 0 ||
    systemOverflow > 0 ||
    toolsOverflow > 0 ||
    ratio >= prefetchRatio ||
    input.historyTokens >= historyBudgetTokens * prefetchHistoryRatio

  let reason = 'within budget'
  if (historyOverflow > 0) {
    reason = `history overflow ${historyOverflow} tokens`
  } else if (toolsOverflow > 0) {
    reason = `tools overflow ${toolsOverflow} tokens`
  } else if (systemOverflow > 0) {
    reason = `system overflow ${systemOverflow} tokens`
  } else if (ratio >= prefetchRatio) {
    reason = `total ratio ${ratio.toFixed(2)} >= prefetch ${prefetchRatio.toFixed(2)}`
  } else if (input.historyTokens >= historyBudgetTokens * prefetchHistoryRatio) {
    reason = `history ratio ${(input.historyTokens / historyBudgetTokens).toFixed(2)} >= prefetch ${prefetchHistoryRatio.toFixed(2)}`
  }

  return {
    totalWindowTokens: input.totalWindowTokens,
    inputBudgetTokens,
    outputBudgetTokens: input.outputBudgetTokens,
    sections: {
      system: {
        budgetTokens: systemBudgetTokens,
        estimatedTokens: input.systemTokens,
        overflowTokens: systemOverflow,
      },
      tools: {
        budgetTokens: toolsBudgetTokens,
        estimatedTokens: input.toolsTokens,
        overflowTokens: toolsOverflow,
      },
      history: {
        budgetTokens: historyBudgetTokens,
        estimatedTokens: input.historyTokens,
        overflowTokens: historyOverflow,
      },
      output: {
        budgetTokens: input.outputBudgetTokens,
        estimatedTokens: 0,
        overflowTokens: 0,
      },
    },
    stats: {
      usedTokens,
      maxTokens: inputBudgetTokens,
      ratio,
    },
    volatility,
    shouldPrefetch,
    reason,
  }
}

export async function estimateContextBudgetAllocation(
  input: EstimateContextBudgetInput,
): Promise<ContextBudgetAllocation> {
  const outputBudgetTokens =
    input.maxOutputTokensOverride ?? getMaxOutputTokensForModel(input.model)
  const totalWindowTokens = getContextWindowForModel(input.model)
  // system budget also includes userContext because it is a stable prompt
  // prefix injected ahead of the message history on every request.
  const systemTokens = roughTokenCountEstimation(
    [
      ...appendSystemContext(input.systemPrompt, input.systemContext),
      stringifyUserContext(input.userContext),
    ]
      .filter(Boolean)
      .join('\n\n'),
  )
  const historyTokens = roughTokenCountEstimationForMessages(input.messages)
  const toolsTokens =
    input.toolTokenEstimateOverride ??
    (await estimateToolPromptTokens(
      input.tools,
      input.model,
      input.toolUseContext,
    ))
  const volatility = input.querySource
    ? getPromptSectionVolatility(input.querySource, input.toolUseContext.agentId)
    : DEFAULT_VOLATILITY

  return computeContextBudgetAllocation({
    totalWindowTokens,
    outputBudgetTokens,
    systemTokens,
    toolsTokens,
    historyTokens,
    volatility,
  })
}
