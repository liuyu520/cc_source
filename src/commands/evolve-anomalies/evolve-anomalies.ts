/**
 * Phase 116(2026-04-24)— /evolve-anomalies 命令实现
 *
 * 读取 Phase 115 写入的 anomaly-history.ndjson,展示 4 节面板:
 *   1. Overview:path、total、time range
 *   2. Anomaly Kind Distribution:4 种 kind 的计数 + 百分比
 *   3. Top Target Kinds:对针对性 anomaly 的 targetKind 聚合排名
 *   4. Recent Timeline:默认 20 条最新条目,--limit N 可调(上限 200)
 *
 * 设计原则(与 Ph114 /evolve-audit 对齐):
 *   - 只读零副作用
 *   - 每节独立 try/catch,互不影响
 *   - fail-open:空文件/损坏行都降级为友好提示
 *
 * 注意:total 按"条目数"计,而非"anomaly 数" —— 一个 tick 可能同时触发
 * 多个 anomaly,它们落在同一条 entry 里;分布计数按"出现在哪些 entry 中"算。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  loadAnomalyHistory,
  type AnomalyHistoryEntry,
  type AnomalyKindHistory,
  MAX_ANOMALY_LINES,
} from '../../services/autoEvolve/arena/anomalyHistory.js'
import { getAnomalyHistoryPath } from '../../services/autoEvolve/paths.js'
import { computeStatsWarnings, formatWarningsMarkdown } from '../../services/autoEvolve/arena/statsWarnings.js'

/** 解析 `--limit N` / `--limit=N`;异常回落 20,上限 200。 */
function parseLimit(args: string): number {
  const DEFAULT = 20
  const MAX = 200
  if (!args) return DEFAULT
  const m = /--limit[=\s]+(\d+)/.exec(args)
  if (!m) return DEFAULT
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT
  return Math.min(n, MAX)
}

/**
 * Ph118(2026-04-24)—— `--since=30m|2h|1d|45s` 时间窗解析。
 * 与 /evolve-audit 共用同一语法,返回毫秒数;缺省/非法返回 null。
 */
function parseSinceMs(args: string): number | null {
  if (!args) return null
  const m = /--since[=\s]+(\d+)([smhd])/i.exec(args)
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2].toLowerCase()
  const mult =
    unit === 's' ? 1000
      : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
          : 86_400_000
  return n * mult
}

