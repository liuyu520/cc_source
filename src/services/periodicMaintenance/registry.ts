/**
 * Periodic Maintenance Registry — 通用周期性维护任务注册表
 *
 * 背景:
 *   agentScheduler/background.ts 已经实现了一套"幂等启停 + tickInFlight 守护
 *   + unref + 吞错 + projectDir 绑定"的周期任务模板,但只服务 agentStats 刷新
 *   和 speculation。实际上项目里还有至少 3 处 lazy-eviction 反模式等同需求:
 *
 *     - cache.ts: evictExpiredCache() 仅在 setCachedResult 写路径上触发
 *     - tokenBudget.ts: evictExpired() 在每次 canCharge/charge 的 hot path 上跑
 *     - (未来) 其它可能的 keepalive / 日志轮转 / 快照落盘 任务
 *
 *   本模块把 background.ts 的模板抽成通用注册表,统一的 start/stop/状态面板,
 *   各模块只需注册一个 tick 函数即可获得:
 *     - 幂等启停(重复 start 同一任务 no-op)
 *     - 并发守护(上一次 tick 未完,下一次自动跳过)
 *     - unref 不阻塞进程退出
 *     - 吞错 + debug 日志,绝不泄露到调用方
 *     - 开关函数 enabled() 动态开关(不用频繁注销/注册)
 *     - 可选首次立即执行(runImmediately)
 *
 * 设计原则:
 *   - 每任务独立 setInterval —— 实现简单,各任务不互相拖累
 *     (共享单 tick loop 会让慢任务推迟快任务,得不偿失)
 *   - 注册即保留,start/stop 只管 timer;未 start 时注册不会执行
 *   - projectDir 作为 ctx 传给 tick —— 支持 /cd 场景重启(stopAll + startAll)
 *   - 零侧效的观测 API:getPeriodicMaintenanceState 读 snapshot 即可
 */

import { logForDebugging } from '../../utils/debug.js'

// ── 类型 ──────────────────────────────────────────────────

export interface PeriodicTaskContext {
  /** 当前会话绑定的项目目录,任务决定是否使用 */
  projectDir: string
  /** 自启动以来本任务累计 tick 次数(从 1 开始) */
  tickCount: number
}

export interface PeriodicTask {
  /** 任务唯一名 —— 重复 register 同名任务会覆盖旧定义(便于热更新) */
  name: string
  /** tick 间隔(ms),最小 1000 —— 防止失控(测试可覆写 MIN) */
  intervalMs: number
  /** 真正的周期逻辑。抛错会被吞并写 debug 日志,不会影响其它任务 */
  tick: (ctx: PeriodicTaskContext) => Promise<void> | void
  /**
   * 运行前动态判定是否 skip 此次 tick —— 通常读 env 开关。
   * 返回 false 时任务依然注册在 registry,但该次 tick no-op。
   * 未提供时视为永远启用。
   */
  enabled?: () => boolean
  /**
   * 若为 true,startPeriodicMaintenance 时会立即触发一次 tick
   * (依然是 fire-and-forget,不阻塞 start)。默认 false,避免冷启动 IO 抖动。
   */
  runImmediately?: boolean
}

export interface PeriodicTaskRuntimeState {
  name: string
  intervalMs: number
  tickCount: number
  tickInFlight: boolean
  lastTickAt: number          // 0 表示从未执行过
  lastErrorMessage: string | null
  enabledSnapshot: boolean    // 最近一次读 enabled() 的结果;未提供时为 true
  running: boolean            // timer 是否存在
}

export interface PeriodicMaintenanceSnapshot {
  running: boolean
  projectDir: string | null
  tasks: PeriodicTaskRuntimeState[]
}

// ── 常量 ──────────────────────────────────────────────────

/** 最小 interval 防止失控;测试场景如需更低值请用 __setMinIntervalMsForTests */
const DEFAULT_MIN_INTERVAL_MS = 1000
let MIN_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS

// ── 内部状态 ─────────────────────────────────────────────

interface TaskRecord {
  task: PeriodicTask
  timer: ReturnType<typeof setInterval> | null
  tickCount: number
  tickInFlight: boolean
  lastTickAt: number
  lastErrorMessage: string | null
  enabledSnapshot: boolean
}

// 模块级单例状态 —— 进程内全局,符合 background.ts 原语义
const tasks = new Map<string, TaskRecord>()
let currentProjectDir: string | null = null
let globalRunning = false

// ── 注册 API ─────────────────────────────────────────────

/**
 * 注册一个周期性任务。同名重复注册会覆盖(便于热更新 tick 逻辑)。
 * - 若当前 running,新任务会立即启动它自己的 timer
 * - 若未 running,仅登记,startPeriodicMaintenance 时批量起
 */
