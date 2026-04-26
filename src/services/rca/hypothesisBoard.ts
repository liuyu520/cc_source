/**
 * RCA Hypothesis Board — 假设看板
 *
 * 核心能力：
 *   1. generateInitialHypotheses: 用 sideQuery + Sonnet 生成初始假设
 *   2. updatePosteriors: 贝叶斯更新（观测证据后调整概率）
 *   3. checkConvergence: 收敛判断（最高后验 > 0.8 即锁定）
 *   4. selectNextProbe: 信息增益最大化的下一步建议
 *
 * 复用 sideQuery 通道，与 findRelevantMemories 同款调用模式。
 */

import { logForDebugging } from '../../utils/debug.js'
import { getDefaultSonnetModel } from '../../utils/model/model.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type {
  Evidence,
  Hypothesis,
  HypothesisStatus,
  ProbeAction,
  RCASession,
} from './types.js'

// ---- 假设生成 ----

const HYPOTHESIS_SYSTEM_PROMPT = `You are an expert debugger performing root cause analysis.
Given a problem description and code context, generate 2-4 hypotheses about the root cause.
Each hypothesis should be specific, testable, and ranked by prior probability.

Return JSON: { "hypotheses": [{ "claim": "...", "prior": 0.0-1.0 }] }
Priors must sum to approximately 1.0. Order by descending probability.`

/**
 * 用 sideQuery 生成初始假设列表
 * 返回带 prior 概率的 Hypothesis 对象数组（不含 id/status 等运行时字段）
 */
export async function generateInitialHypotheses(
  problemStatement: string,
  codeContext: string,
  signal?: AbortSignal,
): Promise<Pick<Hypothesis, 'claim' | 'prior'>[]> {
  try {
    const model = getDefaultSonnetModel()
    const response = await sideQuery({
      model,
      system: HYPOTHESIS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Problem: ${problemStatement}\n\nCode context:\n${codeContext.slice(0, 2000)}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.3,
      querySource: 'rca_hypothesis_generation',
      signal,
    })

    // 从响应中提取 JSON
    const text =
      response.content?.[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logForDebugging('[RCA] Failed to parse hypotheses JSON from sideQuery response')
      return fallbackHypotheses(problemStatement)
    }

    const parsed = jsonParse(jsonMatch[0]) as {
      hypotheses?: { claim: string; prior: number }[]
    }
    if (!parsed?.hypotheses?.length) {
      return fallbackHypotheses(problemStatement)
    }

    // 归一化 priors
    const total = parsed.hypotheses.reduce((sum, h) => sum + h.prior, 0)
    return parsed.hypotheses.map(h => ({
      claim: h.claim,
      prior: total > 0 ? h.prior / total : 1 / parsed.hypotheses!.length,
    }))
  } catch (e) {
    logForDebugging(`[RCA] generateInitialHypotheses failed: ${(e as Error).message}`)
    return fallbackHypotheses(problemStatement)
  }
}

/** sideQuery 失败时的降级：返回一个通用假设 */
function fallbackHypotheses(
  problem: string,
): Pick<Hypothesis, 'claim' | 'prior'>[] {
  return [
    { claim: `Root cause is directly related to: ${problem.slice(0, 100)}`, prior: 0.6 },
    { claim: 'Root cause is an upstream dependency or configuration issue', prior: 0.4 },
  ]
}

// ---- 贝叶斯更新 ----

/**
 * 观测到新证据后更新所有活跃假设的后验概率
 *
 * 更新规则（简化贝叶斯）：
 *   - evidence.supports 中的假设: posterior *= SUPPORT_FACTOR
 *   - evidence.contradicts 中的假设: posterior *= CONTRADICT_FACTOR
 *   - 归一化确保概率和为 1
 *   - posterior > CONFIRM_THRESHOLD → confirmed
 *   - posterior < REJECT_THRESHOLD → rejected
 */
const SUPPORT_FACTOR = 1.5
const CONTRADICT_FACTOR = 0.3
const CONFIRM_THRESHOLD = 0.8
const REJECT_THRESHOLD = 0.05

