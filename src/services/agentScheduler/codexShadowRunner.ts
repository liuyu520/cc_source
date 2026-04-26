/**
 * Codex 影子预跑驱动(P0 影子并行)
 *
 * 核心思路:
 *   Codex 等外部 agent CLI 有独立的套餐配额,闲置时浪费可惜。借助
 *   agentScheduler 里已经就位但无人注册 runner 的 speculation 基建,
 *   让 Codex 在用户主线程"慢思考"时,后台预跑最可能被触发的 agent 任务,
 *   产出落到独立 shadowStore,供 /kernel-status 展示和模型/人引用。
 *
 * 与主 speculation.ts 的关系:
 *   不注册 SpeculationRunner(那条路径会写主 cache,可能格式不匹配)。
 *   走一条平行轻链路 —— runShadowTick 内部:
 *     1. 检查 env 开关 + Codex 可用性
 *     2. 调 predictNextAgentCalls 拿 top-1 候选
 *     3. tryAcquireSlot('speculation') 抢配额(与主 speculation 共享 quota)
 *     4. ExternalAgentSessionManager.create(Codex 子进程)
 *     5. 等 waitForResult → 结果落 shadowStore,session 销毁
 *     6. 异常/超时静默吞,累加 state 指标
 *
 * 关键约束:
 *   - env 未开启 / Codex 不可用 → 整条链路 no-op,零开销
 *   - tryAcquireSlot 非阻塞,资源紧张立即 skip(不排队)
 *   - 单次 Codex 子进程硬超时(默认 90s),避免长期占用配额
 *   - 已有 fresh shadow 条目 → skip(避免重复预跑)
 */

import { predictNextAgentCalls } from './speculation.js'
import { tryAcquireSlot } from './scheduler.js'
import { getShadowResult, putShadowResult } from './shadowStore.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  isAgentRouterEnabled,
  routeExternalAgent,
} from '../agentRouter/capabilityRouter.js'
// 三链打通:shadow 成功时把产出同步写入 contextFingerprint,
// 让后续 pipeline / AgentTool 调用可通过 buildContextPrefix 继承"空转预跑"的结论。
import { putContextFingerprint } from '../externalAgentMemory/contextFingerprint.js'
// #8 shadow → episodic 回填:shadow 产出同步作为 agent_run 样本写入 episode 历史,
// 参与下一轮 predictNextAgentCalls 打分 + agentStats 聚合。
import {
  appendEpisode,
  createAgentRunEpisode,
} from '../episodicMemory/episodicMemory.js'

// ── 配置 ───────────────────────────────────────────────────

const ENV_KEY = 'CLAUDE_CODE_SHADOW_AGENT'

/** 单次 Codex 预跑硬超时(ms) —— 超过就停掉,防止吃满套餐 */
const DEFAULT_TASK_TIMEOUT_MS = 90_000

/** 每次 tick 最多预跑几个候选(控制 Codex 调用密度) */
const DEFAULT_MAX_CANDIDATES_PER_TICK = 1

// ── 可支持的外部 agent 名(与 adapters/index.ts 内建列表对齐) ──
//
// 'auto' 是特殊值:每条 prediction 独立走 capabilityRouter 决策具体 adapter,
// 前提是 CLAUDE_CODE_AGENT_ROUTER=1 同步开启(未开启则 auto 视为 off)。

const SUPPORTED_SHADOW_AGENTS = new Set([
  'codex',
  'gemini',
  'claude-code',
  'auto',
])

// ── 运行态指标 ──────────────────────────────────────────────

export interface ShadowRunnerState {
  enabled: boolean
  sourceAgent: string | null   // 当前生效的外部 agent(env 解析结果;auto 时保持 'auto')
  tickCount: number            // runShadowTick 被调用的总次数
  executed: number             // 成功派出 Codex 子进程的次数
  dropped_noPrediction: number
  dropped_noSlot: number
  dropped_alreadyShadowed: number
  dropped_unavailable: number  // Codex CLI 不可用
  dropped_routerNoCandidate: number  // auto 模式下 router 没给出 chosen
  routerAutoRoutes: number     // auto 模式下成功派出 router 决策的次数
  completed_success: number    // Codex 跑完且有 result
  completed_failed: number     // Codex 跑完但失败
  completed_timeout: number    // 硬超时触发停进程
  /** 成功 shadow 同步写回 contextFingerprint 的次数(三链打通指标) */
  fingerprintWriteBacks: number
  /** #8 成功同步写入 episode 历史的次数(回填到 predictNextAgentCalls / agentStats) */
  episodeWriteBacks: number
  /** #8 最近一次 episode 写入报错摘要 */
  lastEpisodeError?: string
  lastError?: string
  lastTickAt: number
}

