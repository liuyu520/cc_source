/**
 * Phase 144(2026-04-24)— /evolve-triage 命令
 *
 * 目的:把 Ph141 实时聚合 + Ph142 历史落盘 + Ph143 stats 整合为一个可人工分诊
 * (triage)的独立面板。用户场景:
 *   - "最近系统有没有积累任何告警?"
 *   - "哪种 CODE / 哪个 ledger 最顽固(跨很多 tick)?"
 *   - "最近 20 次 tick 的告警时间线长什么样?"
 *   - 一键 --json 喂监控或 LLM 做 RCA。
 *
 * 结构:
 *   1. Live Warnings(Ph141 算法,三 ledger 实时);
 *   2. Historical Distribution(Ph143 byLedger/byCode 跨全 history 累计);
 *   3. Most Persistent Codes(Ph144 新增 —— 按 byCode 降序 top N);
 *   4. Recent Timeline(Ph144 新增 —— 最近 N 条 observer-history 事件倒序)。
 *
 * 参数:
 *   - --limit N(默认 20,最大 200)
 *   - --json(整合结构化输出)
 *   - Ph145:--since=30m|2h|1d(historical/recent 时间窗,不影响 live)
 *   - Ph145:--ledger=audit|anomaly|history(三域统一过滤:live+hist+recent)
 *   - Ph145:--code=CAP_HIGH|STALE_NEWEST(同上)
 *
 * 零副作用 —— 只读 load;fail-open —— 任一 ledger 异常不影响其余 section。
 */
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  computeStatsWarnings,
  type StatsWarning,
} from '../../services/autoEvolve/arena/statsWarnings.js'

type LedgerName = 'audit' | 'anomaly' | 'history'
const LEDGERS: readonly LedgerName[] = ['audit', 'anomaly', 'history'] as const

interface WarningRow {
  ledger: LedgerName
  code: string
  message: string
}

/**
 * Ph145 过滤上下文。live 不应用 sinceMs(live 本就是 now,窗口无意义);
 * hist/recent 三者都应用。ledger/code 非空时做白名单/精确匹配。
 *
 * Ph149(2026-04-24):扩展 ledger 白名单:新增 'action-items' 作为第 4 个视图,
 *   与 Ph148 落盘的 action-items-history 对齐。语义:
 *     - ledger='audit'|'anomaly'|'history' → 只显示该 observer ledger,action-items 视图空
 *     - ledger='action-items' → 只显示 action-items 分布,observer 三 ledger 视图空
 *     - ledger=null → 全部渲染(与 Ph145 行为兼容)
 */
type TriageLedger = LedgerName | 'action-items'

interface TriageFilters {
  sinceMs: number | null
  ledger: TriageLedger | null
  code: string | null
  // 用户原始输入里是否出现了非法字段,用于展示提示
  invalidLedger: string | null
  invalidSince: string | null
}