export function registerPeriodicTask(task: PeriodicTask): void {
  if (!task.name) {
    logForDebugging('[periodicMaintenance] register ignored: missing name')
    return
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, task.intervalMs)
  const normalized: PeriodicTask = { ...task, intervalMs }

  // 已存在 → 先停掉旧 timer,防止泄漏
  const existing = tasks.get(task.name)
  if (existing?.timer) {
    clearInterval(existing.timer)
    existing.timer = null
  }

  const record: TaskRecord = existing ?? {
    task: normalized,
    timer: null,
    tickCount: 0,
    tickInFlight: false,
    lastTickAt: 0,
    lastErrorMessage: null,
    enabledSnapshot: true,
  }
  record.task = normalized

  tasks.set(task.name, record)

  // 当前已 running 且有 projectDir → 立即起 timer(支持运行中动态注册)
  if (globalRunning && currentProjectDir) {
    startTaskTimer(record, currentProjectDir)
  }
}

/**
 * 注销某个任务。若 timer 在跑会先 clear。未注册则 no-op。
 */
export function unregisterPeriodicTask(name: string): void {
  const rec = tasks.get(name)
  if (!rec) return
  if (rec.timer) {
    clearInterval(rec.timer)
    rec.timer = null
  }
  tasks.delete(name)
}

// ── 启停 API ─────────────────────────────────────────────

/**
 * 启动所有已注册任务。
 * - 重复 start 同一 projectDir:no-op
 * - 切换 projectDir:先 stop 再 start(沿袭 background.ts 的 /cd 语义)
 * - 未注册任何任务时只记录 projectDir,不起 timer
 */
export function startPeriodicMaintenance(projectDir: string): void {
  if (!projectDir) return

  // 同 projectDir 且已在跑 → 忽略
  if (globalRunning && currentProjectDir === projectDir) return

  // 切换 projectDir → 先停
  if (globalRunning) stopPeriodicMaintenance()

  currentProjectDir = projectDir
  globalRunning = true

  for (const rec of tasks.values()) {
    startTaskTimer(rec, projectDir)
  }

  logForDebugging(
    `[periodicMaintenance] started (projectDir=${projectDir}, tasks=${tasks.size})`,
  )
}

/**
 * 停止所有任务。幂等:未启动时也安全。
 */
export function stopPeriodicMaintenance(): void {
  for (const rec of tasks.values()) {
    if (rec.timer) {
      clearInterval(rec.timer)
      rec.timer = null
    }
    rec.tickInFlight = false
  }
  currentProjectDir = null
  globalRunning = false
  logForDebugging('[periodicMaintenance] stopped')
}

// ── 内部:单任务 timer 启动 ─────────────────────────────

function startTaskTimer(rec: TaskRecord, projectDir: string): void {
  if (rec.timer) return   // 已在跑,防重入

  const runTickOnce = () => runTick(rec, projectDir)

  rec.timer = setInterval(runTickOnce, rec.task.intervalMs)
  if (typeof (rec.timer as unknown as { unref?: () => void }).unref === 'function') {
    ;(rec.timer as unknown as { unref: () => void }).unref()
  }

  // 可选:立即触发一次(fire-and-forget)
  if (rec.task.runImmediately) {
    // 不 await,沿袭 background.ts 不阻塞 start 的行为
    void runTickOnce()
  }
}

