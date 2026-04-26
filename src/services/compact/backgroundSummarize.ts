/**
 * 后台渐进摘要 — 在两次 compact 之间持续"减压"上下文
 *
 * 设计原则：
 * - 不阻塞主循环：后台异步执行，不 await
 * - 滞后摘要：只处理 currentTurn - LAG 之前的旧 tool-pair，避免摘要还在使用的上下文
 * - 幂等：已摘要的 tool-pair 不重复处理（通过标记检测）
 * - 与 microCompact 互补：microCompact 是截断（信息丢失），这里是压缩（信息保留）
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  summarizeToolResultsForMicrocompact,
  buildFallbackToolResultSummary,
  type ToolResultSummaryCandidate,
} from './toolResultSummary.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { TIME_BASED_MC_CLEARED_MESSAGE } from './microCompact.js'

// 滞后轮次：只摘要 currentTurn - LAG 之前的 tool-pair
const SUMMARIZE_LAG = 3
// 已摘要标记前缀（与 microCompact 的 TIME_BASED_MC_CLEARED_MESSAGE 区分）
const BG_SUMMARIZED_PREFIX = '[Tool result summarized]'
// 单次后台摘要最大候选数（避免后台任务过重）
const MAX_BG_CANDIDATES = 8
// tool_result 内容长度阈值：短结果不值得摘要
const MIN_CONTENT_LENGTH = 1200
// 防并发锁
let bgSummarizeRunning = false

/**
 * 判断 tool_result 内容是否已经被压缩/清除过
 * 已被 microCompact 清除或已被后台摘要处理的不再重复处理
 */
function isAlreadyProcessed(content: ToolResultBlockParam['content']): boolean {
  if (typeof content === 'string') {
    return (
      content === TIME_BASED_MC_CLEARED_MESSAGE ||
      content.startsWith(BG_SUMMARIZED_PREFIX)
    )
  }
  // ContentBlock[] 形式：检查第一个 text block 是否已被标记
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0]
    if (block && 'type' in block && block.type === 'text' && 'text' in block) {
      const text = block.text as string
      return (
        text === TIME_BASED_MC_CLEARED_MESSAGE ||
        text.startsWith(BG_SUMMARIZED_PREFIX)
      )
    }
  }
  return false
}

/**
 * 获取 tool_result 内容的文本长度
 */
function getContentLength(content: ToolResultBlockParam['content']): number {
  if (typeof content === 'string') {
    return content.length
  }
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) {
      if (block && 'type' in block && block.type === 'text' && 'text' in block) {
        total += (block.text as string).length
      } else {
        // image/document 等非文本块给一个估算值
        total += 500
      }
    }
    return total
  }
  return 0
}

/**
 * 从消息列表中收集可后台摘要的旧 tool-pair 候选
 * 条件：
 * 1. 消息在 cutoffTurn 之前（基于消息索引估算轮次）
 * 2. 是 user 消息中的 tool_result block
 * 3. 内容未被 microCompact 清除，也未被后台摘要过
 * 4. 内容长度 > 阈值（短结果不值得摘要）
 */
function collectBgCandidates(
  messages: Message[],
  cutoffTurn: number,
): ToolResultSummaryCandidate[] {
  const candidates: ToolResultSummaryCandidate[] = []

  // 通过统计 assistant 消息数来估算轮次：每个 assistant 回复算一个 turn
  let turnsSeen = 0

  for (const msg of messages) {
    // 遇到 assistant 消息时增加轮次计数
    if (msg.type === 'assistant') {
      turnsSeen++
      continue
    }

    // 只在 cutoffTurn 之前的消息中查找候选
    if (turnsSeen >= cutoffTurn) {
      break
    }

    // 只处理 user 类型消息中的 tool_result block
    if (msg.type !== 'user') {
      continue
    }

    const content = msg.message?.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const block of content) {
      if (!block || block.type !== 'tool_result') {
        continue
      }

      const toolResultBlock = block as ToolResultBlockParam
      const resultContent = toolResultBlock.content
      if (!resultContent) {
        continue
      }

      // 跳过已被处理的内容
      if (isAlreadyProcessed(resultContent)) {
        continue
      }

      // 跳过内容过短的结果（不值得摘要）
      if (getContentLength(resultContent) < MIN_CONTENT_LENGTH) {
        continue
      }

      candidates.push({
        toolUseId: toolResultBlock.tool_use_id,
        toolName: (block as { tool_name?: string }).tool_name ?? 'unknown',
        content: resultContent,
      })

      // 限制单次候选数量
      if (candidates.length >= MAX_BG_CANDIDATES) {
        return candidates
      }
    }
  }

  return candidates
}