/** Ph144:参数解析(--limit N / --json) */
function parseLimit(args: string): number {
  const DEFAULT = 20
  const MAX = 200
  if (!args) return DEFAULT
  const m = /--limit[=\s]+(\d+)/.exec(args)
  if (!m) return DEFAULT
  const n = Number.parseInt(m[1]!, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT
  return Math.min(n, MAX)
}
function parseJson(args: string): boolean {
  return /--json\b/.test(args)
}

/**
 * Ph145:--since=30m / --since 2h / --since=1d → ms。
 * 故意强制单位,避免 `--since=30` 被当 30ms 的陷阱。
 * 返回 null 表示未指定;第二值是"看起来想写但写错了"的原串(用于提示)。
 */
function parseSinceMs(args: string): { ms: number | null; invalid: string | null } {
  if (!args) return { ms: null, invalid: null }
  const m = /--since[=\s]+([A-Za-z0-9.+-]+)/i.exec(args)
  if (!m) return { ms: null, invalid: null }
  const raw = m[1]!
  const valid = /^(\d+)([smhd])$/i.exec(raw)
  if (!valid) return { ms: null, invalid: raw }
  const n = Number.parseInt(valid[1]!, 10)
  if (!Number.isFinite(n) || n <= 0) return { ms: null, invalid: raw }
  const unit = valid[2]!.toLowerCase()
  const mult =
    unit === 's' ? 1000
      : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
          : 86_400_000
  return { ms: n * mult, invalid: null }
}

/** Ph145:--ledger=audit|anomaly|history;Ph149:新增 action-items;未指定 → null;非白名单 → invalid。 */
function parseLedger(args: string): { ledger: TriageLedger | null; invalid: string | null } {
  if (!args) return { ledger: null, invalid: null }
  const m = /--ledger[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return { ledger: null, invalid: null }
  const v = m[1]!.toLowerCase()
  if (v === 'audit' || v === 'anomaly' || v === 'history' || v === 'action-items') {
    return { ledger: v, invalid: null }
  }
  return { ledger: null, invalid: m[1]! }
}

/**
 * Ph145:--code=CAP_HIGH 等。为了向前兼容(未来会加新 CODE),这里不走白名单,
 * 只做精确字面量匹配(大小写敏感),允许字母/数字/下划线/破折号。
 */
function parseCode(args: string): string | null {
  if (!args) return null
  const m = /--code[=\s]+([A-Za-z][A-Za-z0-9_-]*)/.exec(args)
  if (!m) return null
  return m[1]!
}

function parseFilters(args: string): TriageFilters {
  const { ms, invalid: invalidSince } = parseSinceMs(args)
  const { ledger, invalid: invalidLedger } = parseLedger(args)
  const code = parseCode(args)
  return { sinceMs: ms, ledger, code, invalidLedger, invalidSince }
}

/** Ph145:WarningRow 是否匹配 ledger+code 过滤(两者 null 都放行)。 */
function matchWarning(row: WarningRow, f: TriageFilters): boolean {
  if (f.ledger && row.ledger !== f.ledger) return false
  if (f.code && row.code !== f.code) return false
  return true
}

/** 毫秒→人类可读。 */
function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a'
  const abs = Math.abs(ms)
  if (abs < 1000) return `${Math.round(ms)}ms`
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (abs < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

/**
 * 实时收集三 ledger 当前 warnings —— 与 Ph141 kernel-status 算法一致,
 * 但这里作为独立 triage 面板重新收集,免得依赖 kernel-status 的 payload 格式。
 * 每 ledger 独立 try/catch,fail-open。
 *
 * Ph145:接受 filters:
 *   - ledger 非空:跳过不匹配的 ledger 整节(省掉不必要的 load IO)
 *   - code 非空:match 时过滤
 *   - sinceMs:live 忽略(live 即 now,时间窗无意义)
 */
async function collectLiveWarnings(filters: TriageFilters = EMPTY_FILTERS): Promise<WarningRow[]> {
  const out: WarningRow[] = []
  // audit
  if (!filters.ledger || filters.ledger === 'audit') {
    try {
      const { loadBackpressureAudit, MAX_AUDIT_LINES } = await import(
        '../../services/autoEvolve/arena/backpressureAudit.js'
      )
      const all = loadBackpressureAudit()
      if (all.length > 0) {
        const newest = all[all.length - 1]!
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        const ws = computeStatsWarnings({
          total: all.length, maxLines: MAX_AUDIT_LINES,
          sinceNewestMs: sinceNewest, staleHint: 'backpressure observer',
        })
        for (const w of ws) {
          const row: WarningRow = { ledger: 'audit', code: w.code, message: w.message }
          if (matchWarning(row, filters)) out.push(row)
        }
      }
    } catch { /* fail-open */ }
  }
  // anomaly
  if (!filters.ledger || filters.ledger === 'anomaly') {
    try {
      const { loadAnomalyHistory, MAX_ANOMALY_LINES } = await import(
        '../../services/autoEvolve/arena/anomalyHistory.js'
      )
      const all = loadAnomalyHistory()
      if (all.length > 0) {
        const newest = all[all.length - 1]!
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        const ws = computeStatsWarnings({
          total: all.length, maxLines: MAX_ANOMALY_LINES,
          sinceNewestMs: sinceNewest, staleHint: null, // 空窗=健康
        })
        for (const w of ws) {
          const row: WarningRow = { ledger: 'anomaly', code: w.code, message: w.message }
          if (matchWarning(row, filters)) out.push(row)
        }
      }
    } catch { /* fail-open */ }
  }
  // history
  if (!filters.ledger || filters.ledger === 'history') {
    try {
      const { loadHealthDigestHistory, isHealthDigestHistoryEnabled, MAX_HISTORY_LINES } = await import(
        '../../services/autoEvolve/arena/healthDigest.js'
      )
      if (isHealthDigestHistoryEnabled()) {
        const all = loadHealthDigestHistory()
        if (all.length > 0) {
          const newest = all[all.length - 1]!
          const newestMs = Date.parse(newest.generatedAt)
          const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          const ws = computeStatsWarnings({
            total: all.length, maxLines: MAX_HISTORY_LINES,
            sinceNewestMs: sinceNewest, staleHint: 'emergence tick',
          })
          for (const w of ws) {
            const row: WarningRow = { ledger: 'history', code: w.code, message: w.message }
            if (matchWarning(row, filters)) out.push(row)
          }
        }
      }
    } catch { /* fail-open */ }
  }
  return out
}

const EMPTY_FILTERS: TriageFilters = {
  sinceMs: null, ledger: null, code: null, invalidLedger: null, invalidSince: null,
}

interface HistoricalDistribution {
  totalTicks: number
  totalWarnings: number
  oldestAt: string | null
  newestAt: string | null
  sinceNewestMs: number | null
  byLedger: Record<LedgerName, number>
  byCode: Record<string, number>
  /** Ph144:按 code 降序 top N(messages 去重后前 3 条作示例) */
  topCodes: Array<{ code: string; count: number; sampleMessages: string[] }>
  /** 最近 N 条(默认 20)entries(时间倒序) */
  recent: Array<{ ts: string; tickCount: number; total: number; items: WarningRow[] }>
  /** Ph145:raw 条目数(磁盘上真实总数,便于与过滤后对照) */
  rawTicks: number
  /** Ph145:--since 窗口过滤掉的条目数(ts 不在窗口内) */
  filteredOutBySince: number
}

async function buildHistoricalDistribution(
  limit: number,
  filters: TriageFilters = EMPTY_FILTERS,
): Promise<HistoricalDistribution> {
  const empty: HistoricalDistribution = {
    totalTicks: 0, totalWarnings: 0,
    oldestAt: null, newestAt: null, sinceNewestMs: null,
    byLedger: { audit: 0, anomaly: 0, history: 0 },
    byCode: {},
    topCodes: [],
    recent: [],
    rawTicks: 0,
    filteredOutBySince: 0,
  }
  // Ph149:--ledger=action-items 与 observer 三 ledger 互斥,短路直接空
  if (filters.ledger === 'action-items') return empty
  try {
    const { loadObserverWarningsHistory } = await import(
      '../../services/autoEvolve/arena/observerWarningsHistory.js'
    )
    const all = loadObserverWarningsHistory()
    if (all.length === 0) return empty

    // Ph145:阶段 1 —— 按 sinceMs 过滤 entries。
    //   不修改磁盘文件,仅本次渲染视图;ts 解析失败的条目不计入。
    const cutoff = filters.sinceMs !== null ? Date.now() - filters.sinceMs : null
    let filteredOutBySince = 0
    const byTime = cutoff === null
      ? all
      : all.filter(e => {
        const ts = Date.parse(e.ts)
        if (!Number.isFinite(ts)) { filteredOutBySince++; return false }
        if (ts < cutoff) { filteredOutBySince++; return false }
        return true
      })

    if (byTime.length === 0) {
      return {
        ...empty,
        rawTicks: all.length,
        filteredOutBySince,
      }
    }

    // Ph145:阶段 2 —— 对每个 entry 过滤 items(ledger/code),然后丢弃完全没
    //   匹配 item 的 entry。这样 byLedger/byCode/topCodes/recent 都只反映
    //   过滤后视图。
    type FilteredEntry = {
      ts: string
      tickCount: number
      total: number
      items: WarningRow[]
    }
    const filtered: FilteredEntry[] = []
    for (const entry of byTime) {
      const rawItems = Array.isArray(entry.items) ? entry.items : []
      const validItems: WarningRow[] = rawItems.filter(
        (it): it is WarningRow =>
          it && typeof it === 'object'
          && (it.ledger === 'audit' || it.ledger === 'anomaly' || it.ledger === 'history')
          && typeof it.code === 'string'
          && typeof it.message === 'string',
      )
      const matchedItems = validItems.filter(it => matchWarning(it, filters))
      if (matchedItems.length === 0) continue
      filtered.push({
        ts: entry.ts,
        tickCount: entry.tickCount,
        total: matchedItems.length, // Ph145:重算 total(反映过滤后视图)
        items: matchedItems,
      })
    }

    if (filtered.length === 0) {
      return {
        ...empty,
        rawTicks: all.length,
        filteredOutBySince,
      }
    }

    const oldest = filtered[0]!
    const newest = filtered[filtered.length - 1]!
    const newestMs = Date.parse(newest.ts)
    const byLedger: Record<LedgerName, number> = { audit: 0, anomaly: 0, history: 0 }
    const byCode: Record<string, number> = {}
    const codeSamples: Record<string, Set<string>> = {}
    let totalWarnings = 0
    for (const entry of filtered) {
      for (const it of entry.items) {
        byLedger[it.ledger] += 1
        byCode[it.code] = (byCode[it.code] ?? 0) + 1
        const set = codeSamples[it.code] ?? (codeSamples[it.code] = new Set())
        if (set.size < 3) set.add(it.message)
        totalWarnings += 1
      }
    }
    const topCodes = Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({
        code, count,
        sampleMessages: Array.from(codeSamples[code] ?? []).slice(0, 3),
      }))
    const recent = filtered.slice(-limit).reverse().map(e => ({
      ts: e.ts, tickCount: e.tickCount, total: e.total, items: e.items,
    }))
    return {
      totalTicks: filtered.length,
      totalWarnings,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
      byLedger,
      byCode,
      topCodes,
      recent,
      rawTicks: all.length,
      filteredOutBySince,
    }
  } catch {
    return empty
  }
}

/**
 * Ph149(2026-04-24):Action Items 历史分布(Ph148 落盘消费端)。
 * 与 HistoricalDistribution 并列,但有自己的 byPriority / bySource 维度。
 * 过滤:
 *   - ledger='audit'|'anomaly'|'history' → 互斥,短路空
 *   - ledger='action-items' 或 null → 加载并聚合
 *   - sinceMs:entry.ts 过滤
 *   - code:item.code 精确匹配
 */
interface ActionItemRow {
  priority: 'high' | 'medium' | 'low'
  source: string
  code: string
  message: string
  suggested: string | null
}

interface ActionItemsDistribution {
  totalTicks: number
  totalItems: number
  oldestAt: string | null
  newestAt: string | null
  sinceNewestMs: number | null
  byPriority: { high: number; medium: number; low: number }
  bySource: Record<string, number>
  topCodes: Array<{ code: string; count: number; sampleMessages: string[]; persistent: boolean; streakTicks: number; daysSpan: number }>
  // Ph150:只装 isPersistent=true 的 code,供渲染端快速展示 🔥 清单。
  persistentCodes: Array<{
    code: string
    streakTicks: number
    daysSpan: number
    totalOccurrences: number
    firstSeenTs: string
    lastSeenTs: string
    samplePriority: 'high' | 'medium' | 'low'
    sampleSource: string
    sampleMessage: string
    sampleSuggested: string | null
  }>
  persistenceThresholds: { streakMin: number; daysMin: number }
  // Ph151:解决追踪(MTTR)—— 仅装 topCodes 所覆盖 code 的指标,控 payload。
  //   currentlyOpen + resolutionCount + avg/median/max/min MTTR(ms)。
  // Ph152:叠加 recentAvgMttrMs / historicalAvgMttrMs / mttrTrend(📈/📉/◻/unknown)。
  resolutionByCode: Record<string, {
    resolutionCount: number
    avgMttrMs: number | null
    medianMttrMs: number | null
    maxMttrMs: number | null
    minMttrMs: number | null
    currentlyOpen: boolean
    currentOpenDurationMs: number | null
    totalLifetimeOccurrences: number
    recentAvgMttrMs: number | null
    historicalAvgMttrMs: number | null
    mttrTrend: 'degrading' | 'improving' | 'stable' | 'unknown'
  }>
  // Ph152:趋势阈值摘要,便于 JSON 消费方理解 degrading/improving 的 cut-off
  mttrTrendThresholds: { recentCount: number; degradeRatio: number; improveRatio: number }
  // Ph154:基于 Ph150 持久化 + Ph151 开放窗 + Ph152 趋势三信号合成的 warnings。
  //   三种规则:STUCK_DEGRADING(high) / OPEN_TOO_LONG(medium) / REGRESSION(medium)。
  //   同 code 可同时命中多条。空数组 = 无告警。
  mttrWarnings: Array<{
    code: string
    kind: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
    severity: 'high' | 'medium' | 'low'
    message: string
    streakTicks?: number
    daysSpan?: number
    currentOpenDurationMs?: number
    resolutionCount?: number
    avgMttrMs?: number | null
    recentAvgMttrMs?: number | null
    historicalAvgMttrMs?: number | null
  }>
  // Ph154:暴露 mttrWarnings 阈值(openTooLongMs),便于 JSON 消费方理解告警门槛
  mttrWarningThresholds: { openTooLongMs: number }
  // Ph157:warnings 增量(emerged/resolved since last tick)。
  //   entries<2 → 两组皆空。仅为 JSON 提供,markdown 按需渲染一行。
  mttrWarningsDelta: {
    emerged: Array<{
      code: string
      kind: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
      severity: 'high' | 'medium' | 'low'
    }>
    resolved: Array<{
      code: string
      kind: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
      severity: 'high' | 'medium' | 'low'
    }>
  }
  // Ph158:warning lifecycles —— 每个 (code,kind) 的长期活跃统计。
  //   isChronicOffender = totalEmergences >= threshold(默认 3)。
  warningLifecycles: Array<{
    code: string
    kind: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
    severity: 'high' | 'medium' | 'low'
    firstEmergedAt: string
    lastActiveAt: string
    totalEmergences: number
    totalActiveTicks: number
    currentlyActive: boolean
    isChronicOffender: boolean
  }>
  warningLifecycleThresholds: { chronicThreshold: number; maxWindow: number }
  recent: Array<{ ts: string; tickCount: number; total: number; items: ActionItemRow[] }>
  rawTicks: number
  filteredOutBySince: number
  enabled: boolean
}

const EMPTY_ACTION_ITEMS_DISTRIBUTION: ActionItemsDistribution = {
  totalTicks: 0, totalItems: 0,
  oldestAt: null, newestAt: null, sinceNewestMs: null,
  byPriority: { high: 0, medium: 0, low: 0 },
  bySource: {},
  topCodes: [],
  persistentCodes: [],
  // Ph150:默认阈值占位,避免渲染端访问 undefined
  persistenceThresholds: { streakMin: 10, daysMin: 3 },
  // Ph151:resolutionByCode 默认空 Record
  resolutionByCode: {},
  // Ph152:趋势阈值默认(env 未覆盖时)
  mttrTrendThresholds: { recentCount: 3, degradeRatio: 1.5, improveRatio: 0.67 },
  // Ph154:默认空 warnings + 默认阈值 24h
  mttrWarnings: [],
  mttrWarningThresholds: { openTooLongMs: 24 * 60 * 60_000 },
  // Ph157:默认空 delta
  mttrWarningsDelta: { emerged: [], resolved: [] },
  // Ph158:默认空 lifecycles + 默认阈值
  warningLifecycles: [],
  warningLifecycleThresholds: { chronicThreshold: 3, maxWindow: 200 },
  recent: [],
  rawTicks: 0,
  filteredOutBySince: 0,
  enabled: true,
}

function matchActionItem(row: ActionItemRow, f: TriageFilters): boolean {
  // ledger 是否允许看 action-items:null 或 'action-items' 放行;其它值拒绝
  if (f.ledger && f.ledger !== 'action-items') return false
  if (f.code && row.code !== f.code) return false
  return true
}

async function buildActionItemsDistribution(
  limit: number,
  filters: TriageFilters = EMPTY_FILTERS,
): Promise<ActionItemsDistribution> {
  // Ph149:observer 三 ledger 过滤下直接空
  if (filters.ledger && filters.ledger !== 'action-items') {
    return EMPTY_ACTION_ITEMS_DISTRIBUTION
  }
  try {
    const {
      loadActionItemsHistory,
      isActionItemsHistoryEnabled,
      computePersistenceMetrics,
      getPersistenceThresholds,
      computeResolutionMetrics,
      getMttrTrendThresholds,
      computeMttrWarnings,
      getMttrWarningThresholds,
      computeWarningDelta,
      computeWarningLifecycles,
      getWarningLifecycleThresholds,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    const enabled = isActionItemsHistoryEnabled()
    const all = loadActionItemsHistory()
    const thresholds = getPersistenceThresholds()
    if (all.length === 0) {
      return { ...EMPTY_ACTION_ITEMS_DISTRIBUTION, enabled, persistenceThresholds: thresholds }
    }

    // 阶段 1:按 sinceMs 过滤 entries(时间窗)
    const cutoff = filters.sinceMs !== null ? Date.now() - filters.sinceMs : null
    let filteredOutBySince = 0
    const byTime = cutoff === null
      ? all
      : all.filter(e => {
        const ts = Date.parse(e.ts)
        if (!Number.isFinite(ts)) { filteredOutBySince++; return false }
        if (ts < cutoff) { filteredOutBySince++; return false }
        return true
      })

    if (byTime.length === 0) {
      return {
        ...EMPTY_ACTION_ITEMS_DISTRIBUTION,
        enabled,
        rawTicks: all.length,
        filteredOutBySince,
        persistenceThresholds: thresholds,
      }
    }

    // 阶段 2:entry 内 item 级过滤(code)+ 丢弃空 entry
    type FilteredEntry = {
      ts: string
      tickCount: number
      total: number
      items: ActionItemRow[]
    }
    const filtered: FilteredEntry[] = []
    for (const entry of byTime) {
      const rawItems = Array.isArray(entry.items) ? entry.items : []
      const validItems: ActionItemRow[] = rawItems.filter(
        (it): it is ActionItemRow =>
          it && typeof it === 'object'
          && (it.priority === 'high' || it.priority === 'medium' || it.priority === 'low')
          && typeof it.source === 'string'
          && typeof it.code === 'string'
          && typeof it.message === 'string',
      )
      const matchedItems = validItems.filter(it => matchActionItem(it, filters))
      if (matchedItems.length === 0) continue
      filtered.push({
        ts: entry.ts,
        tickCount: entry.tickCount,
        total: matchedItems.length,
        items: matchedItems,
      })
    }

    if (filtered.length === 0) {
      return {
        ...EMPTY_ACTION_ITEMS_DISTRIBUTION,
        enabled,
        rawTicks: all.length,
        filteredOutBySince,
        persistenceThresholds: thresholds,
      }
    }

    const oldest = filtered[0]!
    const newest = filtered[filtered.length - 1]!
    const newestMs = Date.parse(newest.ts)
    const byPriority: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 }
    const bySource: Record<string, number> = {}
    const byCode: Record<string, number> = {}
    const codeSamples: Record<string, Set<string>> = {}
    let totalItems = 0
    for (const entry of filtered) {
      for (const it of entry.items) {
        byPriority[it.priority] += 1
        bySource[it.source] = (bySource[it.source] ?? 0) + 1
        byCode[it.code] = (byCode[it.code] ?? 0) + 1
        const set = codeSamples[it.code] ?? (codeSamples[it.code] = new Set())
        if (set.size < 3) set.add(it.message)
        totalItems += 1
      }
    }
    const baseTopCodes = Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, count]) => ({
        code, count,
        sampleMessages: Array.from(codeSamples[code] ?? []).slice(0, 3),
      }))
    // Ph150:持久化检测 —— 基于 filtered entry 序列计算,尊重 --since / --code 过滤后的窗口
    const persistMetrics = computePersistenceMetrics(
      filtered.map(e => ({ ts: e.ts, items: e.items })),
    )
    const metricByCode = new Map(persistMetrics.map(m => [m.code, m]))
    const topCodes = baseTopCodes.map(tc => {
      const m = metricByCode.get(tc.code)
      return {
        ...tc,
        persistent: m?.isPersistent ?? false,
        streakTicks: m?.streakTicks ?? 0,
        daysSpan: m?.daysSpan ?? 0,
      }
    })
    const persistentCodes = persistMetrics
      .filter(m => m.isPersistent)
      .map(m => ({
        code: m.code,
        streakTicks: m.streakTicks,
        daysSpan: m.daysSpan,
        totalOccurrences: m.totalOccurrences,
        firstSeenTs: m.firstSeenTs,
        lastSeenTs: m.lastSeenTs,
        samplePriority: m.samplePriority,
        sampleSource: m.sampleSource,
        sampleMessage: m.sampleMessage,
        sampleSuggested: m.sampleSuggested,
      }))
    // Ph151:resolution / MTTR —— 只为 top 10 code 计算(控 JSON payload 体积)
    // Ph152:同时取出每 code 的 recentAvg/historicalAvg/mttrTrend
    const resolutionAll = computeResolutionMetrics(
      filtered.map(e => ({ ts: e.ts, items: e.items })),
    )
    const topCodeSet = new Set(topCodes.map(t => t.code))
    const resolutionByCode: ActionItemsDistribution['resolutionByCode'] = {}
    for (const r of resolutionAll) {
      if (!topCodeSet.has(r.code)) continue
      resolutionByCode[r.code] = {
        resolutionCount: r.resolutionCount,
        avgMttrMs: r.avgMttrMs,
        medianMttrMs: r.medianMttrMs,
        maxMttrMs: r.maxMttrMs,
        minMttrMs: r.minMttrMs,
        currentlyOpen: r.currentlyOpen,
        currentOpenDurationMs: r.currentOpenDurationMs,
        totalLifetimeOccurrences: r.totalLifetimeOccurrences,
        // Ph152 —— trend 字段透传
        recentAvgMttrMs: r.recentAvgMttrMs,
        historicalAvgMttrMs: r.historicalAvgMttrMs,
        mttrTrend: r.mttrTrend,
      }
    }
    const mttrTrendThresholds = getMttrTrendThresholds()
    // Ph154:MTTR warnings —— 把 Ph150/151/152 的状态信号接入决策管道。
    //   规则产出在 actionItemsHistory.computeMttrWarnings 中,消费端无需二次聚合。
    //   计算用 filtered(受 --since/--code 过滤)同一份 entries,保持 filter 语义一致。
    const mttrWarnings = computeMttrWarnings(
      filtered.map(e => ({ ts: e.ts, items: e.items })),
    )
    const mttrWarningThresholds = getMttrWarningThresholds()
    // Ph157:warnings 增量(emerged/resolved since last tick),与过滤后 entries 同步。
    const mttrWarningsDelta = computeWarningDelta(
      filtered.map(e => ({ ts: e.ts, items: e.items })),
    )
    // Ph158:warning lifecycles,识别 chronic offenders(反复出现的警告)
    const warningLifecycles = computeWarningLifecycles(
      filtered.map(e => ({ ts: e.ts, items: e.items })),
    )
    const warningLifecycleThresholds = getWarningLifecycleThresholds()
    const recent = filtered.slice(-limit).reverse().map(e => ({
      ts: e.ts, tickCount: e.tickCount, total: e.total, items: e.items,
    }))
    return {
      totalTicks: filtered.length,
      totalItems,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
      byPriority,
      bySource,
      topCodes,
      persistentCodes,
      persistenceThresholds: thresholds,
      resolutionByCode,
      mttrTrendThresholds,
      mttrWarnings,
      mttrWarningThresholds,
      mttrWarningsDelta,
      warningLifecycles,
      warningLifecycleThresholds,
      recent,
      rawTicks: all.length,
      filteredOutBySince,
      enabled,
    }
  } catch {
    return EMPTY_ACTION_ITEMS_DISTRIBUTION
  }
}

