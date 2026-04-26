/**
 * Codex 认证模块 — 读取 ~/.codex/auth.json 获取 API 凭证
 *
 * 支持两种认证模式：
 * 1. apiKey — 直接使用 OPENAI_API_KEY 字段
 * 2. chatgpt — 使用 OAuth tokens（access_token JWT），支持自动刷新
 *
 * 凭证优先级：
 *   CODEX_API_KEY env > OPENAI_API_KEY env > ~/.codex/auth.json > provider env_key
 *
 * OAuth 刷新策略（Phase 3 增强）：
 *   - Promise dedup 防止并发刷新竞态
 *   - 指数退避: 1s → 2s → 4s → max 30s
 *   - 随机抖动: 0-25% 避免惊群
 *   - 最大重试: 3 次后停止，上报错误
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CODEX_DEFAULT_MODEL } from './models.js'

// ==================== 类型 ====================

interface CodexAuthJson {
  auth_mode?: 'apiKey' | 'chatgpt' | 'chatgptAuthTokens'
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id?: string
  } | null
  last_refresh?: string | null
}

interface CodexConfigToml {
  model?: string
  model_reasoning_effort?: CodexReasoningEffort
  model_provider?: string
  openai_base_url?: string
  chatgpt_base_url?: string
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface CodexCredentials {
  token: string
  tokenType: 'api_key' | 'oauth_access_token'
  accountId?: string
  refreshToken?: string
  expiresAt?: number // Unix timestamp in seconds
}

export interface CodexConfig {
  model?: string
  reasoningEffort?: CodexReasoningEffort
  baseUrl?: string
  chatgptBaseUrl?: string
}

// ==================== 路径常量 ====================

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')
const AUTH_JSON_PATH = join(CODEX_HOME, 'auth.json')
const CONFIG_TOML_PATH = join(CODEX_HOME, 'config.toml')

// OpenAI OAuth token refresh endpoint
const TOKEN_REFRESH_URL = 'https://auth.openai.com/oauth/token'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

// ==================== JWT 解析 ====================

/** 从 JWT 中提取过期时间（不验证签名） */
function parseJwtExpiration(jwt: string): number | undefined {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return undefined
    // base64url -> base64 -> JSON
    const payload = parts[1]!
      .replace(/-/g, '+')
      .replace(/_/g, '/')
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    const claims = JSON.parse(decoded)
    return typeof claims.exp === 'number' ? claims.exp : undefined
  } catch {
    return undefined
  }
}

// ==================== Token 管理 ====================

// 内存中缓存的 token，避免每次请求都读文件
let cachedCredentials: CodexCredentials | null = null
let lastAuthFileReadTime = 0
const AUTH_FILE_CACHE_TTL_MS = 30_000 // 30秒重新检查文件

/**
 * 加载 Codex 认证凭证
 *
 * 优先级：
 * 1. CODEX_API_KEY 环境变量
 * 2. OPENAI_API_KEY 环境变量
 * 3. ~/.codex/auth.json 文件
 */
