/**
 * CompactPlanner (P1-1) — 决策"何时压 / 压哪段 / 用哪个策略"。
 *
 * 设计（#9 修复后）：
 *   - `strategy` 只覆盖 autoCompact 阶段的"重量级路径"：
 *       full_compact / session_memory / micro_compact / noop
 *   - snip / microcompact 的"轻量阶段"由独立开关 runSnip / runMicro 控制，
 *     默认都为 true，保留 query.ts 的 legacy 不变量（"snip before micro,
 *     both may run"）。只有明确信号才会把它们关掉（例如 noop + 空闲会话
 *     可以关 micro）。
 *
 * 规则树：
 *   signal.kind === 'manual'              → full_compact + runSnip/runMicro=true
 *   ratio > 0.92                          → full_compact（snip/micro 跳过）
 *   ratio > 0.85                          → session_memory（snip/micro 跳过）
 *   heavyToolResultCount > 0              → strategy=noop, runMicro=true, runSnip=legacy
 *   user_idle && messageCount > 40        → strategy=noop, runSnip=true,  runMicro=legacy
 *   else                                  → noop + 全部沿用 legacy
 *
 * 影子模式期间只返回 plan 不执行。Executor 拿到 plan 再分派给既有的
 * compact 实现，避免引入新的压缩逻辑。
 */

import type { CompactPlan, MessageRef, TokenStats, TriggerSignal } from './types.js'

interface PlannerInput {
  messageCount: number
  stats: TokenStats
  signal: TriggerSignal
  heavyToolResultCount: number
  messageScores?: number[]
  /**
   * Phase 2 Shot 6:过去 10min 已发生的 compact 次数,由 kernel.compactBurst 推入。
   * 若 ≥3 且非紧急/非 manual,降级为 noop 防抖动。undefined / 0 等同旧行为。
   */
  recentCompactCount?: number
}

// Shot 6:压缩反抖动阈值。过去窗口内已 compact ≥ 此值 → 再压基本也降不了多少,
// 强制回到 legacy snip+micro 给用户上下文留出恢复窗口。
const COMPACT_BURST_THRESHOLD = 3

