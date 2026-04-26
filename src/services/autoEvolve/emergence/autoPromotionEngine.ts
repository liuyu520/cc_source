/**
 * Auto-Promotion Engine — Phase 6
 *
 * 职责:
 *   - 扫描所有 shadow / canary organism
 *   - 基于 "invocationCount + age + 最近 Oracle 宏观趋势" 计算晋升决策
 *   - dryRun 只返回决策列表,apply=true 时调 promoteOrganism(trigger='auto-oracle')
 *     让签名 ledger + skill-loader wrap 链路自动接管
 *
 * 为什么不直接用 Oracle per-organism fitness?
 *   Phase 3 的 Oracle 按 sessionId 聚合,不是 organism id。把 session 级分数
 *   归因到具体 organism 需要:
 *     a) Phase 5 的 invocation hook 在 session 结束时记录"本 session 触发过哪些 organism"
 *     b) 然后按交集把 session 级 FitnessScore 分摊给这些 organism
 *   这一路在 Phase 7 做。Phase 6 先用 invocationCount + age 作为代理,
 *   辅以全局 Oracle 趋势当保守闸门(发现最近平均分很低就暂停晋升)。
 *
 * 阈值一律常量 + 清楚注释,方便后续用户手动调参。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  listOrganismIds,
  readOrganism,
  promoteOrganism,
  refreshAllOrganismFitness,
  type PromotionResult,
} from '../arena/arenaController.js'
import { recentFitnessScores } from '../oracle/fitnessOracle.js'
import {
  aggregateOrganismFitness,
  type OrganismFitnessAggregate,
} from '../oracle/oracleAggregator.js'
import {
  detectCheating,
  type GoodhartReason,
} from '../oracle/goodhartGuard.js'
import {
  auditForbiddenZoneVerdict,
  evaluateForbiddenZones,
  type ForbiddenZoneHit,
} from '../arena/forbiddenZones.js'
import { loadTunedThresholds } from '../oracle/thresholdTuner.js'
import { loadTunedPromotionThresholds } from './promotionThresholdTuner.js'
import type { OrganismManifest, OrganismStatus } from '../types.js'

// ── 阈值(保守起点,可调) ───────────────────────────────

/** shadow → canary 所需的最少调用次数 */
export const SHADOW_TO_CANARY_MIN_INVOCATIONS = 3
/** shadow → canary 所需的最小存在天数(24h 至少观察一轮) */
export const SHADOW_TO_CANARY_MIN_AGE_DAYS = 1

/** canary → stable 所需的最少调用次数 */
export const CANARY_TO_STABLE_MIN_INVOCATIONS = 10
/** canary → stable 所需的最小存在天数(防止单日冲量) */
export const CANARY_TO_STABLE_MIN_AGE_DAYS = 3

/** 宏观闸门:最近 N 条 Oracle score 平均低于此值则全 hold */
export const ORACLE_ADVERSE_AVG_THRESHOLD = -0.5
/** 最少样本数,少于此数不触发宏观闸门(信号不足) */
export const ORACLE_MIN_SAMPLES_FOR_GATE = 3
/** 观察窗口:看最近 N 条 fitness 记录算均值 */
export const ORACLE_TREND_WINDOW = 10

// ── Phase 7:per-organism fitness 融合参数 ──────────────────
//
// 思路:
//   - 负向一票否决:某 organism 自己的 wins/losses 明显不利,就算调用够多、时间够久,
//     也不能放它进下一层(防止把"被人讨厌的东西"晋升到更大舞台)。
//   - 正向加速:某 organism avg 明显正,且样本不是偶然(≥2),
//     允许它用更短的观察窗口进阶(但调用次数不放宽 —— 调用次数保的是"用过了")。
//
// 阈值与 oracleAggregator.ORGANISM_WIN_THRESHOLD=0.3 对齐:同一口径。