async function runTick(rec: TaskRecord, projectDir: string): Promise<void> {
  // enabled 闸门:让任务在不注销的情况下动态开关
  const enabled = rec.task.enabled ? safeEnabled(rec.task.enabled) : true
  rec.enabledSnapshot = enabled
  if (!enabled) {
    // G10 Step 1 (2026-04-26) —— 旁路采样:skipped 也写 ledger,便于观察 duty cycle。
    try {
      const { recordTickSample } = require(
        '../autoEvolve/observability/tickBudgetLedger.js',
      ) as typeof import('../autoEvolve/observability/tickBudgetLedger.js')
      recordTickSample({
        taskName: rec.task.name,
        durationMs: 0,
        outcome: 'skipped',
        tickCount: rec.tickCount,
        intervalMs: rec.task.intervalMs,
      })
    } catch {
      /* fail-open */
    }
    return
  }

  // 并发守护:上一次未完,直接跳过
  if (rec.tickInFlight) return

  // G10 Step 3 (2026-04-26) —— budgetCoordinator 节流油门。
  //   只在 CLAUDE_TICK_COORDINATOR=on 时生效;chronic 或 error_burst-high
  //   时拒绝对应 offendingTask,并在 5min 冷却窗口内保持 deny;
  //   其他 task 不受影响。fail-open:coordinator 异常一律放行,与 G10 Step 1/2 同源。
  try {
    const { acquire } = require(
      '../autoEvolve/observability/budgetCoordinator.js',
    ) as typeof import('../autoEvolve/observability/budgetCoordinator.js')
    const decision = acquire(rec.task.name)
    if (!decision.allow) {
      try {
        const { recordTickSample } = require(
          '../autoEvolve/observability/tickBudgetLedger.js',
        ) as typeof import('../autoEvolve/observability/tickBudgetLedger.js')
        recordTickSample({
          taskName: rec.task.name,
          durationMs: 0,
          outcome: 'skipped',
          errorMessage: `throttled:${decision.reason ?? 'unknown'}`,
          tickCount: rec.tickCount,
          intervalMs: rec.task.intervalMs,
        })
      } catch { /* fail-open */ }
      logForDebugging(
        `[periodicMaintenance/${rec.task.name}] throttled by coordinator: ${decision.reason}`,
      )
      return
    }
  } catch { /* coordinator 加载异常:fail-open,继续原路径 */ }

  rec.tickInFlight = true

  // G10 Step 1 (2026-04-26) —— 测量 tick 耗时,finally 里旁路写 ledger。
  const tickStartedAt = Date.now()
  let tickOutcome: 'success' | 'error' = 'success'
  let tickErrorMessage: string | undefined = undefined
  try {
    const nextCount = rec.tickCount + 1
    await rec.task.tick({ projectDir, tickCount: nextCount })
    rec.tickCount = nextCount
    rec.lastTickAt = Date.now()
    rec.lastErrorMessage = null
  } catch (err) {
    const msg = (err as Error).message
    rec.lastErrorMessage = msg
    tickOutcome = 'error'
    tickErrorMessage = msg
    logForDebugging(
      `[periodicMaintenance/${rec.task.name}] tick error: ${msg}`,
    )
  } finally {
    rec.tickInFlight = false
    // G10 Step 1 —— 旁路采样:success/error 均写,fail-open。
    try {
      const { recordTickSample } = require(
        '../autoEvolve/observability/tickBudgetLedger.js',
      ) as typeof import('../autoEvolve/observability/tickBudgetLedger.js')
      recordTickSample({
        taskName: rec.task.name,
        durationMs: Date.now() - tickStartedAt,
        outcome: tickOutcome,
        errorMessage: tickErrorMessage,
        tickCount: rec.tickCount,
        intervalMs: rec.task.intervalMs,
      })
    } catch {
      /* observability 层异常不影响主路径 */
    }
  }
}

// enabled() 自身抛错时默认放行(与历史行为一致:任务继续跑)
function safeEnabled(fn: () => boolean): boolean {
  try {
    return fn()
  } catch (err) {
    logForDebugging(
      `[periodicMaintenance] enabled() threw, defaulting to true: ${(err as Error).message}`,
    )
    return true
  }
}

// ── 观测 API ─────────────────────────────────────────────

/**
 * 快照当前注册表状态 —— 供 /kernel-status 诊断命令消费。
 */
export function getPeriodicMaintenanceState(): PeriodicMaintenanceSnapshot {
  const list: PeriodicTaskRuntimeState[] = []
  for (const rec of tasks.values()) {
    list.push({
      name: rec.task.name,
      intervalMs: rec.task.intervalMs,
      tickCount: rec.tickCount,
      tickInFlight: rec.tickInFlight,
      lastTickAt: rec.lastTickAt,
      lastErrorMessage: rec.lastErrorMessage,
      enabledSnapshot: rec.enabledSnapshot,
      running: rec.timer !== null,
    })
  }
  return {
    running: globalRunning,
    projectDir: currentProjectDir,
    tasks: list,
  }
}

/**
 * 查询某任务是否已注册(供上层 idempotent 注册时避免重复日志)
 */
export function hasPeriodicTask(name: string): boolean {
  return tasks.has(name)
}

// ── 测试辅助 ─────────────────────────────────────────────

/**
 * 仅供测试:调整最小 interval(原默认 1000ms)。
 * 生产代码切勿调用 —— 降到过低会触发 IO 风暴。
 */
export function __setMinIntervalMsForTests(ms: number): void {
  MIN_INTERVAL_MS = Math.max(1, ms)
}

/**
 * 仅供测试:清空整个 registry(注销所有任务 + stop)。
 */
export function __resetForTests(): void {
  stopPeriodicMaintenance()
  tasks.clear()
  MIN_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS
}