export function plan(input: PlannerInput): CompactPlan {
  const { stats, signal, heavyToolResultCount, messageCount, messageScores } =
    input
  const ratio = stats.ratio
  const lowRelevanceCount =
    messageScores?.filter(score => score < 0.35).length ?? 0

  // Legacy 默认:snip 跟随 feature('HISTORY_SNIP'),micro 无条件执行。
  // Planner 默认把两者都开启,调用方(query.ts)再与 feature flag 取与。
  const LEGACY_RUN_SNIP = true
  const LEGACY_RUN_MICRO = true

  // Phase 3 影子字段 — 独立于现有 strategy 的两条建议开关。
  //   runCollapseSuggest:ratio ≥ 0.78 或 heavyToolResultCount ≥ 2 或 messageCount > 60
  //     (比 contextCollapse 自带的 0.9 更早,给 ContextBroker Phase 4 做提前触发的信号)
  //   runOffloadSuggest:heavyToolResultCount ≥ 1(更激进的 offload 建议,供未来消费)
  const runCollapseSuggest =
    ratio >= 0.78 || heavyToolResultCount >= 2 || messageCount > 60
  const runOffloadSuggest = heavyToolResultCount >= 1

  if (signal.kind === 'manual') {
    return {
      strategy: 'full_compact',
      reason: 'manual trigger',
      estimatedTokensSaved: Math.floor(stats.usedTokens * 0.6),
      importanceFloor: 0.2,
      runSnip: LEGACY_RUN_SNIP,
      runMicro: LEGACY_RUN_MICRO,
      runCollapse: runCollapseSuggest,
      runOffload: runOffloadSuggest,
    }
  }

  if (ratio > 0.92) {
    // 严重 token 压力:重量路径会彻底改写 transcript,轻量阶段没必要再跑。
    return {
      strategy: 'full_compact',
      reason: `token ratio ${ratio.toFixed(2)} > 0.92`,
      estimatedTokensSaved: Math.floor(stats.usedTokens * 0.5),
      importanceFloor: 0.25,
      runSnip: false,
      runMicro: false,
      runCollapse: runCollapseSuggest,
      runOffload: runOffloadSuggest,
      preserveAsEpisodic: findPreservableMessages(0.25, 0.4, messageScores),
    }
  }

  // Shot 6 anti-thrash:非紧急(已跳过 ratio>0.92)、非 manual 的压力场景下,
  // 若 10min 内已 compact ≥3 次,不再追加压缩 —— 再压一次通常降不了多少,
  // 只会打断用户上下文。放在 ratio>0.92 之后 = 紧急仍可抢断防抖。
  if ((input.recentCompactCount ?? 0) >= COMPACT_BURST_THRESHOLD) {
    return {
      strategy: 'noop',
      reason: `compact burst ${input.recentCompactCount} within 10min → anti-thrash, legacy snip+micro`,
      estimatedTokensSaved: 0,
      importanceFloor: 0,
      runSnip: LEGACY_RUN_SNIP,
      runMicro: LEGACY_RUN_MICRO,
      // anti-thrash 期内不建议再 collapse(避免二次打断);offload 仍允许
      runCollapse: false,
      runOffload: runOffloadSuggest,
    }
  }

  if (ratio > 0.85) {
    return {
      strategy: 'session_memory',
      reason: `token ratio ${ratio.toFixed(2)} > 0.85`,
      estimatedTokensSaved: Math.floor(stats.usedTokens * 0.3),
      importanceFloor: 0.2,
      runSnip: false,
      runMicro: false,
      runCollapse: runCollapseSuggest,
      runOffload: runOffloadSuggest,
      preserveAsEpisodic: findPreservableMessages(0.2, 0.35, messageScores),
    }
  }

  if (heavyToolResultCount > 0) {
    // 轻量路径：保留 legacy 不变量（snip+micro 同跑），reason 带上触发源。
    return {
      strategy: 'noop',
      reason:
        `heavy tool results: ${heavyToolResultCount}` +
        `, low relevance: ${lowRelevanceCount} → legacy snip+micro`,
      estimatedTokensSaved: heavyToolResultCount * 2000,
      importanceFloor: 0.1,
      runSnip: LEGACY_RUN_SNIP,
      runMicro: LEGACY_RUN_MICRO,
      runCollapse: runCollapseSuggest,
      runOffload: runOffloadSuggest,
    }
  }

  if (signal.kind === 'user_idle' && messageCount > 40) {
    return {
      strategy: 'noop',
      reason: 'user idle + long transcript → legacy snip+micro',
      estimatedTokensSaved: 1000,
      importanceFloor: 0.15,
      runSnip: LEGACY_RUN_SNIP,
      runMicro: LEGACY_RUN_MICRO,
      // idle 是做后台维护的好时机 — 即使 ratio 还没上来,也建议试做 collapse
      runCollapse: true,
      runOffload: runOffloadSuggest,
    }
  }

  // 无触发：保持 legacy 行为以满足零回归（#1 修复）。
  return {
    strategy: 'noop',
    reason: 'no trigger met → legacy snip+micro',
    estimatedTokensSaved: 0,
    importanceFloor: 0,
    runSnip: LEGACY_RUN_SNIP,
    runMicro: LEGACY_RUN_MICRO,
    runCollapse: runCollapseSuggest,
    runOffload: runOffloadSuggest,
  }
}

/**
 * 找出"不够重要到保留在 L1 工作记忆"但"有价值降级到 L2 episodic"的消息。
 * P2 shadow 阶段暂返回空数组，为 P3 切流做准备。
 *
 * @param importanceFloor - planner 决定的压缩阈值（低于此分数的消息将被压缩）
 * @param preserveThreshold - 高于此分数的被压缩消息值得降级为 episodic
 */
function findPreservableMessages(
  _importanceFloor: number,
  preserveThreshold: number,
  messageScores: number[] = [],
): MessageRef[] {
  if (messageScores.length === 0) {
    return []
  }

  const refs: MessageRef[] = []
  let startIdx: number | null = null
  let maxScore = 0

  const flush = (endIdx: number) => {
    if (startIdx === null) return
    refs.push({
      startIdx,
      endIdx,
      importanceScore: maxScore,
      suggestedCause: 'relevant_but_compressible',
    })
    startIdx = null
    maxScore = 0
  }

  for (let index = 0; index < messageScores.length; index++) {
    const score = messageScores[index] ?? 0
    if (score >= preserveThreshold && score < 0.95) {
      if (startIdx === null) {
        startIdx = index
      }
      maxScore = Math.max(maxScore, score)
      continue
    }
    flush(index)
  }
  flush(messageScores.length)

  return refs
}