/** per-organism 负向否决所需的最小 trials(样本太少不做判断) */
export const PER_ORG_ADVERSE_MIN_TRIALS = 3
/** per-organism 正向加速所需的最小 trials */
export const PER_ORG_FAVORABLE_MIN_TRIALS = 2
/** per-organism 正向加速的 avg 阈值(≥ 此值算明确信号) */
export const PER_ORG_FAVORABLE_AVG_THRESHOLD = 0.3
/** per-organism 正向加速对 age 阈值的放宽系数(0.5 = 减半) */
export const PER_ORG_FAVORABLE_AGE_RELAX = 0.5

// ── 决策类型 ──────────────────────────────────────────

export type DecisionAction = 'promote' | 'hold' | 'skip'

export interface PromotionDecision {
  organismId: string
  action: DecisionAction
  /** 当前状态(必须是 shadow/canary;stable/vetoed/archived 不会被评估) */
  from: OrganismStatus
  /** 仅 action=promote 有值;其它为 undefined */
  to?: OrganismStatus
  /** 人类可读的理由字符串(会作为 rationale 写入 ledger) */
  reason: string
  /** 附带观察到的指标,便于 debug */
  metrics: {
    invocationCount: number
    ageDays: number
    /** 宏观 Oracle 均值(若样本充足) */
    oracleAvg?: number
    /** Phase 7:per-organism fitness 聚合快照(trials=0 时仍在,但无统计意义) */
    perOrg?: {
      trials: number
      wins: number
      losses: number
      neutrals: number
      avg: number
    }
    /**
     * Phase 22 — Goodhart Guard 本次体检命中的作弊规则名清单。
     * 正常 organism 该数组为空;命中任意一条即 action='hold' 且 reason 以 goodhart_veto 开头。
     * 字段始终存在(空数组)以便 /evolve-status 统一渲染。
     */
    goodhartReasons: GoodhartReason[]
    /**
     * Phase 42 — Forbidden Zone Guard 命中的 hard-block / warn 规则。
     * 正常 organism 为空数组;命中 block 时 auto-promotion 直接 hold。
     */
    forbiddenZoneHits: ForbiddenZoneHit[]
  }
}

export interface ApplyResult {
  decisions: PromotionDecision[]
  promoted: Array<{ decision: PromotionDecision; result: PromotionResult }>
  held: PromotionDecision[]
  /** 全局宏观闸门是否生效(影响所有 candidate) */
  gatedByOracle: boolean
  oracleAvg?: number
  samples: number
}

// ── 工具函数 ───────────────────────────────────────────

function ageDays(createdAt: string): number {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 86400_000
}

function oracleTrendAvg(): { avg?: number; samples: number } {
  const scores = recentFitnessScores(ORACLE_TREND_WINDOW)
  if (scores.length === 0) return { samples: 0 }
  const sum = scores.reduce((a, s) => a + s.score, 0)
  return { avg: sum / scores.length, samples: scores.length }
}

/**
 * 计算单个 organism 的决策。纯函数 —— 不触发任何写操作。
 *
 * Phase 24:oracleAdverseAvgThreshold 由调用方传入(来自 loadTunedThresholds()),
 * 保证"全局闸门 reason 字符串"与"闸门触发时的真实阈值"同步。
 */
