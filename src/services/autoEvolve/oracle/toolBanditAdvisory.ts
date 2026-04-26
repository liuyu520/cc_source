/**
 * G3 Step 4(2026-04-26)· tool-bandit regret advisory
 * -----------------------------------------------------------------
 *
 * 动机:
 *   G3 Step 3 把 ε-greedy policy 推荐结果 shadow 落盘到 tool-bandit-ghost.ndjson。
 *   Step 4 在其之上做纯读聚合:24h 窗内 isMatch=false 的比率 + scoreGap 累计,
 *   超阈值时产出 advisory,供 Rule 14 消费。与 Rule 10/11/12/15/16/17/18 严格对称
 *   (fail-open / 纯读 / 不改选择)。
 *
 * 判定:
 *   kind='high'    mismatchRate ≥ 0.5 且 scoreGapSum ≥ 5  且 total ≥ 10
 *   kind='medium'  mismatchRate ≥ 0.3 且 scoreGapSum ≥ 2  且 total ≥ 5
 *   kind='low'     mismatchRate >  0  且 total ≥ 3
 *   kind='none'    其它(含 total=0、ghost 未开、ledger 缺失)
 *
 *   只有 reason='exploit' 的 row 才计入主指标:explore 随机、cold-start-tie
 *   退化随机,mismatch 本就预期,不能拿来喊 regret;no-data 已在 ghostLog 层拒写。
 *
 * 约束:
 *   - 纯读:文件不存在 / 读失败 / 解析失败 → kind='none';
 *   - fail-open:所有异常 swallow;
 *   - 不改 Step 3 ghostLog 写盘格式,不改 policy 决策。
 */

import { existsSync, readFileSync } from 'node:fs'
import { getToolBanditGhostLedgerPath } from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

export type ToolBanditAdvisoryKind = 'none' | 'low' | 'medium' | 'high'
export type ToolBanditAdvisorySeverity = 'low' | 'medium' | 'high'

/** 24h 窗内聚合结果(Rule 14 + /tool-bandit 都可消费) */
export interface ToolBanditStats {
  windowHours: number
  /** 窗内 ghost ledger 条目总数(含 explore / cold-start-tie) */
  totalRows: number
  /** reason='exploit' 的 row 数,主指标分母 */
  exploitRows: number
  /** exploit 且 isMatch=false 的 row 数 */
  mismatchRows: number
  /** mismatchRows / exploitRows;exploitRows=0 时为 0 */
  mismatchRate: number
  /** 所有 exploit mismatch row 的 scoreGap 累计(reward 单位) */
  scoreGapSum: number
  /** 最近一次 mismatch 的 ISO(用于 hint,可空) */
  lastMismatchAt?: string
  /** 最近一次 mismatch 的 actual→recommended(展示用) */
  lastMismatchDesc?: string
}

export interface ToolBanditAdvisory {
  kind: ToolBanditAdvisoryKind
  severity: ToolBanditAdvisorySeverity
  stats: ToolBanditStats
  /** 形如 'last 24h' */
  windowLabel: string
  /** Rule 14 直接引用;kind='none' 时 undefined */
  message?: string
}

/** 单条 ghost ledger 原始行 —— 只列 detector 用到的字段 */
interface GhostRow {
  at?: string
  actualTool?: string
  recommendedTool?: string
  reason?: 'explore' | 'exploit' | 'cold-start-tie' | 'no-data'
  scoreGap?: number
  isMatch?: boolean
}

function emptyStats(windowHours: number): ToolBanditStats {
  return {
    windowHours,
    totalRows: 0,
    exploitRows: 0,
    mismatchRows: 0,
    mismatchRate: 0,
    scoreGapSum: 0,
  }
}

