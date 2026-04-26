/**
 * autoEvolve(v1.0) — Phase 33:Arena scheduler(多 worktree 智能调度)
 *
 * 目的
 * ────
 * Phase 30 给了 `spawnOrganismWorktreesBatch`,但 id 顺序完全由调用方决定 ——
 * 用户自己 `/evolve-arena --spawn a b c d e f g h` 时 FIFO,没有"谁最值得先跑"
 * 的概念。Phase 33 在 shadow/ 池上加一层 breadth-first 的优先级排序,让
 * scheduler 优先挑:
 *
 *   1. 没跑过 / 跑的 shadow trials 最少的 organism(广度优先,别浪费算力
 *      在已经确认好或坏的同一个 id 上);
 *   2. lastTrialAt 最旧 / 从未 trial 的(避免新生 organism 永远 starve);
 *   3. 年龄更老的(createdAt 越早 → TTL 越紧迫);
 *   4. Phase 32 kinSeed 已命中的轻微提权(有近亲 body → 更像能很快 converge)。
 *
 * 设计
 * ────
 *  - **纯读 + 纯函数**:只扫 shadow/ 下的 manifest,不动磁盘,不依赖
 *    CLAUDE_EVOLVE_ARENA,任何时候都可以 audit 优先队列。
 *  - **分数是单一标量 + components**:调用方(比如 /evolve-arena --schedule)
 *    能拆出 trials/ageDays/stale/kinSeed 四个分量,便于用户理解排序原因。
 *  - **不绑到 spawn 动作**:scheduler 只返回排好序的候选,spawn 走不走
 *    Phase 30 的 batch API 由上层决定(/evolve-arena 会在 --spawn-auto N
 *    里把 top N 喂给 spawnOrganismWorktreesBatch)。
 *  - **可选过滤**:
 *      - excludeActiveWorktree(默认 true):如果 arena/worktrees/<id>/
 *        已经存在,跳过它(别重复 spawn),需要导入 Phase 30 的
 *        listActiveArenaWorktrees。
 *      - maxShadowTrials:shadowTrials 已经 ≥ 该值的 organism 视为
 *        "已经跑够",不再优先,方便把算力让给新生 organism。
 *  - **反作弊**:排序稳定 —— tie-break 走 id 字典序,保证同样的
 *    shadow/ 状态下每次调 `listShadowPriority` 返回同一顺序(reproducible)。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { getArenaWorktreesDir } from '../paths.js'
import {
  listActiveArenaWorktrees,
  listOrganismIds,
  readOrganism,
  type OrganismStatus,
} from './arenaController.js'
import type { OrganismManifest } from '../types.js'

// ── 优先级分量 ─────────────────────────────────────────────
// 四个分量都 clamp 到 [0, 1],再线性加权汇总到 priority ∈ [0, 1]。
// 权重经验值:breadth-first 主导(trials 0 最重要),其次 stale,再年龄,
// 最后 kinSeed 只给小幅提权(不让 kin-seeded organism 一直抢资源)。
const W_TRIALS = 0.45
const W_STALE = 0.3
const W_AGE = 0.15
const W_KIN = 0.1

// 一个 organism 跑了多少 trials 就算"跑够了":超过这个值,trials 分量直接 0
const TRIALS_FULL = 10
// lastTrialAt 多久算 stale(从未 trial 也视为完全 stale)
const STALE_FULL_DAYS = 14
// createdAt 多久算老到必须优先(shadow TTL 30 天,14 天过半就该优先)
const AGE_FULL_DAYS = 14

export interface PriorityComponents {
  trials: number
  stale: number
  age: number
  kin: number
}

export interface PriorityEntry {
  id: string
  priority: number
  components: PriorityComponents
  /** 排序附带的 manifest 摘要 —— 下游表格打印不用再读一次磁盘 */
  summary: {
    shadowTrials: number
    lastTrialAt: string | null
    createdAt: string
    kinSeed: OrganismManifest['kinSeed']
    name: string
    kind: OrganismManifest['kind']
    ageDays: number
    staleDays: number | null
  }
  /** 是否已有活跃 worktree(被 excludeActiveWorktree 跳过的也会出现在返回值里并标记,方便审计) */
  activeWorktree: boolean
}

export interface ListShadowPriorityOptions {
  /** 默认 true:剔除已经存在 arena 活跃 worktree 的 id */
  excludeActiveWorktree?: boolean
  /**
   * organism shadowTrials 达到该阈值后优先级会归零(不再调度)。
   * 默认等于 TRIALS_FULL;外部可以覆盖成一个更严的值,进一步让 arena
   * 把 slot 留给新生 organism。
   */
  maxShadowTrials?: number
  /** 只返回前 N 项。undefined=全返回(已排序) */
  topN?: number
}

// ── 时间工具 ─────────────────────────────────────────────
function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const ms = Date.now() - t
  if (ms < 0) return 0 // 未来时间戳 → 当作刚发生
  return ms / (1000 * 60 * 60 * 24)
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/**
 * 给 shadow manifest 打分(纯函数,无磁盘 IO)。
 * 调用方应该先保证 manifest 确实来自 shadow/ 目录(否则分数语义漂移)。
 */
