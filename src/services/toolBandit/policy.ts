/**
 * G3 Step 3 — tool-bandit policy(shadow-only 推荐层)
 * -----------------------------------------------------------------
 *
 * 目的
 *   在 Step 1/2 的 reward ledger 之上加一层"若我是 bandit 会选哪个"的推荐,
 *   专门输出 ghost recommendation(见 ghostLog),不改真实工具选择。
 *
 * 策略
 *   - ε-greedy:以概率 ε 随机均匀选;否则选 24h 窗内 avgReward 最高者。
 *     ε 默认 0.1,env `CLAUDE_TOOL_BANDIT_EPSILON`(0..1)可调,解析失败走默认。
 *   - avgReward 基于既有 reward ledger 聚合:success=+1 / error=-1 / abort=-0.5
 *     (mapOutcomeToReward 已固化,不要重复写)。
 *   - 冷启动:count < COLD_START_MIN(默认 3)的 candidate 给 neutral=0 做平滑,
 *     防止稀疏样本下单条 error 就被永久打入冷宫。
 *   - 纯函数:recommendTool 接受 `{candidates, ledgerRows, epsilon?, rng?}`,
 *     probe 测试直接注入伪随机 + 伪 ledger。
 *
 * 非目标(要点明)
 *   - 不动真实 tool 选择;不写 system prompt override;不改调度。
 *   - 不做 context-aware(file size / repo size)—— 留给 Step 5+,当前 Step
 *     只验证"basic ε-greedy + ledger 聚合"能跑通且输出稳定。
 *   - 这里不 append ledger;ghost 写盘全部走 ghostLog.ts。
 */

import { readFileSync, statSync } from 'node:fs'
import { getToolBanditRewardLedgerPath } from '../autoEvolve/paths.js'

/** ε 默认值;env 未设或解析失败时使用 */
const DEFAULT_EPSILON = 0.1
/** 冷启动阈值 —— count 低于此数的 candidate 以 neutral 0 分数参与比较 */
const COLD_START_MIN = 3
/** 24h 窗口(ms)—— 与 healthSummary/rewardLedger 一致 */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
/** 防御:读 ledger 最多扫多少行(尾部 tail,避免巨大文件拖慢 shadow 路径) */
const MAX_READ_ROWS = 5000

/** 单条 reward ledger 原始行 —— 只列我们真正用到的字段 */
export interface RewardRow {
  at?: string
  toolName?: string
  reward?: number
}

/** 单工具 24h 窗内汇总(policy 决策基础) */
export interface ToolScore {
  toolName: string
  count: number
  avgReward: number
  /** 是否已跨冷启动阈值,未跨用 neutralScore */
  warm: boolean
  /** 输入到 argmax 的最终分(冷启动=0,warm=avgReward) */
  effectiveScore: number
}

/** recommendTool 返回结构 —— 同样喂给 ghost ledger payload */
export interface RecommendResult {
  pick: string
  reason: 'explore' | 'exploit' | 'cold-start-tie' | 'no-data'
  epsilon: number
  candidates: ToolScore[]
  /** 仅 exploit 时有值:第一名与第二名分数差,ghost 用于"regret 强度"指标 */
  scoreGap?: number
}

/** 读取 env ε,解析失败返回 DEFAULT_EPSILON */
export function readEpsilonFromEnv(raw?: string): number {
  const s = (raw ?? process.env.CLAUDE_TOOL_BANDIT_EPSILON ?? '').trim()
  if (!s) return DEFAULT_EPSILON
  const v = Number(s)
  if (!Number.isFinite(v) || v < 0 || v > 1) return DEFAULT_EPSILON
  return v
}

/**
 * 从 reward ledger 尾部读 rows,过滤 24h 窗内且 toolName 命中 candidates 的行。
 *
 * fail-open:任何 IO/parse 异常返回空数组,上层退化为 no-data。
 */