const state: ShadowRunnerState = {
  enabled: false,
  sourceAgent: null,
  tickCount: 0,
  executed: 0,
  dropped_noPrediction: 0,
  dropped_noSlot: 0,
  dropped_alreadyShadowed: 0,
  dropped_unavailable: 0,
  dropped_routerNoCandidate: 0,
  routerAutoRoutes: 0,
  completed_success: 0,
  completed_failed: 0,
  completed_timeout: 0,
  fingerprintWriteBacks: 0,
  episodeWriteBacks: 0,
  lastTickAt: 0,
}

/** /kernel-status 消费的状态快照 */
export function getShadowRunnerState(): ShadowRunnerState {
  return { ...state }
}

/** 测试钩子:重置运行态指标 */
export function resetShadowRunnerState(): void {
  state.enabled = false
  state.sourceAgent = null
  state.tickCount = 0
  state.executed = 0
  state.dropped_noPrediction = 0
  state.dropped_noSlot = 0
  state.dropped_alreadyShadowed = 0
  state.dropped_unavailable = 0
  state.dropped_routerNoCandidate = 0
  state.routerAutoRoutes = 0
  state.completed_success = 0
  state.completed_failed = 0
  state.completed_timeout = 0
  state.fingerprintWriteBacks = 0
  state.episodeWriteBacks = 0
  state.lastError = undefined
  state.lastEpisodeError = undefined
  state.lastTickAt = 0
}

// ── 开关 ────────────────────────────────────────────────────

/**
 * 读取 env 决定是否启用影子预跑。
 * 值支持: codex、gemini、claude-code、auto(需 CLAUDE_CODE_AGENT_ROUTER=1)。
 * 未识别值视为 off。
 */
export function isShadowRunnerEnabled(): boolean {
  const raw = process.env[ENV_KEY]
  if (!raw) return false
  const name = raw.trim().toLowerCase()
  if (!SUPPORTED_SHADOW_AGENTS.has(name)) return false
  // auto 模式必须同时开启 router,否则视为配置不完整 -> off
  if (name === 'auto' && !isAgentRouterEnabled()) return false
  return true
}

/**
 * 解析 env 得到要用的外部 agent 名(未启用返回 null)。
 * 返回值 'auto' 表示"交给 capabilityRouter per-prediction 决策"。
 */
export function resolveShadowAgentName(): string | null {
  const raw = process.env[ENV_KEY]
  if (!raw) return null
  const name = raw.trim().toLowerCase()
  if (!SUPPORTED_SHADOW_AGENTS.has(name)) return null
  if (name === 'auto' && !isAgentRouterEnabled()) return null
  return name
}

/**
 * #8 回填开关:默认开启,允许用 CLAUDE_CODE_SHADOW_NO_EPISODE=1 opt-out。
 * 某些场景(诊断/隔离)下可能不希望 shadow 影响 episode 历史。
 */
export function isShadowEpisodeWritebackEnabled(): boolean {
  const v = (process.env.CLAUDE_CODE_SHADOW_NO_EPISODE ?? '').trim().toLowerCase()
  return !(v === '1' || v === 'true')
}

// ── 主 tick ────────────────────────────────────────────────

/**
 * 跑一次影子预跑循环。由 periodicMaintenance 任务定期调用。
 *
 * 分支:
 *   - agentName === 'auto':每条 prediction 单独走 capabilityRouter,
 *     不同任务可能路由到不同 adapter(codex/gemini/claude-code)
 *   - 其它:沿用原逻辑,所有 prediction 共用同一个 adapter
 *
 * @returns 本次 tick 派出多少次子进程(0 = 全部 skip / 未启用)
 */
