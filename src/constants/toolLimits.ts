/**
 * Constants related to tool result size limits
 */

/**
 * Default maximum size in characters for tool results before they get persisted
 * to disk. When exceeded, the result is saved to a file and the model receives
 * a preview with the file path instead of the full content.
 *
 * Individual tools may declare a lower maxResultSizeChars, but this constant
 * acts as a system-wide cap regardless of what tools declare.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 第三方 API 无 prompt cache：使用更小的工具结果上限以节省 token。
 * 通过 CLAUDE_CODE_MAX_RESULT_SIZE 环境变量可覆盖。
 */
export const THIRD_PARTY_MAX_RESULT_SIZE_CHARS = 30_000

/**
 * 根据 API provider 返回实际的工具结果大小上限。
 * 第三方 API 默认使用更小的值（30K vs 50K），可通过环境变量覆盖。
 */
export function getEffectiveMaxResultSizeChars(): number {
  const envOverride = process.env.CLAUDE_CODE_MAX_RESULT_SIZE
  if (envOverride) {
    const parsed = parseInt(envOverride, 10)
    if (!isNaN(parsed) && parsed > 0) return parsed
  }
  try {
    const { getAPIProvider } = require('../utils/model/providers.js')
    if (getAPIProvider() === 'thirdParty') {
      return THIRD_PARTY_MAX_RESULT_SIZE_CHARS
    }
  } catch {
    // 模块加载失败时使用默认值
  }
  return DEFAULT_MAX_RESULT_SIZE_CHARS
}

/**
 * Maximum size for tool results in tokens.
 * Based on analysis of tool result sizes, we set this to a reasonable upper bound
 * to prevent excessively large tool results from consuming too much context.
 *
 * This is approximately 400KB of text (assuming ~4 bytes per token).
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/**
 * Bytes per token estimate for calculating token count from byte size.
 * This is a conservative estimate - actual token count may vary.
 */
export const BYTES_PER_TOKEN = 4

/**
 * Maximum size for tool results in bytes (derived from token limit).
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * Default maximum aggregate size in characters for tool_result blocks within
 * a SINGLE user message (one turn's batch of parallel tool results). When a
 * message's blocks together exceed this, the largest blocks in that message
 * are persisted to disk and replaced with previews until under budget.
 * Messages are evaluated independently — a 150K result in one turn and a
 * 150K result in the next are both untouched.
 *
 * This prevents N parallel tools from each hitting the per-tool max and
 * collectively producing e.g. 10 × 40K = 400K in one turn's user message.
 *
 * Overridable at runtime via GrowthBook flag tengu_hawthorn_window — see
 * getPerMessageBudgetLimit() in toolResultStorage.ts.
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/**
 * 第三方 API 的单条消息工具结果聚合上限（更小以节省 token）。
 */
export const THIRD_PARTY_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 100_000

/**
 * 根据 API provider 返回实际的单条消息工具结果聚合上限。
 */
export function getEffectiveMaxToolResultsPerMessageChars(): number {
  try {
    const { getAPIProvider } = require('../utils/model/providers.js')
    if (getAPIProvider() === 'thirdParty') {
      return THIRD_PARTY_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
    }
  } catch {
    // 模块加载失败时使用默认值
  }
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS
}

/**
 * Maximum character length for tool summary strings in compact views.
 * Used by getToolUseSummary() implementations to truncate long inputs
 * for display in grouped agent rendering.
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
