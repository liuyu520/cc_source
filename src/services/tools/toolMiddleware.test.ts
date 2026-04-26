import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  buildTool,
  type ToolDef,
  type ToolUseContext,
} from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  createCachingMiddleware,
  createConcurrencyMiddleware,
  executeToolMiddlewareChain,
  ToolExecutionResultCache,
  ToolExecutionSemaphore,
} from './toolMiddleware.js'

const testInputSchema = z.strictObject({
  file_path: z.string().optional(),
  pattern: z.string().optional(),
})

function createToolUseContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' } as never,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({}) as never,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function createAssistantMessage(): AssistantMessage {
  return {
    uuid: 'assistant-uuid',
    message: {
      id: 'assistant-message-id',
      content: [],
    },
  } as unknown as AssistantMessage
}

function createTestTool({
  name,
  isReadOnly,
  call,
}: {
  name: string
  isReadOnly: boolean
  call: (input: Record<string, unknown>) => Promise<{ data: unknown }>
}) {
  return buildTool({
    name,
    maxResultSizeChars: 10_000,
    async call(input) {
      return call(input)
    },
    async description() {
      return name
    },
    get inputSchema() {
      return testInputSchema
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return isReadOnly
    },
    async prompt() {
      return name
    },
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content:
          typeof output === 'string' ? output : JSON.stringify(output ?? null),
      }
    },
    renderToolUseMessage() {
      return null
    },
  } satisfies ToolDef) as ReturnType<typeof buildTool>
}

describe('tool middleware pipeline', () => {
  test('caches exact Read/Glob executions and clears cache after writes', async () => {
    const cache = new ToolExecutionResultCache(10)
    const middlewares = [
      createCachingMiddleware({
        cache,
        now: (() => {
          let tick = 1_000
          return () => tick++
        })(),
        ttlMs: 50,
      }),
    ]

    let readCalls = 0
    const readTool = createTestTool({
      name: 'Read',
      isReadOnly: true,
      async call() {
        readCalls += 1
        return {
          data: {
            call: readCalls,
          },
        }
      },
    })

    const toolUseContext = createToolUseContext()
    const assistantMessage = createAssistantMessage()

    const first = await executeToolMiddlewareChain(
      {
        assistantMessage,
        canUseTool: async () => ({ behavior: 'allow' } as never),
        callInput: { file_path: './src/foo.ts' },
        observableInput: { file_path: '/abs/src/foo.ts' },
        tool: readTool,
        toolUseContext,
        toolUseID: 'tool-read-1',
      },
      middlewares,
    )
    const second = await executeToolMiddlewareChain(
      {
        assistantMessage,
        canUseTool: async () => ({ behavior: 'allow' } as never),
        callInput: { file_path: './src/foo.ts' },
        observableInput: { file_path: '/abs/src/foo.ts' },
        tool: readTool,
        toolUseContext,
        toolUseID: 'tool-read-2',
      },
      middlewares,
    )

    expect(first.state.cacheHit).toBe(false)
    expect(second.state.cacheHit).toBe(true)
    expect(readCalls).toBe(1)

    const writeTool = createTestTool({
      name: 'Write',
      isReadOnly: false,
      async call() {
        return {
          data: { ok: true },
        }
      },
    })

    await executeToolMiddlewareChain(
      {
        assistantMessage,
        canUseTool: async () => ({ behavior: 'allow' } as never),
        callInput: { file_path: './src/foo.ts' },
        observableInput: { file_path: '/abs/src/foo.ts' },
        tool: writeTool,
        toolUseContext,
        toolUseID: 'tool-write-1',
      },
      middlewares,
    )

    const third = await executeToolMiddlewareChain(
      {
        assistantMessage,
        canUseTool: async () => ({ behavior: 'allow' } as never),
        callInput: { file_path: './src/foo.ts' },
        observableInput: { file_path: '/abs/src/foo.ts' },
        tool: readTool,
        toolUseContext,
        toolUseID: 'tool-read-3',
      },
      middlewares,
    )

    expect(third.state.cacheHit).toBe(false)
    expect(readCalls).toBe(2)
  })

  test('enforces shared middleware concurrency slots', async () => {
    const semaphore = new ToolExecutionSemaphore(1)
    const middlewares = [
      createConcurrencyMiddleware({
        getSemaphore: () => semaphore,
      }),
    ]

    let activeCalls = 0
    let maxActiveCalls = 0
    const globTool = createTestTool({
      name: 'Glob',
      isReadOnly: true,
      async call(input) {
        activeCalls += 1
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
        await new Promise(resolve => setTimeout(resolve, 30))
        activeCalls -= 1
        return {
          data: {
            pattern: input.pattern,
          },
        }
      },
    })

    const toolUseContext = createToolUseContext()
    const assistantMessage = createAssistantMessage()

    const [first, second] = await Promise.all([
      executeToolMiddlewareChain(
        {
          assistantMessage,
          canUseTool: async () => ({ behavior: 'allow' } as never),
          callInput: { pattern: '*.ts' },
          observableInput: { pattern: '*.ts' },
          tool: globTool,
          toolUseContext,
          toolUseID: 'tool-glob-1',
        },
        middlewares,
      ),
      executeToolMiddlewareChain(
        {
          assistantMessage,
          canUseTool: async () => ({ behavior: 'allow' } as never),
          callInput: { pattern: '*.tsx' },
          observableInput: { pattern: '*.tsx' },
          tool: globTool,
          toolUseContext,
          toolUseID: 'tool-glob-2',
        },
        middlewares,
      ),
    ])

    expect(maxActiveCalls).toBe(1)
    expect(
      Math.max(first.state.concurrencyWaitMs, second.state.concurrencyWaitMs),
    ).toBeGreaterThan(0)
  })
})
