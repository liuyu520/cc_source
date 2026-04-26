/**
 * Phase 142(2026-04-24)— observer warnings 历史流水。
 *
 * Ph141 在 /kernel-status 聚合了 audit / anomaly / history 三 ledger 的
 * stats warnings(observerWarnings = {total, byLedger, items}),但它只在
 * 当次命令响应里出现,一过 tick 就蒸发。Ph142 把这个聚合结果每 emergence
 * tick 写一行 ndjson,让"观察者的观察者"也有可回溯的历史:
 *
 *   1. 趋势分析 —— 过去 N 小时 CAP_HIGH / STALE_NEWEST 出现频率;
 *   2. 持续多 tick 未消散的告警 = 真实运维问题,值得升级;
 *   3. 与 Ph115 anomaly-history 姊妹,同一拨 1000/900 规模控制。
 *
 * 设计契合:
 *   - append-only, fail-open
 *   - 空窗=健康:total===0 时 *不* 写(与 anomalyHistory 相同哲学,
 *     避免 tick 噪声淹没真实告警);由调用方(background.ts)保证
 *   - 截断策略与 anomalyHistory.ts 相同:tickCount % 50 抽查
 *
 * Phase 146(2026-04-24)— 时间维度 TTL(默认 30 天,对齐 health TTL 体系)。
 *   observer-history 做长时间调查时价值很高(例如 "近 30 天每日告警总量"),
 *   仅靠 1000/900 行数上限在稳定期会把历史留得过短;在异常期又可能被淹没。
 *   引入 TTL:
 *     - env=CLAUDE_EVOLVE_OBSERVER_HISTORY_TTL_DAYS(默认 30,0=关闭 TTL)
 *     - rotate 时先按 entry.ts 过滤超期,再按 MAX 行截尾
 *     - load 本身不过滤(保持调用方能看到所有物理存在数据,类似 health)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getObserverWarningsHistoryPath } from '../paths.js'

export type ObserverLedger = 'audit' | 'anomaly' | 'history'

export interface ObserverWarningItem {
  ledger: ObserverLedger
  code: string
  message: string
}

export interface ObserverWarningsHistoryEntry {
  ts: string
  tickCount: number
  total: number
  byLedger: {
    audit: number
    anomaly: number
    history: number
  }
  items: ObserverWarningItem[]
}

const MAX_LINES = 1000
const KEEP_LINES = 900

/** Ph142:公开 MAX_LINES 作为 kernel-status 容量基准(Ph143 会消费)。 */
export const MAX_OBSERVER_WARNINGS_LINES = MAX_LINES

/**
 * Ph146(2026-04-24)— observer-history TTL。
 *   - 默认 30 天:比 health TTL(7)长,因为 observer 告警更稀疏,30 天
 *     留足跨月调查窗口;同时也给 --since=30d 类查询留足磁盘数据。
 *   - env=0 关闭 TTL(仅靠行数截尾)
 *   - 上限 365 天,防止 env 填入荒谬值
 */
export const DEFAULT_OBSERVER_HISTORY_TTL_DAYS = 30
export const MAX_OBSERVER_HISTORY_TTL_DAYS = 365
export function getObserverHistoryTtlDays(): number {
  const raw = process.env.CLAUDE_EVOLVE_OBSERVER_HISTORY_TTL_DAYS
  if (raw === undefined || raw === '') return DEFAULT_OBSERVER_HISTORY_TTL_DAYS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_OBSERVER_HISTORY_TTL_DAYS
  return Math.min(n, MAX_OBSERVER_HISTORY_TTL_DAYS)
}

/**
 * 追加一条历史记录。fail-open。
 * 调用方负责确保 entry.total>0(此处不再过滤,保持职责单一,与 anomaly 同策略)。
 */
export function appendObserverWarningsHistory(entry: ObserverWarningsHistoryEntry): void {
  try {
    const p = getObserverWarningsHistoryPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8')
    // 抽查截断:与 Ph115 同策略,每 ~50 次 append 做一次硬上限/TTL 检查
    if (entry.tickCount % 50 === 0) {
      rotateIfNeeded(p)
    }
  } catch {
    /* fail-open */
  }
}

/**
 * 读取所有历史记录。损坏行静默跳过。
 * 注:load 本身不做 TTL 过滤(保持与 healthDigest loadHistory 同策略:
 *     物理存在就返回;TTL 仅在 rotate 时生效)。调用方若需时间窗过滤,
 *     用 /evolve-triage --since=6h 等参数(Ph145)。
 */
export function loadObserverWarningsHistory(): ObserverWarningsHistoryEntry[] {
  try {
    const p = getObserverWarningsHistoryPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: ObserverWarningsHistoryEntry[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (
          obj && typeof obj === 'object'
          && typeof obj.ts === 'string'
          && typeof obj.total === 'number'
          && Array.isArray(obj.items)
          && obj.byLedger && typeof obj.byLedger === 'object'
        ) {
          out.push(obj as ObserverWarningsHistoryEntry)
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

/**
 * Ph146(2026-04-24)— rotate 策略:
 *   1. 先按 TTL 过滤 entries(ts 早于 now-TTL*86400s 丢弃);ttl=0 跳过
 *   2. 再按 MAX_LINES 行数截尾,保留最新 KEEP_LINES
 *   3. 原子写回(tmp+rename)
 *
 * 触发条件(任一满足):TTL 剪掉了条目 或 行数超 MAX。
 * 损坏行一并清除(rotate 天然带"清理"语义)。
 */
function rotateIfNeeded(path: string): boolean {
  try {
    if (!existsSync(path)) return false
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const ttlDays = getObserverHistoryTtlDays()
    const ttlCutoffMs = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : null

    const filtered: string[] = []
    for (const line of lines) {
      let keep = true
      if (ttlCutoffMs !== null) {
        try {
          const obj = JSON.parse(line) as { ts?: string }
          const t = obj?.ts ? Date.parse(obj.ts) : NaN
          if (Number.isFinite(t) && t < ttlCutoffMs) keep = false
          if (!Number.isFinite(t)) keep = false // 无法解析 ts 的也丢(rotate 语义)
        } catch {
          keep = false // 损坏行 → 丢弃
        }
      }
      if (keep) filtered.push(line)
    }

    const droppedByTtl = lines.length - filtered.length
    const overLimit = filtered.length > MAX_LINES
    if (droppedByTtl === 0 && !overLimit) return false

    const kept = overLimit ? filtered.slice(-KEEP_LINES) : filtered
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Ph146:显式公开 rotate —— /evolve-status 等运维命令可主动触发。
 */
export function rotateObserverWarningsHistoryIfNeeded(): boolean {
  try {
    return rotateIfNeeded(getObserverWarningsHistoryPath())
  } catch {
    return false
  }
}

/** 测试用:显式触发 rotate(含 TTL + 行数)。 */
export function __forceTruncateForTests(): void {
  try {
    rotateIfNeeded(getObserverWarningsHistoryPath())
  } catch {
    /* noop */
  }
}

export const __testInternals = { MAX_LINES, KEEP_LINES }
