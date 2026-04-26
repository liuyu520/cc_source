/**
 * autoEvolve(v1.0) — Phase 40:Promotion rollback watchdog
 *
 * 问题
 * ────
 * autoPromotionEngine 把 organism 从 shadow 推到 canary/stable 是"前向 FSM";
 * 真正跑到 canary/stable 之后如果 Phase 39 加权 `manifest.fitness.avg` 迅速回落,
 * 当前 FSM 没有反向边,只有 autoArchiveEngine 在 stable "长期未调用"时才归档。
 * 后果:一个晋升失败的 canary/stable 会持续污染 aggregate、继续被用户/session
 * 触发、并拉偏 Oracle 分布,直到用户手动 /evolve-veto。
 *
 * Phase 40 引入反向边 canary → shadow 和 stable → shadow(在 Phase 2 FSM 表
 * 里新增),并引入新的 TransitionTrigger = 'auto-rollback'。rollbackWatchdog
 * 负责扫 canary + stable 两层,用当前 Phase 39 weighted aggregate 判断是否
 * 该降级回 shadow。
 *
 * 降级到 shadow 而不是 vetoed —— 纪律与理由
 * ─────────────────────────────────────────
 *   - shadow 是"观察位",保留 invocationCount / fitness 累积数据
 *   - 给 organism 第二次自然晋升通道(后续数据变好会重回 canary)
 *   - shadow 阶段持续拉胯会被既有 shadow→vetoed 路径吸收(不重复造轮子)
 *   - 直接 veto 损失晋升阶段的样本,观察断层,不符合"保留信号"原则
 *
 * 阈值与观察期(DEFAULT,v1 硬编码,v2 可抽成 tuner)
 * ──────────────────────────────────────────────
 *   canary:
 *     ROLLBACK_CANARY_AVG_MAX    = -0.3   // weighted avg ≤ 此值触发
 *     ROLLBACK_CANARY_MIN_TRIALS =  3     // 样本数 < 此值不判(噪声太大)
 *     ROLLBACK_CANARY_MIN_AGE_DAYS = 3    // 晋升到 canary 后观察期门槛
 *
 *   stable:
 *     ROLLBACK_STABLE_AVG_MAX    = -0.2   // stable 阈值更严(避免抖动)
 *     ROLLBACK_STABLE_MIN_TRIALS =  5     // stable 门槛更高
 *     ROLLBACK_STABLE_MIN_AGE_DAYS = 7    // stable 观察期更长
 *
 * 三重门槛(weighted avg + trials + 最小观察期)任一不满足都 hold。
 *
 * 阈值比较严格的设计意图:
 *   - canary: -0.3 与 Phase 7 的 ORGANISM_LOSS_THRESHOLD(-0.3)对齐
 *     —— 大多数样本都落在 loss 区才降级,避免中性 noise 触发
 *   - stable: -0.2 更严 —— stable 已经证明过自己,要更大的"证据强度"才回退
 *   - trials 门槛让刚晋升样本稀少的 organism 不被第一条低分拖垮
 *   - MIN_AGE_DAYS 让 organism 至少有机会接受一些新样本,不被历史均值锁死
 *
 * 最近晋升时间戳
 * ────────────
 * 从 promotions.ndjson 最后一条 "to=<status>" 的 Transition.at 取;读不到就当
 * 晋升时间戳是 null(组织可能是手工 seed 进来,没进过 FSM),回退为
 * lastTrialAt(manifest.fitness.lastTrialAt)—— 保守地把"最近一次 fitness 事件"
 * 当成晋升时刻代理,至少保证 MIN_AGE_DAYS 条件不会永远 satisfies。
 *
 * 与 Phase 38 archive watchdog 的区别
 * ─────────────────────────────────
 *   - Phase 38 基于"无调用"(时间信号 → stale)
 *   - Phase 40 基于"有调用但评分差"(fitness 信号 → rollback)
 *   两者互补:一个管"死去",一个管"活着但失能"
 *   rollback 走完回到 shadow,再拉胯会走 shadow→vetoed,vetoed 是终态(ALLOWED 无出边)
 *   —— 两套闸门串联,最终都能收敛到终态。
 */

