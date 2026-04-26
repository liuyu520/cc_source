/**
 * self-evolution-kernel v1.0 §6.2 Goodhart promote-gate 事件 ledger(2026-04-25)。
 *
 * 回答的核心问题:"critical verdict 是否真的挡住了一次晋升 / 是否被 bypass 放行 /
 * 是否因 fail-open 被跳过?"——闸门落地后必须有独立审计流,否则"挡没挡住"
 * 无法回看,advisor 也没法统计。
 *
 * 四类事件(见 GoodhartGateOutcome):
 *   - blocked:   verdict=critical 且未绕行,promote 返回 ok=false
 *   - bypassed:  verdict=critical 但 manual 路径显式 bypass 通过(ledger 留痕)
 *   - passed:    verdict=healthy/watch/alert,闸门放行(采样快照便于统计口径)
 *   - fail-open: computeGoodhartHealth 抛异常,闸门跳过(catch 分支)
 *
 * 架构对齐:
 *   - 与 drift / rare-sample / benchmark / promotions 并列,独立 NDJSON
 *   - 复用 ndjsonLedger.appendJsonLine(10MB 轮换,3 file retention)
 *   - fail-open:文件缺失 → recentGoodhartGateEvents 返回 [],不影响 promote 路径
 *
 * 不做决策:
 *   - 只记录事件,buildGoodhartGateSummaryLines 产生 advisor 级摘要
 *   - 真正的闸门逻辑仍在 arenaController.ts 2.7 段,本模块纯观测
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getGoodhartGateLedgerPath,
  getOracleDir,
} from '../paths.js'
import { appendJsonLine } from './ndjsonLedger.js'
import type { GoodhartVerdict } from './goodhartHealth.js'

/** 晋升阶梯:与 arena 2.7 闸门同义(只挡向上晋升两步) */
export type GoodhartGateStep = 'shadow→canary' | 'canary→stable'

/** 触发源:从 promoteOrganism 入参 trigger 透传 */
export type GoodhartGateTrigger =
  | 'manual-accept'
  | 'auto-oracle'
  | 'auto-age'
  | 'auto-stale'
  | 'auto-rollback'
  | string

/** 四类事件 outcome */
export type GoodhartGateOutcome =
  | 'blocked'
  | 'bypassed'
  | 'passed'
  | 'fail-open'

/** 单条事件结构 */
export interface GoodhartGateEvent {
  /** ISO 时间戳 */
  ts: string
  /** organism id — 便于回溯是哪次晋升尝试 */
  organismId: string
  /** 晋升阶梯 */
  step: GoodhartGateStep
  /** 触发源(auto-&#42;/manual-accept 等) */
  trigger: GoodhartGateTrigger
  /** 本次 outcome */
  outcome: GoodhartGateOutcome
  /**
   * 当时 computeGoodhartHealth 的 verdict(fail-open 时为 'unavailable')
   * 复用 goodhartHealth.ts 的 type,保持跨模块一致
   */
  verdict: GoodhartVerdict
  /** reason 短语(对人可读,便于 daily digest 渲染) */
  reason?: string
  /**
   * 仅 bypassed 事件有效:标记通过什么方式绕的
   *   'flag' = --bypass-goodhart
   *   'env'  = CLAUDE_EVOLVE_BYPASS_GOODHART=on
   *   'both' = 两者同开
   */
  bypassChannel?: 'flag' | 'env' | 'both'
}

/**
 * 追加一条事件。fail-open 返回 false。
 *
 * 调用方(arenaController.ts 2.7 Goodhart 闸门)必须在每个分支都调一次,
 * 否则 passed/blocked 的 event count 就会漏。
 */
export function appendGoodhartGateEvent(evt: GoodhartGateEvent): boolean {
  try {
    ensureDir(getOracleDir())
    return appendJsonLine(getGoodhartGateLedgerPath(), evt)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:goodhartGateLedger] appendGoodhartGateEvent failed: ${
        (e as Error).message
      }`,
    )
    return false
  }
}

/** 读最近 limit 条事件(尾部,时间升序) */
export function recentGoodhartGateEvents(limit = 50): GoodhartGateEvent[] {
  try {
    const path = getGoodhartGateLedgerPath()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return []
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines
    const out: GoodhartGateEvent[] = []
    for (const line of tail) {
      try {
        const obj = JSON.parse(line) as GoodhartGateEvent
        if (obj && typeof obj === 'object' && typeof obj.ts === 'string') {
          out.push(obj)
        }
      } catch {
        // 坏行跳过
      }
    }
    return out
  } catch (e) {
    logForDebugging(
      `[autoEvolve:goodhartGateLedger] recentGoodhartGateEvents read failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
}

