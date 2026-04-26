// G10 Step 3:budgetCoordinator —— periodicMaintenance 的节流油门。
//
// 设计要点(与 Step 1/2 完全对称,不破坏现有 ledger/advisory):
//  1. 纯只读读 tickBudgetAdvisory,不自己 compute 统计;
//  2. 默认 OFF:`CLAUDE_TICK_COORDINATOR=on` 才启用,否则 acquire() 永远 allow;
//  3. 判定规则:
//     - advisory.kind='chronic' → 拒绝(单 task 连续 error,强 RCA 信号);
//     - advisory.kind='error_burst' + severity='high' → 拒绝;
//     - 否则 allow;
//  4. 只对 **offendingTask** 生效,不影响其他 tick(保护非 offender);
//  5. 额外 task-local mini-quota:同一 task 一旦被 throttle,冷却窗口 CHILL_MS 内保持 deny
//     (避免反复 advisor 抖动);
//  6. release() 目前是 no-op,保留签名以便未来挂 real-time 计数。
//  7. fail-open:advisory 读取失败或缺模块,都返回 allow。
//
// 写入路径:registry.ts.runTick 在 enabled()-skipped 分支之后调用。

export interface BudgetDecision {
  allow: boolean
  reason?: string
  kind?: 'chronic' | 'error_burst' | 'none'
  severity?: 'low' | 'medium' | 'high'
  offendingTask?: string
}

// 冷却窗口:被 throttle 后 5 分钟内持续拒绝(避免 advisor 抖动)
const CHILL_MS = 5 * 60 * 1000

// advisory 缓存 TTL:每次 acquire 都读 ledger+stats 代价偏高,30s 内复用。
// 选 30s 的理由:ledger 粒度是 tick 事件,advisor 阈值按"连续 3 次 / 24h 窗"判断,
// 30s 内判定不会漂,却可把 fast-tick 下的 read 放大降低 2~3 个数量级。
const ADVISORY_CACHE_TTL_MS = 30 * 1000

// 同进程 task-local 冷却状态
const chillUntilByTask = new Map<string, number>()

// advisory + stats 的跨调用缓存(单进程内共享)
let advisoryCache:
  | { ts: number; advisory: ReturnType<typeof loadAdvisory> }
  | null = null

function loadAdvisory():
  | {
      adv: import('../oracle/tickBudgetAdvisory.js').TickBudgetAdvisory
      stats: import('../oracle/tickBudgetAdvisory.js').TickBudgetStats
    }
  | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../oracle/tickBudgetAdvisory.js') as typeof import('../oracle/tickBudgetAdvisory.js')
    const adv = mod.detectTickBudgetAdvisory()
    // 从 adv.stats 直接拿 byTask(detect 已经顺带带回),不再二次 compute
    return { adv, stats: adv.stats }
  } catch {
    return null
  }
}

function getAdvisoryCached(now: number): ReturnType<typeof loadAdvisory> {
  if (advisoryCache && now - advisoryCache.ts < ADVISORY_CACHE_TTL_MS) {
    return advisoryCache.advisory
  }
  const fresh = loadAdvisory()
  advisoryCache = { ts: now, advisory: fresh }
  return fresh
}

// 清除 chillUntilByTask 中已过期的条目,避免长跑进程 Map 缓慢增长
function pruneExpiredChills(now: number): void {
  for (const [name, until] of chillUntilByTask.entries()) {
    if (until <= now) chillUntilByTask.delete(name)
  }
}

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_TICK_COORDINATOR ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}

/**
 * 决定某个 tick 是否被允许执行。
 *
 * - 默认 fail-open:disabled / 读失败 / 数据缺失 均 allow。
 * - chronic 或 error_burst-high 才 deny,且只 deny 对应的 offendingTask。
 */
