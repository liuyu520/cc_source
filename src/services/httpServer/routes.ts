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

function handleShutdown(): Response {
  logForDebugging('[http-server] /shutdown called, exiting')
  setTimeout(async () => {
    const { deleteLockfile } = await import('./lockfile.js')
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
      return handleShutdown()
    }

    return Response.json(
      { error: { message: 'not found', type: 'invalid_request_error' } },
      { status: 404 },
    )
  }
}
