/**
 * goodhartHealth — self-evolution-kernel v1.0 §6.2 Goodhart 对抗三件套综合指标聚合
 *
 * 目的
 * ────
 *   §6.2 拆分出三个独立对抗手段(#1 隐藏基准 / #2 Oracle 权重漂移 / #3
 *   稀有样本保护)。每个模块单看都只给出各自窄范围的 verdict。
 *   本模块把三源聚合成一个**总体健康评级**,让 /kernel-status 一眼就看出
 *   Oracle 是否在 Goodhart 陷阱边缘。
 *
 * 设计原则
 * ────────
 *   1. **纯只读**:只调各模块已有的 computeDrift / shouldProposeDrift /
 *      recentRareSampleSnapshots,不读额外文件,不写任何文件。
 *   2. **fail-open**:任一源 import/计算失败 → 该源标 unavailable,不影响其它源。
 *   3. **不做决策**:只给 verdict 与 hint,真正的权重调整走既有 /evolve-meta。
 *   4. **幂等**:同一输入(ledger 快照一致)任意次调用结果一致,无副作用。
 *
 * verdict 分档(保守偏紧,宁可多报)
 * ────────────────────────────────
 *   - critical:rare below-floor **且** benchmark suspicious(结构性失衡)
 *                或 drift 过期 ≥ 2× cadence **且** rare below-floor
 *   - alert   :rare below-floor 或 benchmark suspicious(任一结构性红线)
 *   - watch   :drift 过期(cadence 到而未发)但无结构性红线
 *   - healthy :其他
 *   - unavailable:三源全部失败 / 无任何数据
 *
 * 2026-04-25 新增,不改既有模块行为。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  shouldProposeDrift,
  DEFAULT_DRIFT_CADENCE_DAYS,
} from './oracleDrift.js'
import { recentRareSampleSnapshots } from './rareSampleGuard.js'
import { computeDrift as computeBenchmarkDrift } from './benchmarkLedger.js'

// ── 类型 ──────────────────────────────────────────────────

export type GoodhartVerdict =
  | 'healthy'
  | 'watch'
  | 'alert'
  | 'critical'
  | 'unavailable'

export interface DriftSourceStatus {
  available: boolean
  /** cadence overdue = should === true 且 ageDays > cadence */
  overdue: boolean
  ageDays: number | null
  lastAt: string | null
  reason: string
}

export interface RareSampleSourceStatus {
  available: boolean
  belowFloor: boolean
  share: number | null
  targetShare: number | null
  rareSubjects: number | null
  totalSubjects: number | null
  ts: string | null
}

export interface BenchmarkSourceStatus {
  available: boolean
  suspicious: boolean
  suspiciousRows: number
  totalRows: number
  driftThreshold: number | null
  reason: string
}

export interface GoodhartHealthReport {
  verdict: GoodhartVerdict
  /** 各源独立结论(shadow 子系统复用同一结构,供 /kernel-status 展开) */
  drift: DriftSourceStatus
  rareSample: RareSampleSourceStatus
  benchmark: BenchmarkSourceStatus
  /** 可读性说明,verdict 的"为什么" */
  reason: string
  /** 可选的下一步提示(不为空 = UI 层应渲染 hint line) */
  hint: string | null
  computedAt: string
}

// ── 核心 ──────────────────────────────────────────────────

/**
 * 聚合三源;每源独立 try/catch,fail-open。
 * 同步函数(模块级静态 import,无 IO 动作本身也全是同步读文件)。
 */