export async function loadCodexCredentials(): Promise<CodexCredentials | null> {
  // 优先级1: 环境变量
  const envKey = process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY
  if (envKey) {
    return {
      token: envKey,
      tokenType: 'api_key',
    }
  }

  // 优先级2: 使用缓存（如果未过期）
  const now = Date.now()
  if (cachedCredentials && (now - lastAuthFileReadTime) < AUTH_FILE_CACHE_TTL_MS) {
    // 检查 OAuth token 是否即将过期
    if (cachedCredentials.tokenType === 'oauth_access_token' && cachedCredentials.expiresAt) {
      const nowSec = Math.floor(now / 1000)
      // 提前60秒刷新，使用 Promise dedup 防止并发刷新竞态
      if (nowSec >= cachedCredentials.expiresAt - 60) {
        const refreshed = await refreshOAuthTokenOnce(cachedCredentials)
        if (refreshed) {
          cachedCredentials = refreshed
          return refreshed
        }
      }
    }
    return cachedCredentials
  }

  // 优先级3: 读取 auth.json
  if (!existsSync(AUTH_JSON_PATH)) {
    return null
  }

  try {
    const raw = readFileSync(AUTH_JSON_PATH, 'utf-8')
    const auth: CodexAuthJson = JSON.parse(raw)

    if (auth.auth_mode === 'apiKey' && auth.OPENAI_API_KEY) {
      cachedCredentials = {
        token: auth.OPENAI_API_KEY,
        tokenType: 'api_key',
      }
    } else if (
      (auth.auth_mode === 'chatgpt' || auth.auth_mode === 'chatgptAuthTokens') &&
      auth.tokens?.access_token
    ) {
      const expiresAt = parseJwtExpiration(auth.tokens.access_token)
      cachedCredentials = {
        token: auth.tokens.access_token,
        tokenType: 'oauth_access_token',
        accountId: auth.tokens.account_id,
        refreshToken: auth.tokens.refresh_token,
        expiresAt,
      }

      // 如果 access_token 已过期，立即尝试刷新
      if (expiresAt) {
        const nowSec = Math.floor(now / 1000)
        if (nowSec >= expiresAt - 60 && auth.tokens.refresh_token) {
          const refreshed = await refreshOAuthToken(cachedCredentials)
          if (refreshed) {
            cachedCredentials = refreshed
          }
        }
      }
    } else {
      return null
    }

    lastAuthFileReadTime = now
    return cachedCredentials
  } catch (err) {
    console.error('[codex-auth] Failed to read auth.json:', (err as Error).message)
    return null
  }
}

/**
 * Promise dedup 包装：防止并发 OAuth 刷新竞态（多个请求同时触发 refresh 时只执行一次）
 */
let pendingRefreshPromise: Promise<CodexCredentials | null> | null = null

async function refreshOAuthTokenOnce(
  creds: CodexCredentials,
): Promise<CodexCredentials | null> {
  if (pendingRefreshPromise) return pendingRefreshPromise
  pendingRefreshPromise = refreshOAuthToken(creds).finally(() => {
    pendingRefreshPromise = null
  })
  return pendingRefreshPromise
}

/**
 * 刷新 OAuth access_token（带指数退避和最大重试）
 *
 * 使用 refresh_token 向 OpenAI auth server 请求新 token。
 * 只在内存中缓存，不写回 auth.json（避免与 Codex CLI 竞争写入）。
 *
 * 退避策略：1s → 2s → 4s（最大 30s），带 0-25% 随机抖动
 * 最大重试：3 次后放弃
 */
const MAX_REFRESH_RETRIES = 3
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const JITTER_FACTOR = 0.25
// 单次 fetch 硬超时：复用 AbortSignal.timeout 模式（见 main.tsx 的
// countFilesRoundedRg / bootstrap.ts 的 axios timeout），避免网络栈挂起
// 时 OAuth 刷新无界阻塞启动/首次请求路径。
const REFRESH_FETCH_TIMEOUT_MS = 10_000

async function refreshOAuthToken(
  creds: CodexCredentials,
): Promise<CodexCredentials | null> {
  if (!creds.refreshToken) return null

  for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
    try {
      const response = await fetch(TOKEN_REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(REFRESH_FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        // 4xx 错误不重试（凭证无效）
        if (response.status >= 400 && response.status < 500) {
          console.error(`[codex-auth] Token refresh failed with ${response.status}, not retrying`)
          return null
        }
        // 5xx 错误走退避重试
        if (attempt < MAX_REFRESH_RETRIES - 1) {
          const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)
          const jitter = backoff * JITTER_FACTOR * Math.random()
          console.warn(`[codex-auth] Token refresh failed (${response.status}), retry ${attempt + 1}/${MAX_REFRESH_RETRIES} in ${Math.round(backoff + jitter)}ms`)
          await new Promise(r => setTimeout(r, backoff + jitter))
          continue
        }
        console.error(`[codex-auth] Token refresh failed after ${MAX_REFRESH_RETRIES} attempts`)
        return null
      }

      const data = await response.json() as {
        access_token?: string
        refresh_token?: string
      }

      if (!data.access_token) {
        console.error('[codex-auth] Token refresh: no access_token in response')
        return null
      }

      const expiresAt = parseJwtExpiration(data.access_token)
      return {
        token: data.access_token,
        tokenType: 'oauth_access_token',
        accountId: creds.accountId,
        refreshToken: data.refresh_token ?? creds.refreshToken,
        expiresAt,
      }
    } catch (err) {
      if (attempt < MAX_REFRESH_RETRIES - 1) {
        const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS)
        const jitter = backoff * JITTER_FACTOR * Math.random()
        console.warn(`[codex-auth] Token refresh error, retry ${attempt + 1}/${MAX_REFRESH_RETRIES} in ${Math.round(backoff + jitter)}ms:`, (err as Error).message)
        await new Promise(r => setTimeout(r, backoff + jitter))
        continue
      }
      console.error('[codex-auth] Token refresh error after all retries:', (err as Error).message)
      return null
    }
  }

  return null
}

