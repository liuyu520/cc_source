/**
 * Phase 126(2026-04-24)— /evolve-health 命令实现
 * Phase 128(2026-04-24)— 新增 --history[=N] 模式,读 Ph127 写入的 history ndjson
 *
 * 默认模式(无 --history):读 health-digest.json,展示 5 节面板:
 *   1. Overview:path / generatedAt / 新鲜度("5m ago")
 *   2. Audit Trend:observe / env-on / env-off / auto-gate 分布
 *   3. Anomaly Trend:4 类 anomaly 分布
 *   4. Adaptive Thresholds:per-kind 值 + recentPileups24h
 *   5. Contract Health:L1/L2/L3
 *
 * --history[=N] 模式(Ph128):读 health-digest-history.ndjson,展示时间轴表格
 *   - 每行 1 条 digest,列:generatedAt / 相对时间 / audit / anomaly / contract / adaptive
 *   - N 默认 10,上限 200,非法回落到默认
 *   - --json --history 返回 {entries, total, limit, path, enabled, reason?}
 *
 * 设计原则:
 *   - 只读磁盘,不调后台 API(所以不需要 scheduler / runtime 运行时状态)
 *   - 文件缺失/损坏 → 友好提示(可能是 tick 还没跑过 或 env=off)
 *   - --json 直接吐出原始 digest/history JSON(脚本消费)
 *
 * 与 /kernel-status --json(Ph124)的区别:
 *   - /kernel-status --json 聚合运行时 + 磁盘,需要进程上下文
 *   - /evolve-health --json 纯磁盘,任何进程都能跑
 */

import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  loadHealthDigest,
  loadHealthDigestHistory,
  isHealthDigestEnabled,
  isHealthDigestHistoryEnabled,
  MAX_HISTORY_LINES,
  type HealthDigest,
} from '../../services/autoEvolve/arena/healthDigest.js'
import {
  getHealthDigestPath,
  getHealthDigestHistoryPath,
} from '../../services/autoEvolve/paths.js'
import { computeStatsWarnings, formatWarningsMarkdown } from '../../services/autoEvolve/arena/statsWarnings.js'

/** 解析 --json 开关,与其它 evolve-* 命令语法保持一致。 */
function parseJsonFlag(args: string): boolean {
  if (!args) return false
  return /--json(\b|=|\s|$)/.test(args)
}

/**
 * Ph138(2026-04-24)—— JSON payload 内嵌 stats 字段。
 * 字段语义与 /kernel-status historyStats(Ph134)/ auditStats/anomalyStats(Ph137)
 * 对齐;基于 health history ndjson 计算。enabled=false 时 total=0 + enabled
 * 字段,消费方能区分"未启用"和"启用但为空"。capPct 一位小数以便告警脚本。
 *
 * Ph139(2026-04-24)—— 新增 warnings 数组。health history 规则与 audit 一致:
 * capPct≥80 → CAP_HIGH;sinceNewest>1h → STALE_NEWEST(emergence tick 卡住)。
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
  enabled: boolean
  warnings: StatsWarning[]
}

const HEALTH_CAP_HIGH_PCT = 80
const STALE_HEALTH_MS = 3_600_000

function buildHealthStats(allHistory: HealthDigest[] | null): JsonStats {
  const maxLines = MAX_HISTORY_LINES
  if (allHistory === null) {
    return {
      total: 0, maxLines, capPct: 0,
      oldestAt: null, newestAt: null,
      ageSpanMs: null, sinceNewestMs: null,
      enabled: false,
      warnings: [],
    }
  }
  const total = allHistory.length
  const capPct = Number(((total / maxLines) * 100).toFixed(1))
  if (total === 0) {
    return {
      total, maxLines, capPct,
      oldestAt: null, newestAt: null,
      ageSpanMs: null, sinceNewestMs: null,
      enabled: true,
      warnings: [],
    }
  }
  const oldest = allHistory[0]
  const newest = allHistory[total - 1]
  const oldestMs = Date.parse(oldest.generatedAt)
  const newestMs = Date.parse(newest.generatedAt)
  const ageSpanMs = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
  const sinceNewestMs = Number.isFinite(newestMs) ? Date.now() - newestMs : null
  // Ph140(2026-04-24):warnings 由 arena/statsWarnings 的 computeStatsWarnings 统一计算。
  //   staleHint='emergence tick':health history 由 emergence tick 写入,卡 1h = tick 停工。
  const warnings = computeStatsWarnings({
    total, maxLines, sinceNewestMs, staleHint: 'emergence tick', capPct,
  })
  return {
    total, maxLines, capPct,
    oldestAt: oldest.generatedAt,
    newestAt: newest.generatedAt,
    ageSpanMs, sinceNewestMs,
    enabled: true,
    warnings,
  }
}

/** Ph138:regular --json 路径下没有预加载 history,需按需 load。fail-open 回 null → disabled shape。 */
function lazyHealthStats(): JsonStats {
  try {
    if (!isHealthDigestHistoryEnabled()) return buildHealthStats(null)
    return buildHealthStats(loadHealthDigestHistory())
  } catch {
    return buildHealthStats(null)
  }
}

