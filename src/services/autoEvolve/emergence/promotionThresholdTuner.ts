/**
 * autoEvolve(v1.0) — Phase 37:Promotion 阈值自调(Promotion-tier auto-tuner)
 *
 * 问题
 * ────
 * autoPromotionEngine 的 tier 阈值(SHADOW_TO_CANARY_MIN_INVOCATIONS /
 * SHADOW_TO_CANARY_MIN_AGE_DAYS / CANARY_TO_STABLE_MIN_INVOCATIONS /
 * CANARY_TO_STABLE_MIN_AGE_DAYS)长期是硬编码常量 3/1/10/3。实际运行里这
 * 组值"过紧" → 好 organism 晋升迟;"过松" → 晋升后很快就被 vetoed/archived
 * (回归)。Phase 24 针对 oracle 侧已经有 thresholdTuner,Phase 37 是同款
 * 模式套在 promotion tier 上:
 *
 * 数据信号
 * ────────
 * 从 promotions.ndjson(Phase 2 FSM 的 append-only ledger)读窗口内的
 * Transition 流,按 "from→to" 分桶:
 *   - 桶 A(shadow→canary)
 *   - 桶 B(canary→stable)
 *
 * 对每个 organism,若在 "成功晋升" 之后**又**出现
 * `to='vetoed'` 的 transition → 计作"promoted-then-regressed"(回归)。
 *
 *   regressionRate_tier = regressed / total
 *
 *   - regressionRate ≥ HIGH_REGRESSION(0.3)  → **tighten** 该 tier 阈值
 *     (invocations +1, ageDays +1,夹紧在上限)
 *   - regressionRate ≤ LOW_REGRESSION(0.05) AND total ≥ MIN_SAMPLES_RELAX(5)
 *                                             → **relax** 该 tier 阈值
 *     (invocations -1, ageDays -1,夹紧在下限)
 *   - 其它                                     → **hold**(不动)
 *
 * 样本不够(total < MIN_SAMPLES_FOR_PROMO_TUNE = 5)时整体 insufficient,
 * 返回空 rows 并在 insufficientReason 里说明 —— 与 Phase 24 一致。
 *
 * 为什么只数 vetoed,不数 archived?
 * ───────────────────────────────
 * archived 有两种语义:
 *   - 从 stable 归档:正常退役(stale / lineage merge)—— 不是回归
 *   - 从 shadow/canary 归档:可能是 auto-age 超时,也算"没成功",
 *     但不一定是"坏"—— 中性。
 * vetoed 语义统一:明确的"坏信号"(用户或 auto-gate 判定不合格)。
 * 只用 vetoed 保证回归率**只数真坏**,不被中性退役污染。
 *
 * 文件不写任何硬编码默认 —— 见 DEFAULT_TUNED_PROMOTION_THRESHOLDS,数值
 * 必须与 autoPromotionEngine.ts 的原硬编码保持一致(3 / 1 / 10 / 3)。
 * autoPromotionEngine 会 loadTunedPromotionThresholds() fallback 到默认,
 * 所以文件缺失 → 行为不变,完全向后兼容。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

import { getOracleDir, getPromotionLedgerPath, getTunedPromotionThresholdsPath } from '../paths.js'
import type { Transition } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

// ── 常量 ──────────────────────────────────────────────────────────

/**
 * 原硬编码与 autoPromotionEngine 对齐 —— 任何修改都要同步那边。
 * 必须保持数值不变,以便文件缺失时行为不变。
 */
export const DEFAULT_TUNED_PROMOTION_THRESHOLDS: TunedPromotionThresholds = {
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  shadowToCanaryMinInvocations: 3,
  shadowToCanaryMinAgeDays: 1,
  canaryToStableMinInvocations: 10,
  canaryToStableMinAgeDays: 3,
}

/** invocations 夹紧范围 */
export const INVOCATIONS_MIN = 1
export const INVOCATIONS_MAX = 50
/** ageDays 夹紧范围(0 = 无等待) */
export const AGE_DAYS_MIN = 0
export const AGE_DAYS_MAX = 30

/** regressionRate ≥ 这个值 → tighten */
export const HIGH_REGRESSION_RATE = 0.3
/** regressionRate ≤ 这个值 AND total ≥ MIN_SAMPLES_RELAX → relax */
export const LOW_REGRESSION_RATE = 0.05
/** relax 需要的最小样本(避免只有 2 个成功就放宽) */
export const MIN_SAMPLES_RELAX = 5
/** 整个调优流程的最小样本;低于此直接 insufficient */
export const MIN_SAMPLES_FOR_PROMO_TUNE = 5

