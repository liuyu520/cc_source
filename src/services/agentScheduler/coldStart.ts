/**
 * 冷启动预跑(#5) —— 在 CLI 首帧 / coordinator 模式下，尽早触发 speculation。
 *
 * 设计要点:
 *   1. 复用 periodicMaintenance 注册表做 "burst" 机制(短寿命周期任务，完成 N 次
 *      tick 后自注销) —— 不新增 timer 管理逻辑
 *   2. 复用 speculation.maybeRunSpeculation —— 真正的并发闸门 / quota / 缓存命中
 *      逻辑全部走原路径，这里只是把"触发节拍"提前并加密
 *   3. 通过 DI hook(setColdStartProvider)把候选注入 predictNextAgentCalls,
 *      不修改 episode 历史仓库;冷启动产出的样本会经由 runner 正常写 cache
 *
 * 为什么不是简单 runImmediately:
 *   - 全新项目无 episode 历史 —> predictNextAgentCalls 直接返回 []
 *   - 仅靠 runImmediately 让第一次 tick 提前触发，但无候选仍是 no-predictions
 *   - coldStart 注册表是 "候选兜底源":history 空时提供若干候选，让 speculation
 *     有机会真的跑起来。候选由上层按需注册(通常 coordinator 冷启动钩子)
 *
 * 非目标:
 *   - 不主动猜用户第一句 prompt。候选 prompt 与真实 prompt 的 signature 一般
 *     不会 match，coldStart 产出的是 "热身" 样本(agentStats/tool subprocess
 *     warm-up)，而非 prefetch。真正 prefetch 仍靠 episode 历史。
 */

import {
  hasPeriodicTask,
  registerPeriodicTask,
  unregisterPeriodicTask,
} from '../periodicMaintenance/index.js'
import { logForDebugging } from '../../utils/debug.js'
import { computePromptSignature } from './cache.js'
import { maybeRunSpeculation, type SpeculationPrediction } from './speculation.js'

// ── 类型 ─────────────────────────────────────────────────

export type ColdStartAppliesWhen =
  | 'always'
  | 'coordinator-only'
  | 'non-coordinator-only'

export interface ColdStartCandidate {
  /** 唯一名字，同名后注册会覆盖(幂等) */
  name: string
  /** 调用的 agent 类型(与 SpeculationPrediction.agentType 同义) */
  agentType: string
  /** 冷启动时喂给 runner 的 prompt —— 建议简短只读 */
  prompt: string
  /** 优先级:越小越优先;同值按注册顺序 */
  priority?: number
  /** 溯源:调试时知道这条 candidate 是哪段代码种下的 */
  source?: string
  /** 生效条件:默认 always,coordinator-only 需要 CLAUDE_CODE_COORDINATOR_MODE 打开 */
  when?: ColdStartAppliesWhen
}

export interface ColdStartCandidateSnapshot extends Required<Omit<ColdStartCandidate, 'priority'>> {
  priority: number
}

export interface ColdStartBurstOptions {
  /** 总 tick 次数;默认 3 次 */
  totalTicks?: number
  /** 每次 tick 间隔(ms);默认 20_000 */
  intervalMs?: number
  /** 任务名字;默认 'agentScheduler.coldStart-burst' */
  taskName?: string
}

export interface ColdStartRuntimeState {
  candidatesRegistered: number
  lastBurstStartedAt: number
  lastBurstTaskName: string | null
  burstTicksTotal: number
  burstTicksExecuted: number
  burstCompleted: boolean
  lastPickedName: string | null
  lastError: string | null
}

// ── 内部状态 ─────────────────────────────────────────────

const candidates = new Map<string, ColdStartCandidate>()

const runtime: ColdStartRuntimeState = {
  candidatesRegistered: 0,
  lastBurstStartedAt: 0,
  lastBurstTaskName: null,
  burstTicksTotal: 0,
  burstTicksExecuted: 0,
  burstCompleted: false,
  lastPickedName: null,
  lastError: null,
}

const DEFAULT_BURST_TICKS = 3
const DEFAULT_BURST_INTERVAL_MS = 20_000
const DEFAULT_BURST_TASK_NAME = 'agentScheduler.coldStart-burst'

// ── 候选注册 API ─────────────────────────────────────────

export function registerColdStartCandidate(c: ColdStartCandidate): void {
  if (!c || !c.name || !c.agentType || !c.prompt) return
  candidates.set(c.name, { priority: 100, source: 'unknown', when: 'always', ...c })
  runtime.candidatesRegistered = candidates.size
}

export function unregisterColdStartCandidate(name: string): void {
  if (candidates.delete(name)) {
    runtime.candidatesRegistered = candidates.size
  }
}

export function listColdStartCandidates(): ColdStartCandidateSnapshot[] {
  const list: ColdStartCandidateSnapshot[] = []
  for (const c of candidates.values()) {
    list.push({
      name: c.name,
      agentType: c.agentType,
      prompt: c.prompt,
      priority: c.priority ?? 100,
      source: c.source ?? 'unknown',
      when: c.when ?? 'always',
    })
  }
  // 注册表视图按 priority asc + name asc,便于 /kernel-status 观察
  list.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
  return list
}

export function clearColdStartCandidates(): void {
  candidates.clear()
  runtime.candidatesRegistered = 0
}

