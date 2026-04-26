# Claude Code HTTP/SSE LLM Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-starting global HTTP/SSE LLM service on port 6646 that supports both OpenAI and Anthropic API protocols, launched as a detached background process when Claude Code CLI starts.

**Architecture:** CLI startup calls `ensureHttpServerRunning()` which checks a lockfile + healthz probe. If no running daemon is found, it spawns `bun bootstrap-entry.ts --daemon-worker http-server` (detached). The child process runs `Bun.serve()` on `0.0.0.0:6646`, writes a lockfile with PID/token/port, and handles requests by routing to OpenAI-adapter or Anthropic-passthrough handlers. Both use the existing `getAnthropicClient()` SDK to call the upstream API.

**Tech Stack:** TypeScript, Bun (built-in `Bun.serve`), `@anthropic-ai/sdk`, `signal-exit`

**Spec:** `docs/superpowers/specs/2026-04-16-claude-code-http-sse-server-design.md`

---

## Task 0: Pre-implementation Probes

**Files:**
- Create: `scripts/probe-feature.ts` (temporary, delete after probing)
- Create: `scripts/probe-detach.ts` (temporary, delete after probing)

These probes determine whether the `--daemon-worker` fast-path in `cli.tsx:100` works at runtime, and whether `Bun.spawn` detached children survive parent exit. Results gate the approach for Tasks 1-3.

- [ ] **Step 0.1: Probe `feature('DAEMON')` runtime value**

Create `scripts/probe-feature.ts`:
```ts
try {
  const { feature } = await import('bun:bundle')
  console.log('feature DAEMON =', feature('DAEMON'))
  console.log('feature BRIDGE_MODE =', feature('BRIDGE_MODE'))
} catch (e) {
  console.log('bun:bundle not available at runtime:', (e as Error).message)
}
```

Run: `bun run scripts/probe-feature.ts`

**Branch:**
- If output shows `feature DAEMON = true` → `cli.tsx:100` fast-path works. **No changes needed to cli.tsx.**
- If output shows `false` or `bun:bundle not available` → Must add a **fallback fast-path** in `cli.tsx` (see Task 1 Step 1.2-alt).

- [ ] **Step 0.2: Probe detached spawn survival on macOS**

Create `scripts/probe-detach.ts`:
```ts
import { resolve } from 'path'

const child = Bun.spawn(['bun', '-e', 'await Bun.sleep(30000); console.log("alive")'], {
  stdio: ['ignore', 'ignore', 'ignore'],
  // @ts-ignore Bun types
  detached: true,
})
child.unref()

console.log('spawned child pid:', child.pid)
console.log('parent exiting in 1s...')
await Bun.sleep(1000)
process.exit(0)
```

Run: `bun run scripts/probe-detach.ts && sleep 2 && ps -p $(bun run scripts/probe-detach.ts 2>&1 | grep 'spawned child pid:' | awk '{print $NF}')`

Or simpler manual test:
```bash
bun run scripts/probe-detach.ts
# Note the PID printed
# Wait 2 seconds after parent exits
ps -p <PID>  # Should show the child still alive
```

**Branch:**
- If child survives → `Bun.spawn` detached works. Use it in Task 3.
- If child dies with parent → Switch to `child_process.spawn` with `detached: true, stdio: 'ignore'` and `.unref()` in Task 3.

- [ ] **Step 0.3: Clean up probe scripts**

```bash
rm scripts/probe-feature.ts scripts/probe-detach.ts
```

---

## Task 1: Create Worker Registry (`src/daemon/workerRegistry.ts`)

**Files:**
- Create: `src/daemon/workerRegistry.ts`

This file fills the "dead import" at `src/entrypoints/cli.tsx:103` (`import('../daemon/workerRegistry.js')`). It's a simple switch dispatcher that routes daemon worker kinds to their entry points.

- [ ] **Step 1.1: Create the daemon directory and workerRegistry.ts**

```bash
mkdir -p src/daemon
```

Create `src/daemon/workerRegistry.ts`:
```ts
// daemon worker 注册分发器
// cli.tsx:100-106 的 --daemon-worker fast-path 动态 import 此文件
export async function runDaemonWorker(kind: string): Promise<void> {
  switch (kind) {
    case 'http-server': {
      const { runHttpServerWorker } = await import(
        '../services/httpServer/workerEntry.js'
      )
      return runHttpServerWorker()
    }
    default:
      throw new Error(`unknown daemon worker kind: ${kind}`)
  }
}
```

- [ ] **Step 1.2 (conditional): Add fallback fast-path in cli.tsx**