function decide(
  m: OrganismManifest,
  gatedByOracle: boolean,
  oracleAvg: number | undefined,
  oracleAdverseAvgThreshold: number = ORACLE_ADVERSE_AVG_THRESHOLD,
): PromotionDecision {
  const invocations =
    typeof m.invocationCount === 'number' ? m.invocationCount : 0
  const age = ageDays(m.createdAt)

  // Phase 7:拉取 per-organism fitness 聚合快照(失败静默)
  let perOrg: OrganismFitnessAggregate | undefined
  try {
    perOrg = aggregateOrganismFitness(m.id)
  } catch (e) {
    logForDebugging(
      `[autoPromotion] aggregateOrganismFitness(${m.id}) failed: ${(e as Error).message}`,
    )
  }
  const perOrgSnapshot = perOrg
    ? {
        trials: perOrg.trials,
        wins: perOrg.wins,
        losses: perOrg.losses,
        neutrals: perOrg.neutrals,
        avg: perOrg.avg,
      }
    : undefined

  const base = {
    organismId: m.id,
    from: m.status,
    metrics: {
      invocationCount: invocations,
      ageDays: age,
      oracleAvg,
      perOrg: perOrgSnapshot,
      // Phase 22:Goodhart 体检默认空 —— 命中时下面覆盖
      goodhartReasons: [] as GoodhartReason[],
      // Phase 42:Forbidden Zone Guard 默认空 —— 命中时下面覆盖
      forbiddenZoneHits: [] as ForbiddenZoneHit[],
    },
  }

  // 全局宏观闸门:最近 Oracle 趋势过于负面,暂停晋升
  if (gatedByOracle) {
    return {
      ...base,
      action: 'hold',
      reason: `oracle_adverse: avg=${oracleAvg?.toFixed(2) ?? 'n/a'} < ${oracleAdverseAvgThreshold}`,
    }
  }

  // Phase 22 — Goodhart Guard 体检。
  //
  // 把反作弊规则放在 per_org_adverse 之前:per_org_adverse 靠 wins/losses
  // 做统计判断,但如果打分本身被作弊污染,统计就是错的。Goodhart 负责
  // 在统计之前就识别"数据分布异常"的样本。
  //
  // 失败静默 —— detectCheating 自身失败不抛,这里也兜一层 try/catch
  // 保证 decide 永远可以返回一个 decision。
  let goodhartReasons: GoodhartReason[] = []
  let goodhartDetail = ''
  try {
    const verdict = detectCheating(m, m.status, {
      // 把已计算的 perOrg 透传进去,避免 goodhartGuard 再读一次 ledger
      aggregateOverride: perOrg
        ? { trials: perOrg.trials, losses: perOrg.losses, avg: perOrg.avg }
        : undefined,
    })
    goodhartReasons = verdict.reasons
    goodhartDetail = verdict.detail
  } catch (e) {
    logForDebugging(
      `[autoPromotion] goodhartGuard ${m.id} failed: ${(e as Error).message}`,
    )
  }
  if (goodhartReasons.length > 0) {
    return {
      ...base,
      metrics: { ...base.metrics, goodhartReasons },
      action: 'hold',
      reason: goodhartDetail || `goodhart_veto: ${goodhartReasons.join(',')}`,
    }
  }

  // Phase 42 — Forbidden Zone Guard。
  //
  // 设计书 §6.1 明确要求 auth/permission/.env/bin/build-binary 以及 destructive
  // shell 语义必须人工批准。这里在 auto-promotion 决策阶段先做一次静态守门:
  //   - 命中 block → 直接 hold + 审计到 forbidden-zones.ndjson
  //   - 命中 warn  → 只记 metrics + 审计,当前版本不拦截(给未来扩展留口)
  //
  // 注意:当前扫描的是 organism 自己目录内的产物文件,不做全仓 grep,避免 blast
  // radius 过大;真正源码级 patch 时代码仍可复用同一守门模块。
  const forbiddenVerdict = evaluateForbiddenZones(m, m.status)
  if (forbiddenVerdict.status !== 'pass') {
    auditForbiddenZoneVerdict(m, forbiddenVerdict, m.status)
  }
  if (forbiddenVerdict.status === 'block') {
    const detail = forbiddenVerdict.blocked
      .map(hit => `${hit.ruleId}@${hit.path}`)
      .join(', ')
    return {
      ...base,
      metrics: {
        ...base.metrics,
        forbiddenZoneHits: forbiddenVerdict.hits,
      },
      action: 'hold',
      reason: detail
        ? `forbidden_zone_block: ${detail}`
        : 'forbidden_zone_block',
    }
  }

  // Phase 7 负向否决:per-organism 样本充足 + 胜负关系明确不利,一票 hold
  if (
    perOrg &&
    perOrg.trials >= PER_ORG_ADVERSE_MIN_TRIALS &&
    perOrg.wins < perOrg.losses
  ) {
    return {
      ...base,
      action: 'hold',
      reason:
        `per_org_adverse: W=${perOrg.wins} L=${perOrg.losses} N=${perOrg.neutrals} ` +
        `trials=${perOrg.trials}≥${PER_ORG_ADVERSE_MIN_TRIALS} avg=${perOrg.avg.toFixed(2)}`,
    }
  }

  // Phase 7 正向加速:per-organism avg 足够正 + 样本≥2,放宽 age 阈值(调用次数不放宽)
  const favorable =
    !!perOrg &&
    perOrg.trials >= PER_ORG_FAVORABLE_MIN_TRIALS &&
    perOrg.avg >= PER_ORG_FAVORABLE_AVG_THRESHOLD

  // Phase 37: 读 tuned-promotion-thresholds.json(文件缺失 → DEFAULT = 原硬编码值,行为不变)
  const tuned = loadTunedPromotionThresholds()

  if (m.status === 'shadow') {
    const ageThreshold = favorable
      ? tuned.shadowToCanaryMinAgeDays * PER_ORG_FAVORABLE_AGE_RELAX
      : tuned.shadowToCanaryMinAgeDays
    const ok =
      invocations >= tuned.shadowToCanaryMinInvocations && age >= ageThreshold
    if (ok) {
      return {
        ...base,
        action: 'promote',
        to: 'canary',
        reason:
          `shadow→canary: invocations=${invocations}≥${tuned.shadowToCanaryMinInvocations} ` +
          `age=${age.toFixed(1)}d≥${ageThreshold.toFixed(1)}d` +
          (favorable
            ? ` (relaxed by per_org_favorable avg=${perOrg!.avg.toFixed(2)} trials=${perOrg!.trials})`
            : ''),
      }
    }
    return {
      ...base,
      action: 'hold',
      reason:
        `shadow: need invocations≥${tuned.shadowToCanaryMinInvocations} (got ${invocations}) ` +
        `and age≥${ageThreshold.toFixed(1)}d (got ${age.toFixed(1)}d)` +
        (favorable ? ` [age threshold relaxed]` : ''),
    }
  }
  if (m.status === 'canary') {
    const ageThreshold = favorable
      ? tuned.canaryToStableMinAgeDays * PER_ORG_FAVORABLE_AGE_RELAX
      : tuned.canaryToStableMinAgeDays
    const ok =
      invocations >= tuned.canaryToStableMinInvocations && age >= ageThreshold
    if (ok) {
      return {
        ...base,
        action: 'promote',
        to: 'stable',
        reason:
          `canary→stable: invocations=${invocations}≥${tuned.canaryToStableMinInvocations} ` +
          `age=${age.toFixed(1)}d≥${ageThreshold.toFixed(1)}d` +
          (favorable
            ? ` (relaxed by per_org_favorable avg=${perOrg!.avg.toFixed(2)} trials=${perOrg!.trials})`
            : ''),
      }
    }
    return {
      ...base,
      action: 'hold',
      reason:
        `canary: need invocations≥${tuned.canaryToStableMinInvocations} (got ${invocations}) ` +
        `and age≥${ageThreshold.toFixed(1)}d (got ${age.toFixed(1)}d)` +
        (favorable ? ` [age threshold relaxed]` : ''),
    }
  }
  // 其它状态理论上不会进入 decide(evaluateAutoPromotions 只扫 shadow/canary)
  return {
    ...base,
    action: 'skip',
    reason: `status ${m.status} is not eligible for auto-promotion`,
  }
}

