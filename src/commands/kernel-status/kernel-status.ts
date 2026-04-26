/**
 * /kernel-status — 调度内核诊断命令
 *
 * 把散落在 6+ 个模块的 snapshot API 聚合到一屏,便于排障和说服用户开启更高
 * 档位的特性开关。不做任何写入,零副作用。
 *
 * 数据源:
 *   - runtimeMode              运行模式(与 /memory-stats 一致)
 *   - agentScheduler            maxSlots / activeSlots / queueDepth / quotaUsage
 *   - periodicMaintenance       每个周期任务的 tickCount/inFlight/lastError
 *   - cache                     Agent result cache 的 size/signature 规模
 *   - rateBucket                迭代所有滑窗限流桶(默认 input-tokens + 后续扩展)
 *   - speculation               预跑尝试/命中/丢弃分布
 *   - agentPreflight            本 session 各 agent 的连续失败计数
 *   - agentStats cached         最近一次聚合产出(成功率 / p95 / 样本数)
 *   - toolStats                 本 session in-memory ring buffer(工具调用成功率 / p95)
 *   - autoContinueStrategies    自动续聊策略注册表(priority / enabled / hits)
 *   - snapshotStores            跨会话持久化快照(#2:agent-stats / tool-stats)
 *   - coldStart                 冷启动候选注册表 + 最近 burst 运行态(#5)
 *
 * 每节独立 try/catch —— 某模块未启用或未初始化时不影响其它节渲染。
 */

import type { LocalJSXCommandCall } from '../../types/command.js'
import { computeStatsWarnings, formatWarningsMarkdown } from '../../services/autoEvolve/arena/statsWarnings.js'