/**
 * Ph128 — 解析 --history[=N]。
 * 返回 null 表示未开启 history 模式;返回 number 表示请求条数(默认 10)。
 * N 非法时回落到默认值,保持 fail-open(不抛错)。
 */
const HISTORY_DEFAULT = 10
const HISTORY_MAX = 200
function parseHistoryFlag(args: string): number | null {
  if (!args) return null
  const m = args.match(/--history(?:=(\S+))?(?:\s|$)/)
  if (!m) return null
  const raw = m[1]
  if (!raw) return HISTORY_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return HISTORY_DEFAULT
  return Math.min(n, HISTORY_MAX)
}

/** 统计单条 digest 的 adaptive 紧/松/默认 计数,供时间轴压缩展示。 */
function adaptiveTallyOf(d: HealthDigest): { t: number; r: number; def: number } {
  const tally = { t: 0, r: 0, def: 0 }
  try {
    const at = d.adaptiveThresholds
    if (!at || !at.enabled) return tally
    for (const v of Object.values(at.thresholds ?? {})) {
      if (v.value < 3) tally.t += 1
      else if (v.value > 3) tally.r += 1
      else tally.def += 1
    }
  } catch {
    /* fail-open */
  }
  return tally
}

/**
 * Ph131 — 时间桶解析(与 /evolve-audit Ph125 对称)
 * 返回 null 表示未开启 bucket 模式,invalid 用于展示回显错误名。
 */
const KNOWN_BUCKETS = ['hour', 'day'] as const
type BucketFilter = typeof KNOWN_BUCKETS[number]
const BUCKET_CAP: Record<BucketFilter, number> = { hour: 24, day: 14 }

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

/** iso → bucket key: hour=YYYY-MM-DDTHH / day=YYYY-MM-DD */
function bucketKey(iso: string, bucket: BucketFilter): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  if (bucket === 'day') return d.toISOString().slice(0, 10)
  return d.toISOString().slice(0, 13)
}

/**
 * Ph131 — 把 digest 列表按时间桶聚合。
 *
 * 聚合维度(逐桶):
 *   - n:该桶内 digest 条数
 *   - avgAuditTotal / avgAnomalyTotal:反映该时段累积观测的规模趋势
 *   - contractFailEvents:contractHealth.passCount<3 的出现次数
 *   - adaptiveTightenedAvg / adaptiveRelaxedAvg:平均紧/松 kind 数(浮点)
 *
 * 桶按 key 升序排序(时间早 → 晚),超过 BUCKET_CAP 只保留最近的桶(尾部切片)。
 */