export function acquire(taskName: string, now = Date.now()): BudgetDecision {
  if (!isEnabled()) return { allow: true, reason: 'coordinator-disabled' }
  if (!taskName) return { allow: true, reason: 'no-task-name' }

  // task-local 冷却优先:命中即复用上次判定,节省 advisor 计算
  // 惰性清理已过期 chill 条目:防止长跑进程 Map 无界增长
  pruneExpiredChills(now)

  const until = chillUntilByTask.get(taskName)
  if (until && until > now) {
    return {
      allow: false,
      reason: `cooling-down:${Math.ceil((until - now) / 1000)}s`,
      kind: 'none',
    }
  }

  try {
    // 走带 TTL 的 advisory 缓存:fast-tick 情景下不再每次都读 ledger+parse 2000 行
    const loaded = getAdvisoryCached(now)
    if (!loaded) {
      return { allow: true, reason: 'advisory-fail-open' }
    }
    const { adv, stats } = loaded
    if (adv.kind === 'chronic') {
      // chronic:必 high,指向特定 offendingTask
      if (adv.offendingTask && adv.offendingTask === taskName) {
        chillUntilByTask.set(taskName, now + CHILL_MS)
        return {
          allow: false,
          reason: 'chronic-error-streak',
          kind: 'chronic',
          severity: adv.severity,
          offendingTask: adv.offendingTask,
        }
      }
      // 多 offender 兜底:advisory.find() 只取第一个,若本 task 自身 streak 也已超阈值,
      // 同样应被拒绝,否则第二个 chronic task 永远逃过闸门。
      const self = stats.byTask[taskName]
      if (self && self.lastErrorStreak >= 3) {
        chillUntilByTask.set(taskName, now + CHILL_MS)
        return {
          allow: false,
          reason: 'chronic-error-streak-self',
          kind: 'chronic',
          severity: adv.severity,
          offendingTask: taskName,
        }
      }
      return { allow: true, reason: 'chronic-other-task' }
    }
    if (adv.kind === 'error_burst' && adv.severity === 'high') {
      // error_burst-high:优先匹配 advisory 指出的 offendingTask
      if (adv.offendingTask && adv.offendingTask === taskName) {
        chillUntilByTask.set(taskName, now + CHILL_MS)
        return {
          allow: false,
          reason: 'error-burst-high',
          kind: 'error_burst',
          severity: adv.severity,
          offendingTask: adv.offendingTask,
        }
      }
      // 多 offender 兜底:若本 task 自身 errorRate/count 也达标,同样拒绝。
      // 阈值沿用 advisory 默认值(errorRate>=0.3, total>=3)—— 这里是最后一层
      // 闸门,不再重复暴露可调项,保持 coordinator 足够简单。
      const self = stats.byTask[taskName]
      if (self && self.errorRate >= 0.3 && self.count >= 3) {
        chillUntilByTask.set(taskName, now + CHILL_MS)
        return {
          allow: false,
          reason: 'error-burst-high-self',
          kind: 'error_burst',
          severity: adv.severity,
          offendingTask: taskName,
        }
      }
      return { allow: true, reason: 'error_burst-other-task' }
    }
    // slow / error_burst-medium / error_burst-low / none:均放行
    return { allow: true, reason: `advisory-${adv.kind}-${adv.severity}` }
  } catch {
    // advisory 加载/读取异常:fail-open
    return { allow: true, reason: 'advisory-fail-open' }
  }
}

/** 对称 API,保留给未来实时计数;目前是 no-op。 */
export function release(_taskName: string): void {
  // 占位:保留 acquire/release 对称
}

/** 测试/观测用:清空 task-local 冷却状态 */
export function __resetBudgetCoordinatorForTests(): void {
  chillUntilByTask.clear()
  advisoryCache = null
}

/** 只读 snapshot:当前被冷却的 task 列表(含剩余毫秒) */
export function getBudgetCoordinatorSnapshot(now = Date.now()): {
  enabled: boolean
  chilled: Array<{ taskName: string; remainingMs: number }>
} {
  const chilled: Array<{ taskName: string; remainingMs: number }> = []
  for (const [name, until] of chillUntilByTask.entries()) {
    const remaining = until - now
    if (remaining > 0) {
      chilled.push({ taskName: name, remainingMs: remaining })
    }
  }
  return { enabled: isEnabled(), chilled }
}