// ── 辅助格式化 ─────────────────────────────────────────

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms >= 60_000) return `${(ms / 1000).toFixed(0)}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

// ── Ph147(2026-04-24):Action Items 聚合 ─────────────────
//   目的:把 /kernel-status 变成"体检报告",一眼看到需要动手处理什么。
//   - 不触发写入,只读磁盘(与整个 kernel-status 契约保持一致)
//   - 三个级别:high=契约破了 / medium=digest 陈旧 / low=observer warnings
//   - suggested:给每条 item 附"下一步命令",避免用户猜
//   - fail-open:任何一源抛错,跳过该源,不影响其它源的 item 汇总
export type ActionItemPriority = 'high' | 'medium' | 'low'
export interface ActionItem {
  priority: ActionItemPriority
  source: string
  code: string
  message: string
  suggested: string | null
}

// Ph150:enriched = item + 从 action-items-history 计算出的持久化标记。
//   persistent/streakTicks/daysSpan 仅在历史可读 + 该 code 命中阈值时填充。
//   不改变 collectActionItems() 契约(仍返回纯 ActionItem[])。
// Ph153(2026-04-24):叠加 Ph151 resolution/MTTR 与 Ph152 趋势。
//   resolutionCount/avgMttrMs/currentlyOpen/currentOpenDurationMs 取自 computeResolutionMetrics;
//   mttrTrend 为 Ph152 📈/📉/◻/unknown 四态之一。
//   所有字段仍然 optional,历史读失败或 env=off 时一律缺席,维持 fail-open。
export interface EnrichedActionItem extends ActionItem {
  persistent?: boolean
  streakTicks?: number
  daysSpan?: number
  // Ph153 —— MTTR 相关(Ph151)
  resolutionCount?: number
  avgMttrMs?: number | null
  currentlyOpen?: boolean
  currentOpenDurationMs?: number | null
  // Ph153 —— 趋势(Ph152)
  mttrTrend?: 'degrading' | 'improving' | 'stable' | 'unknown'
  // Ph156 —— warnings→decision 闭环:
  //   当 code 命中 Ph154 mttrWarnings 之一(STUCK_DEGRADING/OPEN_TOO_LONG/REGRESSION)时,
  //   该 action item 被"升级";UI 用 🚨 badge 区别单纯 🔥(只表示持久化)。
  //   一条 code 可能被多个 warning 匹配 —— 取 severity 最重的那条。
  escalated?: boolean
  escalationKind?: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'
  escalationSeverity?: 'high' | 'medium' | 'low'
}

/**
 * Ph150 —— 用 action-items-history 给 live items 补"顽固"标签。
 * Ph153 —— 同时取 Ph151 resolution 指标与 Ph152 趋势。
 * fail-open:历史读失败 / env=off / compute 抛异常 → 原样返回(增强字段一律缺席)。
 */
export async function enrichActionItemsWithPersistence(
  items: ActionItem[],
): Promise<EnrichedActionItem[]> {
  if (items.length === 0) return []
  try {
    const {
      loadActionItemsHistory,
      computePersistenceMetrics,
      computeResolutionMetrics,
      computeMttrWarnings,
      isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (!isActionItemsHistoryEnabled()) return items.map(i => ({ ...i }))
    const entries = loadActionItemsHistory()
    if (entries.length === 0) return items.map(i => ({ ...i }))
    const minEntries = entries.map(e => ({ ts: e.ts, items: e.items }))
    const pMetrics = computePersistenceMetrics(minEntries)
    // Ph153 —— 平行计算 resolution/trend
    const rMetrics = computeResolutionMetrics(minEntries)
    const byCodeP = new Map(pMetrics.map(m => [m.code, m]))
    const byCodeR = new Map(rMetrics.map(m => [m.code, m]))
    // Ph156 —— 平行计算 mttrWarnings,为每条 code 保留最重的那条。
    //   sev rank:high=0 < medium=1 < low=2,取最小 rank 即最重。
    //   warnings 计算异常 → 吞掉(fail-open),enrichment 继续。
    const byCodeW = new Map<string, { kind: 'STUCK_DEGRADING' | 'OPEN_TOO_LONG' | 'REGRESSION'; severity: 'high' | 'medium' | 'low' }>()
    try {
      const warnings = computeMttrWarnings(minEntries)
      const sevRank = (s: 'high' | 'medium' | 'low') => s === 'high' ? 0 : s === 'medium' ? 1 : 2
      for (const w of warnings) {
        const prev = byCodeW.get(w.code)
        if (!prev || sevRank(w.severity) < sevRank(prev.severity)) {
          byCodeW.set(w.code, { kind: w.kind, severity: w.severity })
        }
      }
    } catch {
      // warnings 失败不阻塞 persistent/resolution enrichment
    }
    return items.map(i => {
      const p = byCodeP.get(i.code)
      const r = byCodeR.get(i.code)
      const w = byCodeW.get(i.code)
      const out: EnrichedActionItem = { ...i }
      if (p) {
        out.persistent = p.isPersistent
        out.streakTicks = p.streakTicks
        out.daysSpan = p.daysSpan
      }
      if (r) {
        out.resolutionCount = r.resolutionCount
        out.avgMttrMs = r.avgMttrMs
        out.currentlyOpen = r.currentlyOpen
        out.currentOpenDurationMs = r.currentOpenDurationMs
        out.mttrTrend = r.mttrTrend
      }
      if (w) {
        out.escalated = true
        out.escalationKind = w.kind
        out.escalationSeverity = w.severity
      }
      return out
    })
  } catch {
    return items.map(i => ({ ...i }))
  }
}

const HEALTH_STALE_THRESHOLD_MS = 24 * 60 * 60_000 // 24h

export async function collectActionItems(): Promise<ActionItem[]> {
  const items: ActionItem[] = []

  // (A) 契约三层 —— 任何一层破即 high
  try {
    const { getAdvisoryMiningDiagnostics } = await import(
      '../../services/autoEvolve/emergence/patternMiner.js'
    )
    const fm = getAdvisoryMiningDiagnostics({ topN: 0 }).fusionMapping
    if (fm.orphanContractCategories.length > 0) {
      items.push({
        priority: 'high', source: 'contract', code: 'ORPHAN_CONTRACT',
        message: `orphan contract categories: ${fm.orphanContractCategories.slice(0, 3).join(',')}${fm.orphanContractCategories.length > 3 ? '…' : ''}`,
        suggested: '/evolve-health',
      })
    }
    if (fm.missingContractCategories.length > 0) {
      items.push({
        priority: 'high', source: 'contract', code: 'MISSING_CONTRACT',
        message: `missing contract categories: ${fm.missingContractCategories.slice(0, 3).join(',')}${fm.missingContractCategories.length > 3 ? '…' : ''}`,
        suggested: '/evolve-health',
      })
    }
    if (fm.unmappedWithEntity > 0) {
      items.push({
        priority: 'high', source: 'contract', code: 'UNMAPPED_WITH_ENTITY',
        message: `${fm.unmappedWithEntity} unmapped entities`,
        suggested: '/evolve-health',
      })
    }
    if (fm.undeclaredEmittedCategories.length > 0) {
      items.push({
        priority: 'high', source: 'contract', code: 'UNDECLARED_EMITTED',
        message: `undeclared emitted categories: ${fm.undeclaredEmittedCategories.slice(0, 3).join(',')}${fm.undeclaredEmittedCategories.length > 3 ? '…' : ''}`,
        suggested: '/evolve-health',
      })
    }
  } catch { /* fail-open */ }

  // (B) Health Digest 陈旧 / 缺失 —— medium
  try {
    const { loadHealthDigest, isHealthDigestEnabled } = await import(
      '../../services/autoEvolve/arena/healthDigest.js'
    )
    if (isHealthDigestEnabled()) {
      const d = loadHealthDigest()
      if (!d) {
        items.push({
          priority: 'medium', source: 'health-digest', code: 'MISSING',
          message: 'health digest 尚未生成(emergence tick 未落盘)',
          suggested: '/evolve-tick',
        })
      } else {
        const ageMs = Date.now() - Date.parse(d.generatedAt)
        if (Number.isFinite(ageMs) && ageMs > HEALTH_STALE_THRESHOLD_MS) {
          items.push({
            priority: 'medium', source: 'health-digest', code: 'STALE',
            message: `health digest 陈旧:${fmtMs(ageMs)} ago(阈值 24h)`,
            suggested: '/evolve-tick',
          })
        }
      }
    }
  } catch { /* fail-open */ }

  // (C) Observer warnings 三 ledger —— low;code 映射到 /evolve-triage
  try {
    type LedgerName = 'audit' | 'anomaly' | 'history'
    const ledgerCmd = (l: LedgerName) => `/evolve-triage --ledger=${l}`
    // audit
    try {
      const { loadBackpressureAudit, MAX_AUDIT_LINES } = await import(
        '../../services/autoEvolve/arena/backpressureAudit.js'
      )
      const all = loadBackpressureAudit()
      if (all.length > 0) {
        const newest = all[all.length - 1]
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        for (const w of computeStatsWarnings({
          total: all.length, maxLines: MAX_AUDIT_LINES,
          sinceNewestMs: sinceNewest, staleHint: 'backpressure observer',
        })) {
          items.push({
            priority: 'low', source: 'observer-audit',
            code: w.code, message: w.message, suggested: ledgerCmd('audit'),
          })
        }
      }
    } catch { /* per-ledger fail-open */ }
    // anomaly
    try {
      const { loadAnomalyHistory, MAX_ANOMALY_LINES } = await import(
        '../../services/autoEvolve/arena/anomalyHistory.js'
      )
      const all = loadAnomalyHistory()
      if (all.length > 0) {
        const newest = all[all.length - 1]
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        for (const w of computeStatsWarnings({
          total: all.length, maxLines: MAX_ANOMALY_LINES,
          sinceNewestMs: sinceNewest, staleHint: null,
        })) {
          items.push({
            priority: 'low', source: 'observer-anomaly',
            code: w.code, message: w.message, suggested: ledgerCmd('anomaly'),
          })
        }
      }
    } catch { /* per-ledger fail-open */ }
    // history
    try {
      const { loadHealthDigestHistory, isHealthDigestHistoryEnabled, MAX_HISTORY_LINES } = await import(
        '../../services/autoEvolve/arena/healthDigest.js'
      )
      if (isHealthDigestHistoryEnabled()) {
        const all = loadHealthDigestHistory()
        if (all.length > 0) {
          const newest = all[all.length - 1]
          const newestMs = Date.parse(newest.generatedAt)
          const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          for (const w of computeStatsWarnings({
            total: all.length, maxLines: MAX_HISTORY_LINES,
            sinceNewestMs: sinceNewest, staleHint: 'emergence tick',
          })) {
            items.push({
              priority: 'low', source: 'observer-history',
              code: w.code, message: w.message, suggested: ledgerCmd('history'),
            })
          }
        }
      }
    } catch { /* per-ledger fail-open */ }
  } catch { /* fail-open */ }

  // 排序:high → medium → low,同级按 source + code
  const rank: Record<ActionItemPriority, number> = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => {
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority]
    if (a.source !== b.source) return a.source < b.source ? -1 : 1
    return a.code < b.code ? -1 : 1
  })
  return items
}

function fmtTs(ts: number): string {
  if (!ts) return 'never'
  const delta = Date.now() - ts
  if (delta < 0) return 'in future'
  return `${fmtMs(delta)} ago`
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '∞'
  return n.toLocaleString()
}

// ── Ph124(2026-04-24):--json 结构化输出 ────────────
//   延续 Ph122 /evolve-audit --json 的短路模式:检测到 --json 时跳过
//   markdown 整条渲染路径,直接调用各节底层 API 生成结构化 payload。
//   每节独立 try/catch 失败降级为 null,最终 JSON 依然有效。

function parseJsonFlag(args: string): boolean {
  if (!args) return false
  return /--json(\b|=|\s|$)/.test(args)
}

async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

// Ph139(2026-04-24):stats warnings 阈值常量(与三姐妹 JSON 对齐)
//   CAP_HIGH_PCT:total/maxLines ≥ 80% → 下次 rotate 会挤掉最老条目
//   STALE_NEWEST_MS:sinceNewest > 1h → observer 停工(仅对 live-write 的 audit/health 生效)
const CAP_HIGH_PCT = 80
const STALE_NEWEST_MS = 3_600_000
type StatsWarning = { code: 'CAP_HIGH' | 'STALE_NEWEST'; message: string }

async function buildJsonPayload(): Promise<Record<string, unknown>> {
  // 每节独立 safe 包裹,任何一节异常不影响其它节输出。
  const runtimeMode = await safe(async () => {
    const { getResolvedRuntimeMode } = await import('../../utils/model/runtimeMode.js')
    return {
      mode: getResolvedRuntimeMode(),
      explicit: !!process.env.CLAUDE_CODE_RUNTIME_MODE,
    }
  }, null)

  const agentScheduler = await safe(async () => {
    const { getSchedulerState, isAdaptiveQuotaEnabled } = await import(
      '../../services/agentScheduler/index.js'
    )
    const s = getSchedulerState()
    return {
      activeSlots: s.activeSlots,
      maxSlots: s.maxSlots,
      queueDepth: s.queueDepth,
      quotaUsage: s.quotaUsage,
      adaptiveQuota: isAdaptiveQuotaEnabled(),
    }
  }, null)

  const periodicMaintenance = await safe(async () => {
    const { getPeriodicMaintenanceState } = await import(
      '../../services/periodicMaintenance/index.js'
    )
    const snap = getPeriodicMaintenanceState()
    return {
      running: snap.running,
      projectDir: snap.projectDir ?? null,
      taskCount: snap.tasks.length,
      tasks: snap.tasks.map((t: { name: string; tickCount: number; inFlight: boolean; lastError: string | null }) => ({
        name: t.name,
        tickCount: t.tickCount,
        inFlight: t.inFlight,
        lastError: t.lastError ?? null,
      })),
    }
  }, null)

  // Ph117 trend:最近 30 条 audit + anomaly 汇总
  const trend = await safe(async () => {
    const [{ loadBackpressureAudit }, { loadAnomalyHistory }] = await Promise.all([
      import('../../services/autoEvolve/arena/backpressureAudit.js'),
      import('../../services/autoEvolve/arena/anomalyHistory.js'),
    ])
    const N = 30
    const auditAll = loadBackpressureAudit()
    const audit = auditAll.slice(-N)
    const auditDist = { observe: 0, 'env-on': 0, 'env-off': 0, 'auto-gate': 0 }
    for (const e of audit) {
      if (e.decision in auditDist) auditDist[e.decision as keyof typeof auditDist]++
    }
    const anomAll = loadAnomalyHistory()
    const anom = anomAll.slice(-N)
    const anomDist = { SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0 }
    for (const entry of anom) {
      for (const a of entry.anomalies ?? []) {
        if (a.kind in anomDist) anomDist[a.kind as keyof typeof anomDist]++
      }
    }
    return {
      audit: { totalAll: auditAll.length, sample: audit.length, distribution: auditDist },
      anomaly: { totalAll: anomAll.length, sample: anom.length, distribution: anomDist },
    }
  }, null)

  // Ph121 自适应阈值快照
  const adaptiveThresholds = await safe(async () => {
    const { loadAdaptiveThresholds, isAdaptiveThresholdEnabled } = await import(
      '../../services/autoEvolve/arena/adaptiveThresholds.js'
    )
    const state = loadAdaptiveThresholds()
    const thresholds: Record<string, { value: number; recentPileups24h: number }> = {}
    for (const [k, v] of Object.entries(state.thresholds ?? {})) {
      thresholds[k] = {
        value: (v as { value: number }).value,
        recentPileups24h: (v as { recentPileups24h: number }).recentPileups24h,
      }
    }
    return {
      enabled: isAdaptiveThresholdEnabled(),
      updatedAt: state.updatedAt ?? null,
      thresholds,
    }
  }, null)

  // Ph99 contract health 三层
  const contractHealth = await safe(async () => {
    const { getAdvisoryMiningDiagnostics } = await import(
      '../../services/autoEvolve/emergence/patternMiner.js'
    )
    const fm = getAdvisoryMiningDiagnostics({ topN: 0 }).fusionMapping
    const l1 = fm.orphanContractCategories.length === 0 && fm.missingContractCategories.length === 0
    const l2 = fm.unmappedWithEntity === 0
    const l3 = fm.undeclaredEmittedCategories.length === 0
    return { l1, l2, l3, passCount: [l1, l2, l3].filter(Boolean).length }
  }, null)

  // Ph130(2026-04-24):上次 Health Digest 新鲜度 + 关键指标快照
  //   - 读磁盘(只读),不触发 digest 生成 —— 要看"上次 tick 落盘的状态"。
  //   - 缺/损/env=off 三态都走 null + reason,保证 JSON 永远可解析。
  //   - ageMs 是客户端算,方便 JSON 消费方做阈值告警(例如 >1h 未更新提醒)。
  const lastHealthDigest = await safe(async () => {
    const { loadHealthDigest, isHealthDigestEnabled } = await import(
      '../../services/autoEvolve/arena/healthDigest.js'
    )
    if (!isHealthDigestEnabled()) return { digest: null, reason: 'disabled' }
    const d = loadHealthDigest()
    if (!d) return { digest: null, reason: 'missing' }
    const ageMs = Date.now() - Date.parse(d.generatedAt)
    // adaptive tally:紧/松/默认
    let tight = 0, relax = 0, def = 0
    if (d.adaptiveThresholds?.enabled) {
      for (const v of Object.values(d.adaptiveThresholds.thresholds ?? {})) {
        if (v.value < 3) tight++
        else if (v.value > 3) relax++
        else def++
      }
    }
    return {
      generatedAt: d.generatedAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      audit: d.audit ? { totalAll: d.audit.totalAll, sample: d.audit.sample } : null,
      anomaly: d.anomaly ? { totalAll: d.anomaly.totalAll, sample: d.anomaly.sample } : null,
      contract: d.contractHealth ? { passCount: d.contractHealth.passCount } : null,
      adaptive: { tightened: tight, relaxed: relax, default: def },
    }
  }, null)

  // Ph134(2026-04-24):历史 ndjson 容量/新鲜度摘要
  //   目的:让监控能检测 "digest pipeline 卡死"(history 半小时没长)或 "容量临爆"。
  //   只读 load,不触发 append/rotate。env=off 或空文件 → 结构化 reason。
  //   Ph139:新增 warnings[] 数组(与三姐妹 JSON 对齐):capPct≥80→CAP_HIGH;
  //         sinceNewest>1h→STALE_NEWEST(emergence tick 卡住)。
  const historyStats = await safe(async () => {
    const { loadHealthDigestHistory, isHealthDigestHistoryEnabled,
      MAX_HISTORY_LINES, getHistoryTtlDays } = await import(
      '../../services/autoEvolve/arena/healthDigest.js'
    )
    if (!isHealthDigestHistoryEnabled()) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        ttlDays: getHistoryTtlDays(), maxLines: MAX_HISTORY_LINES,
        enabled: false,
        warnings: [],
        reason: 'disabled',
      }
    }
    const all = loadHealthDigestHistory()
    if (all.length === 0) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        ttlDays: getHistoryTtlDays(), maxLines: MAX_HISTORY_LINES,
        enabled: true,
        warnings: [],
        reason: 'empty',
      }
    }
    const oldest = all[0]
    const newest = all[all.length - 1]
    const oldestMs = Date.parse(oldest.generatedAt)
    const newestMs = Date.parse(newest.generatedAt)
    const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
    const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
    // Ph140(2026-04-24):warnings 统一调 computeStatsWarnings(取整 capPct,staleHint='emergence tick')。
    const warnings = computeStatsWarnings({
      total: all.length, maxLines: MAX_HISTORY_LINES,
      sinceNewestMs: sinceNewest, staleHint: 'emergence tick',
    })
    return {
      total: all.length,
      oldestAt: oldest.generatedAt,
      newestAt: newest.generatedAt,
      ageSpanMs: span,
      sinceNewestMs: sinceNewest,
      ttlDays: getHistoryTtlDays(),
      maxLines: MAX_HISTORY_LINES,
      enabled: true,
      warnings,
    }
  }, null)

  // Ph137(2026-04-24):backpressure audit ndjson 容量/新鲜度摘要
  //   mirror Ph134 historyStats:让监控一眼看 audit 堆积 / 背压观察停工。
  //   audit 是 live-write(每 tick 一行),sinceNewest>1h 代表 observer 卡住。
  const auditStats = await safe(async () => {
    const { loadBackpressureAudit, MAX_AUDIT_LINES } = await import(
      '../../services/autoEvolve/arena/backpressureAudit.js'
    )
    const all = loadBackpressureAudit()
    if (all.length === 0) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        maxLines: MAX_AUDIT_LINES,
        warnings: [],
        reason: 'empty',
      }
    }
    const oldest = all[0]
    const newest = all[all.length - 1]
    const oldestMs = Date.parse(oldest.ts)
    const newestMs = Date.parse(newest.ts)
    const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
    const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
    // Ph140:warnings 统一调 computeStatsWarnings(staleHint='backpressure observer')。
    const warnings = computeStatsWarnings({
      total: all.length, maxLines: MAX_AUDIT_LINES,
      sinceNewestMs: sinceNewest, staleHint: 'backpressure observer',
    })
    return {
      total: all.length,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      ageSpanMs: span,
      sinceNewestMs: sinceNewest,
      maxLines: MAX_AUDIT_LINES,
      warnings,
    }
  }, null)

  // Ph137:anomaly-history ndjson 容量/新鲜度摘要
  //   与 audit 相比语义差异:anomaly 只在 anomalies 非空时写,"空窗期"= 系统健康
  //   所以 sinceNewest 不是告警信号(只暴露数据,渲染层不加 ⚠️);capPct 仍告警。
  const anomalyStats = await safe(async () => {
    const { loadAnomalyHistory, MAX_ANOMALY_LINES } = await import(
      '../../services/autoEvolve/arena/anomalyHistory.js'
    )
    const all = loadAnomalyHistory()
    if (all.length === 0) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        maxLines: MAX_ANOMALY_LINES,
        warnings: [],
        reason: 'empty',
      }
    }
    const oldest = all[0]
    const newest = all[all.length - 1]
    const oldestMs = Date.parse(oldest.ts)
    const newestMs = Date.parse(newest.ts)
    const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
    const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
    // Ph140:warnings 统一调 computeStatsWarnings(staleHint=null → anomaly 空窗=健康,不告 STALE_NEWEST)。
    const warnings = computeStatsWarnings({
      total: all.length, maxLines: MAX_ANOMALY_LINES,
      sinceNewestMs: sinceNewest, staleHint: null,
    })
    return {
      total: all.length,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      ageSpanMs: span,
      sinceNewestMs: sinceNewest,
      maxLines: MAX_ANOMALY_LINES,
      warnings,
    }
  }, null)

  // Phase 143(2026-04-24):observer-warnings-history ndjson 容量+新鲜度摘要。
  //   Ph142 已让 emergence tick 把聚合告警落盘(total>0 才写,空窗=健康),
  //   Ph143 把"告警历史"本身也纳入三姐妹 stats 体系,同时做两件 Ph143 独有的事:
  //     1. byLedger: 累计各 ledger 贡献的告警总次数(跨所有 tick)
  //     2. byCode: 累计各 CODE(CAP_HIGH/STALE_NEWEST)出现次数
  //   这让 "哪种告警最顽固 / 哪个 ledger 最脏" 一眼看到。staleHint=null 沿用
  //   anomaly 哲学(Ph142 只在 total>0 写,空窗期等同于健康)。
  const observerWarningsHistoryStats = await safe(async () => {
    const { loadObserverWarningsHistory, MAX_OBSERVER_WARNINGS_LINES, getObserverHistoryTtlDays } = await import(
      '../../services/autoEvolve/arena/observerWarningsHistory.js'
    )
    const ttlDays = getObserverHistoryTtlDays()
    const all = loadObserverWarningsHistory()
    if (all.length === 0) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        maxLines: MAX_OBSERVER_WARNINGS_LINES,
        ttlDays,
        byLedger: { audit: 0, anomaly: 0, history: 0 },
        byCode: {} as Record<string, number>,
        warnings: [],
        reason: 'empty',
      }
    }
    const oldest = all[0]!
    const newest = all[all.length - 1]!
    const oldestMs = Date.parse(oldest.ts)
    const newestMs = Date.parse(newest.ts)
    const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs) ? newestMs - oldestMs : null
    const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
    // 跨全 history 聚合 byLedger / byCode —— Ph143 独有输出
    const byLedger: Record<string, number> = { audit: 0, anomaly: 0, history: 0 }
    const byCode: Record<string, number> = {}
    for (const entry of all) {
      const items = Array.isArray(entry.items) ? entry.items : []
      for (const it of items) {
        if (it && typeof it.ledger === 'string') {
          byLedger[it.ledger] = (byLedger[it.ledger] ?? 0) + 1
        }
        if (it && typeof it.code === 'string') {
          byCode[it.code] = (byCode[it.code] ?? 0) + 1
        }
      }
    }
    // 容量/新鲜度本身的告警(staleHint=null:Ph142 空窗=健康,不告 STALE_NEWEST)
    const warnings = computeStatsWarnings({
      total: all.length, maxLines: MAX_OBSERVER_WARNINGS_LINES,
      sinceNewestMs: sinceNewest, staleHint: null,
    })
    return {
      total: all.length,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      ageSpanMs: span,
      sinceNewestMs: sinceNewest,
      maxLines: MAX_OBSERVER_WARNINGS_LINES,
      ttlDays,
      byLedger,
      byCode,
      warnings,
    }
  }, null)

  // Ph141(2026-04-24):Observer Warnings Summary —— 三 ledger(audit/anomaly/history)
  //   的 warnings 聚合视图。让监控一次看到所有阈值告警,不用逐 stats 块扫 ⚠️。
  //   - total:总告警数;byLedger:每 ledger 计数(fail-open 时缺失的 ledger 不计入)
  //   - items:打平后的告警条目(ledger + code + message),markdown/消费方直接渲染
  //   - stats=null(fail-open)时对应 ledger 跳过,不影响其它 ledger 的告警
  const observerWarnings = (() => {
    type LedgerName = 'audit' | 'anomaly' | 'history'
    const items: Array<{ ledger: LedgerName; code: string; message: string }> = []
    const byLedger: Record<LedgerName, number> = { audit: 0, anomaly: 0, history: 0 }
    const pushFrom = (ledger: LedgerName, stats: { warnings?: unknown } | null) => {
      if (!stats) return
      const ws = Array.isArray(stats.warnings) ? stats.warnings : []
      for (const w of ws) {
        const obj = w as { code?: unknown; message?: unknown }
        if (typeof obj.code === 'string' && typeof obj.message === 'string') {
          items.push({ ledger, code: obj.code, message: obj.message })
          byLedger[ledger] += 1
        }
      }
    }
    pushFrom('audit', auditStats as { warnings?: unknown } | null)
    pushFrom('anomaly', anomalyStats as { warnings?: unknown } | null)
    pushFrom('history', historyStats as { warnings?: unknown } | null)
    return {
      total: items.length,
      byLedger,
      items,
    }
  })()

  // Ph147(2026-04-24):actionItems —— "下一步要做什么"汇总(high/medium/low),
  //   复用 Ph141 的 observer 告警 + 契约三层 + healthDigest 陈旧度,每条附 suggested 命令
  // Ph150(2026-04-24):同时用 action-items-history 算 persistent/streakTicks/daysSpan 标签。
  //   enrichActionItemsWithPersistence fail-open,历史不可读时原样返回(无 persistent 字段)。
  const rawActionItems = await safe(() => collectActionItems(), [])
  const actionItems = await safe(() => enrichActionItemsWithPersistence(rawActionItems), rawActionItems)

  // Ph148(2026-04-24):actionItemsHistoryStats —— Ph148 落盘消费端
  //   total/oldestAt/newestAt/ageSpanMs/sinceNewestMs/maxLines/ttlDays/enabled
  //   /byPriority(high/medium/low)/bySource(Record)/warnings(单源 stats)。
  //   enabled=false(env=off)且 total=0 → reason='disabled'
  const actionItemsHistoryStats = await safe(async () => {
    const {
      loadActionItemsHistory, MAX_ACTION_ITEMS_HISTORY_LINES,
      getActionItemsHistoryTtlDays, isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    const ttlDays = getActionItemsHistoryTtlDays()
    const enabled = isActionItemsHistoryEnabled()
    const all = loadActionItemsHistory()
    if (all.length === 0) {
      return {
        total: 0, oldestAt: null, newestAt: null,
        ageSpanMs: null, sinceNewestMs: null,
        maxLines: MAX_ACTION_ITEMS_HISTORY_LINES,
        ttlDays,
        enabled,
        byPriority: { high: 0, medium: 0, low: 0 },
        bySource: {} as Record<string, number>,
        warnings: [],
        reason: enabled ? 'empty' : 'disabled',
      }
    }
    const oldest = all[0]!
    const newest = all[all.length - 1]!
    const oldestMs = Date.parse(oldest.ts)
    const newestMs = Date.parse(newest.ts)
    const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
      ? newestMs - oldestMs : null
    const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
    const byPriority: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 }
    const bySource: Record<string, number> = {}
    for (const entry of all) {
      const items = Array.isArray(entry.items) ? entry.items : []
      for (const it of items) {
        if (it && (it.priority === 'high' || it.priority === 'medium' || it.priority === 'low')) {
          byPriority[it.priority] += 1
        }
        if (it && typeof it.source === 'string') {
          bySource[it.source] = (bySource[it.source] ?? 0) + 1
        }
      }
    }
    const warnings = computeStatsWarnings({
      total: all.length, maxLines: MAX_ACTION_ITEMS_HISTORY_LINES,
      sinceNewestMs: sinceNewest, staleHint: null,
    })
    return {
      total: all.length,
      oldestAt: oldest.ts,
      newestAt: newest.ts,
      ageSpanMs: span,
      sinceNewestMs: sinceNewest,
      maxLines: MAX_ACTION_ITEMS_HISTORY_LINES,
      ttlDays,
      enabled,
      byPriority,
      bySource,
      warnings,
    }
  }, null)

  // Ph155(2026-04-24):MTTR Warnings —— 镜像 Ph154 triage Section 8。
  //   在 signal→decision 通路上,把 computeMttrWarnings 暴露给 kernel-status。
  //   fail-open:load/compute 任一异常 → 空数组(不阻塞)。
  //   env off:isActionItemsHistoryEnabled=false → []。
  const mttrWarnings = await safe(async () => {
    const {
      loadActionItemsHistory, computeMttrWarnings, isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (!isActionItemsHistoryEnabled()) return []
    const entries = loadActionItemsHistory()
    return computeMttrWarnings(entries.map(e => ({ ts: e.ts, items: e.items })))
  }, [])
  const mttrWarningThresholds = await safe(async () => {
    const { getMttrWarningThresholds } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    return getMttrWarningThresholds()
  }, { openTooLongMs: 24 * 3600_000 })

  // Ph157(2026-04-24):Warning Delta —— emerged/resolved since last tick。
  //   复用 action-items-history;无新 ledger。为降噪,env off 或 <2 条 → 空。
  const mttrWarningsDelta = await safe(async () => {
    const {
      loadActionItemsHistory, computeWarningDelta, isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (!isActionItemsHistoryEnabled()) return { emerged: [], resolved: [] }
    const entries = loadActionItemsHistory()
    return computeWarningDelta(entries.map(e => ({ ts: e.ts, items: e.items })))
  }, { emerged: [], resolved: [] })

  // Ph158(2026-04-24):Warning Lifecycle —— 长期活跃统计(chronic offenders)。
  //   同样复用 action-items-history,不新建 ledger。
  const warningLifecycles = await safe(async () => {
    const {
      loadActionItemsHistory, computeWarningLifecycles, isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (!isActionItemsHistoryEnabled()) return []
    const entries = loadActionItemsHistory()
    return computeWarningLifecycles(entries.map(e => ({ ts: e.ts, items: e.items })))
  }, [])
  const warningLifecycleThresholds = await safe(async () => {
    const { getWarningLifecycleThresholds } = await import(
      '../../services/autoEvolve/arena/actionItemsHistory.js'
    )
    return getWarningLifecycleThresholds()
  }, { chronicThreshold: 3, maxWindow: 200 })

  return {
    generatedAt: new Date().toISOString(),
    runtimeMode,
    agentScheduler,
    periodicMaintenance,
    contractHealth,
    trend,
    adaptiveThresholds,
    lastHealthDigest,
    historyStats,
    auditStats,
    anomalyStats,
    observerWarningsHistoryStats,
    observerWarnings,
    actionItems,
    actionItemsHistoryStats,
    mttrWarnings,
    mttrWarningThresholds,
    mttrWarningsDelta,
    warningLifecycles,
    warningLifecycleThresholds,
  }
}

// ── 主入口 ─────────────────────────────────────────────

export const call: LocalJSXCommandCall = async (onDone, _ctx, args) => {
  // Ph124:--json 模式短路,避开 markdown 聚合整块逻辑,直接输出结构化数据
  if (parseJsonFlag(args ?? '')) {
    const payload = await buildJsonPayload()
    onDone(JSON.stringify(payload, null, 2))
    return null
  }

  const lines: string[] = ['## Kernel Status\n']

  // 0. Runtime Mode
  try {
    const { getResolvedRuntimeMode } = await import('../../utils/model/runtimeMode.js')
    const mode = getResolvedRuntimeMode()
    const explicit = process.env.CLAUDE_CODE_RUNTIME_MODE
      ? ' (via CLAUDE_CODE_RUNTIME_MODE)'
      : ' (inferred)'
    lines.push('### Runtime Mode')
    lines.push(`Current: ${mode}${explicit}`)
    lines.push('')
  } catch {
    lines.push('### Runtime Mode')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 0.1 Action Items(Ph147,2026-04-24)—— 顶部体检摘要
  //   - 把"要动手处理的事"抽成一张清单,附 priority(high/medium/low)+ 建议命令
  //   - 空 → "✅ 系统健康",避免沉默让用户怀疑命令坏了
  //   - 排序:high→medium→low,已在 collectActionItems() 内部完成
  //   - Ph150:用 enrichActionItemsWithPersistence 给每条打持久化标签,🔥 标顽固项
  //   - Ph153:叠加 Ph151 MTTR(resolved=N avgMttr=X)与 Ph152 趋势(📈/📉/◻)
  //     语义:📈 最近修得慢(degrading),📉 最近修得快(improving),◻ 稳定;unknown 不渲染
  //   - Ph156:若该 code 命中 mttrWarning(任一 kind),加 🚨 badge —— signal→decision 闭环
  try {
    const rawItems = await collectActionItems()
    const items = await enrichActionItemsWithPersistence(rawItems)
    lines.push('### Action Items (Phase 147/150/151/152/156)')
    if (items.length === 0) {
      lines.push('  ✅ 系统健康 — no action items')
    } else {
      const byPrio: Record<ActionItemPriority, number> = { high: 0, medium: 0, low: 0 }
      let persistentCount = 0
      let degradingCount = 0
      let improvingCount = 0
      let escalatedCount = 0
      for (const it of items) {
        byPrio[it.priority] += 1
        if (it.persistent) persistentCount += 1
        if (it.mttrTrend === 'degrading') degradingCount += 1
        else if (it.mttrTrend === 'improving') improvingCount += 1
        if (it.escalated) escalatedCount += 1
      }
      const badge = (p: ActionItemPriority) => p === 'high' ? '🔴' : p === 'medium' ? '🟡' : '🟢'
      for (const it of items) {
        const cmd = it.suggested ? `  → ${it.suggested}` : ''
        const fire = it.persistent
          ? ` 🔥(streak=${it.streakTicks} days=${it.daysSpan})`
          : ''
        // Ph153:趋势 badge(unknown 不渲染,避免噪声)
        let trend = ''
        if (it.mttrTrend === 'degrading') trend = ' 📈'
        else if (it.mttrTrend === 'improving') trend = ' 📉'
        else if (it.mttrTrend === 'stable') trend = ' ◻'
        // Ph153:MTTR / open 信息(仅当有闭窗 or 开放窗口时)
        let mttr = ''
        const mttrBits: string[] = []
        if ((it.resolutionCount ?? 0) > 0 && it.avgMttrMs != null) {
          mttrBits.push(`resolved=${it.resolutionCount} avgMttr=${fmtMs(it.avgMttrMs)}`)
        }
        if (it.currentlyOpen && it.currentOpenDurationMs != null) {
          mttrBits.push(`open=${fmtMs(it.currentOpenDurationMs)}`)
        }
        if (mttrBits.length > 0) mttr = ` [${mttrBits.join(' ')}]`
        // Ph156:escalation 前置,和 priority badge 并列,让 🚨 在视觉上先于 🔴/🟡/🟢
        const esc = it.escalated ? `🚨 ` : ''
        lines.push(`  ${esc}${badge(it.priority)} [${it.source}] ${it.code}: ${it.message}${fire}${trend}${mttr}${cmd}`)
      }
      const parts: string[] = []
      if (byPrio.high > 0) parts.push(`high=${byPrio.high}`)
      if (byPrio.medium > 0) parts.push(`medium=${byPrio.medium}`)
      if (byPrio.low > 0) parts.push(`low=${byPrio.low}`)
      if (persistentCount > 0) parts.push(`persistent=${persistentCount} 🔥`)
      // Ph153:summary 的趋势维度 —— 只报非零,避免 stable 占位
      if (degradingCount > 0) parts.push(`degrading=${degradingCount} 📈`)
      if (improvingCount > 0) parts.push(`improving=${improvingCount} 📉`)
      // Ph156:summary 加 escalated 计数(仅非零)
      if (escalatedCount > 0) parts.push(`escalated=${escalatedCount} 🚨`)
      lines.push(`  (total: ${items.length};  ${parts.join(', ')})`)
    }
    lines.push('')
  } catch (e) {
    lines.push('### Action Items (Phase 147/150/151/152/156)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.4 Observer Warnings Summary(Ph141,2026-04-24):三 ledger(audit/anomaly/history)
  //   warnings 聚合视图,仅在 total>0 时渲染。放在 0.5 之前,让监控第一眼看到所有阈值告警,
  //   不用逐 stats section 扫 ⚠️。每条目标准化为 `[ledger] CODE: message`,便于 grep / 手动分诊。
  //   fail-open:任一 load 抛异常,该 ledger 跳过,不影响其余 ledger 的告警。
  try {
    type LedgerName = 'audit' | 'anomaly' | 'history'
    const summary: Array<{ ledger: LedgerName; code: string; message: string }> = []
    // audit
    try {
      const { loadBackpressureAudit, MAX_AUDIT_LINES } = await import(
        '../../services/autoEvolve/arena/backpressureAudit.js'
      )
      const all = loadBackpressureAudit()
      if (all.length > 0) {
        const newest = all[all.length - 1]
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        const ws = computeStatsWarnings({
          total: all.length, maxLines: MAX_AUDIT_LINES,
          sinceNewestMs: sinceNewest, staleHint: 'backpressure observer',
        })
        for (const w of ws) summary.push({ ledger: 'audit', code: w.code, message: w.message })
      }
    } catch {}
    // anomaly
    try {
      const { loadAnomalyHistory, MAX_ANOMALY_LINES } = await import(
        '../../services/autoEvolve/arena/anomalyHistory.js'
      )
      const all = loadAnomalyHistory()
      if (all.length > 0) {
        const newest = all[all.length - 1]
        const newestMs = Date.parse(newest.ts)
        const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
        const ws = computeStatsWarnings({
          total: all.length, maxLines: MAX_ANOMALY_LINES,
          sinceNewestMs: sinceNewest, staleHint: null,
        })
        for (const w of ws) summary.push({ ledger: 'anomaly', code: w.code, message: w.message })
      }
    } catch {}
    // history
    try {
      const { loadHealthDigestHistory, isHealthDigestHistoryEnabled, MAX_HISTORY_LINES } = await import(
        '../../services/autoEvolve/arena/healthDigest.js'
      )
      if (isHealthDigestHistoryEnabled()) {
        const all = loadHealthDigestHistory()
        if (all.length > 0) {
          const newest = all[all.length - 1]
          const newestMs = Date.parse(newest.generatedAt)
          const sinceNewest = Number.isFinite(newestMs) ? Date.now() - newestMs : null
          const ws = computeStatsWarnings({
            total: all.length, maxLines: MAX_HISTORY_LINES,
            sinceNewestMs: sinceNewest, staleHint: 'emergence tick',
          })
          for (const w of ws) summary.push({ ledger: 'history', code: w.code, message: w.message })
        }
      }
    } catch {}
    if (summary.length > 0) {
      lines.push('### ⚠️ Observer Warnings Summary (Phase 141)')
      const byLedger: Record<LedgerName, number> = { audit: 0, anomaly: 0, history: 0 }
      for (const it of summary) {
        lines.push(`  [${it.ledger}] ${it.code}: ${it.message}`)
        byLedger[it.ledger] += 1
      }
      const parts = (['audit', 'anomaly', 'history'] as const)
        .filter(k => byLedger[k] > 0)
        .map(k => `${k}=${byLedger[k]}`)
      lines.push(`  (total: ${summary.length} across ${parts.length} ledger${parts.length !== 1 ? 's' : ''};  ${parts.join(', ')})`)
      lines.push('')
    }
  } catch (e) {
    // 最外层 fail-open:整个 summary 段异常也不阻塞后续 Section
    lines.push('### ⚠️ Observer Warnings Summary (Phase 141)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.41 MTTR Warnings(Ph155,2026-04-24)—— 镜像 Ph154 triage Section 8。
  //   在 signal→decision 通路上,把 computeMttrWarnings 暴露给 kernel-status。
  //   3 个正交规则:STUCK_DEGRADING(high) / OPEN_TOO_LONG(medium) / REGRESSION(medium)。
  //   空 → 不渲染 section(保持 0.4 pattern,降噪);
  //   env off / load 异常 → 吞掉(fail-open),不阻塞后续 section。
  //   Ph157:若 warnings 非空,追加一行 "(since last tick: emerged=N, resolved=N)"
  //         仅在 emerged+resolved 之和 > 0 时渲染,继续保持降噪。
  try {
    const {
      loadActionItemsHistory, computeMttrWarnings, computeWarningDelta, isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (isActionItemsHistoryEnabled()) {
      const entries = loadActionItemsHistory()
      const minEntries = entries.map(e => ({ ts: e.ts, items: e.items }))
      const warnings = computeMttrWarnings(minEntries)
      if (warnings.length > 0) {
        lines.push('### ⚠️ MTTR Warnings (Phase 155/157)')
        const sevBadge = (s: 'high' | 'medium' | 'low') =>
          s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🟢'
        const byKind: Record<string, number> = {}
        for (const w of warnings) {
          byKind[w.kind] = (byKind[w.kind] ?? 0) + 1
          lines.push(`  ${sevBadge(w.severity)} [${w.kind}] ${w.code}: ${w.message}`)
        }
        const parts = Object.entries(byKind).map(([k, n]) => `${k}=${n}`)
        lines.push(`  (total: ${warnings.length};  ${parts.join(', ')})`)
        // Ph157 delta 行(降噪:emerged+resolved=0 不渲染)
        const delta = computeWarningDelta(minEntries)
        if (delta.emerged.length + delta.resolved.length > 0) {
          lines.push(`  (since last tick: emerged=${delta.emerged.length} 🆕, resolved=${delta.resolved.length} ✅)`)
        }
        lines.push('')
      }
    }
  } catch {
    // fail-open:signal→decision 层不让 warnings 计算的异常冒泡到 kernel-status 主体
  }

  // 0.42 Chronic Warnings(Ph158,2026-04-24)—— Warning Lifecycle 提示
  //   - 只渲染 chronic offenders(totalEmergences ≥ threshold,默认 3)
  //   - 空 → 不渲染(保持降噪,同 0.41 pattern)
  //   - fail-open:entries<2 或任何异常 → 静默跳过
  try {
    const {
      loadActionItemsHistory,
      computeWarningLifecycles,
      isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    if (isActionItemsHistoryEnabled()) {
      const entries = loadActionItemsHistory()
      const lifecycles = computeWarningLifecycles(
        entries.map(e => ({ ts: e.ts, items: e.items })),
      )
      const chronic = lifecycles.filter(lc => lc.isChronicOffender)
      if (chronic.length > 0) {
        lines.push('### 🔁 Chronic Warnings (Phase 158)')
        const sevBadge = (s: 'high' | 'medium' | 'low') =>
          s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🟢'
        // 限 top 10,避免 kernel-status 被噪声淹没
        for (const lc of chronic.slice(0, 10)) {
          const stillActive = lc.currentlyActive ? ' (currently active)' : ''
          lines.push(
            `  ${sevBadge(lc.severity)} [${lc.kind}] ${lc.code}: emergences=${lc.totalEmergences} activeTicks=${lc.totalActiveTicks}${stillActive}`,
          )
        }
        const activeNow = chronic.filter(lc => lc.currentlyActive).length
        lines.push(`  (total chronic: ${chronic.length}; currently active: ${activeNow})`)
        lines.push('')
      }
    }
  } catch {
    // fail-open
  }

  // 0.5 Health Digest(Ph130,2026-04-24):跨模块健康快照的新鲜度窗口
  //   - 放在 Runtime Mode 之后、Agent Scheduler 之前 —— 让用户一眼看到
  //     "上一次后台 tick 落盘的健康状态是什么时候 + 长什么样"。
  //   - 不触发生成,只读磁盘 —— 不把 kernel-status 变成写入 hook。
  //   - 缺/损/off 三态都走友好提示,不打断后续段落。
  try {
    const { loadHealthDigest, isHealthDigestEnabled } = await import(
      '../../services/autoEvolve/arena/healthDigest.js'
    )
    lines.push('### Health Digest (Phase 123)')
    if (!isHealthDigestEnabled()) {
      lines.push(
        '  (disabled — CLAUDE_EVOLVE_HEALTH_DIGEST=off; no periodic writer active)',
      )
    } else {
      const d = loadHealthDigest()
      if (!d) {
        lines.push(
          '  (no digest yet — emergence tick has not written one; try `/evolve-tick`)',
        )
      } else {
        const age = Date.now() - Date.parse(d.generatedAt)
        const rel = Number.isFinite(age) && age >= 0 ? fmtMs(age) + ' ago' : 'unknown age'
        lines.push(`  Last snapshot: ${rel} @ ${d.generatedAt}`)
        const auditCell = d.audit
          ? `audit=${d.audit.totalAll}(sample ${d.audit.sample})`
          : 'audit=(n/a)'
        const anomCell = d.anomaly
          ? `anomaly=${d.anomaly.totalAll}(sample ${d.anomaly.sample})`
          : 'anomaly=(n/a)'
        const c = d.contractHealth
        const contractCell = c
          ? `contract=${c.l1 ? '✓' : '✗'}${c.l2 ? '✓' : '✗'}${c.l3 ? '✓' : '✗'}(${c.passCount}/3)`
          : 'contract=(n/a)'
        // adaptive tally
        let tight = 0, relax = 0, def = 0
        if (d.adaptiveThresholds?.enabled) {
          for (const v of Object.values(d.adaptiveThresholds.thresholds ?? {})) {
            if (v.value < 3) tight++
            else if (v.value > 3) relax++
            else def++
          }
        }
        const adaptCell = `adaptive=${tight}🔒/${relax}🔓/${def}⏸`
        lines.push(`  ${auditCell}  ${anomCell}  ${contractCell}  ${adaptCell}`)
        lines.push('  (run `/evolve-health` for full detail, `/evolve-health --history` for timeline)')
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Health Digest (Phase 123)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.6 Health Digest History(Ph134,2026-04-24):history ndjson 容量+新鲜度
  //   帮助运维一眼看:"pipeline 是否卡住"(sinceNewest 大)+ "容量是否临爆"。
  //   - 无历史 → 友好提示;env=off → 展示 disabled
  //   - 否则:total / oldest / newest(相对时间)/ span / ttl / max
  try {
    const { loadHealthDigestHistory, isHealthDigestHistoryEnabled,
      MAX_HISTORY_LINES, getHistoryTtlDays } = await import(
      '../../services/autoEvolve/arena/healthDigest.js'
    )
    lines.push('### Health Digest History (Phase 127/134)')
    if (!isHealthDigestHistoryEnabled()) {
      lines.push('  (disabled — CLAUDE_EVOLVE_HEALTH_HISTORY=off; history writer inactive)')
    } else {
      const all = loadHealthDigestHistory()
      const ttlDays = getHistoryTtlDays()
      if (all.length === 0) {
        lines.push(`  (empty — no history entries;ttl=${ttlDays}d  max=${MAX_HISTORY_LINES} lines)`)
      } else {
        const oldest = all[0]
        const newest = all[all.length - 1]
        const oldestMs = Date.parse(oldest.generatedAt)
        const newestMs = Date.parse(newest.generatedAt)
        const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
          ? fmtMs(newestMs - oldestMs) : 'n/a'
        const sinceNewest = Number.isFinite(newestMs)
          ? fmtMs(Date.now() - newestMs) + ' ago' : 'n/a'
        lines.push(
          `  total=${all.length}/${MAX_HISTORY_LINES}  ttl=${ttlDays === 0 ? 'off' : ttlDays + 'd'}  span=${span}  newest=${sinceNewest}  oldest=${fmtMs(Date.now() - (Number.isFinite(oldestMs) ? oldestMs : Date.now()))} ago`,
        )
        // Ph140(2026-04-24):markdown 消费 computeStatsWarnings 的单源输出,与 JSON auditStats/historyStats.warnings 文案完全一致。
        //   原独立 capPct / sinceNewest ⚠️ 计算保留数据,但判定走 helper(单源)。
        const _w = computeStatsWarnings({
          total: all.length, maxLines: MAX_HISTORY_LINES,
          sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
          staleHint: 'emergence tick',
        })
        for (const wline of formatWarningsMarkdown(_w)) {
          lines.push(wline)
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Health Digest History (Phase 127/134)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.7 Backpressure Audit Stats(Ph137,2026-04-24)——audit ndjson 容量+新鲜度
  //   与 Section 0.6 同构,告警条件:capPct≥80% + sinceNewest>1h(后者代表
  //   背压 observer 卡住,audit 是 live-write 每 tick 一行)。
  try {
    const { loadBackpressureAudit, MAX_AUDIT_LINES } = await import(
      '../../services/autoEvolve/arena/backpressureAudit.js'
    )
    lines.push('### Backpressure Audit Stats (Phase 113/137)')
    const all = loadBackpressureAudit()
    if (all.length === 0) {
      lines.push(`  (empty — no audit entries;max=${MAX_AUDIT_LINES} lines)`)
    } else {
      const oldest = all[0]
      const newest = all[all.length - 1]
      const oldestMs = Date.parse(oldest.ts)
      const newestMs = Date.parse(newest.ts)
      const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
        ? fmtMs(newestMs - oldestMs) : 'n/a'
      const sinceNewest = Number.isFinite(newestMs)
        ? fmtMs(Date.now() - newestMs) + ' ago' : 'n/a'
      lines.push(
        `  total=${all.length}/${MAX_AUDIT_LINES}  span=${span}  newest=${sinceNewest}  oldest=${fmtMs(Date.now() - (Number.isFinite(oldestMs) ? oldestMs : Date.now()))} ago`,
      )
      // Ph140:单源 warnings(staleHint='backpressure observer')
      const _w = computeStatsWarnings({
        total: all.length, maxLines: MAX_AUDIT_LINES,
        sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
        staleHint: 'backpressure observer',
      })
      for (const wline of formatWarningsMarkdown(_w)) {
        lines.push(wline)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Backpressure Audit Stats (Phase 113/137)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.8 Anomaly History Stats(Ph137)—— anomaly ndjson 容量+新鲜度
  //   与 audit 的关键差异:anomaly 只在 anomalies 非空时 append,空窗期 = 系统健康,
  //   所以 sinceNewest 不做 ⚠️(反而应视为好事),只暴露数据;capPct 仍告警。
  try {
    const { loadAnomalyHistory, MAX_ANOMALY_LINES } = await import(
      '../../services/autoEvolve/arena/anomalyHistory.js'
    )
    lines.push('### Anomaly History Stats (Phase 115/137)')
    const all = loadAnomalyHistory()
    if (all.length === 0) {
      lines.push(`  (empty — no anomaly entries yet;max=${MAX_ANOMALY_LINES} lines)`)
    } else {
      const oldest = all[0]
      const newest = all[all.length - 1]
      const oldestMs = Date.parse(oldest.ts)
      const newestMs = Date.parse(newest.ts)
      const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
        ? fmtMs(newestMs - oldestMs) : 'n/a'
      const sinceNewest = Number.isFinite(newestMs)
        ? fmtMs(Date.now() - newestMs) + ' ago' : 'n/a'
      lines.push(
        `  total=${all.length}/${MAX_ANOMALY_LINES}  span=${span}  newest=${sinceNewest}  oldest=${fmtMs(Date.now() - (Number.isFinite(oldestMs) ? oldestMs : Date.now()))} ago`,
      )
      // Ph140:单源 warnings(staleHint=null → anomaly 空窗=健康,不告 STALE_NEWEST)
      const _w = computeStatsWarnings({
        total: all.length, maxLines: MAX_ANOMALY_LINES,
        sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
        staleHint: null,
      })
      for (const wline of formatWarningsMarkdown(_w)) {
        lines.push(wline)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Anomaly History Stats (Phase 115/137)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.9 Observer Warnings History Stats(Ph143,2026-04-24)—— Ph142 落盘消费端。
  //   与 0.6/0.7/0.8 同构的 total/span/newest/max 基础行,加一条 byLedger 频率行
  //   和一条 byCode 频率行(Ph143 独有:让 "哪个 ledger 最脏 / 哪种 CODE 最顽固"
  //   在 markdown 一眼可见)。告警走同一套 computeStatsWarnings(staleHint=null)。
  //   Ph146(2026-04-24):展示 ttl(天数或 'off'),与 0.6 Health Digest History 对齐。
  try {
    const { loadObserverWarningsHistory, MAX_OBSERVER_WARNINGS_LINES, getObserverHistoryTtlDays } = await import(
      '../../services/autoEvolve/arena/observerWarningsHistory.js'
    )
    lines.push('### Observer Warnings History Stats (Phase 142/143/146)')
    const ttlDays = getObserverHistoryTtlDays()
    const ttlStr = ttlDays === 0 ? 'off' : `${ttlDays}d`
    const all = loadObserverWarningsHistory()
    if (all.length === 0) {
      lines.push(`  (empty — no observer warnings entries yet;ttl=${ttlStr}  max=${MAX_OBSERVER_WARNINGS_LINES} lines;空窗=健康)`)
    } else {
      const oldest = all[0]!
      const newest = all[all.length - 1]!
      const oldestMs = Date.parse(oldest.ts)
      const newestMs = Date.parse(newest.ts)
      const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
        ? fmtMs(newestMs - oldestMs) : 'n/a'
      const sinceNewest = Number.isFinite(newestMs)
        ? fmtMs(Date.now() - newestMs) + ' ago' : 'n/a'
      lines.push(
        `  total=${all.length}/${MAX_OBSERVER_WARNINGS_LINES}  ttl=${ttlStr}  span=${span}  newest=${sinceNewest}  oldest=${fmtMs(Date.now() - (Number.isFinite(oldestMs) ? oldestMs : Date.now()))} ago`,
      )
      // Ph143 独有:累计 byLedger / byCode,展示告警分布。
      const byLedger: Record<string, number> = { audit: 0, anomaly: 0, history: 0 }
      const byCode: Record<string, number> = {}
      for (const entry of all) {
        const items = Array.isArray(entry.items) ? entry.items : []
        for (const it of items) {
          if (it && typeof it.ledger === 'string') {
            byLedger[it.ledger] = (byLedger[it.ledger] ?? 0) + 1
          }
          if (it && typeof it.code === 'string') {
            byCode[it.code] = (byCode[it.code] ?? 0) + 1
          }
        }
      }
      const ledgerParts = (['audit', 'anomaly', 'history'] as const).map(
        k => `${k}=${byLedger[k] ?? 0}`,
      )
      lines.push(`  byLedger: ${ledgerParts.join(', ')}`)
      const codeKeys = Object.keys(byCode).sort()
      if (codeKeys.length > 0) {
        const codeParts = codeKeys.map(k => `${k}=${byCode[k]}`)
        lines.push(`  byCode: ${codeParts.join(', ')}`)
      }
      // Ph140 单源 warnings(staleHint=null)
      const _w = computeStatsWarnings({
        total: all.length, maxLines: MAX_OBSERVER_WARNINGS_LINES,
        sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
        staleHint: null,
      })
      for (const wline of formatWarningsMarkdown(_w)) {
        lines.push(wline)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Observer Warnings History Stats (Phase 142/143/146)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 0.10 Action Items History Stats(Ph148,2026-04-24)—— Ph147 落盘消费端。
  //   复用与 0.9 Observer 完全同构的 total/span/newest/max/ttl 行,再加一条
  //   byPriority(high/medium/low 频率)+ bySource(按来源分布)。告警也复用
  //   computeStatsWarnings(staleHint=null:空窗=健康)。env=off 时不写,展示
  //   为 "(disabled)" 或"(empty)"取决于实际磁盘存在。
  try {
    const {
      loadActionItemsHistory,
      MAX_ACTION_ITEMS_HISTORY_LINES,
      getActionItemsHistoryTtlDays,
      isActionItemsHistoryEnabled,
    } = await import('../../services/autoEvolve/arena/actionItemsHistory.js')
    lines.push('### Action Items History Stats (Phase 148)')
    const ttlDays = getActionItemsHistoryTtlDays()
    const ttlStr = ttlDays === 0 ? 'off' : `${ttlDays}d`
    const enabled = isActionItemsHistoryEnabled()
    const all = loadActionItemsHistory()
    if (!enabled && all.length === 0) {
      lines.push(`  (disabled — CLAUDE_EVOLVE_ACTION_ITEMS_HISTORY=off;no new entries written)`)
    } else if (all.length === 0) {
      lines.push(`  (empty — no action items entries yet;ttl=${ttlStr}  max=${MAX_ACTION_ITEMS_HISTORY_LINES} lines;空窗=健康)`)
    } else {
      const oldest = all[0]!
      const newest = all[all.length - 1]!
      const oldestMs = Date.parse(oldest.ts)
      const newestMs = Date.parse(newest.ts)
      const span = Number.isFinite(oldestMs) && Number.isFinite(newestMs)
        ? fmtMs(newestMs - oldestMs) : 'n/a'
      const sinceNewest = Number.isFinite(newestMs)
        ? fmtMs(Date.now() - newestMs) + ' ago' : 'n/a'
      lines.push(
        `  total=${all.length}/${MAX_ACTION_ITEMS_HISTORY_LINES}  ttl=${ttlStr}  span=${span}  newest=${sinceNewest}  oldest=${fmtMs(Date.now() - (Number.isFinite(oldestMs) ? oldestMs : Date.now()))} ago`,
      )
      // 累计 byPriority / bySource
      const byPriority: Record<'high' | 'medium' | 'low', number> = { high: 0, medium: 0, low: 0 }
      const bySource: Record<string, number> = {}
      for (const entry of all) {
        const items = Array.isArray(entry.items) ? entry.items : []
        for (const it of items) {
          if (it && (it.priority === 'high' || it.priority === 'medium' || it.priority === 'low')) {
            byPriority[it.priority] += 1
          }
          if (it && typeof it.source === 'string') {
            bySource[it.source] = (bySource[it.source] ?? 0) + 1
          }
        }
      }
      const prioParts = (['high', 'medium', 'low'] as const).map(
        k => `${k}=${byPriority[k]}`,
      )
      lines.push(`  byPriority: ${prioParts.join(', ')}`)
      const srcKeys = Object.keys(bySource).sort()
      if (srcKeys.length > 0) {
        const srcParts = srcKeys.map(k => `${k}=${bySource[k]}`)
        lines.push(`  bySource: ${srcParts.join(', ')}`)
      }
      // 单源 warnings(staleHint=null:空窗=健康)
      const _w = computeStatsWarnings({
        total: all.length, maxLines: MAX_ACTION_ITEMS_HISTORY_LINES,
        sinceNewestMs: Number.isFinite(newestMs) ? Date.now() - newestMs : null,
        staleHint: null,
      })
      for (const wline of formatWarningsMarkdown(_w)) {
        lines.push(wline)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Action Items History Stats (Phase 148)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 1. Agent Scheduler —— 最重要,放前面
  try {
    const { getSchedulerState, isAdaptiveQuotaEnabled } = await import(
      '../../services/agentScheduler/index.js'
    )
    const s = getSchedulerState()
    lines.push('### Agent Scheduler')
    lines.push(`Slots: ${s.activeSlots} / ${s.maxSlots} active  |  Queue depth: ${s.queueDepth}`)
    const quotaParts = Object.entries(s.quotaUsage).map(
      ([k, v]) => `${k}=${v}`,
    )
    lines.push(`Quota usage: ${quotaParts.join(', ') || '(none)'}`)
    lines.push(`Adaptive quota: ${isAdaptiveQuotaEnabled() ? 'on' : 'off'} (CLAUDE_CODE_ADAPTIVE_QUOTA)`)
    lines.push('')
  } catch (e) {
    lines.push('### Agent Scheduler')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2. Periodic Maintenance —— 本批次新基建,展示所有周期任务
  try {
    const { getPeriodicMaintenanceState } = await import(
      '../../services/periodicMaintenance/index.js'
    )
    const snap = getPeriodicMaintenanceState()
    lines.push('### Periodic Maintenance')
    lines.push(
      `Running: ${snap.running}  |  Project dir: ${snap.projectDir ?? '(none)'}  |  Tasks: ${snap.tasks.length}`,
    )
    if (snap.tasks.length === 0) {
      lines.push('(no tasks registered)')
    } else {
      for (const t of snap.tasks) {
        const state =
          !t.running ? 'stopped' :
          t.tickInFlight ? 'running(inflight)' :
          !t.enabledSnapshot ? 'idle(disabled)' : 'idle'
        const err = t.lastErrorMessage ? `  err: ${t.lastErrorMessage}` : ''
        lines.push(
          `  ${t.name.padEnd(36)} every ${fmtMs(t.intervalMs).padEnd(6)}  ticks=${String(t.tickCount).padEnd(4)} last=${fmtTs(t.lastTickAt).padEnd(10)} ${state}${err}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Periodic Maintenance')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2.5 Emergence Tick(Phase 48/102):agentScheduler 的 30min 后台 tick 产出
  //   之前只在 debug log 出现,periodic maintenance 行只显示 ticks/last 不显示
  //   "产出"。此段暴露:上一次 tick 的 mined/effective/compiled/outcome 四元组,
  //   以及累计 compiled 数。让用户一眼看到 shadow organism 是不是还在生成。
  //   独立 try:尚未注册或 import 失败都不阻断后续节。
  try {
    const { getEmergenceTickStats } = await import(
      '../../services/agentScheduler/background.js'
    )
    const s = getEmergenceTickStats()
    lines.push('### Emergence Tick (Phase 48/102)')
    if (!s.everRan) {
      // never: 进程内还没跑过 —— 可能是 CLAUDE_EVOLVE != 'on',或刚启动未满 30min
      lines.push(
        '(never ran yet — 可能 CLAUDE_EVOLVE 未开启,或进程刚启动不到 30min)',
      )
    } else {
      const outcomeMark =
        s.lastOutcome === 'compiled'
          ? '✅ compiled'
          : s.lastOutcome === 'idle'
            ? '⏸ idle'
            : s.lastOutcome === 'failed'
              ? '❌ failed'
              : '— never'
      // 时间截到 16 字符(YYYY-MM-DDTHH:MM)
      const last = (s.lastTickAt || '').slice(0, 16)
      lines.push(
        `total ticks=${s.totalTicks}  cumulative compiled=${s.cumulativeCompiled}  last=${last}  outcome=${outcomeMark}`,
      )
      lines.push(
        `last run: mined=${s.lastTotalMined}  effective=${s.lastEffectiveCandidates}  compiled=${s.lastCompiledCount}`,
      )
      // Ph109(2026-04-24):背压一行 —— 仅在 detected 时渲染,避免无异常时的面板噪声。
      //   mark 语义:
      //     🛑 = env=on 主动拦(显式 env)
      //     🤖 = auto-gate 拦(streak 升级触发,Ph112)
      //     👁 = 仅观察(detected 但未拦)
      //   Ph110:kindList 从"空格分隔 kind 名"升级为"kind[REASON_ABBR]",让
      //     用户能分辨是 SHADOW_PILEUP(暂时)还是 ARCHIVE_BIAS(系统性)。
      //     同 kind 命中两因时显示两字母,如 skill[PB](Pileup+Bias)。
      //   Ph111(2026-04-24):kind 后追加 ×N 表示跨 tick streak 长度。
      //     N≥2 时才显示,N=1 保持原样不干扰(刚触发的新背压看起来跟 Ph110 一致)。
      //     streaks 由 lastBackpressureStreaks 提供,全量从 ~/.claude/autoEvolve/
      //     backpressure-streaks.json 热读 → 反映真实累计。
      //   Ph112(2026-04-24):被 auto-gate 命中的 kind 追加 🔒 标记,使"谁触发了升级"
      //     一眼可见(区分"仅观察态 streak" vs "已升级到拦截态")。
      if (s.lastBackpressureDetected) {
        const mark = s.lastBackpressureAutoGated
          ? '🤖 auto-gate'
          : s.lastBackpressureSkipped
            ? '🛑 skipped'
            : '👁 observed'
        const envVal = process.env.CLAUDE_EVOLVE_BACKPRESSURE
        const envLabel = envVal === 'on' ? 'on' : envVal === 'off' ? 'off' : 'auto'
        const reasonsByKind = s.lastBackpressureReasonsByKind ?? {}
        const streaks = s.lastBackpressureStreaks ?? {}
        const autoGatedSet = new Set(s.lastBackpressureAutoGatedKinds ?? [])
        const abbr = (r: string): string =>
          r === 'SHADOW_PILEUP' ? 'P' : r === 'ARCHIVE_BIAS' ? 'B' : '?'
        const kindList =
          s.lastBackpressureKinds.length > 0
            ? s.lastBackpressureKinds
                .map(k => {
                  const rs = reasonsByKind[k] ?? []
                  const tag = rs.length ? `[${rs.map(abbr).join('')}]` : ''
                  const count = streaks[k]?.count ?? 0
                  const streakTag = count >= 2 ? `×${count}` : ''
                  const lockTag = autoGatedSet.has(k) ? '🔒' : ''
                  return `${k}${tag}${streakTag}${lockTag}`
                })
                .join(',')
            : '(none)'
        lines.push(
          `backpressure: ${mark}  kinds={${kindList}}  env=${envLabel}  (P=SHADOW_PILEUP, B=ARCHIVE_BIAS, ×N=streak, 🔒=auto-gated)`,
        )
      }
      if (s.lastError) {
        // 截断到 160 字,避免面板被长错误栈撑爆
        const errShort =
          s.lastError.length > 160 ? s.lastError.slice(0, 157) + '...' : s.lastError
        lines.push(`last error: ${errShort}`)
      }
    }
    // Ph117(2026-04-24):趋势摘要 ——
    //   backpressure 行只反映"本 tick",用户想看"最近一段时间系统健康度"还得切
    //   /evolve-audit + /evolve-anomalies 两个命令。Ph117 把两条 ndjson 的
    //   last-N 窗口聚合成两行印在主面板,一屏内形成"现在 + 最近"的双视角。
    //   取窗口 N=30:与 /evolve-audit 默认 limit=20 接近但不重合,避免误以为
    //   一致 → 让用户在面板和命令之间感知到"面板是摘要、命令是完整"。
    //   故意放在 if(!s.everRan){...}else{...} 之外 —— 历史 ndjson 与当前进程
    //   是否 tick 过无关,"这台机器历史上跑过 autoEvolve"就该能看到回顾。
    //   完全 fail-open:IO 或空文件都静默跳过,不额外输出"(unavailable)"
    //   免得污染"系统一切正常"时的第一印象。
    try {
      const [{ loadBackpressureAudit }, { loadAnomalyHistory }] = await Promise.all([
        import('../../services/autoEvolve/arena/backpressureAudit.js'),
        import('../../services/autoEvolve/arena/anomalyHistory.js'),
      ])
      const N = 30
      const auditAll = loadBackpressureAudit()
      const audit = auditAll.slice(-N)
      if (audit.length > 0) {
        // 决策分布 —— 保持 4 类齐全,即使某类为 0 也显示,让用户看清"绝对分布"
        const dist = { observe: 0, 'env-on': 0, 'env-off': 0, 'auto-gate': 0 }
        for (const e of audit) {
          if (e.decision in dist) dist[e.decision as keyof typeof dist]++
        }
        lines.push(
          `  audit trend (last ${audit.length}): 👁observe=${dist['observe']}  🛑env-on=${dist['env-on']}  🔕env-off=${dist['env-off']}  🤖auto-gate=${dist['auto-gate']}`,
        )
      }
      const anomAll = loadAnomalyHistory()
      const anom = anomAll.slice(-N)
      if (anom.length > 0) {
        // 按 entry 计数:同一 entry 命中多种 anomaly 时每种各+1(与 /evolve-anomalies 一致)
        const kd = { SHADOW_PILEUP: 0, ARCHIVE_BIAS: 0, STAGNATION: 0, HIGH_ATTRITION: 0 }
        for (const e of anom) {
          const seen = new Set<string>()
          for (const a of e.anomalies) {
            if (a.kind in kd && !seen.has(a.kind)) {
              kd[a.kind as keyof typeof kd]++
              seen.add(a.kind)
            }
          }
        }
        lines.push(
          `  anomaly trend (last ${anom.length}): 🔥P=${kd.SHADOW_PILEUP}  📦B=${kd.ARCHIVE_BIAS}  ❄️S=${kd.STAGNATION}  ⚠️A=${kd.HIGH_ATTRITION}`,
        )
      }
    } catch {
      /* fail-open 不污染主面板 */
    }
    lines.push('')
  } catch (e) {
    lines.push('### Emergence Tick (Phase 48/102)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 2.6 Adaptive Thresholds(Ph129,2026-04-24):把 Ph121 自适应状态可视化。
  //   每个 kind 一行,展示 threshold=value / DEFAULT / 24h pileup / 偏移标签。
  //   空 state 友好提示(未发生过 pileup 时所有 kind 都走 DEFAULT=3)。
  //   位置:Emergence Tick 之后、Cache 之前,延续"背压-趋势-自适应"的阅读节奏。
  //   fail-open:加载失败静默。
  try {
    const { loadAdaptiveThresholds, isAdaptiveThresholdEnabled, DEFAULT_THRESHOLD, MIN_T, MAX_T } =
      await import('../../services/autoEvolve/arena/adaptiveThresholds.js')
    const enabled = isAdaptiveThresholdEnabled()
    lines.push('### Adaptive Thresholds (Phase 121)')
    if (!enabled) {
      lines.push(
        `  (disabled — CLAUDE_EVOLVE_ADAPTIVE_THRESHOLD=off; all kinds use constant ${DEFAULT_THRESHOLD})`,
      )
      lines.push('')
    } else {
      const state = loadAdaptiveThresholds()
      const entries = Object.entries(state.thresholds ?? {})
      if (entries.length === 0) {
        lines.push(
          `  (no per-kind thresholds recorded yet — all kinds use DEFAULT=${DEFAULT_THRESHOLD}, range=[${MIN_T},${MAX_T}])`,
        )
      } else {
        lines.push(
          `  range=[${MIN_T},${MAX_T}]  default=${DEFAULT_THRESHOLD}  (last updated: ${state.updatedAt ?? 'never'})`,
        )
        // 排序:先收紧(value<DEFAULT)的 kind,按 value 升序;再放松/默认
        const sorted = entries
          .map(([k, v]) => [k, v] as [string, { value: number; recentPileups24h: number }])
          .sort((a, b) => a[1].value - b[1].value)
        for (const [k, v] of sorted) {
          const tag =
            v.value < DEFAULT_THRESHOLD
              ? '🔒 tightened'
              : v.value > DEFAULT_THRESHOLD
                ? '🔓 relaxed'
                : '⏸ default'
          lines.push(
            `  ${k.padEnd(12)}  threshold=${v.value}  recentPileups24h=${v.recentPileups24h}  ${tag}`,
          )
        }
      }
      lines.push('')
    }
  } catch (e) {
    lines.push('### Adaptive Thresholds (Phase 121)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 3. Agent Result Cache
  try {
    const { getCacheSize, getSignatureIndexSize } = await import(
      '../../services/agentScheduler/index.js'
    )
    lines.push('### Agent Result Cache')
    lines.push(`Entries: ${getCacheSize()}  |  Signature index: ${getSignatureIndexSize()}`)
    lines.push('')
  } catch {
    lines.push('### Agent Result Cache')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 4. Rate Buckets —— 通用滑窗限流器,tokenBudget 是其中默认 input-tokens 桶
  //    #7 多桶化后这里迭代整张 registry:任何新桶(output-tokens / cost-usd /
  //    per-provider ...) 一旦被 createRateBucket 创建就会自动出现在这里。
  //    历史 "Input Token Budget" 那行仍然存在(dimension=input-tokens),语义不变。
  try {
    // 副作用加载:确保默认 input-tokens 桶已被创建进 registry
    await import('../../services/agentScheduler/tokenBudget.js')
    const { getAllRateBuckets } = await import(
      '../../services/rateBucket/index.js'
    )
    const allBuckets = getAllRateBuckets()
    lines.push('### Rate Buckets (sliding window)')
    if (allBuckets.length === 0) {
      lines.push('(no buckets registered)')
    } else {
      for (const b of allBuckets) {
        const s = b.snapshot()
        lines.push(
          `[${s.dimension}] window=${fmtMs(s.windowMs)}  enabled=${s.enabled}  usage=${fmtNum(s.usage)} / ${fmtNum(s.limit)}  remaining=${fmtNum(s.remaining)}  ledger=${s.ledgerEntries}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Rate Buckets')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5. Speculation
  try {
    const { getSpeculationState, getSpeculationMode } = await import(
      '../../services/agentScheduler/index.js'
    )
    const s = getSpeculationState()
    lines.push('### Speculation (pre-run)')
    lines.push(
      `Enabled: ${s.enabled}  |  Mode: ${getSpeculationMode()}  |  Runner: ${s.runnerRegistered ? 'registered' : 'NOT registered'}`,
    )
    lines.push(
      `Attempts: ${s.attempts}  executed: ${s.executed}  hits: ${s.hits}`,
    )
    lines.push(
      `Dropped: noSlot=${s.dropped_noSlot} alreadyCached=${s.dropped_alreadyCached} noPrediction=${s.dropped_noPrediction} runnerError=${s.dropped_runnerError}`,
    )
    lines.push('')
  } catch {
    lines.push('### Speculation')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 5b. Shadow Agent Runner —— P0 影子并行
  //     由 codexShadowRunner 驱动,与主 speculation 平行但不写主 cache。
  //     产出落在独立 shadowStore,仅作参考,不影响 AgentTool 命中路径。
  try {
    const {
      getShadowRunnerState,
      resolveShadowAgentName,
      listShadowResults,
      getShadowStoreSize,
      getShadowStoreConfig,
    } = await import('../../services/agentScheduler/index.js')
    const r = getShadowRunnerState()
    const agentName = resolveShadowAgentName()
    const cfg = getShadowStoreConfig()
    lines.push('### Shadow Agent Runner (P0 影子并行)')
    lines.push(
      `Enabled: ${r.enabled}  |  Agent: ${agentName ?? '(none)'}  |  Env: CLAUDE_CODE_SHADOW_AGENT`,
    )
    lines.push(
      `Ticks: ${r.tickCount}  executed: ${r.executed}  lastTick: ${fmtTs(r.lastTickAt)}`,
    )
    lines.push(
      `Completed: success=${r.completed_success} failed=${r.completed_failed} timeout=${r.completed_timeout}  fp-writeback=${r.fingerprintWriteBacks}  ep-writeback=${r.episodeWriteBacks}`,
    )
    lines.push(
      `Dropped: noSlot=${r.dropped_noSlot} noPrediction=${r.dropped_noPrediction} alreadyShadowed=${r.dropped_alreadyShadowed} unavailable=${r.dropped_unavailable}`,
    )
    if (r.lastError) {
      lines.push(`Last error: ${r.lastError}`)
    }
    if (r.lastEpisodeError) {
      lines.push(`Last episode error: ${r.lastEpisodeError}`)
    }
    const entries = listShadowResults()
    lines.push(
      `Store: ${getShadowStoreSize()} entries  |  TTL: ${fmtMs(cfg.ttlMs)}  |  Max: ${cfg.maxSize}`,
    )
    if (entries.length > 0) {
      lines.push('Recent shadow entries:')
      for (const e of entries.slice(0, 5)) {
        const tokenStr = e.tokens
          ? ` in=${e.tokens.input} out=${e.tokens.output}`
          : ''
        lines.push(
          `  [${e.status.padEnd(7)}] ${e.agentType.padEnd(24)} via=${e.sourceAgent.padEnd(11)} ${fmtMs(e.durationMs).padEnd(6)} ago=${fmtTs(e.finishedAt)}${tokenStr}`,
        )
        lines.push(`     ${e.promptPreview.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Shadow Agent Runner')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5c. Capability Router —— P0 差异化路由
  //     被 ShadowRunner(env=auto)消费;展示规则表规模与最近决策,
  //     便于判断路由是否按预期工作。
  try {
    const { getRouterSnapshot } = await import(
      '../../services/agentRouter/capabilityRouter.js'
    )
    const snap = getRouterSnapshot()
    lines.push('### Capability Router (P0 差异化路由)')
    lines.push(
      `Enabled: ${snap.enabled}  |  Default: ${snap.defaultAgent}  |  Env: CLAUDE_CODE_AGENT_ROUTER`,
    )
    lines.push(
      `Rules: ${snap.rulesCount}  |  History: ${snap.historyCount} decisions`,
    )
    if (snap.recentDecisions.length > 0) {
      lines.push('Recent decisions:')
      for (const d of snap.recentDecisions) {
        const cs = d.candidates
          .slice(0, 3)
          .map(c => `${c.name}${c.available ? '' : '!'}@${c.score}`)
          .join(',')
        lines.push(
          `  ${fmtTs(d.at).padEnd(10)} -> ${String(d.chosen ?? '(none)').padEnd(12)} [${d.reasoning}]  cands: ${cs}`,
        )
        lines.push(`     ${d.taskPreview.replace(/\s+/g, ' ').slice(0, 110)}`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Capability Router')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5d. Context Fingerprints —— P1 外部 agent 跨会话上下文复用
  //     写入时机:pipelineRunner 每阶段成功后。读时机:下一阶段自动注入前缀。
  //     这里仅做只读诊断,不触发任何写入。
  try {
    const {
      listContextFingerprints,
      getContextFingerprintSize,
      getContextFingerprintConfig,
    } = await import('../../services/externalAgentMemory/index.js')
    const entries = listContextFingerprints()
    const cfg = getContextFingerprintConfig()
    lines.push('### Context Fingerprints (P1 跨会话上下文复用)')
    lines.push(
      `Store: ${getContextFingerprintSize()} entries  |  TTL: ${fmtMs(cfg.ttlMs)}  |  Max: ${cfg.maxSize}`,
    )
    if (entries.length === 0) {
      lines.push('(no fingerprints recorded yet)')
    } else {
      lines.push('Recent fingerprints:')
      for (const e of entries.slice(0, 5)) {
        const tokenStr = e.tokens
          ? ` tokens=in${e.tokens.input}/out${e.tokens.output}`
          : ''
        lines.push(
          `  [${e.sourceAgent.padEnd(11)}] samples=${String(e.sampleCount).padEnd(3)} ago=${fmtTs(e.finishedAt).padEnd(10)} cwd=${e.cwd}${tokenStr}`,
        )
        lines.push(`     task: ${e.taskPreview.replace(/\s+/g, ' ').slice(0, 110)}`)
        lines.push(`     summary: ${e.summary.replace(/\s+/g, ' ').slice(0, 140)}`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Context Fingerprints')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 5e. External Agent Pipeline —— P1 流水线执行历史(最近 10 次)
  //     仅诊断只读,不主动触发执行。历史为纯内存 ring buffer,进程退出清零。
  try {
    const { getPipelineHistory } = await import(
      '../../services/externalAgentPipeline/index.js'
    )
    const runs = getPipelineHistory()
    lines.push('### External Agent Pipeline (P1 流水线分工)')
    lines.push(`History: ${runs.length} run(s)`)
    if (runs.length === 0) {
      lines.push('(no pipeline runs recorded yet)')
    } else {
      for (const run of runs.slice(0, 5)) {
        lines.push(
          `[${run.id}] "${run.name}" status=${run.status} dur=${fmtMs(run.finishedAt - run.startedAt)} stages=${run.stages.length}`,
        )
        for (const st of run.stages) {
          const agent = st.agentResolved.padEnd(11)
          const status = st.status.padEnd(7)
          const err = st.errorMessage ? `  err=${st.errorMessage.slice(0, 60)}` : ''
          const tok = st.tokens ? ` in=${st.tokens.input}/out=${st.tokens.output}` : ''
          const fp = st.persistedFingerprint ? ' fp=yes' : ''
          lines.push(
            `   - ${st.stageName.padEnd(16)} ${agent} ${status} ${fmtMs(st.durationMs).padEnd(6)}${tok}${fp}${err}`,
          )
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### External Agent Pipeline')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 6. Preflight Gates —— 统一展示注册表里的所有 gate(agent / tool / 未来扩展)
  //    历史上这一节只展示 agent gate;#3 Preflight Registry 落地后改为迭代
  //    getAllGates(),任何新 gate 自动出现在这里。
  try {
    // 确保内置 gate 已被加载到注册表(副作用式 import —— 模块顶层会自行 register)
    await import('../../tools/AgentTool/agentPreflight.js')
    await import('../../services/preflight/toolPreflight.js')
    const { getAllGates } = await import('../../services/preflight/index.js')
    const allGates = getAllGates()
    lines.push('### Preflight Gates')
    if (allGates.length === 0) {
      lines.push('(no gates registered)')
    } else {
      for (const g of allGates) {
        lines.push(
          `[${g.name}] enabled=${g.isEnabled()}  thresholds: minSamples=${g.thresholds.minSamples}, warnErr=${g.thresholds.warnErrorRate}, warnP95=${fmtMs(g.thresholds.warnP95Ms)}, blockFails=${g.thresholds.blockConsecutiveFails}`,
        )
        const fails = g.getFails()
        if (fails.size === 0) {
          lines.push('  (no consecutive-fail keys)')
        } else {
          const items = Array.from(fails.entries()).sort((a, b) => b[1] - a[1])
          for (const [name, n] of items) {
            lines.push(`  ${name}: ${n} consecutive fail(s)`)
          }
        }
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Preflight Gates')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 7. Agent Stats(缓存的快照,不触发扫盘)
  try {
    const { getCachedAgentStatsSnapshot } = await import(
      '../../services/agentScheduler/index.js'
    )
    const snap = getCachedAgentStatsSnapshot()
    lines.push('### Agent Stats (cached snapshot)')
    if (!snap) {
      lines.push('(no snapshot yet — background tick 尚未刷新,或历史无数据)')
    } else {
      lines.push(
        `Generated: ${fmtTs(snap.generatedAt)}  |  Total samples: ${snap.totalSamples}  |  Agents: ${Object.keys(snap.byAgentType).length}`,
      )
      // 按样本数倒序取前 10 个展示
      const rows = Object.entries(snap.byAgentType)
        .sort((a, b) => b[1].totalRuns - a[1].totalRuns)
        .slice(0, 10)
      if (rows.length > 0) {
        lines.push('Top agents (by sample count):')
        for (const [name, stat] of rows) {
          const err = stat.totalRuns > 0
            ? ((stat.errorRuns + stat.abortRuns) / stat.totalRuns * 100).toFixed(0) + '%'
            : 'n/a'
          lines.push(
            `  ${name.padEnd(28)} runs=${String(stat.totalRuns).padEnd(5)} err=${err.padEnd(4)} p95=${fmtMs(stat.p95DurationMs)}`,
          )
        }
      }
    }
    lines.push('')
  } catch {
    lines.push('### Agent Stats')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 8. Tool Stats(本 session in-memory ring buffer,镜像 AgentStat 字段形状)
  //    数据来源:services/tools/toolExecution.ts 在 success/error/abort 三处记录
  try {
    const { getToolStatsSnapshot, getToolStatsRecordCount } = await import(
      '../../services/agentScheduler/index.js'
    )
    const snap = getToolStatsSnapshot()
    lines.push('### Tool Stats (this session, in-memory)')
    lines.push(
      `Ring buffer: ${getToolStatsRecordCount()} records  |  Generated: ${fmtTs(snap.generatedAt)}  |  Tools seen: ${Object.keys(snap.byToolName).length}`,
    )
    const rows = Object.entries(snap.byToolName)
      .sort((a, b) => b[1].totalRuns - a[1].totalRuns)
      .slice(0, 12)
    if (rows.length > 0) {
      lines.push('Top tools (by call count):')
      for (const [name, stat] of rows) {
        const err = stat.totalRuns > 0
          ? ((stat.errorRuns + stat.abortRuns) / stat.totalRuns * 100).toFixed(0) + '%'
          : 'n/a'
        lines.push(
          `  ${name.padEnd(28)} runs=${String(stat.totalRuns).padEnd(5)} err=${err.padEnd(4)} p95=${fmtMs(stat.p95DurationMs).padEnd(8)} last=${fmtTs(stat.lastRunAt)}`,
        )
      }
    } else {
      lines.push('(no tool calls recorded yet this session)')
    }
    lines.push('')
  } catch {
    lines.push('### Tool Stats')
    lines.push('(unavailable)')
    lines.push('')
  }

  // 9. Auto-Continue Strategies —— 自动续聊的策略注册表快照
  //    副作用 import autoContinueTurn 触发两条内置策略注册(max_tokens /
  //    next_step_intent);未来业务侧添加新策略会自动出现在这里,并带 hits 计数。
  try {
    await import('../../utils/autoContinueTurn.js')
    const { getAllAutoContinueStrategies } = await import(
      '../../services/autoContinue/index.js'
    )
    const snaps = getAllAutoContinueStrategies()
    lines.push('### Auto-Continue Strategies')
    if (snaps.length === 0) {
      lines.push('(no strategies registered)')
    } else {
      for (const s of snaps) {
        lines.push(
          `[${s.name.padEnd(20)}] priority=${String(s.priority).padEnd(4)} enabled=${String(s.enabled).padEnd(5)} hits=${s.hits}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Auto-Continue Strategies')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 9.1 Auto-Continue Learner —— 展示 LLM 自动续聊的动态 confidence 阈值。
  //     与 /evolve-status 同源,便于在主诊断面板直接观察 learner 是否被调高/调低。
  try {
    const {
      autoContinueLearner,
      DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE,
    } = await import('../../services/autoEvolve/learners/autoContinue.js')
    const p = await autoContinueLearner.load()
    lines.push('### Auto-Continue Learner')
    lines.push(
      `minConfidenceForContinue=${p.minConfidenceForContinue.toFixed(3)}  default=${DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE.toFixed(3)}  samples=${p.sampleCount}  accepted=${p.acceptedCount}  interrupted=${p.interruptedCount}  last=${p.lastOutcome}  updated=${fmtTs(p.updatedAt)}`,
    )
    lines.push('')
  } catch (e) {
    lines.push('### Auto-Continue Learner')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 10. Snapshot Stores(#2 跨会话持久化:agent-stats / tool-stats / 任意新订阅)
  //     副作用 import agentStats & toolStats,保证两个内置 store 已注册。
  //     未来业务侧 createSnapshotStore 也会自动出现在这里。
  try {
    await import('../../services/agentScheduler/agentStats.js')
    await import('../../services/agentScheduler/toolStats.js')
    const { getAllSnapshotStores } = await import(
      '../../services/snapshotStore/index.js'
    )
    const snaps = getAllSnapshotStores()
    lines.push('### Snapshot Stores (persisted cross-session)')
    if (snaps.length === 0) {
      lines.push('(no snapshot stores registered)')
    } else {
      for (const s of snaps) {
        const bytesLabel = s.lastSaveBytes > 0 ? `${s.lastSaveBytes}B` : 'n/a'
        lines.push(
          `[${s.namespace.padEnd(16)}] v${s.schemaVersion}  lastSaved=${fmtTs(s.lastSavedAt)}  lastLoaded=${fmtTs(s.lastLoadedAt)}  bytes=${bytesLabel}${s.lastError ? `  err=${s.lastError}` : ''}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Snapshot Stores')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 11. Cold-Start(#5 冷启动预跑):候选注册表 + 最近 burst 运行态
  //     候选由上层(如 coordinator hook)按需 registerColdStartCandidate 种下;
  //     无候选时整个区段仍可读,表示未启用冷启动兜底。
  try {
    const { getColdStartState, listColdStartCandidates } = await import(
      '../../services/agentScheduler/index.js'
    )
    const coldState = getColdStartState()
    const candidates = listColdStartCandidates()
    lines.push('### Cold-Start (coordinator pre-run)')
    lines.push(
      `registered=${coldState.candidatesRegistered}  lastPicked=${coldState.lastPickedName ?? 'n/a'}`,
    )
    lines.push(
      `burst: task=${coldState.lastBurstTaskName ?? 'n/a'}  startedAt=${fmtTs(coldState.lastBurstStartedAt)}  ticks=${coldState.burstTicksExecuted}/${coldState.burstTicksTotal}  completed=${coldState.burstCompleted}${coldState.lastError ? `  err=${coldState.lastError}` : ''}`,
    )
    if (candidates.length === 0) {
      lines.push('(no candidates registered)')
    } else {
      for (const c of candidates) {
        const promptPreview =
          c.prompt.length > 50 ? `${c.prompt.slice(0, 50)}…` : c.prompt
        lines.push(
          `[${c.name.padEnd(24)}] priority=${String(c.priority).padEnd(4)} agent=${c.agentType.padEnd(16)} when=${c.when.padEnd(24)} source=${c.source}`,
        )
        lines.push(`  prompt="${promptPreview}"`)
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Cold-Start')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // Context Economy —— Phase 1/2/3 汇总面板
  // 把"折叠/外置/影子评估/分层索引"四类事件聚合一屏,零副作用。
  try {
    lines.push('### Context Economy (Phase 1/2/3/6)')

    // 1) Collapse 聚合(Phase 1)
    try {
      const { summarizeContextCollapseState, listCommittedCollapses, getContextBrokerShadowStats } =
        await import('../../services/contextCollapse/index.js')
      const { listOffloadedToolResults, getRehydrateStats } = await import(
        '../../services/contextCollapse/operations.js'
      )

      const summary = summarizeContextCollapseState()
      const committed = listCommittedCollapses()
      const totalArchived = committed.reduce((s, c) => s + (c.messageCount || 0), 0)
      const h = summary.stats.health
      lines.push('Collapse:')
      lines.push(
        `  enabled=${summary.enabled}  armed=${summary.armed}  spawns=${fmtNum(h.totalSpawns)}  errors=${fmtNum(h.totalErrors)}${h.lastError ? `  lastError="${h.lastError}"` : ''}`,
      )
      lines.push(
        `  spans: committed=${fmtNum(summary.stats.collapsedSpans)}  staged=${fmtNum(summary.stats.stagedSpans)}  archivedMsgs=${fmtNum(totalArchived)}`,
      )
      lines.push(`  lastSpawnTokens=${fmtNum(summary.lastSpawnTokens)}`)
      if (committed.length > 0) {
        const tail = committed.slice(-3)
        for (const c of tail) {
          const turnPreview = c.turnIds && c.turnIds.length > 0 ? ` turns=${c.turnIds.length}` : ''
          lines.push(
            `    [${c.collapseId.padEnd(18)}] msgs=${fmtNum(c.messageCount || 0)}${turnPreview}`,
          )
        }
      }

      // 2) Offload 聚合(Phase 2) —— 外置化工具结果
      const offloaded = listOffloadedToolResults()
      const totalOffloadBytes = offloaded.reduce((s, o) => s + o.sizeBytes, 0)
      lines.push('Offload (tool results):')
      lines.push(
        `  files=${fmtNum(offloaded.length)}  totalBytes=${fmtNum(totalOffloadBytes)}`,
      )

      // 3) Broker Shadow 聚合(Phase 3) —— 仅日志,不执行
      const shadow = getContextBrokerShadowStats()
      lines.push('Broker Shadow (planner suggest-only):')
      lines.push(
        `  evaluated=${fmtNum(shadow.evaluated)}  earlySuggest=${fmtNum(shadow.earlySuggest)}  errored=${fmtNum(shadow.errored)}`,
      )
      if (shadow.lastEvaluatedAt > 0) {
        lines.push(
          `  lastEval: ${fmtTs(shadow.lastEvaluatedAt)}  ratio=${shadow.lastRatio}  tokens=${fmtNum(shadow.lastTokens)}/${fmtNum(shadow.lastThreshold)}`,
        )
      }
      if (shadow.lastSuggestAt > 0) {
        lines.push(`  lastSuggest: ${fmtTs(shadow.lastSuggestAt)}`)
      }

      // 4) Rehydrate 聚合(Phase 6) —— 回取频率/命中率/均值
      const reh = getRehydrateStats()
      lines.push('Rehydrate (Tool + /rehydrate share the same kernel):')
      lines.push(
        `  calls=${fmtNum(reh.calls)}  hits=${fmtNum(reh.hits)}  misses=${fmtNum(reh.misses)}  invalid=${fmtNum(reh.invalid)}  hitRate=${reh.hitRate}`,
      )
      if (reh.hits > 0) {
        lines.push(
          `  hitsByKind: turn=${fmtNum(reh.hitsByKind.turn || 0)} collapse=${fmtNum(reh.hitsByKind.collapse || 0)} tool=${fmtNum(reh.hitsByKind.tool || 0)}`,
        )
        lines.push(
          `  avg: tokens=${fmtNum(reh.avgTokens)}  tookMs=${fmtNum(reh.avgTookMs)}  lastSource=${reh.lastSource}`,
        )
      }
      if (reh.lastHitAt > 0) lines.push(`  lastHit: ${fmtTs(reh.lastHitAt)}`)
      if (reh.lastMissAt > 0) lines.push(`  lastMiss: ${fmtTs(reh.lastMissAt)}`)
      if (reh.lastInvalidAt > 0) lines.push(`  lastInvalid: ${fmtTs(reh.lastInvalidAt)}`)
    } catch (inner) {
      lines.push(`  (collapse/offload/shadow/rehydrate unavailable: ${(inner as Error).message})`)
    }

    // 5) Tier Index 聚合(Phase 1 写 L4) —— 磁盘视图
    try {
      const { contextTierManager } = await import(
        '../../services/compact/tieredContext/tierManager.js'
      )
      const { getSessionId } = await import('../../bootstrap/state.js')
      const { getTranscriptPath } = await import('../../utils/sessionStorage.js')
      const sid = getSessionId()
      const tpath = getTranscriptPath()
      const idx = contextTierManager.getIndexStats(sid, tpath)
      lines.push('Tier Index (L4 disk):')
      lines.push(
        `  entries=${fmtNum(idx.totalEntries)}  tokens=${fmtNum(idx.totalTokens)}`,
      )
    } catch (inner) {
      lines.push(`  (tier index unavailable: ${(inner as Error).message})`)
    }

    // 特性开关可视化
    const flagCollapse = process.env.CLAUDE_CODE_COLLAPSE_TIER_INDEX
    const flagShadow = process.env.CLAUDE_CODE_CONTEXT_BROKER_SHADOW
    lines.push(
      `Flags: COLLAPSE_TIER_INDEX=${flagCollapse ?? '(default on)'}  CONTEXT_BROKER_SHADOW=${flagShadow ?? '(default on)'}`,
    )
    lines.push('')
  } catch (e) {
    lines.push('### Context Economy')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 12. Context Signals —— Phase 54 统一上下文投递账本
  //     各 source(auto-memory / 后续接入的 tool-result / tier-index 等)在投递
  //     上下文时打点, 这里聚合成 per-kind 统计。与 Context Economy 互补:
  //       Context Economy: 聚焦"压缩/外置/折叠"事件
  //       Context Signals: 聚焦"每次送进上下文的是哪家 source, 花了多少 tokens"
  try {
    const { getContextSignalsSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getContextSignalsSnapshot()
    lines.push('### Context Signals (Phase 54)')
    const flagSignals = process.env.CLAUDE_CODE_CONTEXT_SIGNALS
    lines.push(
      `Enabled: ${snap.enabled}  |  Env: CLAUDE_CODE_CONTEXT_SIGNALS=${flagSignals ?? '(default on)'}`,
    )
    lines.push(
      `Ring: served=${fmtNum(snap.servedRingSize)}/${fmtNum(snap.ringCapacity)}  utilization=${fmtNum(snap.utilizationRingSize)}/${fmtNum(snap.ringCapacity)}`,
    )
    if (snap.byKind.length === 0) {
      lines.push('(no signals recorded yet this session)')
    } else {
      lines.push('By kind (served count desc):')
      for (const row of snap.byKind) {
        const util =
          row.utilizedCount + row.notUtilizedCount > 0
            ? `${(row.utilizationRate * 100).toFixed(0)}%`
            : 'n/a'
        lines.push(
          `  ${row.kind.padEnd(18)} served=${String(row.servedCount).padEnd(4)} items=${String(row.totalItems).padEnd(4)} tokens=${fmtNum(row.totalTokens).padEnd(7)} util=${util.padEnd(4)} last=${fmtTs(row.lastServedAt)}`,
        )
      }
    }
    if (snap.recentServed.length > 0) {
      lines.push('Recent served:')
      for (const ev of snap.recentServed) {
        const lvl = ev.level ? ` lvl=${ev.level}` : ''
        const dp = ev.decisionPoint ? ` @${ev.decisionPoint}` : ''
        lines.push(
          `  ${fmtTs(ev.ts).padEnd(10)} ${String(ev.kind).padEnd(18)} items=${ev.itemCount} tokens=${fmtNum(ev.tokens)}${lvl}${dp}`,
        )
      }
    }
    // Phase 63 (2026-04-24): dream pipeline 蒸馏产出亮点 —— 从 recentServed 里挑出
    // kind='dream-artifact' 的事件, 展示 distilled names(compact.autoDistill 落下)。
    // byKind 行已自动包含此 kind, 这里只是把 meta.distilledNames 拎到前台。
    const dreamEvents = snap.recentServed.filter(e => e.kind === 'dream-artifact')
    if (dreamEvents.length > 0) {
      lines.push('Dream artifacts (Phase 63):')
      for (const ev of dreamEvents.slice(-5)) {
        const meta = (ev.meta ?? {}) as {
          episodeCount?: number
          distilledCount?: number
          distilledNames?: ReadonlyArray<string>
          sessionId?: string
        }
        const names = (meta.distilledNames ?? []).slice(0, 3).join(', ')
        lines.push(
          `  ${fmtTs(ev.ts).padEnd(10)} episodes=${meta.episodeCount ?? '?'} → distilled=${meta.distilledCount ?? ev.itemCount} [${names}]`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Context Signals (Phase 54)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 13. Context Budget Ledger —— Phase 55 最近 N 次 budget 估算快照
  //     每次 query.ts 调用 estimateContextBudgetAllocation 后被记录,
  //     让 /kernel-status 一眼看"当前 turn 的上下文经济学分布"。
  try {
    const { getBudgetLedgerSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getBudgetLedgerSnapshot()
    lines.push('### Context Budget Ledger (Phase 55)')
    lines.push(
      `Enabled: ${snap.enabled}  |  Entries: ${fmtNum(snap.count)}/${fmtNum(snap.ringCapacity)}  |  avgRatio=${(snap.avgRatio * 100).toFixed(0)}%  prefetchRate=${(snap.prefetchRate * 100).toFixed(0)}%`,
    )
    if (snap.latest) {
      const L = snap.latest
      lines.push(
        `Latest: window=${fmtNum(L.totalWindowTokens)} input=${fmtNum(L.inputBudgetTokens)} output=${fmtNum(L.outputBudgetTokens)} used=${fmtNum(L.usedTokens)}/${fmtNum(L.maxTokens)} ratio=${(L.ratio * 100).toFixed(0)}%${L.shouldPrefetch ? ' PREFETCH' : ''}`,
      )
      lines.push(
        `  sections: sys=${fmtNum(L.sectionTokens.system)} tools=${fmtNum(L.sectionTokens.tools)} hist=${fmtNum(L.sectionTokens.history)} out=${fmtNum(L.sectionTokens.output)}  hottest=${L.hottestSection}`,
      )
      if (L.reason) lines.push(`  reason: ${L.reason}`)
    } else {
      lines.push('(no allocation recorded yet this session)')
    }
    lines.push('')
  } catch (e) {
    lines.push('### Context Budget Ledger (Phase 55)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 14. Shadow Choreographer —— Phase 57 suggest-only 建议
  //     根据 Phase 55 budget + Phase 54/58 signals 每次渲染拉一次评估,
  //     输出 demote / upgrade 建议, 从不实际执行 —— 供人眼审视和 Phase 59
  //     context-selector Pattern Miner 当做 ground-truth fitness 信号。
  try {
    const {
      evaluateShadowChoreography,
      getShadowChoreographerState,
      getShadowSuggestionAggregates,
    } = await import('../../services/contextSignals/index.js')
    // 触发一次评估(每次 /kernel-status 拉取都刷新; 不做后台周期, 避免沉没负担)
    evaluateShadowChoreography()
    const s = getShadowChoreographerState()
    const flagChor = process.env.CLAUDE_CODE_CONTEXT_CHOREOGRAPHY_SHADOW
    lines.push('### Shadow Choreographer (Phase 57, suggest-only)')
    lines.push(
      `Enabled: ${s.enabled}  |  Env: CLAUDE_CODE_CONTEXT_CHOREOGRAPHY_SHADOW=${flagChor ?? '(default on)'}`,
    )
    lines.push(
      `Evaluated: ${fmtNum(s.evaluated)}  lastAt: ${fmtTs(s.lastEvaluatedAt)}  ruleHits: demote=${fmtNum(s.ruleHits.demote)} upgrade=${fmtNum(s.ruleHits.upgrade)} noop=${fmtNum(s.ruleHits.noop)}`,
    )
    if (s.lastSuggestions.length === 0) {
      lines.push('(no suggestions from latest evaluation — signals may be insufficient)')
    } else {
      lines.push('Latest suggestions (confidence desc, NOT executed):')
      for (const g of s.lastSuggestions.slice(0, 6)) {
        lines.push(
          `  [${g.kind.padEnd(7)}] target=${String(g.target).padEnd(18)} conf=${(g.confidence * 100).toFixed(0)}%  ${g.reason}`,
        )
      }
    }
    // Phase 59:展示跨 turn aggregate 账本的尾部预览,让用户知道哪些 (target,kind)
    // 有足够样本去触发 context-selector Pattern Miner。
    try {
      const aggs = getShadowSuggestionAggregates()
      if (aggs.length > 0) {
        lines.push('')
        lines.push(
          `Phase 59 aggregates: ${aggs.length} (target,kind) pair(s) tracked — feeds context-selector Pattern Miner`,
        )
        // 按 totalEmitted 排序, 取前 5 条
        const top = [...aggs]
          .sort((a, b) => b.totalEmitted - a.totalEmitted)
          .slice(0, 5)
        for (const a of top) {
          const avgConf = a.totalConfidence / Math.max(1, a.totalEmitted)
          lines.push(
            `  ${String(a.target).padEnd(18)} ${a.kind.padEnd(7)} emitted=${fmtNum(a.totalEmitted)}  avgConf=${(avgConf * 100).toFixed(0)}%`,
          )
        }
      }
    } catch {
      // aggregate 展示失败不挡主流程
    }
    lines.push('')
  } catch (e) {
    lines.push('### Shadow Choreographer (Phase 57)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // Phase A. ContextAdmissionController —— shadow-only 准入判定
  //     把 Advisor/Budget/RegretHunger 汇成 skip/index/summary/full 影子决策。
  //     当前阶段只展示,不改变任何实际上下文注入行为。
  try {
    const { getContextAdmissionSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getContextAdmissionSnapshot()
    const flagAdmission = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW
    lines.push('### Context Admission Controller (Phase A, shadow-only)')
    const flagToolExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_TOOL_RESULT
    lines.push(
      `Enabled: ${snap.enabled}  |  Env: CLAUDE_CODE_CONTEXT_ADMISSION_SHADOW=${flagAdmission ?? '(default on)'}  |  Events: ${fmtNum(snap.count)}/${fmtNum(snap.ringCapacity)}`,
    )
    const flagMemExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_AUTO_MEMORY
    const flagFileExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_FILE_ATTACHMENT
    const flagHistoryExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HISTORY_COMPACT
    const flagSideExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_SIDE_QUERY
    const flagHandoffExec = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_EXECUTE_HANDOFF_MANIFEST
    const flagPersistRetirement = process.env.CLAUDE_CODE_CONTEXT_ADMISSION_PERSIST_RETIREMENT
    lines.push(
      `Execution: tool-result=${snap.toolResultExecutionEnabled ? 'on' : 'off'}  auto-memory=${snap.autoMemoryExecutionEnabled ? 'on' : 'off'}  file=${snap.fileAttachmentExecutionEnabled ? 'on' : 'off'}  history=${snap.historyCompactExecutionEnabled ? 'on' : 'off'}  side-query=${snap.sideQueryExecutionEnabled ? 'on' : 'off'}  handoff=${snap.handoffManifestExecutionEnabled ? 'on' : 'off'}`,
    )
    lines.push(
      `  envs: TOOL_RESULT=${flagToolExec ?? '(default off)'} AUTO_MEMORY=${flagMemExec ?? '(default off)'} FILE=${flagFileExec ?? '(default off)'} HISTORY=${flagHistoryExec ?? '(default off)'} SIDE_QUERY=${flagSideExec ?? '(default off)'} HANDOFF=${flagHandoffExec ?? '(default off)'} RETIREMENT=${flagPersistRetirement ?? '(default off)'}`,
    )
    lines.push(
      `Decisions: skip=${fmtNum(snap.byDecision.skip)} index=${fmtNum(snap.byDecision.index)} summary=${fmtNum(snap.byDecision.summary)} full=${fmtNum(snap.byDecision.full)}`,
    )
    // Phase G 闭环观测(2026-04-25):evidence-informed 规则实际触发次数,按 decision 细分。
    const evi = snap.evidenceInformed
    if (evi.total > 0) {
      const lastStr = evi.lastAt ? new Date(evi.lastAt).toISOString() : 'never'
      lines.push(
        `Phase G evidence-informed triggers: total=${fmtNum(evi.total)} index=${fmtNum(evi.byDecision.index)} summary=${fmtNum(evi.byDecision.summary)} lastAt=${lastStr}`,
      )
    } else {
      lines.push('Phase G evidence-informed triggers: total=0 (no new items with ≥2 net-negative evidence this session)')
    }
    if (snap.byCacheClass.length > 0) {
      lines.push('Cache classes:')
      for (const c of snap.byCacheClass.slice(0, 4)) {
        lines.push(
          `  ${String(c.cacheClass).padEnd(12)} events=${fmtNum(c.count)} tokens=${fmtNum(c.tokens)} skip=${fmtNum(c.byDecision.skip)} index=${fmtNum(c.byDecision.index)} summary=${fmtNum(c.byDecision.summary)} full=${fmtNum(c.byDecision.full)}`,
        )
      }
      const churn = snap.promptCacheChurnRisk
      lines.push(
        `Prompt cache churn risk: ${churn.level} volatileFull=${fmtNum(churn.volatileFullTokens)} volatile=${fmtNum(churn.volatileTokens)} stable=${fmtNum(churn.stableTokens)} events=${fmtNum(churn.volatileFullEvents)}`,
      )
      lines.push(`  ${churn.reason}`)
      for (const o of snap.promptCacheChurnOffenders.slice(0, 3)) {
        lines.push(
          `  offender ${String(o.kind).padEnd(18)} tokens=${fmtNum(o.tokens)} count=${fmtNum(o.count)} key=${o.key.slice(0, 80)}`,
        )
      }
    }
    if (snap.retirementCandidates.length > 0) {
      lines.push(`Retirement candidates (shadow-only, persist=${snap.retirementPersistenceEnabled ? 'on' : 'off'}):`)
      for (const c of snap.retirementCandidates) {
        lines.push(
          `  ${String(c.kind).padEnd(18)} ${c.decision.padEnd(7)} count=${fmtNum(c.count)} avgConf=${(c.avgConfidence * 100).toFixed(0)}% evidence=+${fmtNum(c.evidence.positive)}/-${fmtNum(c.evidence.negative)}/~${fmtNum(c.evidence.neutral)}`,
        )
        lines.push(`    ${c.reason}`)
      }
    }
    if (snap.persistedRetirementCandidates.length > 0) {
      lines.push('Persisted retirement candidates (joins minePatterns skip-set when RETIREMENT=on):')
      for (const c of snap.persistedRetirementCandidates.slice(0, 3)) {
        lines.push(
          `  ${String(c.kind).padEnd(18)} ${c.decision.padEnd(7)} seen=${fmtNum(c.seenCount)} evidence=+${fmtNum(c.evidence.positive)}/-${fmtNum(c.evidence.negative)}/~${fmtNum(c.evidence.neutral)} last=${c.lastSeenAt}`,
        )
      }
    }
    if (snap.recent.length === 0) {
      lines.push('(no admission shadow events recorded yet this session)')
    } else {
      lines.push('Recent shadow decisions (NOT executed):')
      for (const ev of snap.recent.slice(0, 6)) {
        const cur = ev.currentLevel ? ` current=${ev.currentLevel}` : ''
        const dp = ev.decisionPoint ? ` @${ev.decisionPoint}` : ''
        lines.push(
          `  ${fmtTs(ev.ts).padEnd(10)} ${String(ev.kind).padEnd(18)} → ${ev.decision.padEnd(7)} conf=${(ev.confidence * 100).toFixed(0)}% tokens=${fmtNum(ev.estimatedTokens)}${cur}${dp}`,
        )
        lines.push(`    ${ev.reason}`)
      }
    }
    try {
      const { getContextItemRoiSnapshot } = await import(
        '../../services/contextSignals/index.js'
      )
      const roi = getContextItemRoiSnapshot(5)
      lines.push(
        `Item ROI: enabled=${roi.enabled} persist=${roi.persist.enabled ? 'on' : 'off'} loaded=${roi.persist.loaded} tracked=${fmtNum(roi.tracked)} deadWeight=${fmtNum(roi.deadWeight.length)} topUsed=${fmtNum(roi.topUsed.length)} admission=${fmtNum(roi.admissionCount)} [full=${fmtNum(roi.admissionByDecision.full)} summary=${fmtNum(roi.admissionByDecision.summary)} index=${fmtNum(roi.admissionByDecision.index)} skip=${fmtNum(roi.admissionByDecision.skip)}]`,
      )
      lines.push(`  persist path: ${roi.persist.path}`)
      for (const ev of roi.recentAdmission.slice(0, 3)) {
        lines.push(
          `  admission ${String(ev.kind).padEnd(16)} ${String(ev.admission).padEnd(7)} ${ev.contextItemId.slice(0, 64)} outcome=${ev.outcome}`,
        )
      }
      for (const r of roi.deadWeight.slice(0, 3)) {
        lines.push(
          `  dead ${String(r.kind).padEnd(16)} ${r.contextItemId.slice(0, 64)} served=${fmtNum(r.servedCount)} used=${fmtNum(r.usedCount)}`,
        )
      }
      const { getEvidenceGraphSnapshot } = await import(
        '../../services/contextSignals/index.js'
      )
      const graph = getEvidenceGraphSnapshot(5)
      lines.push(
        `Evidence Graph: enabled=${graph.enabled} persist=${graph.persist.enabled ? 'on' : 'off'} loaded=${graph.persist.loaded} edges=${fmtNum(graph.edgeCount)} relations=${graph.topRelations.map(r => `${r.relation}:${r.count}`).join(', ') || 'none'}`,
      )
      lines.push(`  persist path: ${graph.persist.path}`)
      for (const o of graph.outcomeBySourceKind.slice(0, 3)) {
        lines.push(
          `  outcome ${String(o.sourceKind).padEnd(16)} +${fmtNum(o.positive)} -${fmtNum(o.negative)} ~${fmtNum(o.neutral)} top=${o.topOutcomes.map(t => `${t.outcome}:${t.count}`).join(', ') || 'none'}`,
        )
      }
    } catch { /* ROI/Evidence 展示失败不影响 status */ }
    lines.push('')
  } catch (e) {
    lines.push('### Context Admission Controller (Phase A)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 15. Cross-agent Handoff Manifest —— Phase 60 深化(2026-04-24)
  //     展示最近的主→子 agent 交接:每条含 subagentType + 上下文摘要,
  //     使"raw dump 到底有多 raw"可被观察,为未来 relevance 重排提供数据。
  try {
    const { getHandoffLedgerSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getHandoffLedgerSnapshot()
    const flagSig = process.env.CLAUDE_CODE_CONTEXT_SIGNALS
    lines.push('### Cross-agent Handoff Manifest (Phase 60)')
    lines.push(
      `Enabled: ${snap.enabled}  |  Env: CLAUDE_CODE_CONTEXT_SIGNALS=${flagSig ?? '(default on)'}`,
    )
    lines.push(
      `Tracked: ${fmtNum(snap.count)}/${fmtNum(snap.ringCapacity)} manifest(s)`,
    )
    const typeLabels = Object.entries(snap.byTypeCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, c]) => `${t}=${c}`)
      .join('  ')
    if (typeLabels) lines.push(`by subagentType: ${typeLabels}`)
    if (snap.recent.length === 0) {
      lines.push('(no recent handoffs)')
    } else {
      lines.push('Recent handoffs (newest first):')
      for (const m of snap.recent.slice(0, 5)) {
        const digest = m.contextDigest
        const kinds = digest.byKind
          .slice(0, 4)
          .map(
            k =>
              `${String(k.kind).slice(0, 12)}:${k.servedCount}/${(k.utilizationRate >= 0 ? (k.utilizationRate * 100).toFixed(0) + '%' : '—')}`,
          )
          .join(' ')
        const anchors = digest.topAnchors.slice(0, 3).join(',')
        const desc = (m.description || '').slice(0, 40)
        // Phase 66:return leg 状态 —— pending / ✓N tk (Dms) / ✗err
        // Phase 68:⚡async 单独标出 async_launched/backgrounded placeholder,
        //   提醒"这不是真 ROI,是已派发后台的登记行"。
        let retBadge = ''
        if (m.return) {
          const r = m.return
          if (r.asyncLaunched) {
            retBadge = ` ⚡async (${r.durationMs}ms)`
          } else if (r.success) {
            retBadge = ` ✓${r.resultTokens}tk (${r.durationMs}ms)`
          } else {
            retBadge = ` ✗${r.errorMessage ? r.errorMessage.slice(0, 24) : 'failed'}`
          }
        } else {
          retBadge = ' ⏳pending'
        }
        lines.push(
          `  [${m.handoffId.slice(0, 8)}] ${fmtTs(m.ts)} → ${m.subagentType.padEnd(16)} ${m.promptTokens}tk${retBadge}  budget=${(digest.budgetRatio * 100).toFixed(0)}%  kinds[${kinds}]  anchors[${anchors}]  "${desc}"`,
        )
      }
    }
    // Phase 66(2026-04-24):ROI 聚合 ——
    //   用 totalWithReturn / totalPending / success / avgROI 量化 handoff 的实际回收。
    //   avgRoiRatio > 1 说明"子 agent 收回 > 主 agent 投入",<1 说明开销大于收获。
    // Phase 68(2026-04-24):totalAsyncLaunched 单独列出, 不参与 successRate 分母
    //   和 avg* 平均值 —— 因为 async_launched/backgrounded 是 placeholder,
    //   把 async 掺进去会拖低 success 百分比、拉低 avgResultTokens。
    if (
      snap.roi.totalWithReturn > 0 ||
      snap.roi.totalPending > 0 ||
      snap.roi.totalAsyncLaunched > 0
    ) {
      const r = snap.roi
      // 分母只算闭合的同步 return(success+failure), 不算 asyncLaunched placeholder
      const syncClosed = r.successCount + r.failureCount
      const successRate =
        syncClosed > 0
          ? ((r.successCount / syncClosed) * 100).toFixed(0) + '%'
          : 'n/a'
      const asyncPart =
        r.totalAsyncLaunched > 0 ? ` async=${r.totalAsyncLaunched}` : ''
      lines.push(
        `ROI (Phase 66): closed=${r.totalWithReturn} pending=${r.totalPending}${asyncPart}  success=${successRate}  avg ${r.avgResultTokens}tk/${r.avgDurationMs}ms  avgRoiRatio=${r.avgRoiRatio.toFixed(2)}`,
      )
      const q = snap.quality
      if (q.sampleCount > 0) {
        lines.push(
          `Quality: samples=${q.sampleCount} validation=${q.validationEvidenceCount} file=${q.fileEvidenceCount} command=${q.commandEvidenceCount} all=${q.allEvidenceCount}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Cross-agent Handoff Manifest (Phase 60)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // 16. Per-memory Utility Ledger —— Phase 61(2026-04-24)
  //     把 Phase 54 的 kind 级 auto-memory 口径下钻到 basename 粒度,
  //     展示高命中户(topUsers)和持续赔付(deadWeight),为未来
  //     findRelevantMemories 的历史命中率排序打底。
  try {
    const { getMemoryUtilityLedgerSnapshot } = await import(
      '../../services/contextSignals/index.js'
    )
    const snap = getMemoryUtilityLedgerSnapshot(6)
    const flagSig = process.env.CLAUDE_CODE_CONTEXT_SIGNALS
    lines.push('### Per-memory Utility Ledger (Phase 61)')
    lines.push(
      `Enabled: ${snap.enabled}  |  Env: CLAUDE_CODE_CONTEXT_SIGNALS=${flagSig ?? '(default on)'}`,
    )
    lines.push(
      `Tracked basenames: ${fmtNum(snap.tracked)}  surfaced=${fmtNum(snap.totalSurfaced)}  used=${fmtNum(snap.totalUsed)}  overallUtil=${(snap.overallUtilizationRate * 100).toFixed(0)}%`,
    )
    if (snap.topUsers.length > 0) {
      lines.push('Top users (usedCount / surfacedCount):')
      for (const r of snap.topUsers) {
        const rate = (r.usedCount / Math.max(1, r.surfacedCount)) * 100
        lines.push(
          `  ${r.basename.slice(0, 48).padEnd(48)}  ${r.usedCount}/${r.surfacedCount}  (${rate.toFixed(0)}%)`,
        )
      }
    } else {
      lines.push('Top users: (none — model output has not echoed any surfaced basename yet)')
    }
    if (snap.deadWeight.length > 0) {
      lines.push('Dead weight (surfaced ≥3 times, never used):')
      for (const r of snap.deadWeight) {
        lines.push(
          `  ${r.basename.slice(0, 48).padEnd(48)}  surfaced=${r.surfacedCount}`,
        )
      }
    }
    lines.push('')
  } catch (e) {
    lines.push('### Per-memory Utility Ledger (Phase 61)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // Phase 71(2026-04-24) · Advisor Panel ——
  //   读 Phase 54-70 账本, 把"观察"闭环成"建议"。纯文本输出, 不改任何行为。
  //   规则触发条件严格(样本量门槛 + 严重程度门槛), 空结果时完全不输出该区块,
  //   避免噪声污染 kernel-status 本体。
  // Phase 72(2026-04-24) · 改用 withHistory 版本, 标 🆕 首次出现 / 🔁 连续 ≥3 次。
  try {
    const { generateAdvisoriesWithHistory } = await import(
      '../../services/contextSignals/index.js'
    )
    const advisories = generateAdvisoriesWithHistory()
    if (advisories.length > 0) {
      lines.push('### 🧭 Advisory (Phase 71/72)')
      // high / medium / low 用不同前缀符号, 方便一眼扫
      const iconBySeverity: Record<string, string> = {
        high: '⚠',
        medium: '•',
        low: '·',
      }
      // 排序: high 优先, 同级保持插入序
      const severityRank: Record<string, number> = {
        high: 0,
        medium: 1,
        low: 2,
      }
      const sorted = [...advisories].sort(
        (a, b) =>
          (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3),
      )
      for (const a of sorted) {
        const icon = iconBySeverity[a.severity] ?? '·'
        // Phase 72:streak 视觉标记
        //   streak=1 → 🆕 首次出现
        //   streak≥3 → 🔁 持续烦扰(≥3 次都没处理, 提醒升级)
        //   2 → 无前缀标记, 避免频繁闪烁
        let streakMark = ''
        if (a.streak === 1) streakMark = '🆕 '
        else if (a.streak >= 3) streakMark = `🔁×${a.streak} `
        lines.push(`${icon} [${a.severity}] ${streakMark}${a.message}`)
        lines.push(`    → ${a.suggestedAction}`)
      }
      lines.push('')
    }
  } catch (e) {
    // advisor 出错不影响 kernel-status 本体渲染
    lines.push('### 🧭 Advisory (Phase 71/72)')
    lines.push(`(unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // Phase 99(2026-04-24):contract health 摘要接入 /kernel-status 末尾。
  //   与 Ph98 /evolve-tick 的末尾摘要保持一致:一行三层(L1/L2/L3)评分。
  //   动机:/kernel-status 是高频查看命令,让 advisor contract drift 不必
  //   等到主动跑 /evolve-tick 或 bun run check:contract 才能被看见。
  //   失败静默,不影响 kernel-status 前面主干输出。
  try {
    const { getAdvisoryMiningDiagnostics } = await import(
      '../../services/autoEvolve/emergence/patternMiner.js'
    )
    const fm = getAdvisoryMiningDiagnostics({ topN: 0 }).fusionMapping
    const l1 =
      fm.orphanContractCategories.length === 0 &&
      fm.missingContractCategories.length === 0
    const l2 = fm.unmappedWithEntity === 0
    const l3 = fm.undeclaredEmittedCategories.length === 0
    const passCount = [l1, l2, l3].filter(Boolean).length
    if (passCount === 3) {
      lines.push(
        '### 📐 Advisory Contract Health (Phase 99): L1✓ L2✓ L3✓ (3/3 clean)',
      )
    } else {
      lines.push(
        `### 📐 Advisory Contract Health (Phase 99): ` +
          `L1${l1 ? '✓' : '✗'} L2${l2 ? '✓' : '✗'} L3${l3 ? '✓' : '✗'} ` +
          `(${passCount}/3) ⚠️ drift`,
      )
      lines.push(
        `  → 详情:/evolve-status 或 \`bun run check:contract\``,
      )
    }
    lines.push('')
  } catch {
    // fail-open:健康摘要不 push 任何东西,也不报错
  }

  // G6 Step 2(2026-04-26):Skill-Worthy Candidates 摘要。
  //   目的:procedural memory 里累积的"反复做相同动作"候选,在不跑 /skill-candidates
  //   的时候永远不会被看到。kernel-status 是高频查看入口,这里在**有候选时**
  //   追加一行 summary(N 条 ≥门槛,最高 score 的 task_signature),让用户知道
  //   该不该 /evolve-accept。零候选时完全不打印,避免噪声污染。
  //   门槛沿用 findSkillWorthyCandidates 默认值:minSupport=6 / minRate=0.9 / minConf=0.6。
  //   纯读 procedural memory,不写,不触发任何 promote。
  try {
    const { findSkillWorthyCandidates } = await import(
      '../../services/proceduralMemory/skillCandidateMiner.js'
    )
    const cands = findSkillWorthyCandidates({ limit: 5 })
    if (cands.length > 0) {
      const top = cands[0]!
      lines.push(
        `### 🧬 Skill-Worthy Candidates (G6): ${cands.length} ≥ threshold (support≥6, rate≥0.9, conf≥0.6)`,
      )
      lines.push(
        `  top: "${top.name}" support=${top.support} rate=${(top.successRate * 100).toFixed(0)}% score=${top.score}`,
      )
      lines.push(
        `  → 详情:\`/skill-candidates\`,可 \`/evolve-accept\` 到 canary`,
      )
      lines.push('')
    }
  } catch {
    // fail-open:miner 失败不破坏 kernel-status 输出
  }

  // G5 Step 2(2026-04-26):API Fallback 24h 摘要。
  //   目的:后台 API provider 降级(5xx/529 → 链式切换)在 /api-fallback-check 之外
  //   完全静默,用户不敲就永远不知道。kernel-status 作为高频诊断入口,在
  //   **有降级事件时**打印一行摘要,计数+最近一次 fallbackModel/reason;
  //   零事件完全不打印,避免污染。
  //   纯读 oracle/api-fallback.ndjson,不改任何 retry 行为。
  try {
    const { summarizeFallbackWindow } = await import(
      '../../services/api/fallbackChain.js'
    )
    const summary = summarizeFallbackWindow({ windowHours: 24 })
    if (summary.count > 0) {
      const reasonParts = Object.entries(summary.byReason)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}=${n}`)
        .join(', ')
      lines.push(
        `### 🌐 API Fallback 24h (G5): ${summary.count} event(s) (${reasonParts})`,
      )
      if (summary.lastFallbackModel) {
        lines.push(
          `  last: ${summary.lastFallbackModel} (${summary.lastReason ?? 'unknown'}) @ ${summary.lastAt}`,
        )
      }
      lines.push(`  → 详情:\`/api-fallback-check\``)
      lines.push('')
    }
  } catch {
    // fail-open:摘要失败不破坏 kernel-status 输出
  }

  // G2 Step 2(2026-04-26):Dormant Organisms 摘要。
  //   目的:autoEvolve 5 source 源源不断产 shadow/canary organism,但
  //   "产出后从未被 invoke 过" 的死灵魂在 /evolve-status 大表里混着
  //   几十条活 organism 看不见。它们是两种信号混合体:wire 失败(bug)/
  //   确实没用(该 /fossil 或 /evolve-reset)。kernel-status 在 count>0
  //   时打印一行 breakdown + 最老一条 id + 指引,零 dormant 完全不打印。
  //   age ≥ 24h 才计入,避免刚孵出的 organism 被误报。
  //   纯读 listAllOrganisms → 不改 manifest、不触发 promote/archive。
  try {
    const { summarizeDormantOrganisms } = await import(
      '../../services/autoEvolve/observability/dormantOrganismSummary.js'
    )
    const dormant = summarizeDormantOrganisms({ minAgeHours: 24 })
    if (dormant.totalDormant > 0) {
      const kindParts = Object.entries(dormant.dormantByKind)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')
      const statusParts = Object.entries(dormant.dormantByStatus)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .map(([s, n]) => `${s}=${n}`)
        .join(', ')
      lines.push(
        `### 💤 Dormant Organisms (G2): ${dormant.totalDormant} never-invoked ≥${dormant.minAgeHours}h (${kindParts}; ${statusParts})`,
      )
      const oldest = dormant.samples[0]
      if (oldest) {
        lines.push(
          `  oldest: ${oldest.id} (${oldest.kind}/${oldest.status}, age=${oldest.ageHours}h)`,
        )
      }
      lines.push(
        `  → 详情:\`/organism-invocation-check\` 确认 wire,或 \`/fossil <id>\` 化石化`,
      )
      lines.push('')
    }
  } catch {
    // fail-open:dormant 摘要失败不破坏 kernel-status 输出
  }

  // G3 Step 2(2026-04-26):Tool Bandit 24h 健康摘要。
  //   目的:Step 1 已把每次 tool 调用的 outcome+duration+reward 旁路写 ndjson,
  //   但 /tool-bandit 是主动查询入口,user 不敲就永远不知道某工具在偷偷连错。
  //   kernel-status 作为高频诊断入口,在 24h 内**有异常信号**时打印一行 per-tool
  //   breakdown;零异常完全不打印。
  //   三类判定:consecutive_failures(tail≥5 连 error)/ high_error_rate
  //   (count≥6 且 errorRate≥0.5)/ high_abort_rate(count≥6 且 abortRate≥0.5);
  //   只列最严重那一类;不改 tool 选择 policy(risk>value 保留给未来 Step 3)。
  try {
    const { summarizeToolBanditHealth } = await import(
      '../../services/autoEvolve/observability/toolBanditHealthSummary.js'
    )
    const health = summarizeToolBanditHealth({ windowHours: 24 })
    if (health.troubles.length > 0) {
      const kindParts: Record<string, number> = {}
      for (const t of health.troubles) {
        kindParts[t.kind] = (kindParts[t.kind] ?? 0) + 1
      }
      const breakdown = Object.entries(kindParts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}=${n}`)
        .join(', ')
      lines.push(
        `### 🛠️ Tool Bandit 24h (G3): ${health.troubles.length} tool(s) unhealthy (${breakdown})`,
      )
      const top = health.troubles[0]!
      // 不同 kind 展示不同核心指标,避免死板列所有字段
      const detail =
        top.kind === 'consecutive_failures'
          ? `tail=${top.tailErrorBurst} consecutive error`
          : top.kind === 'high_error_rate'
            ? `error=${top.error}/${top.count} (rate=${top.errorRate})`
            : `abort=${top.abort}/${top.count} (rate=${top.abortRate})`
      lines.push(`  worst: ${top.toolName} — ${top.kind} · ${detail}`)
      lines.push(`  → 详情:\`/tool-bandit\``)
      lines.push('')
    }
  } catch {
    // fail-open:tool-bandit 摘要失败不破坏 kernel-status 输出
  }

  // v1.0 Phase 5.5(2026-04-24):MetaEvolve snapshot 接入 /kernel-status。
  //   目的:让人类在每次查状态时都能看到"种群健康度 + 当前元基因 + 元参数
  //   建议",而不必主动跑 /evolve-status。
  //   Phase 5.6(2026-04-24):advice 行扩展为 per-param:mutationRate +
  //   arenaShadowCount,两条独立 advisor 组合展示。
  //   Phase 5.7(2026-04-24):补齐 learningRate + selectionPressure 两把,
  //   四把 advisor 中 selectionPressure 方向相反(converging→down 放生弱者),
  //   其余三把同向(converging→up 注入探索)。
  //   Phase 5.8(2026-04-24):把 Oracle 权重基因(Phase 27 metaEvolver)并入同一
  //   观察面,展示 current tuned weights + 30d SNR suggestion 摘要,正式补齐
  //   "fitness 权重也是基因" 这条 blueprint 叙事。
  //   数据全部经由 Phase 5.1/5.2/5.4/5.6/5.7/5.8 的只读 API 计算,永不写盘。
  //   fail-open:任何一层失败都降级成一行 "(unavailable ...)",不影响主干。
  try {
    const {
      buildMetaActionPlanSnapshot,
      renderMetaActionPlanLines,
      renderMetaOracleAdviceLines,
      renderMetaParamAdviceLines,
    } = await import('../../services/autoEvolve/metaEvolve/metaActionPlan.js')

    const plan = buildMetaActionPlanSnapshot(30)
    const mg = plan.metaGenome
    const snap = plan.snapshot
    const tunedWeights = plan.oracle.tunedWeights
    const currentWeights = plan.oracle.currentWeights
    const weightSuggestion = plan.oracle.weightSuggestion
    const mutAdvice = plan.paramDecisions[0]
    const shadowAdvice = plan.paramDecisions[1]
    const lrAdvice = plan.paramDecisions[2]
    const spAdvice = plan.paramDecisions[3]

    // verdict 选个 emoji,让 scan 时一眼看出健康与否
    const verdictIcon =
      snap.verdict === 'healthy'
        ? '✅'
        : snap.verdict === 'converging'
          ? '🌀'
          : snap.verdict === 'diverging'
            ? '💥'
            : '⚪'

    lines.push('### 🧬 MetaEvolve (Phase 5.1-5.8)')
    lines.push(
      `  verdict: ${verdictIcon} ${snap.verdict}  ` +
        `(population=${snap.populationSize}, ` +
        `avgFitness=${snap.avgFitness === null ? 'n/a' : snap.avgFitness.toFixed(3)}, ` +
        `diversity=${snap.diversity === null ? 'n/a' : snap.diversity.toFixed(3)}, ` +
        `pareto=${snap.paretoWidth}/${snap.paretoCandidates})`,
    )
    lines.push(`  reason: ${snap.verdictReason}`)
    lines.push(
      `  meta-genome: mutationRate=${mg.mutationRate.toFixed(3)}, ` +
        `learningRate=${mg.learningRate.toFixed(3)}, ` +
        `selectionPressure=${mg.selectionPressure.toFixed(2)}, ` +
        `arenaShadowCount=${mg.arenaShadowCount}`,
    )
    lines.push(
      `  oracle-weights(${tunedWeights ? 'tuned' : 'default'}): ` +
        `user=${currentWeights.userSatisfaction.toFixed(3)}, ` +
        `task=${currentWeights.taskSuccess.toFixed(3)}, ` +
        `code=${currentWeights.codeQuality.toFixed(3)}, ` +
        `perf=${currentWeights.performance.toFixed(3)}`,
    )

    const exploreVotes = plan.exploreVotes
    const stabilizeVotes = plan.stabilizeVotes
    const oracleActionable = plan.oracle.actionable
    const metaMode = plan.metaAdvisor
    // Phase 5.9:在已有票决汇总上叠加 action 闭环,不另造新决策器。
    // 规则尽量复用现有信号:
    //   - 3+ 同向票 → apply <bundle>
    //   - 只有 oracle actionable → apply oracleWeights only
    //   - 仅 1 把偏移 → apply 单参数 only
    //   - 否则 hold/manual-review
    const actionableParamLabels = plan.actionableParamLabels
    const metaAction = plan.metaAction
    lines.push(
      `  metaAdvisor: ${metaMode}` +
        ` (exploreVotes=${exploreVotes}, stabilizeVotes=${stabilizeVotes}, oracleWeights=${oracleActionable ? 'actionable' : 'hold'})`,
    )
    lines.push(`  metaAction: ${metaAction}`)

    // Phase 6.6:把 metaActionPlan 文案也下沉到共享 renderer,避免状态面漂移。
    lines.push(...renderMetaActionPlanLines(plan, { indent: '  ' }))

    lines.push(...renderMetaParamAdviceLines(mutAdvice, { indent: '  ', labelPrefix: 'advice · mutationRate', includeApplyHint: true }))
    lines.push(...renderMetaParamAdviceLines(shadowAdvice, { indent: '  ', labelPrefix: 'advice · arenaShadowCount', includeApplyHint: true }))
    lines.push(...renderMetaParamAdviceLines(lrAdvice, { indent: '  ', labelPrefix: 'advice · learningRate', includeApplyHint: true }))
    lines.push(...renderMetaParamAdviceLines(spAdvice, { indent: '  ', labelPrefix: 'advice · selectionPressure', includeApplyHint: true }))

    lines.push(
      ...renderMetaOracleAdviceLines(plan, {
        indent: '  ',
        labelPrefix: 'advice · oracleWeights',
      }).map((line, idx) => (idx === 1 ? line.replace(/^  apply:/, '    apply:') : line)),
    )

    // v1.0 §6.2 Goodhart #2 — Oracle 权重随机漂移 cadence 提示(2026-04-25)
    //   与 oracleWeights advice 并列展示,帮助用户判断"下一次漂移该不该发"
    //   纯只读,fail-open:ledger 缺失 / import 失败则 skip section。
    try {
      const { buildOracleDriftSummaryLines } = await import(
        '../../services/autoEvolve/oracle/oracleDrift.js'
      )
      const driftLines = buildOracleDriftSummaryLines({
        indent: '  ',
        mutationRate: mg.mutationRate,
      })
      if (driftLines.length > 0) {
        lines.push(...driftLines)
      }
    } catch {
      // fail-open:漂移观察层不影响主 MetaEvolve 展示
    }

    // §6.2 Goodhart 对抗 #3 —— 稀有样本保护(shadow-only)
    //   buildRareSampleSummaryLines 复用:freshAnalyze=false → 只看 ledger 里最新快照
    //   这样 /kernel-status 不会在高频渲染时真去读 fitness.ndjson 重算,
    //   用户要"现算"走 /evolve-rare-check --analyze。
    try {
      const { buildRareSampleSummaryLines } = await import(
        '../../services/autoEvolve/oracle/rareSampleGuard.js'
      )
      const rareLines = buildRareSampleSummaryLines({ indent: '  ' })
      if (rareLines.length > 0) {
        lines.push(...rareLines)
      }
    } catch {
      // fail-open:稀有样本观察层不影响主 MetaEvolve 展示
    }

    // §6.2 三件套综合总结行(drift + rareSample + benchmark 聚合)
    //   compact=true 只一行 verdict + reason,不再展开三源,
    //   想看明细走 /evolve-goodhart-check --detail。
    //   纯只读,失败静默。
    try {
      const { buildGoodhartHealthSummaryLines } = await import(
        '../../services/autoEvolve/oracle/goodhartHealth.js'
      )
      const ghLines = buildGoodhartHealthSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (ghLines.length > 0) {
        lines.push(...ghLines)
      }
    } catch {
      // fail-open
    }
    // §6.2 Goodhart gate 事件统计(2026-04-25):紧跟 health 行,
    //   补答"闸门真实拦/放了多少次",与 advisor 行量纲对齐。
    //   无事件时 buildGoodhartGateSummaryLines 返回 [],不打空行。
    try {
      const { buildGoodhartGateSummaryLines } = await import(
        '../../services/autoEvolve/oracle/goodhartGateLedger.js'
      )
      const gateLines = buildGoodhartGateSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (gateLines.length > 0) {
        lines.push(...gateLines)
      }
    } catch {
      // fail-open
    }

    // §6.3 veto-window 闸门事件统计(2026-04-25 与 Goodhart 对称):
    //   bake 时长是否真的挡住 / 被 bypass / 被 fail-open,advisor 识别
    //   stalled(门槛过严)/ bypass_heavy(操作员总绕)/ fail_open_spike(数据坏)。
    //   无事件时 buildVetoWindowSummaryLines 返回 [],静默。
    try {
      const { buildVetoWindowSummaryLines } = await import(
        '../../services/autoEvolve/oracle/vetoWindowLedger.js'
      )
      const vwLines = buildVetoWindowSummaryLines({
        indent: '  ',
        compact: true,
      })
      if (vwLines.length > 0) {
        lines.push(...vwLines)
      }
    } catch {
      // fail-open
    }

    lines.push('')
  } catch (e) {
    lines.push('### 🧬 MetaEvolve (Phase 5.1-5.8)')
    lines.push(`  (unavailable: ${(e as Error).message})`)
    lines.push('')
  }

  // E-line causalGraph 消费者闭环(2026-04-25):
  //   getCausalGraphSummary + formatCausalGraphSummaryLines 一次读取,
  //   如果 mode=off 且 nodes=0 则直接返回 [],/kernel-status 无新增 section,
  //   保证在没有启用 causalGraph 的用户处体感为零回归。
  //   异常统一 fail-open 返回 [],不影响主状态面。
  try {
    const { formatCausalGraphSummaryLines } = await import('../../services/causalGraph/index.js')
    const cgLines = formatCausalGraphSummaryLines({ indent: '  ', recentLimit: 20 })
    if (cgLines.length > 0) {
      lines.push(...cgLines)
      lines.push('')
    }
  } catch {
    // fail-open:不打印任何东西
  }

  // Shadow cutover readiness one-liner —— 消费者闭环 Ph2:让用户不用
  // 显式 /shadow-promote 也能在 /kernel-status 底部一眼看到"7 条线各自
  // 离 cutover 还有多远"。格式来自 shadowPromote.formatShadowReadinessOneLine,
  // 完全无数据或任何异常时静默(零回归)。
  try {
    const { formatShadowReadinessOneLine } = await import(
      '../../services/shadowPromote/readiness.js'
    )
    const oneLine = await formatShadowReadinessOneLine()
    if (oneLine) {
      lines.push(oneLine)
      lines.push('')
    }
  } catch {
    // fail-open
  }

  onDone(lines.join('\n'))
  return null
}