**Only do this if Step 0.1 showed `feature('DAEMON')` returns false or throws.**

Edit `src/entrypoints/cli.tsx`. Add **after** line 106 (after the existing `feature('DAEMON')` block):

```ts
  // Fallback for restored builds where feature('DAEMON') is not available:
  // direct arg check for --daemon-worker without feature gate.
  if (!feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }
```

**If Step 0.1 showed `feature('DAEMON')` returns true, skip this step entirely.**

- [ ] **Step 1.3: Verify the registry loads**

```bash
bun run src/bootstrap-entry.ts --daemon-worker nonexistent 2>&1
```

Expected: Error message containing `unknown daemon worker kind: nonexistent`

- [ ] **Step 1.4: Commit**

```bash
git add src/daemon/workerRegistry.ts
# If cli.tsx was modified:
# git add src/entrypoints/cli.tsx
git commit -m "feat(http-server): create daemon worker registry (fills cli.tsx:103 dead import)"
```

---

## Task 2: Create Lockfile Module (`src/services/httpServer/lockfile.ts`)

**Files:**
- Create: `src/services/httpServer/lockfile.ts`

Handles reading/writing/deleting `~/.claude/http-server.json` and detecting stale lockfiles via PID liveness + healthz probe.

- [ ] **Step 2.1: Create directory structure**

```bash
mkdir -p src/services/httpServer/adapters
```

- [ ] **Step 2.2: Write lockfile.ts**

Create `src/services/httpServer/lockfile.ts`:
```ts
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
```

- [ ] **Step 2.3: Commit**

```bash
git add src/services/httpServer/lockfile.ts
git commit -m "feat(http-server): add lockfile module for singleton detection"
```

---

## Task 3: Create HTTP Server Entry API (`src/services/httpServer/index.ts`)

**Files:**
- Create: `src/services/httpServer/index.ts`

This is what `main.tsx` calls. It checks the lockfile, probes the daemon, spawns if needed.

- [ ] **Step 3.1: Write index.ts**

Create `src/services/httpServer/index.ts`:
```ts
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

export function isHttpServerEnabled(): boolean {
  const v = process.env.CLAUDE_HTTP_SERVER_ENABLED
  // 默认 enabled（spec 确认默认 '1'），仅 '0' / 'false' 显式关闭
  if (v === '0' || v === 'false') return false
  return true
}

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

    // 3. 轮询等待 daemon ready
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
```

- [ ] **Step 3.2: Commit**

```bash
git add src/services/httpServer/index.ts
git commit -m "feat(http-server): add ensureHttpServerRunning entry API"
```

---

## Task 4: Create OpenAI Adapter (`src/services/httpServer/adapters/openaiAdapter.ts`)

**Files:**
- Create: `src/services/httpServer/adapters/openaiAdapter.ts`

Converts between OpenAI `/v1/chat/completions` request/response format and Anthropic SDK format.

- [ ] **Step 4.1: Write openaiAdapter.ts**

Create `src/services/httpServer/adapters/openaiAdapter.ts`:
```ts
import { randomUUID } from 'crypto'

// --- OpenAI 类型 ---

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
}

interface OpenAIChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: { role?: string; content?: string }
    finish_reason: string | null
  }>
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// --- 请求转换：OpenAI → Anthropic ---

export function openaiRequestToAnthropic(body: OpenAIChatRequest): {
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  max_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream: boolean
} {
  // 提取 system message
  let system: string | undefined
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const msg of body.messages) {
    if (msg.role === 'system') {
      system = system ? system + '\n' + msg.content : msg.content
    } else {
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
    }
  }

  // Anthropic 要求 messages 以 user 开头，若第一条是 assistant 则补空 user
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '.' })
  }

  // 若 messages 为空（只有 system），补一条 user
  if (messages.length === 0) {
    messages.push({ role: 'user', content: '.' })
  }

  return {
    model: body.model,
    ...(system ? { system } : {}),
    messages,
    max_tokens: body.max_tokens ?? 4096,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    stream: body.stream ?? false,
  }
}

// --- SSE 流转换：Anthropic stream events → OpenAI SSE lines ---

export async function* anthropicStreamToOpenaiSSE(
  stream: AsyncIterable<any>,
  model: string,
): AsyncIterable<string> {
  const requestId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)

  for await (const event of stream) {
    const type = event.type ?? event.event

    if (type === 'message_start') {
      const chunk: OpenAIChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }
      yield `data: ${JSON.stringify(chunk)}\n\n`
    } else if (type === 'content_block_delta') {
      const text = event.delta?.text ?? ''
      if (text) {
        const chunk: OpenAIChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }
        yield `data: ${JSON.stringify(chunk)}\n\n`
      }
    } else if (type === 'message_delta') {
      const stopReason = event.delta?.stop_reason
      if (stopReason) {
        const finishReason = stopReason === 'end_turn' ? 'stop' : stopReason === 'max_tokens' ? 'length' : 'stop'
        const chunk: OpenAIChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        }
        yield `data: ${JSON.stringify(chunk)}\n\n`
      }
    } else if (type === 'message_stop') {
      yield `data: [DONE]\n\n`
    }
  }
}

// --- 非 stream 响应聚合 ---

export async function anthropicStreamToOpenaiJson(
  stream: AsyncIterable<any>,
  model: string,
): Promise<OpenAIChatResponse> {
  const requestId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let content = ''
  let finishReason = 'stop'
  let inputTokens = 0
  let outputTokens = 0

  for await (const event of stream) {
    const type = event.type ?? event.event

    if (type === 'message_start') {
      inputTokens = event.message?.usage?.input_tokens ?? 0
    } else if (type === 'content_block_delta') {
      content += event.delta?.text ?? ''
    } else if (type === 'message_delta') {
      outputTokens = event.usage?.output_tokens ?? 0
      const sr = event.delta?.stop_reason
      if (sr === 'max_tokens') finishReason = 'length'
    }
  }

  return {
    id: requestId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  }
}
```

