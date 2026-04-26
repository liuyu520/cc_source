// src/tools/ExternalAgentDelegate/adapters/ClaudeCodeAdapter.ts
// Claude Code CLI 适配器 — 使用 stream-json 双向协议
// 参考 cc-connect 项目的 agent/claudecode/session.go 实现

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON, parseAssistantContent } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

export class ClaudeCodeAdapter extends BaseExternalAgentAdapter {
  name = 'claude-code'

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable('claude')
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ]

    // 过滤 CLAUDECODE 相关环境变量，防止被外部 Claude Code 识别为嵌套会话
    const filteredEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('CLAUDECODE')) {
        filteredEnv[key] = value
      }
    }

    return {
      command: 'claude',
      args,
      env: { ...filteredEnv, ...task.env },
    }
  }

  // 解析 Claude Code CLI 的 stream-json stdout 输出行
  parseOutputLine(line: string): ExternalAgentEvent | null {
    const json = tryParseJSON(line)
    if (!json) return null

    const type = json.type as string
    const now = Date.now()

    switch (type) {
      case 'system': {
        return {
          type: 'system',
          data: { session_id: json.session_id },
          timestamp: now,
        }
      }

      case 'assistant': {
        const message = json.message as Record<string, unknown> | undefined
        const content = (message?.content ?? []) as unknown[]
        const events = parseAssistantContent(content)
        if (events.length === 0) return null
        if (events.length === 1) return events[0]!
        return events.find(e => e.type === 'text') ?? events[0]!
      }

      case 'result': {
        const usage = json.usage as Record<string, number> | undefined
        return {
          type: 'result',
          data: {
            result: json.result,
            session_id: json.session_id,
            input_tokens: usage?.input_tokens,
            output_tokens: usage?.output_tokens,
          },
          timestamp: now,
        }
      }

      case 'control_request': {
        const request = json.request as Record<string, unknown> | undefined
        if (request?.subtype !== 'can_use_tool') return null
        return {
          type: 'permission_request',
          data: {
            request_id: json.request_id,
            tool_name: request?.tool_name,
            input: request?.input,
          },
          timestamp: now,
        }
      }

      default:
        return null
    }
  }

  buildInputMessage(message: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
  }

  buildPermissionResponse(requestId: string, toolInput?: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: toolInput ?? {},
        },
      },
    })
  }
}
