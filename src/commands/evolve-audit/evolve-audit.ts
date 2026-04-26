/**
 * Phase 114(2026-04-24)— /evolve-audit 命令实现
 *
 * 读取 Phase 113 写入的 backpressure-audit.ndjson,按以下顺序输出:
 *   1. Header:总条目数、时间范围
 *   2. Decision 分布(observe / env-off / env-on / auto-gate,各自计数 + 百分比)
 *   3. Top auto-gated kinds(按 autoGatedKinds 出现次数聚合排名)
 *   4. Recent timeline(按 ts 降序的最后 N 条,默认 20)
 *
 * 参数解析:
 *   --limit N   调节时间线条数(默认 20,最大 200)
 *
 * 零副作用 —— 不写文件,不触发任何副作用操作。
 * fail-open —— 任一分节渲染失败都继续其它分节,与 /kernel-status 保持一致。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  loadBackpressureAudit,
  type BackpressureAuditEntry,
  type BackpressureDecision,
  MAX_AUDIT_LINES,
} from '../../services/autoEvolve/arena/backpressureAudit.js'
import { getBackpressureAuditPath } from '../../services/autoEvolve/paths.js'
import { computeStatsWarnings, formatWarningsMarkdown } from '../../services/autoEvolve/arena/statsWarnings.js'

/** 解析 `--limit N` 字面量;任何异常回落默认 20。 */
function parseLimit(args: string): number {
  const DEFAULT = 20
  const MAX = 200
  if (!args) return DEFAULT
  // 支持两种写法:--limit=50 和 --limit 50
  const eq = /--limit[=\s]+(\d+)/.exec(args)
  if (!eq) return DEFAULT
  const n = Number.parseInt(eq[1], 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT
  return Math.min(n, MAX)
}

/**
 * Ph118(2026-04-24)—— 解析 `--since=30m` / `--since 2h` / `--since=1d` 等时间窗。
 * 支持单位:s(秒)/ m(分)/ h(时)/ d(天)。
 * 返回毫秒数;缺省或非法返回 null,调用方据此决定是否过滤。
 * 故意用比 parseLimit 更严格的正则(要求单位):防止用户误写 `--since=30` 被吞成
 * 30ms 这种毫无意义的值。
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

/** 把毫秒窗口回显成可读标签,与用户输入对称。 */
function fmtSince(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * Ph119(2026-04-24)—— `--kind=skill` / `--kind command` kind 维度过滤。
 * 只接受白名单 kind(与 organism 家族一致),防止无意义输入。
 * 返回 null 表示未指定(不过滤);unknown kind 也回 null 并在 Overview 提示。
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

/**
 * Ph122(2026-04-24)—— `--json` 结构化输出开关。
 * 纯 flag:出现即触发 JSON 路径,与 markdown 路径互斥。
 * 设计:JSON 必须永远合法,任何计算异常都用 `null` 占位,不抛错。
 *   理由:这是为脚本/监控管道设计的,解析方 `JSON.parse()` 绝不能挂。
 */
function parseJsonFlag(args: string): boolean {
  if (!args) return false
  return /--json(\b|=|\s|$)/.test(args)
}

/**
 * Ph120(2026-04-24)—— `--decision=auto-gate` 细粒度过滤。
 * 白名单:observe / env-on / env-off / auto-gate。
 * 容忍 underscore 写法(auto_gate → auto-gate),便于 shell 不逃逸。
 * 大小写不敏感;非白名单值在 Overview 显式提示并回退到不过滤。
 */
const KNOWN_DECISIONS = ['observe', 'env-on', 'env-off', 'auto-gate'] as const
type DecisionFilter = typeof KNOWN_DECISIONS[number]
function parseDecision(args: string): { decision: DecisionFilter | null; invalid: string | null } {
  if (!args) return { decision: null, invalid: null }
  const m = /--decision[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return { decision: null, invalid: null }
  const v = m[1].toLowerCase().replace(/_/g, '-')
  if ((KNOWN_DECISIONS as readonly string[]).includes(v)) {
    return { decision: v as DecisionFilter, invalid: null }
  }
  return { decision: null, invalid: m[1] }
}

/**
 * Ph125(2026-04-24)—— `--bucket=hour` / `--bucket day` 时间桶聚合。
 * 只接受 hour / day 两档(week/month 意义有限,audit 通常只关心最近几天)。
 * 返回 null = 未指定,不做桶聚合;invalid 表示白名单外的值。
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

/** 把 ISO 时间戳归入指定 bucket 的 key(hour=YYYY-MM-DDTHH / day=YYYY-MM-DD)。 */
function bucketKey(iso: string, bucket: BucketFilter): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  if (bucket === 'day') return d.toISOString().slice(0, 10)
  return d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
}

/** 把 ISO 时间转成"N 秒/分/时/天前"的相对展示。 */
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

/** decision → 图标,与 /kernel-status 保持一致,让两个面板视觉对齐。 */
function decisionIcon(d: BackpressureDecision): string {
  switch (d) {
    case 'observe':
      return '👁'
    case 'env-off':
      return '🔕'
    case 'env-on':
      return '🛑'
    case 'auto-gate':
      return '🤖'
  }
}

/** reasons 缩写:与 /kernel-status Ph110 保持一致。 */
function abbrReason(r: string): string {
  if (r === 'SHADOW_PILEUP') return 'P'
  if (r === 'ARCHIVE_BIAS') return 'B'
  return '?'
}

/**
 * Ph135(2026-04-24)—— `--compare` / `--compare=N` 窗口对比开关。
 * 和 Ph133 /evolve-health --compare 语义对齐:比较最新 N 条 vs 再前 N 条。
 * 默认 N=20(audit 条目密度远高于 health digest,窗口可更大);上限 1000。
 * 返回 null 表示未指定;异常值(=0/负数/非数)回落默认 20。
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

/** Ph135:单个 decision/kind 计数的前后对比 triple。 */
type AuditDeltaInt = { from: number; to: number; delta: number }

type AuditDelta = {
  compareN: number
  older: { first: string | null; last: string | null; n: number }
  newer: { first: string | null; last: string | null; n: number }
  decisions: Record<BackpressureDecision, AuditDeltaInt>
  autoGatedKinds: Array<{ kind: string; from: number; to: number; delta: number }>
}

/**
 * Ph135:计算两个审计窗口的 decision 分布 + autoGatedKinds 差值。
 * 输入假设:older 时间早于 newer,且两侧都已按 ts 升序,长度各自为 compareN。
 * autoGatedKinds:合并两侧 kind 键,只保留 delta !== 0 的行,按 |delta| 降序,
 *   top 10。这样用户快速看到"新近被锁升/解锁"的 kind,而不是每次都看全量。
 */
function computeAuditDelta(
  newer: BackpressureAuditEntry[],
  older: BackpressureAuditEntry[],
  compareN: number,
): AuditDelta {
  const DEC: BackpressureDecision[] = ['observe', 'env-off', 'env-on', 'auto-gate']
  const tallyA: Record<BackpressureDecision, number> = { observe: 0, 'env-off': 0, 'env-on': 0, 'auto-gate': 0 }
  const tallyB: Record<BackpressureDecision, number> = { observe: 0, 'env-off': 0, 'env-on': 0, 'auto-gate': 0 }
  for (const e of older) if (e.decision in tallyA) tallyA[e.decision]++
  for (const e of newer) if (e.decision in tallyB) tallyB[e.decision]++
  const decisions = {} as Record<BackpressureDecision, AuditDeltaInt>
  for (const d of DEC) decisions[d] = { from: tallyA[d], to: tallyB[d], delta: tallyB[d] - tallyA[d] }
  const kindsA: Record<string, number> = {}
  const kindsB: Record<string, number> = {}
  for (const e of older) for (const k of e.autoGatedKinds ?? []) kindsA[k] = (kindsA[k] ?? 0) + 1
  for (const e of newer) for (const k of e.autoGatedKinds ?? []) kindsB[k] = (kindsB[k] ?? 0) + 1
  const all = new Set<string>([...Object.keys(kindsA), ...Object.keys(kindsB)])
  const autoGatedKinds = Array.from(all)
    .map(k => {
      const from = kindsA[k] ?? 0
      const to = kindsB[k] ?? 0
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
    decisions,
    autoGatedKinds,
  }
}

/** Ph135:把带符号的 delta 格式化为 "+N" / "-N" / "±0"。 */
function fmtDeltaSign(n: number): string {
  if (n > 0) return `+${n}`
  if (n < 0) return String(n)
  return '±0'
}

/**
 * Ph138(2026-04-24)—— JSON payload 内嵌 stats 字段。
 * 消费方不必并发跑 /kernel-status --json 拿容量/新鲜度;与 Ph137 kernel
 * auditStats 字段完全对齐。stats 反映"磁盘全量",不随 filter 变化。
 * capPct = total / maxLines * 100,一位小数便于后续阈值告警脚本对齐。
 *
 * Ph139(2026-04-24)—— 新增 warnings 数组,把 ph137 markdown 的 ⚠️ 阈值
 * 规则搬到结构化字段。消费方直接看 `stats.warnings.length > 0` 判断告警。
 * audit 规则:capPct≥80 → CAP_HIGH;sinceNewest>1h → STALE_NEWEST
 * (audit 是 live-write 每 tick 一行,1h 空窗 = observer 卡住)。
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

/** Ph139:audit + health 共用的告警阈值(Ph137 markdown 硬编码对齐)。 */
const CAP_HIGH_PCT = 80
const STALE_AUDIT_MS = 3_600_000

function buildAuditStats(rawEntries: BackpressureAuditEntry[]): JsonStats {
  const total = rawEntries.length
  const maxLines = MAX_AUDIT_LINES
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
  // Ph140(2026-04-24):warnings 由 arena/statsWarnings 的 computeStatsWarnings 统一计算,
  //   把 Ph139 的阈值常量收敛到单源;staleHint='backpressure observer' 指出 audit 新鲜度
  //   卡 1h 意味着 kernel observer 停工。capPct 传现成的一位小数值。
  const warnings = computeStatsWarnings({
    total, maxLines, sinceNewestMs, staleHint: 'backpressure observer', capPct,
  })
  return {
    total, maxLines, capPct,
    oldestAt: oldest.ts, newestAt: newest.ts,
    ageSpanMs, sinceNewestMs,
    warnings,
  }
}

export const call: LocalJSXCommandCall = async (onDone, _ctx, args) => {
  const lines: string[] = ['## autoEvolve Backpressure Audit (Phase 113/114)\n']
  const limit = parseLimit(args ?? '')
  const sinceMs = parseSinceMs(args ?? '')
  const { kind: kindFilter, invalid: invalidKind } = parseKind(args ?? '')
  const { decision: decisionFilter, invalid: invalidDecision } = parseDecision(args ?? '')
  const { bucket: bucketFilter, invalid: invalidBucket } = parseBucket(args ?? '')

  // 所有分节共享同一份 entries;若 load 失败则下游 sections 自然降级
  let entries: BackpressureAuditEntry[] = []
  try {
    entries = loadBackpressureAudit()
  } catch {
    // fail-open:loader 本身已吞异常,此处仅作防御
  }
  // Ph138(2026-04-24):rawEntries 捕获过滤前全量,供 stats 使用。
  //   stats 反映磁盘全量,不随 --since/--kind/--decision 变化;消费方可据此
  //   做"磁盘容量告警"这种跨查询元信息。filter 后的 entries 仍走原路径。
  const rawEntries: BackpressureAuditEntry[] = entries.slice()

  // Ph118:时间窗过滤 —— 先于任何聚合,让 decision distribution / top /
  //   timeline 都只反映窗口内事件;过滤掉时间戳非法(Date.parse=NaN)的条目,
  //   避免污染统计。不修改原文件,只改本次渲染所用视图。
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

  // Ph119:kind 维度过滤 —— 只保留 pileupKinds 或 autoGatedKinds 命中指定 kind
  //   的条目。与 --since 正交:两者都应用后得到交集视图。
  //   语义说明:即使是 env-off 的 observe 条目,只要它报告了 skill pileup
  //   也会被保留 —— 让 "skill 在什么情况下被观测到问题" 可查。
  let kindFilteredOut = 0
  if (kindFilter !== null) {
    const before = entries.length
    entries = entries.filter(e => {
      const inPileup = (e.pileupKinds ?? []).includes(kindFilter)
      const inAutoGated = (e.autoGatedKinds ?? []).includes(kindFilter)
      return inPileup || inAutoGated
    })
    kindFilteredOut = before - entries.length
  }

  // Ph120:decision 维度过滤 —— 与 kind 过滤并列的第四维度。交集语义:
  //   decision=auto-gate && kind=skill → 只看 skill 触发的 auto-gate 决策。
  let decisionFilteredOut = 0
  if (decisionFilter !== null) {
    const before = entries.length
    entries = entries.filter(e => e.decision === decisionFilter)
    decisionFilteredOut = before - entries.length
  }

  // Ph125(2026-04-24):时间桶聚合 —— 在所有过滤已应用之后计算。
  //   桶为 Map<key, {total, byDecision}>,key = hour / day 字符串;
  //   按 key 升序,取最近 MAX 桶(hour=24, day=14),避免面板过长。
  //   空窗口(过滤后 entries 为 0 或未指定 --bucket)会得到空 buckets,
  //   markdown 段与 JSON 字段都据此显示"(no buckets)"或空数组。
  const MAX_HOUR_BUCKETS = 24
  const MAX_DAY_BUCKETS = 14
  type AuditBucket = {
    key: string
    total: number
    byDecision: Record<BackpressureDecision, number>
  }
  let timeBuckets: AuditBucket[] = []
  if (bucketFilter !== null) {
    const map = new Map<string, AuditBucket>()
    for (const e of entries) {
      const k = bucketKey(e.ts, bucketFilter)
      if (k === null) continue
      let b = map.get(k)
      if (!b) {
        b = {
          key: k,
          total: 0,
          byDecision: { observe: 0, 'env-off': 0, 'env-on': 0, 'auto-gate': 0 },
        }
        map.set(k, b)
      }
      b.total++
      if (e.decision in b.byDecision) b.byDecision[e.decision]++
    }
    const sorted = Array.from(map.values()).sort((a, b) => (a.key < b.key ? -1 : 1))
    const max = bucketFilter === 'hour' ? MAX_HOUR_BUCKETS : MAX_DAY_BUCKETS
    timeBuckets = sorted.slice(-max)
  }

  // Ph135(2026-04-24):--compare[=N] 短路 —— 在所有过滤/桶聚合已应用之后,
  //   优先于 JSON 短路判断。这样 `--compare --json` / `--json --compare` 都
  //   落到 compare 分支,输出结构化 delta,而非常规 JSON payload。
  //   语义:entries 按 ts 升序加载 → newer = 末尾 N 条,older = 再前 N 条。
  //   不足 2N 时给友好提示(markdown 或 JSON 各自对应),不抛。
  const compareN = parseCompareFlag(args ?? '')
  if (compareN !== null) {
    const wantJson = parseJsonFlag(args ?? '')
    const needed = compareN * 2
    if (entries.length < needed) {
      if (wantJson) {
        const payload = {
          phase: '135',
          path: getBackpressureAuditPath(),
          delta: null,
          compareN,
          total: entries.length,
          stats: buildAuditStats(rawEntries),
          reason: `insufficient history: ${entries.length} entries, need at least ${needed}`,
        }
        onDone(JSON.stringify(payload, null, 2))
        return null
      }
      lines.push('### Delta (Phase 135)')
      lines.push(`(insufficient history: ${entries.length} entries, need at least ${needed} for --compare=${compareN})`)
      lines.push('')
      onDone(lines.join('\n'))
      return null
    }
    const newer = entries.slice(-compareN)
    const older = entries.slice(-(compareN * 2), -compareN)
    const delta = computeAuditDelta(newer, older, compareN)
    if (wantJson) {
      const payload = {
        phase: '135',
        path: getBackpressureAuditPath(),
        delta,
        compareN,
        total: entries.length,
        stats: buildAuditStats(rawEntries),
      }
      onDone(JSON.stringify(payload, null, 2))
      return null
    }
    // markdown 渲染:窗口时间范围 + decision 差值表 + autoGatedKinds top 变动
    lines.push(`### Delta (newer N=${compareN} vs previous N=${compareN}, Phase 135)`)
    if (delta.older.first && delta.older.last) {
      lines.push(`older window: ${fmtRelative(delta.older.first)} → ${fmtRelative(delta.older.last)} (n=${delta.older.n})`)
    }
    if (delta.newer.first && delta.newer.last) {
      lines.push(`newer window: ${fmtRelative(delta.newer.first)} → ${fmtRelative(delta.newer.last)} (n=${delta.newer.n})`)
    }
    lines.push('')
    lines.push('**decisions**')
    for (const d of ['auto-gate', 'env-on', 'env-off', 'observe'] as BackpressureDecision[]) {
      const di = delta.decisions[d]
      lines.push(`  ${decisionIcon(d)} ${d.padEnd(10)} ${di.from} → ${di.to} (${fmtDeltaSign(di.delta)})`)
    }
    lines.push('')
    lines.push('**autoGatedKinds top changes**')
    if (delta.autoGatedKinds.length === 0) {
      lines.push('  (no kind tally changed between windows)')
    } else {
      for (const c of delta.autoGatedKinds) {
        lines.push(`  ${c.kind.padEnd(12)} ${c.from} → ${c.to} (${fmtDeltaSign(c.delta)})`)
      }
    }
    lines.push('')
    onDone(lines.join('\n'))
    return null
  }

  // Ph122(2026-04-24):--json 短路 —— 在所有过滤已应用之后,跳过 markdown
  //   section 渲染,直接输出结构化 JSON。与 markdown 路径共享同一份 entries,
  //   所以 --since / --kind 过滤语义完全一致,脚本消费方不会得到与人类用户
  //   不同的视图。
  //   JSON 必须永远合法 —— 每个字段都 try-catch 降级为 null,而非中断。
  if (parseJsonFlag(args ?? '')) {
    const safe = <T,>(fn: () => T, fallback: T): T => {
      try { return fn() } catch { return fallback }
    }
    const decisionDistribution = safe(() => {
      const d: Record<BackpressureDecision, number> = { observe: 0, 'env-off': 0, 'env-on': 0, 'auto-gate': 0 }
      for (const e of entries) if (e.decision in d) d[e.decision]++
      return d
    }, { observe: 0, 'env-off': 0, 'env-on': 0, 'auto-gate': 0 })
    const topAutoGatedKinds = safe(() => {
      const tally: Record<string, number> = {}
      for (const e of entries) for (const k of e.autoGatedKinds ?? []) tally[k] = (tally[k] ?? 0) + 1
      return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 10)
    }, [] as Array<[string, number]>)
    const payload = {
      phase: '113/114',
      path: getBackpressureAuditPath(),
      stats: buildAuditStats(rawEntries),
      filters: {
        limit,
        sinceMs,
        kind: kindFilter,
        invalidKind,
        decision: decisionFilter,
        invalidDecision,
        bucket: bucketFilter,
        invalidBucket,
      },
      filteredOut: {
        bySince: filteredOut,
        byKind: kindFilteredOut,
        byDecision: decisionFilteredOut,
      },
      total: entries.length,
      timeRange: entries.length > 0
        ? { first: entries[0].ts, last: entries[entries.length - 1].ts }
        : null,
      decisionDistribution,
      topAutoGatedKinds,
      timeBuckets,
      recent: safe(() => entries.slice(-limit), [] as BackpressureAuditEntry[]),
    }
    onDone(JSON.stringify(payload, null, 2))
    return null
  }

  // ── Section 1: Header ────────────────────────────────────────
  try {
    lines.push('### Overview')
    lines.push(`path: ${getBackpressureAuditPath()}`)
    if (sinceMs !== null) {
      // Ph118:即便窗口为空也要让用户看到"窗口确实被应用了",避免把"0 条"
      // 误判成"系统没记录",另外显示被过滤掉的老条目数以便核对边界。
      lines.push(
        `time window: last ${fmtSince(sinceMs)}  (filtered out ${filteredOut} older entr${filteredOut === 1 ? 'y' : 'ies'})`,
      )
    }
    if (invalidKind !== null) {
      // Ph119:白名单外的 kind 值给出明确提示,让用户知道自己打错了,而不是
      // 悄悄按"未指定"处理 —— 否则会误以为"我过滤了但它返回全量"。
      lines.push(
        `kind filter: (ignored — "${invalidKind}" is not a known kind; use one of: ${KNOWN_KINDS.join('/')})`,
      )
    } else if (kindFilter !== null) {
      lines.push(
        `kind filter: ${kindFilter}  (filtered out ${kindFilteredOut} unrelated entr${kindFilteredOut === 1 ? 'y' : 'ies'})`,
      )
    }
    if (invalidDecision !== null) {
      // Ph120:同 kind 的错误处理 —— 显式告诉用户"我忽略了你的过滤"。
      lines.push(
        `decision filter: (ignored — "${invalidDecision}" is not a known decision; use one of: ${KNOWN_DECISIONS.join('/')})`,
      )
    } else if (decisionFilter !== null) {
      lines.push(
        `decision filter: ${decisionFilter}  (filtered out ${decisionFilteredOut} unrelated entr${decisionFilteredOut === 1 ? 'y' : 'ies'})`,
      )
    }
    if (invalidBucket !== null) {
      // Ph125:时间桶非法值提示 —— 与 kind/decision 错误处理对称,保证用户能
      //   看到"我忽略了你的 --bucket,所以下面没有 Time Buckets 段"。
      lines.push(
        `bucket: (ignored — "${invalidBucket}" is not a known bucket; use one of: ${KNOWN_BUCKETS.join('/')})`,
      )
    } else if (bucketFilter !== null) {
      lines.push(`bucket: ${bucketFilter}`)
    }
    if (entries.length === 0) {
      lines.push(
        decisionFilter !== null
          ? `(no audit entries match decision=${decisionFilter}${kindFilter !== null ? ` kind=${kindFilter}` : ''}${sinceMs !== null ? ` within last ${fmtSince(sinceMs)}` : ''})`
          : kindFilter !== null
            ? `(no audit entries match kind=${kindFilter}${sinceMs !== null ? ` within last ${fmtSince(sinceMs)}` : ''})`
            : sinceMs !== null
              ? `(no audit entries within last ${fmtSince(sinceMs)})`
              : '(no audit entries yet — backpressure has not been detected in any tick)',
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
    //   统计基于 rawEntries(磁盘全量),不随 filter 变化;空 warnings 时整段不显示。
    const _auditStatsForMd = buildAuditStats(rawEntries)
    if (_auditStatsForMd.warnings.length > 0) {
      for (const line of formatWarningsMarkdown(_auditStatsForMd.warnings)) {
        lines.push(line)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push(`### Overview`)
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 2: Decision 分布 ─────────────────────────────────
  try {
    lines.push('### Decision Distribution')
    const counts: Record<BackpressureDecision, number> = {
      observe: 0,
      'env-off': 0,
      'env-on': 0,
      'auto-gate': 0,
    }
    for (const e of entries) {
      if (e.decision in counts) counts[e.decision]++
    }
    const total = entries.length
    const order: BackpressureDecision[] = ['auto-gate', 'env-on', 'env-off', 'observe']
    for (const d of order) {
      const c = counts[d]
      const pct = total > 0 ? ((c / total) * 100).toFixed(1) : '0.0'
      lines.push(`  ${decisionIcon(d)} ${d.padEnd(10)}  ${String(c).padStart(5)}  (${pct.padStart(5)}%)`)
    }
    lines.push('')
  } catch (e) {
    lines.push('### Decision Distribution')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 2.5: Time Buckets(Ph125)─────────────────────────
  //   只有 --bucket 指定时才渲染本节。每行一个 bucket,四档决策计数紧随。
  //   位置:Decision Distribution 之后、Top Auto-Gated Kinds 之前,让
  //   "何时发生 / 谁拦的 / 哪些 kind" 三维阅读顺序自然。
  if (bucketFilter !== null) {
    try {
      lines.push(`### Time Buckets (by ${bucketFilter})`)
      if (timeBuckets.length === 0) {
        lines.push('  (no buckets)')
      } else {
        for (const b of timeBuckets) {
          const bd = b.byDecision
          lines.push(
            `  ${b.key.padEnd(13)}  total=${String(b.total).padStart(4)}   👁${bd['observe']}  🛑${bd['env-on']}  🔕${bd['env-off']}  🤖${bd['auto-gate']}`,
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

  // ── Section 3: Top auto-gated kinds ──────────────────────────
  try {
    lines.push('### Top Auto-Gated Kinds')
    const tally: Record<string, number> = {}
    for (const e of entries) {
      for (const k of e.autoGatedKinds ?? []) {
        tally[k] = (tally[k] ?? 0) + 1
      }
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1])
    if (ranked.length === 0) {
      lines.push('  (no kind has ever been auto-gated)')
    } else {
      for (const [k, c] of ranked.slice(0, 10)) {
        lines.push(`  ${k.padEnd(12)}  ${String(c).padStart(5)} tick(s)`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Top Auto-Gated Kinds')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // ── Section 4: Recent timeline ───────────────────────────────
  try {
    lines.push(`### Recent Timeline (last ${limit})`)
    const recent = entries.slice(-limit)
    for (const e of recent) {
      // 行格式:
      //   👁 observe    skill[P]×3  tick=522  12m ago  dropped=0
      const rel = fmtRelative(e.ts)
      const streaks = e.streaksSummary ?? {}
      const autoGated = new Set(e.autoGatedKinds ?? [])
      const reasons = e.reasonsByKind ?? {}
      const kindList = (e.pileupKinds ?? [])
        .map(k => {
          const rs = reasons[k] ?? []
          const tag = rs.length ? `[${rs.map(abbrReason).join('')}]` : ''
          const count = streaks[k] ?? 0
          const stag = count >= 2 ? `×${count}` : ''
          const lock = autoGated.has(k) ? '🔒' : ''
          return `${k}${tag}${stag}${lock}`
        })
        .join(',') || '(none)'
      lines.push(
        `  ${decisionIcon(e.decision)} ${e.decision.padEnd(10)}  {${kindList}}  tick=${e.tickCount}  ${rel}  dropped=${e.droppedCount}`,
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
