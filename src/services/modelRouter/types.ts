/**
 * Model Router / Provider Gateway — 类型定义
 *
 * Model Router 是在 ProviderRegistry（services/providers/）之上的智能路由层：
 * 负责按能力、健康、成本、优先级在多 provider 之间做决策与降级。
 *
 * 关系图：
 *   user request
 *      │
 *      ▼
 *   getAnthropicClient()
 *      │
 *      ├── ProviderRegistry (P0-2, 已有)  ← 做类型分派 (firstParty/bedrock/...)
 *      │
 *      └── ModelRouter       (P1, 本文件)  ← 在 provider 群体内做智能选型
 */

export type ProviderCapability =
  | 'chat'
  | 'tool_use'
  | 'vision'
  | 'cache'
  | 'streaming'
  | 'extended_thinking'

export type ProviderTier = 'haiku' | 'sonnet' | 'opus' | 'unknown'

export type RouteIntent =
  | 'latency'
  | 'balanced'
  | 'quality'
  | 'reliability'

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'hard'

export type RouteRcaPhase =
  | 'idle'
  | 'hypothesis_gen'
  | 'evidence_gather'
  | 'converging'

export interface RouteIntentResult {
  class: RouteIntent
  confidence: number
  evidence: string[]
}

/** 单个 provider 的静态配置 */
export interface ProviderConfig {
  /** 唯一名字，如 'minimax' / 'anthropic' / 'bedrock' */
  name: string
  /** base URL；用于覆盖 ANTHROPIC_BASE_URL（enforce 模式下） */
  endpoint: string
  /** 该 provider 上的默认模型名 */
  model: string
  /** 读取 API key 的环境变量名 */
  apiKeyEnv?: string
  /** 能力清单 */
  capabilities: ProviderCapability[]
  /** 每百万 input token 的价格（USD），用于成本追踪 */
  pricePerMToken?: number
  /** RPM 限流上限 */
  maxRpm?: number
  /** 优先级：越小越优先 */
  priority: number
  /** 可选：显式声明 tier；未填时由 model 名推断 */
  tier?: ProviderTier
}

/** provider 运行时健康状态 */
export interface ProviderHealth {
  name: string
  state: 'healthy' | 'degraded' | 'down'
  p99LatencyMs: number
  /** 0.0 - 1.0 滚动窗口错误率 */
  errorRate: number
  lastSuccessAt?: string
  lastFailureAt?: string
  consecutiveFailures: number
}

/** 一次路由决策的结果 */
export interface RouteDecision {
  provider: ProviderConfig
  /** 人类可读的决策原因 */
  reason: string
  /** 若 provider 失败后的降级链（按顺序尝试） */
  fallbackChain: string[]
  /** 命中的 staircase 档位；0=首档，越大代表兜底越深 */
  fallbackRank: number
  /** 路由入口的意图分类结果 */
  intent: RouteIntentResult
  /** 参与排序的候选分数（按最终排序顺序） */
  candidateScores: Array<{ provider: string; score: number }>
  /** true = 决策仅记录到 ledger，不实际改变路由 */
  shadow: boolean
}

/** 路由埋点数据 */
export interface RouterTelemetry {
  decision: RouteDecision
  /** 实际被使用的 provider 名 */
  actualProvider: string
  latencyMs: number
  success: boolean
  tokensUsed: number
  costEstimate: number
}

import type { ExecutionModeDecision } from '../executionMode/types.js'

/** decide() 的输入 */
export interface RouteContext {
  /** 任务类型提示，如 'code' / 'summary' / 'vision' */
  taskType?: string
  /** 原始请求文本（若调用方能提供，优先用于 intent-classify） */
  requestText?: string
  /** 必需的能力 */
  requiredCapabilities?: ProviderCapability[]
  /** 期望的模型名（如果调用方有偏好） */
  preferredModel?: string
  /** 路由意图提示（可选） */
  intentHint?: RouteIntent
  /** 任务复杂度 */
  taskComplexity?: TaskComplexity
  /** 预估工具调用次数 */
  estimatedToolCallCount?: number
  /** RCA 当前阶段 */
  rcaPhase?: RouteRcaPhase
  /** RCA 收敛度 0..1 */
  rcaConvergenceScore?: number
  /** 会话已花费成本（USD） */
  sessionCostUsd?: number
  /** 剩余预算（USD） */
  remainingBudgetUsd?: number
  /** 统一执行模式裁决结果（若上游已生成，优先复用） */
  executionModeDecision?: ExecutionModeDecision
}
