/**
 * 工具Schema转换器 — Anthropic tool definitions -> OpenAI function definitions
 *
 * Anthropic 的 input_schema 和 OpenAI 的 parameters 结构完全一致（都是 JSON Schema），
 * 只是外层包装字段名不同。
 *
 * 所有工具（包括 Anthropic 服务端工具类型）都转换为 function 工具传递给 OpenAI 模型，
 * 不做任何过滤。
 */

import type { FunctionTool } from '../types.js'

/** Anthropic 工具定义（简化版，兼容 SDK 类型） */
interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  type?: string
  [key: string]: unknown
}

/**
 * 将 Anthropic 工具定义数组转换为 OpenAI function 工具定义数组
 */
export function translateTools(tools: AnthropicTool[]): FunctionTool[] {
  return tools.map(translateSingleTool)
}

function translateSingleTool(tool: AnthropicTool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema as Record<string, unknown> | undefined,
    strict: false,
  }
}
