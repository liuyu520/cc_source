/**
 * Phase 123(2026-04-24)— Health Digest 周期落盘。
 *
 * 把 kernel 健康快照周期写到磁盘,供外部工具(监控/仪表盘/CI)直接读盘。
 * 避免每次都启动 Claude Code 进程跑 /kernel-status --json。
 *
 * 与 /kernel-status --json(Ph124)的 payload 在核心字段上对齐,但此处
 * 只收录"冷态"历史快照 + 配置态,不含运行时的 scheduler state / runtimeMode
 * (那些需要进程上下文才有意义)。
 *
 * 调用点:agentScheduler 后台 emergence tick 末尾(applyPileup 之后)。
 * 失败静默 fail-open,不影响 tick 主干。env CLAUDE_EVOLVE_HEALTH_DIGEST=off
 * 完全禁用周期写入。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getHealthDigestPath, getHealthDigestHistoryPath } from '../paths.js'

export type AuditDecision = 'observe' | 'env-on' | 'env-off' | 'auto-gate'
export type AnomalyKind = 'SHADOW_PILEUP' | 'ARCHIVE_BIAS' | 'STAGNATION' | 'HIGH_ATTRITION'

export interface HealthDigest {
  version: 1
  generatedAt: string
  audit: {
    totalAll: number
    sample: number
    distribution: Record<AuditDecision, number>
  } | null
  anomaly: {
    totalAll: number
    sample: number
    distribution: Record<AnomalyKind, number>
  } | null
  adaptiveThresholds: {
    enabled: boolean
    updatedAt: string | null
    thresholds: Record<string, { value: number; recentPileups24h: number }>
  } | null
  contractHealth: { l1: boolean; l2: boolean; l3: boolean; passCount: number } | null
}

const DIGEST_SAMPLE_N = 30

export function isHealthDigestEnabled(): boolean {
  return process.env.CLAUDE_EVOLVE_HEALTH_DIGEST !== 'off'
}

/**
 * 构造 health digest 快照。每节独立 try/catch fail-open 降级为 null。
 *
 * 这里是纯"读"的聚合函数,不写盘、不触发任何副作用。
 */
export async function buildHealthDigest(): Promise<HealthDigest> {
  let audit: HealthDigest['audit'] = null
  let anomaly: HealthDigest['anomaly'] = null
  try {
    const { loadBackpressureAudit } = await import('./backpressureAudit.js')
    const all = loadBackpressureAudit()
    const sample = all.slice(-DIGEST_SAMPLE_N)
    const dist: Record<AuditDecision, number> = {
      observe: 0,
      'env-on': 0,
      'env-off': 0,
      'auto-gate': 0,
    }
    for (const e of sample) {
      if (e.decision in dist) dist[e.decision as AuditDecision]++
    }
    audit = { totalAll: all.length, sample: sample.length, distribution: dist }
  } catch {
    // fail-open
  }
  try {
    const { loadAnomalyHistory } = await import('./anomalyHistory.js')
    const all = loadAnomalyHistory()
    const sample = all.slice(-DIGEST_SAMPLE_N)
    const dist: Record<AnomalyKind, number> = {
      SHADOW_PILEUP: 0,
      ARCHIVE_BIAS: 0,
      STAGNATION: 0,
      HIGH_ATTRITION: 0,
    }
    for (const entry of sample) {
      for (const a of entry.anomalies ?? []) {
        if (a.kind in dist) dist[a.kind as AnomalyKind]++
      }
    }
    anomaly = { totalAll: all.length, sample: sample.length, distribution: dist }
  } catch {
    // fail-open
  }

  let adaptiveThresholds: HealthDigest['adaptiveThresholds'] = null
  try {
    const { loadAdaptiveThresholds, isAdaptiveThresholdEnabled } = await import(
      './adaptiveThresholds.js'
    )
    const state = loadAdaptiveThresholds()
    const thresholds: Record<string, { value: number; recentPileups24h: number }> = {}
    for (const [k, v] of Object.entries(state.thresholds ?? {})) {
      thresholds[k] = {
        value: (v as { value: number }).value,
        recentPileups24h: (v as { recentPileups24h: number }).recentPileups24h,
      }
    }
    adaptiveThresholds = {
      enabled: isAdaptiveThresholdEnabled(),
      updatedAt: state.updatedAt ?? null,
      thresholds,
    }
  } catch {
    // fail-open
  }

  let contractHealth: HealthDigest['contractHealth'] = null
  try {
    const { getAdvisoryMiningDiagnostics } = await import(
      '../emergence/patternMiner.js'
    )
    const fm = getAdvisoryMiningDiagnostics({ topN: 0 }).fusionMapping
    const l1 =
      fm.orphanContractCategories.length === 0 &&
      fm.missingContractCategories.length === 0
    const l2 = fm.unmappedWithEntity === 0
    const l3 = fm.undeclaredEmittedCategories.length === 0
    contractHealth = { l1, l2, l3, passCount: [l1, l2, l3].filter(Boolean).length }
  } catch {
    // fail-open
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    audit,
    anomaly,
    adaptiveThresholds,
    contractHealth,
  }
}

/**
 * 原子写:tmp 文件 + rename,避免半截写被读。
 * 失败静默 fail-open,不抛异常。
 */
