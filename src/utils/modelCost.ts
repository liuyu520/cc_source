import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'
// 从注册表导入定价层级常量（注册表是 single source of truth）
import {
  PRICING_TIER_3_15,
  PRICING_TIER_15_75,
  PRICING_TIER_5_25,
  PRICING_TIER_30_150,
  PRICING_HAIKU_35,
  PRICING_HAIKU_45,
  getModelPricingFromRegistry,
} from './model/registry.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

// 向后兼容：保留原有常量名导出，引用注册表中的定价层级
// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = PRICING_TIER_3_15

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = PRICING_TIER_15_75

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = PRICING_TIER_5_25

// Fast mode pricing for Opus 4.6: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = PRICING_TIER_30_150

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = PRICING_HAIKU_35

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = PRICING_HAIKU_45

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

// OpenAI 模型定价（$ per Mtok）— 用于 Codex provider 费用估算
// @see https://openai.com/api/pricing/
const OPENAI_PRICING_GPT4O: ModelCosts = {
  inputTokens: 2.5,
  outputTokens: 10,
  promptCacheWriteTokens: 2.5,
  promptCacheReadTokens: 1.25,
  webSearchRequests: 0,
}

const OPENAI_PRICING_GPT4O_MINI: ModelCosts = {
  inputTokens: 0.15,
  outputTokens: 0.6,
  promptCacheWriteTokens: 0.15,
  promptCacheReadTokens: 0.075,
  webSearchRequests: 0,
}

const OPENAI_PRICING_O3: ModelCosts = {
  inputTokens: 2,
  outputTokens: 8,
  promptCacheWriteTokens: 2,
  promptCacheReadTokens: 1,
  webSearchRequests: 0,
}

const OPENAI_PRICING_O3_MINI: ModelCosts = {
  inputTokens: 1.1,
  outputTokens: 4.4,
  promptCacheWriteTokens: 1.1,
  promptCacheReadTokens: 0.55,
  webSearchRequests: 0,
}

const OPENAI_PRICING_O4_MINI: ModelCosts = {
  inputTokens: 1.1,
  outputTokens: 4.4,
  promptCacheWriteTokens: 1.1,
  promptCacheReadTokens: 0.55,
  webSearchRequests: 0,
}

const OPENAI_PRICING_GPT41: ModelCosts = {
  inputTokens: 2,
  outputTokens: 8,
  promptCacheWriteTokens: 2,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0,
}

// OpenAI 模型名 → 定价映射（codex provider 使用的模型名直接查此表）
const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  'gpt-4o': OPENAI_PRICING_GPT4O,
  'gpt-4o-2024-11-20': OPENAI_PRICING_GPT4O,
  'gpt-4o-mini': OPENAI_PRICING_GPT4O_MINI,
  'o3': OPENAI_PRICING_O3,
  'o3-mini': OPENAI_PRICING_O3_MINI,
  'o4-mini': OPENAI_PRICING_O4_MINI,
  'gpt-4.1': OPENAI_PRICING_GPT41,
  'gpt-4.1-mini': OPENAI_PRICING_GPT4O_MINI,
  'gpt-4.1-nano': OPENAI_PRICING_GPT4O_MINI,
}

/**
 * Get the cost tier for Opus 4.6 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  // 优先查 OpenAI 模型定价（Codex provider 的模型名不经过 getCanonicalName 转换）
  const openaiCosts = OPENAI_MODEL_COSTS[model]
  if (openaiCosts) return openaiCosts

  const shortName = getCanonicalName(model)

  // Check if this is an Opus 4.6 model with fast mode active.
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    trackUnknownModelCost(model, shortName)
    return (
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

// Calculate the cost of a query in US dollars.
// If the model's costs are not found, use the default model's costs.
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

function formatPrice(price: number): string {
  // Format price: integers without decimals, others with 2 decimal places
  // e.g., 3 -> "$3", 0.8 -> "$0.80", 22.5 -> "$22.50"
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  return `$${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
