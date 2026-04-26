// src/tools/ExternalAgentDelegate/DelegateToExternalAgentTool.tsx
// 主委派工具 — 将子任务分配给外部 AI Agent CLI 执行

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME } from './constants.js'
import { DELEGATE_DESCRIPTION } from './prompt.js'
import { getAdapter, getAvailableAgentTypes } from './adapters/index.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { DelegateOutput, DelegateTask } from './types.js'
import { renderDelegateToolUseMessage, renderDelegateToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    agent_type: z.string().describe(
      `The external AI agent CLI to delegate to. Available types: ${getAvailableAgentTypes().join(', ')}`
    ),
    task: z.string().describe('Detailed description of the task to delegate'),
    cwd: z.string().optional().describe('Working directory for the external agent (defaults to current directory)'),
    run_in_background: z.boolean().optional().default(true).describe(
      'Whether to run in background mode (default true). You will be notified when the task completes.'
    ),
    env: z.record(z.string(), z.string()).optional().describe('Additional environment variables for the agent'),
    timeout: z.number().min(0).max(3600000).optional().default(600000).describe(
      'Timeout in milliseconds (default 600000 = 10 minutes, max 1 hour)'
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const DelegateToExternalAgentTool = buildTool({
  name: DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  searchHint: 'delegate task to external AI agent CLI codex gemini',
  maxResultSizeChars: 200_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Delegate a sub-task to an external AI Agent CLI'
  },
  async prompt() {
    return DELEGATE_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return renderDelegateToolUseMessage(input)
  },
  renderToolResultMessage(output: DelegateOutput) {
    return renderDelegateToolResultMessage(output)
  },
  async call(
    { agent_type, task, cwd, run_in_background, env, timeout },
    { abortController },
  ) {
    // 获取适配器
    const adapter = getAdapter(agent_type)
    if (!adapter) {
      const available = getAvailableAgentTypes().join(', ')
      return {
        data: {
          delegate_id: '',
          status: 'failed' as const,
          result: `Unknown agent type: '${agent_type}'. Available types: ${available}`,
        },
      }
    }

    // 检查 CLI 是否可用
    const isAvailable = await adapter.isAvailable()
    if (!isAvailable) {
      // 各 agent 类型的安装提示
      const installHints: Record<string, string> = {
        'codex': 'npm install -g @openai/codex',
        'gemini': 'npm install -g @google/gemini-cli',
        'claude-code': 'npm install -g @anthropic-ai/claude-code',
      }
      const hint = installHints[agent_type] ?? `Ensure '${adapter.name}' is installed and available in PATH`
      return {
        data: {
          delegate_id: '',
          status: 'failed' as const,
          result: `${agent_type} CLI not found. Install with: ${hint}`,
        },
      }
    }

    // 构建委派任务
    const delegateTask: DelegateTask = {
      agentType: agent_type,
      task,
      cwd: cwd ?? process.cwd(),
      env: env ?? {},
      timeout: timeout ?? 600000,
    }

    // 创建会话并启动子进程
    const session = await ExternalAgentSessionManager.create(adapter, delegateTask)

    if (run_in_background) {
      // 后台模式：立即返回 delegate_id，任务完成后会收到通知
      return {
        data: {
          delegate_id: session.id,
          status: 'running' as const,
          session_id: session.sessionId,
        } satisfies DelegateOutput,
      }
    }

    // 前台模式：等待任务完成
    await session.waitForResult(timeout ?? 600000)

    return {
      data: {
        delegate_id: session.id,
        status: session.status,
        result: session.result,
        session_id: session.sessionId,
      } satisfies DelegateOutput,
    }
  },
} satisfies ToolDef<InputSchema, DelegateOutput>)