/**
 * Ph145:把 filters 压缩成人类可读/JSON 友好的小对象。
 * 便于 render 两路复用 + 测试直接断言。
 */
function describeFilters(filters: TriageFilters): {
  hasActive: boolean
  parts: string[]
  warnings: string[]
  applied: { since: string | null; sinceMs: number | null; ledger: TriageLedger | null; code: string | null }
} {
  const parts: string[] = []
  const warnings: string[] = []
  if (filters.sinceMs !== null) {
    parts.push(`since=${fmtMs(filters.sinceMs)}`)
  }
  if (filters.invalidSince) {
    warnings.push(`⚠️ --since='${filters.invalidSince}' 解析失败(需 30m/2h/1d),忽略`)
  }
  if (filters.ledger) {
    parts.push(`ledger=${filters.ledger}`)
  }
  if (filters.invalidLedger) {
    warnings.push(`⚠️ --ledger='${filters.invalidLedger}' 非白名单(audit|anomaly|history|action-items),忽略`)
  }
  if (filters.code) {
    parts.push(`code=${filters.code}`)
  }
  return {
    hasActive: parts.length > 0,
    parts,
    warnings,
    applied: {
      since: filters.sinceMs !== null ? fmtMs(filters.sinceMs) : null,
      sinceMs: filters.sinceMs,
      ledger: filters.ledger,
      code: filters.code,
    },
  }
}

