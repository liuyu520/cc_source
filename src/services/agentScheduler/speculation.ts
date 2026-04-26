/**
 * P3 推测执行(speculation pre-run)
 *
 * 核心思路:
 *   - scheduler 已经定义 speculation=2 优先级和独立 quota(默认 1),但无人使用
 *   - cache 已有两级 LRU(字面量 + 签名),但只在"二次相同调用"时受益
 *   - 空转的 speculation 配额 + 冷启的缓存 = 明显浪费
 *
 * 动作:基于 episode 历史预测"下一个用户最可能触发的 agent 调用",
 *       在 speculation quota 闲时预跑,结果预置到 cache。真实调用命中则
 *       首字节零延迟;不命中静默 drop。
 *
 * 分层:
 *   Layer 1  predictNextAgentCalls:纯函数,读 episode 算 top-N 候选
 *   Layer 2  runner registry:上层(通常是 REPL)注册"如何跑一个 agent"
 *   Layer 3  maybeRunSpeculation:调度 + runner + 缓存预置,fire-and-forget
 *
 * 关键约束:
 *   - 严格 non-blocking(tryAcquireSlot):资源紧张时立即 drop
 *   - runner 未注册时整条链路 no-op(上层 opt-in)
 *   - env CLAUDE_CODE_SPECULATION=1 总开关,默认关闭
 *   - 不做任何写盘/改 agentMemory 副作用 — 只读 episodes + 写 cache
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../utils/debug.js'
import type { Episode } from '../episodicMemory/episodicMemory.js'
import { computePromptSignature, isSpeculationSeeded, setCachedResult } from './cache.js'
import { getSchedulerState, tryAcquireSlot } from './scheduler.js'

// ── 类型 ────────────────────────────────────────────────────

export interface SpeculationPrediction {
  agentType: string
  /** 用户历史 prompt(episode.content)—— 用作预跑 prompt,命中就直接复用 */
  prompt: string
  /** 预期命中的 cache 签名键,供诊断 */
  signature: string
  /** 综合分 = 近期频率 × 成功率 / max(1, p95sec) */
  score: number
  /** 这个 (agentType, prompt prefix) 在近期出现的次数 */
  samples: number
  /** 最近一次出现时间戳 */
  lastSeenAt: number
}

export interface SpeculationState {
  enabled: boolean
  runnerRegistered: boolean
  attempts: number
  executed: number
  dropped_noSlot: number
  dropped_alreadyCached: number
  dropped_noPrediction: number
  dropped_runnerError: number
  hits: number             // 真实调用命中 speculation 预置结果的次数
}

/** runner 签名:agent 预跑执行器(上层注入,通常由 REPL 层提供 AgentTool 封装) */
export type SpeculationRunner = (
  prediction: SpeculationPrediction,
  signal: AbortSignal,
) => Promise<unknown>

/**
 * P4 推测模式:
 *   - 'full' (默认):runner 跑完整 agent,结果写入本地 cache,真实调用复用
 *   - 'warm':runner 只做 provider 侧 KV prefix 预热(如 Anthropic cache_control)
 *            结果不写入本地 cache(内容未必完整,写入反而降命中率)
 *
 * 用 warm 的场景:provider 支持 prefix cache(first-party Anthropic / Bedrock / Vertex),
 * 节省真实调用的首字节延迟 + 重复前缀 token 成本。
 * MiniMax 等当前不支持 cache_control,warm 模式退化为"白跑一次"—— 用 speculation
 * quota(本来就闲置)换零收益,由 env 显式开启,默认不开。
 */
export type SpeculationMode = 'full' | 'warm'

// ── 状态 ────────────────────────────────────────────────────

let runner: SpeculationRunner | null = null
const state: SpeculationState = {
  enabled: false,
  runnerRegistered: false,
  attempts: 0,
  executed: 0,
  dropped_noSlot: 0,
  dropped_alreadyCached: 0,
  dropped_noPrediction: 0,
  dropped_runnerError: 0,
  hits: 0,
}