// ── 对外 API ───────────────────────────────────────────

/**
 * 评估当前所有 shadow + canary organism 的自动晋升决策。
 *
 * 纯读 —— 不触发任何 disk write、不调 promoteOrganism。
 * 返回的 decisions 可直接用于 /evolve-status 预览或 /evolve-tick --dry-run。
 */
export function evaluateAutoPromotions(): {
  decisions: PromotionDecision[]
  gatedByOracle: boolean
  oracleAvg?: number
  samples: number
} {
  const trend = oracleTrendAvg()
  // Phase 24:宏观闸门与 per-organism Goodhart R4 阈值都走 tuned-thresholds.json,
  // 文件缺失时自动回退到 DEFAULT_TUNED_THRESHOLDS(= 与原硬编码一致),保持向后兼容。
  const tuned = loadTunedThresholds()
  const gatedByOracle =
    trend.samples >= ORACLE_MIN_SAMPLES_FOR_GATE &&
    typeof trend.avg === 'number' &&
    trend.avg < tuned.oracleAdverseAvg

  const decisions: PromotionDecision[] = []
  for (const status of ['shadow', 'canary'] as const) {
    for (const id of listOrganismIds(status)) {
      const m = readOrganism(status, id)
      if (!m) continue
      decisions.push(decide(m, gatedByOracle, trend.avg, tuned.oracleAdverseAvg))
    }
  }
  return {
    decisions,
    gatedByOracle,
    oracleAvg: trend.avg,
    samples: trend.samples,
  }
}

