/**
 * autoEvolve / learners / runtime —— P0-③ runtime 门面
 *
 * 背景
 * ────
 * P0-①+② 把 hook-gate / skill-route / prompt-snippet 三个 learner 的**读写 API
 * 与 JSON 存储**上线了,但运行时没有任何消费点 —— 参数在磁盘上自转,没人听。
 * P0-③ 把三者接入真实决策点:
 *   - hookGate:      execCommandHook 对 autoEvolve 来源 hook 做软门采样
 *   - skillRoute:    localSearch 技能召回按 routePrior 增加第 5 路 RRF 维度
 *   - promptSnippet: 可选 prompt 片段注入前 Bernoulli 采样
 *
 * 本文件是"读端"的共享工具;写端统一入口 `recordLearnerFromTransition` 由
 * rollbackWatchdog(loss)与 promoteOrganism→stable(win)调用,避免每个调用点
 * 都自己拼 outcome shape。
 *
 * 设计纪律
 * ───────
 *  - 读端**硬件最小化**:参数从 fs 读 → clamp → 直接采样,不走 learner registry
 *    的 async resolve(热路径)
 *  - 写端**路由统一**:按 manifest.kind 分派到对应 learner,未知 kind 静默 no-op
 *  - 失败绝对静默:任何一处抛错不阻塞主路径(hook 执行 / 技能召回 / 提示词组装)
 *  - 探索保留:即使 weight → 0.02 依然有 2% 概率通过,避免"死去的基因永远不
 *    再被测试",对齐 ε-greedy 的基本纪律
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  ensureBuiltinLearners,
  recordOutcome,
} from '../index.js'
import type { OrganismManifest } from '../types.js'
import { getHookGateWeight } from './hookGate.js'
import { getPromptSnippetWeight } from './promptSnippet.js'

// ── 常量 ──────────────────────────────────────────────────────

/**
 * hookGate 软门阈值:只有当某 hook 的 gateWeight 低于此值时才启用采样。
 *
 * 设计理由:
 *   - DEFAULT_GATE_WEIGHT = 0.8(冷启动偏向保守放行)
 *   - 若 "weight < threshold 才采样"的策略不存在,新 hook 冷启动就有 20% 被丢,
 *     对用户造成困惑。所以阈值 0.35 表示"只有已经学到明显负向(几次 loss 后
 *     才会跌破 0.35)的 hook 才会被采样"。
 *   - 0.35 与 kinship diversity 的 LOW_DIVERSITY_THRESHOLD 一致,便于后续统一
 *     "0.35 作为系统侧软告警位"的心智模型。
 */
export const HOOK_GATE_SOFT_THRESHOLD = 0.35

/**
 * autoEvolve 自带 hook 的 command 路径前缀正则。
 *
 * 语义:autoEvolve 安装的 hook 脚本固定落在
 *   ~/.claude/autoEvolve/installed-hooks/<organismId>/hook.sh
 * 通过这个前缀可以可靠地区分 organism hook 与用户手写 hook —— 后者不参与
 * 本 learner 的任何决策(避免误改用户意图)。
 *
 * `CLAUDE_CONFIG_DIR` 在测试 / 自定义场景下会改变 ~/.claude 位置,所以此处
 * 只匹配相对目录特征 `/autoEvolve/installed-hooks/<id>/`,对绝对前缀无要求。
 */
const AUTOEVOLVE_HOOK_COMMAND_RE = /autoEvolve\/installed-hooks\/([A-Za-z0-9_-]+)\//

// ── hookGate 读端 ────────────────────────────────────────────

export interface HookGateDecision {
  /** true:本次 hook 应被跳过;false:按正常路径执行 */
  skip: boolean
  /** 对应 organism 的 gateWeight(0.0~1.0);无法解析时为 null */
  weight: number | null
  /** 从 command 里抽出来的 organism id(非 autoEvolve hook 时为 null) */
  organismId: string | null
  /** 说明位:当没采样时为 'above-threshold' / 'not-autoevolve' / 'no-weight' */
  reason: string
}

/**
 * hookGate 读端决策:给定 hook.command 字符串,判断是否应跳过。
 *
 * 逻辑:
 *   1. command 里能抽到 `autoEvolve/installed-hooks/<id>/` → id;否则不管
 *   2. 读 gateWeight;默认 0.8 时 skip=false
 *   3. weight ≥ HOOK_GATE_SOFT_THRESHOLD → skip=false(热 hook 不干扰)
 *   4. weight < HOOK_GATE_SOFT_THRESHOLD → Math.random() < weight 决定放行
 *      → 也就是说 weight=0.20 有 20% 放行 / 80% 跳过,weight=0.02 有 2% 放行
 */
