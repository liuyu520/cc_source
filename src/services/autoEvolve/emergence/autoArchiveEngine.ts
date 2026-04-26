/**
 * autoArchiveEngine — Phase 8 + Phase 10
 *
 * 职责(两条扫描路径,共用同一套决策/应用框架):
 *   [Phase 8] auto-age:扫描 shadow + proposal,对 `expiresAt < now` 的
 *                       调 promoteOrganism(trigger='auto-age') → archived
 *   [Phase 10] auto-stale:扫描 stable,对 lastInvokedAt/createdAt
 *                       已超过 STALE_STABLE_UNUSED_DAYS 没被调用的,
 *                       调 promoteOrganism(trigger='auto-stale') → archived
 *                       (只要年龄 ≥ STALE_STABLE_MIN_AGE_DAYS,防刚晋升就被割)
 *
 * 复用纪律(遵循用户"举一反三、尽可能复用已有逻辑"指令):
 *   - FSM 路径仍走 promoteOrganism → 已经包好了 isTransitionAllowed
 *     + moveOrganism + 签名 recordTransition + readOrganism 回读
 *     (FSM ALLOWED 表 L54 早已允许 stable→archived,零 FSM 改动)
 *   - TransitionTrigger 'auto-age'/'auto-stale' 都是 Phase 1/10 在 types.ts
 *     的合法值,ledger 格式不变
 *   - 与 autoPromotionEngine.ts 同构:
 *       evaluateAutoArchive(纯函数,只读)
 *       applyAutoArchive({ dryRun })(写路径,默认 dryRun=true)
 *     /evolve-tick 一并串入、/evolve-status 一并展示,不新增命令
 *   - lastInvokedAt 字段由 Phase 5 recordOrganismInvocation 原子写入,
 *     本模块只读不写
 *
 * 范围:
 *   - Phase 8 扫 shadow + proposal(非生产路径但 FSM 合法)的过期 TTL
 *   - Phase 10 扫 stable 的长期未调用(status='stable' 的 organism
 *     在 Phase 9 后 expiresAt 永远为 null,不会被 Phase 8 路径误伤)
 *   - vetoed/archived 是终态,FSM 禁出迁,不扫
 *
 * 安全闸门:
 *   - dryRun=true 时只算,不写 ledger、不 moveOrganism
 *   - 写路径由 /evolve-tick --apply 的 CLAUDE_EVOLVE=on 共同守卫
 *     (本模块不直接读 featureCheck,让调用方决定,和 autoPromotion 一致)
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  listOrganismIds,
  readOrganism,
  promoteOrganism,
  type PromotionResult,
} from '../arena/arenaController.js'
import type {
  OrganismManifest,
  OrganismStatus,
  TransitionTrigger,
} from '../types.js'
// Phase 38:archive 阈值自调。autoArchiveEngine 每次 evaluate 都读这个
// mtime-cached 的 JSON,文件缺失 → fallback 到 DEFAULT(= 原硬编码 45/14)。
import { loadTunedArchiveThresholds } from './archiveThresholdTuner.js'

/** Phase 8:auto-age 扫描范围(FSM 允许迁到 archived 的非终态上游) */
const ARCHIVABLE_SOURCE_STATUSES: OrganismStatus[] = ['shadow', 'proposal']

/** Phase 10:auto-stale 扫描范围(目前仅 stable,保留可扩展) */
const STALE_SOURCE_STATUSES: OrganismStatus[] = ['stable']

/**
 * Phase 10:stable 长期未调用阈值(天)。
 *
 * 判定口径:
 *   - lastInvokedAt != null:now - lastInvokedAt > 阈值 → stale
 *   - lastInvokedAt == null:now - createdAt     > 阈值 → stale
 *     (从未被调用过,等同于"自诞生起就没用过")
 *
 * 45d 比 Phase 9 canary 的 60d 观察窗口略短,语义是:
 *   一个合格的 stable skill 每个季度至少该被触发一次;
 *   45d 里连一次调用都没积累,说明已经被更好的替代/遗忘了。
 */
export const STALE_STABLE_UNUSED_DAYS = 45

/**
 * Phase 10:stable 归档宽限期(天)。
 *
 * 只对 createdAt ≥ 此阈值的 stable 应用 auto-stale,
 * 防止"刚晋升成 stable 就被 auto-stale 反复收割"的抖动。
 * 14d 覆盖掉典型 canary 观察窗口(Phase 9 canary=60d,但 canary→stable
 * 需要 ≥3d 就绪 + 10 次调用,真正"新鲜" stable 的样本还很少)。
 */
