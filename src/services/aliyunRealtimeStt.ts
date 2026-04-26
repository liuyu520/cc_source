import { createHmac, randomBytes, randomUUID } from 'crypto'
import WebSocket from 'ws'
import { logForDebugging } from '../utils/debug.js'
import type {
  RealtimeSttCallbacks,
  RealtimeSttConnection,
  RealtimeSttFinalizeSource,
} from './realtimeStt.js'

type AliyunRealtimeSttOptions = {
  language?: string
  keyterms?: string[]
}

type AliyunRealtimeSttMessage = {
  header?: {
    name?: string
    status?: number
    status_text?: string
    task_id?: string
    message_id?: string
  }
  payload?: {
    result?: string
    sentence?: {
      text?: string
      begin_time?: number
      end_time?: number
    }
    output?: {
      text?: string
    }
  }
}

type AliyunTokenCache = {
  token: string
  expireAt: number
}

const ALIYUN_NLS_URL =
  process.env.ALIYUN_NLS_URL ??
  'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1'
const ALIYUN_TOKEN_ENDPOINT =
  process.env.ALIYUN_NLS_TOKEN_ENDPOINT ??
  'https://nls-meta.cn-shanghai.aliyuncs.com'
const ALIYUN_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const AUDIO_CHUNK_BYTES = 3200
const FINALIZE_TIMEOUT_MS = 5000

let aliyunTokenCache: AliyunTokenCache | null = null
let aliyunTokenPromise: Promise<string | null> | null = null

function getAliyunStaticToken(): string | null {
  const token =
    process.env.ALIYUN_NLS_TOKEN ?? process.env.ALIYUN_TOKEN ?? null
  return token?.trim() || null
}

function getAliyunAccessKeyConfig(): {
  accessKeyId: string
  accessKeySecret: string
  appKey: string
} | null {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID?.trim()
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET?.trim()
  const appKey = process.env.ALIYUN_NLS_APP_KEY?.trim()

  if (!accessKeyId || !accessKeySecret || !appKey) {
    return null
  }

  return {
    accessKeyId,
    accessKeySecret,
    appKey,
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')
}

function buildAliyunRpcQuery(
  params: Record<string, string>,
  accessKeySecret: string,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&')

  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(sorted)}`
  const signature = createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64')

  return `Signature=${percentEncode(signature)}&${sorted}`
}

async function fetchAliyunTokenFromAccessKey(): Promise<string | null> {
  const config = getAliyunAccessKeyConfig()
  if (!config) {
    return null
  }

  const now = Date.now()
  if (
    aliyunTokenCache &&
    aliyunTokenCache.expireAt - ALIYUN_TOKEN_REFRESH_SKEW_MS > now
  ) {
    return aliyunTokenCache.token
  }

  const nonce = randomUUID()
  const timestamp = new Date().toISOString()
  const params: Record<string, string> = {
    AccessKeyId: config.accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: process.env.ALIYUN_REGION_ID ?? 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    Timestamp: timestamp,
    Version: '2019-02-28',
  }

  const query = buildAliyunRpcQuery(params, config.accessKeySecret)
  const url = `${ALIYUN_TOKEN_ENDPOINT}/?${query}`
  logForDebugging(
    `[aliyun-stt] requesting token from ${ALIYUN_TOKEN_ENDPOINT} with region ${params.RegionId}`,
  )
  // 硬超时避免网络栈挂起导致语音激活路径无限阻塞
  // （与 codex/auth.ts OAuth 刷新、codex/adapter.ts 请求超时同模式）
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Aliyun token request failed with status ${String(response.status)}${body ? `: ${body.slice(0, 300)}` : ''}`,
    )
  }

  const data = (await response.json()) as {
    Token?: {
      Id?: string
      ExpireTime?: number | string
    }
  }

  const token = data?.Token?.Id?.trim()
  if (!token) {
    throw new Error('Aliyun token response did not contain Token.Id')
  }

  const expireTimeRaw = data?.Token?.ExpireTime
  const expireTimeSeconds =
    typeof expireTimeRaw === 'number'
      ? expireTimeRaw
      : Number(expireTimeRaw ?? 0)
  const expireAt =
    expireTimeSeconds > 0 ? expireTimeSeconds * 1000 : now + 10 * 60 * 1000

  aliyunTokenCache = {
    token,
    expireAt,
  }

  logForDebugging(
    `[aliyun-stt] token acquired, expires at ${new Date(expireAt).toISOString()}`,
  )

  return token
}

