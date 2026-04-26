// src/tools/ExternalAgentDelegate/adapters/GenericAdapter.ts
// 通用可配置适配器 — 允许用户指定任意 CLI 命令

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

// 用户配置的外部 Agent 定义
export interface GenericAgentConfig {
  command: string
  args?: string[]
  output_format?: 'line-json' | 'text'
  input_format?: 'stdin-text' | 'arg'
  env?: Record<string, string>
}

export class GenericAdapter extends BaseExternalAgentAdapter {
  name: string
  private config: GenericAgentConfig

  constructor(name: string, config: GenericAgentConfig) {
    super()
    this.name = name
    this.config = config
  }

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable(this.config.command)
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    const args = [...(this.config.args ?? [])]
    if (this.config.input_format === 'arg') {
      args.push(task.task)
    }
    return {
      command: this.config.command,
      args,
      env: {
        ...(process.env as Record<string, string>),
        ...(this.config.env ?? {}),
        ...task.env,
      },
    }
  }

  parseOutputLine(line: string): ExternalAgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    const now = Date.now()

    if (this.config.output_format === 'line-json') {
      const json = tryParseJSON(trimmed)
      if (json) {
        return { type: 'text', data: json, timestamp: now }
      }
    }

    return { type: 'text', data: { text: trimmed }, timestamp: now }
  }

  buildInputMessage(message: string): string {
    return message
  }

  buildPermissionResponse(_requestId: string): string {
    return ''
  }
}
