/**
 * ContextSignals — 纯内存 ring buffer 遥测层(Phase 54)
 *
 * 约定:
 * - 所有 recordXxx / getXxx 必须对调用方是"纯记账", 不可抛, 不可阻塞。
 * - 关闭开关走环境变量 CLAUDE_CODE_CONTEXT_SIGNALS; 默认 on(只读记账, 开销可忽略)。
 * - 不写磁盘; 进程退出即丢弃。需要跨会话保留再包 snapshotStore(Phase 58+)。
 */

import type {
  ContextSignalKind,
  ContextSignalKindSnapshot,
  ContextSignalsSnapshot,
  SignalServedEvent,
  SignalUtilizationEvent,
} from './types.js'

// ── 环境开关 ───────────────────────────────────────────
function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_CONTEXT_SIGNALS ?? '').trim().toLowerCase()
  // 默认 on: 空字符串/未设置视作 on; 显式关闭需要 '0' | 'off' | 'false' | 'no'
  if (raw === '' || raw === undefined) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

// ── 环形缓冲上限 ────────────────────────────────────────
// 与 kernel 已有滑动窗口(50)同量级, 避免内存增长
const RING_CAPACITY = 200

// 模块级单例状态; 刻意不做多实例
const servedRing: SignalServedEvent[] = []
const utilizationRing: SignalUtilizationEvent[] = []

// Phase 58b · 采样游标: 每条 served event 唯一 id, sampler 用它记录"已采样"集合,
// 避免对同一 served event 反复采样。游标 reset 发生在 __resetContextSignalsForTests。
let servedIdCounter = 0
const servedById = new Map<number, SignalServedEvent>()
const sampledIds = new Set<number>()

// ── 写入路径 ──────────────────────────────────────────────

/**
 * 记录一次上下文投递。所有字段可选最大限度降低调用方负担。
 * 约定 kind 必填, tokens/itemCount 至少其一。
 */
export function recordSignalServed(
  input: Omit<SignalServedEvent, 'ts'> & { ts?: number },
): void {
  if (!isEnabled()) return
  try {
    const ev: SignalServedEvent = {
      ts: input.ts ?? Date.now(),
      kind: input.kind,
      decisionPoint: input.decisionPoint,
      tokens: Math.max(0, input.tokens | 0),
      itemCount: Math.max(0, input.itemCount | 0),
      level: input.level,
      relevance:
        typeof input.relevance === 'number'
          ? Math.max(0, Math.min(1, input.relevance))
          : undefined,
      anchors: input.anchors,
      meta: input.meta,
    }
    pushWindow(servedRing, ev, RING_CAPACITY)
    // Phase 58b · 给事件打一个 monotonic id, 供 sampler 使用。id 不外露类型,
    // 只由本模块内部维护; 外部通过 drainUnsampledServedEvents 消费。
    const id = ++servedIdCounter
    servedById.set(id, ev)
    // 清理过旧 id: 只保留 ring 当前存活事件的 id
    if (servedById.size > RING_CAPACITY * 2) {
      // 简单策略: 删除所有不在当前 ring 里的 id
      const alive = new Set(servedRing)
      for (const [k, v] of servedById) {
        if (!alive.has(v)) {
          servedById.delete(k)
          sampledIds.delete(k)
        }
      }
    }
  } catch {
    // 遥测只读, 吞掉一切异常以免污染调用方
  }
}

/**
 * 记录一次"事后看是否被用到"。Phase 54 仅保留接口 + ring, 让后续 Phase 58 填数。
 */
export function recordSignalUtilization(
  input: Omit<SignalUtilizationEvent, 'ts'> & { ts?: number },
): void {
  if (!isEnabled()) return
  try {
    const ev: SignalUtilizationEvent = {
      ts: input.ts ?? Date.now(),
      kind: input.kind,
      decisionPoint: input.decisionPoint,
      used: input.used,
      evidence: input.evidence,
    }
    pushWindow(utilizationRing, ev, RING_CAPACITY)
  } catch {
    // 同上, 只读吞异常
  }
}