import { readOrganism, listOrganismIds, promoteOrganism } from '../arena/arenaController.js'
import { readRecentTransitions } from '../arena/promotionFsm.js'
import {
  recordRollback as recordRollbackQuarantine,
  type QuarantineRecordResult,
} from '../arena/quarantineTracker.js'
import { aggregateOrganismFitness, type OrganismFitnessAggregate } from '../oracle/oracleAggregator.js'
import { loadTunedRollbackThresholds } from '../oracle/rollbackThresholdTuner.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { OrganismManifest, OrganismStatus } from '../types.js'

// ── 阈值常量(Phase 40 DEFAULT,Phase 41 tuner fallback)─────────
//
// Phase 41 起 evaluateRollback 在运行时调 loadTunedRollbackThresholds() 读
// 实际使用的值;以下 export const 继续作为"工厂默认"保留,供:
//   - 测试对照(verify 默认行为)
//   - 诊断 / 文档说明 Phase 40 初始设计值
//   - Phase 41 DEFAULT_TUNED_ROLLBACK_THRESHOLDS 的 source of truth(间接)
//
// 文件缺失时 loadTunedRollbackThresholds 返回与这些常量一致的 DEFAULT,
// 行为 100% 向后兼容。

export const ROLLBACK_CANARY_AVG_MAX = -0.3
export const ROLLBACK_CANARY_MIN_TRIALS = 3
export const ROLLBACK_CANARY_MIN_AGE_DAYS = 3

export const ROLLBACK_STABLE_AVG_MAX = -0.2
export const ROLLBACK_STABLE_MIN_TRIALS = 5
export const ROLLBACK_STABLE_MIN_AGE_DAYS = 7

// ── 类型 ────────────────────────────────────────────────────────

/** 单个 organism 的评估结果 */
export interface RollbackEvaluation {
  organismId: string
  name: string
  fromStatus: 'canary' | 'stable'
  /** 用于判定的 Phase 39 weighted aggregate */
  aggregate: OrganismFitnessAggregate
  /** 晋升到当前状态的时间戳(ISO,可能来自 promotions.ndjson 或 lastTrialAt fallback) */
  promotedAt: string | null
  /** 晋升后经过的天数(promotedAt 缺失时为 null) */
  ageSincePromotionDays: number | null
  /** 触发的阈值 snapshot(便于 rationale 记录) */
  thresholds: {
    avgMax: number
    minTrials: number
    minAgeDays: number
  }
  /** 决定降级 / hold */
  decision: 'rollback' | 'hold'
  /** 人类可读理由(写进 transition.rationale) */
  rationale: string
}

/** 一次全量扫描产物 */
export interface RollbackScanResult {
  scannedCanary: number
  scannedStable: number
  rollbackCount: number
  holdCount: number
  evaluations: RollbackEvaluation[]
}

// ── 工具函数 ────────────────────────────────────────────────────

/**
 * 从 promotions.ndjson 找 organism 最近一次"迁入 status"的时间戳。
 * 没有任何符合条件的 transition → null(可能是 seed-in,从未经 FSM)。
 *
 * 实现复用 readRecentTransitions(limit 大数)以保持和其它模块一致的读路径;
 * 我们只需要 latest —— 直接取 max(Date.parse(t.at)),不依赖 readRecent 的
 * 排序方向(它的内部排序语义未来可能变化,这样更鲁棒)。理论上 ledger 会被
 * Phase 12 轮换,保持 limit=2000 足够覆盖"最近一次晋升"的典型场景。
 */
export function findLastPromotionAt(
  organismId: string,
  toStatus: OrganismStatus,
  limit: number = 2000,
): string | null {
  try {
    const recents = readRecentTransitions(limit)
    let bestAt: string | null = null
    let bestTs = -Infinity
    for (const t of recents) {
      if (t.organismId !== organismId) continue
      if (t.to !== toStatus) continue
      const ts = Date.parse(t.at)
      if (!Number.isFinite(ts)) continue
      if (ts > bestTs) {
        bestTs = ts
        bestAt = t.at
      }
    }
    return bestAt
  } catch {
    return null
  }
}

