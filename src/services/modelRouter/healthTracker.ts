/**
 * HealthTracker — 基于 CircuitBreaker 的 provider 健康追踪
 *
 * 每个 provider 一个 CircuitBreaker 实例 + 一份滚动窗口统计：
 *   - 请求 → allow() 决定是否放行
 *   - 成功/失败 → recordSuccess/recordFailure
 *   - 健康态推断：
 *       breaker.state === 'open'   → down
 *       errorRate > 0.3            → degraded
 *       其他                        → healthy
 *
 * 所有健康事件都会 append 到 EvidenceLedger domain='router'。
 */

import { CircuitBreaker, EvidenceLedger } from '../harness/index.js'
import type { ProviderHealth } from './types.js'

interface ProviderStats {
  breaker: CircuitBreaker
  successCount: number
  failureCount: number
  latencySamples: number[] // 最近 N 个 latency，用于 p99
  lastSuccessAt?: string
  lastFailureAt?: string
}

const MAX_LATENCY_SAMPLES = 50

class HealthTrackerImpl {
  private stats = new Map<string, ProviderStats>()

  /** 返回该 provider 的 breaker（供 decide() 检查 allow） */
  getBreaker(provider: string): CircuitBreaker {
    return this.getOrCreate(provider).breaker
  }

  /** 记录一次成功调用 */
  recordSuccess(provider: string, latencyMs: number): void {
    const s = this.getOrCreate(provider)
    s.breaker.recordSuccess()
    s.successCount += 1
    s.lastSuccessAt = new Date().toISOString()
    s.latencySamples.push(latencyMs)
    if (s.latencySamples.length > MAX_LATENCY_SAMPLES) {
      s.latencySamples.shift()
    }
    EvidenceLedger.append({
      ts: new Date().toISOString(),
      domain: 'router',
      kind: 'health_success',
      data: { provider, latencyMs },
    })
  }

  /** 记录一次失败调用 */
  recordFailure(provider: string, error: unknown): void {
    const s = this.getOrCreate(provider)
    s.breaker.recordFailure()
    s.failureCount += 1
    s.lastFailureAt = new Date().toISOString()
    EvidenceLedger.append({
      ts: new Date().toISOString(),
      domain: 'router',
      kind: 'health_failure',
      data: {
        provider,
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }

  /** 获取指定 provider 的健康快照 */
  getHealth(provider: string): ProviderHealth {
    const s = this.stats.get(provider)
    if (!s) {
      return {
        name: provider,
        state: 'healthy',
        p99LatencyMs: 0,
        errorRate: 0,
        consecutiveFailures: 0,
      }
    }
    const total = s.successCount + s.failureCount
    const errorRate = total === 0 ? 0 : s.failureCount / total
    const p99 = computeP99(s.latencySamples)
    let state: ProviderHealth['state'] = 'healthy'
    if (s.breaker.getState() === 'open') {
      state = 'down'
    } else if (errorRate > 0.3) {
      state = 'degraded'
    }
    return {
      name: provider,
      state,
      p99LatencyMs: p99,
      errorRate,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      // CircuitBreaker 没有暴露 consecutiveFailures 的 getter，用 failureCount 近似
      consecutiveFailures: s.breaker.isOpen() ? s.failureCount : 0,
    }
  }

  getAllHealth(): ProviderHealth[] {
    return Array.from(this.stats.keys()).map((name) => this.getHealth(name))
  }

  private getOrCreate(provider: string): ProviderStats {
    let s = this.stats.get(provider)
    if (!s) {
      s = {
        breaker: new CircuitBreaker({
          failureThreshold: 3,
          cooldownMs: 60_000,
        }),
        successCount: 0,
        failureCount: 0,
        latencySamples: [],
      }
      this.stats.set(provider, s)
    }
    return s
  }
}

/** 计算 p99 延迟（简单排序取分位） */
function computeP99(samples: number[]): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.99)
  return sorted[Math.min(idx, sorted.length - 1)]
}

export const healthTracker = new HealthTrackerImpl()
