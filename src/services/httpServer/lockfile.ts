import { readFileSync, writeFileSync, unlinkSync, chmodSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

export interface LockInfo {
  pid: number
  port: number
  host: string
  token: string
  startedAt: number
  version: string
}

export function getLockfilePath(): string {
  return join(getClaudeConfigHomeDir(), 'http-server.json')
}

export function readLockfile(): LockInfo | null {
  try {
    const raw = readFileSync(getLockfilePath(), 'utf-8')
    const info = JSON.parse(raw) as LockInfo
    // 基本格式校验
    if (typeof info.pid !== 'number' || typeof info.port !== 'number' || typeof info.token !== 'string') {
      return null
    }
    return info
  } catch {
    return null
  }
}

export function writeLockfile(info: LockInfo): void {
  const filepath = getLockfilePath()
  mkdirSync(dirname(filepath), { recursive: true })
  writeFileSync(filepath, JSON.stringify(info, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // 双保险：显式 chmod（某些文件系统忽略 mode 参数）
  try { chmodSync(filepath, 0o600) } catch { /* 静默 */ }
}

export function deleteLockfile(): void {
  try {
    unlinkSync(getLockfilePath())
    logForDebugging('[http-server] lockfile deleted')
  } catch {
    // 文件不存在时静默
  }
}

// pid 探活：kill(pid, 0) 不发信号，仅检查进程是否存在
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// healthz HTTP 探活
async function healthzProbe(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

// 综合 stale 判断：pid 已死 或 healthz 不通 → stale
export async function isLockStale(info: LockInfo, timeoutMs = 2000): Promise<boolean> {
  if (!isProcessAlive(info.pid)) {
    logForDebugging(`[http-server] lockfile stale: pid ${info.pid} not alive`)
    return true
  }
  const healthy = await healthzProbe(info.port, timeoutMs)
  if (!healthy) {
    logForDebugging(`[http-server] lockfile stale: healthz probe failed on port ${info.port}`)
    return true
  }
  return false
}
