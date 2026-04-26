/**
 * rareSampleGuard — self-evolution-kernel v1.0 §6.2 Goodhart 对抗 #3
 *
 * "稀有样本保护 ≥ 30%":保证长尾任务权重不被高频任务独占,
 * 防止"进化只朝常见任务刷分"退化为过拟合。
 *
 * ── 设计原则 ───────────────────────────────────────────────
 *  1. **shadow-only / observe-only**:
 *     - 只读 fitness.ndjson,不改 scoreSubject 主路径
 *     - 只追加 rare-sample.ndjson 快照,不触碰 tuned-oracle-weights.json
 *     - 任何 parse/IO 失败都 fail-open,不抛不挂
 *
 *  2. **稀有 = 低频 + 高影响缺席**:
 *     - 按 subjectId 分组窗口内 fitness 记录
 *     - frequency ≤ rareThreshold(默认 2) 的 subjectId 视为 rare
 *     - rare share = rare 样本总记录数 / 总记录数
 *     - 若 share < targetShare(§6.2 规定的 30%)→ 进入 "below-floor" 状态
 *
 *  3. **共享视图**:
 *     - buildRareSampleSummaryLines 给 /kernel-status, /evolve-status,
 *       dailyDigest 三观测点复用,行为/布局统一
 *     - todayOnly 模式用 anchorMs 锚当天 UTC 范围,和 oracleDrift 保持一致
 *
 *  4. **不做决策**:
 *     - 只给出 advisor 级提示("run /evolve-rare-check for detail")
 *     - 真正的权重调整走既有 /evolve-meta --apply 人工批准链路
 *
 * 2026-04-25 新增,不改任何既有文件行为。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getOracleDir,
  getRareSampleLedgerPath,
} from '../paths.js'
import { appendJsonLine } from './ndjsonLedger.js'
import { recentFitnessScores } from './fitnessOracle.js'
import type { FitnessScore } from '../types.js'

// ── 常量 ──────────────────────────────────────────────────

/** §6.2 拍板:长尾权重地板 30%。低于此值即报警提示保护不足。 */
export const RARE_SAMPLE_TARGET_SHARE = 0.3

/** 默认窗口:最近 500 条 fitness 记录;和 oracleAggregator DEFAULT_FITNESS_WINDOW 一致。 */
export const DEFAULT_RARE_WINDOW = 500

/** 默认稀有阈值:出现次数 ≤ 2 视为稀有。 */
export const DEFAULT_RARE_FREQUENCY_THRESHOLD = 2

// ── 核心数据类型 ──────────────────────────────────────────

/**
 * 一次 rare-sample 快照。每次 analyze 调用可落一行。
 * 与 DriftProposal 一样,subjectId 示例只写 hash 前缀,避免暴露 sessionId。
 */
export interface RareSampleSnapshot {
  /** ISO 时间戳 */
  ts: string
  /** 窗口大小(实际扫描到的记录数,可能 < 请求 window) */
  windowSize: number
  /** 稀有阈值(<=) */
  rareThreshold: number
  /** 稀有 subjectId 个数 */
  rareSubjects: number
  /** 总 subjectId 个数 */
  totalSubjects: number
  /** 稀有样本总记录数 */
  rareRecords: number
  /** 稀有样本占比 = rareRecords / windowSize ∈ [0,1] */
  rareShare: number
  /** 稀有样本平均 score ∈ [-1,1];无稀有样本时为 null */
  rareAvgScore: number | null
  /** 非稀有样本平均 score ∈ [-1,1];无非稀有样本时为 null */
  nonRareAvgScore: number | null
  /** 目标下限(通常 = RARE_SAMPLE_TARGET_SHARE) */
  targetShare: number
  /** 是否低于下限 → advisor 会给"保护不足"提示 */
  belowFloor: boolean
  /**
   * top N 稀有样本的摘要:用于人类审视,不参与任何决策。
   * 只记 subjectIdHash(前 8 位)+ count + avgScore,防敏感数据泄漏。
   */
  topRareSamples: Array<{
    subjectIdHash: string
    count: number
    avgScore: number
  }>
  /** 触发来源:'manual' / 'observe-only' / 'kernel-status' / 'digest' 等 */
  reason: string
}

// ── 环境覆盖 ──────────────────────────────────────────────

function envTargetShare(): number {
  const raw = process.env.CLAUDE_EVOLVE_RARE_SAMPLE_TARGET
  if (!raw) return RARE_SAMPLE_TARGET_SHARE
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) return RARE_SAMPLE_TARGET_SHARE
  return n
}

