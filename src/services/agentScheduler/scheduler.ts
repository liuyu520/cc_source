/**
 * Agent 调度器核心模块
 *
 * 实现全局并发池、优先级队列、配额隔离。
 * 复用 createSignal 进行状态变更通知。
 *
 * 设计：
 * - 模块级单例，无需实例化
 * - acquireSlot() 返回 Promise<SlotHandle>，有空槽立即 resolve，否则入队等待
 * - release() 释放槽位后自动检查队列，出队下一个等待者
 * - AbortSignal 监听：agent 被取消时自动从队列移除并 reject
 * - 优先级：foreground(0) > background(1) > speculation(2)，同级 FIFO
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { createSignal } from '../../utils/signal.js'
import { getAgentStats } from './agentStats.js'
import { updateCacheConfig } from './cache.js'
import { canCharge, charge, resetTokenBudget } from './tokenBudget.js'
import type {
  AgentPriority,
  QueuedAgent,
  SchedulerConfig,
  SchedulerState,
  SlotHandle,
} from './types.js'
import { PRIORITY_ORDER } from './types.js'

// ── 默认配置 ──────────────────────────────────────────────

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrent: parseInt(process.env.CLAUDE_CODE_MAX_AGENT_CONCURRENCY || '', 10) || 5,
  quotas: { foreground: 3, background: 2, speculation: 1 },
  cacheTTLMs: 5 * 60 * 1000,
  cacheMaxSize: 50,
}

// ── 模块级状态 ─────────────────────────────────────────────

// 当前配置（可热更新）
let config: SchedulerConfig = { ...DEFAULT_CONFIG }

// 活跃槽位：slotId → SlotHandle
const activeSlots = new Map<string, SlotHandle>()

// 各优先级当前占用数
const quotaUsage: Record<AgentPriority, number> = {
  foreground: 0,
  background: 0,
  speculation: 0,
}

// 等待队列（按优先级排序插入）
const queue: QueuedAgent[] = []

// 自增 ID 生成器
let nextSlotId = 1

// 状态变更信号 — UI 组件可订阅
const stateChanged = createSignal()

// ── 内部辅助 ──────────────────────────────────────────────

/**
 * 检查指定优先级是否可以获得槽位
 * 条件:总并发未满 + 该优先级配额未满 +(若提供 estimatedTokens)token 预算未超
 *
 * P5:estimatedTokens 默认 0 → 不做 token 检查(向后兼容原行为)。
 * 未配置 CLAUDE_CODE_MAX_TOKENS_PER_MINUTE 时 canCharge 恒 true,零开销。
 */
function canAcquire(
  priority: AgentPriority,
  estimatedTokens = 0,
): boolean {
  return (
    activeSlots.size < config.maxConcurrent &&
    quotaUsage[priority] < config.quotas[priority] &&
    canCharge(estimatedTokens)
  )
}

/**
 * 创建一个 SlotHandle 并注册到活跃 Map
 */
function createSlotHandle(agentId: string, priority: AgentPriority): SlotHandle {
  const slotId = `slot_${nextSlotId++}`
  let released = false

  const handle: SlotHandle = {
    slotId,
    priority,
    release() {
      if (released) return // 幂等
      released = true
      activeSlots.delete(slotId)
      quotaUsage[priority]--
      // 释放后尝试出队下一个等待者
      drainQueue()
      stateChanged.emit()
    },
  }

  activeSlots.set(slotId, handle)
  quotaUsage[priority]++
  stateChanged.emit()

  return handle
}

/**
 * 从队列头部按优先级出队可执行的 agent
 * 队列已按优先级排序，遍历找到第一个满足配额条件的条目
 */
function drainQueue(): void {
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i]
    // P5:入队时记录的 estimatedTokens 也要作为出队条件
    if (canAcquire(entry.priority, entry.estimatedTokens ?? 0)) {
      // 移除该条目
      queue.splice(i, 1)

      // 清理 AbortSignal listener
      if (entry.abortCleanup) {
        entry.abortCleanup()
      }

      // P5:出队成功时扣 token 预算(与 createSlotHandle 分开,因为
      // createSlotHandle 本身不知道 estimatedTokens 的值)
      if (entry.estimatedTokens && entry.estimatedTokens > 0) {
        charge(entry.estimatedTokens)
      }

      // 创建槽位并 resolve
      const handle = createSlotHandle(entry.id, entry.priority)
      entry.resolve(handle)

      // 继续检查是否还能出队更多（递归改迭代）
      // 因为 splice 改变了数组，从头重新扫描
      i = -1
      continue
    }
  }
}