// ── 类型 ──────────────────────────────────────────────────────────

/**
 * tuned-promotion-thresholds.json 的 schema(v1)。
 * 只存实际被替换的 4 个 tier 阈值;其它 autoPromotion 常量(ORACLE_ADVERSE_*、
 * PER_ORG_*、oracle trend window)不在 Phase 37 管辖范围。
 */
export interface TunedPromotionThresholds {
  /** schema 版本 */
  version: 1
  /** 上次 /evolve-tune-promotion --apply 的 ISO 时间 */
  updatedAt: string
  /** shadow→canary 最小调用次数 */
  shadowToCanaryMinInvocations: number
  /** shadow→canary 最小年龄(天) */
  shadowToCanaryMinAgeDays: number
  /** canary→stable 最小调用次数 */
  canaryToStableMinInvocations: number
  /** canary→stable 最小年龄(天) */
  canaryToStableMinAgeDays: number
}

/** 单行建议(一个 tier-field 一行) */
export interface PromotionSuggestionRow {
  /** tier + field,如 "shadowToCanaryMinInvocations" */
  name: keyof Omit<TunedPromotionThresholds, 'version' | 'updatedAt'>
  /** 当前生效值(tuned 文件 或 DEFAULT) */
  current: number
  /** 建议新值(已夹紧到范围) */
  suggested: number
  /** 可读解释(引用 regression rate) */
  rationale: string
}

/** 单次规划产物 */
export interface PromotionTuningSuggestion {
  /** 窗口天数 */
  windowDays: number
  /** 读到的 transition 总数 */
  totalTransitions: number
  /** shadow→canary 成功晋升数 */
  shadowToCanaryCount: number
  /** shadow→canary 后被 vetoed 的 organism 数 */
  shadowToCanaryRegressed: number
  /** canary→stable 成功晋升数 */
  canaryToStableCount: number
  /** canary→stable 后被 vetoed 的 organism 数 */
  canaryToStableRegressed: number
  /** 样本不足 / 没有回归数据时的理由,空串表示 ready */
  insufficientReason: string
  /** 每一条 tier-field 的建议;样本不足时为空 */
  rows: PromotionSuggestionRow[]
  /**
   * 2026-04-25 —— bake-stall 逃生通道。
   * 当 classic path 因 insufficient 不出 rows,但 veto-window 持续 stalled
   * (bake 太长,promotions 根本出不来,回归率无从计算)时,由 detectBakeStallSignal()
   * 触发一次 AGE_DAYS -1 的 override row,避免死锁。纯只读。
   * 仅承担诊断性语义:bakeStallOverride != null 表示此 suggestion 里有至少一行是由
   * bake-stall 信号驱动,而不是 promoted-then-vetoed 回归率驱动。
   */
  bakeStallOverride?: {
    /** 触发时的 ledger 统计(同 VetoWindowStats 结构) */
    stats: {
      blocked: number
      bypassed: number
      passed: number
      failOpen: number
    }
    /** 人类可读摘要,用于 CLI render */
    summary: string
  }
}

// ── 缓存(mtime 触发重读) ────────────────────────────────────────

let cachedTuned: TunedPromotionThresholds | null = null
let cachedMtime = 0

/**
 * 热路径:autoPromotionEngine 每次 evaluate 都会调用 loadTunedPromotionThresholds,
 * 用 mtime 比对避免 disk re-read。
 */
export function loadTunedPromotionThresholds(): TunedPromotionThresholds {
  const path = getTunedPromotionThresholdsPath()
  try {
    if (!existsSync(path)) {
      cachedTuned = null
      cachedMtime = 0
      return { ...DEFAULT_TUNED_PROMOTION_THRESHOLDS }
    }
    const mtime = statSync(path).mtimeMs
    if (cachedTuned && mtime === cachedMtime) return cachedTuned
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as TunedPromotionThresholds
    // 防御性校验:若 schema 不对,回退 DEFAULT(不覆盖文件)
    if (
      parsed.version !== 1 ||
      typeof parsed.shadowToCanaryMinInvocations !== 'number' ||
      typeof parsed.shadowToCanaryMinAgeDays !== 'number' ||
      typeof parsed.canaryToStableMinInvocations !== 'number' ||
      typeof parsed.canaryToStableMinAgeDays !== 'number'
    ) {
    logForDebugging(`[autoEvolve:promotionTuner] tuned-promotion-thresholds.json schema invalid, falling back to DEFAULT`)
      return { ...DEFAULT_TUNED_PROMOTION_THRESHOLDS }
    }
    cachedTuned = parsed
    cachedMtime = mtime
    return parsed
  } catch (e) {
    logForDebugging(`[autoEvolve:promotionTuner] loadTunedPromotionThresholds fallback: ${e}`)
    return { ...DEFAULT_TUNED_PROMOTION_THRESHOLDS }
  }
}