export async function decideHookGate(
  command: string | undefined | null,
): Promise<HookGateDecision> {
  if (!command) {
    return { skip: false, weight: null, organismId: null, reason: 'not-autoevolve' }
  }
  const m = command.match(AUTOEVOLVE_HOOK_COMMAND_RE)
  if (!m) {
    return { skip: false, weight: null, organismId: null, reason: 'not-autoevolve' }
  }
  const organismId = m[1]!

  let weight: number
  try {
    weight = await getHookGateWeight(organismId)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:runtime] hook gate read failed for ${organismId}: ${(e as Error).message}`,
    )
    return { skip: false, weight: null, organismId, reason: 'no-weight' }
  }

  if (weight >= HOOK_GATE_SOFT_THRESHOLD) {
    return { skip: false, weight, organismId, reason: 'above-threshold' }
  }

  // 低于阈值 → ε-greedy 采样。weight 即"放行概率"。
  const sample = Math.random()
  const skip = sample >= weight
  return {
    skip,
    weight,
    organismId,
    reason: skip ? 'sampled-out' : 'sampled-in',
  }
}

// ── skillRoute 读端 ──────────────────────────────────────────

/**
 * 批量读 routePriors —— localSearch 每次 O(skills) 次 fs 读不划算,
 * 一次性 snapshot 给出 map。
 */
export async function loadSkillRoutePriorsSnapshot(): Promise<
  Readonly<Record<string, number>>
> {
  try {
    const { skillRouteLearner } = await import('./skillRoute.js')
    const params = await skillRouteLearner.load()
    return params.routePriors
  } catch (e) {
    logForDebugging(
      `[autoEvolve:runtime] loadSkillRoutePriorsSnapshot failed: ${(e as Error).message}`,
    )
    return {}
  }
}

/**
 * 给 skill name → 软分(0.5 为中性;>0.5 奖励;<0.5 惩罚)。
 * 未登记 → DEFAULT_ROUTE_PRIOR(0.5)→ RRF 入参为 0 不影响排序。
 *
 * 用法(在 localSearch RRF 维度里):
 *   const priorScores = new Map<string, number>()
 *   for (const skill of pruned) {
 *     const p = getSkillRoutePriorBias(snapshot, skill.name)
 *     if (p !== 0) priorScores.set(skill.name, p)
 *   }
 *   rrfFuse([...existing, { ranking: priorScores, weight: SKILL_ROUTE_FUSION_WEIGHT }])
 */
export function getSkillRoutePriorBias(
  snapshot: Readonly<Record<string, number>>,
  skillName: string,
): number {
  const p = snapshot[skillName]
  if (typeof p !== 'number' || !Number.isFinite(p)) return 0
  // 把 [0.02, 0.98] 映射到 [-0.48, +0.48],中性 0.5 → 0
  return p - 0.5
}

/**
 * skillRoute RRF 融合权重。保守取一个非常小的数,避免盖过 lexical/context。
 * 与 HEAT_FUSION_WEIGHT(0.05)对齐量级 —— 这个信号同样只做 tiebreaker。
 */
export const SKILL_ROUTE_FUSION_WEIGHT = 0.05

// ── promptSnippet 读端 ──────────────────────────────────────

/**
 * 可选 snippet 是否应注入的决策:Bernoulli(weight)。
 * 未登记 → DEFAULT_SELECT_WEIGHT(0.8)→ 80% 注入。
 *
 * 与 hookGate 不同,promptSnippet 没有"阈值区间" —— 每次调用都是独立的
 * Bernoulli 采样。理由:prompt 片段的影响面小、反馈弱,保留采样可以持续
 * 探索;而 hook 的副作用强,只有低 weight 才有必要 gate。
 */
export async function shouldInjectOptionalSnippet(
  snippetId: string,
): Promise<{ inject: boolean; weight: number }> {
  let weight: number
  try {
    weight = await getPromptSnippetWeight(snippetId)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:runtime] prompt snippet read failed for ${snippetId}: ${(e as Error).message}`,
    )
    return { inject: true, weight: 0.8 } // 读失败走默认放行
  }
  const inject = Math.random() < weight
  return { inject, weight }
}

// ── 写端:从 FSM transition 路由到对应 learner ─────────────────

export type LearnerTurnOutcome = 'win' | 'loss' | 'neutral'

/**
 * FSM 转换(rollback / promotion)发生后,按 manifest.kind 把 outcome 回流到
 * 对应 learner。统一入口,让多个调用点(rollbackWatchdog / arenaController)
 * 不必各自 switch-case。
 *
 * 当前支持的 kind:
 *   - 'hook'   → hookGateLearner
 *   - 'skill'  → skillRouteLearner
 *   - 'prompt' → promptSnippetLearner
 *   - 'command'/'agent' 目前没有 learner,静默跳过(未来再接)
 *
 * 所有异常自吞 + debug log。
 */
export async function recordLearnerFromTransition(
  manifest: OrganismManifest,
  turnOutcome: LearnerTurnOutcome,
): Promise<void> {
  try {
    // 确保内置 learner 已注册 —— 本函数可能在任何调用点被首次调用,
    // registry 若为空,recordOutcome 会静默 no-op 吞掉信号。
    await ensureBuiltinLearners()
    switch (manifest.kind) {
      case 'hook':
        await recordOutcome('hook-gate', {
          hookName: manifest.id,
          fired: true,
          turnOutcome,
        })
        break
      case 'skill':
        await recordOutcome('skill-route', {
          skillId: manifest.id,
          invoked: true,
          turnOutcome,
        })
        break
      case 'prompt':
        await recordOutcome('prompt-snippet', {
          snippetId: manifest.id,
          injected: true,
          turnOutcome,
        })
        break
      default:
        // command / agent / 其它 kind 暂无 learner,静默跳过
        break
    }
  } catch (e) {
    logForDebugging(
      `[autoEvolve:runtime] recordLearnerFromTransition failed for ${manifest.id} (${manifest.kind}/${turnOutcome}): ${(e as Error).message}`,
    )
  }
}