- [ ] **Step 4.2: Commit**

```bash
git add src/services/httpServer/adapters/openaiAdapter.ts
git commit -m "feat(http-server): add OpenAI-to-Anthropic request/SSE adapter"
```

---

## Task 5: Create Route Handler (`src/services/httpServer/routes.ts`)

**Files:**
- Create: `src/services/httpServer/routes.ts`

Central `fetch` handler for `Bun.serve()`. Routes requests, validates Bearer tokens, dispatches to adapters.

- [ ] **Step 5.1: Write routes.ts**

Create `src/services/httpServer/routes.ts`:
```ts
import { timingSafeEqual } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import {
  type OpenAIChatRequest,
  openaiRequestToAnthropic,
  anthropicStreamToOpenaiSSE,
  anthropicStreamToOpenaiJson,
} from './adapters/openaiAdapter.js'

export interface ServerContext {
  token: string
  port: number
  host: string
  startedAt: number
  version: string
  getClient: () => Promise<Anthropic>
}

// 常量时 token 比较（防 timing attack）
function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function checkAuth(req: Request, ctx: ServerContext): Response | null {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token || !verifyToken(token, ctx.token)) {
    return Response.json(
      { error: { message: 'unauthorized', type: 'invalid_request_error' } },
      { status: 401 },
    )
  }
  return null
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization',
  }
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    ...corsHeaders(),
  }
}

// --- 端点处理器 ---

function handleHealthz(ctx: ServerContext): Response {
  return Response.json({
    ok: true,
    pid: process.pid,
    port: ctx.port,
    host: ctx.host,
    version: ctx.version,
    uptimeMs: Date.now() - ctx.startedAt,
  })
}

function handleModels(ctx: ServerContext): Response {
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
  return Response.json({
    object: 'list',
    data: [
      { id: model, object: 'model', created: Math.floor(ctx.startedAt / 1000), owned_by: 'claude-code-http-server' },
    ],
  })
}

async function handleChatCompletions(req: Request, ctx: ServerContext): Promise<Response> {
  let body: OpenAIChatRequest
  try {
    body = await req.json() as OpenAIChatRequest
  } catch {
    return Response.json(
      { error: { message: 'invalid json body', type: 'invalid_request_error' } },
      { status: 400 },
    )
  }

  const anthropicParams = openaiRequestToAnthropic(body)
  const client = await ctx.getClient()

  try {
    if (body.stream) {
      // SSE 流
      const stream = client.messages.stream(anthropicParams)
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const line of anthropicStreamToOpenaiSSE(stream, anthropicParams.model)) {
              controller.enqueue(new TextEncoder().encode(line))
            }
          } catch (e) {
            const errPayload = `event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`
            controller.enqueue(new TextEncoder().encode(errPayload))
          } finally {
            controller.close()
          }
        },
      })
      return new Response(readable, { headers: sseHeaders() })
    } else {
      // 非 stream：聚合完整响应
      const stream = client.messages.stream(anthropicParams)
      const result = await anthropicStreamToOpenaiJson(stream, anthropicParams.model)
      return Response.json(result, { headers: corsHeaders() })
    }
  } catch (e) {
    logForDebugging(`[http-server] chat/completions upstream error: ${(e as Error).message}`)
    return Response.json(
      { error: { message: (e as Error).message, type: 'upstream_error' } },
      { status: 502, headers: corsHeaders() },
    )
  }
}

async function handleMessages(req: Request, ctx: ServerContext): Promise<Response> {
  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'invalid json body' } },
      { status: 400 },
    )
  }

  const client = await ctx.getClient()

  try {
    if (body.stream) {
      // Anthropic 原生 SSE 透传
      const stream = client.messages.stream(body)
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of stream) {
              const eventType = (event as any).type ?? 'message'
              const line = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`
              controller.enqueue(new TextEncoder().encode(line))
            }
          } catch (e) {
            const errPayload = `event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`
            controller.enqueue(new TextEncoder().encode(errPayload))
          } finally {
            controller.close()
          }
        },
      })
      return new Response(readable, { headers: sseHeaders() })
    } else {
      // 非 stream
      const result = await client.messages.create(body)
      return Response.json(result, { headers: corsHeaders() })
    }
  } catch (e) {
    logForDebugging(`[http-server] messages upstream error: ${(e as Error).message}`)
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: (e as Error).message } },
      { status: 502, headers: corsHeaders() },
    )
  }
}

