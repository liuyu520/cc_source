/**
 * veto-window 闸门 ledger(self-evolution-kernel v1.0 §6.3 人工交互门)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 2026-04-25 新增。与 goodhartGateLedger(§6.2)完全对称——两者都是
 * promoteOrganism 路径上的"观察 ≥2 个红线被触发 / 是否被 bypass / 是否
 * fail-open"专用审计流,但语义不同:
 *   - goodhart-gate.ndjson : computeGoodhartHealth verdict=critical 闸门
 *   - veto-window.ndjson   : shadow→canary (24h) / canary→stable (72h) bake 时长闸门
 *
 * 为什么需要独立 ledger:
 *   - promotions.ndjson 只记录最终 ok/reason,回看不到"本次 bake 时长差多少";
 *   - 如果用户总在 ageMs 差 1h 的时候 --bypass-veto,这是个明显的门槛过严信号,
 *     没有 ledger 与 advisor 就看不到这个模式。
 *
 * 四类事件(与 Goodhart 对齐):
 *   blocked   — ageMs < requiredMs 且未 bypass,promote 返回 veto_window_not_met
 *   bypassed  — ageMs < requiredMs 但 --bypass-veto / env 放行通过
 *   passed    — ageMs ≥ requiredMs,闸门放行(采样快照)
 *   fail-open — createdAtMs 解析失败或 try/catch 分支(fallthrough 视为 passed,
 *               但单独打标便于 advisor)
 *
 * 架构对齐:
 *   - 独立 NDJSON,与 goodhart-gate.ndjson 并列
 *   - 复用 ndjsonLedger.appendJsonLine(10MB 轮换,3 file retention)
 *   - fail-open:文件缺失 → recentVetoWindowEvents 返回 [],不影响 promote 路径
 *
 * 不做决策:
 *   - 只记录事件,buildVetoWindowSummaryLines 产生 advisor 级摘要
 *   - 真正的闸门逻辑仍在 arenaController.ts 2.6 段,本模块纯观测
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureDir,
  getOracleDir,
  getVetoWindowLedgerPath,
} from '../paths.js'
import { appendJsonLine } from './ndjsonLedger.js'

/** 两档晋升阶梯:只对"向上升"计数(drop 类 down-step 不挂 veto-window) */
export type VetoWindowStep = 'shadow→canary' | 'canary→stable'

/** 触发源:从 promoteOrganism 入参 trigger 透传(与 Goodhart 对齐) */
export type VetoWindowTrigger =
  | 'manual-accept'
  | 'auto-oracle'
  | 'auto-age'
  | 'auto-stale'
  | 'auto-rollback'
  | string

/** 四类事件 outcome(与 goodhartGateLedger 对齐) */
export type VetoWindowOutcome =
  | 'blocked'
  | 'bypassed'
  | 'passed'
  | 'fail-open'

/** 单条事件结构 */
export interface VetoWindowEvent {
  /** ISO 时间戳 */
  ts: string
  /** organism id — 便于回溯是哪次晋升尝试 */
  organismId: string
  /** 晋升阶梯 */
  step: VetoWindowStep
  /** 触发源 */
  trigger: VetoWindowTrigger
  /** 本次 outcome */
  outcome: VetoWindowOutcome
  /** 当时 ageMs(ms)— 便于 advisor 判断"差多少就过阈值" */
  ageMs?: number
  /** 当时 requiredMs(ms)— 冗余但便于单条回放 */
  requiredMs?: number
  /** reason 短语(对人可读) */
  reason?: string
  /**
   * 仅 bypassed 事件有效:标记通过什么方式绕的
   *   'flag' = --bypass-veto
   *   'env'  = CLAUDE_EVOLVE_BYPASS_VETO=on
   *   'both' = 两者同开
   */
  bypassChannel?: 'flag' | 'env' | 'both'
}

/**
 * 追加一条事件。fail-open 返回 false。
 *
 * 调用方(arenaController.ts 2.6 veto-window 闸门)必须在每个分支都调一次。
 */
