/**
 * Pre-compact snapshot — 在 full compact 前保存完整 messages 数组，
 * 供 /rollback 命令恢复到 compact 前的对话状态。
 *
 * 快照文件存储在与 session JSONL 同目录下：
 *   {sessionId}.pre-compact-snapshot.jsonl
 *
 * 生命周期：
 *   - 创建：compactConversation() 入口处
 *   - 消费：/rollback 命令读取后恢复
 *   - 覆盖：每次 compact 只保留最新一个快照
 *   - 删除：rollback 成功后清理
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getSessionId,
  getSessionProjectDir,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { logForDebugging } from '../../utils/debug.js'
import type { Message } from '../../types/message.js'

// ---------------------------------------------------------------------------
// Snapshot file path resolution
// ---------------------------------------------------------------------------

/**
 * 获取快照文件路径。
 * 与 getTranscriptPath() 保持一致的目录解析逻辑：
 *   sessionProjectDir ?? getProjectDir(originalCwd)
 */
function getSnapshotPath(sessionId: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.pre-compact-snapshot.jsonl`)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 保存 compact 前的完整消息快照。
 * 每行一个 JSON 对象（与 session JSONL 格式一致）。
 * 使用 write-to-tmp + rename 模式保证原子性。
 *
 * @returns 快照文件路径
 */
export async function savePreCompactSnapshot(
  sessionId: string,
  messages: Message[],
): Promise<string> {
  const snapshotPath = getSnapshotPath(sessionId)
  const tmpPath = snapshotPath + '.tmp'

  // 确保目录存在
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })

  // 序列化：每行一个 message JSON
  const lines = messages.map(msg => JSON.stringify(msg))
  const content = lines.join('\n') + '\n'

  // 原子写入：先写 tmp 再 rename，避免 crash 时损坏快照
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmpPath, snapshotPath)

  logForDebugging(
    `[Snapshot] Saved pre-compact snapshot: ${messages.length} messages → ${snapshotPath}`,
  )
  return snapshotPath
}

/**
 * 加载最近的 compact 前快照。
 *
 * @returns 完整 messages 数组，无快照时返回 null
 */
export async function loadPreCompactSnapshot(
  sessionId: string,
): Promise<Message[] | null> {
  const snapshotPath = getSnapshotPath(sessionId)

  try {
    const content = await readFile(snapshotPath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    const messages: Message[] = lines.map(line => JSON.parse(line))

    logForDebugging(
      `[Snapshot] Loaded pre-compact snapshot: ${messages.length} messages from ${snapshotPath}`,
    )
    return messages
  } catch (e: unknown) {
    // ENOENT = 无快照，正常情况
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    // 其他错误（解析失败、权限等）— 视为无可用快照，记录日志
    logForDebugging(
      `[Snapshot] Failed to load snapshot: ${(e as Error).message}`,
    )
    return null
  }
}

/**
 * 删除快照文件 — rollback 成功后调用。
 */
export async function deletePreCompactSnapshot(
  sessionId: string,
): Promise<void> {
  const snapshotPath = getSnapshotPath(sessionId)
  try {
    await unlink(snapshotPath)
    logForDebugging(`[Snapshot] Deleted snapshot: ${snapshotPath}`)
  } catch (e: unknown) {
    // ENOENT = 已经不存在，忽略
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(
        `[Snapshot] Failed to delete snapshot: ${(e as Error).message}`,
      )
    }
  }
}

/**
 * 检查快照是否存在。
 */
export async function hasPreCompactSnapshot(
  sessionId: string,
): Promise<boolean> {
  const snapshotPath = getSnapshotPath(sessionId)
  try {
    const s = await stat(snapshotPath)
    return s.size > 0
  } catch {
    return false
  }
}
