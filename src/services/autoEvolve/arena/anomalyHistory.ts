/**
 * Phase 115(2026-04-24)— 全量 anomaly 历史流水。
 *
 * Ph113 (backpressureAudit) 只记录 SHADOW_PILEUP / ARCHIVE_BIAS 两种被用作
 * 背压触发的 anomaly。STAGNATION 和 HIGH_ATTRITION 是 Ph105 的另两种 anomaly
 * 类型,它们代表全局趋势(停滞 / 高汰率),但目前只在 /kernel-status 展示最新
 * 一次,历史一旦过了下一个 tick 就消失。
 *
 * Ph115 把这 4 种 anomaly 全量沉淀到 NDJSON,让:
 *   1. /evolve-anomalies 或 /evolve-audit 可按时间窗回溯
 *   2. 未来做趋势分析(如"过去一周 HIGH_ATTRITION 出现频率是否上升")
 *   3. 联动 Ph113 audit —— 背压决策配上对应的 anomaly context 可交叉查证
 *
 * 与 backpressureAudit.ts 是姊妹模块,结构保持一致(append/load/truncate)。
 *
 * 写入时机:由 background.ts 在 anomalies 非空时调用(空数组不写,避免噪声)。
 * 规模控制:1000 行硬上限,触发后保留尾部 900 行。
 * fail-open:IO 故障吞异常。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAnomalyHistoryPath } from '../paths.js'

export type AnomalyKindHistory =
  | 'SHADOW_PILEUP'
  | 'ARCHIVE_BIAS'
  | 'STAGNATION'
  | 'HIGH_ATTRITION'

export interface AnomalyHistoryItem {
  kind: AnomalyKindHistory
  /** 针对性 anomaly 的目标 status(SHADOW_PILEUP → 'shadow') */
  targetStatus: string | null
  /** 针对性 anomaly 的目标 kind(SHADOW_PILEUP → 'skill' 等) */
  targetKind: string | null
  /** Ph105 marker(🔥/📦/❄️/⚠️) */
  marker: string
  /** 人类可读的信息 */
  message: string
}

export interface PopulationSnapshotMini {
  totalShadow: number
  totalStable: number
  totalArchived: number
  totalVetoed: number
  /** Ph103 24h 动能,便于回顾时判断"那会儿系统是否活跃" */
  transitions24h: number
}

export interface AnomalyHistoryEntry {
  ts: string
  tickCount: number
  anomalies: AnomalyHistoryItem[]
  populationSnapshot: PopulationSnapshotMini
}

const MAX_LINES = 1000
const KEEP_LINES = 900

/** Ph137(2026-04-24):公开 MAX_LINES 作为 kernel-status 容量基准。 */
export const MAX_ANOMALY_LINES = MAX_LINES

/**
 * 追加一条历史记录。fail-open。
 * 调用方负责确保 anomalies.length>0(此处不再过滤,保持职责单一)。
 */
export function appendAnomalyHistory(entry: AnomalyHistoryEntry): void {
  try {
    const p = getAnomalyHistoryPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8')
    // 抽查截断:与 Ph113 同策略,每 ~50 次 append 做一次硬上限检查
    //   1000 行硬上限,正常规模(100 次/小时)12h 就会抽查到
    if (entry.tickCount % 50 === 0) {
      truncateIfNeeded(p)
    }
  } catch {
    /* fail-open */
  }
}

/**
 * 读取所有历史记录。损坏行静默跳过。
 */
export function loadAnomalyHistory(): AnomalyHistoryEntry[] {
  try {
    const p = getAnomalyHistoryPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: AnomalyHistoryEntry[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (
          obj && typeof obj === 'object'
          && typeof obj.ts === 'string'
          && Array.isArray(obj.anomalies)
        ) {
          out.push(obj as AnomalyHistoryEntry)
        }
      } catch {
        /* 单行损坏跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 硬截断,与 Ph113 同策略。fail-open。 */
function truncateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    if (lines.length > MAX_LINES) {
      const kept = lines.slice(lines.length - KEEP_LINES)
      writeFileSync(path, kept.join('\n') + '\n', 'utf-8')
    }
  } catch {
    /* noop */
  }
}

/** 测试用:显式触发截断。 */
export function __forceTruncateForTests(): void {
  try {
    truncateIfNeeded(getAnomalyHistoryPath())
  } catch {
    /* noop */
  }
}

export const __testInternals = { MAX_LINES, KEEP_LINES }
