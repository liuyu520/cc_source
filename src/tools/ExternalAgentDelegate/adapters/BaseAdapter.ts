// src/tools/ExternalAgentDelegate/adapters/BaseAdapter.ts
// 外部 Agent 适配器基类，提供共享的 NDJSON 解析和 CLI 检测逻辑

import { spawn } from 'child_process'
import type { ExternalAgentAdapter, ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

// 通用的 CLI 可用性检测：尝试运行 which/where 命令
export async function checkCliAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(process.platform === 'win32' ? 'where' : 'which', [command], {
      stdio: 'pipe',
      timeout: 5000,
    })
    check.on('close', (code) => resolve(code === 0))
    check.on('error', () => resolve(false))
  })
}

// 尝试将一行文本解析为 JSON，失败返回 null
export function tryParseJSON(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
}

// 从 assistant 消息的 content 数组中提取事件列表
export function parseAssistantContent(content: unknown[]): ExternalAgentEvent[] {
  const events: ExternalAgentEvent[] = []
  const now = Date.now()
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    const blockType = b.type as string
    if (blockType === 'text') {
      events.push({ type: 'text', data: { text: b.text }, timestamp: now })
    } else if (blockType === 'thinking') {
      events.push({ type: 'thinking', data: { thinking: b.thinking }, timestamp: now })
    } else if (blockType === 'tool_use') {
      events.push({
        type: 'tool_use',
        data: { name: b.name, input: b.input, id: b.id },
        timestamp: now,
      })
    }
  }
  return events
}

// 抽象基类，提供通用默认实现
export abstract class BaseExternalAgentAdapter implements ExternalAgentAdapter {
  abstract name: string

  abstract isAvailable(): Promise<boolean>
  abstract buildCommand(task: DelegateTask): AdapterCommand
  abstract parseOutputLine(line: string): ExternalAgentEvent | null
  abstract buildInputMessage(message: string): string
  abstract buildPermissionResponse(requestId: string, toolInput?: Record<string, unknown>): string

  isSuccessExitCode(code: number): boolean {
    return code === 0
  }
}
