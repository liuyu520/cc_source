import { randomBytes } from 'crypto'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { writeLockfile, deleteLockfile, type LockInfo } from './lockfile.js'
import { createFetchHandler, type ServerContext } from './routes.js'

const DEFAULT_PORT = 6646
const DEFAULT_HOST = '0.0.0.0'

function getLogPath(): string {
  return process.env.CLAUDE_HTTP_SERVER_LOG ?? join(getClaudeConfigHomeDir(), 'http-server.log')
}

function logToFile(msg: string): void {
  try {
    appendFileSync(getLogPath(), `${new Date().toISOString()} ${msg}\n`)
  } catch { /* 静默 */ }
}

export async function runHttpServerWorker(): Promise<void> {
  // 解锁 config 读取（daemon 进程中没有走正常 CLI 初始化链路）
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()

  const port = parseInt(process.env.CLAUDE_HTTP_SERVER_PORT ?? String(DEFAULT_PORT), 10)
  const host = process.env.CLAUDE_HTTP_SERVER_HOST ?? DEFAULT_HOST
  const token = randomBytes(32).toString('hex')
  const version = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'
  const startedAt = Date.now()

  // 构造 Anthropic SDK 客户端（惰性，复用 services/api/client.ts）
  let _client: any = null
  async function getClient() {
    if (!_client) {
      const { getAnthropicClient } = await import('../../services/api/client.js')
      _client = await getAnthropicClient({ maxRetries: 2, source: 'http-server' })
    }
    return _client
  }

  const ctx: ServerContext = { token, port, host, startedAt, version, getClient }

  // 启动 Bun.serve
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: host,
      port,
      fetch: createFetchHandler(ctx),
    })
  } catch (e) {
    const msg = (e as Error).message
    logToFile(`[http-server] FATAL: Bun.serve failed: ${msg}`)
    // EADDRINUSE 或权限 → 不写 lockfile，直接退出
    process.exit(1)
  }

  // 写 lockfile
  const lockInfo: LockInfo = { pid: process.pid, port, host, token, startedAt, version }
  writeLockfile(lockInfo)
  logToFile(`[http-server] listening on ${host}:${port} pid=${process.pid}`)

  // 注册退出清理
  function cleanup() {
    logToFile('[http-server] shutting down')
    deleteLockfile()
    try { server.stop() } catch { /* 静默 */ }
  }

  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })

  // uncaughtException / unhandledRejection → 写日志但不退出
  process.on('uncaughtException', (e) => {
    logToFile(`[http-server] uncaughtException: ${e.message}\n${e.stack}`)
  })
  process.on('unhandledRejection', (reason) => {
    logToFile(`[http-server] unhandledRejection: ${String(reason)}`)
  })

  // 阻止进程退出（Bun.serve 自身会保活，但显式挂起更安全）
  await new Promise(() => {})
}
