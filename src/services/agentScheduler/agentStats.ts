/**
 * AgentStats — 从情景记忆(episodicMemory)聚合出 per-agentType 运行统计。
 *
 * 设计目标:
 *   - 只读:不写 episode,不触发 API,聚合本地 .jsonl 文件
 *   - 零破坏:不改 scheduler.ts 的决策逻辑,只提供 getAgentStats API,
 *     由 policy 层(例如 scheduler.ts 中的自适应配额)按需查询
 *   - 带 TTL 缓存:扫盘成本低但非零,默认 30s 内复用上次聚合结果
 *
 * 数据来源:
 *   <projectDir>/episodes/*.jsonl 中的 type === 'agent_run' 事件
 *   字段从 tags 中解码(见 createAgentRunEpisode):
 *     tags = ['agent-run', 'agent:<type>', 'outcome:<success|abort|error>',
 *             'duration:<ms>', 'priority:<p>?']
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../utils/debug.js'
import type { Episode } from '../episodicMemory/episodicMemory.js'
import { createSnapshotStore } from '../snapshotStore/index.js'

// 单个 agentType 的聚合
export interface AgentStat {
  agentType: string
  totalRuns: number
  successRuns: number
  abortRuns: number
  errorRuns: number
  avgDurationMs: number
  p95DurationMs: number          // 95 分位耗时,用于配额决策(避免被偶发慢样本拉高)
  successRate: number            // [0, 1]
  lastRunAt: number              // 最近一次 run 的 timestamp
}

export interface AgentStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byAgentType: Record<string, AgentStat>
}

// ── 内存缓存(避免每次调用都扫盘) ────────────────────────────────
const DEFAULT_STATS_TTL_MS = 30 * 1000   // 30s
let statsCache: { snapshot: AgentStatsSnapshot; expiresAt: number } | null = null
let statsTTLMs = DEFAULT_STATS_TTL_MS
// 防止并发触发多次扫盘
let inflight: Promise<AgentStatsSnapshot> | null = null

// ── 可配置最大扫描样本数 —— 防止 episode 文件爆炸时卡住 ─────────
const DEFAULT_MAX_SAMPLES = 2000

/**
 * 从 tag 数组里查找形如 `prefix:value` 的值。
 * 多条匹配返回第一条。
 */
function readTag(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const needle = `${prefix}:`
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(needle)) {
      return t.slice(needle.length)
    }
  }
  return undefined
}

/**
 * 获取 <projectDir>/episodes 目录下所有 .jsonl 文件
 * 异步、失败时返回空数组。
 */
async function listEpisodeFiles(episodesDir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(episodesDir)
    return entries
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(episodesDir, f))
  } catch {
    return []
  }
}

/**
 * 读取单个 .jsonl 文件,返回 type === 'agent_run' 的事件数组。
 * 容错:损坏行跳过,整文件读失败返回空。
 */