export function saveTunedPromotionThresholds(t: TunedPromotionThresholds): void {
  const path = getTunedPromotionThresholdsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(t, null, 2), 'utf8')
    // 写后立即失效缓存,下一次 load 再读
    cachedTuned = null
    cachedMtime = 0
  } catch (e) {
    logForDebugging(`[autoEvolve:promotionTuner] saveTunedPromotionThresholds failed: ${e}`)
    throw e
  }
}

/** 仅测试使用;清缓存后下次 load 会重新读磁盘 */
export function _resetTunedPromotionThresholdsCacheForTest(): void {
  cachedTuned = null
  cachedMtime = 0
}

// ── helpers ──────────────────────────────────────────────────────

/** 读取 promotions.ndjson 的全部 transition;文件缺失返回 [] */
function readAllTransitions(): Transition[] {
  const path = getPromotionLedgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    const out: Transition[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as Transition)
      } catch {
        // 跳过损坏行
      }
    }
    return out
  } catch (e) {
    logForDebugging(`[autoEvolve:promotionTuner] readAllTransitions error: ${e}`)
    return []
  }
}

/**
 * 给定一组 transitions + 一个 (from, to) 对,返回:
 *   promotedIds:那些在窗口内完成了 from→to 的 organismId 集合
 *   regressedIds:其中后续(同 organism,任何时间,不限窗口)又出现 to='vetoed'
 *                的 organism 集合 —— 这保证了"先晋升后回归"的顺序
 *
 * 时间条件:成功晋升必须在窗口内(>= cutoff)。后续被 vetoed 不限窗口 ——
 * 因为回归通常滞后,限制窗口会漏掉真正的"延迟回归",偏差 tuner 向过松。
 */
function computeTierStats(
  allTransitions: Transition[],
  windowMs: number,
  from: 'shadow' | 'canary',
  to: 'canary' | 'stable',
): { promotedIds: Set<string>; regressedIds: Set<string> } {
  const now = Date.now()
  const cutoff = now - windowMs
  const promotedIds = new Set<string>()
  const promotedTimes = new Map<string, number>()
  for (const t of allTransitions) {
    if (t.from !== from || t.to !== to) continue
    const at = Date.parse(t.at)
    if (!Number.isFinite(at) || at < cutoff) continue
    promotedIds.add(t.organismId)
    // 取最早的 promotion time(如果同一 organism 重复晋升,以第一次为准)
    const prev = promotedTimes.get(t.organismId)
    if (prev === undefined || at < prev) promotedTimes.set(t.organismId, at)
  }
  const regressedIds = new Set<string>()
  for (const t of allTransitions) {
    if (t.to !== 'vetoed') continue
    if (!promotedIds.has(t.organismId)) continue
    const at = Date.parse(t.at)
    if (!Number.isFinite(at)) continue
    const promotedAt = promotedTimes.get(t.organismId) ?? 0
    // 只数"晋升之后"的 vetoed —— 顺序保证
    if (at >= promotedAt) regressedIds.add(t.organismId)
  }
  return { promotedIds, regressedIds }
}

/** 单个 tier-field 的 tighten/relax/hold 决策 */
function decideRow(
  name: PromotionSuggestionRow['name'],
  current: number,
  regressionRate: number,
  total: number,
  field: 'invocations' | 'ageDays',
): PromotionSuggestionRow {
  const min = field === 'invocations' ? INVOCATIONS_MIN : AGE_DAYS_MIN
  const max = field === 'invocations' ? INVOCATIONS_MAX : AGE_DAYS_MAX
  let suggested = current
  let rationale = ''
  if (regressionRate >= HIGH_REGRESSION_RATE) {
    suggested = Math.min(max, current + 1)
    rationale = `tighten: regressionRate=${regressionRate.toFixed(3)} ≥ ${HIGH_REGRESSION_RATE.toFixed(2)} (n=${total}) → +1`
  } else if (regressionRate <= LOW_REGRESSION_RATE && total >= MIN_SAMPLES_RELAX) {
    suggested = Math.max(min, current - 1)
    rationale = `relax: regressionRate=${regressionRate.toFixed(3)} ≤ ${LOW_REGRESSION_RATE.toFixed(2)} (n=${total} ≥ ${MIN_SAMPLES_RELAX}) → -1`
  } else {
    rationale = `hold: regressionRate=${regressionRate.toFixed(3)} in [${LOW_REGRESSION_RATE.toFixed(2)}, ${HIGH_REGRESSION_RATE.toFixed(2)}) (n=${total})`
  }
  return { name, current, suggested, rationale }
}