function renderMarkdown(
  live: WarningRow[],
  hist: HistoricalDistribution,
  limit: number,
  filters: TriageFilters = EMPTY_FILTERS,
  aiDist: ActionItemsDistribution = EMPTY_ACTION_ITEMS_DISTRIBUTION,
): string {
  const lines: string[] = ['## autoEvolve Triage Report (Phase 144/145/149/150/151/152/154/157/158)\n']

  // Ph145:Filters header(仅当有任一 filter 生效 or 非法)
  const desc = describeFilters(filters)
  if (desc.hasActive) {
    lines.push(`### Filters: ${desc.parts.join(', ')}`)
    if (hist.filteredOutBySince > 0) {
      lines.push(`  (filteredOutBySince=${hist.filteredOutBySince} of raw ${hist.rawTicks} ticks)`)
    }
    lines.push('')
  }
  for (const w of desc.warnings) {
    lines.push(`  ${w}`)
  }
  if (desc.warnings.length > 0) lines.push('')

  // 1. Live Warnings
  lines.push('### 1. Live Warnings')
  if (live.length === 0) {
    // Ph145:有 filter 时文案细化 —— 避免把"被过滤掉"误认为"系统健康"。
    if (filters.ledger || filters.code) {
      lines.push('  (no matching live warnings under current filters)')
    } else {
      lines.push('  (no active warnings —— 三 ledger 全部健康)')
    }
  } else {
    const byLedger: Record<LedgerName, number> = { audit: 0, anomaly: 0, history: 0 }
    for (const w of live) {
      lines.push(`  [${w.ledger}] ${w.code}: ${w.message}`)
      byLedger[w.ledger] += 1
    }
    const parts = (['audit', 'anomaly', 'history'] as const)
      .filter(k => byLedger[k] > 0)
      .map(k => `${k}=${byLedger[k]}`)
    lines.push(`  (total: ${live.length} across ${parts.length} ledger(s);  ${parts.join(', ')})`)
  }
  lines.push('')

  // 2. Historical Distribution
  lines.push('### 2. Historical Distribution (Phase 142)')
  if (hist.totalTicks === 0) {
    if (desc.hasActive) {
      lines.push('  (no matching history entries under current filters)')
    } else {
      lines.push('  (no observer-history entries yet;空窗=健康)')
    }
  } else {
    lines.push(
      `  totalTicks=${hist.totalTicks}  totalWarnings=${hist.totalWarnings}  newest=${fmtMs(hist.sinceNewestMs)} ago`,
    )
    const ledgerParts = (['audit', 'anomaly', 'history'] as const).map(
      k => `${k}=${hist.byLedger[k]}`,
    )
    lines.push(`  byLedger: ${ledgerParts.join(', ')}`)
    const codeKeys = Object.keys(hist.byCode).sort()
    if (codeKeys.length > 0) {
      const codeParts = codeKeys.map(k => `${k}=${hist.byCode[k]}`)
      lines.push(`  byCode: ${codeParts.join(', ')}`)
    }
  }
  lines.push('')

  // 3. Most Persistent Codes
  lines.push('### 3. Most Persistent Codes (top 10)')
  if (hist.topCodes.length === 0) {
    lines.push('  (no codes recorded yet)')
  } else {
    for (const t of hist.topCodes) {
      const sample = t.sampleMessages.length > 0
        ? `  e.g. ${t.sampleMessages[0]}`
        : ''
      lines.push(`  ${t.code.padEnd(14)} count=${t.count}${sample}`)
    }
  }
  lines.push('')

  // 4. Recent Timeline
  lines.push(`### 4. Recent Timeline (last ${limit})`)
  if (hist.recent.length === 0) {
    lines.push('  (no recent entries)')
  } else {
    for (const r of hist.recent) {
      const ago = fmtMs(Date.now() - Date.parse(r.ts))
      lines.push(`  ${r.ts}  (${ago} ago)  tick=${r.tickCount}  total=${r.total}`)
      for (const it of r.items) {
        lines.push(`    [${it.ledger}] ${it.code}: ${it.message}`)
      }
    }
  }
  lines.push('')

  // Ph149:Action Items 历史分布 —— 与 observer ledger 并列的第 4 个视图。
  //   当 --ledger=audit|anomaly|history 时,aiDist 为 EMPTY(互斥)→ 显示"被过滤"。
  //   空 distribution + enabled=false → 提示 env=off(Ph148 的 CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY)。
  //   空 distribution + enabled=true → 提示尚未写入(空窗=健康)。
  lines.push('### 5. Action Items Distribution (Phase 148/149)')
  if (filters.ledger && filters.ledger !== 'action-items') {
    lines.push(`  (filtered out — current --ledger=${filters.ledger} 与 action-items 互斥)`)
  } else if (aiDist.totalTicks === 0) {
    if (!aiDist.enabled) {
      lines.push('  (disabled — CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY=off)')
    } else if (desc.hasActive) {
      lines.push('  (no matching action-items history under current filters)')
    } else {
      lines.push('  (no action-items history entries yet;空窗=健康)')
    }
  } else {
    lines.push(
      `  totalTicks=${aiDist.totalTicks}  totalItems=${aiDist.totalItems}  newest=${fmtMs(aiDist.sinceNewestMs)} ago`,
    )
    const prioParts = (['high', 'medium', 'low'] as const).map(
      k => `${k}=${aiDist.byPriority[k]}`,
    )
    lines.push(`  byPriority: ${prioParts.join(', ')}`)
    const srcKeys = Object.keys(aiDist.bySource).sort()
    if (srcKeys.length > 0) {
      const srcParts = srcKeys.map(k => `${k}=${aiDist.bySource[k]}`)
      lines.push(`  bySource: ${srcParts.join(', ')}`)
    }
  }
  lines.push('')

  // 6. Action Items — Most Persistent Codes
  //   Ph150:topCodes 行内加 🔥 badge(isPersistent),追加 streak/days 信息。
  //   Ph151:再追 mttr / resolved 次数(有 resolution 数据时);🔥 子节追 open=X。
  //   并列出独立的 persistentCodes 子节(若有),给出 suggested 跳转。
  lines.push('### 6. Action Items — Most Persistent Codes (top 10, Ph150 🔥 / Ph151 MTTR / Ph152 trend)')
  if (filters.ledger && filters.ledger !== 'action-items') {
    lines.push('  (filtered out)')
  } else if (aiDist.topCodes.length === 0) {
    lines.push('  (no action-items codes recorded yet)')
  } else {
    const th = aiDist.persistenceThresholds
    lines.push(`  thresholds: streak≥${th.streakMin} OR daysSpan≥${th.daysMin}`)
    for (const t of aiDist.topCodes) {
      const fire = t.persistent ? ' 🔥' : ''
      const persistInfo = t.persistent
        ? `  streak=${t.streakTicks} days=${t.daysSpan}`
        : ''
      // Ph151:MTTR / resolved —— 仅当有已闭窗口或开放时标注
      // Ph152:trend —— 📈 degrading / 📉 improving / ◻ stable(unknown 不渲染,避免噪声)
      const r = aiDist.resolutionByCode[t.code]
      let mttrInfo = ''
      let trendBadge = ''
      if (r) {
        const bits: string[] = []
        if (r.resolutionCount > 0 && r.avgMttrMs !== null) {
          bits.push(`resolved=${r.resolutionCount} avgMttr=${fmtMs(r.avgMttrMs)}`)
        }
        if (r.currentlyOpen && r.currentOpenDurationMs !== null) {
          bits.push(`open=${fmtMs(r.currentOpenDurationMs)}`)
        }
        if (bits.length > 0) mttrInfo = `  ${bits.join(' ')}`
        // Ph152:trend —— 只有 degrading/improving/stable 时渲染 badge
        if (r.mttrTrend === 'degrading') trendBadge = ' 📈'
        else if (r.mttrTrend === 'improving') trendBadge = ' 📉'
        else if (r.mttrTrend === 'stable') trendBadge = ' ◻'
      }
      const sample = t.sampleMessages.length > 0
        ? `  e.g. ${t.sampleMessages[0]}`
        : ''
      lines.push(`  ${t.code.padEnd(22)} count=${t.count}${fire}${trendBadge}${persistInfo}${mttrInfo}${sample}`)
    }
    // 独立汇总 —— 只有顽固项时才渲染,避免干扰
    if (aiDist.persistentCodes.length > 0) {
      lines.push('')
      lines.push(`  🔥 persistent codes (${aiDist.persistentCodes.length}):`)
      for (const p of aiDist.persistentCodes) {
        const suggestedStr = p.sampleSuggested ? `  → ${p.sampleSuggested}` : ''
        // Ph151:若该 code 在 resolutionByCode 且 currentlyOpen,追加 open=X
        const r = aiDist.resolutionByCode[p.code]
        const openInfo = r && r.currentlyOpen && r.currentOpenDurationMs !== null
          ? `  open=${fmtMs(r.currentOpenDurationMs)}`
          : ''
        lines.push(
          `    ${p.code} streak=${p.streakTicks} days=${p.daysSpan} [${p.samplePriority}/${p.sampleSource}]${openInfo}${suggestedStr}`,
        )
      }
    }
  }
  lines.push('')

  // 7. Action Items — Recent Timeline
  lines.push(`### 7. Action Items — Recent Timeline (last ${limit})`)
  if (filters.ledger && filters.ledger !== 'action-items') {
    lines.push('  (filtered out)')
  } else if (aiDist.recent.length === 0) {
    lines.push('  (no recent action-items entries)')
  } else {
    const badge = (p: 'high' | 'medium' | 'low') =>
      p === 'high' ? '🔴' : p === 'medium' ? '🟡' : '🟢'
    for (const r of aiDist.recent) {
      const ago = fmtMs(Date.now() - Date.parse(r.ts))
      lines.push(`  ${r.ts}  (${ago} ago)  tick=${r.tickCount}  total=${r.total}`)
      for (const it of r.items) {
        const suggestedStr = it.suggested ? `  → ${it.suggested}` : ''
        lines.push(`    ${badge(it.priority)} [${it.source}] ${it.code}: ${it.message}${suggestedStr}`)
      }
    }
  }
  lines.push('')

  // 8. MTTR Warnings(Ph154,2026-04-24)—— 把 Ph150/151/152 状态信号合成决策信号
  //    - 空数组 → "(no mttr warnings)",让消费端能分辨"健康"与"没启用"
  //    - filtered out by --ledger!=action-items → 空数组(buildActionItemsDistribution 早返回)
  //    - 三种 kind:STUCK_DEGRADING(high)/OPEN_TOO_LONG(medium)/REGRESSION(medium)
  //    - Ph157:末尾追加一行 delta(since last tick: emerged=N, resolved=N)
  //             仅在 emerged+resolved>0 时渲染,降噪
  lines.push('### 8. MTTR Warnings (Phase 154/157)')
  if (aiDist.mttrWarnings.length === 0) {
    lines.push('  (no mttr warnings)')
  } else {
    const sevBadge = (s: 'high' | 'medium' | 'low') => s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🟢'
    const byKind: Record<string, number> = {}
    for (const w of aiDist.mttrWarnings) {
      byKind[w.kind] = (byKind[w.kind] ?? 0) + 1
      lines.push(`  ${sevBadge(w.severity)} [${w.kind}] ${w.code}: ${w.message}`)
    }
    const parts = Object.entries(byKind).map(([k, n]) => `${k}=${n}`)
    lines.push(`  (total: ${aiDist.mttrWarnings.length};  ${parts.join(', ')})`)
  }
  // Ph157 delta 行 —— 即使 warnings 为空,若有 resolved 也渲染(让用户看到"刚修好了"的回路)
  const delta = aiDist.mttrWarningsDelta
  if (delta.emerged.length + delta.resolved.length > 0) {
    lines.push(`  (since last tick: emerged=${delta.emerged.length} 🆕, resolved=${delta.resolved.length} ✅)`)
  }
  lines.push('')

  // 9. Warning Lifecycle(Ph158,2026-04-24)—— 把 Ph154 warnings 从瞬时快照升级为时序剖面
  //    - 遍历 actionItemsHistory 前缀,跟踪每个 (code, kind) 的 emergence 事件 + active 延续
  //    - chronic offender:totalEmergences ≥ chronicThreshold(默认 3,env 可覆盖)
  //    - 仅渲染 chronic(降噪);currently active 标注出来方便优先处置
  lines.push('### 9. Warning Lifecycle (Phase 158)')
  const chronic = aiDist.warningLifecycles.filter(lc => lc.isChronicOffender)
  if (chronic.length === 0) {
    lines.push('  (no chronic offenders)')
  } else {
    const sevBadge = (s: 'high' | 'medium' | 'low') => s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🟢'
    for (const lc of chronic.slice(0, 10)) {
      const activeStr = lc.currentlyActive ? ' (currently active)' : ''
      lines.push(
        `  ${sevBadge(lc.severity)} [${lc.kind}] ${lc.code}: emergences=${lc.totalEmergences} activeTicks=${lc.totalActiveTicks}${activeStr}`,
      )
    }
    const activeNow = chronic.filter(lc => lc.currentlyActive).length
    lines.push(`  (total chronic: ${chronic.length}; currently active: ${activeNow})`)
  }
  lines.push('')

  return lines.join('\n')
}

