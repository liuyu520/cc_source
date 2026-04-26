/**
 * autoEvolve — Learner Registry
 *
 * 承袭 v0.3 设计(docs/self-evolution-kernel-2026-04-22.md §3)。
 *
 * 职责:
 *   - 提供 registerLearner / getLearner / recordOutcome 三个 API
 *   - 单例容器,跨调用共享
 *   - 零副作用:没被注册的 domain 调用 recordOutcome 会静默 no-op
 *
 * 复用:
 *   - 已有的 feedbackLoop.ts 的 ε-greedy 逻辑被封装成 dreamTriageLearner
 *     (见 feedbackLoop.ts 末尾追加的导出),在 bootstrap 时自动注册进来。
 *
 * 首次加载时自动注册 dream-triage,保证业务零改动即可受益。
 */

import { logForDebugging } from '../../utils/debug.js'
import type { Learner } from './types.js'

// ── 单例容器 ────────────────────────────────────────────
const learners = new Map<string, Learner<unknown, unknown>>()

/** 注册或替换一个 learner(同 domain 以最新为准,热替换友好) */
export function registerLearner<P, O>(learner: Learner<P, O>): void {
  learners.set(learner.domain, learner as Learner<unknown, unknown>)
  logForDebugging(`[autoEvolve] learner registered: ${learner.domain}`)
}

/** 读一个 learner(未注册返回 undefined) */
export function getLearner<P, O>(domain: string): Learner<P, O> | undefined {
  return learners.get(domain) as Learner<P, O> | undefined
}

/** 列出所有已注册 domain,供 /evolve-status 展示 */
export function listLearnerDomains(): string[] {
  return Array.from(learners.keys()).sort()
}

/**
 * 上报一个 outcome,自动触发 learner.update + save
 * - 未注册的 domain 静默 no-op(允许调用方无感知地接信号)
 * - 任何异常都吞掉:learner 是软信号,不应影响主流程
 */
export async function recordOutcome(
  domain: string,
  outcome: unknown,
): Promise<void> {
  const l = learners.get(domain)
  if (!l) return
  try {
    const cur = await l.load()
    const next = l.update(cur, outcome)
    const normalized = l.normalize ? l.normalize(next) : next
    await l.save(normalized)
    logForDebugging(`[autoEvolve] recordOutcome ok: ${domain}`)
  } catch (e) {
    logForDebugging(
      `[autoEvolve] recordOutcome failed (${domain}): ${(e as Error).message}`,
    )
  }
}

/**
 * 测试/热重载用:清空注册表。生产路径别用。
 */
export function clearLearnersForTest(): void {
  learners.clear()
}

// ── 自动注册内置 learner ─────────────────────────────────
// 放在文件末尾避免循环依赖(feedbackLoop.ts 不 import autoEvolve)。
// 首次 import 本模块时副作用注册,后续 import 幂等(Map.set 以最新为准)。
//
// 策略:延迟到真正 recordOutcome('dream-triage', ...) 前,
// 由调用方或 bootstrap 主动触发 ensureBuiltinLearners()。
// 这样保持本文件零磁盘/零网络,仅持单例 Map。

let builtinRegistered = false

/**
 * 幂等注册内置 learner。
 * 在下列入口调用一次即可:
 *   - /evolve-status 命令加载时
 *   - recordDreamOutcome 入口(可选,用于闭环)
 *
 * Phase 43 扩展:
 *   除 dreamTriageLearner 外,一起注册 hook-gate / skill-route / prompt-snippet /
 *   auto-continue 四个 built-in learner(src/services/autoEvolve/learners/*.ts)。
 *   它们的 update 规则各自独立,共享 shared.ts 的 JSON I/O 模板。
 *   任何一个模块 load 失败不影响其他 learner 注册 —— 单点故障隔离。
 */
export async function ensureBuiltinLearners(): Promise<void> {
  if (builtinRegistered) return
  // 逐个 try,单个 learner 的导入失败不应阻塞其他 learner。
  // 全部成功后统一把 builtinRegistered 置 true;如果有任一失败,下次调用
  // 会再次尝试(幂等),直至全部就位。
  let allOk = true

  // 1) dream-triage(历史依赖,保持首位)
  try {
    const { dreamTriageLearner } = await import(
      '../autoDream/pipeline/feedbackLoop.js'
    )
    registerLearner(dreamTriageLearner)
  } catch (e) {
    allOk = false
    logForDebugging(
      `[autoEvolve] register dream-triage failed: ${(e as Error).message}`,
    )
  }

  // 2) hook-gate
  try {
    const { hookGateLearner } = await import('./learners/hookGate.js')
    registerLearner(hookGateLearner)
  } catch (e) {
    allOk = false
    logForDebugging(
      `[autoEvolve] register hook-gate failed: ${(e as Error).message}`,
    )
  }

  // 3) skill-route
  try {
    const { skillRouteLearner } = await import('./learners/skillRoute.js')
    registerLearner(skillRouteLearner)
  } catch (e) {
    allOk = false
    logForDebugging(
      `[autoEvolve] register skill-route failed: ${(e as Error).message}`,
    )
  }

  // 4) prompt-snippet
  try {
    const { promptSnippetLearner } = await import(
      './learners/promptSnippet.js'
    )
    registerLearner(promptSnippetLearner)
  } catch (e) {
    allOk = false
    logForDebugging(
      `[autoEvolve] register prompt-snippet failed: ${(e as Error).message}`,
    )
  }

  // 5) auto-continue
  try {
    const { autoContinueLearner } = await import('./learners/autoContinue.js')
    registerLearner(autoContinueLearner)
  } catch (e) {
    allOk = false
    logForDebugging(
      `[autoEvolve] register auto-continue failed: ${(e as Error).message}`,
    )
  }

  if (allOk) builtinRegistered = true
}