export function readRecentRewardRows(opts?: {
  now?: number
  windowMs?: number
  maxRows?: number
  path?: string
}): RewardRow[] {
  const now = opts?.now ?? Date.now()
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS
  const maxRows = opts?.maxRows ?? MAX_READ_ROWS
  const path = opts?.path ?? getToolBanditRewardLedgerPath()
  try {
    const st = statSync(path)
    if (!st.isFile()) return []
    const text = readFileSync(path, 'utf8')
    // 按行切;尾部裁剪 maxRows,避免历史巨大文件 parse 放大。
    const lines = text.split('\n')
    const tail = lines.slice(Math.max(0, lines.length - maxRows - 1))
    const out: RewardRow[] = []
    for (const line of tail) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line) as RewardRow
        if (!row || typeof row !== 'object') continue
        if (!row.at || !row.toolName) continue
        const t = Date.parse(row.at)
        if (!Number.isFinite(t) || now - t > windowMs) continue
        out.push(row)
      } catch {
        /* skip 损坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 按 candidates 聚合 24h rows,计算 effectiveScore。
 *
 * - count < COLD_START_MIN 视为冷启动,effectiveScore = 0(neutral)。
 * - warm 的 effectiveScore = avgReward。
 * - 未在 rows 中出现的 candidate 以 count=0/warm=false/effective=0 填充,
 *   保持 scores.length === candidates.length,便于 ghost 记录。
 */
export function aggregateScores(
  candidates: string[],
  rows: RewardRow[],
): ToolScore[] {
  const buckets = new Map<string, { sum: number; count: number }>()
  for (const name of candidates) buckets.set(name, { sum: 0, count: 0 })
  for (const r of rows) {
    const name = r.toolName
    if (!name) continue
    const b = buckets.get(name)
    if (!b) continue
    const rew = typeof r.reward === 'number' ? r.reward : 0
    b.sum += rew
    b.count += 1
  }
  return candidates.map(name => {
    const b = buckets.get(name) ?? { sum: 0, count: 0 }
    const avg = b.count > 0 ? b.sum / b.count : 0
    const warm = b.count >= COLD_START_MIN
    return {
      toolName: name,
      count: b.count,
      avgReward: avg,
      warm,
      effectiveScore: warm ? avg : 0,
    }
  })
}

/** 默认 RNG:Math.random。probe 时可注入固定序列。 */
type RNG = () => number

/**
 * recommendTool 主入口 —— 纯决策函数。
 *
 * 返回 `pick` 是 candidates 中的一个。reason:
 *   - 'no-data':candidates.length === 0 → pick = '',上层需 skip ghost 写盘。
 *   - 'explore':RNG < ε,随机均匀选一个。
 *   - 'cold-start-tie':全部 candidate 冷启动或 effectiveScore 相同,退化随机。
 *   - 'exploit':argmax effectiveScore,带 scoreGap。
 */
export function recommendTool(opts: {
  candidates: string[]
  ledgerRows?: RewardRow[]
  epsilon?: number
  rng?: RNG
  now?: number
}): RecommendResult {
  const candidates = Array.from(new Set(opts.candidates.filter(Boolean)))
  const epsilon = opts.epsilon ?? readEpsilonFromEnv()
  const rng = opts.rng ?? Math.random

  if (candidates.length === 0) {
    return {
      pick: '',
      reason: 'no-data',
      epsilon,
      candidates: [],
    }
  }
  const rows = opts.ledgerRows ?? readRecentRewardRows({ now: opts.now })
  const scores = aggregateScores(candidates, rows)

  // ε-greedy:先 explore 判定
  if (rng() < epsilon) {
    const idx = Math.floor(rng() * candidates.length) % candidates.length
    return {
      pick: candidates[idx] ?? candidates[0],
      reason: 'explore',
      epsilon,
      candidates: scores,
    }
  }

  // exploit: argmax effectiveScore;打平按输入顺序取第一个,标 cold-start-tie
  let bestIdx = 0
  for (let i = 1; i < scores.length; i++) {
    if (scores[i].effectiveScore > scores[bestIdx].effectiveScore) bestIdx = i
  }
  const best = scores[bestIdx]
  // 所有 warm=false 或者 top 两个 effectiveScore 完全相等:退化 cold-start-tie
  const anyWarm = scores.some(s => s.warm)
  const top2Equal =
    scores.length > 1 &&
    scores.filter(s => s.effectiveScore === best.effectiveScore).length >= 2
  if (!anyWarm || top2Equal) {
    return {
      pick: best.toolName,
      reason: 'cold-start-tie',
      epsilon,
      candidates: scores,
    }
  }

  // scoreGap:best − second best(用 effectiveScore,便于后续 regret 量化)
  let secondBest = Number.NEGATIVE_INFINITY
  for (let i = 0; i < scores.length; i++) {
    if (i === bestIdx) continue
    if (scores[i].effectiveScore > secondBest)
      secondBest = scores[i].effectiveScore
  }
  return {
    pick: best.toolName,
    reason: 'exploit',
    epsilon,
    candidates: scores,
    scoreGap: Number.isFinite(secondBest)
      ? best.effectiveScore - secondBest
      : undefined,
  }
}