export function updatePosteriors(session: RCASession, newEvidence: Evidence): void {
  const activeHypotheses = session.hypotheses.filter(h => h.status === 'active')
  if (activeHypotheses.length === 0) return

  // 应用似然比
  for (const h of activeHypotheses) {
    if (newEvidence.supports.includes(h.id)) {
      h.posterior *= SUPPORT_FACTOR
      h.evidenceRefs.push(newEvidence.id)
    }
    if (newEvidence.contradicts.includes(h.id)) {
      h.posterior *= CONTRADICT_FACTOR
      h.evidenceRefs.push(newEvidence.id)
    }
  }

  // 归一化
  const total = activeHypotheses.reduce((sum, h) => sum + h.posterior, 0)
  if (total > 0) {
    for (const h of activeHypotheses) {
      h.posterior = h.posterior / total
    }
  }

  // 状态转换
  for (const h of activeHypotheses) {
    if (h.posterior > CONFIRM_THRESHOLD) {
      h.status = 'confirmed'
    } else if (h.posterior < REJECT_THRESHOLD) {
      h.status = 'rejected'
    }
  }
}

// ---- 收敛判断 ----

export interface ConvergenceResult {
  converged: boolean
  topHypothesis: Hypothesis | null
  convergenceScore: number
}

/**
 * 检查假设看板是否收敛
 * 收敛条件：存在 confirmed 的假设，或 convergenceScore > 0.5
 */
export function checkConvergence(session: RCASession): ConvergenceResult {
  const confirmed = session.hypotheses.find(h => h.status === 'confirmed')
  if (confirmed) {
    return { converged: true, topHypothesis: confirmed, convergenceScore: 1.0 }
  }

  // 按后验降序排序
  const sorted = [...session.hypotheses]
    .filter(h => h.status === 'active')
    .sort((a, b) => b.posterior - a.posterior)

  if (sorted.length === 0) {
    return { converged: false, topHypothesis: null, convergenceScore: 0 }
  }

  const top = sorted[0]
  const second = sorted[1]?.posterior ?? 0
  const score = top.posterior - second

  // 更新 session 状态
  session.convergenceScore = score

  return {
    converged: score > 0.5,
    topHypothesis: top,
    convergenceScore: score,
  }
}

// ---- 下一步探测建议 ----

const PROBE_SYSTEM_PROMPT = `You are selecting the next debugging action to maximize information gain.
Given the current hypothesis board and available tools, suggest ONE action that will best differentiate between the remaining hypotheses.

Return JSON: { "tool": "ToolName", "rationale": "why this action", "targetHypothesis": "h_XXX", "estimatedCost": "low|medium|high" }
Prefer low-cost tools (Grep, Read) over high-cost ones (Bash).`

/**
 * 用 sideQuery 选择信息增益最大的下一步探测动作
 * 仅在 RCA 非 shadow 模式下被主循环调用
 */
export async function selectNextProbe(
  session: RCASession,
  availableTools: string[],
  signal?: AbortSignal,
): Promise<ProbeAction | null> {
  try {
    const activeH = session.hypotheses.filter(h => h.status === 'active')
    if (activeH.length <= 1) return null // 已收敛或只剩一个假设

    const boardSummary = activeH
      .map(h => `${h.id}: "${h.claim}" (posterior=${h.posterior.toFixed(3)})`)
      .join('\n')

    const model = getDefaultSonnetModel()
    const response = await sideQuery({
      model,
      system: PROBE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Hypothesis Board:\n${boardSummary}\n\nAvailable tools: ${availableTools.join(', ')}\n\nRecent evidences: ${session.evidences.slice(-3).map(e => e.summary).join('; ')}`,
        },
      ],
      max_tokens: 512,
      temperature: 0.2,
      querySource: 'rca_probe_selection',
      signal,
    })

    const text =
      response.content?.[0]?.type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    return jsonParse(jsonMatch[0]) as ProbeAction
  } catch (e) {
    logForDebugging(`[RCA] selectNextProbe failed: ${(e as Error).message}`)
    return null
  }
}
