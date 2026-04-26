/**
 * Phase 148(2026-04-24)— action items 历史流水(append-only ndjson)。
 *
 * Ph147 把"下一步要做什么"聚合成了 actionItems(high/medium/low + source/code
 * /message/suggested),但它与 Ph141 同命:只在 /kernel-status 或 JSON 查询里
 * 当场渲染,下次 tick 再查就只有最新一次。Ph148 把 items.length>0 的 actionItems
 * 每 emergence tick 末尾写一行 ndjson,让:
 *
 *   1. 趋势回看 —— 过去 N 小时 high/medium/low 条数变化
 *   2. 用户离线一阵再回来 —— 能看到中间真正发生过什么
 *   3. 告警升级基础 —— 后续"连续 N 次 high → escalate"需要历史才能算
 *
 * 设计契合现有 Ph142/146 observer-history 家族:
 *   - append-only, fail-open
 *   - 空窗=健康:items.length===0 时 *不* 写(调用方在 background.ts 保证)
 *   - 规模控制:与 observer-history / anomaly-history 姊妹相同的 1000/900
 *   - TTL 默认 30 天,env CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY_TTL_DAYS 覆盖
 *   - env CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY=off 完全禁用(append 直接返回)
 *   - load 本身不做 TTL 过滤(物理存在就返回;TTL 仅在 rotate 时生效)
 *   - rotate 策略:先 TTL 剪,再行数截尾,原子 tmp+rename
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getActionItemsHistoryPath } from '../paths.js'

export type ActionItemPriority = 'high' | 'medium' | 'low'

/**
 * 镜像 kernel-status.ts 的 ActionItem 形状(避免双向 import 死循环 —
 * kernel-status 已经 import 了这里一堆 ledger)。如果 kernel-status 那边
 * 新增字段,记得同步这里 & loadActionItemsHistory 的验证逻辑。
 */
export interface ActionItemSnapshot {
  priority: ActionItemPriority
  source: string
  code: string
  message: string
  suggested: string | null
}

export interface ActionItemsHistoryEntry {
  ts: string
  tickCount: number
  total: number
  byPriority: {
    high: number
    medium: number
    low: number
  }
  bySource: Record<string, number>
  items: ActionItemSnapshot[]
}

const MAX_LINES = 1000
const KEEP_LINES = 900

/** Ph148:公开 MAX_LINES 作为 kernel-status 容量基准。 */
export const MAX_ACTION_ITEMS_HISTORY_LINES = MAX_LINES

/**
 * Ph148 env 开关。与 digest 主开关解耦 —— 用户可能只想关历史,不关实时聚合。
 * 默认开(缺省 env 视为 enabled),显式 'off' 才关。
 */
export function isActionItemsHistoryEnabled(): boolean {
  return process.env.CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY !== 'off'
}

/** Ph148 — 时间维度 TTL。与 observer-history 对齐:默认 30 天,env=0 关。 */
export const DEFAULT_ACTION_ITEMS_HISTORY_TTL_DAYS = 30
export const MAX_ACTION_ITEMS_HISTORY_TTL_DAYS = 365
export function getActionItemsHistoryTtlDays(): number {
  const raw = process.env.CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY_TTL_DAYS
  if (raw === undefined || raw === '') return DEFAULT_ACTION_ITEMS_HISTORY_TTL_DAYS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ACTION_ITEMS_HISTORY_TTL_DAYS
  return Math.min(n, MAX_ACTION_ITEMS_HISTORY_TTL_DAYS)
}

/**
 * 追加一条历史记录。fail-open。
 * 调用方负责确保 entry.total>0(不在此过滤,与 observer-history 同策略)。
 * env=off 时直接返回,不做任何磁盘操作(零副作用)。
 */
export function appendActionItemsHistory(entry: ActionItemsHistoryEntry): void {
  if (!isActionItemsHistoryEnabled()) return
  try {
    const p = getActionItemsHistoryPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8')
    // 抽查截断:与姊妹 ndjson 相同的 tickCount % 50 策略
    if (entry.tickCount % 50 === 0) {
      rotateIfNeeded(p)
    }
  } catch {
    /* fail-open */
  }
}

/**
 * 读取所有历史记录。损坏行静默跳过。
 * 不做 TTL 过滤(调用方若需时间窗用 --since 参数)。
 */