function renderJson(
  live: WarningRow[],
  hist: HistoricalDistribution,
  limit: number,
  filters: TriageFilters = EMPTY_FILTERS,
  aiDist: ActionItemsDistribution = EMPTY_ACTION_ITEMS_DISTRIBUTION,
): string {
  // 与 markdown 同源;不做 dedent / 格式化,方便下游 parse。
  const byLedgerLive: Record<LedgerName, number> = { audit: 0, anomaly: 0, history: 0 }
  for (const w of live) byLedgerLive[w.ledger] += 1
  const desc = describeFilters(filters)
  const payload = {
    generatedAt: new Date().toISOString(),
    // Ph158:phase→158(smoke 向后兼容 144/145/149/150/151/152/154/157/158 任一)
    phase: 158,
    // Ph145:applied filters + 丢弃统计(rawTicks vs totalTicks)
    filters: {
      applied: desc.applied,
      warnings: desc.warnings,
      rawTicks: hist.rawTicks,
      filteredOutBySince: hist.filteredOutBySince,
    },
    live: {
      total: live.length,
      byLedger: byLedgerLive,
      items: live,
    },
    historical: {
      totalTicks: hist.totalTicks,
      totalWarnings: hist.totalWarnings,
      oldestAt: hist.oldestAt,
      newestAt: hist.newestAt,
      sinceNewestMs: hist.sinceNewestMs,
      byLedger: hist.byLedger,
      byCode: hist.byCode,
      topCodes: hist.topCodes,
    },
    recent: {
      limit,
      entries: hist.recent,
    },
    // Ph149:action-items 历史分布 —— observer ledger 并列第 4 视图
    actionItemsDistribution: {
      enabled: aiDist.enabled,
      totalTicks: aiDist.totalTicks,
      totalItems: aiDist.totalItems,
      oldestAt: aiDist.oldestAt,
      newestAt: aiDist.newestAt,
      sinceNewestMs: aiDist.sinceNewestMs,
      byPriority: aiDist.byPriority,
      bySource: aiDist.bySource,
      topCodes: aiDist.topCodes,
      // Ph150:持久化清单 + 阈值(让 JSON 下游不用自己重算)
      persistentCodes: aiDist.persistentCodes,
      persistenceThresholds: aiDist.persistenceThresholds,
      // Ph151:resolution / MTTR 指标(仅 top 10 code)
      resolutionByCode: aiDist.resolutionByCode,
      // Ph152:MTTR 趋势阈值(让 JSON 下游能理解 degrading/improving 的 cut-off)
      mttrTrendThresholds: aiDist.mttrTrendThresholds,
      // Ph154:MTTR warnings 与阈值一并暴露,方便消费端根据 severity/kind 驱动决策
      mttrWarnings: aiDist.mttrWarnings,
      mttrWarningThresholds: aiDist.mttrWarningThresholds,
      // Ph157:warnings 增量(emerged/resolved since last tick)
      mttrWarningsDelta: aiDist.mttrWarningsDelta,
      // Ph158:warning 生命周期 + chronic offender 判定阈值
      warningLifecycles: aiDist.warningLifecycles,
      warningLifecycleThresholds: aiDist.warningLifecycleThresholds,
      rawTicks: aiDist.rawTicks,
      filteredOutBySince: aiDist.filteredOutBySince,
      recent: aiDist.recent,
    },
  }
  return JSON.stringify(payload, null, 2)
}

