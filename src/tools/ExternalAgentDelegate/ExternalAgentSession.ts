// src/tools/ExternalAgentDelegate/ExternalAgentSession.ts
// 外部 Agent 会话 — 包装单个子进程的生命周期和事件收集

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import type { ExternalAgentAdapter, ExternalAgentEvent, DelegateTask, DelegateStatus, ToolUseSummary } from './types.js'

// 优雅关闭超时 ms
const GRACEFUL_SHUTDOWN_TIMEOUT = 8000

export class ExternalAgentSession {
  readonly id: string                           // delegate_id (uuid)
  readonly adapter: ExternalAgentAdapter
  readonly task: DelegateTask
  status: DelegateStatus = 'running'
  events: ExternalAgentEvent[] = []             // 收集到的所有事件
  result: string | undefined                    // 最终结果文本
  sessionId: string | undefined                 // 外部 Agent 的 session ID
  tokens: { input: number; output: number } | undefined
  error: string | undefined
  readonly startTime: number

  private process: ChildProcess | null = null
  private abortController: AbortController
  private stderrBuf = ''
  // 完成时的回调（用于通知 SessionManager）
  private onComplete: ((session: ExternalAgentSession) => void) | null = null

  constructor(adapter: ExternalAgentAdapter, task: DelegateTask) {
    this.id = randomUUID()
    this.adapter = adapter
    this.task = task
    this.startTime = Date.now()
    this.abortController = new AbortController()
  }

  // 设置完成回调
  setOnComplete(callback: (session: ExternalAgentSession) => void): void {
    this.onComplete = callback
  }

  // 启动子进程并开始事件循环
  async start(): Promise<void> {
    const cmd = this.adapter.buildCommand(this.task)

    this.process = spawn(cmd.command, cmd.args, {
      cwd: this.task.cwd,
      env: cmd.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: this.abortController.signal,
    })

    // 收集 stderr
    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString()
    })

    // 逐行读取 stdout — 核心事件循环
    if (this.process.stdout) {
      const rl = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      })

      rl.on('line', (line: string) => {
        this.handleOutputLine(line)
      })
    }

    // 进程退出处理
    this.process.on('close', (code: number | null) => {
      this.handleProcessExit(code)
    })

    this.process.on('error', (err: Error) => {
      // spawn 失败（如命令不存在）
      if (this.status === 'running') {
        this.status = 'failed'
        this.error = err.message
        this.onComplete?.(this)
      }
    })

    // 对于通过 stdin 传递任务的适配器（如 claude-code），发送任务消息
    if (this.adapter.name === 'claude-code') {
      this.writeToStdin(this.adapter.buildInputMessage(this.task.task))
    }

    // 设置超时
    if (this.task.timeout > 0) {
      setTimeout(() => {
        if (this.status === 'running') {
          this.stop()
          if (!this.result) {
            this.error = `Task timed out after ${this.task.timeout}ms`
          }
        }
      }, this.task.timeout)
    }
  }

  // 处理 stdout 的一行输出
  private handleOutputLine(line: string): void {
    const event = this.adapter.parseOutputLine(line)
    if (!event) return

    this.events.push(event)

    switch (event.type) {
      case 'system': {
        // 从 system 事件中提取 session_id
        const sid = event.data.session_id as string | undefined
        if (sid) this.sessionId = sid
        break
      }

      case 'permission_request': {
        // 自动批准权限请求
        const requestId = event.data.request_id as string
        const toolInput = event.data.input as Record<string, unknown> | undefined
        const response = this.adapter.buildPermissionResponse(requestId, toolInput)
        if (response) {
          this.writeToStdin(response)
        }
        break
      }

      case 'result': {
        // 收集最终结果和 token 使用量
        this.result = event.data.result as string | undefined
        if (event.data.input_tokens || event.data.output_tokens) {
          this.tokens = {
            input: (event.data.input_tokens as number) ?? 0,
            output: (event.data.output_tokens as number) ?? 0,
          }
        }
        const sid = event.data.session_id as string | undefined
        if (sid) this.sessionId = sid
        break
      }
    }
  }

  // 进程退出处理
  private handleProcessExit(code: number | null): void {
    if (this.status !== 'running') return

    if (code !== null && this.adapter.isSuccessExitCode(code)) {
      this.status = 'completed'
      // 如果没有从 result 事件中获取到结果，尝试从最后一个 text 事件获取
      if (!this.result) {
        const lastTextEvent = [...this.events].reverse().find(e => e.type === 'text')
        if (lastTextEvent) {
          this.result = lastTextEvent.data.text as string
        }
      }
    } else {
      this.status = 'failed'
      this.error = this.stderrBuf || `Process exited with code ${code}`
      // 即使失败也尝试收集文本输出作为结果
      if (!this.result) {
        const textEvents = this.events.filter(e => e.type === 'text')
        if (textEvents.length > 0) {
          this.result = textEvents.map(e => e.data.text as string).join('\n')
        }
      }
    }

    this.onComplete?.(this)
  }

  // 写入 stdin（NDJSON 格式：JSON + 换行）
  private writeToStdin(data: string): void {
    if (!this.process?.stdin?.writable) return
    this.process.stdin.write(data + '\n')
  }

  // 停止进程 — 先 SIGTERM（通过 AbortController），超时后 SIGKILL
  async stop(): Promise<void> {
    if (!this.process || this.status !== 'running') return

    this.abortController.abort()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.process?.kill('SIGKILL')
        } catch {
          // 进程可能已经退出
        }
        if (this.status === 'running') {
          this.status = 'failed'
          this.error = 'Process killed after timeout'
          this.onComplete?.(this)
        }
        resolve()
      }, GRACEFUL_SHUTDOWN_TIMEOUT)

      this.process?.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // 获取进度摘要（最近 5 个事件的简短描述）
  getProgressSummary(): string {
    const recentEvents = this.events.slice(-5)
    if (recentEvents.length === 0) return 'No events yet'

    const lines: string[] = []
    for (const event of recentEvents) {
      switch (event.type) {
        case 'text':
          lines.push(`[text] ${(event.data.text as string).slice(0, 100)}`)
          break
        case 'tool_use':
          lines.push(`[tool] ${event.data.name}: ${JSON.stringify(event.data.input).slice(0, 80)}`)
          break
        case 'thinking':
          lines.push(`[thinking] ${(event.data.thinking as string).slice(0, 80)}`)
          break
        default:
          lines.push(`[${event.type}]`)
      }
    }
    return lines.join('\n')
  }

  // 获取工具使用摘要列表
  getToolUses(): ToolUseSummary[] {
    return this.events
      .filter(e => e.type === 'tool_use')
      .map(e => ({
        tool: e.data.name as string,
        input_summary: JSON.stringify(e.data.input).slice(0, 200),
      }))
  }

  // 等待完成（阻塞模式），超时后自动返回
  waitForResult(timeout: number = 30000): Promise<void> {
    if (this.status !== 'running') return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve()
      }, timeout)

      const originalOnComplete = this.onComplete
      this.onComplete = (session) => {
        clearTimeout(timer)
        originalOnComplete?.(session)
        resolve()
      }
    })
  }

  // 获取已运行时间（毫秒）
  getElapsedMs(): number {
    return Date.now() - this.startTime
  }
}
