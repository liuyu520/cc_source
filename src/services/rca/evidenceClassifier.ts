/**
 * RCA Evidence Classifier — 证据智能分类器
 *
 * 设计理念（贝叶斯大脑假说 + 预测编码理论）：
 * 大脑不是被动接收感觉输入，而是主动用先验假设"预测"输入。
 * 当观测与预测不符时产生"预测误差"，驱动后验更新。
 *
 * 当前 rcaHook.ts 的问题：
 *   extractEvidencesFromMessages() 提取的 Evidence 的
 *   supports[] 和 contradicts[] 始终为空数组，
 *   导致 updatePosteriors() 对自动收集的证据是 no-op。
 *
 * 本模块通过 sideQuery 让 LLM 判断每条证据支持/反驳哪些假设，
 * 然后回填 supports/contradicts，使贝叶斯更新真正生效。
 *
 * 同时将分类后的证据桥接写入 EvidenceLedger（via evidenceBus）。
 */

import { logForDebugging } from '../../utils/debug.js'
import type { Evidence, Hypothesis } from './types.js'

/** 分类结果 */
export interface ClassificationResult {
  evidenceId: string
  supports: string[]     // 支持的假设 ID
  contradicts: string[]  // 反驳的假设 ID
  neutral: string[]      // 中性（不影响）的假设 ID
  confidence: number     // 分类置信度 0-1
}

/**
 * 基于规则的快速分类（零 LLM 调用，O(1)）
 *
 * 启发式规则：
 *   1. error_signal 类型 → 支持所有包含 "error"/"bug"/"fail" 的假设
 *   2. tool_result 成功 → 反驳所有包含 "error"/"broken"/"fail" 的假设
 *   3. 工具名匹配 → 支持提到相同工具的假设
 */
export function classifyByRules(
  evidence: Omit<Evidence, 'id' | 'sessionId'>,
  hypotheses: Hypothesis[],
): { supports: string[]; contradicts: string[] } {
  const supports: string[] = []
  const contradicts: string[] = []
  const active = hypotheses.filter(h => h.status === 'active')

  if (active.length === 0) return { supports, contradicts }

  const summaryLower = (evidence.summary || '').toLowerCase()
  const isError = evidence.kind === 'error_signal'

  for (const h of active) {
    const claimLower = h.claim.toLowerCase()
    const hasErrorKeyword = /error|bug|fail|crash|broken|exception/.test(claimLower)
    const hasToolMatch = evidence.toolName &&
      claimLower.includes(evidence.toolName.toLowerCase())

    if (isError) {
      // 错误信号支持"有错误"类假设，反驳"没问题"类假设
      if (hasErrorKeyword) supports.push(h.id)
      // 工具匹配加强关联
      if (hasToolMatch) supports.push(h.id)
    } else {
      // 成功的工具结果反驳"该工具有问题"类假设
      if (hasToolMatch && hasErrorKeyword) contradicts.push(h.id)
      // 包含关键信息的成功结果可能支持特定假设
      if (hasToolMatch && !hasErrorKeyword) supports.push(h.id)
    }

    // 关键词匹配：evidence 摘要中提到假设核心概念
    const claimKeywords = extractKeywords(claimLower)
    const matchedKeywords = claimKeywords.filter(kw => summaryLower.includes(kw))
    if (matchedKeywords.length >= 2) {
      if (isError) supports.push(h.id)
      else supports.push(h.id)
    }
  }

  // 去重
  return {
    supports: [...new Set(supports)],
    contradicts: [...new Set(contradicts)],
  }
}

/**
 * 基于 sideQuery 的深度分类（有 LLM 调用成本）
 *
 * 仅在以下条件满足时触发：
 *   1. 规则分类结果为空（supports + contradicts = 0）
 *   2. 活跃假设 >= 2（否则没有分类价值）
 *   3. evidence 摘要 >= 20 字符（太短没有分析价值）
 *
 * 使用 Sonnet 模型，temperature=0.1（近确定性判断）
 */
