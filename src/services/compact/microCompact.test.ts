import { describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import {
  microcompactMessages,
  TIME_BASED_MC_CLEARED_MESSAGE,
} from './microCompact.js'

function createAssistantToolUseMessage(params: {
  id: string
  name: string
  timestamp: string
}): Message {
  return {
    type: 'assistant',
    uuid: `assistant-${params.id}`,
    timestamp: params.timestamp,
    message: {
      id: `assistant-message-${params.id}`,
      model: 'test-model',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        {
          type: 'tool_use',
          id: params.id,
          name: params.name,
          input: {},
        },
      ],
    },
  } as unknown as Message
}

function createUserToolResultMessage(params: {
  toolUseId: string
  content: string
  timestamp: string
}): Message {
  return {
    type: 'user',
    uuid: `user-${params.toolUseId}`,
    timestamp: params.timestamp,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: params.toolUseId,
          content: params.content,
        },
      ],
    },
  } as unknown as Message
}

describe('time-based microcompact', () => {
  test('replaces cleared tool results with structured summaries when available', async () => {
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const messages = [
      createAssistantToolUseMessage({
        id: 'tool-read-1',
        name: 'Read',
        timestamp: oldTimestamp,
      }),
      createUserToolResultMessage({
        toolUseId: 'tool-read-1',
        content: 'Read src/query.ts and identified stale token estimation comments.',
        timestamp: oldTimestamp,
      }),
      createAssistantToolUseMessage({
        id: 'tool-grep-1',
        name: 'Grep',
        timestamp: oldTimestamp,
      }),
      createUserToolResultMessage({
        toolUseId: 'tool-grep-1',
        content: 'Matched autoCompact thresholds in src/services/compact/autoCompact.ts.',
        timestamp: oldTimestamp,
      }),
    ]

    const result = await microcompactMessages(
      messages,
      {} as ToolUseContext,
      'repl_main_thread',
      {
        timeBasedConfig: {
          enabled: true,
          gapThresholdMinutes: 1,
          keepRecent: 1,
        },
        summarizeToolResults: async ({ candidates }) =>
          new Map(
            candidates.map(candidate => [
              candidate.toolUseId,
              `[Tool result summarized] ${candidate.toolName}: preserved ${candidate.toolUseId}`,
            ]),
          ),
      },
    )

    const firstToolResult = (result.messages[1] as Message)
      .message!.content as Array<{ type: string; content?: unknown }>
    const secondToolResult = (result.messages[3] as Message)
      .message!.content as Array<{ type: string; content?: unknown }>

    expect(firstToolResult[0]?.content).toBe(
      '[Tool result summarized] Read: preserved tool-read-1',
    )
    expect(secondToolResult[0]?.content).toBe(
      'Matched autoCompact thresholds in src/services/compact/autoCompact.ts.',
    )
  })

  test('falls back to the legacy cleared marker when no summary is produced', async () => {
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const messages = [
      createAssistantToolUseMessage({
        id: 'tool-read-2',
        name: 'Read',
        timestamp: oldTimestamp,
      }),
      createUserToolResultMessage({
        toolUseId: 'tool-read-2',
        content: 'Read src/services/compact/microCompact.ts and traced cached MC state.',
        timestamp: oldTimestamp,
      }),
      createAssistantToolUseMessage({
        id: 'tool-grep-2',
        name: 'Grep',
        timestamp: oldTimestamp,
      }),
      createUserToolResultMessage({
        toolUseId: 'tool-grep-2',
        content: 'Searched for evaluateTimeBasedTrigger call sites.',
        timestamp: oldTimestamp,
      }),
    ]

    const result = await microcompactMessages(
      messages,
      {} as ToolUseContext,
      'repl_main_thread',
      {
        timeBasedConfig: {
          enabled: true,
          gapThresholdMinutes: 1,
          keepRecent: 1,
        },
        summarizeToolResults: async () => new Map(),
      },
    )

    const firstToolResult = (result.messages[1] as Message)
      .message!.content as Array<{ type: string; content?: unknown }>

    expect(firstToolResult[0]?.content).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
  })
})
