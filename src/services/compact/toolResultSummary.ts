import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { runForkedAgent } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import {
  createUserMessage,
  getAssistantMessageText,
  getUserMessageText,
} from '../../utils/messages.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

export type ToolResultSummaryCandidate = {
  toolUseId: string
  toolName: string
  content: NonNullable<ToolResultBlockParam['content']>
}

type ToolResultSummaryRecord = {
  toolUseId?: string
  summary?: string
  artifacts?: string[]
  signals?: string[]
}

const TOOL_RESULT_SUMMARY_SYSTEM_PROMPT = `You compress verbose tool results into durable short memory records for later context reuse.

Return JSON only. Do not wrap the JSON in markdown or add commentary.

Schema:
[
  {
    "toolUseId": "exact id from input",
    "summary": "1 short sentence describing the durable takeaway",
    "artifacts": ["important file path, URL, command, identifier"],
    "signals": ["error, warning, next-step clue, or key fact"]
  }
]

Rules:
- Never invent facts that are not present in the input.
- Favor concrete engineering facts: file paths, errors, decisions, counts, config names, commands.
- Keep each summary concise and high-signal.
- If a result has no durable facts, summarize it as a plain completion outcome.
- Keep artifacts/signals arrays short (0-3 items each).`

const MAX_ITEMS_PER_BATCH = 4
const MAX_OUTPUT_TOKENS = 2_048
const HEAD_PREVIEW_CHARS = 2_400
const TAIL_PREVIEW_CHARS = 700
const MAX_SUMMARY_LENGTH = 320

const ERROR_LINE_RE = /\b(error|exception|failed|enoent|eacces|timeout)\b/i
const PATH_RE =
  /(?:[A-Za-z]:\\|\/|\.{1,2}\/)?(?:[\w.-]+[\\/])+[\w.-]+\.\w+/g

function denyToolUse(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during tool result summarization',
    decisionReason: {
      type: 'other' as const,
      reason: 'tool result summarizer should only produce text output',
    },
  })
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, maxLength: number): string {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function stringifyContent(
  content: NonNullable<ToolResultBlockParam['content']>,
): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .map(block => {
      switch (block.type) {
        case 'text':
          return block.text
        case 'image':
          return '[image output]'
        case 'document':
          return '[document output]'
        default:
          return jsonStringify(block)
      }
    })
    .join('\n')
}

function buildPreview(
  content: NonNullable<ToolResultBlockParam['content']>,
): string {
  const text = stringifyContent(content)
  if (text.length <= HEAD_PREVIEW_CHARS + TAIL_PREVIEW_CHARS + 40) {
    return text
  }
  return `${text.slice(0, HEAD_PREVIEW_CHARS)}\n...\n${text.slice(
    -TAIL_PREVIEW_CHARS,
  )}`
}

function extractTaskHint(messages: ReadonlyArray<Message>): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'user' || message.isMeta) {
      continue
    }
    const text = getUserMessageText(message)
    if (text && text.trim()) {
      return clip(text, 240)
    }
  }
  return null
}

function buildPrompt(
  batch: readonly ToolResultSummaryCandidate[],
  taskHint: string | null,
): string {
  const header = taskHint ? `Current task hint: ${taskHint}\n\n` : ''
  const body = batch
    .map(
      candidate => `toolUseId: ${candidate.toolUseId}
tool: ${candidate.toolName}
result:
${buildPreview(candidate.content)}`,
    )
    .join('\n\n---\n\n')

  return `${header}Summarize each tool result for context compaction.\nReturn one JSON object per input item.\n\n${body}`
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}

function parseToolResultSummaryResponse(
  text: string,
): ToolResultSummaryRecord[] | null {
  const jsonPayload = extractJsonArray(text)
  if (!jsonPayload) {
    return null
  }

  try {
    const parsed = JSON.parse(jsonPayload)
    return Array.isArray(parsed) ? (parsed as ToolResultSummaryRecord[]) : null
  } catch {
    return null
  }
}

function extractArtifacts(text: string): string[] {
  const matches = text.match(PATH_RE) ?? []
  return [...new Set(matches.map(match => clip(match, 120)))].slice(0, 3)
}

function extractSignals(text: string): string[] {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.filter(line => ERROR_LINE_RE.test(line)).slice(0, 3)
}

