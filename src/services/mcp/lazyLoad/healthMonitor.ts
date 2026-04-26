/**
 * MCP HealthMonitor (P1-2) — 按 server 隔离的熔断器。
 *
 * 直接复用 services/sideQuery/circuitBreaker.ts 的 CircuitBreaker 实现，
 * 消除重复代码。每个 server 一个 CircuitBreaker 实例。
 *
 * 失败 3 次 → 隔离 5 分钟 → half-open 探测 → 恢复或再隔离。
 */

import { CircuitBreaker } from '../../sideQuery/circuitBreaker.js'
import type { McpHealthState } from './types.js'

export class HealthMonitor {
  private breakers = new Map<string, CircuitBreaker>()

  private getBreaker(serverName: string): CircuitBreaker {
    let b = this.breakers.get(serverName)
    if (!b) {
      b = new CircuitBreaker({
        failureThreshold: 3,
        cooldownMs: 5 * 60 * 1000,
      })
      this.breakers.set(serverName, b)
    }
    return b
  }

  /** 返回该 server 当前是否允许放行 */
  allow(serverName: string): boolean {
    return this.getBreaker(serverName).allow()
  }

  recordSuccess(serverName: string): void {
    this.getBreaker(serverName).recordSuccess()
  }

  recordFailure(serverName: string): void {
    this.getBreaker(serverName).recordFailure()
  }

  getState(serverName: string): McpHealthState {
    const b = this.breakers.get(serverName)
    if (!b) return 'healthy'
    const s = b.getState()
    if (s === 'open') return 'isolated'
    if (s === 'half') return 'degraded'
    return 'healthy'
  }

  snapshot(): Record<string, McpHealthState> {
    const out: Record<string, McpHealthState> = {}
    for (const [k] of this.breakers) out[k] = this.getState(k)
    return out
  }

  reset(serverName?: string): void {
    if (serverName) {
      this.breakers.get(serverName)?.reset()
    } else {
      for (const b of this.breakers.values()) b.reset()
    }
  }
}

export const mcpHealthMonitor = new HealthMonitor()