// ── 主 API ─────────────────────────────────────────────────────

/**
 * 2026-04-25 —— bake-stall 逃生信号检测(纯只读,fail-open)。
 *
 * 为什么需要:classic path 依赖 promoted-then-vetoed 回归率,但如果 bake 时长设得太长,
 * 根本没有 promotion 出生(全被 veto-window blocked),就永远算不出回归率,形成死锁:
 *   bake 太长 → promotions=0 → rows=[] + insufficientReason → 用户得到"不动"的建议
 *   → bake 仍然太长 → ……
 *
 * 本函数读 vetoWindowLedger.computeVetoWindowStats 最近 24h 数据,
 * 当命中"持续 stalled"模式(blocked ≥ 3 && bypassed === 0 && passed <= blocked)时,
 * 返回 override 指示:应当将 shadowToCanaryMinAgeDays -1(夹紧到 AGE_DAYS_MIN)。
 *
 * 返 null 表示 ledger 无事件 / 数据不足 / 不满足 stalled 模式 / 模块加载失败,
 * 这些都走 classic 原逻辑,不触发 override。
 */
function detectBakeStallSignal(): {
  stats: { blocked: number; bypassed: number; passed: number; failOpen: number }
  summary: string
} | null {
  try {
    const vwMod = require('../oracle/vetoWindowLedger.js') as typeof import('../oracle/vetoWindowLedger.js')
    // 与 detectVetoWindowAdvisory 同语义:最近 24h 窗口;advisor 已做 stalled 判定,
    // 这里复用它的 kind + stats,避免阈值漂移。
    const adv = vwMod.detectVetoWindowAdvisory({ windowHours: 24 })
    if (adv.kind !== 'stalled' || !adv.stats) return null
    const s = adv.stats
    // 双保险:严格复核 stalled 条件(与 advisor 判定一致),防止 advisor 未来语义扩展后误触发。
    if (!(s.blocked >= 3 && s.bypassed === 0 && s.passed <= s.blocked)) return null
    return {
      stats: {
        blocked: s.blocked,
        bypassed: s.bypassed,
        passed: s.passed,
        failOpen: s.failOpen,
      },
      summary:
        `veto-window stalled (${s.blocked} blocked, ${s.passed} passed, 0 bypass in 24h) ` +
        `→ bake 阈值实际在阻塞 promotion,AGE_DAYS -1 逃生`,
    }
  } catch {
    // fail-open:ledger 不存在 / 模块加载失败都不触发 override
    return null
  }
}

/**
 * 规划(纯读 —— 不写盘)。
 *
 * 返回 rows 为空 + insufficientReason 非空,表示不动(样本不够或没有 vetoed 数据)。
 *
 * 2026-04-25 —— insufficient 分支增加 bake-stall 逃生路径:
 *   若 veto-window 最近 24h 处于 stalled(bake 太长,promotions 出不来),
 *   生成一条 AGE_DAYS -1 的 override row,并在返回值 bakeStallOverride 字段留痕。
 *   这样用户按 advisor 指向跑 /evolve-tune-promotion 时,真能拿到可落盘的建议,
 *   而不是因 insufficient 永远停在 rows=[]。
 */
