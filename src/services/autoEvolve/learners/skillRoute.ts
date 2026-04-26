/**
 * autoEvolve / learners / skillRoute —— 学习每个 skill 在召回阶段的 prior。
 *
 * 问题:
 *   /intent-recall 与 skill-loader 目前按"静态 description 匹配 + 首字母优先"做召回。
 *   同一个 skill description 在不同用户/不同任务上命中率差异巨大:
 *     - 用户 A 做 CI 相关,`blast-radius` skill 每次都被正确召回 → 高 prior
 *     - 用户 B 做前端,同一个 skill 被误触大量冷启动 → 低 prior
 *   目前没有任何机制把这个分布记下来。
 *
 * 本 learner 维护每个 skillId 的 routePrior ∈ [0,1]:
 *   - 正样本(invoked=true, turnOutcome='win') → prior 提高
 *   - 负样本(invoked=true, turnOutcome='loss') → prior 降低
 *   - invoked=false 的样本当作"被 route 过但 skill 本身没执行" —— 归 neutral,不动
 *
 * 未来消费侧(本 PR 不改,只预留):
 *   - skill-loader 召回排序时把 routePrior 作为乘子叠加到 static score
 *   - /intent-recall 展示时带出 routePrior,供用户观察分布
 *
 * 复用 shared 的 JSON I/O 与 clamp 工具;结构完全对称于 hookGate,便于后续
 * 对二者做 meta-aggregation(比如 domain 均值)。
 */

import type { Learner } from '../types.js'
import { clamp, makeJsonLoader, makeJsonSaver, roundTo } from './shared.js'

// ── 类型 ──────────────────────────────────────────────────────────────
export interface SkillRouteParams {
  /** 每个 skill 的 prior。key = skillId(skills/bundled/<name> 里的目录名)。 */
  routePriors: Record<string, number>
  updatedAt: string
}

export interface SkillRouteOutcome {
  /** 被 route 的 skill id */
  skillId: string
  /** 是否真的被调用(用户接受召回 or skill 被自动挂载) */
  invoked: boolean
  /** 该 turn 的 outcome */
  turnOutcome: 'win' | 'loss' | 'neutral'
}

// ── 常量 ──────────────────────────────────────────────────────────────

export const DEFAULT_SKILL_ROUTE_PARAMS: SkillRouteParams = {
  routePriors: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
}

/** 未见过的 skill 第一次出现时的 prior 初值 —— 中位 0.5,让两侧都有探索空间 */
export const DEFAULT_ROUTE_PRIOR = 0.5

/** 学习率 —— 与 dreamTriage 的 0.05 对齐 */
const LEARNING_RATE = 0.05

/** neutral 样本朝 0.5 微收敛 */
const NEUTRAL_PULL = 0.01

// ── update 核心 ───────────────────────────────────────────────────────

export function updateSkillRouteParams(
  current: SkillRouteParams,
  outcome: SkillRouteOutcome,
): SkillRouteParams {
  // 未 invoked 的 skill 不喂给学习器 —— 那只是"被列进候选",不是真正试错样本。
  if (!outcome.invoked) return current

  const next: SkillRouteParams = {
    routePriors: { ...current.routePriors },
    updatedAt: new Date().toISOString(),
  }

  const prev =
    typeof next.routePriors[outcome.skillId] === 'number'
      ? next.routePriors[outcome.skillId]
      : DEFAULT_ROUTE_PRIOR

  let updated: number
  switch (outcome.turnOutcome) {
    case 'win':
      updated = prev + LEARNING_RATE
      break
    case 'loss':
      updated = prev - LEARNING_RATE
      break
    case 'neutral':
    default:
      updated = prev + (0.5 - prev) * NEUTRAL_PULL
      break
  }

  next.routePriors[outcome.skillId] = roundTo(clamp(updated, 0.02, 0.98), 3)
  return next
}

// ── Learner 实例 ──────────────────────────────────────────────────────

export const skillRouteLearner: Learner<SkillRouteParams, SkillRouteOutcome> = {
  domain: 'skill-route',
  defaults: DEFAULT_SKILL_ROUTE_PARAMS,
  load: makeJsonLoader<SkillRouteParams>(
    'skill-route',
    DEFAULT_SKILL_ROUTE_PARAMS,
    parsed => {
      const priors = (parsed.routePriors ?? {}) as Record<string, unknown>
      const clean: Record<string, number> = {}
      for (const [id, v] of Object.entries(priors)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          clean[id] = clamp(v, 0.02, 0.98)
        }
      }
      return { routePriors: clean, updatedAt: parsed.updatedAt ?? new Date().toISOString() }
    },
  ),
  save: makeJsonSaver<SkillRouteParams>('skill-route'),
  update: updateSkillRouteParams,
}

// ── 便捷读出口 ────────────────────────────────────────────────────────

/**
 * 同步读取某 skill 的当前 routePrior。缺失返回 DEFAULT_ROUTE_PRIOR(0.5)。
 *
 * 消费方(未来的 skill-loader 排序)建议:
 *   final_score = static_match_score * (0.5 + routePrior)
 * —— 这样 prior=0.5 时不偏,prior=1.0 放大 3x,prior=0 压到 0.5x。
 */
export async function getSkillRoutePrior(skillId: string): Promise<number> {
  try {
    const params = await skillRouteLearner.load()
    const p = params.routePriors[skillId]
    return typeof p === 'number' ? p : DEFAULT_ROUTE_PRIOR
  } catch {
    return DEFAULT_ROUTE_PRIOR
  }
}