export function appendVetoWindowEvent(evt: VetoWindowEvent): boolean {
  try {
    ensureDir(getOracleDir())
    return appendJsonLine(getVetoWindowLedgerPath(), evt)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:vetoWindowLedger] appendVetoWindowEvent failed: ${
        (e as Error).message
      }`,
    )
    return false
  }
}

/** 读最近 limit 条事件(尾部,时间升序) */
export function recentVetoWindowEvents(limit = 50): VetoWindowEvent[] {
  try {
    const path = getVetoWindowLedgerPath()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    if (!fs.existsSync(path)) return []
    const raw = fs.readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const tail = lines.length > limit ? lines.slice(lines.length - limit) : lines
    const out: VetoWindowEvent[] = []
    for (const line of tail) {
      try {
        const obj = JSON.parse(line) as VetoWindowEvent
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
      `[autoEvolve:vetoWindowLedger] recentVetoWindowEvents read failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
}

/** 对外聚合:四类 count + 最近一条 */
export interface VetoWindowStats {
  total: number
  blocked: number
  bypassed: number
  passed: number
  failOpen: number
  lastTs: string | null
  lastOutcome: VetoWindowOutcome | null
}

/**
 * 统计四类 outcome(今日 / 最近 N 条)。fail-open 时返回全零 + null。
 */
