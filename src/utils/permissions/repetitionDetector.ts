/**
 * RepetitionInspector — 检测重复 tool 调用
 *
 * 追踪相同 tool name + 参数 hash 的调用频率
 * 短期窗口内超过阈值时，要求用户确认以打断死循环
 *
 * 复用 denialTracking.ts 的状态管理模式（纯函数 + 模块级状态）
 */

import { createHash } from 'node:crypto'
import { logForDebugging } from '../debug.js'

// 重复调用阈值：同一 tool+args 组合在窗口内超过此次数要求确认
const REPETITION_THRESHOLD = 5
// 滑动窗口大小（最近 N 次调用记录）
const WINDOW_SIZE = 20

interface RepetitionEntry {
  key: string        // tool_name:args_hash
  timestamp: number
}

// 滑动窗口追踪（模块级状态，与 denialTracking 的 state 管理模式一致）
const recentCalls: RepetitionEntry[] = []

/**
 * 对 tool 输入生成稳定 hash（用于去重比较）
 * 将 key 排序后 JSON 序列化 + sha256 前 8 字符，确保相同输入始终产生相同 hash
 */
function hashToolInput(input: Record<string, unknown>): string {
  const stable = JSON.stringify(input, Object.keys(input).sort())
  return createHash('sha256').update(stable).digest('hex').slice(0, 8)
}

/**
 * 记录一次 tool 调用并检测是否重复
 *
 * 每次调用都会将 tool name + args hash 加入滑动窗口，
 * 然后统计窗口内同一 key 的出现次数。
 * 超过 REPETITION_THRESHOLD 时返回 true，调用方应要求用户确认。
 *
 * @returns true 如果检测到重复（应要求用户确认），false 正常放行
 */
export function checkRepetition(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const hash = hashToolInput(input)
  const key = `${toolName}:${hash}`
  const now = Date.now()

  // 加入窗口
  recentCalls.push({ key, timestamp: now })
  // 保持窗口大小不超过 WINDOW_SIZE
  while (recentCalls.length > WINDOW_SIZE) {
    recentCalls.shift()
  }

  // 统计窗口内同 key 的次数
  const count = recentCalls.filter(e => e.key === key).length

  if (count >= REPETITION_THRESHOLD) {
    logForDebugging(
      `[RepetitionDetector] tool=${toolName} repeated ${count} times in last ${WINDOW_SIZE} calls`,
      { level: 'warn' },
    )
    return true
  }
  return false
}

/**
 * 重置全部状态（会话结束时调用）
 */
export function resetRepetitionState(): void {
  recentCalls.length = 0
}

/**
 * 用户确认后，清除特定 tool 的重复计数
 * 这样用户确认继续后不会立即再次触发
 */
export function clearRepetitionForTool(toolName: string): void {
  for (let i = recentCalls.length - 1; i >= 0; i--) {
    if (recentCalls[i].key.startsWith(toolName + ':')) {
      recentCalls.splice(i, 1)
    }
  }
}

// 导出常量供测试或外部引用
export { REPETITION_THRESHOLD, WINDOW_SIZE }