export async function runShadowTick(projectDir: string): Promise<number> {
  state.tickCount++
  state.lastTickAt = Date.now()

  const agentName = resolveShadowAgentName()
  if (!agentName) {
    state.enabled = false
    state.sourceAgent = null
    return 0
  }
  state.enabled = true
  state.sourceAgent = agentName

  // 非 auto 模式:先做一次 top-level adapter 可用性检查,失败整体 skip
  //(与旧版行为一致,避免不可用时还进 predict 和循环)
  let fixedAdapter:
    | import('../../tools/ExternalAgentDelegate/types.js').ExternalAgentAdapter
    | null = null
  if (agentName !== 'auto') {
    try {
      const { getAdapter } = await import(
        '../../tools/ExternalAgentDelegate/adapters/index.js'
      )
      fixedAdapter = getAdapter(agentName)
    } catch (e) {
      state.lastError = `adapter import failed: ${(e as Error).message}`
      return 0
    }
    if (!fixedAdapter) {
      state.dropped_unavailable++
      state.lastError = `adapter ${agentName} not registered`
      return 0
    }
    try {
      const ok = await fixedAdapter.isAvailable()
      if (!ok) {
        state.dropped_unavailable++
        return 0
      }
    } catch (e) {
      state.dropped_unavailable++
      state.lastError = `isAvailable check threw: ${(e as Error).message}`
      return 0
    }
  }

  // 从 episode 历史预测下一步候选
  const predictions = await predictNextAgentCalls(projectDir, {
    limit: DEFAULT_MAX_CANDIDATES_PER_TICK,
  })
  if (predictions.length === 0) {
    state.dropped_noPrediction++
    return 0
  }

  let launched = 0
  const cwd = process.cwd()

  for (const p of predictions.slice(0, DEFAULT_MAX_CANDIDATES_PER_TICK)) {
    // 已有 fresh shadow 条目就别重复跑
    const existing = getShadowResult(p.agentType, p.prompt, cwd)
    if (existing) {
      state.dropped_alreadyShadowed++
      continue
    }

    // 解析本条 prediction 要用的 adapter
    let chosenAdapter = fixedAdapter
    let chosenAgentName = agentName
    if (agentName === 'auto') {
      // per-prediction 路由:router 过滤掉不可用 adapter
      const decision = await routeExternalAgent({
        taskText: p.prompt,
        agentTypeHint: p.agentType,
      })
      if (!decision.chosen) {
        state.dropped_routerNoCandidate++
        continue
      }
      try {
        const { getAdapter } = await import(
          '../../tools/ExternalAgentDelegate/adapters/index.js'
        )
        chosenAdapter = getAdapter(decision.chosen)
      } catch (e) {
        state.lastError = `adapter import failed: ${(e as Error).message}`
        continue
      }
      if (!chosenAdapter) {
        state.dropped_unavailable++
        continue
      }
      chosenAgentName = decision.chosen
      state.routerAutoRoutes++
      logForDebugging(
        `[shadow-runner/auto] routed ${p.agentType} -> ${chosenAgentName} (${decision.reasoning})`,
      )
    }

    // 抢 speculation slot(与主 speculation 共用配额;非阻塞)
    const agentId = `shadow_${chosenAgentName}_${Date.now().toString(36)}`
    const estimatedTokens = Math.ceil((p.prompt?.length ?? 0) / 4)
    const slot = tryAcquireSlot('speculation', agentId, { estimatedTokens })
    if (!slot) {
      state.dropped_noSlot++
      continue
    }

    state.executed++
    launched++

    // chosenAdapter 在 auto/非 auto 两条路径上都已保证非 null
    const adapterToUse = chosenAdapter!
    // fire-and-forget;不阻塞 tick,让下一个候选或下一轮 tick 并发推进
    // #8 把 projectDir 透传到 runOneShadow,用于 episode 回填的文件定位
    void runOneShadow(adapterToUse, chosenAgentName, p.agentType, p.prompt, cwd, projectDir)
      .finally(() => {
        slot.release()
      })
  }

  return launched
}

// ── 单次子进程执行 ────────────────────────────────────────────

/**
 * 跑一次 Codex 子进程,把产出写进 shadowStore。
 * 所有异常在函数内吞掉,state 累加相应失败计数。
 */