// ── Phase 4:stable genome → skill loader 挂接(幂等启动钩子) ──

let stableGenomeRegistered = false

/**
 * 幂等把 `~/.claude/autoEvolve/genome/stable/` 注册到 Claude Code skill loader。
 *
 * 适用场景:
 *   - 进程启动后第一次 `/evolve-status`:保证存量 stable organism 立即可用
 *   - `promoteOrganism(to='stable')` 成功时:新晋升 organism 即时生效
 *     (该路径在 arenaController.promoteOrganism 内直接调用 registerStableGenomeAsSkillDir)
 *
 * 保障:
 *   - 内部委托 addSkillDirectories(),已自带 dedup + 并发锁
 *   - 失败静默(不阻塞调用方),只写 debug 日志
 *   - 仍受显式 skill 加载总闸门控制,避免未输入 `load skill` 时主动扫描 skills
 */
export async function ensureStableGenomeRegistered(): Promise<void> {
  if (stableGenomeRegistered) return
  try {
    const { registerStableGenomeAsSkillDir } = await import(
      './arena/arenaController.js'
    )
    await registerStableGenomeAsSkillDir()
    stableGenomeRegistered = true
  } catch (e) {
    logForDebugging(
      `[autoEvolve] ensureStableGenomeRegistered failed: ${(e as Error).message}`,
    )
  }
}

// 重导出类型 & featureCheck,方便上层统一入口
export type { Learner } from './types.js'
export * from './featureCheck.js'

// v1.0 Phase 5 · MetaGenome 存储层(纯读写,未接入决策点)
export {
  DEFAULT_META_GENOME,
  MUTATION_RATE_MIN,
  MUTATION_RATE_MAX,
  LEARNING_RATE_MIN,
  LEARNING_RATE_MAX,
  SELECTION_PRESSURE_MIN,
  SELECTION_PRESSURE_MAX,
  ARENA_SHADOW_COUNT_MIN,
  ARENA_SHADOW_COUNT_MAX,
  sanitizeMetaGenome,
  loadMetaGenome,
  saveMetaGenome,
  getEffectiveMetaGenome,
  _resetMetaGenomeCacheForTest,
} from './metaEvolve/metaGenome.js'
export type {
  MetaGenome,
  GetEffectiveMetaGenomeOptions,
} from './metaEvolve/metaGenome.js'

// v1.0 Phase 5.2 · MetaOracle(种群级 fitness snapshot,只读)
export {
  ALIVE_STATUSES,
  DEFAULT_META_ORACLE_THRESHOLDS,
  getEffectiveMetaOracleThresholds,
  computeMetaOracleSnapshot,
} from './metaEvolve/metaOracle.js'
export type {
  MetaOracleSnapshot,
  MetaOracleVerdict,
  MetaOracleThresholds,
  ComputeMetaOracleSnapshotOptions,
} from './metaEvolve/metaOracle.js'

// v1.0 Phase 5.4 · MutationRateAdvisor(纯建议,非自动执行)
export {
  advocateMutationRate,
} from './metaEvolve/mutationRateAdvisor.js'
export type {
  MutationRateAdvice,
  MutationRateAdvisorOptions,
  MutationRateDirection,
} from './metaEvolve/mutationRateAdvisor.js'

// v1.0 Phase 5.6 · ArenaShadowCountAdvisor(纯建议,整数步进)
export {
  advocateArenaShadowCount,
} from './metaEvolve/arenaShadowCountAdvisor.js'
export type {
  ArenaShadowCountAdvice,
  ArenaShadowCountAdvisorOptions,
  ArenaShadowCountDirection,
} from './metaEvolve/arenaShadowCountAdvisor.js'

// v1.0 Phase 5.7a · LearningRateAdvisor(与 mutationRate 同向)
export {
  advocateLearningRate,
} from './metaEvolve/learningRateAdvisor.js'
export type {
  LearningRateAdvice,
  LearningRateAdvisorOptions,
  LearningRateDirection,
} from './metaEvolve/learningRateAdvisor.js'

// v1.0 Phase 5.7b · SelectionPressureAdvisor(方向与其它三把相反)
export {
  advocateSelectionPressure,
} from './metaEvolve/selectionPressureAdvisor.js'
export type {
  SelectionPressureAdvice,
  SelectionPressureAdvisorOptions,
  SelectionPressureDirection,
} from './metaEvolve/selectionPressureAdvisor.js'

// Phase 6.5 · MetaActionPlan 共用快照/执行编排读端
export {
  buildMetaActionPlanSnapshot,
  renderMetaActionPlanLines,
  renderMetaOracleAdviceLines,
  renderMetaParamAdviceLines,
  renderMetaApplyPlanLines,
  pickActionableMetaParams,
  getSingleActionableMetaParamName,
} from './metaEvolve/metaActionPlan.js'
export type {
  MetaParamName,
  MetaParamDecision,
  MetaOracleDecision,
  MetaActionPlanSnapshot,
  RenderMetaActionPlanOptions,
  RenderMetaOracleAdviceOptions,
  RenderMetaParamAdviceOptions,
  RenderMetaApplyPlanOptions,
} from './metaEvolve/metaActionPlan.js'
