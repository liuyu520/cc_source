/**
 * /daily-digest —— self-evolution-kernel v1.0 §6.3 human-interaction 观测层。
 *
 * 每日把 autoEvolve 这一天"做了什么"聚合成 markdown:
 *   - 促销/否决/归档 transition 计数 + top 5
 *   - Fitness top/bottom 各 3(依 score)
 *   - Forbidden zones 审计命中 block/warn 汇总
 *   - Ledger 完整性(promotions/fitness 的 verified/tampered)
 *
 * 铁律:
 *   - 纯只读,不改 ledger / manifest。
 *   - 幂等:同一日期写入同一 .md,后写覆盖前写(human 无需合并)。
 *   - fail-open:数据源炸了,在对应段落打印 "(unavailable: reason)"。
 *   - 不自动补历史日期:只生成传入或今天的这一份。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { recentFitnessScores } from '../oracle/fitnessOracle.js'
import { digestLedgerIntegrity } from '../oracle/signatureVerifier.js'
import { buildOracleDriftSummaryLines } from '../oracle/oracleDrift.js'
import { buildRareSampleSummaryLines } from '../oracle/rareSampleGuard.js'
import { buildGoodhartHealthSummaryLines } from '../oracle/goodhartHealth.js'
// §6.2 Goodhart gate 事件 ledger(2026-04-25 补观测):
// daily-digest 给出当日四类事件 multi-line breakdown,便于早会回顾。
import { buildGoodhartGateSummaryLines } from '../oracle/goodhartGateLedger.js'
// §6.3 veto-window 闸门事件 ledger(2026-04-25 与 Goodhart 对称):
// daily-digest 与 gate 同 section 节奏,multi-line;无事件省略整段。
import { buildVetoWindowSummaryLines } from '../oracle/vetoWindowLedger.js'
import { readRecentTransitions } from '../arena/promotionFsm.js'
import type {
  ForbiddenZoneAuditEvent,
} from '../arena/forbiddenZones.js'
import {
  ensureDir,
  getDailyDigestDir,
  getDailyDigestPath,
  getForbiddenZonesLedgerPath,
} from '../paths.js'
import { logForDebugging } from '../../../utils/debug.js'

/** 取给定 ISO 时间戳的本地 YYYY-MM-DD(UTC 下也可接受;日界取 UTC) */
function toYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 判定一个 iso 时间字符串是否落在某个 YYYY-MM-DD 日(按 UTC 日界) */
function isOnDate(iso: string | undefined, ymd: string): boolean {
  if (!iso) return false
  try {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return false
    return toYmd(d) === ymd
  } catch {
    return false
  }
}

export interface DailyDigestSummary {
  date: string
  promotions: {
    total: number
    byTrigger: Record<string, number>
    byTransition: Record<string, number>
  }
  fitness: {
    total: number
    top: Array<{ organismId?: string; score: number; at: string }>
    bottom: Array<{ organismId?: string; score: number; at: string }>
  }
  forbiddenZones: {
    total: number
    blocked: number
    warned: number
    topRules: Array<{ ruleId: string; count: number }>
  }
  integrity: ReturnType<typeof digestLedgerIntegrity> | { error: string }
}