// ── 读取路径 ────────────────────────────────────────────

/**
 * 聚合按 kind 分组的统计, /kernel-status 直接展示这个结果。
 */
export function getContextSignalsSnapshot(): ContextSignalsSnapshot {
  const enabled = isEnabled()
  const byKindMap = new Map<ContextSignalKind, {
    servedCount: number
    totalTokens: number
    totalItems: number
    lastServedAt: number
    utilizedCount: number
    notUtilizedCount: number
  }>()

  // served 聚合
  for (const ev of servedRing) {
    const agg = byKindMap.get(ev.kind) ?? {
      servedCount: 0,
      totalTokens: 0,
      totalItems: 0,
      lastServedAt: 0,
      utilizedCount: 0,
      notUtilizedCount: 0,
    }
    agg.servedCount += 1
    agg.totalTokens += ev.tokens
    agg.totalItems += ev.itemCount
    if (ev.ts > agg.lastServedAt) agg.lastServedAt = ev.ts
    byKindMap.set(ev.kind, agg)
  }

  // utilization 合并进同一张表
  for (const ev of utilizationRing) {
    const agg = byKindMap.get(ev.kind) ?? {
      servedCount: 0,
      totalTokens: 0,
      totalItems: 0,
      lastServedAt: 0,
      utilizedCount: 0,
      notUtilizedCount: 0,
    }
    if (ev.used) agg.utilizedCount += 1
    else agg.notUtilizedCount += 1
    byKindMap.set(ev.kind, agg)
  }

  const byKind: ContextSignalKindSnapshot[] = []
  for (const [kind, agg] of byKindMap.entries()) {
    const sampled = agg.utilizedCount + agg.notUtilizedCount
    const utilizationRate =
      sampled > 0 ? agg.utilizedCount / sampled : 0
    byKind.push({
      kind,
      servedCount: agg.servedCount,
      totalTokens: agg.totalTokens,
      totalItems: agg.totalItems,
      lastServedAt: agg.lastServedAt,
      utilizedCount: agg.utilizedCount,
      notUtilizedCount: agg.notUtilizedCount,
      utilizationRate,
    })
  }

  // 按 servedCount 倒序, 热门 source 排前面
  byKind.sort((a, b) => b.servedCount - a.servedCount)

  return {
    enabled,
    ringCapacity: RING_CAPACITY,
    servedRingSize: servedRing.length,
    utilizationRingSize: utilizationRing.length,
    byKind,
    recentServed: servedRing.slice(-5).reverse(),
  }
}

/**
 * 仅供测试/诊断: 清空 ring。生产路径不应调用。
 */
export function __resetContextSignalsForTests(): void {
  servedRing.length = 0
  utilizationRing.length = 0
  servedById.clear()
  sampledIds.clear()
  servedIdCounter = 0
}

/**
 * Phase 58b · 从 served 账本里"取走"所有还未被采样过的事件(且在时间窗内),
 * 标记为已采样, 调用方拿去做 utilization 计算。幂等: 再次调用返回空。
 *
 * @param windowMs 只返回 ts 在 (now - windowMs) 以内的事件, 避免拿到很久以前的陈旧条目
 */
export function drainUnsampledServedEvents(
  windowMs = 60_000,
): ReadonlyArray<SignalServedEvent> {
  if (!isEnabled()) return []
  try {
    const threshold = Date.now() - Math.max(0, windowMs | 0)
    const out: SignalServedEvent[] = []
    for (const [id, ev] of servedById) {
      if (sampledIds.has(id)) continue
      if (ev.ts < threshold) continue
      out.push(ev)
      sampledIds.add(id)
    }
    return out
  } catch {
    return []
  }
}

// ── 内部辅助 ─────────────────────────────────────────────
function pushWindow<T>(arr: T[], item: T, max: number): void {
  arr.push(item)
  if (arr.length > max) arr.splice(0, arr.length - max)
}