export function computePromotionTuningSuggestion(
  windowDays: number = 30,
): PromotionTuningSuggestion {
  const all = readAllTransitions()
  const windowMs = windowDays * 86400_000
  const current = loadTunedPromotionThresholds()

  const tierA = computeTierStats(all, windowMs, 'shadow', 'canary')
  const tierB = computeTierStats(all, windowMs, 'canary', 'stable')

  const totalPromoted = tierA.promotedIds.size + tierB.promotedIds.size
  const shadowToCanaryCount = tierA.promotedIds.size
  const canaryToStableCount = tierB.promotedIds.size
  const shadowToCanaryRegressed = tierA.regressedIds.size
  const canaryToStableRegressed = tierB.regressedIds.size

  if (totalPromoted < MIN_SAMPLES_FOR_PROMO_TUNE) {
    // classic path 不够样本 —— 看 veto-window 有没有 stalled 逃生信号
    const bakeStall = detectBakeStallSignal()
    if (bakeStall !== null) {
      // 出一条 AGE_DAYS -1 的 override row(夹紧到 AGE_DAYS_MIN)
      const current = loadTunedPromotionThresholds()
      const currentAgeDays = current.shadowToCanaryMinAgeDays
      const suggested = Math.max(AGE_DAYS_MIN, currentAgeDays - 1)
      const overrideRow: PromotionSuggestionRow = {
        name: 'shadowToCanaryMinAgeDays',
        current: currentAgeDays,
        suggested,
        rationale:
          suggested < currentAgeDays
            ? `bake_stalled: ${bakeStall.summary} → -1`
            : `bake_stalled but already at floor (${AGE_DAYS_MIN})`,
      }
      return {
        windowDays,
        totalTransitions: all.length,
        shadowToCanaryCount,
        shadowToCanaryRegressed,
        canaryToStableCount,
        canaryToStableRegressed,
        insufficientReason: `insufficient samples: totalPromoted=${totalPromoted} < ${MIN_SAMPLES_FOR_PROMO_TUNE} (overridden by bake-stall signal)`,
        rows: [overrideRow],
        bakeStallOverride: bakeStall,
      }
    }
    return {
      windowDays,
      totalTransitions: all.length,
      shadowToCanaryCount,
      shadowToCanaryRegressed,
      canaryToStableCount,
      canaryToStableRegressed,
      insufficientReason: `insufficient samples: totalPromoted=${totalPromoted} < ${MIN_SAMPLES_FOR_PROMO_TUNE}`,
      rows: [],
    }
  }

  const rows: PromotionSuggestionRow[] = []

  // shadow→canary tier
  if (shadowToCanaryCount > 0) {
    const rate = shadowToCanaryRegressed / shadowToCanaryCount
    rows.push(
      decideRow(
        'shadowToCanaryMinInvocations',
        current.shadowToCanaryMinInvocations,
        rate,
        shadowToCanaryCount,
        'invocations',
      ),
    )
    rows.push(
      decideRow(
        'shadowToCanaryMinAgeDays',
        current.shadowToCanaryMinAgeDays,
        rate,
        shadowToCanaryCount,
        'ageDays',
      ),
    )
  }

  // canary→stable tier
  if (canaryToStableCount > 0) {
    const rate = canaryToStableRegressed / canaryToStableCount
    rows.push(
      decideRow(
        'canaryToStableMinInvocations',
        current.canaryToStableMinInvocations,
        rate,
        canaryToStableCount,
        'invocations',
      ),
    )
    rows.push(
      decideRow(
        'canaryToStableMinAgeDays',
        current.canaryToStableMinAgeDays,
        rate,
        canaryToStableCount,
        'ageDays',
      ),
    )
  }

  return {
    windowDays,
    totalTransitions: all.length,
    shadowToCanaryCount,
    shadowToCanaryRegressed,
    canaryToStableCount,
    canaryToStableRegressed,
    insufficientReason: '',
    rows,
  }
}

/**
 * suggestion → 下一版 TunedPromotionThresholds(保留未在 rows 出现的 field)。
 * 用于 applySuggestion 前的最后一步。
 */
export function suggestionToNext(
  s: PromotionTuningSuggestion,
): TunedPromotionThresholds {
  const base = loadTunedPromotionThresholds()
  const next: TunedPromotionThresholds = {
    version: 1,
    updatedAt: new Date().toISOString(),
    shadowToCanaryMinInvocations: base.shadowToCanaryMinInvocations,
    shadowToCanaryMinAgeDays: base.shadowToCanaryMinAgeDays,
    canaryToStableMinInvocations: base.canaryToStableMinInvocations,
    canaryToStableMinAgeDays: base.canaryToStableMinAgeDays,
  }
  for (const r of s.rows) {
    switch (r.name) {
      case 'shadowToCanaryMinInvocations':
        next.shadowToCanaryMinInvocations = r.suggested
        break
      case 'shadowToCanaryMinAgeDays':
        next.shadowToCanaryMinAgeDays = r.suggested
        break
      case 'canaryToStableMinInvocations':
        next.canaryToStableMinInvocations = r.suggested
        break
      case 'canaryToStableMinAgeDays':
        next.canaryToStableMinAgeDays = r.suggested
        break
    }
  }
  return next
}

// 避免 getOracleDir 未使用 lint 告警(保留 import 以便后续扩展)
void getOracleDir