function readLedger(path: string, maxRows: number): GhostRow[] {
  try {
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean).slice(-maxRows)
    const out: GhostRow[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip 损坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 单独暴露便于 probe / /tool-bandit 命令直接聚合 */
export function computeToolBanditStats(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  path?: string
}): ToolBanditStats {
  const anchor = opts?.now ?? Date.now()
  const windowHours = opts?.windowHours ?? 24
  const maxRows = opts?.maxRows ?? 5000
  try {
    const rows = readLedger(
      opts?.path ?? getToolBanditGhostLedgerPath(),
      maxRows,
    )
    const cutoff = anchor - windowHours * 3600 * 1000
    let totalRows = 0
    let exploitRows = 0
    let mismatchRows = 0
    let scoreGapSum = 0
    let lastMismatchAt: string | undefined
    let lastMismatchDesc: string | undefined
    for (const r of rows) {
      if (!r.at) continue
      const t = Date.parse(r.at)
      if (!Number.isFinite(t) || t < cutoff || t > anchor) continue
      totalRows += 1
      if (r.reason !== 'exploit') continue
      exploitRows += 1
      if (r.isMatch === false) {
        mismatchRows += 1
        if (typeof r.scoreGap === 'number' && Number.isFinite(r.scoreGap)) {
          scoreGapSum += Math.max(0, r.scoreGap)
        }
        // 记最近 mismatch(rows 已 tail,按序遍历后最后命中的就是最近)
        lastMismatchAt = r.at
        if (r.actualTool && r.recommendedTool) {
          lastMismatchDesc = `${r.actualTool}→${r.recommendedTool}`
        }
      }
    }
    const mismatchRate = exploitRows > 0 ? mismatchRows / exploitRows : 0
    return {
      windowHours,
      totalRows,
      exploitRows,
      mismatchRows,
      mismatchRate,
      scoreGapSum,
      lastMismatchAt,
      lastMismatchDesc,
    }
  } catch (e) {
    logForDebugging(
      `[toolBanditAdvisory] computeStats failed: ${(e as Error).message}`,
    )
    return emptyStats(windowHours)
  }
}

/**
 * detect 入口 —— Rule 14 直接调用;/tool-bandit 可复用。
 * 阈值全部可 override,便于 probe。
 */
export function detectToolBanditRegret(opts?: {
  now?: number
  windowHours?: number
  maxRows?: number
  path?: string
  /** high 门槛 */
  highRate?: number
  highGapSum?: number
  highMin?: number
  /** medium 门槛 */
  mediumRate?: number
  mediumGapSum?: number
  mediumMin?: number
  /** low 门槛(仅用 total 控制出现时机) */
  lowMin?: number
}): ToolBanditAdvisory {
  const windowHours = opts?.windowHours ?? 24
  const windowLabel = `last ${windowHours}h`
  try {
    const stats = computeToolBanditStats({
      now: opts?.now,
      windowHours,
      maxRows: opts?.maxRows,
      path: opts?.path,
    })
    const highRate = opts?.highRate ?? 0.5
    const highGapSum = opts?.highGapSum ?? 5
    const highMin = opts?.highMin ?? 10
    const mediumRate = opts?.mediumRate ?? 0.3
    const mediumGapSum = opts?.mediumGapSum ?? 2
    const mediumMin = opts?.mediumMin ?? 5
    const lowMin = opts?.lowMin ?? 3

    // exploit 样本不足:不做判定(避免稀疏下误报 low)。
    if (stats.exploitRows < lowMin) {
      return { kind: 'none', severity: 'low', stats, windowLabel }
    }

    if (
      stats.mismatchRate >= highRate &&
      stats.scoreGapSum >= highGapSum &&
      stats.exploitRows >= highMin
    ) {
      return {
        kind: 'high',
        severity: 'high',
        stats,
        windowLabel,
        message:
          `tool-bandit regret high: ${stats.mismatchRows}/${stats.exploitRows} exploit picks diverged ` +
          `(rate=${(stats.mismatchRate * 100).toFixed(0)}%, gap_sum=${stats.scoreGapSum.toFixed(2)})` +
          (stats.lastMismatchDesc ? ` · last: ${stats.lastMismatchDesc}` : '') +
          `. Review via /tool-bandit.`,
      }
    }
    if (
      stats.mismatchRate >= mediumRate &&
      stats.scoreGapSum >= mediumGapSum &&
      stats.exploitRows >= mediumMin
    ) {
      return {
        kind: 'medium',
        severity: 'medium',
        stats,
        windowLabel,
        message:
          `tool-bandit regret medium: ${stats.mismatchRows}/${stats.exploitRows} exploit picks diverged ` +
          `(rate=${(stats.mismatchRate * 100).toFixed(0)}%, gap_sum=${stats.scoreGapSum.toFixed(2)})` +
          (stats.lastMismatchDesc ? ` · last: ${stats.lastMismatchDesc}` : '') +
          `. Review via /tool-bandit.`,
      }
    }
    if (stats.mismatchRate > 0 && stats.exploitRows >= lowMin) {
      return {
        kind: 'low',
        severity: 'low',
        stats,
        windowLabel,
        message:
          `tool-bandit regret low: ${stats.mismatchRows}/${stats.exploitRows} exploit picks diverged ` +
          `(rate=${(stats.mismatchRate * 100).toFixed(0)}%, gap_sum=${stats.scoreGapSum.toFixed(2)})` +
          (stats.lastMismatchDesc ? ` · last: ${stats.lastMismatchDesc}` : '') +
          `. Review via /tool-bandit.`,
      }
    }

    return { kind: 'none', severity: 'low', stats, windowLabel }
  } catch (e) {
    logForDebugging(
      `[toolBanditAdvisory] detect failed: ${(e as Error).message}`,
    )
    return {
      kind: 'none',
      severity: 'low',
      stats: emptyStats(windowHours),
      windowLabel,
    }
  }
}