/** 对外聚合:四类 count + 最近一条时间 */
export interface GoodhartGateStats {
  total: number
  blocked: number
  bypassed: number
  passed: number
  failOpen: number
  /** 最近一条事件 ts(ISO)— 无则 null */
  lastTs: string | null
  /** 最近一条 outcome — 无则 null */
  lastOutcome: GoodhartGateOutcome | null
}

/**
 * 对 recentGoodhartGateEvents 做聚合统计。
 *
 * opts.todayOnly: 仅统计当天(UTC)的事件。daily-digest 用。
 * opts.anchorMs:  todayOnly 的"当天"锚点毫秒数(默认 Date.now())
 */
export function computeGoodhartGateStats(opts?: {
  limit?: number
  todayOnly?: boolean
  anchorMs?: number
}): GoodhartGateStats {
  const events = recentGoodhartGateEvents(opts?.limit ?? 200)
  let filtered = events
  if (opts?.todayOnly) {
    const anchor = opts.anchorMs ?? Date.now()
    const dayStart = new Date(anchor)
    dayStart.setUTCHours(0, 0, 0, 0)
    const dayEnd = new Date(anchor)
    dayEnd.setUTCHours(23, 59, 59, 999)
    const startMs = dayStart.getTime()
    const endMs = dayEnd.getTime()
    filtered = events.filter(e => {
      const t = Date.parse(e.ts)
      return Number.isFinite(t) && t >= startMs && t <= endMs
    })
  }
  const stats: GoodhartGateStats = {
    total: filtered.length,
    blocked: 0,
    bypassed: 0,
    passed: 0,
    failOpen: 0,
    lastTs: null,
    lastOutcome: null,
  }
  for (const e of filtered) {
    if (e.outcome === 'blocked') stats.blocked++
    else if (e.outcome === 'bypassed') stats.bypassed++
    else if (e.outcome === 'passed') stats.passed++
    else if (e.outcome === 'fail-open') stats.failOpen++
  }
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1]!
    stats.lastTs = last.ts
    stats.lastOutcome = last.outcome
  }
  return stats
}

/**
 * Advisory 判定:从 gate ledger 里识别"需要人注意"的异常模式(2026-04-25)。
 *
 * 为什么要做:
 *   纯数字统计("blocked=3")靠用户自己判断"是不是该 remediate";
 *   advisory 把数字翻译成行动建议,与 §6.2 其它模块的 advisor 行风格一致。
 *
 * 三种模式(优先级 stalled > fail_open_spike > bypass_heavy,只返一种):
 *
 *   1. stalled          —— blocked≥3 且 bypassed=0 且 passed≤blocked
 *                          "连续挡,没人 bypass,也没有一次成功过"——典型"忘了 remediate"。
 *   2. fail_open_spike  —— failOpen≥2
 *                          "gate 自身频繁抛异常"——要么 computeGoodhartHealth 坏了,
 *                          要么 ledger I/O 异常;比 bypass_heavy 更危险(闸门形同虚设)。
 *   3. bypass_heavy     —— bypassed > blocked 且 bypassed≥2
 *                          "bypass 次数多于 block"——有可能是在"习惯性绕行",
 *                          advisor 只提醒"留意审计",不下 veto 结论。
 *
 * 规则都是保守阈值,窗口默认覆盖最近 24h 事件(anchorMs 可注入给 probe)。
 * 返回 kind='none' 表示"无需告警",调用方不渲染 advisory 行。
 *
 * 纯读,失败 fail-open 返回 'none'。
 */
export type GoodhartGateAdvisoryKind =
  | 'none'
  | 'stalled'
  | 'bypass_heavy'
  | 'fail_open_spike'