async function runOneShadow(
  adapter: import('../../tools/ExternalAgentDelegate/types.js').ExternalAgentAdapter,
  sourceAgent: string,
  agentType: string,
  prompt: string,
  cwd: string,
  projectDir: string,
): Promise<void> {
  const startedAt = Date.now()

  // 惰性加载 session manager,避免顶层引用带出副作用
  const { ExternalAgentSessionManager } = await import(
    '../../tools/ExternalAgentDelegate/ExternalAgentSessionManager.js'
  )

  let session:
    | Awaited<ReturnType<typeof ExternalAgentSessionManager.create>>
    | null = null

  try {
    session = await ExternalAgentSessionManager.create(adapter, {
      agentType: sourceAgent,
      // 明确告诉 Codex 这是"参考性预跑",降低破坏性操作概率
      task: `[shadow-prerun] 以下是一个可能被用户发起的 agent 任务,请先给出你的参考方案(只读分析/思路);不要修改文件,不要创建分支。\n\nagent: ${agentType}\n任务描述:\n${prompt}`,
      cwd,
      env: {},
      timeout: DEFAULT_TASK_TIMEOUT_MS,
    })
  } catch (e) {
    state.completed_failed++
    state.lastError = `session create failed: ${(e as Error).message}`
    return
  }

  // 等待;waitForResult 本身带超时保护(双保险,session.start 内部也有)
  await session.waitForResult(DEFAULT_TASK_TIMEOUT_MS + 5000)

  const durationMs = Date.now() - startedAt
  const finishedAt = Date.now()

  let status: 'success' | 'failed' | 'timeout' = 'failed'
  let errorMessage: string | undefined = session.error
  if (session.status === 'completed') {
    status = 'success'
    errorMessage = undefined
    state.completed_success++
  } else if (session.status === 'running') {
    // waitForResult 超时 —— 主动停掉
    status = 'timeout'
    errorMessage = 'waitForResult timeout'
    state.completed_timeout++
    try {
      await session.stop()
    } catch {
      // 停进程失败不关心,主流程继续
    }
  } else {
    state.completed_failed++
  }

  const output = (session.result ?? '').trim()

  // 只要有输出就存;空 output 也记一条 failed,便于诊断
  putShadowResult(agentType, prompt, cwd, {
    sourceAgent,
    output,
    status,
    errorMessage,
    durationMs,
    finishedAt,
    tokens: session.tokens,
  })

  // 三链打通:成功且有产出 → 同步写入 contextFingerprint
  // key 粒度比 shadowStore 更粗(sourceAgent+cwd+taskPrefix),
  // 目的是"下一个同主题任务"也能通过 buildContextPrefix 继承本次结论,
  // 把 Codex 套餐闲置预跑的价值真正串联到后续主工作流。
  // 异常全部吞,不回滚 shadowStore 写入 —— 两条链路相互独立。
  if (status === 'success' && output) {
    try {
      putContextFingerprint(sourceAgent, cwd, prompt, {
        summary: output,
        tokens: session.tokens,
        finishedAt,
      })
      state.fingerprintWriteBacks++
    } catch (e) {
      logForDebugging(
        `[shadow-runner] fingerprint write-back failed: ${(e as Error).message}`,
      )
    }
  }

  // #8 shadow → episodic 回填:把这次 shadow 跑的结果做成 agent_run 样本
  // 追加到 episode 历史,让下一轮 predictNextAgentCalls 打分 + agentStats
  // 聚合也能看到它。不做同步等待 —— appendEpisode 内部已经吞掉 IO 错误。
  //
  //  outcome 映射:
  //    shadow 'success' → 'success'
  //    shadow 'failed'  → 'error'
  //    shadow 'timeout' → 'error'(时间异常,没有 'abort' 语义)
  //
  //  sessionId 用 'shadow_<sourceAgent>_<YYYYMMDD>' 分组:
  //    - 避免污染真实用户会话的 .jsonl 文件
  //    - predictNextAgentCalls 读 episodes/ 下全部 .jsonl,样本仍可被吸收
  //    - 按天分桶,单文件不会无限增长;配合 cleanupOldEpisodes 自然淘汰
  if (isShadowEpisodeWritebackEnabled() && projectDir) {
    try {
      const dateKey = new Date(finishedAt).toISOString().slice(0, 10).replace(/-/g, '')
      const syntheticSessionId = `shadow_${sourceAgent}_${dateKey}`
      const mappedOutcome: 'success' | 'error' =
        status === 'success' ? 'success' : 'error'
      const ep = createAgentRunEpisode({
        agentType,
        durationMs,
        outcome: mappedOutcome,
        priority: 'speculation',
        sessionId: syntheticSessionId,
        projectPath: projectDir,
        description: prompt,
        source: 'shadow',
      })
      // fire-and-forget —— appendEpisode 内部已 catch,外层不会抛
      void appendEpisode(projectDir, ep).then(() => {
        state.episodeWriteBacks++
      }).catch(e => {
        state.lastEpisodeError = (e as Error).message
      })
    } catch (e) {
      // createAgentRunEpisode 是纯构造,理论上不会抛;保守处理一下
      state.lastEpisodeError = (e as Error).message
      logForDebugging(
        `[shadow-runner] episode write-back failed: ${(e as Error).message}`,
      )
    }
  }

  // 清理 session 句柄(destroy 幂等;未 running 时为 no-op)
  try {
    await ExternalAgentSessionManager.destroy(session.id)
  } catch (e) {
    logForDebugging(`[shadow-runner] destroy session failed: ${(e as Error).message}`)
  }
}