export function loadActionItemsHistory(): ActionItemsHistoryEntry[] {
  try {
    const p = getActionItemsHistoryPath()
    if (!existsSync(p)) return []
    const raw = readFileSync(p, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: ActionItemsHistoryEntry[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (
          obj && typeof obj === 'object'
          && typeof obj.ts === 'string'
          && typeof obj.total === 'number'
          && Array.isArray(obj.items)
          && obj.byPriority && typeof obj.byPriority === 'object'
          && obj.bySource && typeof obj.bySource === 'object'
        ) {
          out.push(obj as ActionItemsHistoryEntry)
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
 * rotate 策略:
 *   1. 先按 TTL 过滤 entries(ts 早于 now-TTL*86400s 丢弃);ttl=0 跳过
 *   2. 再按 MAX_LINES 行数截尾,保留最新 KEEP_LINES
 *   3. 原子写回(tmp+rename)
 * 损坏行天然被 rotate 清理(解析失败 = drop)。
 */
function rotateIfNeeded(path: string): boolean {
  try {
    if (!existsSync(path)) return false
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const ttlDays = getActionItemsHistoryTtlDays()
    const ttlCutoffMs = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : null

    const filtered: string[] = []
    for (const line of lines) {
      let keep = true
      if (ttlCutoffMs !== null) {
        try {
          const obj = JSON.parse(line) as { ts?: string }
          const t = obj?.ts ? Date.parse(obj.ts) : NaN
          if (Number.isFinite(t) && t < ttlCutoffMs) keep = false
          if (!Number.isFinite(t)) keep = false
        } catch {
          keep = false
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
 * 显式公开 rotate —— /evolve-status 等命令可主动触发。
 */
export function rotateActionItemsHistoryIfNeeded(): boolean {
  try {
    return rotateIfNeeded(getActionItemsHistoryPath())
  } catch {
    return false
  }
}

/** 测试用:显式触发 rotate(含 TTL + 行数)。 */
export function __forceTruncateForTests(): void {
  try {
    rotateIfNeeded(getActionItemsHistoryPath())
  } catch {
    /* noop */
  }
}

export const __testInternals = { MAX_LINES, KEEP_LINES }

/* ─────────── Ph150:持久化检测(streak/天数) ─────────── */
/**
 * Ph150 —— 把 Ph148 的历史流水再往前推一步:光写下来不够,得知道哪条 action item
 * 是"卡住"的。定义两条独立 OR 触发:
 *   1. 连续 streakTicks ≥ streakMin(默认 10)出现在最近 N 条 entry ——"频繁轰炸"
 *   2. firstSeen 到 lastSeen 跨度 daysSpan ≥ daysMin(默认 3)——"顽固不走"
 * 两者任一成立 → isPersistent=true,渲染端(kernel-status / evolve-triage)加 🔥。
 *
 * streak 计算规则:从最新一条 entry 开始向前走,连续多少条包含该 code 就是 streak;
 * 中间只要缺一次就停止。一条 entry 内同 code 多次只计 1(entry 级别计数)。
 */
export const PERSISTENCE_STREAK_DEFAULT = 10
export const PERSISTENCE_DAYS_DEFAULT = 3
export const PERSISTENCE_STREAK_MAX = 1000
export const PERSISTENCE_DAYS_MAX = 365

function parseIntEnvBounded(envName: string, dflt: number, cap: number): number {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return dflt
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return dflt
  return Math.min(n, cap)
}

export function getPersistenceThresholds(): { streakMin: number; daysMin: number } {
  return {
    streakMin: parseIntEnvBounded(
      'CLAUDE_EVOLVE_ACTION_ITEMS_PERSISTENT_STREAK',
      PERSISTENCE_STREAK_DEFAULT,
      PERSISTENCE_STREAK_MAX,
    ),
    daysMin: parseIntEnvBounded(
      'CLAUDE_EVOLVE_ACTION_ITEMS_PERSISTENT_DAYS',
      PERSISTENCE_DAYS_DEFAULT,
      PERSISTENCE_DAYS_MAX,
    ),
  }
}

export interface PersistenceMetric {
  code: string
  firstSeenTs: string
  lastSeenTs: string
  totalOccurrences: number   // 该 code 出现过的 entry 数(entry 级,不是 item 级)
  streakTicks: number        // 从最新往前连续出现的 entry 条数
  daysSpan: number           // (lastSeenMs - firstSeenMs) / 86400000,保留 1 位小数
  isPersistent: boolean
  samplePriority: ActionItemPriority   // 该 code 最常出现的 priority
  sampleSource: string                 // 该 code 最常出现的 source
  sampleMessage: string                // 最新一次的 message
  sampleSuggested: string | null       // 最新一次的 suggested
}

/**
 * 计算每个 code 的持久化指标。entries 可以是未排序的,内部按 ts 升序重排。
 * 接受最小子集 { ts, items },方便 kernel-status 从任意来源喂入。
 */
export function computePersistenceMetrics(
  entries: Array<{ ts: string; items: ActionItemSnapshot[] }>,
  opts: { streakMin?: number; daysMin?: number } = {},
): PersistenceMetric[] {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const defaults = getPersistenceThresholds()
  const streakMin = opts.streakMin ?? defaults.streakMin
  const daysMin = opts.daysMin ?? defaults.daysMin

  // ts 升序(稳定:未排序/已排序/乱序都能 round-trip)
  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(a.ts)
    const tb = Date.parse(b.ts)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb
    return 0
  })

  // Step 1:累积每 code 的 first/last/occurrences/priority+source 计数
  const agg = new Map<string, {
    firstSeenMs: number
    lastSeenMs: number
    firstSeenTs: string
    lastSeenTs: string
    totalOccurrences: number
    priorityCounts: Record<ActionItemPriority, number>
    sourceCounts: Record<string, number>
    latestMessage: string
    latestSuggested: string | null
  }>()
  for (const e of sorted) {
    const ms = Date.parse(e.ts)
    if (!Number.isFinite(ms)) continue
    const items = Array.isArray(e.items) ? e.items : []
    const seen = new Set<string>()
    for (const it of items) {
      if (!it || typeof it.code !== 'string') continue
      if (seen.has(it.code)) continue  // entry 级去重
      seen.add(it.code)
      let m = agg.get(it.code)
      if (!m) {
        m = {
          firstSeenMs: ms, lastSeenMs: ms,
          firstSeenTs: e.ts, lastSeenTs: e.ts,
          totalOccurrences: 0,
          priorityCounts: { high: 0, medium: 0, low: 0 },
          sourceCounts: {},
          latestMessage: it.message ?? '',
          latestSuggested: it.suggested ?? null,
        }
        agg.set(it.code, m)
      }
      m.lastSeenMs = ms
      m.lastSeenTs = e.ts
      m.totalOccurrences += 1
      const p = (it.priority === 'high' || it.priority === 'medium' || it.priority === 'low')
        ? it.priority : 'low'
      m.priorityCounts[p] += 1
      if (typeof it.source === 'string') {
        m.sourceCounts[it.source] = (m.sourceCounts[it.source] ?? 0) + 1
      }
      m.latestMessage = it.message ?? m.latestMessage
      m.latestSuggested = it.suggested ?? null
    }
  }

  if (agg.size === 0) return []

  // Step 2:streak —— 倒序遍历,各 code 各自统计"从尾开始连续包含"的条数
  const reversed = [...sorted].reverse()
  const streak: Record<string, number> = {}
  const stopped = new Set<string>()
  for (const code of agg.keys()) streak[code] = 0
  for (const e of reversed) {
    const codes = new Set<string>()
    for (const it of Array.isArray(e.items) ? e.items : []) {
      if (it && typeof it.code === 'string') codes.add(it.code)
    }
    for (const code of agg.keys()) {
      if (stopped.has(code)) continue
      if (codes.has(code)) streak[code] = (streak[code] ?? 0) + 1
      else stopped.add(code)
    }
    if (stopped.size === agg.size) break
  }

  // Step 3:组装输出,排序:persistent 优先,再 streak desc,再 daysSpan desc
  const out: PersistenceMetric[] = []
  for (const [code, m] of agg) {
    const daysSpanRaw = Math.max(0, (m.lastSeenMs - m.firstSeenMs) / 86_400_000)
    const daysSpan = Math.round(daysSpanRaw * 10) / 10
    const s = streak[code] ?? 0
    const isPersistent = s >= streakMin || daysSpan >= daysMin
    // 最常见 priority
    let bestP: ActionItemPriority = 'low'
    let bestPC = -1
    for (const p of ['high', 'medium', 'low'] as ActionItemPriority[]) {
      const c = m.priorityCounts[p]
      if (c > bestPC) { bestP = p; bestPC = c }
    }
    // 最常见 source
    let bestS = ''
    let bestSC = -1
    for (const [s2, c] of Object.entries(m.sourceCounts)) {
      if (c > bestSC) { bestS = s2; bestSC = c }
    }
    out.push({
      code,
      firstSeenTs: m.firstSeenTs,
      lastSeenTs: m.lastSeenTs,
      totalOccurrences: m.totalOccurrences,
      streakTicks: s,
      daysSpan,
      isPersistent,
      samplePriority: bestP,
      sampleSource: bestS,
      sampleMessage: m.latestMessage,
      sampleSuggested: m.latestSuggested,
    })
  }
  out.sort((a, b) => {
    if (a.isPersistent !== b.isPersistent) return a.isPersistent ? -1 : 1
    if (b.streakTicks !== a.streakTicks) return b.streakTicks - a.streakTicks
    return b.daysSpan - a.daysSpan
  })
  return out
}

/* ─────────── Ph151:解决追踪 / MTTR ─────────── */
/**
 * Ph151 —— 与 Ph150 持久化形成闭环:
 *   - Ph150 回答"这条 item 现在卡了多久?"(streak/daysSpan)
 *   - Ph151 回答"这条 item 历史上每次卡多久?"(resolutionCount/avgMttr)
 *
 * 概念:把每个 code 的历史看成若干"出现窗口"。连续的 entry 中出现 = 同一窗口;
 * 中间有一条 entry 该 code 不出现 → 窗口关闭(resolved)。MTTR = 窗口内
 * lastSeenMs - firstSeenMs(1-entry 窗口 MTTR=0 = 一次性出现即消失)。
 *
 * 若最新一条 entry 仍包含该 code → currentlyOpen=true,当前开放窗口耗时
 * = lastEntryMs - currentOpenStartMs(单独字段,不计入 closed 统计)。
 *
 * 不做阈值判断(阈值由渲染层决定)。
 */
export interface ResolutionMetric {
  code: string
  resolutionCount: number              // 已关闭窗口数
  avgMttrMs: number | null             // 已闭窗口平均 MTTR
  medianMttrMs: number | null
  maxMttrMs: number | null
  minMttrMs: number | null
  currentlyOpen: boolean               // 最新 entry 是否仍含该 code
  currentOpenDurationMs: number | null // 当前开放窗口已开多久
  totalLifetimeOccurrences: number     // 历史上出现 entry 总数(≥ resolutionCount)
  // Ph152 —— MTTR 趋势(对比最近 N 闭窗 vs 其余历史)
  recentAvgMttrMs: number | null       // 最近 N 条 closedMttrs 的平均值
  historicalAvgMttrMs: number | null   // 其余(去掉最近 N)closedMttrs 的平均值
  mttrTrend: 'degrading' | 'improving' | 'stable' | 'unknown'
}

/* ─────────── Ph152:MTTR 趋势阈值 ─────────── */
/**
 * Ph152 —— 在 Ph151 闭窗 MTTR 之上叠一层"这类 code 最近修得更快还是更慢":
 *   - recent = 最近 RECENT_COUNT 条 closedMttrs(时间序)
 *   - historical = 其余 closedMttrs
 *   - ratio = recentAvg / historicalAvg
 *   - ratio > DEGRADE_RATIO → degrading(最近变慢)
 *   - ratio < IMPROVE_RATIO → improving
 *   - 中间 → stable
 *   - 样本不足(闭窗数 < 2 或 historical=0)→ unknown
 * 阈值可通过 env 覆盖,便于在不同噪声水位下校准。
 */
export const MTTR_TREND_RECENT_COUNT_DEFAULT = 3
export const MTTR_TREND_RECENT_COUNT_MAX = 10
export const MTTR_TREND_DEGRADE_RATIO_DEFAULT = 1.5
export const MTTR_TREND_IMPROVE_RATIO_DEFAULT = 0.67

function parseFloatEnvBounded(envName: string, dflt: number, min: number, max: number): number {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return dflt
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(Math.max(n, min), max)
}

export function getMttrTrendThresholds(): {
  recentCount: number
  degradeRatio: number
  improveRatio: number
} {
  return {
    recentCount: parseIntEnvBounded(
      'CLAUDE_EVOLVE_MTTR_TREND_RECENT_COUNT',
      MTTR_TREND_RECENT_COUNT_DEFAULT,
      MTTR_TREND_RECENT_COUNT_MAX,
    ) || MTTR_TREND_RECENT_COUNT_DEFAULT,
    degradeRatio: parseFloatEnvBounded(
      'CLAUDE_EVOLVE_MTTR_TREND_DEGRADE_RATIO',
      MTTR_TREND_DEGRADE_RATIO_DEFAULT,
      1.01, 100,
    ),
    improveRatio: parseFloatEnvBounded(
      'CLAUDE_EVOLVE_MTTR_TREND_IMPROVE_RATIO',
      MTTR_TREND_IMPROVE_RATIO_DEFAULT,
      0.001, 0.99,
    ),
  }
}

/**
 * Ph152 —— 纯函数:对一串按时间序排列的 closedMttrs 计算 trend。
 * 独立导出,便于上层复用 & 单测。
 */
export function computeMttrTrend(
  closedMttrsChronological: number[],
  opts: { recentCount?: number; degradeRatio?: number; improveRatio?: number } = {},
): {
  recentAvgMttrMs: number | null
  historicalAvgMttrMs: number | null
  mttrTrend: 'degrading' | 'improving' | 'stable' | 'unknown'
} {
  const defaults = getMttrTrendThresholds()
  const recentCount = opts.recentCount ?? defaults.recentCount
  const degradeRatio = opts.degradeRatio ?? defaults.degradeRatio
  const improveRatio = opts.improveRatio ?? defaults.improveRatio
  const arr = Array.isArray(closedMttrsChronological) ? closedMttrsChronological : []
  // 样本不足:闭窗 < 2 直接 unknown
  if (arr.length < 2) {
    return { recentAvgMttrMs: null, historicalAvgMttrMs: null, mttrTrend: 'unknown' }
  }
  // recentN 至少 1,且需保证 historical 至少 1
  const recentN = Math.min(recentCount, arr.length - 1)
  if (recentN < 1) {
    return { recentAvgMttrMs: null, historicalAvgMttrMs: null, mttrTrend: 'unknown' }
  }
  const recent = arr.slice(-recentN)
  const historical = arr.slice(0, arr.length - recentN)
  if (historical.length === 0) {
    return { recentAvgMttrMs: null, historicalAvgMttrMs: null, mttrTrend: 'unknown' }
  }
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
  const historicalAvg = historical.reduce((a, b) => a + b, 0) / historical.length
  if (historicalAvg <= 0) {
    // 历史全 0-MTTR(1-entry 窗口):用 recent 是否>0 判断
    if (recentAvg > 0) return { recentAvgMttrMs: recentAvg, historicalAvgMttrMs: historicalAvg, mttrTrend: 'degrading' }
    return { recentAvgMttrMs: recentAvg, historicalAvgMttrMs: historicalAvg, mttrTrend: 'stable' }
  }
  const ratio = recentAvg / historicalAvg
  let trend: 'degrading' | 'improving' | 'stable'
  if (ratio > degradeRatio) trend = 'degrading'
  else if (ratio < improveRatio) trend = 'improving'
  else trend = 'stable'
  return { recentAvgMttrMs: recentAvg, historicalAvgMttrMs: historicalAvg, mttrTrend: trend }
}

/**
 * 按 code 切分 open/closed 窗口。entries 不要求已排序,内部按 ts 升序。
 * 单一 entry 内同 code 多次只计一次(entry 级)。
 */
export function computeResolutionMetrics(
  entries: Array<{ ts: string; items: ActionItemSnapshot[] }>,
): ResolutionMetric[] {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(a.ts)
    const tb = Date.parse(b.ts)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb
    return 0
  })

  // 每个 code 的当前状态
  type S = {
    // 当前开放窗口的起止(ms)
    windowStartMs: number | null
    windowLastSeenMs: number | null
    // 已关闭窗口的 MTTR(lastSeen - firstSeen)列表
    closedMttrs: number[]
    // 出现 entry 总数
    totalOccurrences: number
  }
  const state = new Map<string, S>()
  const ensure = (code: string): S => {
    let s = state.get(code)
    if (!s) {
      s = { windowStartMs: null, windowLastSeenMs: null, closedMttrs: [], totalOccurrences: 0 }
      state.set(code, s)
    }
    return s
  }

  const allSeenCodes = new Set<string>()
  for (const e of sorted) {
    const ms = Date.parse(e.ts)
    if (!Number.isFinite(ms)) continue
    const codesInEntry = new Set<string>()
    for (const it of Array.isArray(e.items) ? e.items : []) {
      if (it && typeof it.code === 'string') codesInEntry.add(it.code)
    }

    // 对所有历史见过的 code 判断当前 entry 状态
    for (const code of allSeenCodes) {
      const s = ensure(code)
      if (codesInEntry.has(code)) {
        // 仍在 → 开放窗口延续(或新开)
        if (s.windowStartMs === null) s.windowStartMs = ms
        s.windowLastSeenMs = ms
        s.totalOccurrences += 1
      } else if (s.windowStartMs !== null && s.windowLastSeenMs !== null) {
        // 上一 entry 还在,这条不在 → 关闭窗口
        s.closedMttrs.push(s.windowLastSeenMs - s.windowStartMs)
        s.windowStartMs = null
        s.windowLastSeenMs = null
      }
    }
    // 新 code(本 entry 首次出现)
    for (const code of codesInEntry) {
      if (!allSeenCodes.has(code)) {
        allSeenCodes.add(code)
        const s = ensure(code)
        s.windowStartMs = ms
        s.windowLastSeenMs = ms
        s.totalOccurrences += 1
      }
    }
  }

  // 输出
  const lastEntryMs = Date.parse(sorted[sorted.length - 1]!.ts)
  const out: ResolutionMetric[] = []
  for (const [code, s] of state) {
    const currentlyOpen = s.windowStartMs !== null
    // sorted2 只用于中位/min/max;趋势用原 chronological s.closedMttrs
    const sorted2 = s.closedMttrs.slice().sort((a, b) => a - b)
    const count = sorted2.length
    const sum = sorted2.reduce((a, b) => a + b, 0)
    // Ph152 —— chronological closedMttrs → trend
    const trend = computeMttrTrend(s.closedMttrs)
    out.push({
      code,
      resolutionCount: count,
      avgMttrMs: count > 0 ? sum / count : null,
      medianMttrMs: count > 0 ? sorted2[Math.floor(count / 2)]! : null,
      maxMttrMs: count > 0 ? sorted2[count - 1]! : null,
      minMttrMs: count > 0 ? sorted2[0]! : null,
      currentlyOpen,
      currentOpenDurationMs: currentlyOpen && Number.isFinite(lastEntryMs) && s.windowStartMs !== null
        ? lastEntryMs - s.windowStartMs
        : null,
      totalLifetimeOccurrences: s.totalOccurrences,
      recentAvgMttrMs: trend.recentAvgMttrMs,
      historicalAvgMttrMs: trend.historicalAvgMttrMs,
      mttrTrend: trend.mttrTrend,
    })
  }
  // 排序:currentlyOpen 优先,再按 resolutionCount desc(多次出现的更值得看)
  out.sort((a, b) => {
    if (a.currentlyOpen !== b.currentlyOpen) return a.currentlyOpen ? -1 : 1
    return b.resolutionCount - a.resolutionCount
  })
  return out
}

/* ─────────── Ph154:MTTR-based Warnings ─────────── */
/**
 * Ph154 —— 把 Ph150/151/152 的三类状态信号接入决策管道(signal→decision):
 *   1) STUCK_DEGRADING: persistent(Ph150) + mttrTrend=degrading(Ph152) → severity=high
 *      语义:code 已"顽固常客"(streak≥10 或 days≥3),且最近修得更慢 → 优先级最高。
 *   2) OPEN_TOO_LONG:  currentlyOpen(Ph151) + currentOpenDurationMs > threshold → severity=medium
 *      默认阈值 24h,env 覆盖 CLAUDE_EVOLVE_MTTR_WARN_OPEN_HOURS(bound: 1~720)。
 *      语义:当前这一次窗口已经开太久,不论历史是否持久都值得盯。
 *   3) REGRESSION:      !persistent + resolved≥3 + mttrTrend=degrading → severity=medium
 *      语义:不是顽固,但已经修过几次且最近修得变慢 → 正在回归恶化。
 * 同一 code 可以命中多条规则,本函数全部产出;消费端自己决定是否合并/去重。
 * fail-open:entries 空 / 指标为空 → 返回空数组,不抛。
 */
export type MttrWarningKind = 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
export type MttrWarningSeverity = 'high' | 'medium' | 'low'

export interface MttrWarning {
  code: string
  kind: MttrWarningKind
  severity: MttrWarningSeverity
  message: string
  // 携带命中规则时的原始指标,消费端可二次决策,无需全填
  streakTicks?: number
  daysSpan?: number
  currentOpenDurationMs?: number
  resolutionCount?: number
  avgMttrMs?: number | null
  recentAvgMttrMs?: number | null
  historicalAvgMttrMs?: number | null
}

export const MTTR_WARN_OPEN_HOURS_DEFAULT = 24
export const MTTR_WARN_OPEN_HOURS_MIN = 1
export const MTTR_WARN_OPEN_HOURS_MAX = 720 // 30d

export function getMttrWarningThresholds(): { openTooLongMs: number } {
  const hours = parseIntEnvBounded(
    'CLAUDE_EVOLVE_MTTR_WARN_OPEN_HOURS',
    MTTR_WARN_OPEN_HOURS_DEFAULT,
    MTTR_WARN_OPEN_HOURS_MAX,
  ) || MTTR_WARN_OPEN_HOURS_DEFAULT
  return {
    openTooLongMs: Math.max(hours, MTTR_WARN_OPEN_HOURS_MIN) * 60 * 60 * 1000,
  }
}

export function computeMttrWarnings(
  entries: Array<{ ts: string; items: ActionItemSnapshot[] }>,
  opts: { openTooLongMs?: number } = {},
): MttrWarning[] {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const thresholds = getMttrWarningThresholds()
  const openTooLongMs = opts.openTooLongMs ?? thresholds.openTooLongMs
  const warnings: MttrWarning[] = []
  const persistence = new Map(
    computePersistenceMetrics(entries).map(m => [m.code, m]),
  )
  const resolution = new Map(
    computeResolutionMetrics(entries).map(m => [m.code, m]),
  )
  const codes = new Set<string>([...persistence.keys(), ...resolution.keys()])
  for (const code of codes) {
    const p = persistence.get(code)
    const r = resolution.get(code)
    // Rule 1: STUCK_DEGRADING(高危)
    if (p?.isPersistent && r?.mttrTrend === 'degrading') {
      warnings.push({
        code,
        kind: 'STUCK_DEGRADING',
        severity: 'high',
        message: `code "${code}" 顽固+最近修得变慢(streak=${p.streakTicks} days=${p.daysSpan})`,
        streakTicks: p.streakTicks,
        daysSpan: p.daysSpan,
        resolutionCount: r.resolutionCount,
        avgMttrMs: r.avgMttrMs,
        recentAvgMttrMs: r.recentAvgMttrMs,
        historicalAvgMttrMs: r.historicalAvgMttrMs,
      })
    }
    // Rule 2: OPEN_TOO_LONG(当前窗口超阈值)
    if (r?.currentlyOpen && r.currentOpenDurationMs != null && r.currentOpenDurationMs > openTooLongMs) {
      warnings.push({
        code,
        kind: 'OPEN_TOO_LONG',
        severity: 'medium',
        message: `code "${code}" 当前开放已 ${Math.round(r.currentOpenDurationMs / 3600000)}h,超过阈值`,
        currentOpenDurationMs: r.currentOpenDurationMs,
      })
    }
    // Rule 3: REGRESSION(非持久但趋势恶化)
    if (!p?.isPersistent && r && r.resolutionCount >= 3 && r.mttrTrend === 'degrading') {
      warnings.push({
        code,
        kind: 'REGRESSION',
        severity: 'medium',
        message: `code "${code}" 非持久但已修 ${r.resolutionCount} 次且趋势恶化`,
        resolutionCount: r.resolutionCount,
        avgMttrMs: r.avgMttrMs,
        recentAvgMttrMs: r.recentAvgMttrMs,
        historicalAvgMttrMs: r.historicalAvgMttrMs,
      })
    }
  }
  // 排序:severity(high>medium>low) → kind 字母序 → code 字母序,稳定可读
  const sevRank = { high: 0, medium: 1, low: 2 }
  warnings.sort((a, b) => {
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.code.localeCompare(b.code)
  })
  return warnings
}

/**
 * Ph157(2026-04-24)—— warning 增量(emerged / resolved since last tick)。
 *
 * 原理:warnings 是 history 的纯函数 —— 截 entries[0..-1] 算 prev,全量算 curr,按
 *       (code,kind) 做差集即可得本次 tick 的新出现 / 已消失集合。无需新 ledger、无需
 *       writer,复用现有 action-items-history。
 *
 * fail-open:entries.length<2 → 返回空 delta(无从比较);warnings 计算异常由 compute*
 *           自身 fail-open 处理,这里只管集合运算。
 */
export function computeWarningDelta(
  entries: Array<{ ts: string; items: ActionItemSnapshot[] }>,
  opts: { openTooLongMs?: number } = {},
): { emerged: MttrWarning[]; resolved: MttrWarning[] } {
  if (!Array.isArray(entries) || entries.length < 2) {
    return { emerged: [], resolved: [] }
  }
  const prev = computeMttrWarnings(entries.slice(0, -1), opts)
  const curr = computeMttrWarnings(entries, opts)
  // 同一 code 可能被不同 kind 命中(STUCK_DEGRADING vs REGRESSION),用 (code,kind)
  // 做唯一键,让 kind 变化也能被识别为 emerged/resolved。
  const key = (w: MttrWarning) => `${w.code}::${w.kind}`
  const prevKeys = new Set(prev.map(key))
  const currKeys = new Set(curr.map(key))
  const emerged = curr.filter(w => !prevKeys.has(key(w)))
  const resolved = prev.filter(w => !currKeys.has(key(w)))
  return { emerged, resolved }
}

// ── Ph158(2026-04-24)—— Warning Lifecycle 指标 ──
//
// 在信号叠加阶梯上(Ph150→151→152→154→156→157→158),最后一层关心:
//   "这条警告是一次性出现,还是反复发作?"—— 反复发作的 warning 说明背后的问题
//   没有根治,应当被提升优先级。
//
// Chronic offender:在观察窗口内 totalEmergences ≥ threshold(默认 3)的 (code,kind)。
//   默认 threshold 来自 env,fail-open 到 3。
//
// 复杂度:
//   - 每个 tick 调用一次 computeMttrWarnings(prefix),prefix 最多为 entries[0..i]。
//   - entries 长度 N,观察窗口 maxWindow(默认 200,上限防止 O(N^2) 爆炸)。
//   - 总开销 O(maxWindow * N log N) —— N=1000 仍在 ms 级。
//
// fail-open:entries<2 → []。底层 compute* 异常走吞掉,返回已聚合的部分。

const WARN_CHRONIC_THRESHOLD_DEFAULT = 3
const WARN_CHRONIC_THRESHOLD_MIN = 1
const WARN_CHRONIC_THRESHOLD_MAX = 20
const WARN_LIFECYCLE_WINDOW_DEFAULT = 200
const WARN_LIFECYCLE_WINDOW_MIN = 10
const WARN_LIFECYCLE_WINDOW_MAX = 2000

export function getWarningLifecycleThresholds(): {
  chronicThreshold: number
  maxWindow: number
} {
  const chronicRaw = parseIntEnvBounded(
    'CLAUDE_EVOLVE_WARN_CHRONIC_THRESHOLD',
    WARN_CHRONIC_THRESHOLD_DEFAULT,
    WARN_CHRONIC_THRESHOLD_MAX,
  ) || WARN_CHRONIC_THRESHOLD_DEFAULT
  const chronicThreshold = Math.max(chronicRaw, WARN_CHRONIC_THRESHOLD_MIN)
  const windowRaw = parseIntEnvBounded(
    'CLAUDE_EVOLVE_WARN_LIFECYCLE_WINDOW',
    WARN_LIFECYCLE_WINDOW_DEFAULT,
    WARN_LIFECYCLE_WINDOW_MAX,
  ) || WARN_LIFECYCLE_WINDOW_DEFAULT
  const maxWindow = Math.max(windowRaw, WARN_LIFECYCLE_WINDOW_MIN)
  return { chronicThreshold, maxWindow }
}

export interface WarningLifecycle {
  code: string
  kind: MttrWarningKind
  // 当前/最新 severity(若 currentlyActive 则是现在的;否则是上次活跃时的)
  severity: MttrWarningSeverity
  // 首次出现时间
  firstEmergedAt: string
  // 最近一次活跃时间(warning 存在于该 tick 的 warnings 列表)
  lastActiveAt: string
  // 在观察窗口内独立 emergence(从 inactive → active 的转换)次数
  totalEmergences: number
  // warning 处于活跃状态的 tick 数(累计)
  totalActiveTicks: number
  // 是否当前仍活跃(最新 tick 的 warnings 中包含此 key)
  currentlyActive: boolean
  // totalEmergences >= threshold
  isChronicOffender: boolean
}

export function computeWarningLifecycles(
  entries: Array<{ ts: string; items: ActionItemSnapshot[] }>,
  opts: { openTooLongMs?: number; chronicThreshold?: number; maxWindow?: number } = {},
): WarningLifecycle[] {
  if (!Array.isArray(entries) || entries.length < 2) return []
  const thresholds = getWarningLifecycleThresholds()
  const chronicThreshold = opts.chronicThreshold ?? thresholds.chronicThreshold
  const maxWindow = opts.maxWindow ?? thresholds.maxWindow
  const N = entries.length
  // 只遍历窗口末端 —— 但每次 prefix 仍取自 entries[0..i],保证 persistence/resolution
  // 依托的 history 完整。
  const startI = Math.max(1, N - maxWindow)
  const lifecycles = new Map<string, WarningLifecycle>()
  const keyOf = (w: MttrWarning) => `${w.code}::${w.kind}`
  // 在 startI 之前的"最后一帧"作为 prev —— 避免窗口起点误判为 emergence
  let prevKeys: Set<string>
  try {
    prevKeys = new Set(
      computeMttrWarnings(entries.slice(0, startI), opts).map(keyOf),
    )
  } catch {
    prevKeys = new Set()
  }
  for (let i = startI; i < N; i++) {
    let currWarnings: MttrWarning[] = []
    try {
      currWarnings = computeMttrWarnings(entries.slice(0, i + 1), opts)
    } catch {
      // compute 失败 —— 保留既有聚合,跳过这一 tick
      prevKeys = new Set()
      continue
    }
    const currKeys = new Set(currWarnings.map(keyOf))
    const ts = entries[i].ts
    for (const w of currWarnings) {
      const key = keyOf(w)
      let lc = lifecycles.get(key)
      if (!lc) {
        lc = {
          code: w.code,
          kind: w.kind,
          severity: w.severity,
          firstEmergedAt: ts,
          lastActiveAt: ts,
          totalEmergences: 0,
          totalActiveTicks: 0,
          currentlyActive: false,
          isChronicOffender: false,
        }
        lifecycles.set(key, lc)
      }
      if (!prevKeys.has(key)) {
        // inactive → active 转换
        lc.totalEmergences += 1
      }
      lc.totalActiveTicks += 1
      lc.lastActiveAt = ts
      lc.severity = w.severity
    }
    prevKeys = currKeys
  }
  // 最终 currentlyActive 判定 —— 全量 entries 的 warnings 代表"此刻状态"
  let latestKeys: Set<string>
  try {
    latestKeys = new Set(computeMttrWarnings(entries, opts).map(keyOf))
  } catch {
    latestKeys = new Set()
  }
  const out: WarningLifecycle[] = []
  for (const lc of lifecycles.values()) {
    const key = `${lc.code}::${lc.kind}`
    lc.currentlyActive = latestKeys.has(key)
    lc.isChronicOffender = lc.totalEmergences >= chronicThreshold
    out.push(lc)
  }
  // 排序:chronic 优先,然后按 totalEmergences desc,再 severity rank,再 code/kind 字典序
  const sevRank = { high: 0, medium: 1, low: 2 }
  out.sort((a, b) => {
    if (a.isChronicOffender !== b.isChronicOffender) return a.isChronicOffender ? -1 : 1
    if (a.totalEmergences !== b.totalEmergences) return b.totalEmergences - a.totalEmergences
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity]
    if (a.code !== b.code) return a.code.localeCompare(b.code)
    return a.kind.localeCompare(b.kind)
  })
  return out
}


