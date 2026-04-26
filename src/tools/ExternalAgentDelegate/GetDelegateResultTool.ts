// src/tools/ExternalAgentDelegate/GetDelegateResultTool.ts
// 获取委派任务的完整结果

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { GET_DELEGATE_RESULT_TOOL_NAME } from './constants.js'
import { GET_RESULT_DESCRIPTION } from './prompt.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { GetResultOutput } from './types.js'
import { renderGetResultToolUseMessage, renderGetResultToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delegate_id: z.string().describe('The delegate ID returned by DelegateToExternalAgent'),
    block: z.boolean().optional().default(false).describe(
      'Whether to wait for the task to complete before returning (default false)'
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const GetDelegateResultTool = buildTool({
  name: GET_DELEGATE_RESULT_TOOL_NAME,
  searchHint: 'get external agent delegate task result output',
  maxResultSizeChars: 200_000,
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
    return 'Get the result of a delegated external agent task'
  },
  async prompt() {
    return GET_RESULT_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage: renderGetResultToolUseMessage,
  renderToolResultMessage(output: GetResultOutput) {
    return renderGetResultToolResultMessage(output)
  },
  async call({ delegate_id, block }) {
    const session = ExternalAgentSessionManager.get(delegate_id)
    if (!session) {
      return {
        data: {
          status: 'not_found' as const,
        } satisfies GetResultOutput,
      }
    }

    // 阻塞等待完成
    if (block && session.status === 'running') {
      await session.waitForResult(30000)
    }

    return {
      data: {
        status: session.status,
        result: session.result,
        tool_uses: session.getToolUses(),
        tokens: session.tokens,
        error: session.error,
      } satisfies GetResultOutput,
    }
  },
} satisfies ToolDef<InputSchema, GetResultOutput>)
