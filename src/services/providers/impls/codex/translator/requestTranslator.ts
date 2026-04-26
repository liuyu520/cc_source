/**
 * 请求转换器 — 将完整的 Anthropic Messages API 参数转换为 OpenAI Responses API 请求
 *
 * 这是翻译层的最顶层入口，协调 messageTranslator 和 toolTranslator 完成
 * 从 Anthropic 格式到 OpenAI Responses API 格式的完整转换。
 */

import type { ResponsesApiRequest, ReasoningConfig } from '../types.js'
import { getCodexConfiguredReasoningEffort } from '../auth.js'
import { translateMessages } from './messageTranslator.js'
import { translateTools } from './toolTranslator.js'

/**
 * Anthropic Messages API 参数（简化版，兼容 SDK 参数类型）
 */
interface AnthropicCreateParams {
  model: string
  system?: string | Array<{ type: string; text?: string; [k: string]: unknown }>
  messages: Array<{ role: string; content: unknown; [k: string]: unknown }>
  tools?: Array<{ name: string; description?: string; input_schema?: unknown; [k: string]: unknown }>
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  metadata?: unknown
  stop_sequences?: string[]
  tool_choice?: unknown
  thinking?: {
    type: string
    budget_tokens?: number
    [k: string]: unknown
  }
  // Prefer upstream effort; fall back to Codex CLI config for Codex-only sessions.
  effortValue?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | number
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | number
    [k: string]: unknown
  }
  [key: string]: unknown
}

/**
 * 将 Anthropic Messages API create() 参数转换为 OpenAI Responses API 请求
 */
export function translateRequest(
  params: AnthropicCreateParams,
  modelOverride?: string,
): ResponsesApiRequest {
  // 1. 转换 system prompt → instructions
  const instructions = translateSystemPrompt(params.system)

  // 2. 转换 messages → input (ResponseItem[])
  const normalizedMessages = params.messages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string | Array<{ type: string; [k: string]: unknown }>,
  }))
  const input = translateMessages(normalizedMessages)

  // 3. 转换 tools → function definitions
  const tools = params.tools
    ? translateTools(params.tools as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>)
    : undefined

  // 4. 转换 thinking / effort → reasoning
  const hasTools = !!(params.tools && params.tools.length > 0)
  const reasoning = translateReasoning(params, hasTools)

  // 5. 组装请求
  const request: ResponsesApiRequest = {
    model: modelOverride ?? params.model,
    stream: params.stream !== false, // 默认 true
    input,
    store: false, // OpenAI API 要求显式设置
  }

  // 可选字段
  if (instructions) {
    request.instructions = instructions
  }
  if (tools && tools.length > 0) {
    request.tools = tools
    request.tool_choice = translateToolChoice(params.tool_choice)
    request.parallel_tool_calls = true
  }
  if (reasoning) {
    request.reasoning = reasoning
    // OpenAI API 规定：reasoning 模式下不允许 temperature 和 top_p 参数
  } else {
    // 对 Codex / Responses API 兼容层：默认不要透传 Anthropic 的 temperature=1。
    // 只有显式设置为非默认值时才下发，避免某些兼容端点直接报 unsupported parameter。
    if (params.temperature !== undefined && params.temperature !== 1) {
      request.temperature = params.temperature
    }
    // 对 Codex / Responses API 兼容层：默认不要透传 Anthropic 的 top_p=1。
    // 只有显式设置为非默认值时才下发，减少兼容端点的 unsupported parameter。
    if (params.top_p !== undefined && params.top_p !== 1) {
      request.top_p = params.top_p
    }
  }

  // 对 Codex / Responses API 兼容层：默认不要透传 Anthropic 的 max_tokens。
  // 某些兼容端点不接受 max_output_tokens，保留 CODEX_SKIP_MAX_TOKENS 旧开关语义，
  // 但默认即跳过，只有显式开启 CODEX_ENABLE_MAX_OUTPUT_TOKENS=1 时才下发。
  if (
    params.max_tokens &&
    process.env.CODEX_SKIP_MAX_TOKENS !== '1' &&
    process.env.CODEX_ENABLE_MAX_OUTPUT_TOKENS === '1'
  ) {
    request.max_output_tokens = params.max_tokens
  }

  // stop_sequences → stop：尽力透传，不阻塞请求
  if (params.stop_sequences && params.stop_sequences.length > 0) {
    request.stop = params.stop_sequences
  }

  return request
}

