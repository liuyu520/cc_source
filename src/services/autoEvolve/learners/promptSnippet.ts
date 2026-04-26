/**
 * autoEvolve / learners / promptSnippet —— 学习每段可选 prompt snippet 的选用权重。
 *
 * 问题:
 *   Claude Code 的 system prompt 里有大量"可选片段":
 *     - CLAUDE.md 局部段落
 *     - memory MEMORY.md 条目(按 frontmatter description 决定是否注入)
 *     - 各 feature 的 guide 文本(blast-radius / self-review / intent-recall 等)
 *   目前注入与否是静态规则(总是注入 / 按 feature flag 开关)。但某些 snippet 在
 *   某用户上长期"被 rollback 所关联"(注入后质量反而变差) —— 应该自动降权。
 *
 * 本 learner 维护每个 snippetId 的 selectWeight ∈ [0,1]:
 *   - 被注入且 turn 为 'win'  → selectWeight 上调
 *   - 被注入且 turn 为 'loss' → selectWeight 下调
 *   - 未注入或 neutral        → 不动 / 微收敛
 *
 * 消费侧(未来接入,本 PR 不改):
 *   - system prompt 装配器在 append 某 snippet 前读 getPromptSnippetWeight(id),
 *     以 weight 为概率做 Bernoulli 采样:weight 高则注入,低则跳过。
 *   - 特别地:MEMORY.md 里 "memory hygiene" 提示 learner 可以独立分 slot。
 *
 * 结构完全对称于 hookGate / skillRoute,便于后续统一观测。
 */

import type { Learner } from '../types.js'
import { clamp, makeJsonLoader, makeJsonSaver, roundTo } from './shared.js'

// ── 类型 ──────────────────────────────────────────────────────────────
export interface PromptSnippetParams {
  /** snippetId → selectWeight。key 建议用 'memory:<file>' / 'claude-md:<heading>' 这样有命名空间的 slug。 */
  selectWeights: Record<string, number>
  updatedAt: string
}

export interface PromptSnippetOutcome {
  /** snippet 的唯一标识(调用方自定义 slug,建议带命名空间) */
  snippetId: string
  /** 本轮是否真的 inject 进 system prompt */
  injected: boolean
  /** 该 turn 的 outcome */
  turnOutcome: 'win' | 'loss' | 'neutral'
}

// ── 常量 ──────────────────────────────────────────────────────────────

export const DEFAULT_PROMPT_SNIPPET_PARAMS: PromptSnippetParams = {
  selectWeights: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
}

/** 未见过的 snippet 初始 weight —— 偏向放行(0.8),避免冷启动就屏蔽 */
export const DEFAULT_SELECT_WEIGHT = 0.8

/** 学习率 —— 与其他 learner 对齐 */
const LEARNING_RATE = 0.05

/** neutral 样本微收敛 */
const NEUTRAL_PULL = 0.01

// ── update 核心 ───────────────────────────────────────────────────────

export function updatePromptSnippetParams(
  current: PromptSnippetParams,
  outcome: PromptSnippetOutcome,
): PromptSnippetParams {
  // 未注入的样本不改权重(与 hookGate 的 fired=false 同构)。
  if (!outcome.injected) return current

  const next: PromptSnippetParams = {
    selectWeights: { ...current.selectWeights },
    updatedAt: new Date().toISOString(),
  }

  const prev =
    typeof next.selectWeights[outcome.snippetId] === 'number'
      ? next.selectWeights[outcome.snippetId]
      : DEFAULT_SELECT_WEIGHT

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

  next.selectWeights[outcome.snippetId] = roundTo(clamp(updated, 0.02, 0.98), 3)
  return next
}

// ── Learner 实例 ──────────────────────────────────────────────────────

export const promptSnippetLearner: Learner<
  PromptSnippetParams,
  PromptSnippetOutcome
> = {
  domain: 'prompt-snippet',
  defaults: DEFAULT_PROMPT_SNIPPET_PARAMS,
  load: makeJsonLoader<PromptSnippetParams>(
    'prompt-snippet',
    DEFAULT_PROMPT_SNIPPET_PARAMS,
    parsed => {
      const weights = (parsed.selectWeights ?? {}) as Record<string, unknown>
      const clean: Record<string, number> = {}
      for (const [id, v] of Object.entries(weights)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          clean[id] = clamp(v, 0.02, 0.98)
        }
      }
      return {
        selectWeights: clean,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }
    },
  ),
  save: makeJsonSaver<PromptSnippetParams>('prompt-snippet'),
  update: updatePromptSnippetParams,
}

// ── 便捷读出口 ────────────────────────────────────────────────────────

/**
 * 读某 snippet 当前的 selectWeight。缺失返回 DEFAULT_SELECT_WEIGHT(0.8)。
 *
 * 注入决策建议:
 *   if (Math.random() < weight) injectSnippet(id)
 * —— 概率式采样同时保留了 exploration,避免 weight 不可恢复。
 */
export async function getPromptSnippetWeight(
  snippetId: string,
): Promise<number> {
  try {
    const params = await promptSnippetLearner.load()
    const w = params.selectWeights[snippetId]
    return typeof w === 'number' ? w : DEFAULT_SELECT_WEIGHT
  } catch {
    return DEFAULT_SELECT_WEIGHT
  }
}