function readForbiddenZonesAuditForDate(ymd: string): ForbiddenZoneAuditEvent[] {
  const path = getForbiddenZonesLedgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const out: ForbiddenZoneAuditEvent[] = []
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as ForbiddenZoneAuditEvent
        if (isOnDate(ev.at, ymd)) out.push(ev)
      } catch {
        // 坏行跳过
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[dailyDigest] forbidden-zones read failed: ${(e as Error).message}`,
    )
    return []
  }
}

/**
 * 聚合原始数据为结构化 summary(不渲染)。给 JSON 输出与 markdown 渲染共用。
 */
export function buildDailyDigestSummary(date?: string): DailyDigestSummary {
  const ymd = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : toYmd(new Date())

  // ── transitions
  const promotions: DailyDigestSummary['promotions'] = {
    total: 0,
    byTrigger: {},
    byTransition: {},
  }
  try {
    // 扫近 2000 条,过滤 at 落在 ymd 的行。autoEvolve 日常促销不会超过这个量级。
    const all = readRecentTransitions(2000)
    for (const t of all) {
      if (!isOnDate(t.at, ymd)) continue
      promotions.total += 1
      promotions.byTrigger[t.trigger] = (promotions.byTrigger[t.trigger] ?? 0) + 1
      const edge = `${t.from}→${t.to}`
      promotions.byTransition[edge] = (promotions.byTransition[edge] ?? 0) + 1
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] readRecentTransitions failed: ${(e as Error).message}`,
    )
  }

  // ── fitness(取当日的 top/bottom 3)
  const fitness: DailyDigestSummary['fitness'] = {
    total: 0,
    top: [],
    bottom: [],
  }
  try {
    const all = recentFitnessScores(2000)
    const today = all.filter(s => isOnDate(s.scoredAt, ymd))
    fitness.total = today.length
    const sorted = [...today].sort((a, b) => b.score - a.score)
    fitness.top = sorted.slice(0, 3).map(s => ({
      organismId: s.organismId,
      score: s.score,
      at: s.scoredAt,
    }))
    fitness.bottom = sorted
      .slice(-3)
      .reverse()
      .map(s => ({ organismId: s.organismId, score: s.score, at: s.scoredAt }))
  } catch (e) {
    logForDebugging(
      `[dailyDigest] recentFitnessScores failed: ${(e as Error).message}`,
    )
  }

  // ── forbidden zones
  const forbiddenZones: DailyDigestSummary['forbiddenZones'] = {
    total: 0,
    blocked: 0,
    warned: 0,
    topRules: [],
  }
  try {
    const events = readForbiddenZonesAuditForDate(ymd)
    forbiddenZones.total = events.length
    const ruleCounts = new Map<string, number>()
    for (const ev of events) {
      if (ev.verdict === 'block') forbiddenZones.blocked += 1
      else if (ev.verdict === 'warn') forbiddenZones.warned += 1
      for (const hit of ev.hits ?? []) {
        ruleCounts.set(hit.ruleId, (ruleCounts.get(hit.ruleId) ?? 0) + 1)
      }
    }
    forbiddenZones.topRules = [...ruleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ruleId, count]) => ({ ruleId, count }))
  } catch (e) {
    logForDebugging(
      `[dailyDigest] forbiddenZones agg failed: ${(e as Error).message}`,
    )
  }

  // ── integrity
  let integrity: DailyDigestSummary['integrity']
  try {
    integrity = digestLedgerIntegrity()
  } catch (e) {
    integrity = { error: (e as Error).message }
  }

  return {
    date: ymd,
    promotions,
    fitness,
    forbiddenZones,
    integrity,
  }
}

/**
 * 渲染为 markdown。传入 summary 而不是 date,方便测试 / preview 模式复用。
 */