export async function classifyBySideQuery(
  evidence: Omit<Evidence, 'id' | 'sessionId'>,
  hypotheses: Hypothesis[],
): Promise<{ supports: string[]; contradicts: string[] } | null> {
  const active = hypotheses.filter(h => h.status === 'active')
  if (active.length < 2) return null
  if ((evidence.summary || '').length < 20) return null

  try {
    const { sideQuery } = await import('../../utils/sideQuery.js')
    const { getDefaultSonnetModel } = await import('../../utils/model/model.js')

    const hypothesesBlock = active.map(h =>
      `- ${h.id}: "${h.claim}" (posterior=${h.posterior.toFixed(3)})`,
    ).join('\n')

    const prompt = `Given this evidence from a debugging session:

Evidence (${evidence.kind}): "${evidence.summary}"
${evidence.toolName ? `Tool: ${evidence.toolName}` : ''}

And these active hypotheses:
${hypothesesBlock}

Classify which hypotheses this evidence SUPPORTS and which it CONTRADICTS.
Output JSON: {"supports": ["h_001"], "contradicts": ["h_002"]}
Only include hypotheses with clear directional signal. When uncertain, omit.`

    const response = await sideQuery({
      model: getDefaultSonnetModel(),
      system: 'You are a logical reasoning agent. Classify evidence-hypothesis relationships. Output valid JSON only.',
      prompt,
      maxTokens: 256,
      temperature: 0.1,
      querySource: 'rca_evidence_classifier',
    })

    const text = typeof response === 'string' ? response : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const validIds = new Set(active.map(h => h.id))

    return {
      supports: Array.isArray(parsed.supports)
        ? (parsed.supports as string[]).filter(id => validIds.has(id))
        : [],
      contradicts: Array.isArray(parsed.contradicts)
        ? (parsed.contradicts as string[]).filter(id => validIds.has(id))
        : [],
    }
  } catch (e) {
    logForDebugging(`[EvidenceClassifier] sideQuery failed: ${(e as Error).message}`)
    return null
  }
}

/**
 * 两级分类管道：规则优先 → sideQuery 补充
 *
 * 返回增强后的 evidence（supports/contradicts 已填充）
 */
export async function classifyEvidence(
  evidence: Omit<Evidence, 'id' | 'sessionId'>,
  hypotheses: Hypothesis[],
  opts: { allowSideQuery?: boolean } = {},
): Promise<{ supports: string[]; contradicts: string[] }> {
  // Level 1: 基于规则的快速分类
  const ruleResult = classifyByRules(evidence, hypotheses)

  if (ruleResult.supports.length > 0 || ruleResult.contradicts.length > 0) {
    logForDebugging(
      `[EvidenceClassifier] rule-based: supports=[${ruleResult.supports}] contradicts=[${ruleResult.contradicts}]`,
    )
    return ruleResult
  }

  // Level 2: 规则无结果 → sideQuery 深度分类（可选）
  if (opts.allowSideQuery !== false) {
    const sqResult = await classifyBySideQuery(evidence, hypotheses)
    if (sqResult) {
      logForDebugging(
        `[EvidenceClassifier] sideQuery: supports=[${sqResult.supports}] contradicts=[${sqResult.contradicts}]`,
      )
      return sqResult
    }
  }

  // 两级都无结果 → 返回空（该证据对所有假设中性）
  return { supports: [], contradicts: [] }
}

/** 从文本中提取关键词（去停用词，保留 >= 3 字符的词） */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'is', 'at', 'in', 'on', 'a', 'an', 'and', 'or', 'but',
    'not', 'with', 'for', 'this', 'that', 'from', 'to', 'of', 'by',
    'it', 'be', 'as', 'are', 'was', 'were', 'been', 'has', 'have',
    'may', 'might', 'could', 'should', 'would', 'can', 'will',
  ])
  return text
    .split(/\W+/)
    .filter(w => w.length >= 3 && !stopWords.has(w))
}