export interface GoodhartGateAdvisory {
  kind: GoodhartGateAdvisoryKind
  /** 对人可读说明 */
  message: string
  /** 参考统计 */
  stats: GoodhartGateStats
  /** 窗口描述("last 24h" / "today") */
  windowLabel: string
}

export function detectGoodhartGateAdvisory(opts?: {
  /** 窗口小时数(默认 24);传 0 表示用 todayOnly */
  windowHours?: number
  /** 与 computeGoodhartGateStats.todayOnly 一致。传 true 时忽略 windowHours */
  todayOnly?: boolean
  now?: number
}): GoodhartGateAdvisory {
  const anchor = opts?.now ?? Date.now()
  const todayOnly = opts?.todayOnly ?? false
  const windowHours = opts?.windowHours ?? 24
  let stats: GoodhartGateStats
  try {
    if (todayOnly) {
      stats = computeGoodhartGateStats({ todayOnly: true, anchorMs: anchor })
    } else {
      // 24h 窗口:先拉足够多的事件,再自己按 ts 过滤
      const events = recentGoodhartGateEvents(500)
      const cutoff = anchor - windowHours * 60 * 60 * 1000
      const filtered = events.filter(e => {
        const t = Date.parse(e.ts)
        return Number.isFinite(t) && t >= cutoff
      })
      stats = {
        total: filtered.length,
        blocked: 0,
        bypassed: 0,
        passed: 0,
        failOpen: 0,
        lastTs: null,
        lastOutcome: null,
      }
      for (const e of filtered) {
        if (e.outcome === 'blocked') stats.blocked++
        else if (e.outcome === 'bypassed') stats.bypassed++
        else if (e.outcome === 'passed') stats.passed++
        else if (e.outcome === 'fail-open') stats.failOpen++
      }
      if (filtered.length > 0) {
        const last = filtered[filtered.length - 1]!
        stats.lastTs = last.ts
        stats.lastOutcome = last.outcome
      }
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:goodhartGateLedger] detectGoodhartGateAdvisory failed: ${
        (e as Error).message
      }`,
    )
    return {
      kind: 'none',
      message: '',
      stats: {
        total: 0,
        blocked: 0,
        bypassed: 0,
        passed: 0,
        failOpen: 0,
        lastTs: null,
        lastOutcome: null,
      },
      windowLabel: todayOnly ? 'today' : `last ${windowHours}h`,
    }
  }
  const windowLabel = todayOnly ? 'today' : `last ${windowHours}h`
  // 优先级 stalled > fail_open_spike > bypass_heavy
  if (stats.blocked >= 3 && stats.bypassed === 0 && stats.passed <= stats.blocked) {
    return {
      kind: 'stalled',
      message:
        `Goodhart gate stalled: ${stats.blocked} blocked, 0 bypassed, ` +
        `${stats.passed} passed in ${windowLabel}. ` +
        `Remediate via /evolve-drift-check --propose, /evolve-rare-check, /evolve-bench; ` +
        `do NOT just bypass without fixing the verdict driver.`,
      stats,
      windowLabel,
    }
  }
  if (stats.failOpen >= 2) {
    return {
      kind: 'fail_open_spike',
      message:
        `Goodhart gate fail-open spike: ${stats.failOpen} evaluation errors in ${windowLabel}. ` +
        `computeGoodhartHealth may be broken — check recent logs and /evolve-goodhart-check --detail.`,
      stats,
      windowLabel,
    }
  }
  if (stats.bypassed > stats.blocked && stats.bypassed >= 2) {
    return {
      kind: 'bypass_heavy',
      message:
        `Goodhart gate bypass_heavy: ${stats.bypassed} bypassed vs ${stats.blocked} blocked in ${windowLabel}. ` +
        `Audit bypass rationales in transition ledger; repeated bypass signals the verdict source needs attention, not more overrides.`,
      stats,
      windowLabel,
    }
  }
  return {
    kind: 'none',
    message: '',
    stats,
    windowLabel,
  }
}

/**
 * 三观测点共享的摘要渲染器。
 *
 * opts.indent:   每行前缀(/kernel-status 用 '  ',daily-digest 顶格用 '')
 * opts.compact:  true → 一行概要;false → 多行详解
 * opts.todayOnly:true → 仅当天事件(daily-digest);false → 最近 200 条
 * opts.now:      固定时间(probe 注入)
 *
 * 无事件时返回 [](调用方做空判断,避免打空 section)。
 */
export function buildGoodhartGateSummaryLines(opts?: {
  indent?: string
  compact?: boolean
  todayOnly?: boolean
  now?: number
}): string[] {
  const indent = opts?.indent ?? ''
  const compact = opts?.compact ?? false
  const todayOnly = opts?.todayOnly ?? false
  const anchorMs = opts?.now ?? Date.now()
  let stats: GoodhartGateStats
  try {
    stats = computeGoodhartGateStats({ todayOnly, anchorMs })
  } catch (e) {
    logForDebugging(
      `[autoEvolve:goodhartGateLedger] buildGoodhartGateSummaryLines failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
  if (stats.total === 0) return []
  const scopeTag = todayOnly ? 'today' : 'recent'
  const lines: string[] = []
  if (compact) {
    // 一行概要:适合 /kernel-status 末尾追加
    lines.push(
      `${indent}- Goodhart gate (${scopeTag}): ` +
        `blocked=${stats.blocked}, bypassed=${stats.bypassed}, ` +
        `passed=${stats.passed}, fail-open=${stats.failOpen}` +
        (stats.lastOutcome
          ? ` · last=${stats.lastOutcome}${stats.lastTs ? `@${stats.lastTs}` : ''}`
          : ''),
    )
    // compact 模式下 advisory 跟紧概要,同样一行;kind='none' 时 detectGoodhartGateAdvisory
    // 会返回空 message,此处不推送。
    try {
      const adv = detectGoodhartGateAdvisory({
        todayOnly,
        now: anchorMs,
      })
      if (adv.kind !== 'none') {
        lines.push(`${indent}  ${badgeForAdvisory(adv.kind)} ${adv.message}`)
      }
    } catch {
      // fail-open:advisory 失败不影响 compact 概要行
    }
  } else {
    // 多行详解:给 daily-digest
    lines.push(`${indent}- Goodhart gate events (${scopeTag}):`)
    lines.push(`${indent}  total:     ${stats.total}`)
    lines.push(`${indent}  blocked:   ${stats.blocked}`)
    lines.push(`${indent}  bypassed:  ${stats.bypassed}`)
    lines.push(`${indent}  passed:    ${stats.passed}`)
    lines.push(`${indent}  fail-open: ${stats.failOpen}`)
    if (stats.lastOutcome && stats.lastTs) {
      lines.push(`${indent}  last:      ${stats.lastOutcome} @ ${stats.lastTs}`)
    }
    // 统一 advisory:取代原先 blocked / bypassed 两条固定文案。
    // advisory 三类之外,若只是"blocked 偶发"或"bypassed 偶发"也仍给一条提示。
    try {
      const adv = detectGoodhartGateAdvisory({
        todayOnly,
        now: anchorMs,
      })
      if (adv.kind !== 'none') {
        lines.push(`${indent}  advisory:  ${badgeForAdvisory(adv.kind)} ${adv.message}`)
      } else {
        // 兜底保留原计数行,便于"有 blocked 但未到 stalled 阈值"也有提示
        if (stats.blocked > 0) {
          lines.push(
            `${indent}  advisor:   ${stats.blocked} promotion(s) blocked; ` +
              `run /evolve-drift-check --propose, /evolve-rare-check, /evolve-bench to remediate.`,
          )
        }
        if (stats.bypassed > 0) {
          lines.push(
            `${indent}  advisor:   ${stats.bypassed} bypass(es) recorded — ` +
              `review rationales in transition ledger for audit trail.`,
          )
        }
      }
    } catch {
      // fail-open
    }
  }
  return lines
}

/** advisory kind → emoji badge(ASCII-free 用户友好) */
function badgeForAdvisory(kind: GoodhartGateAdvisoryKind): string {
  switch (kind) {
    case 'stalled':
      return '⚠️  stalled:'
    case 'bypass_heavy':
      return '🔁 bypass_heavy:'
    case 'fail_open_spike':
      return '🧯 fail_open_spike:'
    default:
      return ''
  }
}