/**
 * 将 agent 按优先级插入队列（稳定排序：同优先级 FIFO）
 */
function enqueue(entry: QueuedAgent): void {
  const order = PRIORITY_ORDER[entry.priority]
  // 找到第一个优先级数值大于当前的位置插入
  let insertIdx = queue.length
  for (let i = 0; i < queue.length; i++) {
    if (PRIORITY_ORDER[queue[i].priority] > order) {
      insertIdx = i
      break
    }
  }
  queue.splice(insertIdx, 0, entry)
}

/**
 * 从队列中移除指定 agent（abort 时调用）
 */
function removeFromQueue(agentId: string): QueuedAgent | undefined {
  const idx = queue.findIndex(e => e.id === agentId)
  if (idx === -1) return undefined
  const [removed] = queue.splice(idx, 1)
  return removed
}

// ── 公共 API ──────────────────────────────────────────────

/**
 * 获取执行槽位。
 * - 如果有空槽且配额未满，立即返回 SlotHandle
 * - 否则入队等待，返回的 Promise 在出队时 resolve
 * - 如果 abortSignal 被触发，Promise reject 并从队列移除
 *
 * P5:opts.estimatedTokens 用于 token/min 滑窗预算检查(未配置上限时忽略)。
 * 未提供等价于 0,保持向后兼容;调用方应传 prompt 粗估值。
 */
export async function acquireSlot(
  priority: AgentPriority,
  agentId: string,
  abortSignal?: AbortSignal,
  opts: { estimatedTokens?: number } = {},
): Promise<SlotHandle> {
  const estimatedTokens = Math.max(0, opts.estimatedTokens ?? 0)

  // 快速路径：有空槽且预算足 → 直接分配
  if (canAcquire(priority, estimatedTokens)) {
    if (estimatedTokens > 0) charge(estimatedTokens)
    return createSlotHandle(agentId, priority)
  }

  // 慢路径：入队等待
  return new Promise<SlotHandle>((resolve, reject) => {
    const entry: QueuedAgent = {
      id: agentId,
      priority,
      resolve,
      reject,
      abortSignal,
      enqueuedAt: Date.now(),
      estimatedTokens,
    }

    // 监听 AbortSignal — agent 被取消时从队列移除
    if (abortSignal) {
      if (abortSignal.aborted) {
        reject(new DOMException('Agent scheduling aborted', 'AbortError'))
        return
      }

      const onAbort = () => {
        const removed = removeFromQueue(agentId)
        if (removed) {
          stateChanged.emit()
          reject(new DOMException('Agent scheduling aborted', 'AbortError'))
        }
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      entry.abortCleanup = () => abortSignal.removeEventListener('abort', onAbort)
    }

    enqueue(entry)
    stateChanged.emit()
  })
}

/**
 * 非阻塞版本的 acquireSlot:有空槽立即返回 SlotHandle,无空槽返回 null。
 * P3 speculation 专用 —— 推测执行在槽位紧张时应立即 drop,绝不入队等待
 * 否则会 starvation 抢占 foreground/background。
 *
 * P5:opts.estimatedTokens 参与 budget 检查;预算不足时也直接返回 null。
 */
export function tryAcquireSlot(
  priority: AgentPriority,
  agentId: string,
  opts: { estimatedTokens?: number } = {},
): SlotHandle | null {
  const estimatedTokens = Math.max(0, opts.estimatedTokens ?? 0)
  if (canAcquire(priority, estimatedTokens)) {
    if (estimatedTokens > 0) charge(estimatedTokens)
    return createSlotHandle(agentId, priority)
  }
  return null
}

/**
 * 获取调度器当前快照状态（用于 AppState 同步 / UI 展示）
 */
export function getSchedulerState(): SchedulerState {
  return {
    activeSlots: activeSlots.size,
    maxSlots: config.maxConcurrent,
    queueDepth: queue.length,
    quotaUsage: { ...quotaUsage },
  }
}

/**
 * 获取当前最大并发数（供 prompt.ts 引用）
 */
export function getMaxConcurrent(): number {
  return config.maxConcurrent
}

/**
 * 热更新调度器配置
 * 更新后立即尝试出队（新配置可能放宽了限制）
 */
export function updateSchedulerConfig(partial: Partial<SchedulerConfig>): void {
  config = { ...config, ...partial }

  // 同步更新缓存配置
  if (partial.cacheTTLMs !== undefined || partial.cacheMaxSize !== undefined) {
    updateCacheConfig(partial.cacheTTLMs, partial.cacheMaxSize)
  }

  // 配置放宽后可能有等待者可以出队
  drainQueue()
  stateChanged.emit()
}

/**
 * 订阅调度器状态变更（UI 组件使用）
 * 返回 unsubscribe 函数
 */
export const subscribeSchedulerState = stateChanged.subscribe

/**
 * 重置调度器（用于测试 / session 清理）
 * 注意：不会 abort 活跃的 agent，只清理队列和计数
 */
export function resetScheduler(): void {
  // reject 所有等待中的 agent
  for (const entry of queue) {
    if (entry.abortCleanup) entry.abortCleanup()
    entry.reject(new Error('Scheduler reset'))
  }
  queue.length = 0

  activeSlots.clear()
  quotaUsage.foreground = 0
  quotaUsage.background = 0
  quotaUsage.speculation = 0

  config = { ...DEFAULT_CONFIG }
  lastAdaptAt = 0
  // P5:重置时也清空 token 滑窗,避免测试/session 切换时状态污染
  resetTokenBudget()
  stateChanged.emit()
}

// ── 自适应配额(feature-flag 门控,默认关闭) ──────────────────

// 冷却窗口:防止 stats 抖动触发频繁配额切换
const ADAPT_COOLDOWN_MS = 60 * 1000
// 样本下限:样本不足时不做调整,避免基于噪声决策
const ADAPT_MIN_SAMPLES = 20
// 配额调整幅度边界(绝对值):不超过原 default 的 ±2
const ADAPT_MAX_DELTA = 2
// 上次调整的时间戳
let lastAdaptAt = 0

/**
 * 读取环境开关:CLAUDE_CODE_ADAPTIVE_QUOTA 开启后 adaptScheduler 才会真正调整 config
 */
export function isAdaptiveQuotaEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ADAPTIVE_QUOTA)
}