/**
 * system prompt 转换: Anthropic system → OpenAI instructions
 *
 * Anthropic 的 system 可以是字符串或 content block 数组（含 cache_control）。
 * OpenAI 的 instructions 是纯字符串。
 */
function translateSystemPrompt(
  system: AnthropicCreateParams['system'],
): string | undefined {
  if (!system) return undefined

  if (typeof system === 'string') {
    return system
  }

  // 数组格式：提取所有 text block 的文本，拼接
  const texts: string[] = []
  for (const block of system) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
    }
  }

  return texts.length > 0 ? texts.join('\n\n') : undefined
}

/**
 * thinking 配置转换: Anthropic thinking → OpenAI reasoning
 *
 * 支持三种 thinking 类型：
 *   - 'disabled' → undefined（不启用推理）
 *   - 'adaptive' → 根据上下文智能选择 effort（有 tools 时 medium，否则 low）
 *   - 'enabled' + budget_tokens → 精细映射：
 *       ≤ 1000  → low
 *       ≤ 4000  → medium
 *       > 4000  → high
 */
function translateReasoning(
  params: AnthropicCreateParams,
  hasTools?: boolean,
): ReasoningConfig | undefined {
  const directEffort = normalizeCodexEffort(
    params.effortValue ??
      params.output_config?.effort ??
      getCodexConfiguredReasoningEffort(),
  )
  if (directEffort) {
    return {
      effort: directEffort,
      summary: 'auto',
    }
  }

  return translateThinking(params.thinking, hasTools)
}

function translateThinking(
  thinking?: AnthropicCreateParams['thinking'],
  hasTools?: boolean,
): ReasoningConfig | undefined {
  if (!thinking) return undefined
  if (thinking.type === 'disabled') return undefined

  // adaptive 模式：有工具调用时用 medium（工具选择需要推理），否则 low
  if (thinking.type === 'adaptive') {
    return {
      effort: hasTools ? 'medium' : 'low',
      summary: 'auto',
    }
  }

  // type === 'enabled': 根据 budget_tokens 精细映射 effort
  const budget = thinking.budget_tokens ?? 10000
  let effort: 'low' | 'medium' | 'high'
  if (budget <= 1000) {
    effort = 'low'
  } else if (budget <= 4000) {
    effort = 'medium'
  } else {
    effort = 'high'
  }

  return {
    effort,
    summary: 'auto',
  }
}

function normalizeCodexEffort(
  effort: AnthropicCreateParams['effortValue'] | AnthropicCreateParams['output_config'] extends undefined
    ? never
    : AnthropicCreateParams['output_config']['effort'],
): ReasoningConfig['effort'] | undefined {
  if (typeof effort === 'number') {
    if (effort <= 50) return 'low'
    if (effort <= 85) return 'medium'
    if (effort <= 100) return 'high'
    return 'xhigh'
  }

  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
      return effort
    case 'max':
    case 'xhigh':
      // Claude 4-7 机型的 'xhigh' 直接透传；'max' 也映射到 Codex 的 xhigh 档，
      // 因为 Codex Responses API 的最高档即 xhigh，没有更高一级。
      return 'xhigh'
    default:
      return undefined
  }
}

/**
 * tool_choice 翻译: Anthropic → OpenAI Responses API
 *
 * Anthropic 格式:
 *   - { type: 'auto' }     → 'auto'
 *   - { type: 'any' }      → 'required' (必须调用某个工具)
 *   - { type: 'none' }     → 'none'
 *   - { type: 'tool', name: 'xxx' } → { type: 'function', name: 'xxx' }
 *   - 'auto' / 'any' / 'none' (字符串简写)
 */
function translateToolChoice(choice: unknown): string | { type: string; name?: string } {
  if (!choice) return 'auto'

  if (typeof choice === 'string') {
    if (choice === 'any') return 'required'
    return choice // 'auto' | 'none'
  }

  if (typeof choice === 'object' && choice !== null) {
    const c = choice as Record<string, unknown>
    if (c.type === 'auto') return 'auto'
    if (c.type === 'any') return 'required'
    if (c.type === 'none') return 'none'
    if (c.type === 'tool' && typeof c.name === 'string') {
      return { type: 'function', name: c.name }
    }
  }

  return 'auto'
}