// ── when 过滤 —— 只读 env,避免循环依赖 coordinatorMode.ts ────

function isCoordinatorEnv(): boolean {
  const v = process.env.CLAUDE_CODE_COORDINATOR_MODE
  return v === '1' || v === 'true'
}

function isCandidateApplicable(c: ColdStartCandidate): boolean {
  const when = c.when ?? 'always'
  if (when === 'always') return true
  const coord = isCoordinatorEnv()
  if (when === 'coordinator-only') return coord
  if (when === 'non-coordinator-only') return !coord
  return true
}

// ── Provider: 供 speculation 在 history 空时兜底 ─────────

/**
 * 返回当前冷启动候选中优先级最高且环境适用的一条,转成 SpeculationPrediction。
 * 无候选或全部被 when 过滤 → null;调用方(predictNextAgentCalls)应按未命中处理。
 */
export function pickColdStartPrediction(): SpeculationPrediction | null {
  const applicable: ColdStartCandidate[] = []
  for (const c of candidates.values()) {
    if (isCandidateApplicable(c)) applicable.push(c)
  }
  if (applicable.length === 0) return null
  applicable.sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || a.name.localeCompare(b.name),
  )
  const top = applicable[0]
  runtime.lastPickedName = top.name
  // 冷启动候选没有 episode 支撑:score/samples 置 0,lastSeenAt 用当下。
  // maybeRunSpeculation 的闸门只关心 quota / signature-cache 命中,
  // 不会因为 score=0 而拒跑。
  return {
    agentType: top.agentType,
    prompt: top.prompt,
    signature: computePromptSignature(top.agentType, top.prompt, process.cwd()),
    score: 0,
    samples: 0,
    lastSeenAt: Date.now(),
  }
}

export function getColdStartState(): ColdStartRuntimeState {
  return { ...runtime }
}

// ── Burst:短寿命周期任务,做 N 次立即 speculation tick 后自注销 ───

/**
 * 启动一次冷启动 burst。
 * - registerPeriodicTask + runImmediately=true → 首 tick 同步入 fire-and-forget
 * - 每 tick 走 maybeRunSpeculation(复用 quota/cache/runner)
 * - 达到 totalTicks 后自调用 unregisterPeriodicTask → timer 清理完成
 *
 * 幂等:同 taskName 再次调用会被 registry 覆盖(等价 restart);
 * 外部检查 hasPeriodicTask 可区分是否已在跑。
 */
export function scheduleColdStartBurst(
  projectDir: string,
  opts: ColdStartBurstOptions = {},
): { taskName: string; totalTicks: number; intervalMs: number } {
  if (!projectDir) {
    return { taskName: '', totalTicks: 0, intervalMs: 0 }
  }
  const taskName = opts.taskName ?? DEFAULT_BURST_TASK_NAME
  const totalTicks = Math.max(1, Math.floor(opts.totalTicks ?? DEFAULT_BURST_TICKS))
  const intervalMs = Math.max(1000, Math.floor(opts.intervalMs ?? DEFAULT_BURST_INTERVAL_MS))

  let executed = 0
  runtime.lastBurstStartedAt = Date.now()
  runtime.lastBurstTaskName = taskName
  runtime.burstTicksTotal = totalTicks
  runtime.burstTicksExecuted = 0
  runtime.burstCompleted = false
  runtime.lastError = null

  registerPeriodicTask({
    name: taskName,
    intervalMs,
    runImmediately: true,
    tick: async () => {
      executed += 1
      runtime.burstTicksExecuted = executed
      try {
        const outcome = await maybeRunSpeculation(projectDir)
        logForDebugging(
          `[agentScheduler/coldStart] burst tick ${executed}/${totalTicks}: ${outcome}`,
        )
      } catch (e) {
        runtime.lastError = (e as Error).message
        logForDebugging(
          `[agentScheduler/coldStart] burst tick error: ${(e as Error).message}`,
        )
      }
      // 达到总次数后自注销 —— 避免长期占位
      if (executed >= totalTicks) {
        runtime.burstCompleted = true
        // 异步注销:避免在 tick 回调里同步销毁自己的 timer 的边界情况
        setTimeout(() => {
          try {
            unregisterPeriodicTask(taskName)
          } catch {
            // 吞错 —— 幂等即可
          }
        }, 0)
      }
    },
  })

  return { taskName, totalTicks, intervalMs }
}

/**
 * 停止 burst(如果在跑)。幂等。通常只在测试或切 projectDir 时调用。
 */
export function stopColdStartBurst(taskName?: string): void {
  const name = taskName ?? runtime.lastBurstTaskName ?? DEFAULT_BURST_TASK_NAME
  if (hasPeriodicTask(name)) {
    unregisterPeriodicTask(name)
  }
}

// ── 测试钩子 ─────────────────────────────────────────────

export function __resetColdStartForTests(): void {
  candidates.clear()
  runtime.candidatesRegistered = 0
  runtime.lastBurstStartedAt = 0
  runtime.lastBurstTaskName = null
  runtime.burstTicksTotal = 0
  runtime.burstTicksExecuted = 0
  runtime.burstCompleted = false
  runtime.lastPickedName = null
  runtime.lastError = null
}