/**
 * 根据历史 episode 统计,对 maxConcurrent 做软调整。
 *
 * 决策规则(故意保守,只动 maxConcurrent,不动 per-priority quotas):
 *   - 整体 successRate >= 0.9 且样本 >= 20 → 增 1(上限 default + ADAPT_MAX_DELTA)
 *   - 整体 errorRate   >  0.3 且样本 >= 20 → 减 1(下限 max(2, default - ADAPT_MAX_DELTA))
 *   - 其他             → 回归 DEFAULT_CONFIG.maxConcurrent
 *
 * 冷却期 60s,避免抖动。
 * 默认关闭 —— 仅当 env CLAUDE_CODE_ADAPTIVE_QUOTA 真值时执行调整。
 * 返回是否发生了调整。
 */
export async function adaptScheduler(projectDir: string): Promise<boolean> {
  if (!isAdaptiveQuotaEnabled()) return false

  const now = Date.now()
  if (now - lastAdaptAt < ADAPT_COOLDOWN_MS) return false

  const snapshot = await getAgentStats(projectDir)
  if (snapshot.totalSamples < ADAPT_MIN_SAMPLES) return false

  // 整体聚合(跨 agentType)
  let total = 0
  let success = 0
  let errorOrAbort = 0
  for (const stat of Object.values(snapshot.byAgentType)) {
    total += stat.totalRuns
    success += stat.successRuns
    errorOrAbort += stat.errorRuns + stat.abortRuns
  }
  if (total === 0) return false

  const successRate = success / total
  const errorRate = errorOrAbort / total

  const baseMax = DEFAULT_CONFIG.maxConcurrent
  let targetMax = baseMax
  if (successRate >= 0.9) {
    targetMax = Math.min(baseMax + ADAPT_MAX_DELTA, baseMax + 2)
  } else if (errorRate > 0.3) {
    targetMax = Math.max(2, baseMax - ADAPT_MAX_DELTA)
  }

  if (targetMax === config.maxConcurrent) return false

  // 复用已有热更新路径,保留 drainQueue + stateChanged.emit
  updateSchedulerConfig({ maxConcurrent: targetMax })
  lastAdaptAt = now
  return true
}