/**
 * 加载 Codex 配置（~/.codex/config.toml）
 *
 * 增强版 TOML 解析器（Phase 3），支持：
 * - 双引号值: key = "value"
 * - 单引号值: key = 'value'
 * - 无引号值: key = value
 * - [section] 表头（跳过）
 * - # 注释行
 * 不引入完整的 TOML 解析器，减少依赖。
 */
export function loadCodexConfig(): CodexConfig | null {
  if (!existsSync(CONFIG_TOML_PATH)) {
    return null
  }

  try {
    const raw = readFileSync(CONFIG_TOML_PATH, 'utf-8')
    const config: CodexConfig = {}

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue

      // 匹配: key = "value" 或 key = 'value' 或 key = value
      const match = trimmed.match(/^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/)
      if (!match) continue

      const key = match[1]
      const value = match[2] ?? match[3] ?? match[4] // 双引号 > 单引号 > 无引号
      if (value === undefined) continue

      switch (key) {
        case 'model':
          config.model = value
          break
        case 'model_reasoning_effort':
          if (isCodexReasoningEffort(value)) {
            config.reasoningEffort = value
          }
          break
        case 'model_provider':
          // 记录但不直接使用（可用于未来的 provider 自动选择）
          break
        case 'openai_base_url':
          config.baseUrl = value
          break
        case 'chatgpt_base_url':
          config.chatgptBaseUrl = value
          break
      }
    }

    return config
  } catch (err) {
    console.error('[codex-auth] Failed to read config.toml:', (err as Error).message)
    return null
  }
}

export function getCodexConfiguredModel(): string {
  return loadCodexConfig()?.model ?? process.env.ANTHROPIC_MODEL ?? CODEX_DEFAULT_MODEL
}

export function getCodexConfiguredReasoningEffort(): CodexReasoningEffort | undefined {
  return loadCodexConfig()?.reasoningEffort
}

export function saveCodexModelSelection(update: {
  model: string
  reasoningEffort?: CodexReasoningEffort
}): void {
  const existing = existsSync(CONFIG_TOML_PATH)
    ? readFileSync(CONFIG_TOML_PATH, 'utf-8')
    : ''
  let next = upsertTopLevelTomlString(existing, 'model', update.model)
  if (update.reasoningEffort !== undefined) {
    next = upsertTopLevelTomlString(
      next,
      'model_reasoning_effort',
      update.reasoningEffort,
    )
  }
  mkdirSync(dirname(CONFIG_TOML_PATH), { recursive: true })
  writeFileSync(CONFIG_TOML_PATH, next, 'utf-8')
  clearResolvedCodexModelCache()
}

export function clearResolvedCodexModelCache(): void {
  cachedResolvedModel = null
  lastResolvedModelAt = 0
}

function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}