export function renderDailyDigest(summary: DailyDigestSummary): string {
  const lines: string[] = []
  lines.push(`# autoEvolve daily digest — ${summary.date}`)
  lines.push('')
  lines.push('> self-evolution-kernel v1.0 §6.3 observability layer.')
  lines.push('> Read-only aggregation of this UTC day. Idempotent — same day, same file.')
  lines.push('')

  // Promotions
  lines.push('## Promotions / Transitions')
  if (summary.promotions.total === 0) {
    lines.push('_No transitions today._')
  } else {
    lines.push(`**Total:** ${summary.promotions.total}`)
    lines.push('')
    const triggers = Object.entries(summary.promotions.byTrigger).sort(
      (a, b) => b[1] - a[1],
    )
    if (triggers.length > 0) {
      lines.push('**By trigger:**')
      for (const [trg, n] of triggers) lines.push(`- ${trg}: ${n}`)
      lines.push('')
    }
    const edges = Object.entries(summary.promotions.byTransition).sort(
      (a, b) => b[1] - a[1],
    )
    if (edges.length > 0) {
      lines.push('**By edge:**')
      for (const [edge, n] of edges) lines.push(`- ${edge}: ${n}`)
      lines.push('')
    }
  }

  // Fitness
  lines.push('## Fitness')
  if (summary.fitness.total === 0) {
    lines.push('_No fitness scores today._')
  } else {
    lines.push(`**Total scored:** ${summary.fitness.total}`)
    lines.push('')
    lines.push('**Top:**')
    if (summary.fitness.top.length === 0) lines.push('- (none)')
    for (const s of summary.fitness.top) {
      lines.push(
        `- ${s.organismId ?? '(no-id)'}  score=${s.score.toFixed(3)}  at=${s.at}`,
      )
    }
    lines.push('')
    lines.push('**Bottom:**')
    if (summary.fitness.bottom.length === 0) lines.push('- (none)')
    for (const s of summary.fitness.bottom) {
      lines.push(
        `- ${s.organismId ?? '(no-id)'}  score=${s.score.toFixed(3)}  at=${s.at}`,
      )
    }
  }
  lines.push('')

  // Forbidden zones
  lines.push('## Forbidden Zones Audit')
  if (summary.forbiddenZones.total === 0) {
    lines.push('_No forbidden-zone audit events today._')
  } else {
    lines.push(
      `**Events:** ${summary.forbiddenZones.total}  ` +
        `(blocked=${summary.forbiddenZones.blocked}, warned=${summary.forbiddenZones.warned})`,
    )
    if (summary.forbiddenZones.topRules.length > 0) {
      lines.push('')
      lines.push('**Top rules:**')
      for (const r of summary.forbiddenZones.topRules) {
        lines.push(`- ${r.ruleId}: ${r.count}`)
      }
    }
  }
  lines.push('')

  // Oracle Drift (kernel v1.0 §6.2 Goodhart #2) — 2026-04-25
  // 只显示当日有新增 proposal 的行;ledger 缺失或无当日事件 → 整段不渲染
  try {
    const anchorMs = Date.parse(summary.date + 'T12:00:00Z')
    const driftLines = buildOracleDriftSummaryLines({
      todayOnly: true,
      now: Number.isFinite(anchorMs) ? anchorMs : Date.now(),
    })
    if (driftLines.length > 0) {
      lines.push('## Oracle Drift Proposals')
      lines.push(...driftLines)
      lines.push('')
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] oracle drift summary failed: ${(e as Error).message}`,
    )
  }

  // §6.2 #3 Rare-Sample Protection(shadow-only)— 2026-04-25
  //   同 todayOnly 语义:只有当日落过 snapshot 才渲染本 section;
  //   若用户没跑过 /evolve-rare-check --analyze 或后台 hook,全天为空是预期的,
  //   不展示也等于"不打扰"。
  try {
    const anchorMs = Date.parse(summary.date + 'T12:00:00Z')
    const rareLines = buildRareSampleSummaryLines({
      todayOnly: true,
      now: Number.isFinite(anchorMs) ? anchorMs : Date.now(),
    })
    if (rareLines.length > 0) {
      lines.push('## Rare-Sample Protection')
      lines.push(...rareLines)
      lines.push('')
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] rare-sample summary failed: ${(e as Error).message}`,
    )
  }

  // §6.2 三件套综合摘要(drift + rareSample + benchmark)— 2026-04-25
  //   todayOnly=true:只在当日 rareSample 或 drift 有落盘时渲染
  //   compact=false:digest 里展开三源分项,便于每日复盘
  try {
    const anchorMs = Date.parse(summary.date + 'T12:00:00Z')
    const ghLines = buildGoodhartHealthSummaryLines({
      todayOnly: true,
      compact: false,
      now: Number.isFinite(anchorMs) ? anchorMs : Date.now(),
    })
    if (ghLines.length > 0) {
      lines.push('## Goodhart Health (§6.2)')
      lines.push(...ghLines)
      lines.push('')
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] goodhart summary failed: ${(e as Error).message}`,
    )
  }

  // §6.2 Goodhart gate events (2026-04-25 新增):
  //   当日四类事件 breakdown(blocked/bypassed/passed/fail-open),
  //   与 Goodhart Health section 互补 —— health 是"系统当前状态",
  //   gate events 是"闸门真实拦/放了多少次"。只渲染当天事件,
  //   无事件则整个 section 省略(buildGoodhartGateSummaryLines 返回 [])。
  try {
    const anchorMs = Date.parse(summary.date + 'T12:00:00Z')
    const gateLines = buildGoodhartGateSummaryLines({
      todayOnly: true,
      compact: false,
      now: Number.isFinite(anchorMs) ? anchorMs : Date.now(),
    })
    if (gateLines.length > 0) {
      lines.push('## Goodhart Gate Events (§6.2)')
      lines.push(...gateLines)
      lines.push('')
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] goodhart gate summary failed: ${(e as Error).message}`,
    )
  }

  // §6.3 veto-window events (2026-04-25 与 Goodhart gate 对称新增):
  //   与 veto-window 闸门相关的 bake 时长事件。无事件则整个 section 省略。
  try {
    const anchorMs = Date.parse(summary.date + 'T12:00:00Z')
    const vwLines = buildVetoWindowSummaryLines({
      todayOnly: true,
      compact: false,
      now: Number.isFinite(anchorMs) ? anchorMs : Date.now(),
    })
    if (vwLines.length > 0) {
      lines.push('## Veto-Window Events (§6.3)')
      lines.push(...vwLines)
      lines.push('')
    }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] veto-window summary failed: ${(e as Error).message}`,
    )
  }

  // Integrity
  lines.push('## Ledger Integrity')
  const integ = summary.integrity
  if ('error' in integ) {
    lines.push(`_(unavailable: ${integ.error})_`)
  } else {
    lines.push(
      `- promotions.ndjson: total=${integ.promotions.total}  verified=${integ.promotions.verified}  ` +
        `tampered=${integ.promotions.tampered}  unsigned=${integ.promotions.unsigned}  ` +
        `malformed=${integ.promotions.malformed}`,
    )
    lines.push(
      `- fitness.ndjson: total=${integ.fitness.total}  verified=${integ.fitness.verified}  ` +
        `tampered=${integ.fitness.tampered}  unsigned=${integ.fitness.unsigned}  ` +
        `malformed=${integ.fitness.malformed}`,
    )
    if (integ.hasTampering) {
      lines.push('')
      lines.push('⚠ **Tampering detected — see `/evolve-status` Integrity section for samples.**')
    }
  }

  lines.push('')
  lines.push(`_Generated ${new Date().toISOString()}_`)
  return lines.join('\n') + '\n'
}

/**
 * 核心函数:生成并返回 markdown。不写盘,供 --preview 复用。
 */
export function generateDailyDigest(date?: string): string {
  const summary = buildDailyDigestSummary(date)
  return renderDailyDigest(summary)
}

export interface WriteResult {
  path: string
  bytes: number
  overwrote: boolean
}

/**
 * 真写盘版本:幂等,同日覆盖。返回路径与是否是 overwrite。
 *
 * 触发路径:/evolve-daily-digest --apply、graceful shutdown 兜底。
 * fail-open:任何 I/O 异常都不抛出,只返回 bytes=0。
 */
export function writeDailyDigest(date?: string): WriteResult {
  const summary = buildDailyDigestSummary(date)
  const ymd = summary.date
  const md = renderDailyDigest(summary)
  const path = getDailyDigestPath(ymd)
  const overwrote = existsSync(path)
  try {
    ensureDir(getDailyDigestDir())
    writeFileSync(path, md, 'utf8')
    return { path, bytes: Buffer.byteLength(md, 'utf8'), overwrote }
  } catch (e) {
    logForDebugging(
      `[dailyDigest] write failed at ${path}: ${(e as Error).message}`,
    )
    return { path, bytes: 0, overwrote }
  }
}