export function computeGoodhartHealth(opts?: {
  now?: number
}): GoodhartHealthReport {
  const now = opts?.now ?? Date.now()

  // ── 源 1: oracleDrift cadence
  let drift: DriftSourceStatus = {
    available: false,
    overdue: false,
    ageDays: null,
    lastAt: null,
    reason: 'module unavailable',
  }
  try {
    const envRaw = process.env.CLAUDE_EVOLVE_ORACLE_DRIFT_CADENCE_DAYS
    const cadence =
      envRaw && Number.isFinite(Number(envRaw)) && Number(envRaw) > 0
        ? Number(envRaw)
        : DEFAULT_DRIFT_CADENCE_DAYS
    const gate = shouldProposeDrift(now)
    // overdue = 已经超过 cadence 并且建议发起
    const overdue = gate.should && gate.ageDays > cadence
    drift = {
      available: true,
      overdue,
      ageDays: Number.isFinite(gate.ageDays) ? gate.ageDays : null,
      lastAt: gate.lastAt,
      reason: gate.reason,
    }
  } catch (e) {
    logForDebugging(
      `[goodhartHealth] drift source failed: ${(e as Error).message}`,
    )
  }

  // ── 源 2: rareSampleGuard 最近一次 snapshot
  let rareSample: RareSampleSourceStatus = {
    available: false,
    belowFloor: false,
    share: null,
    targetShare: null,
    rareSubjects: null,
    totalSubjects: null,
    ts: null,
  }
  try {
    const recent = recentRareSampleSnapshots(1)
    if (recent.length > 0) {
      const last = recent[recent.length - 1]!
      rareSample = {
        available: true,
        belowFloor: last.belowFloor,
        share: last.rareShare,
        targetShare: last.targetShare,
        rareSubjects: last.rareSubjects,
        totalSubjects: last.totalSubjects,
        ts: last.ts,
      }
    } else {
      // 模块存在但 ledger 为空 → available=true,但也视为 no-data;不强制算
      rareSample = {
        available: true,
        belowFloor: false,
        share: null,
        targetShare: null,
        rareSubjects: null,
        totalSubjects: null,
        ts: null,
      }
    }
  } catch (e) {
    logForDebugging(
      `[goodhartHealth] rareSample source failed: ${(e as Error).message}`,
    )
  }

  // ── 源 3: benchmarkLedger drift
  let benchmark: BenchmarkSourceStatus = {
    available: false,
    suspicious: false,
    suspiciousRows: 0,
    totalRows: 0,
    driftThreshold: null,
    reason: 'module unavailable',
  }
  try {
    const report = computeBenchmarkDrift()
    benchmark = {
      available: true,
      suspicious: report.suspicious,
      suspiciousRows: report.suspiciousRows.length,
      totalRows: report.allRows.length,
      driftThreshold: report.driftThreshold,
      reason: report.reason,
    }
  } catch (e) {
    logForDebugging(
      `[goodhartHealth] benchmark source failed: ${(e as Error).message}`,
    )
  }

  // ── 综合 verdict
  const {
    verdict,
    reason,
    hint,
  } = deriveVerdict(drift, rareSample, benchmark)

  return {
    verdict,
    drift,
    rareSample,
    benchmark,
    reason,
    hint,
    computedAt: new Date(now).toISOString(),
  }
}

/**
 * 纯函数 derive,便于单测 & 观测。
 * 策略注释:
 *  - critical:两条红线同时触发 → Oracle 几乎肯定在 Goodhart 陷阱里
 *  - alert   :单条红线触发 → 需要人关注
 *  - watch   :只是 cadence 过期,还没见结构性异常
 *  - healthy :三源都正常
 *  - unavailable:三源全挂(通常意味着 autoEvolve 还没开)
 */
function deriveVerdict(
  drift: DriftSourceStatus,
  rareSample: RareSampleSourceStatus,
  benchmark: BenchmarkSourceStatus,
): { verdict: GoodhartVerdict; reason: string; hint: string | null } {
  const availableSources = [drift, rareSample, benchmark].filter(
    s => s.available,
  ).length
  if (availableSources === 0) {
    return {
      verdict: 'unavailable',
      reason: 'no Goodhart source available',
      hint: null,
    }
  }

  const rareRed = rareSample.available && rareSample.belowFloor
  const benchRed = benchmark.available && benchmark.suspicious
  const driftOverdue = drift.available && drift.overdue

  // 两条同时 → critical
  if (rareRed && benchRed) {
    return {
      verdict: 'critical',
      reason:
        'rare-sample below floor AND benchmark drift suspicious — Oracle may be optimizing for Goodhart targets',
      hint: 'run /evolve-rare-check --analyze + /evolve-bench --drift for detail, then consider /evolve-meta --apply after review',
    }
  }
  if (driftOverdue && rareRed) {
    const ageDesc =
      drift.ageDays === null || !Number.isFinite(drift.ageDays)
        ? 'no prior drift proposal'
        : `${fmtAge(drift.ageDays)}d since last proposal`
    return {
      verdict: 'critical',
      reason: `drift overdue (${ageDesc}) AND rare-sample below floor — re-drift is the first remedy`,
      hint: 'run /evolve-drift-check --propose (shadow-only) then /evolve-meta --apply',
    }
  }

  // 任一红线
  if (rareRed) {
    return {
      verdict: 'alert',
      reason: `rare-sample share ${fmtPct(rareSample.share)} < target ${fmtPct(
        rareSample.targetShare,
      )}`,
      hint: 'long-tail tasks under-weighted; run /evolve-rare-check for detail',
    }
  }
  if (benchRed) {
    return {
      verdict: 'alert',
      reason: `benchmark drift suspicious (${benchmark.suspiciousRows}/${benchmark.totalRows} rows over threshold)`,
      hint: 'run /evolve-bench --drift for detail',
    }
  }

  // 只是 cadence 过期
  if (driftOverdue) {
    const ageDesc =
      drift.ageDays === null || !Number.isFinite(drift.ageDays)
        ? 'no prior drift proposal'
        : `${fmtAge(drift.ageDays)}d since last proposal`
    return {
      verdict: 'watch',
      reason: `oracle drift cadence overdue (${ageDesc})`,
      hint: 'run /evolve-drift-check --propose (shadow-only)',
    }
  }

  return {
    verdict: 'healthy',
    reason: 'all Goodhart sources within safe band',
    hint: null,
  }
}