function formatSummaryRecord(
  candidate: ToolResultSummaryCandidate,
  summary: {
    summary: string
    artifacts?: string[]
    signals?: string[]
  },
): string {
  const parts = [
    `[Tool result summarized] ${candidate.toolName}: ${clip(summary.summary, 150)}`,
  ]
  if (summary.artifacts && summary.artifacts.length > 0) {
    parts.push(`Artifacts: ${summary.artifacts.map(item => clip(item, 120)).join(', ')}`)
  }
  if (summary.signals && summary.signals.length > 0) {
    parts.push(`Signals: ${summary.signals.map(item => clip(item, 120)).join('; ')}`)
  }
  return clip(parts.join('. '), MAX_SUMMARY_LENGTH)
}

export function buildFallbackToolResultSummary(
  candidate: ToolResultSummaryCandidate,
): string {
  const text = stringifyContent(candidate.content)
  const normalized = normalizeWhitespace(text)
  const artifacts = extractArtifacts(text)
  const signals = extractSignals(text)
  const leadingLine =
    normalized
      .split(/[.!?]\s/)
      .map(line => line.trim())
      .find(Boolean) ?? 'Completed with compacted output'

  return formatSummaryRecord(candidate, {
    summary: leadingLine,
    artifacts,
    signals,
  })
}

async function summarizeBatch(
  batch: readonly ToolResultSummaryCandidate[],
  toolUseContext: ToolUseContext,
  taskHint: string | null,
): Promise<Map<string, string>> {
  const prompt = buildPrompt(batch, taskHint)
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt, isMeta: true })],
    cacheSafeParams: {
      systemPrompt: asSystemPrompt([TOOL_RESULT_SUMMARY_SYSTEM_PROMPT]),
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: [],
    },
    canUseTool: denyToolUse(),
    querySource: 'tool_result_summary',
    forkLabel: 'tool_result_summary',
    maxTurns: 1,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    skipTranscript: true,
    skipCacheWrite: true,
    overrides: {
      abortController: toolUseContext.abortController,
      options: {
        ...toolUseContext.options,
        mainLoopModel: getSmallFastModel(),
        tools: [],
        thinkingConfig: { type: 'disabled' } as ToolUseContext['options']['thinkingConfig'],
      },
    },
  })

  const assistantMessage = result.messages.findLast(
    message => message.type === 'assistant',
  )
  const assistantText = assistantMessage
    ? getAssistantMessageText(assistantMessage)
    : null

  if (!assistantText) {
    return new Map()
  }

  const parsed = parseToolResultSummaryResponse(assistantText)
  if (!parsed) {
    logForDebugging(
      `[SMART MICROCOMPACT] failed to parse tool result summary response: ${assistantText.slice(0, 200)}`,
      { level: 'warn' },
    )
    return new Map()
  }

  const byId = new Map<string, string>()
  for (const candidate of batch) {
    const record = parsed.find(item => item.toolUseId === candidate.toolUseId)
    if (!record?.summary) {
      continue
    }
    byId.set(
      candidate.toolUseId,
      formatSummaryRecord(candidate, {
        summary: record.summary,
        artifacts: record.artifacts,
        signals: record.signals,
      }),
    )
  }
  return byId
}

export async function summarizeToolResultsForMicrocompact(params: {
  candidates: readonly ToolResultSummaryCandidate[]
  toolUseContext: ToolUseContext
  messages: readonly Message[]
}): Promise<Map<string, string>> {
  const { candidates, toolUseContext, messages } = params
  const summaries = new Map<string, string>()

  if (candidates.length === 0) {
    return summaries
  }

  const taskHint = extractTaskHint(messages)

  try {
    for (let index = 0; index < candidates.length; index += MAX_ITEMS_PER_BATCH) {
      const batch = candidates.slice(index, index + MAX_ITEMS_PER_BATCH)
      const batchSummaries = await summarizeBatch(batch, toolUseContext, taskHint)
      for (const candidate of batch) {
        summaries.set(
          candidate.toolUseId,
          batchSummaries.get(candidate.toolUseId) ??
            buildFallbackToolResultSummary(candidate),
        )
      }
    }
    return summaries
  } catch (error) {
    logError(error)
    for (const candidate of candidates) {
      summaries.set(candidate.toolUseId, buildFallbackToolResultSummary(candidate))
    }
    return summaries
  }
}