export const STALE_STABLE_MIN_AGE_DAYS = 14

export type ArchiveAction = 'archive' | 'skip'

export interface ArchiveDecision {
  organismId: string
  action: ArchiveAction
  from: OrganismStatus
  /** Phase 10:承载 trigger 让 apply 层按 decision 分流,不在 apply 硬编码 */
  trigger: TransitionTrigger
  reason: string
  metrics: {
    /** manifest.expiresAt 原值(可能为 null) */
    expiresAt: string | null
    /** 创建至今的天数(来自 createdAt,一定 ≥0) */
    ageDays: number
    /**
     * 已过期的天数 = now - expiresAt(天)。
     * - 未到期/expiresAt 为 null → 0(调用方看 action=skip 判定)
     * - 已过期 → >0
     */
    overdueDays: number
    /**
     * Phase 10:距上次调用的天数。
     * - lastInvokedAt == null → 用 ageDays 兜底(含义:从未调用过)
     * - 否则 = (now - lastInvokedAt)/86400
     */
    daysSinceLastInvoke: number
  }
}

export interface ArchiveApplyResult {
  decisions: ArchiveDecision[]
  /** 成功 archived(action=archive 且 dryRun=false) */
  archived: Array<{ decision: ArchiveDecision; result: PromotionResult }>
  /** action=skip 的决策 */
  skipped: ArchiveDecision[]
}

// ── 工具 ─────────────────────────────────────────────

function ageDays(createdAt: string): number {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86400_000
}

/** 负值 = 还没到期(距过期还有 |overdueDays| 天);正值 = 已过期 */
function overdueDays(expiresAt: string | null): number {
  if (!expiresAt) return 0
  const t = new Date(expiresAt).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86400_000
}

/**
 * Phase 10:距上次调用的天数。
 * 从未调用过(lastInvokedAt 为 null/undefined)时返回 createdAt 至今天数,
 * 让 decideByStale 可以用单一数值比较阈值。
 */
function daysSinceLastInvoke(m: OrganismManifest): number {
  const raw = m.lastInvokedAt
  if (!raw) return ageDays(m.createdAt)
  const t = new Date(raw).getTime()
  if (Number.isNaN(t)) return ageDays(m.createdAt)
  return (Date.now() - t) / 86400_000
}

/**
 * Phase 8 决策:基于 expiresAt 的 auto-age 路径。
 * 仅面向 shadow/proposal(外层 ARCHIVABLE_SOURCE_STATUSES 限定)。
 */
function decideByExpiresAt(m: OrganismManifest): ArchiveDecision {
  const age = ageDays(m.createdAt)
  const overdue = overdueDays(m.expiresAt)
  const dsli = daysSinceLastInvoke(m)
  const base = {
    organismId: m.id,
    from: m.status,
    trigger: 'auto-age' as const,
    metrics: {
      expiresAt: m.expiresAt,
      ageDays: age,
      overdueDays: overdue,
      daysSinceLastInvoke: dsli,
    },
  }
  if (!m.expiresAt) {
    return {
      ...base,
      action: 'skip',
      reason: `no_ttl: expiresAt=null — not eligible for auto-age`,
    }
  }
  if (overdue <= 0) {
    return {
      ...base,
      action: 'skip',
      reason: `not_expired: expiresAt=${m.expiresAt} (in ${(-overdue).toFixed(1)}d)`,
    }
  }
  return {
    ...base,
    action: 'archive',
    reason: `auto-age: expired ${overdue.toFixed(1)}d past expiresAt=${m.expiresAt} (age=${age.toFixed(1)}d)`,
  }
}

/**
 * Phase 10 决策:基于 lastInvokedAt 的 auto-stale 路径。
 * 仅面向 stable。
 *
 * 判定顺序:
 *   1) age < STALE_STABLE_MIN_AGE_DAYS → skip 'too_young'
 *      (刚晋升的 stable 样本少,先给它至少 14d 的调用机会)
 *   2) daysSinceLastInvoke <= STALE_STABLE_UNUSED_DAYS → skip 'recently_invoked'
 *   3) 其它 → archive(trigger='auto-stale')
 */
