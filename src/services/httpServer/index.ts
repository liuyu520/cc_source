import { resolve } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import {
  type LockInfo,
  readLockfile,
  deleteLockfile,
  isLockStale,
} from './lockfile.js'

export type { LockInfo }

export type EnsureResult =
  | { status: 'already-running'; info: LockInfo }
  | { status: 'spawned'; pid: number; port: number }
  | { status: 'disabled'; reason: string }
  | { status: 'failed'; error: string }

// 默认 enabled（spec 确认默认 '1'），仅 '0' / 'false' 显式关闭
export function isHttpServerEnabled(): boolean {
  const v = process.env.CLAUDE_HTTP_SERVER_ENABLED
  if (v === '0' || v === 'false') return false
  return true
}

// 快速启动路径不需要启动 HTTP 服务
function isFastPathStartup(): boolean {
  const args = process.argv.slice(2)
  const fastFlags = [
    '--version', '-v', '-V',
    '--dump-system-prompt',
    '--daemon-worker',
    '--chrome-native-host',
    '--claude-in-chrome-mcp',
    '--computer-use-mcp',
    '--http-server-worker',
  ]
  return fastFlags.some(f => args.includes(f))
}

export function getHttpServerStatus(): LockInfo | null {
  return readLockfile()
}

export async function ensureHttpServerRunning(): Promise<EnsureResult> {
  if (!isHttpServerEnabled()) {
    return { status: 'disabled', reason: 'CLAUDE_HTTP_SERVER_ENABLED=0' }
  }

  if (isFastPathStartup()) {
    return { status: 'disabled', reason: 'fast-path startup, skipping' }
  }

  // 1. 检查已有 lockfile
  const existing = readLockfile()
  if (existing) {
    const stale = await isLockStale(existing)
    if (!stale) {
      logForDebugging(`[http-server] already running: pid=${existing.pid} port=${existing.port}`)
      return { status: 'already-running', info: existing }
    }
    // stale lockfile — 清理后继续
    deleteLockfile()
  }

  // 2. Spawn detached daemon
  try {
    const bootstrapPath = resolve(import.meta.dir, '../../bootstrap-entry.ts')
    const child = Bun.spawn(
      [process.execPath, bootstrapPath, '--daemon-worker', 'http-server'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, CLAUDE_HTTP_SERVER_WORKER: '1' },
      },
    )
    child.unref()

    const childPid = child.pid
    logForDebugging(`[http-server] spawned daemon: pid=${childPid}`)

    // 3. 轮询等待 daemon ready（lockfile 出现即表示就绪）
    const readyTimeoutMs = parseInt(process.env.CLAUDE_HTTP_SERVER_READY_TIMEOUT_MS || '3000', 10)
    const pollIntervalMs = 200
    const deadline = Date.now() + readyTimeoutMs

    while (Date.now() < deadline) {
      await Bun.sleep(pollIntervalMs)
      const info = readLockfile()
      if (info && info.pid === childPid) {
        logForDebugging(`[http-server] daemon ready: pid=${info.pid} port=${info.port}`)
        return { status: 'spawned', pid: info.pid, port: info.port }
      }
    }

    return { status: 'failed', error: `daemon did not report ready in ${readyTimeoutMs}ms` }
  } catch (e) {
    return { status: 'failed', error: (e as Error).message }
  }
}