function upsertTopLevelTomlString(raw: string, key: string, value: string): string {
  const lines = raw.length > 0 ? raw.split('\n') : []
  const keyPattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`)
  let firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line))
  if (firstSectionIndex === -1) firstSectionIndex = lines.length

  for (let i = 0; i < firstSectionIndex; i++) {
    const match = lines[i]?.match(keyPattern)
    if (match) {
      lines[i] = `${match[1] ?? ''}${key} = ${tomlString(value)}`
      return ensureTrailingNewline(lines.join('\n'))
    }
  }

  lines.splice(firstSectionIndex, 0, `${key} = ${tomlString(value)}`)
  return ensureTrailingNewline(lines.join('\n'))
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 获取用于 API 请求的 Authorization header 值
 */
export async function getAuthorizationHeader(): Promise<string | null> {
  const creds = await loadCodexCredentials()
  if (!creds) return null
  return `Bearer ${creds.token}`
}

/**
 * 获取 ChatGPT Account ID header（仅 OAuth 模式需要）
 */
export async function getAccountIdHeader(): Promise<string | undefined> {
  const creds = await loadCodexCredentials()
  if (!creds || creds.tokenType !== 'oauth_access_token') return undefined
  return creds.accountId
}

/** 清除缓存的凭证（测试或重新登录时使用） */
export function clearCredentialsCache(): void {
  cachedCredentials = null
  lastAuthFileReadTime = 0
  // 模型解析缓存与凭证绑定：凭证刷新/重登时同步失效，避免残留过期的模型名。
  clearResolvedCodexModelCache()
}

// ==================== 模型解析（单真相源） ====================
//
// Codex 真实请求模型的解析逻辑集中在此。此前 index.ts（执行层）与 prompts.ts
// （展示层）各自内联相同分支（OAuth/API Key），导致两份 if-else 很容易漂移
// （曾出现展示层写 'gpt-4o' 而执行层默认 'openai/gpt-5.4' 的不一致）。
//
// 复用本文件已有的 `cachedCredentials` 缓存风格（模块级 + TTL + clear 清理）：
// - 展示/执行两条路径从同一函数读取，天然对齐
// - 无参调用走缓存（展示层高频）；带 optsModel 不缓存（执行层单次 override）
// - clearCredentialsCache() 连带清理，登出/重登后首次调用自动重新解析
//
// OAuth 模式故意忽略 optsModel：主循环传入的 claude-* 模型名不适用于 OpenAI API
// （与 index.ts:99-101 行为严格一致，不得在此函数内偏离）。

let cachedResolvedModel: string | null = null
let lastResolvedModelAt = 0
const RESOLVED_MODEL_CACHE_TTL_MS = 30_000

/**
 * 解析当前 Codex 场景下的真实模型名。
 *
 * 优先级严格对齐 index.ts 的 createClient：
 * - OAuth: config.model > ANTHROPIC_MODEL env > CODEX_DEFAULT_MODEL
 * - API Key: optsModel > ANTHROPIC_MODEL env > config.model > 'gpt-4o'
 *
 * 调用端：
 * - 执行层 codex/index.ts createClient()：传 opts.model（可能从主循环带入）
 * - 展示层 constants/prompts.ts getCodexModelDescription()：不传，走缓存
 */
export async function resolveCodexModel(optsModel?: string): Promise<string> {
  // 执行层 override：不走缓存，且不回写缓存（该值只对单次调用有效）
  if (optsModel) {
    const creds = await loadCodexCredentials()
    const cfg = loadCodexConfig()
    const isOAuth = creds?.tokenType === 'oauth_access_token'
    return isOAuth
      ? (cfg?.model ?? process.env.ANTHROPIC_MODEL ?? CODEX_DEFAULT_MODEL)
      : (optsModel ?? process.env.ANTHROPIC_MODEL ?? cfg?.model ?? 'gpt-4o')
  }

  const now = Date.now()
  if (cachedResolvedModel && now - lastResolvedModelAt < RESOLVED_MODEL_CACHE_TTL_MS) {
    return cachedResolvedModel
  }

  const creds = await loadCodexCredentials()
  const cfg = loadCodexConfig()
  const isOAuth = creds?.tokenType === 'oauth_access_token'
  const resolved = isOAuth
    ? (cfg?.model ?? process.env.ANTHROPIC_MODEL ?? CODEX_DEFAULT_MODEL)
    : (process.env.ANTHROPIC_MODEL ?? cfg?.model ?? 'gpt-4o')

  cachedResolvedModel = resolved
  lastResolvedModelAt = now
  return resolved
}
