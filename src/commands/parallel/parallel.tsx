import { randomUUID } from 'crypto'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useInterval } from 'usehooks-ts'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { Markdown } from '../../components/Markdown.js'
import { SpinnerGlyph } from '../../components/Spinner/SpinnerGlyph.js'
import { DOWN_ARROW, UP_ARROW } from '../../constants/figures.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import ScrollBox, {
  type ScrollBoxHandle,
} from '../../ink/components/ScrollBox.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { formatAPIError } from '../../services/api/errorUtils.js'
import { renderToolUseProgressMessage } from '../../tools/AgentTool/UI.js'
import type { Progress as AgentProgress } from '../../tools/AgentTool/AgentTool.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  AssistantMessage,
  Message,
  NormalizedUserMessage,
  ProgressMessage,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  extractResultText,
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { createUserMessage, normalizeMessages } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

type ParallelTaskProps = {
  task: string
  context: LocalJSXCommandContext
  canUseTool: CanUseToolFn
  onDone: LocalJSXCommandOnDone
}

const CHROME_ROWS = 6
const OUTER_CHROME_ROWS = 7
const SCROLL_LINES = 3
const PARALLEL_TASK_MAX_TURNS = 40

function buildParallelTaskPrompt(task: string): string {
  return `<system-reminder>
You are running an isolated temporary task launched via /parallel.

Rules:
- Treat this task as fully independent from the main conversation unless the task text explicitly references it
- Do not rely on or mention prior chat history that is not included in this prompt
- Do not create, resume, rename, branch, or otherwise manage sessions
- Do not spawn subagents or delegate further; use the available tools directly
- Complete the task end-to-end, then return a concise final report with result, key files changed (if any), and verification
</system-reminder>

${task}`
}

async function buildIndependentCacheSafeParams(
  context: LocalJSXCommandContext,
): Promise<CacheSafeParams> {
  const saved = getLastCacheSafeParams()

  if (saved) {
    return {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages: [],
    }
  }

  const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      [],
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])

  return {
    systemPrompt: asSystemPrompt(rawSystemPrompt),
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages: [],
  }
}

function extractParallelTaskResponse(messages: Message[]): string | null {
  const text = extractResultText(messages, '').trim()
  if (text) return text

  const maxTurnsReached = messages.find(message => {
    if (message.type !== 'attachment') return false
    const attachment = (message as Message & {
      attachment?: { type?: string }
    }).attachment
    return attachment?.type === 'max_turns_reached'
  })

  if (maxTurnsReached) {
    return `Stopped after reaching the temporary task turn limit (${PARALLEL_TASK_MAX_TURNS}).`
  }

  const apiError = messages.find(
    (message): message is SystemAPIErrorMessage =>
      message.type === 'system' &&
      'subtype' in message &&
      message.subtype === 'api_error',
  )

  if (apiError) {
    return `(API error: ${formatAPIError(apiError.error)})`
  }

  return null
}

async function runParallelTask({
  task,
  context,
  canUseTool,
  abortController,
  onMessage,
}: {
  task: string
  context: LocalJSXCommandContext
  canUseTool: CanUseToolFn
  abortController: AbortController
  onMessage?: (message: Message) => void
}): Promise<string> {
  const cacheSafeParams = await buildIndependentCacheSafeParams(context)
  const promptMessages = [
    createUserMessage({
      content: buildParallelTaskPrompt(task),
    }),
  ]

  const result = await runForkedAgent({
    promptMessages,
    cacheSafeParams,
    canUseTool,
    querySource: 'parallel_task',
    forkLabel: 'parallel_task',
    maxTurns: PARALLEL_TASK_MAX_TURNS,
    onMessage,
    skipTranscript: true,
    overrides: {
      abortController,
      shareAbortController: true,
      shareSetAppState: true,
      messages: promptMessages,
    },
  })

  return (
    extractParallelTaskResponse(result.messages) ??
    'Task completed without a final text response.'
  )
}