async function getAliyunToken(): Promise<string | null> {
  const staticToken = getAliyunStaticToken()
  if (staticToken) {
    return staticToken
  }

  if (!getAliyunAccessKeyConfig()) {
    return null
  }

  if (!aliyunTokenPromise) {
    aliyunTokenPromise = fetchAliyunTokenFromAccessKey().finally(() => {
      aliyunTokenPromise = null
    })
  }

  return await aliyunTokenPromise
}

export function isAliyunRealtimeSttAvailable(): boolean {
  return Boolean(getAliyunStaticToken() || getAliyunAccessKeyConfig())
}

export function getAliyunRealtimeSttUnavailableReason(): string {
  return 'Voice mode requires ALIYUN_NLS_TOKEN, or ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET + ALIYUN_NLS_APP_KEY.'
}

function createAliyunMessageId(): string {
  return randomBytes(16).toString('hex')
}

function buildStartMessage(options?: AliyunRealtimeSttOptions): string {
  const appKey = process.env.ALIYUN_NLS_APP_KEY
  const format = process.env.ALIYUN_NLS_FORMAT ?? 'pcm'
  const sampleRate = Number(process.env.ALIYUN_NLS_SAMPLE_RATE ?? '16000')
  const language = options?.language || process.env.ALIYUN_NLS_LANGUAGE || 'zh'
  const vocabularyId = process.env.ALIYUN_NLS_VOCABULARY_ID

  const payload: Record<string, unknown> = {
    format,
    sample_rate: sampleRate,
    enable_intermediate_result: true,
    enable_punctuation_prediction: true,
    enable_inverse_text_normalization: true,
    language,
  }

  if (appKey) {
    payload.app_key = appKey
  }
  if (vocabularyId) {
    payload.vocabulary_id = vocabularyId
  }
  if (options?.keyterms?.length) {
    payload.vocabulary = options.keyterms.slice(0, 50)
  }

  return JSON.stringify({
    header: {
      message_id: createAliyunMessageId(),
      task_id: createAliyunMessageId(),
      namespace: 'SpeechTranscriber',
      name: 'StartTranscription',
      appkey: appKey,
    },
    payload,
  })
}

function buildStopMessage(taskId: string | null): string {
  const appKey = process.env.ALIYUN_NLS_APP_KEY

  return JSON.stringify({
    header: {
      message_id: createAliyunMessageId(),
      task_id: taskId,
      name: 'StopTranscription',
      namespace: 'SpeechTranscriber',
      appkey: appKey,
    },
    payload: {
      app_key: appKey,
    },
  })
}

function extractTranscript(message: AliyunRealtimeSttMessage): {
  text: string
  isFinal: boolean
} | null {
  const name = message.header?.name ?? ''
  const text =
    message.payload?.result?.trim() ||
    message.payload?.output?.text?.trim() ||
    message.payload?.sentence?.text?.trim() ||
    ''

  if (!text) return null

  if (
    name === 'TranscriptionResultChanged' ||
    name === 'SentenceBegin' ||
    name === 'SentenceEnd'
  ) {
    return {
      text,
      isFinal: name === 'SentenceEnd',
    }
  }

  if (name === 'TranscriptionStarted') {
    return null
  }

  return {
    text,
    isFinal: false,
  }
}