/**
 * 纯计算:给定 manifest + aggregate,产出 RollbackEvaluation。
 * 不触碰文件系统(除了上面 findLastPromotionAt 透明读 ledger)。
 *
 * nowMs 参数给测试注入 deterministic now;默认 Date.now()。
 */
export function evaluateRollback(
  manifest: OrganismManifest,
  aggregate: OrganismFitnessAggregate,
  nowMs: number = Date.now(),
): RollbackEvaluation | null {
  const status = manifest.status
  if (status !== 'canary' && status !== 'stable') {
    // Phase 40 只关心 canary/stable;proposal/shadow/vetoed/archived 跳过
    return null
  }

  // Phase 41 runtime:读 tuned 文件;缺失时 loadTunedRollbackThresholds 返回
  // 与 Phase 40 export const 一致的 DEFAULT。tuner 调高调低后 evaluateRollback
  // 下一次调用自动用新阈值(mtime cache)。
  const tuned = loadTunedRollbackThresholds()
  const thresholds = status === 'canary' ? tuned.canary : tuned.stable

  // 晋升时间戳:优先读 promotions.ndjson,读不到 fallback 到 lastTrialAt
  const promotedAt =
    findLastPromotionAt(manifest.id, status) ??
    manifest.fitness?.lastTrialAt ??
    null

  let ageSincePromotionDays: number | null = null
  if (promotedAt) {
    const ts = Date.parse(promotedAt)
    if (Number.isFinite(ts)) {
      ageSincePromotionDays = Math.max(0, (nowMs - ts) / 86400_000)
    }
  }

  // 三重门槛任一不满足 → hold
  const reasons: string[] = []
  if (aggregate.trials < thresholds.minTrials) {
    reasons.push(`trials=${aggregate.trials} < min=${thresholds.minTrials}`)
  }
  if (aggregate.avg > thresholds.avgMax) {
    reasons.push(`avg=${aggregate.avg.toFixed(3)} > threshold=${thresholds.avgMax}`)
  }
  if (ageSincePromotionDays == null) {
    reasons.push(`promotedAt unknown`)
  } else if (ageSincePromotionDays < thresholds.minAgeDays) {
    reasons.push(
      `ageSincePromotion=${ageSincePromotionDays.toFixed(1)}d < min=${thresholds.minAgeDays}d`,
    )
  }

  const shouldRollback = reasons.length === 0

  const rationale = shouldRollback
    ? `auto-rollback (Phase 40): weighted avg=${aggregate.avg.toFixed(3)} ≤ ${thresholds.avgMax}, trials=${aggregate.trials} ≥ ${thresholds.minTrials}, ageSincePromotion=${ageSincePromotionDays!.toFixed(1)}d ≥ ${thresholds.minAgeDays}d`
    : `hold (Phase 40): ${reasons.join('; ')}`

  return {
    organismId: manifest.id,
    name: manifest.name,
    fromStatus: status,
    aggregate,
    promotedAt,
    ageSincePromotionDays,
    thresholds,
    decision: shouldRollback ? 'rollback' : 'hold',
    rationale,
  }
}

// ── 主 API ─────────────────────────────────────────────────────

/**
 * 扫 canary + stable 两层,对每个 organism 评估 rollback。
 *
 * 纯读(listOrganismIds + readOrganism + aggregateOrganismFitness),不写盘。
 * 调用方决定是否走 applyRollback 执行降级。
 */
export function scanRollbackCandidates(opts?: {
  nowMs?: number
}): RollbackScanResult {
  const now = opts?.nowMs ?? Date.now()
  const out: RollbackScanResult = {
    scannedCanary: 0,
    scannedStable: 0,
    rollbackCount: 0,
    holdCount: 0,
    evaluations: [],
  }

  for (const status of ['canary', 'stable'] as const) {
    const ids = listOrganismIds(status)
    for (const id of ids) {
      const manifest = readOrganism(status, id)
      if (!manifest) continue
      if (status === 'canary') out.scannedCanary++
      else out.scannedStable++
      const aggregate = aggregateOrganismFitness(id)
      const ev = evaluateRollback(manifest, aggregate, now)
      if (!ev) continue
      out.evaluations.push(ev)
      if (ev.decision === 'rollback') out.rollbackCount++
      else out.holdCount++
    }
  }
  return out
}

