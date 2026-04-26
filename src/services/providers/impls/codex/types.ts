/**
 * OpenAI Responses API 类型定义
 *
 * 与 Codex (codex-rs) 使用相同的 OpenAI Responses API 协议。
 * 这些类型对应 POST /v1/responses 的请求/响应/SSE事件格式。
 */

// ==================== 请求类型 ====================

/** OpenAI Responses API 请求体 */
export interface ResponsesApiRequest {
  model: string
  instructions?: string
  input: ResponseItem[]
  tools?: FunctionTool[]
  tool_choice?: string
  parallel_tool_calls?: boolean
  reasoning?: ReasoningConfig
  store?: boolean
  stream: boolean
  include?: string[]
  service_tier?: string
  text?: TextControls
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  stop?: string[]
}

export interface ReasoningConfig {
  // OpenAI/Codex Responses API 支持更高一档的 xhigh，对应界面里的 Extra high。
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  summary?: 'auto' | 'concise' | 'detailed' | null
}

export interface TextControls {
  format?: { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown }
}

// ==================== ResponseItem 变体 ====================

export type ResponseItem =
  | MessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem

/** 消息项（用户或助手消息） */
export interface MessageItem {
  type: 'message'
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: MessageContentPart[]
  status?: string
}

export type MessageContentPart =
  | InputTextPart
  | OutputTextPart
  | InputImagePart
  | InputFilePart

export interface InputTextPart {
  type: 'input_text'
  text: string
}

export interface OutputTextPart {
  type: 'output_text'
  text: string
}

export interface InputImagePart {
  type: 'input_image'
  image_url: string
  detail?: 'auto' | 'low' | 'high'
}

export interface InputFilePart {
  type: 'input_file'
  file_data?: string
  filename?: string
}

/** 函数调用项 */
export interface FunctionCallItem {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
  status?: string
}

/** 函数调用输出项 */
export interface FunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** 推理/思维项 */
export interface ReasoningItem {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: 'summary_text'; text: string }>
}

// ==================== 工具定义 ====================

export interface FunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

// ==================== SSE 响应事件 ====================

/** SSE 事件的统一类型 */
export type ResponseEvent =
  | ResponseCreatedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseOutputTextDeltaEvent
  | ResponseOutputTextDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseReasoningContentDeltaEvent
  | ResponseContentPartAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseFailedEvent
  | ResponseInProgressEvent
  | ResponseRateLimitsEvent

export interface ResponseCreatedEvent {
  type: 'response.created'
  response: ResponseObject
}

export interface ResponseInProgressEvent {
  type: 'response.in_progress'
  response: ResponseObject
}

export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added'
  output_index: number
  item: ResponseOutputItem
}

export interface ResponseOutputItemDoneEvent {
  type: 'response.output_item.done'
  output_index: number
  item: ResponseOutputItem
}

export interface ResponseContentPartAddedEvent {
  type: 'response.content_part.added'
  output_index: number
  content_index: number
  part: MessageContentPart
}

export interface ResponseContentPartDoneEvent {
  type: 'response.content_part.done'
  output_index: number
  content_index: number
  part: MessageContentPart
}

export interface ResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta'
  output_index: number
  content_index: number
  delta: string
}

export interface ResponseOutputTextDoneEvent {
  type: 'response.output_text.done'
  output_index: number
  content_index: number
  text: string
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta'
  output_index: number
  call_id: string
  delta: string
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done'
  output_index: number
  call_id: string
  arguments: string
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  type: 'response.reasoning_summary_text.delta'
  output_index: number
  summary_index: number
  delta: string
}

export interface ResponseReasoningSummaryTextDoneEvent {
  type: 'response.reasoning_summary_text.done'
  output_index: number
  summary_index: number
  text: string
}

export interface ResponseReasoningContentDeltaEvent {
  type: 'response.reasoning_content.delta'
  output_index: number
  delta: string
}

export interface ResponseCompletedEvent {
  type: 'response.completed'
  response: ResponseObject
}

export interface ResponseFailedEvent {
  type: 'response.failed'
  response: ResponseObject
}

/** response.incomplete — 请求因 max_tokens 等原因提前终止（独立于 response.completed + status: incomplete） */
export interface ResponseIncompleteEvent {
  type: 'response.incomplete'
  response: ResponseObject
}

export interface ResponseRateLimitsEvent {
  type: 'response.rate_limits'
  rate_limits: Array<{
    name: string
    limit: number
    remaining: number
    reset_seconds: number
  }>
}

// ==================== Response 对象 ====================

export interface ResponseObject {
  id: string
  object: 'response'
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete'
  model?: string
  output?: ResponseOutputItem[]
  usage?: ResponseUsage
  error?: {
    type: string
    message: string
    code?: string
  }
}

export type ResponseOutputItem = MessageItem | FunctionCallItem | ReasoningItem

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens: number
}

// ==================== SSE 解析辅助 ====================

/** 解析后的 SSE 事件 */
export interface ParsedSSEEvent {
  event: string
  data: string
}