/**
 * 将摘要结果写回消息列表（原地替换 tool_result 内容）
 * 注意：直接修改 messages 数组中的对象，因为这是后台操作，
 * 主循环在下一轮 API 调用时会看到更新后的消息
 *
 * @returns 成功替换的 tool_result 数量
 */
function applyBgSummaries(
  messages: Message[],
  summaries: Map<string, string>,
): number {
  let appliedCount = 0

  for (const msg of messages) {
    if (msg.type !== 'user') {
      continue
    }
    const content = msg.message?.content
    if (!Array.isArray(content)) {
      continue
    }

    for (const block of content) {
      if (!block || block.type !== 'tool_result') {
        continue
      }
      const toolResultBlock = block as ToolResultBlockParam
      const summary = summaries.get(toolResultBlock.tool_use_id)
      if (!summary) {
        continue
      }

      // 原地替换 tool_result 的 content 为摘要文本
      toolResultBlock.content = summary
      appliedCount++
    }
  }

  return appliedCount
}

/**
 * 后台执行摘要的核心逻辑
 * 调用已有的 summarizeToolResultsForMicrocompact 生成摘要，然后写回消息
 */
async function doBackgroundSummarize(
  messages: Message[],
  candidates: ToolResultSummaryCandidate[],
  toolUseContext: ToolUseContext,
): Promise<void> {
  const startTime = Date.now()

  logForDebugging(
    `[BG_SUMMARIZE] starting background summarize for ${candidates.length} candidates`,
  )

  try {
    // 调用已有的 summarizeToolResultsForMicrocompact 生成摘要
    const summaries = await summarizeToolResultsForMicrocompact({
      candidates,
      toolUseContext,
      messages,
    })

    if (summaries.size === 0) {
      logForDebugging('[BG_SUMMARIZE] no summaries generated, skipping apply')
      return
    }

    // 将摘要结果写回消息列表
    const appliedCount = applyBgSummaries(messages, summaries)

    const elapsed = Date.now() - startTime
    logForDebugging(
      `[BG_SUMMARIZE] applied ${appliedCount}/${summaries.size} summaries in ${elapsed}ms`,
    )
  } catch (error) {
    // LLM 摘要失败时降级为本地摘要
    logForDebugging(
      `[BG_SUMMARIZE] LLM summarize failed, falling back to local: ${(error as Error).message}`,
    )

    const fallbackSummaries = new Map<string, string>()
    for (const candidate of candidates) {
      fallbackSummaries.set(
        candidate.toolUseId,
        buildFallbackToolResultSummary(candidate),
      )
    }

    const appliedCount = applyBgSummaries(messages, fallbackSummaries)
    logForDebugging(
      `[BG_SUMMARIZE] applied ${appliedCount} fallback summaries`,
    )
  }
}

/**
 * 后台渐进摘要入口 — 不 await 调用
 * 在 query.ts 主循环中 tool 执行完后调用
 *
 * @param messages - 当前消息列表（会被原地修改）
 * @param currentTurn - 当前轮次（从 state.turnCount 获取）
 * @param toolUseContext - 工具使用上下文
 */
export function triggerBackgroundSummarize(
  messages: Message[],
  currentTurn: number,
  toolUseContext: ToolUseContext,
): void {
  // 防并发：如果上一次后台摘要还在运行，跳过本次
  if (bgSummarizeRunning) {
    return
  }

  // 只处理 currentTurn - LAG 之前的旧 tool-pair
  const cutoffTurn = currentTurn - SUMMARIZE_LAG
  if (cutoffTurn <= 0) {
    return
  }

  // 收集候选
  const candidates = collectBgCandidates(messages, cutoffTurn)
  if (candidates.length === 0) {
    return
  }

  // 检查 abort 信号：如果已中止则不启动后台任务
  if (toolUseContext.abortController.signal.aborted) {
    return
  }

  bgSummarizeRunning = true
  // 不 await — 后台运行，不阻塞主循环
  doBackgroundSummarize(messages, candidates, toolUseContext)
    .catch(err => logError(err))
    .finally(() => {
      bgSummarizeRunning = false
    })
}

/**
 * 重置后台摘要状态（测试用）
 */
export function resetBackgroundSummarizeState(): void {
  bgSummarizeRunning = false
}
