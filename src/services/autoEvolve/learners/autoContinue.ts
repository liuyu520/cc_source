/**
 * autoEvolve / learners / autoContinue —— 学习 auto-continue LLM 路径的动态 confidence 阈值。
 *
 * 问题:
 *   `src/utils/autoContinueTurnLLM.ts` 里的 `MIN_CONFIDENCE_FOR_CONTINUE = 0.7` 是
 *   2026-04-20 v3 硬编码拍定的折中值 —— 但实际用下来每个用户的协作风格差异巨大:
 *     - 用户 A 经常接受自动续聊 → 0.7 有点保守,错失效率(应下调)
 *     - 用户 B 偏好亲自拍板 → 0.7 偶尔误放行,需要 raise 到 0.8+
 *   这个信号其实由用户的"下一条输入行为"天然给出(打断/继续),完全值得自学习。
 *
 * 本 learner 维护一个一维阈值参数 minConfidenceForContinue ∈ [0.5, 0.95]:
 *   - LLM decided 'continue' 且用户接受(未打断 / 正常推进)→ outcome='accepted' → 阈值下调
 *   - LLM decided 'continue' 但用户打断(重来 / 纠错 / 反悔) → outcome='interrupted' → 阈值上调
 *   - LLM decided 'wait' → 不喂给学习器(没有"若放行"的反事实信号)
 *
 * 消费侧改造(同 PR 的另一处修改):
 *   `autoContinueTurnLLM.detectNextStepIntentViaLLMGated` 的 `options?.minConfidence`
 *   从静态 0.7 fallback 改为"未传时读 learner"。见该文件底部 getDynamicMinConfidenceForContinue。
 *
 * 信号采集侧(留 API,本 PR 不改 REPL):
 *   - REPL 在检测到"auto-continue 实际发生"后,暴露一个 recordAutoContinueOutcome 入口
 *     在下一条用户输入到达时判分。当前先把出口写出,调用侧后续补。
 */

import type { Learner } from '../types.js'
import { clamp, makeJsonLoader, makeJsonSaver, roundTo } from './shared.js'

// ── 类型 ──────────────────────────────────────────────────────────────

export interface AutoContinueParams {
  /**
   * auto-continue LLM 路径放行所需的最低 confidence。
   * 初值 0.7 与 autoContinueTurnLLM 硬编码对齐(向后完全兼容)。
   */
  minConfidenceForContinue: number
  /** 累计学习样本数(只统计 decision='continue' 且拿到 userInterrupted 的样本)。 */
  sampleCount: number
  /** 用户接受自动续聊的累计次数。 */
  acceptedCount: number
  /** 用户打断自动续聊的累计次数。 */
  interruptedCount: number
  /** 最近一次样本结果,便于状态面板快速解释阈值变化。 */
  lastOutcome: 'accepted' | 'interrupted' | 'none'
  updatedAt: string
}

export interface AutoContinueOutcome {
  /** 本次 LLM 决策 */
  decision: 'continue' | 'wait'
  /** LLM 给出的 confidence(0~1) */
  confidence: number
  /**
   * 用户是否打断了自动续聊。
   *   - true  → LLM 放行但用户立刻纠错/回滚 → 阈值应上调(更保守)
   *   - false → LLM 放行且用户接受 → 阈值可下调(更激进)
   *   - 只有 decision='continue' 时才有意义;'wait' 时调用方应传 undefined / 不 record。
   */
  userInterrupted?: boolean
}

// ── 常量 ──────────────────────────────────────────────────────────────

/** 默认阈值 —— 与 autoContinueTurnLLM.MIN_CONFIDENCE_FOR_CONTINUE 保持一致 */
export const DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE = 0.7