export async function connectAliyunRealtimeStt(
  callbacks: RealtimeSttCallbacks,
  options?: AliyunRealtimeSttOptions,
): Promise<RealtimeSttConnection | null> {
  let token: string | null = null
  try {
    token = await getAliyunToken()
  } catch (error) {
    callbacks.onError(
      error instanceof Error ? error.message : 'Failed to fetch Aliyun NLS token.',
      { fatal: true },
    )
    return null
  }

  if (!token) {
    callbacks.onError(getAliyunRealtimeSttUnavailableReason(), { fatal: true })
    return null
  }

  return await new Promise(resolve => {
    let ws: WebSocket | null = null
    let connected = false
    let closed = false
    let finalized = false
    let currentTaskId: string | null = null
    let finalizeResolve: ((value: RealtimeSttFinalizeSource | undefined) => void) | null = null
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null
    let audioBuffer = Buffer.alloc(0)

    const cleanupFinalizeTimer = (): void => {
      if (finalizeTimer) {
        clearTimeout(finalizeTimer)
        finalizeTimer = null
      }
    }

    const finishFinalize = (source: RealtimeSttFinalizeSource | undefined): void => {
      cleanupFinalizeTimer()
      if (finalizeResolve) {
        const resolveFn = finalizeResolve
        finalizeResolve = null
        resolveFn(source)
      }
    }

    const flushAudioBuffer = (): void => {
      if (!ws || ws.readyState !== WebSocket.OPEN || audioBuffer.length === 0) {
        return
      }
      ws.send(audioBuffer)
      audioBuffer = Buffer.alloc(0)
    }

    const connection: RealtimeSttConnection = {
      send(chunk: Buffer): void {
        if (closed || finalized || !chunk.length) {
          return
        }
        const nextBuffer = Buffer.concat([audioBuffer, chunk])
        if (nextBuffer.length < AUDIO_CHUNK_BYTES) {
          audioBuffer = nextBuffer
          return
        }
        let offset = 0
        while (offset + AUDIO_CHUNK_BYTES <= nextBuffer.length) {
          const piece = nextBuffer.subarray(offset, offset + AUDIO_CHUNK_BYTES)
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(piece)
          }
          offset += AUDIO_CHUNK_BYTES
        }
        audioBuffer = nextBuffer.subarray(offset)
      },
      async finalize(): Promise<RealtimeSttFinalizeSource | undefined> {
        if (closed) {
          return undefined
        }
        if (finalized) {
          return new Promise(resolve => resolve(undefined))
        }
        finalized = true
        flushAudioBuffer()
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(buildStopMessage(currentTaskId))
        }
        return await new Promise(resolve => {
          finalizeResolve = resolve
          finalizeTimer = setTimeout(() => {
            finishFinalize('no_data_timeout')
          }, FINALIZE_TIMEOUT_MS)
        })
      },
      close(): void {
        if (closed) return
        closed = true
        cleanupFinalizeTimer()
        finishFinalize(undefined)
        ws?.close()
        callbacks.onClose()
      },
      isConnected(): boolean {
        return connected && ws?.readyState === WebSocket.OPEN
      },
    }

    logForDebugging(
      `[aliyun-stt] opening websocket ${ALIYUN_NLS_URL} language=${options?.language || process.env.ALIYUN_NLS_LANGUAGE || 'zh'}`,
    )
    ws = new WebSocket(ALIYUN_NLS_URL, {
      headers: {
        'X-NLS-Token': token,
      },
    })

    ws.on('open', () => {
      connected = true
      logForDebugging('[aliyun-stt] websocket opened, sending StartTranscription')
      ws?.send(buildStartMessage(options))
      callbacks.onReady(connection)
      resolve(connection)
    })

    ws.on('message', raw => {
      let message: AliyunRealtimeSttMessage | null = null
      try {
        message = JSON.parse(raw.toString()) as AliyunRealtimeSttMessage
      } catch {
        return
      }

      currentTaskId = message.header?.task_id ?? currentTaskId

      const status = message.header?.status
      if (typeof status === 'number' && status >= 40000000) {
        logForDebugging(
          `[aliyun-stt] server error name=${message.header?.name || 'unknown'} status=${String(status)} text=${message.header?.status_text || ''}`,
        )
        callbacks.onError(
          message.header?.status_text || 'Aliyun realtime STT failed.',
          { fatal: true },
        )
        connection.close()
        return
      }

      const transcript = extractTranscript(message)
      if (transcript) {
        callbacks.onTranscript(transcript.text, transcript.isFinal)
      }

      if (message.header?.name === 'TranscriptionCompleted') {
        logForDebugging('[aliyun-stt] transcription completed')
        finishFinalize('explicit')
      }
    })

    ws.on('error', error => {
      logForDebugging(
        `[aliyun-stt] websocket error: ${error.message || 'unknown error'}`,
      )
      callbacks.onError(error.message || 'Aliyun realtime STT socket error.')
      if (!closed) {
        closed = true
        cleanupFinalizeTimer()
        finishFinalize(undefined)
        callbacks.onClose()
      }
      resolve(null)
    })

    ws.on('close', (code, reason) => {
      logForDebugging(
        `[aliyun-stt] websocket closed code=${String(code)} reason=${reason.toString()}`,
      )
      if (!closed) {
        closed = true
        cleanupFinalizeTimer()
        finishFinalize(finalized ? 'explicit' : undefined)
        callbacks.onClose()
      }
    })
  })
}