// ── 开关 ────────────────────────────────────────────────────

/**
 * 是否启用推测执行。默认关闭 —— CLAUDE_CODE_SPECULATION=1 才开。
 */
export function isSpeculationEnabled(): boolean {
  const enabled = process.env.CLAUDE_CODE_SPECULATION === '1'
  state.enabled = enabled
  return enabled
}

/**
 * 读取推测模式。默认 'full'(向后兼容 P3 的行为)。
 * env CLAUDE_CODE_SPECULATION_MODE=warm 切换为 KV 预热模式。
 * 非法值静默降级为 'full',避免误配置炸裂。
 */
export function getSpeculationMode(): SpeculationMode {
  const raw = (process.env.CLAUDE_CODE_SPECULATION_MODE ?? '').toLowerCase()
  return raw === 'warm' ? 'warm' : 'full'
}

// ── Runner 注册 ────────────────────────────────────────────

/**
 * 注册一个 runner —— 通常由 REPL/bootstrap 层提供,能用 AgentTool 异步
 * 路径真实执行一个 agent,返回其输出。未注册时所有 speculation 调用 no-op。
 */
export function registerSpeculationRunner(r: SpeculationRunner): void {
  runner = r
  state.runnerRegistered = true
}

export function unregisterSpeculationRunner(): void {
  runner = null
  state.runnerRegistered = false
}

// ── 冷启动候选 Provider (DI hook for #5) ────────────────────

/**
 * 冷启动候选 provider。episode 预测为空时的兜底源(通常是 coldStart.ts)。
 * 设计为 DI hook,避免 speculation 直接依赖 coldStart,保持
 * predictNextAgentCalls 的纯函数语义。
 */
export type ColdStartPredictionProvider = () => SpeculationPrediction | null

let coldStartProvider: ColdStartPredictionProvider | null = null

export function setColdStartProvider(p: ColdStartPredictionProvider | null): void {
  coldStartProvider = p
}

// ── Prediction Engine (Layer 1) ────────────────────────────

/**
 * 读取单个 episode 文件的 agent_run 事件。容错:单行坏 JSON 跳过。
 */
