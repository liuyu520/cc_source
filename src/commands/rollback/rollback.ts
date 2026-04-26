/**
 * /rollback — 回退到最近一次 full compact 前的对话状态。
 *
 * 工作原理：
 *   1. 读取 compact 前自动保存的快照文件
 *   2. 用 setMessages() 恢复完整消息数组
 *   3. 删除已消费的快照文件
 *
 * 复用模式与 /clear 命令一致（setMessages(() => ...)）
 */

import React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import {
  loadPreCompactSnapshot,
  deletePreCompactSnapshot,
} from '../../services/compact/snapshot.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { logForDebugging } from '../../utils/debug.js'

export const spec = {
  name: 'rollback',
  description: 'Rollback conversation to the state before the last compact',
  isEnabled: () => true,
  isHidden: false,
  userFacing: true,
  argDescription: '',
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  const sessionId = getSessionId()
  if (!sessionId) {
    onDone('No active session found.')
    return null
  }

  try {
    // 加载快照
    const snapshot = await loadPreCompactSnapshot(sessionId)
    if (!snapshot) {
      onDone(
        'No pre-compact snapshot available. A snapshot is created automatically before each full compact.',
        { display: 'system' },
      )
      return null
    }

    // 恢复消息 — 与 /clear 的 setMessages(() => []) 模式一致
    context.setMessages(() => snapshot)

    // 清理已消费的快照文件
    try {
      await deletePreCompactSnapshot(sessionId)
    } catch (e) {
      // 删除失败不影响 rollback 结果
      logForDebugging(
        `[Rollback] Failed to delete snapshot after restore: ${(e as Error).message}`,
      )
    }

    onDone(
      `Rolled back to pre-compact state (${snapshot.length} messages restored).`,
      { display: 'system' },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`Failed to rollback: ${message}`)
  }

  return null
}