interface BucketAgg {
  key: string
  n: number
  avgAuditTotal: number
  avgAnomalyTotal: number
  contractFailEvents: number
  adaptiveTightenedAvg: number
  adaptiveRelaxedAvg: number
}
function aggregateByBucket(
  entries: HealthDigest[],
  bucket: BucketFilter,
): BucketAgg[] {
  const bins = new Map<string, {
    n: number
    auditSum: number
    auditCnt: number
    anomSum: number
    anomCnt: number
    fails: number
    tightSum: number
    relaxSum: number
    tallyCnt: number
  }>()
  for (const d of entries) {
    const key = bucketKey(d.generatedAt, bucket)
    if (!key) continue
    const cur = bins.get(key) ?? {
      n: 0, auditSum: 0, auditCnt: 0, anomSum: 0, anomCnt: 0,
      fails: 0, tightSum: 0, relaxSum: 0, tallyCnt: 0,
    }
    cur.n += 1
    if (d.audit) { cur.auditSum += d.audit.totalAll; cur.auditCnt += 1 }
    if (d.anomaly) { cur.anomSum += d.anomaly.totalAll; cur.anomCnt += 1 }
    if (d.contractHealth && d.contractHealth.passCount < 3) cur.fails += 1
    const tally = adaptiveTallyOf(d)
    cur.tightSum += tally.t
    cur.relaxSum += tally.r
    cur.tallyCnt += 1
    bins.set(key, cur)
  }
  const sorted = [...bins.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const capped = sorted.slice(-BUCKET_CAP[bucket])
  return capped.map(([key, v]) => ({
    key,
    n: v.n,
    avgAuditTotal: v.auditCnt > 0 ? v.auditSum / v.auditCnt : 0,
    avgAnomalyTotal: v.anomCnt > 0 ? v.anomSum / v.anomCnt : 0,
    contractFailEvents: v.fails,
    adaptiveTightenedAvg: v.tallyCnt > 0 ? v.tightSum / v.tallyCnt : 0,
    adaptiveRelaxedAvg: v.tallyCnt > 0 ? v.relaxSum / v.tallyCnt : 0,
  }))
}

/** ISO → 相对时间("5m ago")。与 /evolve-audit 同实现,保持视觉对齐。 */
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

/**
 * Ph133 — 解析 --compare[=N]。
 * 返回 null 表示未开启对比模式;返回 number 表示对比最新 vs (最新的前 N 条)。
 * N 默认 1(对比最新 vs 上一条)。非法回落 1。
 * 注意:与 --history 正交 —— 用户可单独用 --compare 而不需要 --history。
 */
const COMPARE_DEFAULT = 1
const COMPARE_MAX = 1000
function parseCompareFlag(args: string): number | null {
  if (!args) return null
  const m = args.match(/--compare(?:=(\S+))?(?:\s|$)/)
  if (!m) return null
  const raw = m[1]
  if (!raw) return COMPARE_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return COMPARE_DEFAULT
  return Math.min(n, COMPARE_MAX)
}

/**
 * Ph133 — 计算两条 digest 的 delta。
 *
 * 返回 shape:
 *   {
 *     audit:   { totalAll: { from, to, delta }, sample: {...} } | null
 *     anomaly: { totalAll: {...}, sample: {...} } | null
 *     contract:{ fromPass, toPass, flips: ['l2'] } | null  // flips=L1/L2/L3 翻转的通道
 *     adaptive:{ thresholdChanges: [{kind, from, to}], tightenedDelta, relaxedDelta } | null
 *   }
 *
 * 原则:
 *   - 两边都存在才算 delta(一边 null → 整段 null)
 *   - contract.flips 列出状态翻转的层(true→false 或 false→true)
 *   - adaptive thresholdChanges 只列 value 改变的 kind,省略无变化的
 */
interface DigestDelta {
  audit: null | { totalAll: DeltaInt; sample: DeltaInt }
  anomaly: null | { totalAll: DeltaInt; sample: DeltaInt }
  contract: null | { fromPass: number; toPass: number; flips: string[] }
  adaptive: null | {
    thresholdChanges: Array<{ kind: string; from: number | null; to: number | null }>
    tightenedDelta: number
    relaxedDelta: number
  }
}
interface DeltaInt { from: number; to: number; delta: number }

function intDelta(from: number, to: number): DeltaInt {
  return { from, to, delta: to - from }
}

function computeDelta(older: HealthDigest, newer: HealthDigest): DigestDelta {
  // audit
  const audit = (older.audit && newer.audit) ? {
    totalAll: intDelta(older.audit.totalAll, newer.audit.totalAll),
    sample: intDelta(older.audit.sample, newer.audit.sample),
  } : null

  // anomaly
  const anomaly = (older.anomaly && newer.anomaly) ? {
    totalAll: intDelta(older.anomaly.totalAll, newer.anomaly.totalAll),
    sample: intDelta(older.anomaly.sample, newer.anomaly.sample),
  } : null

  // contract:列出翻转层
  const contract = (older.contractHealth && newer.contractHealth) ? (() => {
    const flips: string[] = []
    if (older.contractHealth!.l1 !== newer.contractHealth!.l1) flips.push('l1')
    if (older.contractHealth!.l2 !== newer.contractHealth!.l2) flips.push('l2')
    if (older.contractHealth!.l3 !== newer.contractHealth!.l3) flips.push('l3')
    return {
      fromPass: older.contractHealth!.passCount,
      toPass: newer.contractHealth!.passCount,
      flips,
    }
  })() : null

  // adaptive:列出 threshold value 变化的 kind
  const adaptive = (older.adaptiveThresholds && newer.adaptiveThresholds) ? (() => {
    const oldT = older.adaptiveThresholds!.thresholds ?? {}
    const newT = newer.adaptiveThresholds!.thresholds ?? {}
    const allKinds = new Set([...Object.keys(oldT), ...Object.keys(newT)])
    const thresholdChanges: Array<{ kind: string; from: number | null; to: number | null }> = []
    for (const k of allKinds) {
      const fromV = oldT[k]?.value ?? null
      const toV = newT[k]?.value ?? null
      if (fromV !== toV) thresholdChanges.push({ kind: k, from: fromV, to: toV })
    }
    // tally delta
    const oldTally = adaptiveTallyOf(older)
    const newTally = adaptiveTallyOf(newer)
    return {
      thresholdChanges: thresholdChanges.sort((a, b) => a.kind.localeCompare(b.kind)),
      tightenedDelta: newTally.t - oldTally.t,
      relaxedDelta: newTally.r - oldTally.r,
    }
  })() : null

  return { audit, anomaly, contract, adaptive }
}

/** 把整数 delta 渲染成 "a → b (+/−N)" 格式,供 markdown 使用。 */
function fmtDeltaInt(d: DeltaInt): string {
  const sign = d.delta > 0 ? `+${d.delta}` : d.delta < 0 ? `${d.delta}` : '±0'
  return `${d.from} → ${d.to} (${sign})`
}

export const call: LocalJSXCommandCall = async (onDone, _ctx, args) => {
  const wantJson = parseJsonFlag(args ?? '')
  const historyN = parseHistoryFlag(args ?? '')
  const compareN = parseCompareFlag(args ?? '')
  const digest = loadHealthDigest()
  const path = getHealthDigestPath()
  const enabled = isHealthDigestEnabled()

  // ── Ph133: --compare 模式(与 --history 正交;两者并存时 --compare 优先)──
  //   用户意图:回答"最近这段时间,哪些指标变了"。
  //   实现:从 history ndjson 末尾取 newer + olderIdx=末尾-1-N+1=末尾-N 那条。
  //   边界:history 不足 compareN+1 条 → 友好提示(不抛)。
  if (compareN !== null) {
    const historyEnabled = isHealthDigestHistoryEnabled()
    const historyPath = getHealthDigestHistoryPath()
    const all = loadHealthDigestHistory()
    const needed = compareN + 1

    // JSON 分支:结构化返回,空/不足都给 reason
    if (wantJson) {
      if (!historyEnabled) {
        onDone(JSON.stringify({
          delta: null, older: null, newer: null, compareN, path: historyPath,
          enabled: false,
          stats: buildHealthStats(null),
          reason: 'CLAUDE_EVOLVE_HEALTH_HISTORY=off; history writer disabled',
        }, null, 2))
        return null
      }
      if (all.length < needed) {
        onDone(JSON.stringify({
          delta: null, older: null, newer: null, compareN, path: historyPath,
          enabled: true,
          stats: buildHealthStats(all),
          reason: `history has ${all.length} entries, need at least ${needed} for --compare=${compareN}`,
        }, null, 2))
        return null
      }
      const newer = all[all.length - 1]
      const older = all[all.length - 1 - compareN]
      const delta = computeDelta(older, newer)
      onDone(JSON.stringify({
        delta,
        older: { generatedAt: older.generatedAt },
        newer: { generatedAt: newer.generatedAt },
        compareN,
        path: historyPath,
        enabled: true,
        stats: buildHealthStats(all),
      }, null, 2))
      return null
    }

    // Markdown 分支
    const lines: string[] = [`## autoEvolve Health Digest Compare (Phase 133)\n`]
    lines.push('### Overview')
    lines.push(`path: ${historyPath}`)
    lines.push(`mode: --compare=${compareN}  (newest vs newest-${compareN})`)
    if (!historyEnabled) {
      lines.push('(history writer disabled — CLAUDE_EVOLVE_HEALTH_HISTORY=off)')
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    if (all.length < needed) {
      lines.push(`(insufficient history: ${all.length} entry/entries;need at least ${needed} for this compare — run \`/evolve-tick\` a few more times)`)
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    const newer = all[all.length - 1]
    const older = all[all.length - 1 - compareN]
    const delta = computeDelta(older, newer)
    lines.push(`older: ${older.generatedAt}  (${fmtRelative(older.generatedAt)})`)
    lines.push(`newer: ${newer.generatedAt}  (${fmtRelative(newer.generatedAt)})`)
    lines.push('')

    lines.push('### Delta')
    // audit
    if (delta.audit) {
      lines.push(`  audit.totalAll:  ${fmtDeltaInt(delta.audit.totalAll)}`)
      lines.push(`  audit.sample:    ${fmtDeltaInt(delta.audit.sample)}`)
    } else {
      lines.push('  audit:           (one side missing)')
    }
    // anomaly
    if (delta.anomaly) {
      lines.push(`  anomaly.totalAll:${fmtDeltaInt(delta.anomaly.totalAll)}`)
      lines.push(`  anomaly.sample:  ${fmtDeltaInt(delta.anomaly.sample)}`)
    } else {
      lines.push('  anomaly:         (one side missing)')
    }
    // contract
    if (delta.contract) {
      const c = delta.contract
      const flipStr = c.flips.length > 0 ? `flips: [${c.flips.join(', ')}]` : 'no flips'
      lines.push(`  contract.passCount: ${c.fromPass} → ${c.toPass}  ${flipStr}`)
    } else {
      lines.push('  contract:        (one side missing)')
    }
    // adaptive
    if (delta.adaptive) {
      const a = delta.adaptive
      const sign = (n: number) => n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0'
      lines.push(`  adaptive.tightened: ${sign(a.tightenedDelta)}  adaptive.relaxed: ${sign(a.relaxedDelta)}`)
      if (a.thresholdChanges.length === 0) {
        lines.push('  adaptive.changes: (no per-kind threshold changes)')
      } else {
        lines.push('  adaptive.changes:')
        for (const ch of a.thresholdChanges) {
          const f = ch.from === null ? '(missing)' : String(ch.from)
          const t = ch.to === null ? '(missing)' : String(ch.to)
          lines.push(`    ${ch.kind.padEnd(14)} ${f} → ${t}`)
        }
      }
    } else {
      lines.push('  adaptive:        (one side missing)')
    }
    lines.push('')
    onDone(lines.join('\n'))
    return null
  }

  // ── Ph128: --history 模式,独立分支,不与 snapshot 混合 ──
  if (historyN !== null) {
    const historyEnabled = isHealthDigestHistoryEnabled()
    const historyPath = getHealthDigestHistoryPath()
    // load 全量再手动切尾,便于精确上报 total
    const all = loadHealthDigestHistory()
    const entries = all.slice(-historyN)

    // Ph131 — --bucket=hour|day 聚合(history 模式专属)
    const { bucket, invalid: invalidBucket } = parseBucket(args ?? '')
    const timeBuckets = bucket ? aggregateByBucket(all, bucket) : null

    if (wantJson) {
      onDone(JSON.stringify({
        entries,
        total: all.length,
        limit: historyN,
        path: historyPath,
        enabled: historyEnabled,
        stats: buildHealthStats(historyEnabled ? all : null),
        filters: bucket || invalidBucket
          ? { bucket: bucket ?? null, invalidBucket: invalidBucket ?? null }
          : undefined,
        timeBuckets: timeBuckets ?? undefined,
        reason: !historyEnabled
          ? 'CLAUDE_EVOLVE_HEALTH_HISTORY=off; history writer disabled'
          : all.length === 0
            ? 'no history entries yet — emergence tick has not appended one'
            : undefined,
      }, null, 2))
      return null
    }

    const lines: string[] = ['## autoEvolve Health Digest History (Phase 127/128/131)\n']
    lines.push('### Overview')
    lines.push(`path: ${historyPath}`)
    if (invalidBucket) {
      lines.push(`bucket: (ignored — "${invalidBucket}" is not a known bucket; use one of: ${KNOWN_BUCKETS.join('/')})`)
    }
    if (!historyEnabled) {
      lines.push('(history writer disabled — CLAUDE_EVOLVE_HEALTH_HISTORY=off)')
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    if (all.length === 0) {
      lines.push('(no history entries yet — emergence tick has not appended one; run `/evolve-tick` or wait for periodic scheduler)')
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    lines.push(`total: ${all.length} entries  (showing last ${entries.length}, limit=${historyN})`)
    // Ph140(2026-04-24):markdown 消费 stats.warnings[],与 --json 单源。
    //   health history 的 ⚠️ 只对 --history 模式有意义(regular 只展示最新 digest)。
    const _healthStatsForMd = buildHealthStats(all)
    if (_healthStatsForMd.warnings.length > 0) {
      for (const line of formatWarningsMarkdown(_healthStatsForMd.warnings)) {
        lines.push(line)
      }
    }
    lines.push('')

    // Ph131 — bucket 模式下渲染聚合表,否则保持 Ph128 的时间轴列表
    if (timeBuckets) {
      lines.push(`### Bucket Aggregation (bucket=${bucket}, cap=${BUCKET_CAP[bucket as BucketFilter]})`)
      lines.push(`  bucket${(' ').repeat(bucket === 'hour' ? 11 : 6)}  n   avgAudit   avgAnom   contractFail  adaptiveAvg(T/R)`)
      for (const b of timeBuckets) {
        const keyCell = b.key.padEnd(bucket === 'hour' ? 16 : 11)
        const nCell = String(b.n).padStart(3)
        const auditCell = b.avgAuditTotal.toFixed(1).padStart(9)
        const anomCell = b.avgAnomalyTotal.toFixed(1).padStart(8)
        const failCell = String(b.contractFailEvents).padStart(12)
        const adapCell = `${b.adaptiveTightenedAvg.toFixed(1)}/${b.adaptiveRelaxedAvg.toFixed(1)}`
        lines.push(`  ${keyCell}  ${nCell}  ${auditCell}  ${anomCell}  ${failCell}  ${adapCell}`)
      }
      lines.push('')
      lines.push('legend: avgAudit/avgAnom=每桶 totalAll 均值;contractFail=passCount<3 出现次数;adaptiveAvg=紧/松 kind 数均值')
      onDone(lines.join('\n'))
      return null
    }

    lines.push('### Timeline')
    lines.push('  #   generated (relative)          audit(total/sample)  anomaly(total/sample)  contract   adaptive(T/R/D)')
    entries.forEach((d, i) => {
      const idx = String(i + 1).padStart(3, ' ')
      const rel = fmtRelative(d.generatedAt).padEnd(12, ' ')
      const generatedShort = d.generatedAt.slice(0, 19) + 'Z'
      const a = d.audit
      const auditCell = a
        ? `${String(a.totalAll).padStart(4)}/${String(a.sample).padStart(2)}`.padEnd(14)
        : '   -/-       '.padEnd(14)
      const an = d.anomaly
      const anomalyCell = an
        ? `${String(an.totalAll).padStart(4)}/${String(an.sample).padStart(2)}`.padEnd(14)
        : '   -/-       '.padEnd(14)
      const c = d.contractHealth
      const contractCell = c
        ? `${c.l1 ? '✓' : '✗'}${c.l2 ? '✓' : '✗'}${c.l3 ? '✓' : '✗'}(${c.passCount}/3)`.padEnd(8)
        : '   -    '.padEnd(8)
      const at = adaptiveTallyOf(d)
      const adaptiveCell = `${at.t}/${at.r}/${at.def}`
      lines.push(`  ${idx} ${generatedShort}  ${rel}  ${auditCell}       ${anomalyCell}       ${contractCell}  ${adaptiveCell}`)
    })
    lines.push('')
    lines.push('legend: audit/anomaly=totalAll/sample;contract=L1L2L3(passed/3);adaptive=tightened/relaxed/default')
    onDone(lines.join('\n'))
    return null
  }

  // --json 短路:统一 wrapper shape {digest, path, enabled, stats, reason?}
  //   Ph138:为保持 --json 消费体验统一(audit/anomalies 都走 wrapper),
  //   这里把原本的裸 digest / {digest:null, ...} 两路径合并为一路径;
  //   新增 stats 字段与 Ph137 kernel.historyStats 对齐。
  if (wantJson) {
    if (digest === null) {
      onDone(JSON.stringify({
        digest: null,
        path,
        enabled,
        stats: lazyHealthStats(),
        reason: !enabled
          ? 'CLAUDE_EVOLVE_HEALTH_DIGEST=off; digest writer disabled'
          : 'no digest file yet — emergence tick has not written one',
      }, null, 2))
    } else {
      onDone(JSON.stringify({
        digest,
        path,
        enabled,
        stats: lazyHealthStats(),
      }, null, 2))
    }
    return null
  }

  const lines: string[] = ['## autoEvolve Health Digest (Phase 123/126)\n']

  // ── Section 1: Overview ──────────────────────────────────────
  lines.push('### Overview')
  lines.push(`path: ${path}`)
  if (!enabled) {
    lines.push('(digest writer disabled — CLAUDE_EVOLVE_HEALTH_DIGEST=off)')
    lines.push('')
    onDone(lines.join('\n'))
    return null
  }
  if (digest === null) {
    lines.push('(no digest file yet — emergence tick has not produced one; run `/evolve-tick` or wait for periodic scheduler)')
    lines.push('')
    onDone(lines.join('\n'))
    return null
  }
  lines.push(`generated: ${digest.generatedAt}  (${fmtRelative(digest.generatedAt)})`)
  lines.push('')

  // ── Section 2: Audit Trend ───────────────────────────────────
  try {
    lines.push('### Audit Trend (last 30 decisions)')
    if (digest.audit === null) {
      lines.push('  (unavailable)')
    } else {
      const d = digest.audit.distribution
      lines.push(
        `  📦 totalAll=${digest.audit.totalAll}  sample=${digest.audit.sample}`,
      )
      lines.push(
        `  👁 observe=${d['observe']}  🛑 env-on=${d['env-on']}  🔕 env-off=${d['env-off']}  🤖 auto-gate=${d['auto-gate']}`,
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Audit Trend')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 3: Anomaly Trend ─────────────────────────────────
  try {
    lines.push('### Anomaly Trend (last 30 entries)')
    if (digest.anomaly === null) {
      lines.push('  (unavailable)')
    } else {
      const k = digest.anomaly.distribution
      lines.push(
        `  📦 totalAll=${digest.anomaly.totalAll}  sample=${digest.anomaly.sample}`,
      )
      lines.push(
        `  🔥 SHADOW_PILEUP=${k['SHADOW_PILEUP']}  📦 ARCHIVE_BIAS=${k['ARCHIVE_BIAS']}  ❄️ STAGNATION=${k['STAGNATION']}  ⚠️ HIGH_ATTRITION=${k['HIGH_ATTRITION']}`,
      )
    }
    lines.push('')
  } catch (e) {
    lines.push('### Anomaly Trend')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 4: Adaptive Thresholds ───────────────────────────
  try {
    lines.push('### Adaptive Thresholds (Phase 121)')
    if (digest.adaptiveThresholds === null) {
      lines.push('  (unavailable)')
    } else if (!digest.adaptiveThresholds.enabled) {
      lines.push('  (disabled — CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD=off)')
    } else {
      const t = digest.adaptiveThresholds.thresholds
      const entries = Object.entries(t)
      if (entries.length === 0) {
        lines.push('  (no per-kind thresholds recorded yet — all kinds use DEFAULT=3)')
      } else {
        // 与 /kernel-status Ph129 一致:按 value 升序
        const sorted = entries.sort((a, b) => a[1].value - b[1].value)
        for (const [kind, v] of sorted) {
          const tag = v.value < 3 ? '🔒 tightened' : v.value > 3 ? '🔓 relaxed' : '⏸ default'
          lines.push(
            `  ${kind.padEnd(12)}  threshold=${v.value}  recentPileups24h=${v.recentPileups24h}  ${tag}`,
          )
        }
      }
      if (digest.adaptiveThresholds.updatedAt) {
        lines.push(`  (last updated: ${digest.adaptiveThresholds.updatedAt})`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Adaptive Thresholds')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 5: Contract Health ───────────────────────────────
  try {
    lines.push('### Contract Health (Phase 99)')
    if (digest.contractHealth === null) {
      lines.push('  (unavailable)')
    } else {
      const c = digest.contractHealth
      const mark = (ok: boolean) => (ok ? '✓' : '✗')
      const drift = c.passCount < 3
      lines.push(
        `  L1${mark(c.l1)}  L2${mark(c.l2)}  L3${mark(c.l3)}  (${c.passCount}/3)${drift ? '  ⚠️ drift' : '  ✅ clean'}`,
      )
      if (drift) {
        lines.push('  → 详情:/evolve-status 或 `bun run check:contract`')
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Contract Health')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  onDone(lines.join('\n'))
  return null
}