function envRareThreshold(): number {
  const raw = process.env.CLAUDE_EVOLVE_RARE_SAMPLE_THRESHOLD
  if (!raw) return DEFAULT_RARE_FREQUENCY_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RARE_FREQUENCY_THRESHOLD
  return Math.floor(n)
}

function envWindow(): number {
  const raw = process.env.CLAUDE_EVOLVE_RARE_SAMPLE_WINDOW
  if (!raw) return DEFAULT_RARE_WINDOW
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 10) return DEFAULT_RARE_WINDOW
  return Math.floor(n)
}

// ── 纯计算 ────────────────────────────────────────────────

/**
 * 简单 fnv-1a-like hash,给 subjectId 产生 8 位短标识,便于审视而不泄漏。
 * 不用 crypto 是因为此处不需要加密强度,只需"稳定可读"。
 */
function shortHash(input: string): string {
  // FNV-1a 32 位
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // Math.imul 保证 32-bit 乘法,避免 JS 浮点误差
    h = Math.imul(h, 0x01000193)
  }
  // 转无符号 8 位 hex
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 从一批 FitnessScore 计算 RareSampleSnapshot。
 * 纯函数,便于单测 + 观测;不读文件,不写文件。
 */
export function computeRareSampleSnapshot(
  scores: FitnessScore[],
  opts?: {
    rareThreshold?: number
    targetShare?: number
    topN?: number
    reason?: string
    now?: () => Date
  },
): RareSampleSnapshot {
  const rareThreshold = opts?.rareThreshold ?? envRareThreshold()
  const targetShare = opts?.targetShare ?? envTargetShare()
  const topN = opts?.topN ?? 5
  const now = opts?.now ?? (() => new Date())

  // 按 subjectId 分组
  type Bucket = { count: number; sum: number }
  const bySubject = new Map<string, Bucket>()
  for (const s of scores) {
    if (!s || typeof s.subjectId !== 'string' || s.subjectId.length === 0) continue
    const scoreVal = typeof s.score === 'number' && Number.isFinite(s.score) ? s.score : 0
    const b = bySubject.get(s.subjectId)
    if (b) {
      b.count++
      b.sum += scoreVal
    } else {
      bySubject.set(s.subjectId, { count: 1, sum: scoreVal })
    }
  }

  const totalSubjects = bySubject.size
  const windowSize = scores.length

  // 分稀有 / 非稀有
  let rareRecords = 0
  let rareScoreSum = 0
  let nonRareRecords = 0
  let nonRareScoreSum = 0
  let rareSubjects = 0
  const rareEntries: Array<{ subjectId: string; count: number; avgScore: number }> = []
  for (const [subjectId, b] of bySubject) {
    if (b.count <= rareThreshold) {
      rareSubjects++
      rareRecords += b.count
      rareScoreSum += b.sum
      rareEntries.push({
        subjectId,
        count: b.count,
        avgScore: b.sum / b.count,
      })
    } else {
      nonRareRecords += b.count
      nonRareScoreSum += b.sum
    }
  }

  const rareShare = windowSize > 0 ? rareRecords / windowSize : 0
  const rareAvgScore = rareRecords > 0 ? rareScoreSum / rareRecords : null
  const nonRareAvgScore = nonRareRecords > 0 ? nonRareScoreSum / nonRareRecords : null
  const belowFloor = windowSize > 0 && rareShare < targetShare

  // 排序 top rare:先按 avgScore 升序(最差的优先暴露),再按 count 降序
  rareEntries.sort((a, b) => {
    if (a.avgScore !== b.avgScore) return a.avgScore - b.avgScore
    return b.count - a.count
  })
  const topRareSamples = rareEntries.slice(0, topN).map(e => ({
    subjectIdHash: shortHash(e.subjectId),
    count: e.count,
    avgScore: Number(e.avgScore.toFixed(4)),
  }))

  return {
    ts: now().toISOString(),
    windowSize,
    rareThreshold,
    rareSubjects,
    totalSubjects,
    rareRecords,
    rareShare: Number(rareShare.toFixed(4)),
    rareAvgScore: rareAvgScore === null ? null : Number(rareAvgScore.toFixed(4)),
    nonRareAvgScore: nonRareAvgScore === null ? null : Number(nonRareAvgScore.toFixed(4)),
    targetShare,
    belowFloor,
    topRareSamples,
    reason: opts?.reason ?? 'observe-only',
  }
}

// ── IO ────────────────────────────────────────────────────