export const DEFAULT_AUTO_CONTINUE_PARAMS: AutoContinueParams = {
  minConfidenceForContinue: DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE,
  sampleCount: 0,
  acceptedCount: 0,
  interruptedCount: 0,
  lastOutcome: 'none',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

/** 学习率 α —— 阈值是一维标量,用比 hook/skill 稍大的步长加快收敛 */
const LEARNING_RATE = 0.02

/** 阈值允许的范围:下限 0.5(再低就基本 permissive)、上限 0.95(再高等于关闭 LLM 路径) */
export const AUTO_CONTINUE_MIN_BOUND = 0.5
export const AUTO_CONTINUE_MAX_BOUND = 0.95

// ── update 核心 ───────────────────────────────────────────────────────

export function updateAutoContinueParams(
  current: AutoContinueParams,
  outcome: AutoContinueOutcome,
): AutoContinueParams {
  // 只有 LLM 曾放行(decision='continue')且我们拿到用户的是/否反应时才能学习。
  // decision='wait' 时没有反事实信号(放行会怎样?不知道),跳过。
  if (outcome.decision !== 'continue') return current
  if (typeof outcome.userInterrupted !== 'boolean') return current

  const prev = current.minConfidenceForContinue
  // 用户打断 → 阈值↑(更保守);未打断 → 阈值↓(更激进)
  const direction = outcome.userInterrupted ? 1 : -1

  // 乘以 confidence 的"距当前阈值的距离" —— 当 confidence 本身极靠边界时
  // 反而说明这条样本更有信息量,调整力度略大。
  const distance = Math.abs(outcome.confidence - prev)
  const step = LEARNING_RATE * (0.5 + distance) // 0.02 ~ 0.03 的区间

  const updated = clamp(
    prev + direction * step,
    AUTO_CONTINUE_MIN_BOUND,
    AUTO_CONTINUE_MAX_BOUND,
  )

  return {
    minConfidenceForContinue: roundTo(updated, 3),
    sampleCount: (current.sampleCount ?? 0) + 1,
    acceptedCount: (current.acceptedCount ?? 0) + (outcome.userInterrupted ? 0 : 1),
    interruptedCount: (current.interruptedCount ?? 0) + (outcome.userInterrupted ? 1 : 0),
    lastOutcome: outcome.userInterrupted ? 'interrupted' : 'accepted',
    updatedAt: new Date().toISOString(),
  }
}

// ── Learner 实例 ──────────────────────────────────────────────────────

export const autoContinueLearner: Learner<
  AutoContinueParams,
  AutoContinueOutcome
> = {
  domain: 'auto-continue',
  defaults: DEFAULT_AUTO_CONTINUE_PARAMS,
  load: makeJsonLoader<AutoContinueParams>(
    'auto-continue',
    DEFAULT_AUTO_CONTINUE_PARAMS,
    parsed => ({
      minConfidenceForContinue: clamp(
        typeof parsed.minConfidenceForContinue === 'number'
          ? parsed.minConfidenceForContinue
          : DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE,
        AUTO_CONTINUE_MIN_BOUND,
        AUTO_CONTINUE_MAX_BOUND,
      ),
      sampleCount:
        typeof parsed.sampleCount === 'number' && Number.isFinite(parsed.sampleCount)
          ? Math.max(0, Math.floor(parsed.sampleCount))
          : 0,
      acceptedCount:
        typeof parsed.acceptedCount === 'number' && Number.isFinite(parsed.acceptedCount)
          ? Math.max(0, Math.floor(parsed.acceptedCount))
          : 0,
      interruptedCount:
        typeof parsed.interruptedCount === 'number' && Number.isFinite(parsed.interruptedCount)
          ? Math.max(0, Math.floor(parsed.interruptedCount))
          : 0,
      lastOutcome:
        parsed.lastOutcome === 'accepted' || parsed.lastOutcome === 'interrupted'
          ? parsed.lastOutcome
          : 'none',
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }),
  ),
  save: makeJsonSaver<AutoContinueParams>('auto-continue'),
  update: updateAutoContinueParams,
}

// ── 便捷读出口 ────────────────────────────────────────────────────────

/**
 * 读当前动态 minConfidenceForContinue。供 `autoContinueTurnLLM` 的
 * `detectNextStepIntentViaLLMGated` 在调用方未显式传 minConfidence 时使用。
 *
 * 失败一律回默认 0.7(向后兼容)。**同步路径必须保底**。
 */
export async function getDynamicMinConfidenceForContinue(): Promise<number> {
  try {
    const params = await autoContinueLearner.load()
    const v = params.minConfidenceForContinue
    return typeof v === 'number' && Number.isFinite(v)
      ? clamp(v, AUTO_CONTINUE_MIN_BOUND, AUTO_CONTINUE_MAX_BOUND)
      : DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE
  } catch {
    return DEFAULT_MIN_CONFIDENCE_FOR_CONTINUE
  }
}

/**
 * 记录一次 auto-continue outcome。建议由 REPL 在以下时机调用:
 *   - LLM decided continue & user 下一条 = 打断/回滚     → userInterrupted=true
 *   - LLM decided continue & user 下一条 = 正常推进       → userInterrupted=false
 *
 * 本函数走 autoEvolve.recordOutcome 走统一 registry,便于 /evolve-status
 * 观测所有 learner domain。
 *
 * 失败静默(autoEvolve 层已经 try/catch,这里只是防御式)。
 */
export async function recordAutoContinueOutcome(
  outcome: AutoContinueOutcome,
): Promise<void> {
  try {
    const { recordOutcome } = await import('../index.js')
    await recordOutcome('auto-continue', outcome)
  } catch {
    // 不阻塞 REPL
  }
}