// ── 格式化 helpers ────────────────────────────────────────

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a'
  return `${(n * 100).toFixed(1)}%`
}

function fmtAge(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'never'
  return n.toFixed(1)
}

function verdictBadge(v: GoodhartVerdict): string {
  switch (v) {
    case 'critical':
      return 'CRITICAL🟥'
    case 'alert':
      return 'alert🟧'
    case 'watch':
      return 'watch🟡'
    case 'healthy':
      return 'healthy🟢'
    case 'unavailable':
      return 'unavailable'
    default:
      return v
  }
}

// ── 共享视图 ──────────────────────────────────────────────

/**
 * 给 /kernel-status、/evolve-status、dailyDigest 复用的摘要渲染。
 *
 * 返回 string[]:空数组 = 不渲染。
 * opts:
 *   - indent
 *   - compact=true:只渲染 verdict + reason 两行(/kernel-status 默认)
 *   - todayOnly=true:仅当 rareSample snapshot 或 drift proposal 有今日记录时渲染
 *     (dailyDigest 用;anchor 通过 now 传 UTC 12:00 ms)
 */
export function buildGoodhartHealthSummaryLines(opts?: {
  indent?: string
  compact?: boolean
  todayOnly?: boolean
  now?: number
}): string[] {
  const indent = opts?.indent ?? ''
  const now = opts?.now ?? Date.now()
  const lines: string[] = []
  try {
    const report = computeGoodhartHealth({ now })
    if (report.verdict === 'unavailable' && !opts?.compact) {
      return []
    }
    if (opts?.todayOnly) {
      // 当日范围锚定;rareSample.ts / drift.lastAt 都没有落在今日 → skip
      const ymd = new Date(now).toISOString().slice(0, 10)
      const rareToday =
        report.rareSample.ts !== null && report.rareSample.ts.startsWith(ymd)
      const driftToday =
        report.drift.lastAt !== null && report.drift.lastAt.startsWith(ymd)
      if (!rareToday && !driftToday) return []
    }

    lines.push(
      `${indent}- Goodhart health: ${verdictBadge(report.verdict)}  ${report.reason}`,
    )
    if (!opts?.compact) {
      const driftDesc = report.drift.available
        ? `age=${fmtAge(report.drift.ageDays)}d  overdue=${report.drift.overdue}`
        : 'unavailable'
      const rareDesc = report.rareSample.available
        ? `share=${fmtPct(report.rareSample.share)}/${fmtPct(
            report.rareSample.targetShare,
          )}  below-floor=${report.rareSample.belowFloor}`
        : 'unavailable'
      const benchDesc = report.benchmark.available
        ? `suspicious=${report.benchmark.suspicious}  rows=${report.benchmark.suspiciousRows}/${report.benchmark.totalRows}`
        : 'unavailable'
      lines.push(`${indent}  · drift       : ${driftDesc}`)
      lines.push(`${indent}  · rare-sample : ${rareDesc}`)
      lines.push(`${indent}  · benchmark   : ${benchDesc}`)
    }
    if (report.hint) {
      lines.push(`${indent}  hint: ${report.hint}`)
    }
    return lines
  } catch (e) {
    logForDebugging(
      `[goodhartHealth] summary render failed: ${(e as Error).message}`,
    )
    return []
  }
}
