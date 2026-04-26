/**
 * P0-2 Provider 插件化 — 核心类型定义
 *
 * 把原本散落在 services/api/client.ts 和 utils/model/providers.ts 的
 * provider 判定、client 构造、能力表、错误翻译集中到一个接口后面。
 *
 * 目标：每新增一种第三方 LLM（MiniMax/DeepSeek/Qwen/...）只需新增一个
 * impls/*.ts 文件并注册，无需改动多个散点。
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { ClientOptions } from '@anthropic-ai/sdk'
import type { ProviderCapabilities } from './providerCapabilities.js'

export type ProviderId =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'codex'
  | 'thirdParty'
  | string // 保留后门，允许未来自定义 provider

/** Provider 能力描述 — 由 capabilityCache 缓存 */
export interface Capabilities {
  maxContextTokens: number
  supportsToolUse: boolean
  supportsPromptCache: boolean
  supportsStreaming: boolean
  supportsVision: boolean
  supportsThinking: boolean
}

/** 归一化的标准错误码 — 供 withRetry 决策 */
export type StandardErrorCode =
  | 'auth' // 401/403
  | 'rate_limit' // 429
  | 'overloaded' // 529
  | 'server' // 5xx
  | 'network' // 连接错误
  | 'quota_exceeded' // 用量超限 / 余额不足
  | 'context_length' // 超上下文
  | 'bad_request' // 4xx 其他

export class StandardApiError extends Error {
  constructor(
    public readonly code: StandardErrorCode,
    public readonly retryable: boolean,
    public readonly providerId: ProviderId,
    public readonly original: unknown,
    message?: string,
  ) {
    super(message ?? `[${providerId}] ${code}`)
    this.name = 'StandardApiError'
  }
}

export interface CreateClientOpts {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
  /**
   * 内部旁路标记：当 getAnthropicClient() 因 ProviderRegistry 而调用
   * provider.createClient() 时，provider 实现会再回调 getAnthropicClient
   * 走既有构造逻辑，此时必须带上该标记以避免无限递归。
   * 不应由业务代码设置。
   */
  _bypassRegistry?: boolean
}

export interface LLMProvider {
  readonly id: ProviderId

  /**
   * 该 provider 是否适配当前环境。
   * detect 优先级由 ProviderRegistry 的注册顺序决定：
   *   Bedrock > Vertex > Foundry > Codex > thirdParty > firstParty
   */
  detect(): boolean

  /** 创建底层 Anthropic-like client */
  createClient(opts: CreateClientOpts): Promise<Anthropic>

  /** 探测能力（可走缓存），返回统一的 ProviderCapabilities 子集 */
  probeCapabilities(model: string): Promise<Partial<ProviderCapabilities>>

  /** 把该 provider 家的错误翻译为 StandardApiError */
  translateError(err: unknown): StandardApiError

  /** 可选：认证刷新（OAuth/AWS/GCP/Azure） */
  refreshAuth?(): Promise<void>

  /**
   * 可选：同步声明 provider 能力（作为权威来源）
   * 用于 resolveCapabilities() Layer 4.5，优先级高于磁盘缓存和域名预设。
   * Provider 自己最清楚自己支持什么，消费方必须尊重声明。
   */
  capabilityDeclaration?: Partial<ProviderCapabilities>
}
