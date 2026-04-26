// src/tools/ExternalAgentDelegate/CheckDelegateStatusTool.ts
// 查询委派任务当前状态和进度

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CHECK_DELEGATE_STATUS_TOOL_NAME } from './constants.js'
import { CHECK_STATUS_DESCRIPTION } from './prompt.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { CheckStatusOutput } from './types.js'
import { renderCheckStatusToolUseMessage, renderCheckStatusToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delegate_id: z.string().describe('The delegate ID returned by DelegateToExternalAgent'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const CheckDelegateStatusTool = buildTool({
  name: CHECK_DELEGATE_STATUS_TOOL_NAME,
  searchHint: 'check external agent delegate task status progress',
  maxResultSizeChars: 50_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Check the status of a delegated external agent task'
  },
  async prompt() {
    return CHECK_STATUS_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage: renderCheckStatusToolUseMessage,
  renderToolResultMessage(output: CheckStatusOutput) {
    return renderCheckStatusToolResultMessage(output)
  },
  async call({ delegate_id }) {
    const session = ExternalAgentSessionManager.get(delegate_id)
    if (!session) {
      return {
        data: {
          status: 'not_found' as const,
        } satisfies CheckStatusOutput,
      }
    }

    return {
      data: {
        status: session.status,
        progress: session.getProgressSummary(),
        elapsed_ms: session.getElapsedMs(),
        events_count: session.events.length,
      } satisfies CheckStatusOutput,
    }
  },
} satisfies ToolDef<InputSchema, CheckStatusOutput>)