export function saveHealthDigest(digest: HealthDigest): boolean {
  try {
    const target = getHealthDigestPath()
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(digest, null, 2), 'utf8')
    renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

/**
 * 读磁盘快照。文件不存在 / 损坏 / 版本不匹配 → 返回 null(fail-open)。
 */
export function loadHealthDigest(): HealthDigest | null {
  try {
    const p = getHealthDigestPath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as HealthDigest
    if (parsed && parsed.version === 1 && typeof parsed.generatedAt === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

// ── Ph127(2026-04-24)health digest history(append-only ndjson)──

/**
 * 历史行数硬上限。超过时 rotate 重写尾部 MAX_HISTORY 行。
 * 每行大约 1-2 KB,1000 行约 1-2 MB 上限,覆盖几十天的 tick 历史。
 */
export const MAX_HISTORY_LINES = 1000

/** Ph132 — 时间维度 TTL(默认 7 天)。env=0 关闭 TTL 剪尾,只保留行数剪。 */
export const DEFAULT_HISTORY_TTL_DAYS = 7
export const MAX_HISTORY_TTL_DAYS = 365  // 安全上限,防止 env 填入荒谬值
export function getHistoryTtlDays(): number {
  const raw = process.env.CLAUDE_EVOLVE_HEALTH_HISTORY_TTL_DAYS
  if (raw === undefined || raw === '') return DEFAULT_HISTORY_TTL_DAYS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HISTORY_TTL_DAYS
  return Math.min(n, MAX_HISTORY_TTL_DAYS)
}

/** Ph127 env 开关,与 digest 主开关解耦。 */
export function isHealthDigestHistoryEnabled(): boolean {
  return process.env.CLAUDE_EVOLVE_HEALTH_HISTORY !== 'off'
}

/**
 * 追加一行 digest 到 history ndjson。
 * 每 N 次 append 触发一次 rotate(读尾部 MAX_HISTORY_LINES 行重写)。
 * fail-open:写失败不抛异常。
 *
 * 注意:为了性能,这里不每次都读全文件做 rotate。我们用 "append 后
 * 如果体积超过阈值则 rotate" 的启发策略——读文件只在偶发 rotate 路径,
 * 日常 append 走直接写。
 */
export function appendHealthDigestHistory(digest: HealthDigest): boolean {
  try {
    const p = getHealthDigestHistoryPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(digest) + '\n', 'utf8')
    // 启发 rotate:每 100 次 append 检测一次行数(cheap - read & split)。
    // 之所以不每次都检,是为了把 steady state 的开销压到最低。
    // 用 hash(generatedAt) 做伪随机触发,避免多进程都踩到同一 tick 触发。
    const tick = Date.parse(digest.generatedAt)
    if (Number.isFinite(tick) && tick % 100 === 0) {
      rotateHealthDigestHistoryIfNeeded()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Rotate 触发条件(任一满足即 rotate):
 *   1. 行数 > MAX_HISTORY_LINES(Ph127 行为,保留)
 *   2. Ph132 新增:存在 generatedAt 早于 now-TTL 的条目,且 TTL > 0
 *
 * 执行顺序:先按时间过滤,再按行数截尾。这样既丢掉过期历史,又保证
 * 短时间高频 tick 场景下仍能压到 MAX。
 *
 * 读全文件 → parse 每行 → 时间过滤 → 行数截尾 → 原子写回(tmp+rename)。
 * 损坏行(无法 parse 的) 同样用 Ph127 逻辑静默丢弃 —— 因为 rotate 本就有
 * "清理" 语义,这里把损坏行一并清除是最合理的副作用。
 * 失败静默。
 */
export function rotateHealthDigestHistoryIfNeeded(): boolean {
  try {
    const p = getHealthDigestHistoryPath()
    if (!existsSync(p)) return false
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split('\n').filter(l => l.length > 0)
    const ttlDays = getHistoryTtlDays()
    const ttlCutoffMs = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : null

    // 预先解析 + 时间过滤。保持原始 JSON 串(避免序列化差异),仅以解析结果
    // 判断 generatedAt 是否在 TTL 窗口内。
    const filtered: string[] = []
    for (const line of lines) {
      let keep = true
      if (ttlCutoffMs !== null) {
        try {
          const obj = JSON.parse(line) as { generatedAt?: string }
          const t = obj?.generatedAt ? Date.parse(obj.generatedAt) : NaN
          if (Number.isFinite(t) && t < ttlCutoffMs) keep = false
        } catch {
          // 损坏行 → 丢弃(rotate 语义下合理)
          keep = false
        }
      }
      if (keep) filtered.push(line)
    }

    // 触发条件:(1) 原 lines 超 MAX_HISTORY_LINES  或  (2) TTL 剪掉了条目
    const droppedByTtl = lines.length - filtered.length
    const overLimit = filtered.length > MAX_HISTORY_LINES
    if (droppedByTtl === 0 && !overLimit) return false

    const kept = filtered.slice(-MAX_HISTORY_LINES)
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8')
    renameSync(tmp, p)
    return true
  } catch {
    return false
  }
}

/**
 * 读 history ndjson,返回 parse 成功的条目数组(尾部 limit 条)。
 * 损坏行静默跳过 —— ndjson 单行损坏不该污染整体查询。
 * limit=0 或负值 → 返回空数组;默认返回全部。
 */
export function loadHealthDigestHistory(limit?: number): HealthDigest[] {
  try {
    const p = getHealthDigestHistoryPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split('\n').filter(l => l.length > 0)
    const parsed: HealthDigest[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as HealthDigest
        if (obj && obj.version === 1 && typeof obj.generatedAt === 'string') {
          parsed.push(obj)
        }
      } catch {
        // 损坏行跳过,不污染其它条目
      }
    }
    if (limit !== undefined) {
      if (limit <= 0) return []
      return parsed.slice(-limit)
    }
    return parsed
  } catch {
    return []
  }
}

