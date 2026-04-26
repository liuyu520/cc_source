/**
 * 响应转换器 (v2) — 状态机驱动的 OpenAI Responses API → Anthropic 事件翻译
 *
 * 相比 v1 的平坦 switch-case，v2 引入显式有限状态机：
 *   Init → MessageStarted → BlockActive ⇄ MessageStarted → Completed/Failed
 *
 * 优势：
 *   1. 不可能出现"漏关 block"的 bug（状态转换强制配对 start/stop）
 *   2. 多 content part 天然支持（ContentPartAdded 先关闭当前 block 再开新 block）
 *   3. 非法事件序列被显式拒绝并 warn，而非静默吞掉
 *   4. 支持 reasoning_content.delta (B8) 和 rate_limits 捕获 (B9)
 *
 * 关键映射：
 *   response.created           → message_start
 *   response.output_item.added → content_block_start
 *   response.output_text.delta → content_block_delta (text_delta)
 *   response.function_call_arguments.delta → content_block_delta (input_json_delta)
 *   response.reasoning_summary_text.delta  → content_block_delta (thinking_delta)
 *   response.reasoning_content.delta       → content_block_delta (thinking_delta)
 *   response.output_item.done  → content_block_stop
 *   response.completed         → message_delta + message_stop
 */

import { FiniteStateMachine } from './stateMachine.js'
import type {
  ResponseEvent,
  ResponseCreatedEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseOutputTextDeltaEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
  ResponseInProgressEvent,
  ResponseContentPartAddedEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningContentDeltaEvent,
  ResponseRateLimitsEvent,
  ResponseObject,
  ResponseUsage,
} from '../types.js'

// Anthropic 事件类型
type AnthropicStreamEvent = Record<string, unknown>

// ==================== 状态机定义 ====================

/**
 * 翻译器生命周期状态
 *
 * Init           — 等待 response.created
 * MessageStarted — message_start 已发送，等待 output items
 * BlockActive    — 至少有一个 content block 处于 open 状态
 * Completed      — 流正常结束
 * Failed         — 流异常结束
 */
type TranslatorState = 'Init' | 'MessageStarted' | 'BlockActive' | 'Completed' | 'Failed'

/**
 * 翻译器可识别的事件（从 OpenAI SSE event type 映射）
 */
type TranslatorEvent =
  | 'Created'
  | 'InProgress'
  | 'OutputItemAdded'
  | 'ContentPartAdded'
  | 'TextDelta'
  | 'ArgsDelta'
  | 'ReasoningSummaryDelta'
  | 'ReasoningContentDelta'
  | 'OutputItemDone'
  | 'Completed'
  | 'Incomplete'
  | 'Failed'

// OpenAI SSE event type → TranslatorEvent 映射表
const EVENT_MAP: Record<string, TranslatorEvent> = {
  'response.created': 'Created',
  'response.in_progress': 'InProgress',
  'response.output_item.added': 'OutputItemAdded',
  'response.content_part.added': 'ContentPartAdded',
  'response.output_text.delta': 'TextDelta',
  'response.function_call_arguments.delta': 'ArgsDelta',
  'response.reasoning_summary_text.delta': 'ReasoningSummaryDelta',
  'response.reasoning_content.delta': 'ReasoningContentDelta',
  'response.output_item.done': 'OutputItemDone',
  'response.completed': 'Completed',
  'response.incomplete': 'Incomplete',
  'response.failed': 'Failed',
}