/**
 * 执行自动晋升。
 *
 * dryRun=true(默认):只返回计算结果,不写任何 disk。
 * dryRun=false:对每个 action='promote' 的决策调 promoteOrganism(trigger='auto-oracle'),
 *              rationale 取决策的 reason 字段。若 promoteOrganism 返回 !ok,
 *              把结果附到 promoted 数组但标 result.ok=false。
 *
 * 调用方自行决定是否传 dryRun=false(一般由 CLAUDE_EVOLVE=on + /evolve-tick --apply 共同守卫)。
 */
export function applyAutoPromotions(opts?: { dryRun?: boolean }): ApplyResult {
  const dryRun = opts?.dryRun !== false // 默认 dry-run

  // Phase 9:evaluate 之前先刷一次 per-organism fitness 聚合 →
  // manifest.fitness。这样下面 evaluateAutoPromotions 里的 decide()
  // 读到的 perOrg 签名就是"现在"的聚合值,不是上一次 refresh 的旧值。
  // 失败静默 —— refresh 问题不阻塞决策路径(decide 会再直接调 aggregator,
  // 只是把结果写回 manifest 的步骤跳过而已)。
  try {
    refreshAllOrganismFitness()
  } catch (e) {
    logForDebugging(
      `[autoPromotion] pre-eval refresh failed: ${(e as Error).message}`,
    )
  }

  const eval_ = evaluateAutoPromotions()
  const promoted: ApplyResult['promoted'] = []
  const held: PromotionDecision[] = []

  for (const d of eval_.decisions) {
    if (d.action !== 'promote') {
      held.push(d)
      continue
    }
    if (dryRun) {
      // dry-run 也计入 promoted,但 result 缺省,便于调用方展示"会发生什么"
      continue
    }
    if (!d.to) {
      held.push({ ...d, action: 'hold', reason: `${d.reason} (no target)` })
      continue
    }
    const result = promoteOrganism({
      id: d.organismId,
      fromStatus: d.from,
      toStatus: d.to,
      trigger: 'auto-oracle',
      rationale: d.reason,
    })
    promoted.push({ decision: d, result })
    if (!result.ok) {
      logForDebugging(
        `[autoPromotion] ${d.organismId} ${d.from}→${d.to} failed: ${result.reason}`,
      )
    }
  }
  return {
    decisions: eval_.decisions,
    promoted,
    held,
    gatedByOracle: eval_.gatedByOracle,
    oracleAvg: eval_.oracleAvg,
    samples: eval_.samples,
  }
}
