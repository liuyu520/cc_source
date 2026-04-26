/**
 * AgentScheduler 类型定义
 *
 * 定义 Agent 调度器的核心类型：优先级、配置、槽位句柄、队列条目、
 * 调度器状态、缓存结果。
 */

// Agent 优先级：前台 > 后台 > 推测
export type AgentPriority = 'foreground' | 'background' | 'speculation'

// 优先级数值映射，数值越小优先级越高
export const PRIORITY_ORDER: Record<AgentPriority, number> = {
  foreground: 0,
  background: 1,
  speculation: 2,
}

// 调度器配置
export interface SchedulerConfig {
  maxConcurrent: number                       // 总并发上限，默认 5
  quotas: Record<AgentPriority, number>       // 各优先级独立配额
  cacheTTLMs: number                          // 结果缓存 TTL（毫秒）
  cacheMaxSize: number                        // 缓存最大条目数
}

// 槽位句柄：acquireSlot 返回，持有者在 agent 完成后调用 release()
export interface SlotHandle {
  slotId: string
  priority: AgentPriority
  release: () => void
}

// 队列中等待的 agent 条目
export interface QueuedAgent {
  id: string
  priority: AgentPriority
  resolve: (handle: SlotHandle) => void
  reject: (error: Error) => void
  abortSignal?: AbortSignal
  abortCleanup?: () => void                   // AbortSignal listener 清理函数
  enqueuedAt: number
  /** P5:入队时预估的 input token 数,出队时参与预算检查并扣账;0/undefined 表示未启用 */
  estimatedTokens?: number
}

// 调度器外部可观测状态（用于 AppState / UI 展示）
export interface SchedulerState {
  activeSlots: number
  maxSlots: number
  queueDepth: number
  quotaUsage: Record<AgentPriority, number>
}

// 缓存的 agent 结果
export interface CachedAgentResult {
  hash: string
  result: unknown                             // 缓存的 AgentTool 返回值
  timestamp: number
  hitCount: number
}