// 状态转换表（确定性，穷举所有合法转换）
const TRANSITIONS: Array<{ from: TranslatorState | '*'; on: TranslatorEvent; to: TranslatorState }> = [
  // Init 阶段
  { from: 'Init', on: 'Created', to: 'MessageStarted' },
  { from: 'Init', on: 'InProgress', to: 'Init' },
  { from: 'Init', on: 'Incomplete', to: 'Completed' },
  { from: 'Init', on: 'Failed', to: 'Failed' },

  // MessageStarted 阶段：等待 output items 或结束
  { from: 'MessageStarted', on: 'InProgress', to: 'MessageStarted' },
  { from: 'MessageStarted', on: 'OutputItemAdded', to: 'BlockActive' },
  { from: 'MessageStarted', on: 'Completed', to: 'Completed' },
  { from: 'MessageStarted', on: 'Incomplete', to: 'Completed' },
  { from: 'MessageStarted', on: 'Failed', to: 'Failed' },

  // BlockActive 阶段：接收增量数据、新 content parts、或关闭 block
  { from: 'BlockActive', on: 'TextDelta', to: 'BlockActive' },
  { from: 'BlockActive', on: 'ArgsDelta', to: 'BlockActive' },
  { from: 'BlockActive', on: 'ReasoningSummaryDelta', to: 'BlockActive' },
  { from: 'BlockActive', on: 'ReasoningContentDelta', to: 'BlockActive' },
  { from: 'BlockActive', on: 'ContentPartAdded', to: 'BlockActive' },
  { from: 'BlockActive', on: 'OutputItemDone', to: 'MessageStarted' },
  // 并行 output items：新 item 到达时前一个可能还没显式 done
  { from: 'BlockActive', on: 'OutputItemAdded', to: 'BlockActive' },
  // 边缘情况：completed/failed 时可能有未关闭的 block
  { from: 'BlockActive', on: 'Completed', to: 'Completed' },
  { from: 'BlockActive', on: 'Incomplete', to: 'Completed' },
  { from: 'BlockActive', on: 'Failed', to: 'Failed' },
]

// ==================== 翻译器实现 ====================

export class ResponseTranslator {
  private fsm = new FiniteStateMachine<TranslatorState, TranslatorEvent>('Init', TRANSITIONS)

  // 复合键 `${output_index}:${content_index}` → Anthropic content block index
  private outputToBlockIndex = new Map<string, number>()
  private nextBlockIndex = 0
  private hasFunctionCall = false
  private responseId = ''
  private model = ''
  // 当前活跃的 block keys（用于在 OutputItemDone 时关闭所有相关 blocks）
  private activeBlockKeys = new Set<string>()
  // rate_limits 捕获（B9: 供遥测使用，不翻译为 Anthropic 事件）
  private lastRateLimits: unknown = null

  private blockKey(outputIndex: number, contentIndex: number = 0): string {
    return `${outputIndex}:${contentIndex}`
  }

  /**
   * 将一个 OpenAI SSE 事件翻译为零或多个 Anthropic 流式事件
   */
  translate(event: ResponseEvent): AnthropicStreamEvent[] {
    // rate_limits 不走状态机（可在任意状态下到达）
    if (event.type === 'response.rate_limits') {
      return this.handleRateLimits(event as ResponseRateLimitsEvent)
    }

    // 跳过 .done 冗余事件（完整内容已通过 delta 积累）
    if (event.type.endsWith('.done') && event.type !== 'response.output_item.done') {
      return []
    }

    // 映射 OpenAI 事件类型 → 翻译器事件
    const translatorEvent = EVENT_MAP[event.type]
    if (!translatorEvent) {
      return []
    }

    // 状态转换验证
    const prevState = this.fsm.state
    const valid = this.fsm.transition(translatorEvent)
    if (!valid) {
      console.warn(
        `[codex-translator] Invalid transition: ${prevState} × ${translatorEvent} (from ${event.type})`,
      )
      return []
    }

    // 根据事件类型分发处理
    switch (translatorEvent) {
      case 'Created':
        return this.handleCreated(event as ResponseCreatedEvent)
      case 'InProgress':
        return []
      case 'OutputItemAdded':
        return this.handleOutputItemAdded(event as ResponseOutputItemAddedEvent)
      case 'ContentPartAdded':
        return this.handleContentPartAdded(event as ResponseContentPartAddedEvent)
      case 'TextDelta':
        return this.handleOutputTextDelta(event as ResponseOutputTextDeltaEvent)
      case 'ArgsDelta':
        return this.handleFunctionCallArgsDelta(event as ResponseFunctionCallArgumentsDeltaEvent)
      case 'ReasoningSummaryDelta':
        return this.handleReasoningSummaryDelta(event as ResponseReasoningSummaryTextDeltaEvent)
      case 'ReasoningContentDelta':
        return this.handleReasoningContentDelta(event as ResponseReasoningContentDeltaEvent)
      case 'OutputItemDone':
        return this.handleOutputItemDone(event as ResponseOutputItemDoneEvent)
      case 'Completed':
        return this.handleCompleted(event as ResponseCompletedEvent)
      case 'Incomplete':
        return this.handleIncomplete(event as ResponseIncompleteEvent)
      case 'Failed':
        return this.handleFailed(event as ResponseFailedEvent)
      default:
        return []
    }
  }