async function loadAgentRunEpisodesFromFile(file: string): Promise<Episode[]> {
  try {
    const data = await fs.promises.readFile(file, 'utf-8')
    const lines = data.split('\n')
    const out: Episode[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      try {
        const ep = JSON.parse(line) as Episode
        if (ep && ep.type === 'agent_run') out.push(ep)
      } catch {
        // 损坏行 — 忽略
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 计算 p95 耗时。样本数 < 2 时退化为 avg。
 */
function computeP95(durations: number[]): number {
  if (durations.length === 0) return 0
  if (durations.length === 1) return durations[0]
  const sorted = [...durations].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.95)
  return sorted[Math.min(idx, sorted.length - 1)]
}

/**
 * 真正扫盘 + 聚合的实现,不带缓存。
 * 可被外部直接调用用于诊断/测试。
 */
export async function computeAgentStats(
  projectDir: string,
  opts: { maxSamples?: number } = {},
): Promise<AgentStatsSnapshot> {
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES
  const episodesDir = path.join(projectDir, 'episodes')
  const files = await listEpisodeFiles(episodesDir)

  // 按 mtime 降序(优先最近的文件),避免老文件占满采样配额
  const filesWithMtime: Array<{ file: string; mtime: number }> = []
  for (const file of files) {
    try {
      const st = await fs.promises.stat(file)
      filesWithMtime.push({ file, mtime: st.mtimeMs })
    } catch {
      // 忽略无法 stat 的文件
    }
  }
  filesWithMtime.sort((a, b) => b.mtime - a.mtime)

  // 聚合容器:agentType → 指标
  const buckets = new Map<string, {
    total: number
    success: number
    abort: number
    error: number
    durations: number[]
    lastRunAt: number
  }>()

  let totalSamples = 0

  for (const { file } of filesWithMtime) {
    if (totalSamples >= maxSamples) break
    const runs = await loadAgentRunEpisodesFromFile(file)
    for (const ep of runs) {
      if (totalSamples >= maxSamples) break
      const agentType = readTag(ep.tags, 'agent') ?? 'unknown'
      const outcome = readTag(ep.tags, 'outcome') ?? 'success'
      const durationStr = readTag(ep.tags, 'duration')
      const duration = durationStr ? Number(durationStr) : NaN

      let bucket = buckets.get(agentType)
      if (!bucket) {
        bucket = { total: 0, success: 0, abort: 0, error: 0, durations: [], lastRunAt: 0 }
        buckets.set(agentType, bucket)
      }

      bucket.total++
      if (outcome === 'success') bucket.success++
      else if (outcome === 'abort') bucket.abort++
      else bucket.error++

      if (Number.isFinite(duration) && duration >= 0) {
        bucket.durations.push(duration)
      }
      if (ep.timestamp > bucket.lastRunAt) bucket.lastRunAt = ep.timestamp

      totalSamples++
    }
  }

  // 转成输出结构
  const byAgentType: Record<string, AgentStat> = {}
  for (const [agentType, b] of buckets) {
    const avg =
      b.durations.length > 0
        ? b.durations.reduce((a, c) => a + c, 0) / b.durations.length
        : 0
    byAgentType[agentType] = {
      agentType,
      totalRuns: b.total,
      successRuns: b.success,
      abortRuns: b.abort,
      errorRuns: b.error,
      avgDurationMs: Math.round(avg),
      p95DurationMs: Math.round(computeP95(b.durations)),
      successRate: b.total > 0 ? b.success / b.total : 0,
      lastRunAt: b.lastRunAt,
    }
  }

  return {
    generatedAt: Date.now(),
    totalSamples,
    byAgentType,
  }
}

/**
 * 带缓存的入口 — 外部首选 API。
 * 并发调用共享同一次扫盘。
 *
 * 持久化副作用:每次完整 compute 结束(无论是否 force)都 fire-and-forget
 * 写一次快照到 <projectDir>/snapshots/agent-stats.json。写盘任何异常都会
 * 被 snapshotStore 内部吞掉,绝不影响主路径。
 */
export async function getAgentStats(
  projectDir: string,
  opts: { force?: boolean; maxSamples?: number } = {},
): Promise<AgentStatsSnapshot> {
  const now = Date.now()
  if (!opts.force && statsCache && statsCache.expiresAt > now) {
    return statsCache.snapshot
  }
  if (inflight) return inflight

  inflight = computeAgentStats(projectDir, opts)
    .then(snapshot => {
      statsCache = { snapshot, expiresAt: Date.now() + statsTTLMs }
      // fire-and-forget:把最新聚合结果落盘供下次冷启动秒开
      void agentStatsSnapshotStore.saveNow(projectDir)
      return snapshot
    })
    .catch(err => {
      logForDebugging(`[agentStats] compute failed: ${(err as Error).message}`)
      // 失败时返回一个空快照,避免上层抛错
      const fallback: AgentStatsSnapshot = {
        generatedAt: Date.now(),
        totalSamples: 0,
        byAgentType: {},
      }
      return fallback
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

/**
 * 同步读取内存缓存里最近一次的快照,供 UI 层直接消费(避免 Promise 链)。
 * 与 getAgentStats 的区别:
 *   - 不触发扫盘;即使 TTL 过期也返回最近快照(UI 可容忍陈旧几秒)
 *   - 无缓存时返回 null
 * 后台 driver(background.ts)会定期刷新缓存,UI 下一帧即可见。
 */
export function getCachedAgentStatsSnapshot(): AgentStatsSnapshot | null {
  return statsCache ? statsCache.snapshot : null
}

/**
 * 清除内存缓存 — 用于测试或热重置。
 */
export function clearAgentStatsCache(): void {
  statsCache = null
}

/**
 * 调整 stats 缓存的 TTL(供上层热配置)
 */
export function setAgentStatsCacheTTL(ttlMs: number): void {
  if (Number.isFinite(ttlMs) && ttlMs >= 0) {
    statsTTLMs = ttlMs
  }
}

// ── 跨会话持久化(#2 AgentStat 持久化) ─────────────────────
//
// 为什么持久化聚合快照而非原始 episodes:
//   - 冷启动扫 .jsonl 需要 O(files + samples) 时间;项目跑久了 episode 文件
//     会堆积,启动瞬间的 CPU spike 会让 UI 感知明显的卡顿
//   - 原始 episodes 已经由 episodicMemory 负责落盘,这里如果再存一份原始数据
//     是重复信息。只持久化"最近一次聚合结果"即可 —— 冷启动立刻可用,后台
//     tick 会在 30s 内刷新到最新
//
// 行为:
//   - hydrate:从 <projectDir>/snapshots/agent-stats.json 读快照,塞进 statsCache
//     (TTL 被强制设成 0 —— 让 background.ts 下次 tick 立即覆盖为最新值)
//   - persist:把当前 statsCache.snapshot 写盘(没有缓存就 no-op)
//
// 注:schemaVersion=1。若 AgentStat / AgentStatsSnapshot 字段结构变化需要
//     bump version,旧文件会被自动忽略,不会破坏冷启动。

const AGENT_STATS_NAMESPACE = 'agent-stats'
const AGENT_STATS_SCHEMA_VERSION = 1

const agentStatsSnapshotStore = createSnapshotStore<AgentStatsSnapshot>({
  namespace: AGENT_STATS_NAMESPACE,
  schemaVersion: AGENT_STATS_SCHEMA_VERSION,
  getSnapshot: () => (statsCache ? statsCache.snapshot : null),
  applySnapshot: snap => {
    // 回填时 expiresAt=0,强制下次调用 getAgentStats 触发 force refresh,
    // 避免旧快照无限期霸占缓存。期间 UI 拿到的是 stale-but-fast 数据。
    statsCache = { snapshot: snap, expiresAt: 0 }
  },
})

/**
 * 冷启动:尝试从上次落盘恢复聚合快照。
 * - 无文件 / schema 不匹配 / 损坏 → 返回 false,不影响后续扫盘
 * - 成功 → statsCache 被填充,getCachedAgentStatsSnapshot() 立即返回历史数据
 *
 * 建议由上层在 startAgentSchedulerBackground 前后调用一次。
 */
export async function hydrateAgentStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentStatsSnapshotStore.loadNow(projectDir)
}

/**
 * 把当前 statsCache.snapshot 落盘。适合挂在 periodicMaintenance 的 tick 尾部。
 * - 没有 snapshot 时直接返回 false(不会写空文件)
 * - 原子写 + 吞错:从不抛异常
 */
export async function persistAgentStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentStatsSnapshotStore.saveNow(projectDir)
}

/** 测试/重置用:删除磁盘上的聚合快照文件。吞错。 */
export async function deleteAgentStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentStatsSnapshotStore.deleteNow(projectDir)
}