function ParallelTaskRunner({
  task,
  context,
  canUseTool,
  onDone,
}: ParallelTaskProps): React.ReactNode {
  const [response, setResponse] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [progressMessages, setProgressMessages] = useState<
    ProgressMessage<AgentProgress>[]
  >([])
  const scrollRef = useRef<ScrollBoxHandle>(null)
  const toolUseCounterRef = useRef(0)
  const { rows } = useModalOrTerminalSize(useTerminalSize())

  useInterval(() => setFrame(current => current + 1), response || error ? null : 80)

  function handleKeyDown(event: KeyboardEvent): void {
    if (
      event.key === 'escape' ||
      event.key === 'return' ||
      event.key === ' ' ||
      (event.ctrl && (event.key === 'c' || event.key === 'd'))
    ) {
      event.preventDefault()
      onDone(undefined, { display: 'skip' })
      return
    }

    if (event.key === 'up' || (event.ctrl && event.key === 'p')) {
      event.preventDefault()
      scrollRef.current?.scrollBy(-SCROLL_LINES)
    }

    if (event.key === 'down' || (event.ctrl && event.key === 'n')) {
      event.preventDefault()
      scrollRef.current?.scrollBy(SCROLL_LINES)
    }
  }

  useEffect(() => {
    const abortController = createAbortController()

    const pushProgressMessage = (
      message: AssistantMessage | NormalizedUserMessage,
    ): void => {
      toolUseCounterRef.current += 1
      setProgressMessages(current => [
        ...current,
        {
          type: 'progress',
          data: {
            message,
            type: 'agent_progress',
            prompt: task,
            agentId: 'parallel-task',
          },
          parentToolUseID: 'parallel-task',
          toolUseID: `parallel-task-${toolUseCounterRef.current}`,
          timestamp: new Date().toISOString(),
          uuid: randomUUID(),
        },
      ])
    }

    const handleMessage = (message: Message): void => {
      if (abortController.signal.aborted) return

      const normalized = normalizeMessages([message])[0]

      if (message.type === 'assistant') {
        pushProgressMessage(message)
      } else if (message.type === 'user' && normalized?.type === 'user') {
        pushProgressMessage(normalized)
      }
    }

    void runParallelTask({
      task,
      context,
      canUseTool,
      abortController,
      onMessage: handleMessage,
    })
      .then(result => {
        if (!abortController.signal.aborted) {
          setResponse(result)
        }
      })
      .catch(err => {
        if (!abortController.signal.aborted) {
          setError(errorMessage(err) || 'Failed to complete task')
        }
      })

    return () => {
      abortController.abort()
    }
  }, [task, context, canUseTool])

  const maxContentHeight = Math.max(6, rows - CHROME_ROWS - OUTER_CHROME_ROWS)
  const isRunning = !response && !error

  return (
    <Box
      flexDirection="column"
      paddingLeft={2}
      marginTop={1}
      tabIndex={0}
      autoFocus
      onKeyDown={handleKeyDown}
    >
      <Box>
        <Text color="warning" bold>
          /parallel{' '}
        </Text>
        <Text dimColor>{task}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Independent temporary task · no conversation history · no transcript
        </Text>
      </Box>

      <Box marginTop={1} marginLeft={2} maxHeight={maxContentHeight}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {error ? (
            <Text color="error">{error}</Text>
          ) : response ? (
            <Markdown>{response}</Markdown>
          ) : progressMessages.length > 0 ? (
            renderToolUseProgressMessage(progressMessages, {
              tools: context.options.tools,
              verbose: false,
            })
          ) : (
            <Box>
              <SpinnerGlyph frame={frame} messageColor="warning" />
              <Text color="warning">Working...</Text>
            </Box>
          )}
        </ScrollBox>
      </Box>

      {(progressMessages.length > 0 || response || error) && (
        <Box marginTop={1}>
          <Text dimColor>
            {UP_ARROW}/{DOWN_ARROW} to scroll ·{' '}
            {isRunning
              ? 'Space, Enter, or Escape to cancel'
              : 'Space, Enter, or Escape to dismiss'}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const task = args?.trim()

  if (!task) {
    onDone('Usage: /parallel <task>', { display: 'system' })
    return null
  }

  if (!context.canUseTool) {
    onDone('Parallel tasks are unavailable in this context', {
      display: 'system',
    })
    return null
  }

  return (
    <ParallelTaskRunner
      task={task}
      context={context}
      canUseTool={context.canUseTool}
      onDone={onDone}
    />
  )
}
