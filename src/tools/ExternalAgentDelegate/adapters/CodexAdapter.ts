// src/tools/ExternalAgentDelegate/adapters/CodexAdapter.ts
// OpenAI Codex CLI 适配器 — 使用 `codex exec --json` 获取结构化 JSONL 事件流

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

/**
 * Codex exec --json 事件类型定义
 *
 * 实际输出的 JSONL 事件示例：
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...","status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,"output_tokens":...}}
 *   {"type":"error","message":"..."}
 */

export class CodexAdapter extends BaseExternalAgentAdapter {
  name = 'codex'

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable('codex')
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    const args: string[] = [
      'exec',                   // 非交互式执行子命令
      '--json',                 // 输出 JSONL 结构化事件流（核心：替代 --quiet）
      '--full-auto',            // 自动审批 + workspace-write 沙箱
      '--skip-git-repo-check',  // 允许在非 Git 仓库中运行
      '--ephemeral',            // 不持久化 session 文件（子进程无需保留历史）
    ]

    // 如果指定了工作目录，通过 -C 传递（而非依赖 cwd）
    if (task.cwd) {
      args.push('-C', task.cwd)
    }

    // prompt 作为最后一个位置参数
    args.push(task.task)

    return {
      command: 'codex',
      args,
      env: { ...process.env as Record<string, string>, ...task.env },
    }
  }

  /**
   * 解析 Codex --json 输出的一行 JSONL
   *
   * 事件映射：
   *   thread.started  → system（携带 thread_id 作为 session_id）
   *   turn.started    → system（标记新一轮对话）
   *   item.started    → tool_use（工具调用开始，如 command_execution）
   *   item.completed  → text / tool_result（根据 item.type 区分）
   *   turn.completed  → result（携带 token 用量）
   *   error           → error
   *   纯文本行        → text（兜底，处理 stderr 混入 stdout 等情况）
   */
  parseOutputLine(line: string): ExternalAgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    const now = Date.now()

    // 尝试解析 JSON — Codex --json 模式下每行都是 JSON
    const json = tryParseJSON(trimmed)
    if (!json) {
      // 非 JSON 行（如 stderr 泄露到 stdout 的日志）作为纯文本事件
      return {
        type: 'text',
        data: { text: trimmed },
        timestamp: now,
      }
    }

    const eventType = json.type as string | undefined

    // --- thread.started: 会话开始，提取 thread_id ---
    if (eventType === 'thread.started') {
      return {
        type: 'system',
        data: {
          session_id: json.thread_id as string,
          message: 'Codex session started',
        },
        timestamp: now,
      }
    }

    // --- turn.started: 新一轮对话开始 ---
    if (eventType === 'turn.started') {
      return {
        type: 'system',
        data: { message: 'New turn started' },
        timestamp: now,
      }
    }

    // --- item.started: 工具调用开始（command_execution 等） ---
    if (eventType === 'item.started') {
      const item = json.item as Record<string, unknown> | undefined
      if (item) {
        const itemType = item.type as string
        if (itemType === 'command_execution') {
          return {
            type: 'tool_use',
            data: {
              name: 'shell',
              id: item.id as string,
              input: { command: item.command as string },
            },
            timestamp: now,
          }
        }
        // 其他类型的 item.started（如 file_edit 等）
        return {
          type: 'tool_use',
          data: {
            name: itemType,
            id: item.id as string,
            input: item,
          },
          timestamp: now,
        }
      }
    }

    // --- item.completed: 工具执行完成 / 消息输出 ---
    if (eventType === 'item.completed') {
      const item = json.item as Record<string, unknown> | undefined
      if (item) {
        const itemType = item.type as string

        // agent_message — Codex 的文本回复
        if (itemType === 'agent_message') {
          return {
            type: 'text',
            data: { text: item.text as string },
            timestamp: now,
          }
        }

        // command_execution — 命令执行完成，包含输出和退出码
        if (itemType === 'command_execution') {
          return {
            type: 'tool_result',
            data: {
              id: item.id as string,
              name: 'shell',
              command: item.command as string,
              output: item.aggregated_output as string,
              exit_code: item.exit_code as number | null,
              status: item.status as string,
            },
            timestamp: now,
          }
        }

        // 其他已完成的 item 类型（如 file_edit_completed 等）
        return {
          type: 'tool_result',
          data: {
            id: item.id as string,
            name: itemType,
            ...item,
          },
          timestamp: now,
        }
      }
    }

    // --- turn.completed: 一轮对话结束，包含 token 用量 ---
    if (eventType === 'turn.completed') {
      const usage = json.usage as Record<string, unknown> | undefined
      return {
        type: 'result',
        data: {
          input_tokens: usage?.input_tokens as number | undefined,
          output_tokens: usage?.output_tokens as number | undefined,
          cached_input_tokens: usage?.cached_input_tokens as number | undefined,
        },
        timestamp: now,
      }
    }

    // --- error: Codex 报告的错误 ---
    if (eventType === 'error') {
      return {
        type: 'error',
        data: {
          message: json.message as string,
          text: json.message as string,  // 兼容 getProgressSummary() 中 text 字段的读取
        },
        timestamp: now,
      }
    }

    // --- 兜底：未知的 JSON 事件类型，原样保留 ---
    return {
      type: 'text',
      data: { text: JSON.stringify(json) },
      timestamp: now,
    }
  }

  buildInputMessage(message: string): string {
    return message
  }

  buildPermissionResponse(_requestId: string): string {
    // --full-auto 模式下不需要手动审批
    return ''
  }
}