export function decideByStale(m: OrganismManifest): ArchiveDecision {
  const age = ageDays(m.createdAt)
  const overdue = overdueDays(m.expiresAt)
  const dsli = daysSinceLastInvoke(m)
  // Phase 38:读 tuned-archive-thresholds.json(mtime 缓存),文件缺失 →
  // fallback DEFAULT(45/14),数值与原硬编码一致,向后兼容。
  const tuned = loadTunedArchiveThresholds()
  const minAge = tuned.staleStableMinAgeDays
  const unused = tuned.staleStableUnusedDays
  const base = {
    organismId: m.id,
    from: m.status,
    trigger: 'auto-stale' as const,
    metrics: {
      expiresAt: m.expiresAt,
      ageDays: age,
      overdueDays: overdue,
      daysSinceLastInvoke: dsli,
    },
  }
  if (age < minAge) {
    return {
      ...base,
      action: 'skip',
      reason: `too_young: age=${age.toFixed(1)}d < MIN_AGE=${minAge}d (grace period for fresh stable)`,
    }
  }
  if (dsli <= unused) {
    const last = m.lastInvokedAt ?? 'never'
    return {
      ...base,
      action: 'skip',
      reason: `recently_invoked: lastInvokedAt=${last} (${dsli.toFixed(1)}d ago, threshold=${unused}d)`,
    }
  }
  const last = m.lastInvokedAt ?? `never (using createdAt ${m.createdAt})`
  return {
    ...base,
    action: 'archive',
    reason: `auto-stale: no invocation for ${dsli.toFixed(1)}d (lastInvokedAt=${last}, threshold=${unused}d, age=${age.toFixed(1)}d)`,
  }
}

// ── 对外 API ─────────────────────────────────────────

/**
 * 扫描两条路径下的 organism,返回合并决策列表(纯读)。
 *   [Phase 8] ARCHIVABLE_SOURCE_STATUSES → decideByExpiresAt
 *   [Phase 10] STALE_SOURCE_STATUSES     → decideByStale
 * 调用安全:即使某个 manifest 损坏只会跳过,不抛。
 */
export function evaluateAutoArchive(): { decisions: ArchiveDecision[] } {
  const decisions: ArchiveDecision[] = []
  // Phase 8:过期路径
  for (const status of ARCHIVABLE_SOURCE_STATUSES) {
    for (const id of listOrganismIds(status)) {
      const m = readOrganism(status, id)
      if (!m) continue
      decisions.push(decideByExpiresAt(m))
    }
  }
  // Phase 10:stale 路径
  for (const status of STALE_SOURCE_STATUSES) {
    for (const id of listOrganismIds(status)) {
      const m = readOrganism(status, id)
      if (!m) continue
      decisions.push(decideByStale(m))
    }
  }
  return { decisions }
}

/**
 * 执行自动归档。
 *
 * dryRun=true(默认):只计算,不写 disk。
 * dryRun=false:对每个 action='archive' 调
 *   promoteOrganism({ toStatus:'archived', trigger: d.trigger, rationale:reason })
 *   复用 Phase 1/2 的 FSM + 签名 ledger 路径。
 *   trigger 由 decision 自己携带('auto-age' 或 'auto-stale'),apply 层不再硬编码。
 *
 * 调用方(典型:/evolve-tick --apply)自行守卫 CLAUDE_EVOLVE=on。
 */
export function applyAutoArchive(opts?: {
  dryRun?: boolean
}): ArchiveApplyResult {
  const dryRun = opts?.dryRun !== false // 默认 dry-run
  const eval_ = evaluateAutoArchive()
  const archived: ArchiveApplyResult['archived'] = []
  const skipped: ArchiveDecision[] = []

  for (const d of eval_.decisions) {
    if (d.action !== 'archive') {
      skipped.push(d)
      continue
    }
    if (dryRun) continue
    try {
      // 复用 promoteOrganism —— 它把"archive"也视为一次合法 FSM 转移。
      // shadow→archived / proposal→archived / stable→archived 在
      // promotionFsm ALLOWED 表里都有。trigger 按 decision 分流:
      //   Phase 8 过期路径  → 'auto-age'
      //   Phase 10 stale 路径 → 'auto-stale'
      const result = promoteOrganism({
        id: d.organismId,
        fromStatus: d.from,
        toStatus: 'archived',
        trigger: d.trigger,
        rationale: d.reason,
      })
      archived.push({ decision: d, result })
      if (!result.ok) {
        logForDebugging(
          `[autoArchive] promoteOrganism failed for ${d.organismId} (${d.trigger}): ${result.reason}`,
        )
      }
    } catch (e) {
      logForDebugging(
        `[autoArchive] apply error for ${d.organismId} (${d.trigger}): ${(e as Error).message}`,
      )
      archived.push({
        decision: d,
        result: { ok: false, reason: (e as Error).message },
      })
    }
  }

  return {
    decisions: eval_.decisions,
    archived,
    skipped,
  }
}