async function readAgentRunsFromFile(file: string): Promise<Episode[]> {
  try {
    const data = await fs.promises.readFile(file, 'utf-8')
    const out: Episode[] = []
    for (const line of data.split('\n')) {
      if (line.length === 0) continue
      try {
        const ep = JSON.parse(line) as Episode
        if (ep?.type === 'agent_run') out.push(ep)
      } catch {
        // skip corrupt line
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 读 tag:outcome / duration / agent — 与 agentStats 同格式,保持单一解码源。
 */
function readTag(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const needle = `${prefix}:`
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(needle)) return t.slice(needle.length)
  }
  return undefined
}

/**
 * 基于 episode 历史给出 top-N 推测候选。
 *
 * 聚合键 = (agentType, descriptionPrefix)。prefix 用于区分"同一 agent
 * 被用在不同任务上",避免把近期所有 Explore 合成一个候选。
 *
 * 分值 = 近期样本数(频率代理)× 成功率 / max(1, p95秒)。
 * p95 太长的 agent 预跑性价比差(真跑完用户可能都没问) → 给分权削弱。
 */
export async function predictNextAgentCalls(
  projectDir: string,
  opts: { limit?: number; maxSamples?: number; descriptionPrefixLen?: number } = {},
): Promise<SpeculationPrediction[]> {
  const limit = Math.max(1, opts.limit ?? 3)
  const maxSamples = Math.max(50, opts.maxSamples ?? 500)
  const prefixLen = Math.max(20, opts.descriptionPrefixLen ?? 60)

  const episodesDir = path.join(projectDir, 'episodes')
  let files: string[]
  try {
    files = (await fs.promises.readdir(episodesDir))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(episodesDir, f))
  } catch {
    return []
  }

  // 按 mtime 倒序读(最近文件先扫)
  const withStat: Array<{ file: string; mtime: number }> = []
  for (const f of files) {
    try {
      const st = await fs.promises.stat(f)
      withStat.push({ file: f, mtime: st.mtimeMs })
    } catch {
      // ignore
    }
  }
  withStat.sort((a, b) => b.mtime - a.mtime)

  // 聚合:agentType|descPrefix → 统计
  interface Bucket {
    agentType: string
    prompt: string            // 首次见到的完整 description(上限 300,episode.content 已截)
    samples: number
    success: number
    durations: number[]
    lastSeenAt: number
  }
  const buckets = new Map<string, Bucket>()
  let total = 0

  outer: for (const { file } of withStat) {
    const runs = await readAgentRunsFromFile(file)
    for (const ep of runs) {
      if (total >= maxSamples) break outer
      total++
      const agentType = readTag(ep.tags, 'agent') ?? 'unknown'
      if (!agentType || agentType === 'unknown') continue

      const description = (ep.content ?? '').trim()
      if (description.length === 0) continue  // 无 description 的 episode 没预测价值

      const prefix = description.slice(0, prefixLen).toLowerCase()
      const bucketKey = `${agentType}|${prefix}`
      const outcome = readTag(ep.tags, 'outcome') ?? 'success'
      const durMs = Number(readTag(ep.tags, 'duration') ?? '0') || 0

      let b = buckets.get(bucketKey)
      if (!b) {
        b = {
          agentType,
          prompt: description,
          samples: 0,
          success: 0,
          durations: [],
          lastSeenAt: 0,
        }
        buckets.set(bucketKey, b)
      }
      b.samples++
      if (outcome === 'success') b.success++
      if (durMs > 0) b.durations.push(durMs)
      if (ep.timestamp > b.lastSeenAt) b.lastSeenAt = ep.timestamp
    }
  }

  // 打分 + 排序
  const cwd = process.cwd()
  const predictions: SpeculationPrediction[] = []
  for (const b of buckets.values()) {
    if (b.samples < 2) continue  // 只出现过一次的不预测(噪声)
    const successRate = b.samples > 0 ? b.success / b.samples : 0
    const p95Sec = computeP95Ms(b.durations) / 1000
    const score = (b.samples * successRate) / Math.max(1, p95Sec)
    predictions.push({
      agentType: b.agentType,
      prompt: b.prompt,
      signature: computePromptSignature(b.agentType, b.prompt, cwd),
      score,
      samples: b.samples,
      lastSeenAt: b.lastSeenAt,
    })
  }

  predictions.sort((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
  return predictions.slice(0, limit)
}

function computeP95Ms(durations: number[]): number {
  if (durations.length === 0) return 0
  if (durations.length === 1) return durations[0]
  const sorted = [...durations].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.95)
  return sorted[Math.min(idx, sorted.length - 1)]
}

// ── 执行层 (Layer 3) ──────────────────────────────────────

/**
 * 尝试跑一次推测执行。返回最终状态字符串,供诊断/日志。
 *
 * 流程:
 *   1. 功能开关 off → 'disabled'
 *   2. runner 未注册 → 'no-runner'(静默,上层尚未 opt-in)
 *   3. predict 无候选 → 'no-prediction'
 *   4. cache 已有该签名 → 'already-cached'(跳过不浪费 slot)
 *   5. tryAcquireSlot('speculation') null → 'no-slot'
 *   6. runner 执行 → 成功则 setCachedResult({speculation: true});失败 drop
 */
export async function maybeRunSpeculation(
  projectDir: string,
  opts: { abortSignal?: AbortSignal } = {},
): Promise<
  | 'disabled'
  | 'no-runner'
  | 'no-prediction'
  | 'already-cached'
  | 'no-slot'
  | 'executed'
  | 'runner-error'
> {
  if (!isSpeculationEnabled()) return 'disabled'
  state.attempts++

  if (!runner) {
    // 不计入 dropped:这是配置状态,不是调度失败
    return 'no-runner'
  }

  const predictions = await predictNextAgentCalls(projectDir, { limit: 1 })
  let top: SpeculationPrediction | undefined = predictions[0]
  // #5 冷启动:episode 历史为空时,回退到 coldStart provider 注入的候选
  if (!top && coldStartProvider) {
    try {
      const fallback = coldStartProvider()
      if (fallback) {
        top = fallback
        logForDebugging(
          `[speculation] cold-start fallback used: ${fallback.agentType}`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[speculation] coldStartProvider error: ${(e as Error).message}`,
      )
    }
  }
  if (!top) {
    state.dropped_noPrediction++
    return 'no-prediction'
  }

  // 已经 cached 不必再跑
  if (isSpeculationSeeded(top.agentType, top.prompt, process.cwd())) {
    state.dropped_alreadyCached++
    return 'already-cached'
  }

  // 非阻塞抢 speculation slot
  // P5:预估 token,若开启 budget 限流,prompt 过大也会被拒(零配置时忽略)
  const agentId = `spec_${Date.now().toString(36)}`
  const estimatedTokens = Math.ceil((top.prompt?.length ?? 0) / 4)
  const slot = tryAcquireSlot('speculation', agentId, { estimatedTokens })
  if (!slot) {
    state.dropped_noSlot++
    return 'no-slot'
  }

  const abortController = new AbortController()
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      slot.release()
      return 'runner-error'
    }
    opts.abortSignal.addEventListener('abort', () => abortController.abort(), {
      once: true,
    })
  }

  try {
    const result = await runner(top, abortController.signal)
    // P4:warm 模式下只是为了暖 provider 侧 KV cache,runner 返回物可能是
    // 残缺/占位值(例如 max_tokens=1 的响应),写入本地 cache 反而会拖累
    // 真实调用的正确性。只有 full 模式才 setCachedResult。
    const mode = getSpeculationMode()
    if (mode === 'full') {
      setCachedResult(top.agentType, top.prompt, process.cwd(), result, {
        speculation: true,
      })
    }
    state.executed++
    logForDebugging(
      `[speculation] executed (${mode}): ${top.agentType} (score=${top.score.toFixed(2)}, samples=${top.samples})`,
    )
    return 'executed'
  } catch (err) {
    state.dropped_runnerError++
    logForDebugging(
      `[speculation] runner failed: ${(err as Error).message}`,
    )
    return 'runner-error'
  } finally {
    slot.release()
  }
}

// ── 观测 ────────────────────────────────────────────────────

/**
 * 真实 AgentTool 调用命中 cache 时调用,判定此次命中是否由 speculation 预置。
 * 命中则 hits++。调用方可用 isSpeculationSeeded 自行判定后传 true。
 */
export function recordSpeculationHit(): void {
  state.hits++
}

/**
 * 快照推测执行当前状态 —— 用于诊断或 /status 面板。
 */
export function getSpeculationState(): SpeculationState {
  // scheduler 状态也合入一下,方便调参时观察 slot 利用
  const sched = getSchedulerState()
  return {
    ...state,
    enabled: isSpeculationEnabled(),
    runnerRegistered: runner !== null,
    // dropped_noSlot 之外也暴露当前 speculation slot 用量(辅助信息)
    // 这里只返回基础 state;scheduler state 由调用方自行再查
    ...(sched.quotaUsage.speculation > 0
      ? { /* 无额外字段,保留纯数据结构 */ }
      : {}),
  }
}

/**
 * 重置 speculation 统计 —— 供测试使用。不影响 runner 注册。
 */
export function resetSpeculationState(): void {
  state.attempts = 0
  state.executed = 0
  state.dropped_noSlot = 0
  state.dropped_alreadyCached = 0
  state.dropped_noPrediction = 0
  state.dropped_runnerError = 0
  state.hits = 0
}
