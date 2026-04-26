/**
 * 轻量熔断器 — 供 SideQueryScheduler 与 MCP LazyLoad(P1-2) 共用。
 *
 * 状态机:
 *   closed  → 正常放行
 *   open    → 完全熔断，直接走 fallback，持续 cooldownMs
 *   half    → cooldown 结束后放行 1 个请求探测，成功则回 closed，失败则回 open
 *
 * 不依赖任何外部状态，纯内存。多实例隔离（每个 category / 每个 MCP server 一个）。
 */

export type BreakerState = 'closed' | 'open' | 'half'

export interface CircuitBreakerOptions {
  /** 连续失败 N 次后打开熔断 */
  failureThreshold: number
  /** 打开后的冷却时间 ms */
  cooldownMs: number
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs: 60_000,
}

export class CircuitBreaker {
  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  private openedAt = 0
  private halfProbeInflight = false
  private readonly opts: CircuitBreakerOptions

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  /**
   * 返回当前是否允许放行请求。
   * 副作用：到期时自动从 open → half。
   */
  allow(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = 'half'
        this.halfProbeInflight = false
      } else {
        return false
      }
    }
    // half: 只允许 1 个探测
    if (this.state === 'half') {
      if (this.halfProbeInflight) return false
      this.halfProbeInflight = true
      return true
    }
    return true
  }

  isOpen(): boolean {
    return this.state === 'open'
  }

  getState(): BreakerState {
    return this.state
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    if (this.state === 'half') {
      this.state = 'closed'
      this.halfProbeInflight = false
    }
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.state === 'half') {
      // 探测失败：回到 open 并重置 cooldown
      this.state = 'open'
      this.openedAt = Date.now()
      this.halfProbeInflight = false
      return
    }
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open'
      this.openedAt = Date.now()
    }
  }

  /** 测试/诊断用：强制重置 */
  reset(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.openedAt = 0
    this.halfProbeInflight = false
  }
}