function handleShutdown(ctx: ServerContext): Response {
  logForDebugging('[http-server] /shutdown called, exiting')
  // 延迟退出以便响应先发出
  setTimeout(() => {
    const { deleteLockfile } = require('./lockfile.js')
    deleteLockfile()
    process.exit(0)
  }, 100)
  return Response.json({ ok: true, message: 'shutting down' })
}

// --- 主路由 ---

export function createFetchHandler(ctx: ServerContext) {
  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // /healthz — 公开，不鉴权
    if (path === '/healthz' && req.method === 'GET') {
      return handleHealthz(ctx)
    }

    // 其余端点一律鉴权
    const authError = checkAuth(req, ctx)
    if (authError) return authError

    // 路由
    if (path === '/v1/models' && req.method === 'GET') {
      return handleModels(ctx)
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') {
      return handleChatCompletions(req, ctx)
    }

    if (path === '/v1/messages' && req.method === 'POST') {
      return handleMessages(req, ctx)
    }

    if (path === '/shutdown' && req.method === 'POST') {
      return handleShutdown(ctx)
    }

    return Response.json(
      { error: { message: 'not found', type: 'invalid_request_error' } },
      { status: 404 },
    )
  }
}
```

- [ ] **Step 5.2: Commit**

```bash
git add src/services/httpServer/routes.ts
git commit -m "feat(http-server): add route handler with OpenAI/Anthropic endpoints"
```

---

## Task 6: Create Worker Entry (`src/services/httpServer/workerEntry.ts`)

**Files:**
- Create: `src/services/httpServer/workerEntry.ts`

This is the daemon process's main function. It starts `Bun.serve`, writes the lockfile, registers cleanup handlers.

- [ ] **Step 6.1: Write workerEntry.ts**

Create `src/services/httpServer/workerEntry.ts`:
```ts
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
```

- [ ] **Step 6.2: Commit**

```bash
git add src/services/httpServer/workerEntry.ts
git commit -m "feat(http-server): add worker entry (Bun.serve daemon process)"
```

---

## Task 7: Wire into main.tsx

**Files:**
- Modify: `src/main.tsx:4577` (insert before `profileCheckpoint('run_before_parse')`)

- [ ] **Step 7.1: Add fire-and-forget ensureHttpServerRunning() call**

In `src/main.tsx`, find the line (around line 4577-4578):
```ts
  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
```

Insert **before** `profileCheckpoint('run_before_parse')`:

```ts
  // HTTP/SSE LLM 服务：自动启动全局 daemon（fire-and-forget，失败静默）
  try {
    const { ensureHttpServerRunning } = await import('./services/httpServer/index.js')
    const httpResult = await ensureHttpServerRunning()
    logForDebugging(`[http-server] ensure result: ${httpResult.status}`)
  } catch (e) {
    logForDebugging(`[http-server] ensure failed: ${(e as Error).message}`)
  }