export function scoreShadowPriority(
  manifest: OrganismManifest,
  opts?: { maxShadowTrials?: number },
): { priority: number; components: PriorityComponents } {
  const maxTrials = opts?.maxShadowTrials ?? TRIALS_FULL
  // trials 分量:0 trials → 1.0;TRIALS_FULL trials → 0;之间线性
  const trials = manifest.fitness?.shadowTrials ?? 0
  const trialsComp =
    trials >= maxTrials ? 0 : clamp01(1 - trials / maxTrials)

  // stale 分量:lastTrialAt=null → 1.0(从未 trial,必须先跑);有 → 按天线性饱和
  const staleDaysRaw = daysSince(manifest.fitness?.lastTrialAt ?? null)
  const staleComp =
    staleDaysRaw === null ? 1 : clamp01(staleDaysRaw / STALE_FULL_DAYS)

  // age 分量:createdAt 越老越该优先(TTL 快到了);clamp 到 AGE_FULL_DAYS
  const ageDaysRaw = daysSince(manifest.createdAt) ?? 0
  const ageComp = clamp01(ageDaysRaw / AGE_FULL_DAYS)

  // kin 分量:命中 Phase 32 kinSeed 的 organism 略微提权(假设近亲 body 让它更快 converge)
  // null(显式关闭)/undefined(未命中 or 旧 manifest)都给 0
  const kinComp = manifest.kinSeed && typeof manifest.kinSeed === 'object' ? 1 : 0

  const priority =
    W_TRIALS * trialsComp +
    W_STALE * staleComp +
    W_AGE * ageComp +
    W_KIN * kinComp

  return {
    priority,
    components: {
      trials: trialsComp,
      stale: staleComp,
      age: ageComp,
      kin: kinComp,
    },
  }
}

/** 读一次活跃 worktree id set(忽略任何 error,给空 set,保留纯只读承诺) */
function readActiveWorktreeIds(): Set<string> {
  const out = new Set<string>()
  try {
    if (!existsSync(getArenaWorktreesDir())) return out
    for (const w of listActiveArenaWorktrees()) out.add(w.id)
  } catch {
    /* ignore */
  }
  return out
}

/**
 * 列 shadow/ 下所有 organism 的优先级排序。
 * 返回总是一个稳定的快照(tie-break 走 id 字典序)。
 */
export function listShadowPriority(
  opts?: ListShadowPriorityOptions,
): PriorityEntry[] {
  const excludeActive = opts?.excludeActiveWorktree !== false
  const maxShadowTrials = opts?.maxShadowTrials
  const activeIds = excludeActive ? readActiveWorktreeIds() : new Set<string>()

  const shadowIds = listOrganismIds('shadow' satisfies OrganismStatus)
  const entries: PriorityEntry[] = []
  for (const id of shadowIds) {
    const manifest = readOrganism('shadow' satisfies OrganismStatus, id)
    if (!manifest) continue
    const activeW = activeIds.has(id)
    if (excludeActive && activeW) {
      // 仍然不进 entries(上面的 activeIds.has 已经判断),但为了下游能
      // 审计到"被跳过了哪些 id",我们在一个独立 branch 里额外装回:
      // 没有 excludeActive 时不会走这里;有 excludeActive 时就是跳过。
      // 所以这里纯 continue 足够。
      continue
    }
    const { priority, components } = scoreShadowPriority(manifest, {
      maxShadowTrials,
    })
    const staleDays = daysSince(manifest.fitness?.lastTrialAt ?? null)
    const ageDays = daysSince(manifest.createdAt) ?? 0
    entries.push({
      id,
      priority,
      components,
      summary: {
        shadowTrials: manifest.fitness?.shadowTrials ?? 0,
        lastTrialAt: manifest.fitness?.lastTrialAt ?? null,
        createdAt: manifest.createdAt,
        kinSeed: manifest.kinSeed,
        name: manifest.name,
        kind: manifest.kind,
        ageDays,
        staleDays,
      },
      activeWorktree: activeW,
    })
  }

  // 降序排序(优先级高的在前);tie-break:id 字典序升序(稳定可复现)
  entries.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.id.localeCompare(b.id)
  })

  if (typeof opts?.topN === 'number' && opts.topN > 0) {
    return entries.slice(0, opts.topN)
  }
  return entries
}

/**
 * 方便调用方一次性拿到排好序的 id 列表(不带 summary)。
 * /evolve-arena --spawn-auto N 会用这个接口喂给 Phase 30 的 spawn batch。
 */
export function pickNextShadowIds(
  count: number,
  opts?: ListShadowPriorityOptions,
): string[] {
  if (!Number.isFinite(count) || count <= 0) return []
  return listShadowPriority({ ...opts, topN: Math.floor(count) }).map(e => e.id)
}