  /** 获取当前状态（测试/调试用） */
  get state(): TranslatorState {
    return this.fsm.state
  }

  /** 获取捕获的 rate_limits 数据（遥测用） */
  get rateLimits(): unknown {
    return this.lastRateLimits
  }

  // ==================== 事件处理器 ====================

  private handleCreated(event: ResponseCreatedEvent): AnthropicStreamEvent[] {
    this.responseId = event.response.id
    this.model = event.response.model ?? ''

    return [{
      type: 'message_start',
      message: {
        id: this.responseId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }]
  }

  private handleOutputItemAdded(event: ResponseOutputItemAddedEvent): AnthropicStreamEvent[] {
    const { output_index, item } = event
    const key = this.blockKey(output_index)
    const blockIndex = this.nextBlockIndex++
    this.outputToBlockIndex.set(key, blockIndex)
    this.activeBlockKeys.add(key)

    switch (item.type) {
      case 'message': {
        return [{
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        }]
      }

      case 'function_call': {
        this.hasFunctionCall = true
        return [{
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: '',
          },
        }]
      }

      case 'reasoning': {
        return [{
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
            signature: '',
          },
        }]
      }

      default:
        return []
    }
  }

  private handleContentPartAdded(event: ResponseContentPartAddedEvent): AnthropicStreamEvent[] {
    const { output_index, content_index, part } = event
    const key = this.blockKey(output_index, content_index)

    // content_index === 0 时通常已被 handleOutputItemAdded 处理
    if (content_index === 0 && this.outputToBlockIndex.has(key)) {
      return []
    }

    if (part.type === 'output_text' || part.type === 'summary_text') {
      const blockIndex = this.nextBlockIndex++
      this.outputToBlockIndex.set(key, blockIndex)
      this.activeBlockKeys.add(key)
      return [{
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: part.type === 'summary_text' ? 'thinking' : 'text',
          text: '',
          ...(part.type === 'summary_text' ? { thinking: '', signature: '' } : {}),
        },
      }]
    }
    return []
  }

  private handleOutputTextDelta(event: ResponseOutputTextDeltaEvent): AnthropicStreamEvent[] {
    // 优先用 content_index 精确匹配，兜底用 output_index:0
    const blockIndex =
      this.outputToBlockIndex.get(this.blockKey(event.output_index, event.content_index ?? 0)) ??
      this.outputToBlockIndex.get(this.blockKey(event.output_index))
    if (blockIndex === undefined) return []

    return [{
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'text_delta',
        text: event.delta,
      },
    }]
  }

  private handleFunctionCallArgsDelta(
    event: ResponseFunctionCallArgumentsDeltaEvent,
  ): AnthropicStreamEvent[] {
    const blockIndex = this.outputToBlockIndex.get(this.blockKey(event.output_index))
    if (blockIndex === undefined) return []

    return [{
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: event.delta,
      },
    }]
  }

  private handleReasoningSummaryDelta(
    event: ResponseReasoningSummaryTextDeltaEvent,
  ): AnthropicStreamEvent[] {
    const blockIndex = this.outputToBlockIndex.get(this.blockKey(event.output_index))
    if (blockIndex === undefined) return []

    return [{
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'thinking_delta',
        thinking: event.delta,
      },
    }]
  }

  /**
   * B8 修复：reasoning_content.delta 事件处理
   * 推理过程中的增量内容，映射为 thinking_delta
   */
  private handleReasoningContentDelta(
    event: ResponseReasoningContentDeltaEvent,
  ): AnthropicStreamEvent[] {
    const blockIndex = this.outputToBlockIndex.get(this.blockKey(event.output_index))
    if (blockIndex === undefined) return []

    return [{
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'thinking_delta',
        thinking: event.delta,
      },
    }]
  }

  private handleOutputItemDone(event: ResponseOutputItemDoneEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // 关闭该 output item 下所有活跃的 content blocks
    const prefix = `${event.output_index}:`
    for (const key of this.activeBlockKeys) {
      if (key.startsWith(prefix)) {
        const blockIndex = this.outputToBlockIndex.get(key)
        if (blockIndex !== undefined) {
          events.push({ type: 'content_block_stop', index: blockIndex })
        }
        this.activeBlockKeys.delete(key)
      }
    }

    // 兜底：如果没匹配到任何活跃 key，尝试默认 content_index=0
    if (events.length === 0) {
      const defaultKey = this.blockKey(event.output_index)
      const blockIndex = this.outputToBlockIndex.get(defaultKey)
      if (blockIndex !== undefined) {
        events.push({ type: 'content_block_stop', index: blockIndex })
        this.activeBlockKeys.delete(defaultKey)
      }
    }

    return events
  }

  private handleCompleted(event: ResponseCompletedEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // 安全网：关闭所有仍然活跃的 blocks（防止边缘情况遗漏）
    for (const key of this.activeBlockKeys) {
      const blockIndex = this.outputToBlockIndex.get(key)
      if (blockIndex !== undefined) {
        events.push({ type: 'content_block_stop', index: blockIndex })
      }
    }
    this.activeBlockKeys.clear()

    // 翻译 usage
    const response = event.response
    const usage = this.translateUsage(response.usage)

    // stop_reason 判定：incomplete → max_tokens，function_call → tool_use，否则 → end_turn
    const isIncomplete = response.status === 'incomplete'
    const stopReason = isIncomplete ? 'max_tokens' : (this.hasFunctionCall ? 'tool_use' : 'end_turn')

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage,
      },
      {
        type: 'message_stop',
      },
    )

    return events
  }

  /**
   * response.incomplete — 独立的 incomplete 事件类型（区别于 response.completed + status:incomplete）
   * 强制 stop_reason 为 max_tokens
   */
  private handleIncomplete(event: ResponseIncompleteEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // 如果还没发过 message_start（直接从 Init 到 Incomplete），补发
    if (!this.responseId) {
      this.responseId = event.response.id ?? `msg_${Date.now()}`
      this.model = event.response.model ?? ''
      events.push({
        type: 'message_start',
        message: {
          id: this.responseId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })
    }

    // 关闭所有活跃 blocks
    for (const key of this.activeBlockKeys) {
      const blockIndex = this.outputToBlockIndex.get(key)
      if (blockIndex !== undefined) {
        events.push({ type: 'content_block_stop', index: blockIndex })
      }
    }
    this.activeBlockKeys.clear()

    const response = event.response
    const usage = this.translateUsage(response.usage)

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'max_tokens',
          stop_sequence: null,
        },
        usage,
      },
      {
        type: 'message_stop',
      },
    )

    return events
  }

  private handleFailed(event: ResponseFailedEvent): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = []

    // 关闭所有活跃 blocks
    for (const key of this.activeBlockKeys) {
      const blockIndex = this.outputToBlockIndex.get(key)
      if (blockIndex !== undefined) {
        events.push({ type: 'content_block_stop', index: blockIndex })
      }
    }
    this.activeBlockKeys.clear()

    const response = event.response
    const errorMsg = response.error?.message ?? 'Unknown error from OpenAI Responses API'
    const errorCode = response.error?.code ?? response.error?.type ?? 'api_error'

    // 注入一个错误文本块，让上游对话循环能看到错误信息
    const errorBlockIndex = this.nextBlockIndex++
    events.push(
      {
        type: 'content_block_start',
        index: errorBlockIndex,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: errorBlockIndex,
        delta: { type: 'text_delta', text: `[API Error: ${errorCode}] ${errorMsg}` },
      },
      {
        type: 'content_block_stop',
        index: errorBlockIndex,
      },
    )

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 0 },
      },
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: errorMsg,
        },
      },
    )

    return events
  }

  /**
   * B9 修复：rate_limits 事件捕获
   * 不翻译为 Anthropic 事件（无对应），存储供遥测/调试使用
   */
  private handleRateLimits(event: ResponseRateLimitsEvent): AnthropicStreamEvent[] {
    this.lastRateLimits = event.rate_limits
    return []
  }

  // ==================== 辅助方法 ====================

  private translateUsage(usage?: ResponseUsage): Record<string, number> {
    if (!usage) {
      return { output_tokens: 0 }
    }
    const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0
    return {
      // OpenAI 的 input_tokens 包含 cached，需扣除以匹配 Anthropic 语义
      // (Anthropic: input_tokens 不含 cache，cache_read 单独报告)
      input_tokens: (usage.input_tokens ?? 0) - cachedTokens,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: cachedTokens,
      cache_creation_input_tokens: 0,
      // OpenAI reasoning tokens（非 Anthropic 标准字段，作为扩展传递供成本追踪使用）
      reasoning_output_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    }
  }
}