export function computeVetoWindowStats(opts?: {
  limit?: number
  todayOnly?: boolean
  anchorMs?: number
}): VetoWindowStats {
  const events = recentVetoWindowEvents(opts?.limit ?? 200)
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
  const stats: VetoWindowStats = {
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
 * Advisory kinds:与 Goodhart gate 对称命名,语义微调:
 *   stalled         - blocked≥3 且 bypassed=0 && passed≤blocked: bake 时长可能过长
 *   bypass_heavy    - bypassed > blocked && bypassed ≥ 2: 门槛形同虚设
 *   fail_open_spike - failOpen ≥ 2: 数据损坏,闸门 drive 盲
 *   none            - 无异常
 */
export type VetoWindowAdvisoryKind =
  | 'stalled'
  | 'bypass_heavy'
  | 'fail_open_spike'
  | 'none'

export interface VetoWindowAdvisory {
  kind: VetoWindowAdvisoryKind
  message: string
  stats: VetoWindowStats
  windowLabel: string
}

/**
 * Advisory 判定:识别"需要人注意"的异常模式。
 * 优先级:stalled > fail_open_spike > bypass_heavy(比 Goodhart 同序)。
 *
 * 消费方(advisor/summary)只需看 kind,不需要重新计算原始统计。
 */
export function detectVetoWindowAdvisory(opts?: {
  windowHours?: number
  todayOnly?: boolean
  now?: number
}): VetoWindowAdvisory {
  const anchor = opts?.now ?? Date.now()
  const todayOnly = opts?.todayOnly ?? false
  const windowHours = opts?.windowHours ?? 24
  let stats: VetoWindowStats
  try {
    if (todayOnly) {
      stats = computeVetoWindowStats({ todayOnly: true, anchorMs: anchor })
    } else {
      const events = recentVetoWindowEvents(500)
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
      `[autoEvolve:vetoWindowLedger] detectVetoWindowAdvisory failed: ${
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

  // 1. stalled:blocked 持续挡,既无人绕也没挺过去 → bake 时长过长
  if (stats.blocked >= 3 && stats.bypassed === 0 && stats.passed <= stats.blocked) {
    return {
      kind: 'stalled',
      message:
        `${stats.blocked} promotion(s) blocked by veto-window in ${windowLabel} ` +
        `with no bypass and ≤${stats.passed} passed; bake thresholds may be too long — ` +
        `tune via /evolve-tune-promotion (AGE_DAYS) or wait it out.`,
      stats,
      windowLabel,
    }
  }
  // 2. fail_open_spike:数据异常 → 闸门瞎子
  if (stats.failOpen >= 2) {
    return {
      kind: 'fail_open_spike',
      message:
        `${stats.failOpen} veto-window fail-open event(s) in ${windowLabel} ` +
        `(createdAtMs unparsable etc.); promote path is running blind — ` +
        `check organism records / cold-start snapshots.`,
      stats,
      windowLabel,
    }
  }
  // 3. bypass_heavy:bypass 比 blocked 还多 → 门槛形同虚设
  if (stats.bypassed > stats.blocked && stats.bypassed >= 2) {
    return {
      kind: 'bypass_heavy',
      message:
        `${stats.bypassed} veto-window bypass(es) exceed ${stats.blocked} block(s) in ${windowLabel}; ` +
        `operator is consistently overriding bake floor — review /evolve-accept ` +
        `audit trail and consider reducing bake thresholds.`,
      stats,
      windowLabel,
    }
  }
  return { kind: 'none', message: '', stats, windowLabel }
}

/**
 * 单行/多行摘要构造器:与 goodhartGateLedger.buildGoodhartGateSummaryLines 对齐。
 *
 *   compact=true  → 单行;适合 /kernel-status /evolve-status 末尾
 *   compact=false → 多行;适合 daily-digest
 *
 * fail-open:任何异常都返回 []。
 */
export function buildVetoWindowSummaryLines(opts?: {
  indent?: string
  compact?: boolean
  todayOnly?: boolean
  now?: number
}): string[] {
  const indent = opts?.indent ?? ''
  const compact = opts?.compact ?? false
  const todayOnly = opts?.todayOnly ?? false
  const anchorMs = opts?.now ?? Date.now()
  let stats: VetoWindowStats
  try {
    stats = computeVetoWindowStats({ todayOnly, anchorMs })
  } catch (e) {
    logForDebugging(
      `[autoEvolve:vetoWindowLedger] buildVetoWindowSummaryLines failed: ${
        (e as Error).message
      }`,
    )
    return []
  }
  if (stats.total === 0) return []
  const scopeTag = todayOnly ? 'today' : 'recent'
  const lines: string[] = []
  if (compact) {
    lines.push(
      `${indent}- Veto-window (${scopeTag}): ` +
        `blocked=${stats.blocked}, bypassed=${stats.bypassed}, ` +
        `passed=${stats.passed}, fail-open=${stats.failOpen}` +
        (stats.lastOutcome
          ? ` · last=${stats.lastOutcome}${stats.lastTs ? `@${stats.lastTs}` : ''}`
          : ''),
    )
    try {
      const adv = detectVetoWindowAdvisory({ todayOnly, now: anchorMs })
      if (adv.kind !== 'none') {
        lines.push(`${indent}  ${badgeForAdvisory(adv.kind)} ${adv.message}`)
      }
    } catch {
      // fail-open:advisory 失败不影响 compact 概要
    }
  } else {
    lines.push(`${indent}- Veto-window events (${scopeTag}):`)
    lines.push(`${indent}  total:     ${stats.total}`)
    lines.push(`${indent}  blocked:   ${stats.blocked}`)
    lines.push(`${indent}  bypassed:  ${stats.bypassed}`)
    lines.push(`${indent}  passed:    ${stats.passed}`)
    lines.push(`${indent}  fail-open: ${stats.failOpen}`)
    if (stats.lastOutcome && stats.lastTs) {
      lines.push(`${indent}  last:      ${stats.lastOutcome} @ ${stats.lastTs}`)
    }
    try {
      const adv = detectVetoWindowAdvisory({ todayOnly, now: anchorMs })
      if (adv.kind !== 'none') {
        lines.push(`${indent}  advisory:  ${badgeForAdvisory(adv.kind)} ${adv.message}`)
      } else {
        if (stats.blocked > 0) {
          lines.push(
            `${indent}  advisor:   ${stats.blocked} promotion(s) blocked by bake floor; ` +
              `wait for age to mature or use /evolve-accept --bypass-veto (manual only).`,
          )
        }
        if (stats.bypassed > 0) {
          lines.push(
            `${indent}  advisor:   ${stats.bypassed} bypass(es) recorded — ` +
              `review transition ledger for audit trail.`,
          )
        }
      }
    } catch {
      // fail-open
    }
  }
  return lines
}

/** advisory kind → emoji badge(与 Goodhart 保持相同符号语义) */
function badgeForAdvisory(kind: VetoWindowAdvisoryKind): string {
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