/**
 * 对一条 RollbackEvaluation 执行降级(fromStatus → shadow)。
 *
 * 走 promoteOrganism:FSM 校验 + moveOrganism + recordTransition。
 * 返回 PromotionResult,失败时 ok=false + reason。
 *
 * Phase 40 观察纪律:执行后 oracleScoreSignature 透传 aggregate.lastScoreSignature
 * —— 这样回查 promotions.ndjson 能直接定位"是哪次 fitness 打分触发的 rollback",
 * 审计闭环。
 *
 * Phase 44(P1-⑤):rollback 成功后副路径写 quarantineTracker。纪律:
 *   - 只在 promoteOrganism.ok===true 之后调用,失败路径不记账
 *   - manifest 必须在 move 之前读(move 之后 fromStatus 目录已空),
 *     所以在调 promoteOrganism 之前先读一次 —— 多一次 fs 读,换来的是
 *     quarantine 记账所需的 sourceFeedbackMemories
 *   - quarantine 的 recordRollback 内部自吞异常,这里不包额外 try
 *   - 结果透传到返回值 `.quarantine`(可选),便于命令层 /evolve-rollback 展示
 */
export function applyRollback(
  ev: RollbackEvaluation,
): ReturnType<typeof promoteOrganism> & { quarantine?: QuarantineRecordResult } {
  if (ev.decision !== 'rollback') {
    return { ok: false, reason: `evaluation.decision=${ev.decision}, not a rollback` }
  }

  // Phase 44:在真正 move 之前抓一份 manifest,保证 sourceFeedbackMemories
  // 可供 quarantineTracker 读取。读失败不阻断 rollback 主路径。
  let preMoveManifest: OrganismManifest | null = null
  try {
    preMoveManifest = readOrganism(ev.fromStatus, ev.organismId)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:rollback] pre-move manifest read failed for ${ev.organismId}: ${(e as Error).message}`,
    )
  }

  const result = promoteOrganism({
    id: ev.organismId,
    fromStatus: ev.fromStatus,
    toStatus: 'shadow',
    trigger: 'auto-rollback',
    rationale: ev.rationale,
    oracleScoreSignature: ev.aggregate.lastScoreSignature,
  })

  if (!result.ok) return result

  // Phase 44:副路径,记 rollback 事件到 quarantine 基因池
  let quarantine: QuarantineRecordResult | undefined
  if (preMoveManifest) {
    quarantine = recordRollbackQuarantine(preMoveManifest)
    // P0-③ 同一 transition 回流给对应 learner(kind → domain):
    //   - hook   → hook-gate(fired=true, turnOutcome='loss')
    //   - skill  → skill-route(invoked=true, turnOutcome='loss')
    //   - prompt → prompt-snippet(injected=true, turnOutcome='loss')
    //
    // 以 fire-and-forget 方式调度:
    //   - 写端内部已自吞异常 + 统一 debug log(runtime.recordLearnerFromTransition)
    //   - 不 await 是因为 applyRollback 的调用方(scanRollbackCandidates 主循环)
    //     是同步链路,不希望被 learner load/save 的 fs IO 阻塞。
    //   - 若未来某个 learner IO 变慢,这里也最多是 rollback 对应的 outcome 丢失
    //     一次(next rollback 再补),不会污染 FSM 主流程。
    void import('../learners/runtime.js')
      .then(mod => mod.recordLearnerFromTransition(preMoveManifest!, 'loss'))
      .catch(e =>
        logForDebugging(
          `[autoEvolve:rollback] learner record deferred failed for ${ev.organismId}: ${(e as Error).message}`,
        ),
      )
  } else {
    // manifest 丢失(极少数情况:手工删除 / ledger 异常)—— 不硬失败,
    // 仅 debug log。quarantine 留空。
    logForDebugging(
      `[autoEvolve:rollback] quarantine skipped for ${ev.organismId}: manifest unavailable before move`,
    )
  }

  return { ...result, quarantine }
}