```

**Note:** `logForDebugging` is already imported at the top of `main.tsx` (confirmed from `client.ts` which imports it from `../../utils/debug.js`; `main.tsx` likely imports it too). If not, add:
```ts
import { logForDebugging } from './utils/debug.js'
```

- [ ] **Step 7.2: Verify import exists**

Check if `logForDebugging` is already imported in `main.tsx`:
```bash
grep -n "logForDebugging" src/main.tsx | head -5
```

If not found, add the import near the top of the file alongside other utility imports.

- [ ] **Step 7.3: Commit**

```bash
git add src/main.tsx
git commit -m "feat(http-server): wire ensureHttpServerRunning into CLI init path"
```

---

## Task 8: End-to-End Smoke Test

**Files:** None (manual testing)

All code is written. Now validate the full flow with real upstream API calls.

- [ ] **Step 8.1: Start CLI and verify daemon spawned**

```bash
bun run dev
```

Wait for REPL to appear. In **another terminal**:

```bash
cat ~/.claude/http-server.json
```

Expected: JSON with `pid`, `port: 6646`, `host: "0.0.0.0"`, `token` (64-char hex), `startedAt`, `version`.

- [ ] **Step 8.2: Test healthz (no auth required)**

```bash
curl -sf localhost:6646/healthz | jq .
```

Expected:
```json
{
  "ok": true,
  "pid": <number>,
  "port": 6646,
  "host": "0.0.0.0",
  "version": "<version>",
  "uptimeMs": <number>
}
```

- [ ] **Step 8.3: Test auth failure**

```bash
curl -i -X POST localhost:6646/v1/messages -H "Content-Type: application/json" -d '{}'
```

Expected: HTTP 401 with `{"error":{"message":"unauthorized",...}}`

- [ ] **Step 8.4: Test OpenAI-compatible SSE stream**

```bash
TOKEN=$(jq -r .token ~/.claude/http-server.json)
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST localhost:6646/v1/chat/completions \
  -d '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"Say hello in one word"}],"stream":true}'
```

Expected: Multiple `data: {...}` lines with `choices[0].delta.content` containing text fragments, ending with `data: [DONE]`.

- [ ] **Step 8.5: Test Anthropic native SSE stream**

```bash
TOKEN=$(jq -r .token ~/.claude/http-server.json)
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST localhost:6646/v1/messages \
  -d '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"Say hello in one word"}],"stream":true,"max_tokens":128}'
```

Expected: Lines with `event: message_start`, `event: content_block_delta` (with text), `event: message_stop`.

- [ ] **Step 8.6: Test idempotent startup (second CLI instance)**

Open a **third terminal** and run:

```bash
bun run dev
```

Check debug logs — should show `[http-server] ensure result: already-running`. The daemon should NOT be re-spawned. Verify by checking PID hasn't changed:

```bash
jq .pid ~/.claude/http-server.json
# Should be the same PID as before
```

- [ ] **Step 8.7: Test daemon survives CLI exit**

Kill the first CLI (Ctrl-C). Then verify daemon still alive:

```bash
curl -sf localhost:6646/healthz | jq .ok
# Expected: true
```

- [ ] **Step 8.8: Test /shutdown**

```bash
TOKEN=$(jq -r .token ~/.claude/http-server.json)
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:6646/shutdown
```

Expected: `{"ok":true,"message":"shutting down"}`, daemon exits, lockfile removed.

```bash
cat ~/.claude/http-server.json 2>&1
# Expected: No such file or directory
curl -sf localhost:6646/healthz
# Expected: Connection refused
```

- [ ] **Step 8.9: Test fresh spawn after shutdown**

```bash
bun run dev
# Daemon should spawn again
curl -sf localhost:6646/healthz | jq .ok
# Expected: true
```

- [ ] **Step 8.10: Test /v1/models**

```bash
TOKEN=$(jq -r .token ~/.claude/http-server.json)
curl -H "Authorization: Bearer $TOKEN" localhost:6646/v1/models | jq .
```

Expected: `{"object":"list","data":[{"id":"MiniMax-M2.7",...}]}`

- [ ] **Step 8.11: Commit (if any fixups were needed)**

```bash
git add -A
git commit -m "fix(http-server): smoke test fixups"
```

Only commit if you made fixes during testing. If everything passed cleanly, skip this step.

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 0 | Pre-implementation probes | None |
| 1 | Worker registry | Task 0 |
| 2 | Lockfile module | None |
| 3 | Entry API (ensureHttpServerRunning) | Task 2 |
| 4 | OpenAI adapter | None |
| 5 | Route handler | Task 4 |
| 6 | Worker entry (Bun.serve daemon) | Tasks 1, 2, 5 |
| 7 | Wire into main.tsx | Tasks 3, 6 |
| 8 | End-to-end smoke test | Task 7 |

**Independent tasks that can run in parallel:** Tasks 2 and 4 are fully independent. Task 1 depends only on Task 0 probe results.
