// src/tools/ExternalAgentDelegate/adapters/GeminiAdapter.ts
// Google Gemini CLI 适配器

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

export class GeminiAdapter extends BaseExternalAgentAdapter {
  name = 'gemini'

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable('gemini')
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    return {
      command: 'gemini',
      args: ['-s', task.task],
      env: { ...process.env as Record<string, string>, ...task.env },
    }
  }

  parseOutputLine(line: string): ExternalAgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    const now = Date.now()

    const json = tryParseJSON(trimmed)
    if (json) {
      return {
        type: 'text',
        data: { text: JSON.stringify(json) },
        timestamp: now,
      }
    }

    return {
      type: 'text',
      data: { text: trimmed },
      timestamp: now,
    }
  }

  buildInputMessage(message: string): string {
    return message
  }

  buildPermissionResponse(_requestId: string): string {
    return ''
  }
}