/** 把毫秒窗口回显成与用户输入对称的可读标签。 */
function fmtSince(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * Ph119(2026-04-24)—— `--kind=skill` 维度过滤。
 * 语义:仅保留 anomalies 中存在 `targetKind === 指定 kind` 的 entry。
 * 副作用:STAGNATION / HIGH_ATTRITION 是全局指标(targetKind=null),指定
 *   --kind 时天然排除它们(这正是 drill-down 的意图)。
 */
const KNOWN_KINDS = ['skill', 'command', 'hook', 'agent', 'prompt'] as const
type KindFilter = typeof KNOWN_KINDS[number]
function parseKind(args: string): { kind: KindFilter | null; invalid: string | null } {
  if (!args) return { kind: null, invalid: null }
  const m = /--kind[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return { kind: null, invalid: null }
  const v = m[1].toLowerCase()
  if ((KNOWN_KINDS as readonly string[]).includes(v)) {
    return { kind: v as KindFilter, invalid: null }
  }
  return { kind: null, invalid: m[1] }
}

/** Ph122:`--json` 开关 —— 同 /evolve-audit 的实现,保持语义对齐。 */
function parseJsonFlag(args: string): boolean {
  if (!args) return false
  return /--json(\b|=|\s|$)/.test(args)
}

/**
 * Ph136(2026-04-24)—— `--compare` / `--compare=N` 窗口对比开关。
 * 和 Ph133 /evolve-health / Ph135 /evolve-audit 三姐妹命令语义一致:
 * 默认 N=20,上限 1000,异常值(=0/负数/非数)回落默认。
 * entries 按 ts 升序:newer = 末尾 N,older = 再前 N。不足 2N 时友好提示。
 */
function parseCompareFlag(args: string): number | null {
  if (!args) return null
  const m = /--compare(?:[=\s]+(-?\d+|\S+))?/.exec(args)
  if (!m) return null
  if (m[1] === undefined) return 20
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(n, 1000)
}

/** Ph136:带符号 delta 格式化,与 /evolve-audit 对齐。 */
function fmtDeltaSign(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return String(n)
  return '±0'
}

/** Ph136:单维度的 {from, to, delta} triple。 */
type AnomalyDeltaInt = { from: number; to: number; delta: number }

type AnomalyCompareDelta = {
  compareN: number
  older: { first: string | null; last: string | null; n: number }
  newer: { first: string | null; last: string | null; n: number }
  kindDistribution: Record<AnomalyKindHistory, AnomalyDeltaInt>
  topTargetKinds: Array<{ kind: string; from: number; to: number; delta: number }>
}

/**
 * Ph136:计算两个 anomaly 窗口的 kindDistribution + targetKind tally 差值。
 *   - kindDistribution:entry 维度计数(同 Section 2),4 个 kind 全输出。
 *   - topTargetKinds:只保留 delta !== 0 的 kind,按 |delta| 降序 top10。
 * 输入假设:older 时间早于 newer,两侧各有 compareN 条,已按 ts 升序。
 */
function computeAnomalyDelta(
  newer: AnomalyHistoryEntry[],
  older: AnomalyHistoryEntry[],
  compareN: number,
): AnomalyCompareDelta {
  const KINDS: AnomalyKindHistory[] = ['SHADOW_PILEUP', 'ARCHIVE_BIAS', 'STAGNATION', 'HIGH_ATTRITION']
  // entry 维度 kindDistribution:每 entry 中该 kind 只计一次
  function tally(list: AnomalyHistoryEntry[]): Record<AnomalyKindHistory, number> {
    const t: Record<AnomalyKindHistory, number> = {
      SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0,
    }
    for (const e of list) {
      const seen = new Set<AnomalyKindHistory>()
      for (const a of e.anomalies ?? []) {
        if (!seen.has(a.kind) && a.kind in t) {
          t[a.kind]++
          seen.add(a.kind)
        }
      }
    }
    return t
  }
  // targetKind tally:累计出现次数(同 Section 3 语义),非 entry 去重
  function targetTally(list: AnomalyHistoryEntry[]): Record<string, number> {
    const t: Record<string, number> = {}
    for (const e of list) {
      for (const a of e.anomalies ?? []) {
        if (a.targetKind) t[a.targetKind] = (t[a.targetKind] ?? 0) + 1
      }
    }
    return t
  }
  const tA = tally(older)
  const tB = tally(newer)
  const kindDistribution = {} as Record<AnomalyKindHistory, AnomalyDeltaInt>
  for (const k of KINDS) {
    kindDistribution[k] = { from: tA[k], to: tB[k], delta: tB[k] - tA[k] }
  }
  const ttA = targetTally(older)
  const ttB = targetTally(newer)
  const allKeys = new Set<string>([...Object.keys(ttA), ...Object.keys(ttB)])
  const topTargetKinds = Array.from(allKeys)
    .map(k => {
      const from = ttA[k] ?? 0
      const to = ttB[k] ?? 0
      return { kind: k, from, to, delta: to - from }
    })
    .filter(x => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10)
  return {
    compareN,
    older: {
      first: older[0]?.ts ?? null,
      last: older[older.length - 1]?.ts ?? null,
      n: older.length,
    },
    newer: {
      first: newer[0]?.ts ?? null,
      last: newer[newer.length - 1]?.ts ?? null,
      n: newer.length,
    },
    kindDistribution,
    topTargetKinds,
  }
}

/**
 * Ph120(2026-04-24)—— `--anomaly-kind=SHADOW_PILEUP` 细粒度过滤。
 * 白名单:4 种 Ph105 anomaly kind 全小写/全大写都接受。
 * 与 --kind(targetKind)语义不同:此参数按 anomaly 本身的 kind 分桶(如
 * STAGNATION),而 --kind 按 organism family(如 skill)分桶。二者可组合。
 * entry 维度命中:只要 entry 的 anomalies 里有一个 anomaly.kind 匹配就保留。
 */
const KNOWN_ANOMALY_KINDS = ['SHADOW_PILEUP', 'ARCHIVE_BIAS', 'STAGNATION', 'HIGH_ATTRITION'] as const
type AnomalyKindFilter = typeof KNOWN_ANOMALY_KINDS[number]
function parseAnomalyKind(args: string): { akind: AnomalyKindFilter | null; invalid: string | null } {
  if (!args) return { akind: null, invalid: null }
  const m = /--anomaly-kind[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return { akind: null, invalid: null }
  const v = m[1].toUpperCase().replace(/-/g, '_')
  if ((KNOWN_ANOMALY_KINDS as readonly string[]).includes(v)) {
    return { akind: v as AnomalyKindFilter, invalid: null }
  }
  return { akind: null, invalid: m[1] }
}

/**
 * Ph125(2026-04-24)—— `--bucket=hour|day` 时间桶聚合。
 * 与 /evolve-audit 共用语法,命中后按 anomaly kind 分档:🔥📦❄️⚠️。
 * 非法值不过滤,Overview 显式 ignored。
 */
const KNOWN_BUCKETS = ['hour', 'day'] as const
type BucketFilter = typeof KNOWN_BUCKETS[number]
function parseBucket(args: string): { bucket: BucketFilter | null; invalid: string | null } {
  if (!args) return { bucket: null, invalid: null }
  const m = /--bucket[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return { bucket: null, invalid: null }
  const v = m[1].toLowerCase()
  if ((KNOWN_BUCKETS as readonly string[]).includes(v)) {
    return { bucket: v as BucketFilter, invalid: null }
  }
  return { bucket: null, invalid: m[1] }
}

/** 把 ISO 时间戳归入 bucket key(hour=YYYY-MM-DDTHH / day=YYYY-MM-DD)。 */
function bucketKey(iso: string, bucket: BucketFilter): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  if (bucket === 'day') return d.toISOString().slice(0, 10)
  return d.toISOString().slice(0, 13)
}

/** ISO → 相对时间(与 Ph114 同实现,保持视觉一致)。 */
function fmtRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const delta = Date.now() - t
  if (delta < 0) return 'in future'
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

/** kind → Ph105 emoji(marker)速查,便于列头展示。 */
function kindIcon(kind: AnomalyKindHistory): string {
  switch (kind) {
    case 'SHADOW_PILEUP':
      return '🔥'
    case 'ARCHIVE_BIAS':
      return '📦'
    case 'STAGNATION':
      return '❄️'
    case 'HIGH_ATTRITION':
      return '⚠️'
  }
}

/**
 * Ph138(2026-04-24)—— JSON payload 内嵌 stats 字段。
 * 与 /evolve-audit / /kernel-status anomalyStats 字段对齐,消费方一次调用就能
 * 拿到 total/capPct/ageSpan/sinceNewest。stats 反映磁盘全量,不随 filter 变化。
 *
 * Ph139(2026-04-24)—— 新增 warnings 数组。与 audit 的差异:
 * anomaly 的"空窗 = 系统健康",所以不对 sinceNewest 告警,只在 capPct≥80 时
 * 给 CAP_HIGH。消费方能靠 code 区分语义严重程度。
 */
type StatsWarning = {
  code: 'CAP_HIGH' | 'STALE_NEWEST'
  message: string
}

type JsonStats = {
  total: number
  maxLines: number
  capPct: number
  oldestAt: string | null
  newestAt: string | null
  ageSpanMs: number | null
  sinceNewestMs: number | null
  warnings: StatsWarning[]
}

const ANOMALY_CAP_HIGH_PCT = 80

function buildAnomalyStats(rawEntries: AnomalyHistoryEntry[]): JsonStats {
  const total = rawEntries.length
  const maxLines = MAX_ANOMALY_LINES
  const capPct = Number(((total / maxLines) * 100).toFixed(1))
  if (total === 0) {
    return { total, maxLines, capPct, oldestAt: null, newestAt: null, ageSpanMs: null, sinceNewestMs: null, warnings: [] }
  }
  const oldest = rawEntries[0]
  const newest = rawEntries[total - 1]
  const oldestMs = Date.parse(oldest.ts)
  const newestMs = Date.parse(newest.ts)
  const ageSpanMs = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
  const sinceNewestMs = Number.isFinite(newestMs) ? Date.now() - newestMs : null
  // Ph140(2026-04-24):warnings 由 arena/statsWarnings 的 computeStatsWarnings 统一计算。
  //   staleHint=null 体现 anomaly 的"空窗 = 健康"特例(源单源,语义仍保留)。
  const warnings = computeStatsWarnings({
    total, maxLines, sinceNewestMs, staleHint: null, capPct,
  })
  return {
    total, maxLines, capPct,
    oldestAt: oldest.ts, newestAt: newest.ts,
    ageSpanMs, sinceNewestMs,
    warnings,
  }
}

export const call: LocalJSXCommandCall = async (onDone, _ctx, args) => {
  const lines: string[] = ['## autoEvolve Anomaly History (Phase 115/116)\n']
  const limit = parseLimit(args ?? '')
  const sinceMs = parseSinceMs(args ?? '')
  const { kind: kindFilter, invalid: invalidKind } = parseKind(args ?? '')
  const { akind: anomalyKindFilter, invalid: invalidAnomalyKind } = parseAnomalyKind(args ?? '')
  const { bucket: bucketFilter, invalid: invalidBucket } = parseBucket(args ?? '')

  let entries: AnomalyHistoryEntry[] = []
  try {
    entries = loadAnomalyHistory()
  } catch {
    /* fail-open */
  }
  // Ph138:rawEntries 过滤前全量快照,用于 stats 磁盘级容量/新鲜度。
  const rawEntries: AnomalyHistoryEntry[] = entries.slice()

  // Ph118:时间窗过滤;先于任何聚合,让所有节同步反映窗口。
  //   过滤时间戳非法的条目,防止 Date.parse=NaN 污染比较结果。
  let filteredOut = 0
  if (sinceMs !== null) {
    const cutoff = Date.now() - sinceMs
    const before = entries.length
    entries = entries.filter(e => {
      const t = Date.parse(e.ts)
      return Number.isFinite(t) && t >= cutoff
    })
    filteredOut = before - entries.length
  }

  // Ph119:kind 维度过滤 —— 只保留至少有一个 anomaly 的 targetKind == 指定 kind
  //   的 entry。语义副作用:STAGNATION/HIGH_ATTRITION 天然 targetKind=null,
  //   因此 drill-down 视图里只会看到 SHADOW_PILEUP/ARCHIVE_BIAS 两种 kind
  //   —— 这是期望行为(用户想看"skill 的出错画像"而非全局趋势)。
  let kindFilteredOut = 0
  if (kindFilter !== null) {
    const before = entries.length
    entries = entries.filter(e =>
      (e.anomalies ?? []).some(a => a.targetKind === kindFilter),
    )
    kindFilteredOut = before - entries.length
  }

  // Ph120:anomaly-kind 维度过滤 —— 与 kind(targetKind)正交。
  //   命中规则:entry 中至少一个 anomaly.kind 匹配即保留。
  //   与 kind 组合时得到交集(skill 相关 && SHADOW_PILEUP 命中)。
  let anomalyKindFilteredOut = 0
  if (anomalyKindFilter !== null) {
    const before = entries.length
    entries = entries.filter(e =>
      (e.anomalies ?? []).some(a => a.kind === anomalyKindFilter),
    )
    anomalyKindFilteredOut = before - entries.length
  }

  // Ph125:时间桶聚合 —— 与 /evolve-audit 对称实现。
  //   计数策略:每 entry 在一个 bucket 中,对其 anomalies 里出现的 kind 去重 +1
  //   (entry 维度),确保"某小时 SHADOW_PILEUP 命中数"与 Section 2 分布一致。
  const MAX_HOUR_BUCKETS = 24
  const MAX_DAY_BUCKETS = 14
  type AnomalyBucket = {
    key: string
    total: number
    byKind: Record<AnomalyKindHistory, number>
  }
  let timeBuckets: AnomalyBucket[] = []
  if (bucketFilter !== null) {
    const map = new Map<string, AnomalyBucket>()
    for (const e of entries) {
      const k = bucketKey(e.ts, bucketFilter)
      if (k === null) continue
      let b = map.get(k)
      if (!b) {
        b = {
          key: k,
          total: 0,
          byKind: { SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0 },
        }
        map.set(k, b)
      }
      b.total++
      const seen = new Set<AnomalyKindHistory>()
      for (const a of e.anomalies ?? []) {
        if (!seen.has(a.kind) && a.kind in b.byKind) {
          b.byKind[a.kind]++
          seen.add(a.kind)
        }
      }
    }
    const sorted = Array.from(map.values()).sort((a, b) => (a.key < b.key ? -1 : 1))
    const max = bucketFilter === 'hour' ? MAX_HOUR_BUCKETS : MAX_DAY_BUCKETS
    timeBuckets = sorted.slice(-max)
  }

  // Ph136(2026-04-24):--compare[=N] 短路 —— 在所有过滤/桶聚合已应用之后,
  //   优先于 JSON 短路判断。`--compare --json` / `--json --compare` 两种顺序
  //   都走 compare 分支,输出结构化 delta(而非常规 Section 视图)。
  //   语义:entries 按 ts 升序加载 → newer = 末尾 N,older = 再前 N。
  //   不足 2N 时给友好提示(markdown 或 JSON 各自对应),不抛。
  const compareN = parseCompareFlag(args ?? '')
  if (compareN !== null) {
    const wantJson = parseJsonFlag(args ?? '')
    const needed = compareN * 2
    if (entries.length < needed) {
      if (wantJson) {
        const payload = {
          phase: '136',
          path: getAnomalyHistoryPath(),
          delta: null,
          compareN,
          total: entries.length,
          stats: buildAnomalyStats(rawEntries),
          reason: `insufficient history: ${entries.length} entries, need at least ${needed}`,
        }
        onDone(JSON.stringify(payload, null, 2))
        return null
      }
      lines.push('### Delta (Phase 136)')
      lines.push(`(insufficient history: ${entries.length} entries, need at least ${needed} for --compare=${compareN})`)
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    const newer = entries.slice(-compareN)
    const older = entries.slice(-(compareN * 2), -compareN)
    const delta = computeAnomalyDelta(newer, older, compareN)
    if (wantJson) {
      const payload = {
        phase: '136',
        path: getAnomalyHistoryPath(),
        delta,
        compareN,
        total: entries.length,
        stats: buildAnomalyStats(rawEntries),
      }
      onDone(JSON.stringify(payload, null, 2))
      return null
    }
    // markdown 渲染
    lines.push(`### Delta (newer N=${compareN} vs previous N=${compareN}, Phase 136)`)
    if (delta.older.first && delta.older.last) {
      lines.push(`older window: ${fmtRelative(delta.older.first)} → ${fmtRelative(delta.older.last)} (n=${delta.older.n})`)
    }
    if (delta.newer.first && delta.newer.last) {
      lines.push(`newer window: ${fmtRelative(delta.newer.first)} → ${fmtRelative(delta.newer.last)} (n=${delta.newer.n})`)
    }
    lines.push('')
    lines.push('**kindDistribution (by entry)**')
    for (const k of ['SHADOW_PILEUP', 'ARCHIVE_BIAS', 'STAGNATION', 'HIGH_ATTRITION'] as AnomalyKindHistory[]) {
      const di = delta.kindDistribution[k]
      lines.push(`  ${kindIcon(k)} ${k.padEnd(16)} ${di.from} → ${di.to} (${fmtDeltaSign(di.delta)})`)
    }
    lines.push('')
    lines.push('**topTargetKinds changes**')
    if (delta.topTargetKinds.length === 0) {
      lines.push('  (no targetKind tally changed between windows)')
    } else {
      for (const c of delta.topTargetKinds) {
        lines.push(`  ${c.kind.padEnd(12)} ${c.from} → ${c.to} (${fmtDeltaSign(c.delta)})`)
      }
    }
    lines.push('')
    onDone(lines.join('\n'))
    return null
  }

  // Ph122(2026-04-24):--json 短路 —— 与 /evolve-audit 语义对齐,跳过
  //   markdown 渲染直接输出结构化 JSON。filters/filteredOut 字段齐全,让
  //   脚本消费方能分辨"窗口被空载过滤"还是"本就没有记录"。
  if (parseJsonFlag(args ?? '')) {
    const safe = <T,>(fn: () => T, fallback: T): T => {
      try { return fn() } catch { return fallback }
    }
    const kindDistribution = safe(() => {
      const d: Record<AnomalyKindHistory, number> = {
        SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0,
      }
      for (const e of entries) {
        const seen = new Set<AnomalyKindHistory>()
        for (const a of e.anomalies ?? []) {
          if (!seen.has(a.kind) && a.kind in d) {
            d[a.kind]++
            seen.add(a.kind)
          }
        }
      }
      return d
    }, { SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0 })
    const topTargetKinds = safe(() => {
      const tally: Record<string, number> = {}
      for (const e of entries) {
        const seen = new Set<string>()
        for (const a of e.anomalies ?? []) {
          if (a.targetKind && !seen.has(a.targetKind)) {
            tally[a.targetKind] = (tally[a.targetKind] ?? 0) + 1
            seen.add(a.targetKind)
          }
        }
      }
      return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10)
    }, [] as Array<[string, number]>)
    const payload = {
      phase: '115/116',
      path: getAnomalyHistoryPath(),
      stats: buildAnomalyStats(rawEntries),
      filters: {
        limit,
        sinceMs,
        kind: kindFilter,
        invalidKind,
        anomalyKind: anomalyKindFilter,
        invalidAnomalyKind,
        bucket: bucketFilter,
        invalidBucket,
      },
      filteredOut: {
        bySince: filteredOut,
        byKind: kindFilteredOut,
        byAnomalyKind: anomalyKindFilteredOut,
      },
      total: entries.length,
      timeRange: entries.length > 0
        ? { first: entries[0].ts, last: entries[entries.length - 1].ts }
        : null,
      kindDistribution,
      topTargetKinds,
      timeBuckets,
      recent: safe(() => entries.slice(-limit), [] as AnomalyHistoryEntry[]),
    }
    onDone(JSON.stringify(payload, null, 2))
    return null
  }

  // ── Section 1: Overview ──────────────────────────────────────
  try {
    lines.push('### Overview')
    lines.push(`path: ${getAnomalyHistoryPath()}`)
    if (sinceMs !== null) {
      lines.push(
        `time window: last ${fmtSince(sinceMs)}  (filtered out ${filteredOut} older entr${filteredOut === 1 ? 'y' : 'ies'})`,
      )
    }
    if (invalidKind !== null) {
      lines.push(
        `kind filter: (ignored — "${invalidKind}" is not a known kind; use one of: ${KNOWN_KINDS.join('/')})`,
      )
    } else if (kindFilter !== null) {
      lines.push(
        `kind filter: ${kindFilter}  (filtered out ${kindFilteredOut} unrelated entr${kindFilteredOut === 1 ? 'y' : 'ies'}; STAGNATION/HIGH_ATTRITION excluded as global)`,
      )
    }
    if (invalidAnomalyKind !== null) {
      lines.push(
        `anomaly-kind filter: (ignored — "${invalidAnomalyKind}" is not a known anomaly kind; use one of: ${KNOWN_ANOMALY_KINDS.join('/')})`,
      )
    } else if (anomalyKindFilter !== null) {
      lines.push(
        `anomaly-kind filter: ${anomalyKindFilter}  (filtered out ${anomalyKindFilteredOut} unrelated entr${anomalyKindFilteredOut === 1 ? 'y' : 'ies'})`,
      )
    }
    if (invalidBucket !== null) {
      // Ph125:时间桶非法值提示
      lines.push(
        `bucket: (ignored — "${invalidBucket}" is not a known bucket; use one of: ${KNOWN_BUCKETS.join('/')})`,
      )
    } else if (bucketFilter !== null) {
      lines.push(`bucket: ${bucketFilter}`)
    }
    if (entries.length === 0) {
      lines.push(
        anomalyKindFilter !== null
          ? `(no anomaly entries match anomaly-kind=${anomalyKindFilter}${kindFilter !== null ? ` kind=${kindFilter}` : ''}${sinceMs !== null ? ` within last ${fmtSince(sinceMs)}` : ''})`
          : kindFilter !== null
            ? `(no anomaly entries match kind=${kindFilter}${sinceMs !== null ? ` within last ${fmtSince(sinceMs)}` : ''})`
            : sinceMs !== null
              ? `(no anomaly entries within last ${fmtSince(sinceMs)})`
              : '(no anomaly entries yet — population has been healthy or stats not yet initialized)',
      )
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    const first = entries[0]
    const last = entries[entries.length - 1]
    lines.push(`total entries: ${entries.length}`)
    lines.push(
      `time range: ${first.ts} → ${last.ts}  (first=${fmtRelative(first.ts)}, last=${fmtRelative(last.ts)})`,
    )
    // Ph140(2026-04-24):markdown 消费 stats.warnings[],与 --json 单源。
    //   anomaly 只告 CAP_HIGH(空窗 = 健康),下面若出现 ⚠️ 意味文件快填满了。
    const _anomalyStatsForMd = buildAnomalyStats(rawEntries)
    if (_anomalyStatsForMd.warnings.length > 0) {
      for (const line of formatWarningsMarkdown(_anomalyStatsForMd.warnings)) {
        lines.push(line)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Overview')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 2: Anomaly Kind Distribution ─────────────────────
  // 计数策略:按"该 entry 至少出现一次此 kind"算(entry 维度,非 anomaly 维度)
  //   这样百分比可直接读作"多少比例的观测 tick 命中了此 kind"。
  try {
    lines.push('### Anomaly Kind Distribution (by entry)')
    const counts: Record<AnomalyKindHistory, number> = {
      SHADOW_PILEUP: 0,
      ARCHIVE_BIAS: 0,
      STAGNATION: 0,
      HIGH_ATTRITION: 0,
    }
    for (const e of entries) {
      const seen = new Set<AnomalyKindHistory>()
      for (const a of e.anomalies ?? []) {
        seen.add(a.kind)
      }
      for (const k of seen) {
        counts[k]++
      }
    }
    const total = entries.length
    const order: AnomalyKindHistory[] = [
      'SHADOW_PILEUP',
      'ARCHIVE_BIAS',
      'STAGNATION',
      'HIGH_ATTRITION',
    ]
    for (const k of order) {
      const c = counts[k]
      const pct = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0'
      lines.push(
        `  ${kindIcon(k)} ${k.padEnd(16)}  ${String(c).padStart(5)}  (${pct.padStart(5)}%)`,
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Anomaly Kind Distribution')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 2.5: Time Buckets(Ph125)─────────────────────────
  //   与 /evolve-audit 对称;每行 1 bucket,4 档 anomaly kind 紧随其后。
  if (bucketFilter !== null) {
    try {
      lines.push(`### Time Buckets (by ${bucketFilter})`)
      if (timeBuckets.length === 0) {
        lines.push('  (no buckets)')
      } else {
        for (const b of timeBuckets) {
          const bk = b.byKind
          lines.push(
            `  ${b.key.padEnd(13)}  total=${String(b.total).padStart(4)}   🔥${bk['SHADOW_PILEUP']}  📦${bk['ARCHIVE_BIAS']}  ❄️${bk['STAGNATION']}  ⚠️${bk['HIGH_ATTRITION']}`,
          )
        }
        const cap = bucketFilter === 'hour' ? MAX_HOUR_BUCKETS : MAX_DAY_BUCKETS
        if (timeBuckets.length === cap) {
          lines.push(`  (showing latest ${cap} buckets)`)
        }
      }
      lines.push('')
    } catch (e) {
      lines.push(`### Time Buckets (by ${bucketFilter})`)
      lines.push(`(unavailable: ${(e as Error).message})`)
      lines.push('')
    }
  }

  // ── Section 3: Top Target Kinds ──────────────────────────────
  // 只 kind-specific anomaly(SHADOW_PILEUP / ARCHIVE_BIAS)带 targetKind。
  //   按"每个 targetKind 累计出现次数"排名,帮助用户识别"哪个 kind 最频繁异常"。
  try {
    lines.push('### Top Target Kinds (for kind-specific anomalies)')
    const tally: Record<string, number> = {}
    for (const e of entries) {
      for (const a of e.anomalies ?? []) {
        if (a.targetKind) {
          tally[a.targetKind] = (tally[a.targetKind] ?? 0) + 1
        }
      }
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1])
    if (ranked.length === 0) {
      lines.push('  (no kind-specific anomaly recorded — all entries are STAGNATION/HIGH_ATTRITION)')
    } else {
      for (const [k, c] of ranked.slice(0, 10)) {
        lines.push(`  ${k.padEnd(12)}  ${String(c).padStart(5)} hit(s)`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Top Target Kinds')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 4: Recent Timeline ───────────────────────────────
  try {
    lines.push(`### Recent Timeline (last ${limit})`)
    const recent = entries.slice(-limit)
    for (const e of recent) {
      // 行格式:
      //   🔥📦 2 anomaly  tick=650  12m ago  pop=[S:11,s:0,a:0,v:0,24h↻:0]
      const rel = fmtRelative(e.ts)
      const icons = (e.anomalies ?? []).map(a => kindIcon(a.kind)).join('')
      const n = (e.anomalies ?? []).length
      const s = e.populationSnapshot ?? {
        totalShadow: 0, totalStable: 0, totalArchived: 0, totalVetoed: 0, transitions24h: 0,
      }
      const popTag = `pop=[S:${s.totalShadow},s:${s.totalStable},a:${s.totalArchived},v:${s.totalVetoed},24h↻:${s.transitions24h}]`
      lines.push(
        `  ${icons.padEnd(4)} ${String(n).padStart(2)} anomaly  tick=${e.tickCount}  ${rel}  ${popTag}`,
      )
    }
    if (recent.length < limit) {
      lines.push(`  (showing ${recent.length} of ${entries.length} total)`)
    }
    lines.push('')
  } catch (e) {
    lines.push('### Recent Timeline')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  onDone(lines.join('\n'))
  return null
}