/** 追加一条 RareSampleSnapshot,失败 fail-open 返回 false。 */
export function appendRareSampleSnapshot(snap: RareSampleSnapshot): boolean {
  try {
    ensureDir(getOracleDir())
    return appendJsonLine(getRareSampleLedgerPath(), snap)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:rareSampleGuard] appendRareSampleSnapshot failed: ${
        (e as Error).message
      }`,
    )
    return false
  }
}

/** 读最近 limit 条 snapshot(尾部) */
export function recentRareSampleSnapshots(limit = 20): RareSampleSnapshot[] {
  try {
    const path = getRareSampleLedgerPath()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return []
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines
    const out: RareSampleSnapshot[] = []
    for (const line of tail) {
      try {
        const obj = JSON.parse(line) as RareSampleSnapshot
        // 最小字段校验
        if (typeof obj.ts === 'string' && typeof obj.rareShare === 'number') {
          out.push(obj)
        }
      } catch {
        // 坏行跳过
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[autoEvolve:rareSampleGuard] recentRareSampleSnapshots read failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
}

/**
 * 一站式 analyze:读 window 条 fitness → 算快照 → 追加 ledger。
 * 失败 fail-open 返回 null。
 */
export function analyzeRareSamples(opts?: {
  window?: number
  rareThreshold?: number
  targetShare?: number
  reason?: string
  persist?: boolean
}): RareSampleSnapshot | null {
  try {
    const window = opts?.window ?? envWindow()
    const scores = recentFitnessScores(window)
    const snap = computeRareSampleSnapshot(scores, {
      rareThreshold: opts?.rareThreshold,
      targetShare: opts?.targetShare,
      reason: opts?.reason ?? 'observe-only',
    })
    if (opts?.persist !== false) {
      appendRareSampleSnapshot(snap)
    }
    return snap
  } catch (e) {
    logForDebugging(
      `[autoEvolve:rareSampleGuard] analyzeRareSamples failed: ${(e as Error).message}`,
    )
    return null
  }
}

// ── 共享视图 ──────────────────────────────────────────────

/**
 * 渲染摘要行。被 /kernel-status、/evolve-status、dailyDigest 三观测点共用。
 *
 * - indent:行首缩进
 * - todayOnly:只看今日 UTC 范围内的 snapshot(用于 dailyDigest)
 * - now:测试注入时钟;默认 Date.now()
 * - freshAnalyze:true 则主动算一次最新快照,不依赖 ledger
 *
 * 永远 fail-open,返回空数组 = 不渲染。
 */
export function buildRareSampleSummaryLines(opts?: {
  indent?: string
  todayOnly?: boolean
  now?: number
  freshAnalyze?: boolean
}): string[] {
  const indent = opts?.indent ?? ''
  const now = opts?.now ?? Date.now()
  const lines: string[] = []
  try {
    // 取一份 "代表性" snapshot:
    //   - freshAnalyze → 现算一次(不落盘)
    //   - 否则取 ledger 最后一条
    let snap: RareSampleSnapshot | null = null
    if (opts?.freshAnalyze) {
      snap = analyzeRareSamples({ persist: false, reason: 'kernel-status' })
    } else {
      const recent = recentRareSampleSnapshots(5)
      if (recent.length > 0) snap = recent[recent.length - 1]!
    }

    // todayOnly 过滤:只保留锚定日 00:00 ~ 24:00 UTC 的记录
    if (opts?.todayOnly) {
      const anchor = new Date(now)
      const ymd = anchor.toISOString().slice(0, 10)
      if (snap && !snap.ts.startsWith(ymd)) snap = null
      // 顺便统计当日 snapshot 条数
      const today = recentRareSampleSnapshots(50).filter(s => s.ts.startsWith(ymd))
      if (today.length === 0) return []
      snap = today[today.length - 1]!
      lines.push(`${indent}- rare-sample snapshots today: ${today.length}`)
    }

    if (!snap) return []

    const sharePct = (snap.rareShare * 100).toFixed(1)
    const targetPct = (snap.targetShare * 100).toFixed(0)
    const avgR = snap.rareAvgScore === null ? 'n/a' : snap.rareAvgScore.toFixed(3)
    const avgN =
      snap.nonRareAvgScore === null ? 'n/a' : snap.nonRareAvgScore.toFixed(3)
    const badge = snap.belowFloor ? 'below-floor⚠' : 'ok'
    lines.push(
      `${indent}- rare sample share: ${sharePct}% vs target ≥${targetPct}%  [${badge}]`,
    )
    lines.push(
      `${indent}  window=${snap.windowSize}  rare-subjects=${snap.rareSubjects}/${snap.totalSubjects}  rareAvg=${avgR}  nonRareAvg=${avgN}`,
    )
    if (snap.belowFloor) {
      lines.push(
        `${indent}  hint: run \`/evolve-rare-check\` for details (shadow-only; does NOT change tuned weights)`,
      )
    }
    return lines
  } catch (e) {
    logForDebugging(
      `[autoEvolve:rareSampleGuard] buildRareSampleSummaryLines failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
}