export const call: LocalJSXCommandCall = async (onDone, _ctx, args) => {
  const argStr = args ?? ''
  const limit = parseLimit(argStr)
  const asJson = parseJson(argStr)
  const filters = parseFilters(argStr)
  // Ph149:live + historical + action-items 并发收集,三者独立,节省 startup 时间。
  const [live, hist, aiDist] = await Promise.all([
    collectLiveWarnings(filters),
    buildHistoricalDistribution(limit, filters),
    buildActionItemsDistribution(limit, filters),
  ])
  const out = asJson
    ? renderJson(live, hist, limit, filters, aiDist)
    : renderMarkdown(live, hist, limit, filters, aiDist)
  onDone(out)
  return null
}

// Ph144:测试 hook —— 供 smoke 直接拿聚合数据验证,不通过 onDone。
// Ph145:追加 parseSinceMs / parseLedger / parseCode / parseFilters / matchWarning / describeFilters。
// Ph149:追加 buildActionItemsDistribution / matchActionItem / EMPTY_ACTION_ITEMS_DISTRIBUTION。
export const __testing = {
  collectLiveWarnings,
  buildHistoricalDistribution,
  buildActionItemsDistribution,
  matchActionItem,
  parseLimit,
  parseJson,
  parseSinceMs,
  parseLedger,
  parseCode,
  parseFilters,
  matchWarning,
  describeFilters,
  renderMarkdown,
  renderJson,
  EMPTY_FILTERS,
  EMPTY_ACTION_ITEMS_DISTRIBUTION,
}

export const userFacingName = () => 'evolve-triage'
