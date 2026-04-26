# External Agent Delegate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tools that delegate sub-tasks to external AI Agent CLIs (Codex, Gemini, etc.) via stream-json protocol.

**Architecture:** Three new tools (`DelegateToExternalAgent`, `CheckDelegateStatus`, `GetDelegateResult`) built with `buildTool()`, an adapter layer per CLI, and an `ExternalAgentSessionManager` managing child processes. Communication uses NDJSON stdin/stdout protocol (referencing cc-connect's implementation).

**Tech Stack:** TypeScript, Zod schemas, `child_process.spawn`, React/Ink for UI, existing `buildTool`/`lazySchema` patterns.

---

## File Structure

```
src/tools/ExternalAgentDelegate/
  ├── constants.ts                       — Tool name constants
  ├── types.ts                           — Shared types (events, adapter interface, task config)
  ├── prompt.ts                          — System prompt descriptions for all 3 tools
  ├── adapters/
  │   ├── BaseAdapter.ts                 — Abstract base class with shared NDJSON parsing
  │   ├── ClaudeCodeAdapter.ts           — Claude Code CLI adapter (stream-json)
  │   ├── CodexAdapter.ts                — Codex CLI adapter
  │   ├── GeminiAdapter.ts               — Gemini CLI adapter
  │   ├── GenericAdapter.ts              — User-configurable generic adapter
  │   └── index.ts                       — Adapter registry (name → adapter factory)
  ├── ExternalAgentSession.ts            — Single session: wraps child process + event loop
  ├── ExternalAgentSessionManager.ts     — Singleton session manager
  ├── DelegateToExternalAgentTool.tsx     — Main delegation tool
  ├── CheckDelegateStatusTool.ts         — Status query tool
  ├── GetDelegateResultTool.ts           — Result retrieval tool
  └── UI.tsx                             — Ink render components

Modified:
  src/tools.ts                           — Register 3 new tools in getAllBaseTools()
```

---

### Task 1: Constants, Types, and Prompt

**Files:**
- Create: `src/tools/ExternalAgentDelegate/constants.ts`
- Create: `src/tools/ExternalAgentDelegate/types.ts`
- Create: `src/tools/ExternalAgentDelegate/prompt.ts`

- [ ] **Step 1: Create constants.ts**

```typescript
// src/tools/ExternalAgentDelegate/constants.ts
// 外部 Agent 委派工具名常量
export const DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME = 'DelegateToExternalAgent'
export const CHECK_DELEGATE_STATUS_TOOL_NAME = 'CheckDelegateStatus'
export const GET_DELEGATE_RESULT_TOOL_NAME = 'GetDelegateResult'
```

- [ ] **Step 2: Create types.ts**

```typescript
// src/tools/ExternalAgentDelegate/types.ts
// 外部 Agent 委派的共享类型定义

// 外部 Agent 产生的统一事件类型
export interface ExternalAgentEvent {
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'result' | 'permission_request' | 'error'
  data: Record<string, unknown>
  timestamp: number
}

// 委派任务配置
export interface DelegateTask {
  agentType: string        // CLI 类型标识: 'codex' | 'gemini' | 'claude-code' | 自定义名
  task: string             // 委派任务描述
  cwd: string              // 工作目录
  env: Record<string, string>  // 额外环境变量
  timeout: number          // 超时 ms
}

// Adapter 构建命令的返回值
export interface AdapterCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

// Adapter 接口 — 每种 CLI 实现一个
export interface ExternalAgentAdapter {
  // 适配器标识名
  name: string

  // 检测该 CLI 是否已安装可用
  isAvailable(): Promise<boolean>

  // 构建启动命令和参数
  buildCommand(task: DelegateTask): AdapterCommand

  // 解析 stdout 的一行输出为统一事件，返回 null 表示跳过该行
  parseOutputLine(line: string): ExternalAgentEvent | null

  // 构建发送到 stdin 的用户消息 JSON 字符串
  buildInputMessage(message: string): string

  // 构建权限自动批准响应 JSON 字符串
  buildPermissionResponse(requestId: string, toolInput?: Record<string, unknown>): string

  // 判断进程退出码是否表示正常结束
  isSuccessExitCode(code: number): boolean
}

// 会话状态
export type DelegateStatus = 'running' | 'completed' | 'failed'

// 工具调用摘要
export interface ToolUseSummary {
  tool: string
  input_summary: string
}

// DelegateToExternalAgent 工具输出
export interface DelegateOutput {
  delegate_id: string
  status: DelegateStatus
  result?: string
  session_id?: string
}

// CheckDelegateStatus 工具输出
export interface CheckStatusOutput {
  status: DelegateStatus | 'not_found'
  progress?: string
  elapsed_ms?: number
  events_count?: number
}

// GetDelegateResult 工具输出
export interface GetResultOutput {
  status: DelegateStatus | 'not_found'
  result?: string
  tool_uses?: ToolUseSummary[]
  tokens?: { input: number; output: number }
  error?: string
}
```

- [ ] **Step 3: Create prompt.ts**

```typescript
// src/tools/ExternalAgentDelegate/prompt.ts
// 外部 Agent 委派工具的系统提示词描述

import {
  DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  CHECK_DELEGATE_STATUS_TOOL_NAME,
  GET_DELEGATE_RESULT_TOOL_NAME,
} from './constants.js'

export { DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME, CHECK_DELEGATE_STATUS_TOOL_NAME, GET_DELEGATE_RESULT_TOOL_NAME }

export const DELEGATE_DESCRIPTION = `
Delegate a sub-task to an external AI Agent CLI (Codex, Gemini, Claude Code, etc.) running as a separate process on the local machine.

Usage:
- Use this when you want to parallelize work across different AI agents or leverage a specific agent's strengths
- The external agent runs independently with full filesystem access in the specified working directory
- Supported agent types: 'codex', 'gemini', 'claude-code', or any custom CLI configured by the user
- By default runs in background mode - you will be notified when the task completes via <task-notification>
- Permission requests from the external agent are automatically approved

Available agent types:
- codex: OpenAI Codex CLI (requires 'codex' to be installed)
- gemini: Google Gemini CLI (requires 'gemini' to be installed)
- claude-code: Another Claude Code CLI instance (requires 'claude' to be installed)
`

export const CHECK_STATUS_DESCRIPTION = `
Check the current status and progress of a delegated external agent task.

- Takes a delegate_id returned by DelegateToExternalAgent
- Returns the current status, progress summary, elapsed time, and event count
- Use this to monitor long-running delegated tasks
`

export const GET_RESULT_DESCRIPTION = `
Get the complete result from a delegated external agent task.

- Takes a delegate_id returned by DelegateToExternalAgent
- Use block=true to wait for the task to complete before returning
- Returns the final result text, tool usage summary, token counts, and any errors
- If the task is still running and block=false, returns status 'running'
`
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/ExternalAgentDelegate/constants.ts src/tools/ExternalAgentDelegate/types.ts src/tools/ExternalAgentDelegate/prompt.ts
git commit -m "feat: add external agent delegate constants, types, and prompt definitions"
```

---

### Task 2: Base Adapter and Claude Code Adapter

**Files:**
- Create: `src/tools/ExternalAgentDelegate/adapters/BaseAdapter.ts`
- Create: `src/tools/ExternalAgentDelegate/adapters/ClaudeCodeAdapter.ts`

- [ ] **Step 1: Create BaseAdapter.ts**

```typescript
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
```

- [ ] **Step 2: Create ClaudeCodeAdapter.ts**

```typescript
// src/tools/ExternalAgentDelegate/adapters/ClaudeCodeAdapter.ts
// Claude Code CLI 适配器 — 使用 stream-json 双向协议
// 参考 cc-connect 项目的 agent/claudecode/session.go 实现

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON, parseAssistantContent } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

export class ClaudeCodeAdapter extends BaseExternalAgentAdapter {
  name = 'claude-code'

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable('claude')
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ]

    // 过滤 CLAUDECODE 相关环境变量，防止被外部 Claude Code 识别为嵌套会话
    const filteredEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('CLAUDECODE')) {
        filteredEnv[key] = value
      }
    }

    return {
      command: 'claude',
      args,
      env: { ...filteredEnv, ...task.env },
    }
  }

  // 解析 Claude Code CLI 的 stream-json stdout 输出行
  // 事件格式参考 cc-connect session.go 中的 readLoop 和 handle* 方法
  parseOutputLine(line: string): ExternalAgentEvent | null {
    const json = tryParseJSON(line)
    if (!json) return null

    const type = json.type as string
    const now = Date.now()

    switch (type) {
      case 'system': {
        // {"type":"system","session_id":"abc-123"}
        return {
          type: 'system',
          data: { session_id: json.session_id },
          timestamp: now,
        }
      }

      case 'assistant': {
        // {"type":"assistant","message":{"content":[...]}}
        const message = json.message as Record<string, unknown> | undefined
        const content = (message?.content ?? []) as unknown[]
        // 返回 content 中的第一个有效事件（简化处理）
        const events = parseAssistantContent(content)
        // 将所有事件合并为一个综合事件返回
        if (events.length === 0) return null
        if (events.length === 1) return events[0]!
        // 多个 content block 时，优先返回 text 类型
        return events.find(e => e.type === 'text') ?? events[0]!
      }

      case 'result': {
        // {"type":"result","result":"最终结果","session_id":"...","usage":{"input_tokens":N,"output_tokens":N}}
        const usage = json.usage as Record<string, number> | undefined
        return {
          type: 'result',
          data: {
            result: json.result,
            session_id: json.session_id,
            input_tokens: usage?.input_tokens,
            output_tokens: usage?.output_tokens,
          },
          timestamp: now,
        }
      }

      case 'control_request': {
        // {"type":"control_request","request_id":"req_abc","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{...}}}
        const request = json.request as Record<string, unknown> | undefined
        if (request?.subtype !== 'can_use_tool') return null
        return {
          type: 'permission_request',
          data: {
            request_id: json.request_id,
            tool_name: request?.tool_name,
            input: request?.input,
          },
          timestamp: now,
        }
      }

      default:
        return null
    }
  }

  // 构建发送到 stdin 的用户消息 — NDJSON 格式
  buildInputMessage(message: string): string {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    })
  }

  // 构建权限自动批准响应 — 参考 cc-connect RespondPermission()
  buildPermissionResponse(requestId: string, toolInput?: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: toolInput ?? {},
        },
      },
    })
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/ExternalAgentDelegate/adapters/BaseAdapter.ts src/tools/ExternalAgentDelegate/adapters/ClaudeCodeAdapter.ts
git commit -m "feat: add base adapter and Claude Code CLI adapter for external agent delegate"
```

---

### Task 3: Codex, Gemini, Generic Adapters and Registry

**Files:**
- Create: `src/tools/ExternalAgentDelegate/adapters/CodexAdapter.ts`
- Create: `src/tools/ExternalAgentDelegate/adapters/GeminiAdapter.ts`
- Create: `src/tools/ExternalAgentDelegate/adapters/GenericAdapter.ts`
- Create: `src/tools/ExternalAgentDelegate/adapters/index.ts`

- [ ] **Step 1: Create CodexAdapter.ts**

```typescript
// src/tools/ExternalAgentDelegate/adapters/CodexAdapter.ts
// OpenAI Codex CLI 适配器

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

export class CodexAdapter extends BaseExternalAgentAdapter {
  name = 'codex'

  async isAvailable(): Promise<boolean> {
    return checkCliAvailable('codex')
  }

  buildCommand(task: DelegateTask): AdapterCommand {
    return {
      command: 'codex',
      // --quiet 减少输出噪音, --full-auto 自动批准所有操作
      args: ['--quiet', '--full-auto', task.task],
      env: { ...process.env as Record<string, string>, ...task.env },
    }
  }

  // Codex CLI 输出为纯文本或 JSON，解析为统一事件
  parseOutputLine(line: string): ExternalAgentEvent | null {
    const trimmed = line.trim()
    if (!trimmed) return null

    const now = Date.now()

    // 尝试 JSON 解析
    const json = tryParseJSON(trimmed)
    if (json) {
      // Codex 可能输出结构化 JSON
      return {
        type: 'text',
        data: { text: JSON.stringify(json) },
        timestamp: now,
      }
    }

    // 纯文本输出作为 text 事件
    return {
      type: 'text',
      data: { text: trimmed },
      timestamp: now,
    }
  }

  // Codex 使用命令行参数传入任务，不通过 stdin 发送消息
  buildInputMessage(message: string): string {
    return message
  }

  // Codex --full-auto 模式下不会发权限请求
  buildPermissionResponse(_requestId: string): string {
    return ''
  }
}
```

- [ ] **Step 2: Create GeminiAdapter.ts**

```typescript
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
      // -s 为非交互/sandbox 模式
      args: ['-s', task.task],
      env: { ...process.env as Record<string, string>, ...task.env },
    }
  }

  // Gemini CLI 输出解析
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

  // Gemini 使用命令行参数传入任务
  buildInputMessage(message: string): string {
    return message
  }

  // Gemini sandbox 模式不发权限请求
  buildPermissionResponse(_requestId: string): string {
    return ''
  }
}
```

- [ ] **Step 3: Create GenericAdapter.ts**

```typescript
// src/tools/ExternalAgentDelegate/adapters/GenericAdapter.ts
// 通用可配置适配器 — 允许用户指定任意 CLI 命令

import { BaseExternalAgentAdapter, checkCliAvailable, tryParseJSON } from './BaseAdapter.js'
import type { ExternalAgentEvent, DelegateTask, AdapterCommand } from '../types.js'

// 用户配置的外部 Agent 定义
export interface GenericAgentConfig {
  command: string
  args?: string[]
  output_format?: 'line-json' | 'text'  // 输出解析方式
  input_format?: 'stdin-text' | 'arg'   // 任务传递方式
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
    // arg 模式：将任务附加到命令行参数
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
```

- [ ] **Step 4: Create adapters/index.ts (adapter registry)**

```typescript
// src/tools/ExternalAgentDelegate/adapters/index.ts
// Adapter 注册表 — 根据名称获取适配器实例

import type { ExternalAgentAdapter } from '../types.js'
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter.js'
import { CodexAdapter } from './CodexAdapter.js'
import { GeminiAdapter } from './GeminiAdapter.js'
import { GenericAdapter, type GenericAgentConfig } from './GenericAdapter.js'

// 内建适配器工厂
const builtInAdapters: Record<string, () => ExternalAgentAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  'codex': () => new CodexAdapter(),
  'gemini': () => new GeminiAdapter(),
}

// 用户自定义适配器配置缓存
let customConfigs: Record<string, GenericAgentConfig> = {}

// 设置用户自定义的 Agent 配置（从设置文件加载）
export function setCustomAgentConfigs(configs: Record<string, GenericAgentConfig>): void {
  customConfigs = configs
}

// 根据 agent_type 获取适配器实例
export function getAdapter(agentType: string): ExternalAgentAdapter | null {
  // 优先查找内建适配器
  const factory = builtInAdapters[agentType]
  if (factory) return factory()

  // 查找用户自定义适配器
  const config = customConfigs[agentType]
  if (config) return new GenericAdapter(agentType, config)

  return null
}

// 获取所有可用的 agent type 名称
export function getAvailableAgentTypes(): string[] {
  return [...Object.keys(builtInAdapters), ...Object.keys(customConfigs)]
}
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/ExternalAgentDelegate/adapters/
git commit -m "feat: add Codex, Gemini, Generic adapters and adapter registry"
```

---

### Task 4: ExternalAgentSession (Child Process Wrapper)

**Files:**
- Create: `src/tools/ExternalAgentDelegate/ExternalAgentSession.ts`

- [ ] **Step 1: Create ExternalAgentSession.ts**

```typescript
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
    // 注意：codex 和 gemini 通过命令行参数传递任务，不需要 stdin 发送
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
        // 记录外部 Agent 的 session ID
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
        // 外部 Agent 完成，提取结果
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

      // text, thinking, tool_use, error 等事件仅记录
    }
  }

  // 进程退出处理
  private handleProcessExit(code: number | null): void {
    if (this.status !== 'running') return

    if (code !== null && this.adapter.isSuccessExitCode(code)) {
      this.status = 'completed'
      // 如果没有通过 result 事件获得结果，使用最后的 text 事件
      if (!this.result) {
        const lastTextEvent = [...this.events].reverse().find(e => e.type === 'text')
        if (lastTextEvent) {
          this.result = lastTextEvent.data.text as string
        }
      }
    } else {
      this.status = 'failed'
      this.error = this.stderrBuf || `Process exited with code ${code}`
      // 即使失败也保留部分结果
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

  // 停止进程 — 先 SIGTERM，超时后 SIGKILL
  async stop(): Promise<void> {
    if (!this.process || this.status !== 'running') return

    // 先尝试优雅关闭
    this.abortController.abort()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 超时强制 kill
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

  // 获取进度摘要 — 最近几条事件的简要描述
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

  // 等待完成（阻塞模式）
  waitForResult(timeout: number = 30000): Promise<void> {
    if (this.status !== 'running') return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve() // 超时不再等待，返回当前状态
      }, timeout)

      const originalOnComplete = this.onComplete
      this.onComplete = (session) => {
        clearTimeout(timer)
        originalOnComplete?.(session)
        resolve()
      }
    })
  }

  // 获取已运行时间
  getElapsedMs(): number {
    return Date.now() - this.startTime
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/ExternalAgentDelegate/ExternalAgentSession.ts
git commit -m "feat: add ExternalAgentSession child process wrapper"
```

---

### Task 5: ExternalAgentSessionManager (Singleton)

**Files:**
- Create: `src/tools/ExternalAgentDelegate/ExternalAgentSessionManager.ts`

- [ ] **Step 1: Create ExternalAgentSessionManager.ts**

```typescript
// src/tools/ExternalAgentDelegate/ExternalAgentSessionManager.ts
// 外部 Agent 会话管理器 — 单例模式，管理所有活跃的委派会话

import { ExternalAgentSession } from './ExternalAgentSession.js'
import type { ExternalAgentAdapter, DelegateTask } from './types.js'

// 完成通知回调类型
export type DelegateCompleteCallback = (session: ExternalAgentSession) => void

class ExternalAgentSessionManagerImpl {
  private sessions = new Map<string, ExternalAgentSession>()
  // 外部注册的完成通知回调（用于触发 <task-notification>）
  private completeCallbacks = new Map<string, DelegateCompleteCallback>()

  // 创建新的委派会话
  async create(adapter: ExternalAgentAdapter, task: DelegateTask): Promise<ExternalAgentSession> {
    const session = new ExternalAgentSession(adapter, task)
    this.sessions.set(session.id, session)

    // 设置完成回调
    session.setOnComplete((completedSession) => {
      const callback = this.completeCallbacks.get(completedSession.id)
      if (callback) {
        callback(completedSession)
        this.completeCallbacks.delete(completedSession.id)
      }
    })

    await session.start()
    return session
  }

  // 获取会话
  get(delegateId: string): ExternalAgentSession | undefined {
    return this.sessions.get(delegateId)
  }

  // 注册完成通知回调
  onComplete(delegateId: string, callback: DelegateCompleteCallback): void {
    this.completeCallbacks.set(delegateId, callback)
  }

  // 销毁单个会话
  async destroy(delegateId: string): Promise<void> {
    const session = this.sessions.get(delegateId)
    if (session) {
      await session.stop()
      this.sessions.delete(delegateId)
      this.completeCallbacks.delete(delegateId)
    }
  }

  // 清理所有会话（进程退出时调用）
  async destroyAll(): Promise<void> {
    const promises = Array.from(this.sessions.values()).map(session => session.stop())
    await Promise.allSettled(promises)
    this.sessions.clear()
    this.completeCallbacks.clear()
  }

  // 获取所有活跃会话数量
  getActiveCount(): number {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running').length
  }
}

// 全局单例
export const ExternalAgentSessionManager = new ExternalAgentSessionManagerImpl()

// 注册进程退出清理钩子
process.on('exit', () => {
  // exit 事件中只能执行同步操作，但 destroyAll 是异步的
  // 使用 SIGTERM / SIGINT 处理更可靠的清理
})

// 优雅关闭时清理所有外部 Agent 子进程
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void ExternalAgentSessionManager.destroyAll()
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/ExternalAgentDelegate/ExternalAgentSessionManager.ts
git commit -m "feat: add ExternalAgentSessionManager singleton"
```

---

### Task 6: UI Render Components

**Files:**
- Create: `src/tools/ExternalAgentDelegate/UI.tsx`

- [ ] **Step 1: Create UI.tsx**

```tsx
// src/tools/ExternalAgentDelegate/UI.tsx
// 外部 Agent 委派工具的 Ink 渲染组件

import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { DelegateOutput, CheckStatusOutput, GetResultOutput } from './types.js'

// DelegateToExternalAgent 工具使用消息
export function renderDelegateToolUseMessage(input: {
  agent_type: string
  task: string
}): React.ReactNode {
  const taskPreview = input.task.length > 100
    ? input.task.slice(0, 100) + '...'
    : input.task
  return (
    <MessageResponse>
      <Text>
        Delegating to {input.agent_type}: {taskPreview}
      </Text>
    </MessageResponse>
  )
}

// DelegateToExternalAgent 工具结果消息
export function renderDelegateToolResultMessage(
  output: DelegateOutput,
): React.ReactNode {
  const statusIcon = output.status === 'completed' ? '✓' : output.status === 'running' ? '⏳' : '✗'
  return (
    <MessageResponse>
      <Text>
        {statusIcon} Delegate {output.delegate_id.slice(0, 8)}... [{output.status}]
        {output.result ? ` — ${output.result.slice(0, 100)}` : ''}
      </Text>
    </MessageResponse>
  )
}

// CheckDelegateStatus 工具使用消息
export function renderCheckStatusToolUseMessage(): React.ReactNode {
  return ''
}

// CheckDelegateStatus 工具结果消息
export function renderCheckStatusToolResultMessage(
  output: CheckStatusOutput,
): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        Delegate status: {output.status}
        {output.elapsed_ms ? ` (${Math.round(output.elapsed_ms / 1000)}s)` : ''}
        {output.events_count ? ` — ${output.events_count} events` : ''}
      </Text>
    </MessageResponse>
  )
}

// GetDelegateResult 工具使用消息
export function renderGetResultToolUseMessage(): React.ReactNode {
  return ''
}

// GetDelegateResult 工具结果消息
export function renderGetResultToolResultMessage(
  output: GetResultOutput,
): React.ReactNode {
  const statusIcon = output.status === 'completed' ? '✓' : output.status === 'failed' ? '✗' : '⏳'
  return (
    <MessageResponse>
      <Text>
        {statusIcon} Result [{output.status}]
        {output.result ? `: ${output.result.slice(0, 150)}` : ''}
        {output.error ? ` — Error: ${output.error.slice(0, 100)}` : ''}
      </Text>
    </MessageResponse>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/ExternalAgentDelegate/UI.tsx
git commit -m "feat: add Ink UI components for external agent delegate tools"
```

---

### Task 7: DelegateToExternalAgentTool (Main Tool)

**Files:**
- Create: `src/tools/ExternalAgentDelegate/DelegateToExternalAgentTool.tsx`

- [ ] **Step 1: Create DelegateToExternalAgentTool.tsx**

```typescript
// src/tools/ExternalAgentDelegate/DelegateToExternalAgentTool.tsx
// 主委派工具 — 将子任务分配给外部 AI Agent CLI 执行

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME } from './constants.js'
import { DELEGATE_DESCRIPTION } from './prompt.js'
import { getAdapter, getAvailableAgentTypes } from './adapters/index.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { DelegateOutput, DelegateTask } from './types.js'
import { renderDelegateToolUseMessage, renderDelegateToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    agent_type: z.string().describe(
      `The external AI agent CLI to delegate to. Available types: ${getAvailableAgentTypes().join(', ')}`
    ),
    task: z.string().describe('Detailed description of the task to delegate'),
    cwd: z.string().optional().describe('Working directory for the external agent (defaults to current directory)'),
    run_in_background: z.boolean().optional().default(true).describe(
      'Whether to run in background mode (default true). You will be notified when the task completes.'
    ),
    env: z.record(z.string(), z.string()).optional().describe('Additional environment variables for the agent'),
    timeout: z.number().min(0).max(3600000).optional().default(600000).describe(
      'Timeout in milliseconds (default 600000 = 10 minutes, max 1 hour)'
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const DelegateToExternalAgentTool = buildTool({
  name: DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME,
  searchHint: 'delegate task to external AI agent CLI codex gemini',
  maxResultSizeChars: 200_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async description() {
    return 'Delegate a sub-task to an external AI Agent CLI'
  },
  async prompt() {
    return DELEGATE_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage(input: z.infer<InputSchema>) {
    return renderDelegateToolUseMessage(input)
  },
  renderToolResultMessage(output: DelegateOutput) {
    return renderDelegateToolResultMessage(output)
  },
  async call(
    { agent_type, task, cwd, run_in_background, env, timeout },
    { abortController },
  ) {
    // 获取适配器
    const adapter = getAdapter(agent_type)
    if (!adapter) {
      const available = getAvailableAgentTypes().join(', ')
      return {
        data: {
          delegate_id: '',
          status: 'failed' as const,
          result: `Unknown agent type: '${agent_type}'. Available types: ${available}`,
        },
      }
    }

    // 检查 CLI 是否可用
    const isAvailable = await adapter.isAvailable()
    if (!isAvailable) {
      const installHints: Record<string, string> = {
        'codex': 'npm install -g @openai/codex',
        'gemini': 'npm install -g @anthropic-ai/claude-code (or install Gemini CLI from Google)',
        'claude-code': 'npm install -g @anthropic-ai/claude-code',
      }
      const hint = installHints[agent_type] ?? `Ensure '${adapter.name}' is installed and available in PATH`
      return {
        data: {
          delegate_id: '',
          status: 'failed' as const,
          result: `${agent_type} CLI not found. Install with: ${hint}`,
        },
      }
    }

    // 构建委派任务
    const delegateTask: DelegateTask = {
      agentType: agent_type,
      task,
      cwd: cwd ?? process.cwd(),
      env: env ?? {},
      timeout: timeout ?? 600000,
    }

    // 创建会话并启动子进程
    const session = await ExternalAgentSessionManager.create(adapter, delegateTask)

    if (run_in_background) {
      // 后台模式：注册完成通知，立即返回 delegate_id
      // 完成时通过 <task-notification> 通知模型（由调用方处理）
      return {
        data: {
          delegate_id: session.id,
          status: 'running' as const,
          session_id: session.sessionId,
        } satisfies DelegateOutput,
      }
    }

    // 前台模式：等待完成
    await session.waitForResult(timeout ?? 600000)

    return {
      data: {
        delegate_id: session.id,
        status: session.status,
        result: session.result,
        session_id: session.sessionId,
      } satisfies DelegateOutput,
    }
  },
} satisfies ToolDef<InputSchema, DelegateOutput>)
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/ExternalAgentDelegate/DelegateToExternalAgentTool.tsx
git commit -m "feat: add DelegateToExternalAgentTool - main delegation tool"
```

---

### Task 8: CheckDelegateStatusTool and GetDelegateResultTool

**Files:**
- Create: `src/tools/ExternalAgentDelegate/CheckDelegateStatusTool.ts`
- Create: `src/tools/ExternalAgentDelegate/GetDelegateResultTool.ts`

- [ ] **Step 1: Create CheckDelegateStatusTool.ts**

```typescript
// src/tools/ExternalAgentDelegate/CheckDelegateStatusTool.ts
// 查询委派任务当前状态和进度

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { CHECK_DELEGATE_STATUS_TOOL_NAME } from './constants.js'
import { CHECK_STATUS_DESCRIPTION } from './prompt.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { CheckStatusOutput } from './types.js'
import { renderCheckStatusToolUseMessage, renderCheckStatusToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delegate_id: z.string().describe('The delegate ID returned by DelegateToExternalAgent'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const CheckDelegateStatusTool = buildTool({
  name: CHECK_DELEGATE_STATUS_TOOL_NAME,
  searchHint: 'check external agent delegate task status progress',
  maxResultSizeChars: 50_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Check the status of a delegated external agent task'
  },
  async prompt() {
    return CHECK_STATUS_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage: renderCheckStatusToolUseMessage,
  renderToolResultMessage(output: CheckStatusOutput) {
    return renderCheckStatusToolResultMessage(output)
  },
  async call({ delegate_id }) {
    const session = ExternalAgentSessionManager.get(delegate_id)
    if (!session) {
      return {
        data: {
          status: 'not_found' as const,
        } satisfies CheckStatusOutput,
      }
    }

    return {
      data: {
        status: session.status,
        progress: session.getProgressSummary(),
        elapsed_ms: session.getElapsedMs(),
        events_count: session.events.length,
      } satisfies CheckStatusOutput,
    }
  },
} satisfies ToolDef<InputSchema, CheckStatusOutput>)
```

- [ ] **Step 2: Create GetDelegateResultTool.ts**

```typescript
// src/tools/ExternalAgentDelegate/GetDelegateResultTool.ts
// 获取委派任务的完整结果

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { GET_DELEGATE_RESULT_TOOL_NAME } from './constants.js'
import { GET_RESULT_DESCRIPTION } from './prompt.js'
import { ExternalAgentSessionManager } from './ExternalAgentSessionManager.js'
import type { GetResultOutput } from './types.js'
import { renderGetResultToolUseMessage, renderGetResultToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delegate_id: z.string().describe('The delegate ID returned by DelegateToExternalAgent'),
    block: z.boolean().optional().default(false).describe(
      'Whether to wait for the task to complete before returning (default false)'
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const GetDelegateResultTool = buildTool({
  name: GET_DELEGATE_RESULT_TOOL_NAME,
  searchHint: 'get external agent delegate task result output',
  maxResultSizeChars: 200_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Get the result of a delegated external agent task'
  },
  async prompt() {
    return GET_RESULT_DESCRIPTION
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  renderToolUseMessage: renderGetResultToolUseMessage,
  renderToolResultMessage(output: GetResultOutput) {
    return renderGetResultToolResultMessage(output)
  },
  async call({ delegate_id, block }) {
    const session = ExternalAgentSessionManager.get(delegate_id)
    if (!session) {
      return {
        data: {
          status: 'not_found' as const,
        } satisfies GetResultOutput,
      }
    }

    // 阻塞等待完成
    if (block && session.status === 'running') {
      await session.waitForResult(30000)
    }

    return {
      data: {
        status: session.status,
        result: session.result,
        tool_uses: session.getToolUses(),
        tokens: session.tokens,
        error: session.error,
      } satisfies GetResultOutput,
    }
  },
} satisfies ToolDef<InputSchema, GetResultOutput>)
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/ExternalAgentDelegate/CheckDelegateStatusTool.ts src/tools/ExternalAgentDelegate/GetDelegateResultTool.ts
git commit -m "feat: add CheckDelegateStatus and GetDelegateResult tools"
```

---

### Task 9: Register Tools in tools.ts

**Files:**
- Modify: `src/tools.ts:1-252`

- [ ] **Step 1: Add imports to src/tools.ts**

Add these import lines after the existing tool imports (around line 85, after the `TaskListTool` import):

```typescript
import { DelegateToExternalAgentTool } from './tools/ExternalAgentDelegate/DelegateToExternalAgentTool.js'
import { CheckDelegateStatusTool } from './tools/ExternalAgentDelegate/CheckDelegateStatusTool.js'
import { GetDelegateResultTool } from './tools/ExternalAgentDelegate/GetDelegateResultTool.js'
```

- [ ] **Step 2: Add tools to getAllBaseTools()**

Add the three tools to the `getAllBaseTools()` function's return array, after the `BriefTool` entry (around line 239):

```typescript
    BriefTool,
    // 外部 Agent 委派工具
    DelegateToExternalAgentTool,
    CheckDelegateStatusTool,
    GetDelegateResultTool,
```

- [ ] **Step 3: Add tool names to third-party API core tools**

In the `getTools()` function, add the three tool names to `CORE_TOOL_NAMES` set (around line 304) so they are available when using third-party API:

```typescript
    const CORE_TOOL_NAMES = new Set([
      'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Agent', 'WebFetch', 'WebSearch', 'NotebookEdit',
      'LSP', 'AskUserQuestion', 'TaskStop',
      'DelegateToExternalAgent', 'CheckDelegateStatus', 'GetDelegateResult',
    ])
```

- [ ] **Step 4: Verify the module resolves**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run -e "import('./src/tools/ExternalAgentDelegate/constants.ts').then(m => console.log('OK:', Object.keys(m)))"`

Expected: `OK: [ 'DELEGATE_TO_EXTERNAL_AGENT_TOOL_NAME', 'CHECK_DELEGATE_STATUS_TOOL_NAME', 'GET_DELEGATE_RESULT_TOOL_NAME' ]`

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts
git commit -m "feat: register external agent delegate tools in tool registry"
```

---

### Task 10: Smoke Test

**Files:** None (manual verification)

- [ ] **Step 1: Start the CLI and verify tools appear**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run dev`

Verify that the new tools appear in the tool list. Type `/tools` or similar command to list available tools.

Expected: `DelegateToExternalAgent`, `CheckDelegateStatus`, `GetDelegateResult` should appear in the tool list.

- [ ] **Step 2: Test adapter availability detection**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run -e "
import { getAdapter } from './src/tools/ExternalAgentDelegate/adapters/index.ts'
const adapter = getAdapter('codex')
if (adapter) {
  adapter.isAvailable().then(v => console.log('codex available:', v))
}
const cc = getAdapter('claude-code')
if (cc) {
  cc.isAvailable().then(v => console.log('claude-code available:', v))
}
const unknown = getAdapter('nonexistent')
console.log('unknown adapter:', unknown)
"`

Expected: Availability check returns true/false based on CLI installation. Unknown adapter returns null.

- [ ] **Step 3: Test Claude Code adapter message format**

Run: `cd /Users/ywwl/Documents/code/ideaWorkspace/ai/claude-code-minimaxOk && bun run -e "
import { ClaudeCodeAdapter } from './src/tools/ExternalAgentDelegate/adapters/ClaudeCodeAdapter.ts'
const adapter = new ClaudeCodeAdapter()

// Test input message format
const input = adapter.buildInputMessage('Hello world')
console.log('Input:', input)

// Test permission response format
const resp = adapter.buildPermissionResponse('req_123', {command: 'ls'})
console.log('Permission:', resp)

// Test output parsing
const systemLine = '{\"type\":\"system\",\"session_id\":\"test-123\"}'
const parsed = adapter.parseOutputLine(systemLine)
console.log('Parsed system:', parsed)

const resultLine = '{\"type\":\"result\",\"result\":\"done\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}'
const parsedResult = adapter.parseOutputLine(resultLine)
console.log('Parsed result:', parsedResult)
"`

Expected: Correct NDJSON message formats matching the cc-connect protocol.

- [ ] **Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
