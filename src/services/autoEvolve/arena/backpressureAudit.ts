/**
 * Phase 113(2026-04-24)— 背压决策审计流水。
 *
 * 职责:把 emergence tick 的背压决策("谁 在何时 基于哪些 streak 做出了何决策")
 * 落盘为可回溯的 NDJSON。将来:
 *   - /evolve-audit 或 /evolve-anomalies 命令读取它做趋势分析
 *   - 验证 auto-gate 阈值是否合理(太激进?太保守?)
 *   - 人工排查"为什么这个 kind 一直被拦"
 *
 * 写入时机:只在 pileupKinds.size > 0(detected=true)时写。
 *   - 空 tick 不写,避免日志膨胀
 *   - 每条记录都是"本 tick 做出的决策及其上下文"
 *
 * 规模控制:单文件硬上限 2000 行。超过后读全部→保留尾部 1800 行重写。
 *   - 硬截断策略,避免 log rotation 复杂度
 *   - 1800 而非 2000 是为留 buffer,减少每次 append 都触发截断
 *
 * fail-open:load/append 失败都吞掉异常,只在 debug log 留痕。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getBackpressureAuditPath } from '../paths.js'

export type BackpressureDecision =
  | 'observe'        // detected 但未拦(默认观测 或 streak<阈值)
  | 'env-off'        // CLAUDE_EVOLVE_BACKPRESSURE=off(显式观测)
  | 'env-on'         // CLAUDE_EVOLVE_BACKPRESSURE=on(全拦)
  | 'auto-gate'      // streak≥阈值 自动拦

export interface BackpressureAuditEntry {
  ts: string
  tickCount: number
  decision: BackpressureDecision
  pileupKinds: string[]
  reasonsByKind: Record<string, string[]>
  autoGatedKinds: string[]
  /** 本 tick 相关 kind 的 streak count 摘要(节省空间,不记 since/reasons 全量) */
  streaksSummary: Record<string, number>
  skipped: boolean
  droppedCount: number
}

const MAX_LINES = 2000
const KEEP_LINES = 1800

/**
 * Ph137(2026-04-24):公开 MAX_LINES 作为 kernel-status 的容量基准。
 * additive re-export,不改动 internal MAX_LINES 行为;与 healthDigest 的
 * MAX_HISTORY_LINES 对齐命名。不引入新常量,避免出现漂移。
 */
export const MAX_AUDIT_LINES = MAX_LINES

/**
 * 追加一条审计记录。fail-open。
 *
 * 仅在 pileupKinds.size>0 时调用(调用方决定,此处不再过滤,避免多处条件分散)。
 */
export function appendBackpressureAudit(entry: BackpressureAuditEntry): void {
  try {
    const p = getBackpressureAuditPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8')
    // 软截断:成本高所以只在"可能超标"时检查(每 ~50 次 append 抽查一次)
    //   这里简单用 tickCount%50 触发,不精确但足够 —— 真实规模下 1 小时~72 次
    //   tick,最坏情况一天 1700 条,离 MAX_LINES 还远。
    if (entry.tickCount % 50 === 0) {
      truncateIfNeeded(p)
    }
  } catch {
    // fail-open:审计是辅助功能,不影响主路径
  }
}

/**
 * 读取所有审计记录(测试 + 未来 /evolve-audit 命令用)。
 * 损坏行静默跳过,不抛异常。
 */
export function loadBackpressureAudit(): BackpressureAuditEntry[] {
  try {
    const p = getBackpressureAuditPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: BackpressureAuditEntry[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj && typeof obj === 'object' && typeof obj.ts === 'string') {
          out.push(obj as BackpressureAuditEntry)
        }
      } catch {
        // 单行损坏跳过,继续
      }
    }
    return out
  } catch {
    return []
  }
}

/** 硬截断:超 MAX_LINES 时保留尾部 KEEP_LINES。fail-open。 */
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
    // 截断失败不影响后续 append
  }
}

/**
 * 测试用:显式触发截断(不依赖 tickCount%50 抽查)。
 * 生产路径应调用 appendBackpressureAudit;此函数仅供 smoke 测试验证截断逻辑。
 */
export function __forceTruncateForTests(): void {
  try {
    truncateIfNeeded(getBackpressureAuditPath())
  } catch {
    /* noop */
  }
}

export const __testInternals = { MAX_LINES, KEEP_LINES }
