/**
 * RCA Post-Sampling Hook — 主循环观测接入点
 *
 * 注册一个 PostSamplingHook，在每次模型响应后：
 *   1. 检查 RCA 是否启用且有活跃 session
 *   2. 从 assistant 消息中提取错误信号和工具结果
 *   3. 构造 Evidence 并送入 rcaOrchestrator.onObservation()
 *
 * 全部 fire-and-forget，不阻塞主循环。
 */

import {
  registerPostSamplingHook,
  type REPLHookContext,
} from '../../utils/hooks/postSamplingHooks.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRCAEnabled, isRCAShadowMode } from './featureCheck.js'
import { decideAndLog, endRCA, getSession, onObservation } from './rcaOrchestrator.js'
import type { Evidence, EvidenceKind } from './types.js'

let registered = false

/**
 * 注册 RCA 观测钩子到 PostSamplingHooks 注册表
 * 幂等：重复调用安全
 */
export function registerRCAHook(): void {
  if (registered) return
  registered = true

  registerPostSamplingHook(rcaPostSamplingHook)
  // 进程退出时兜底 endRCA:用户忘 /rca end,也能把 session_end 落盘。
  // 未启用/无活跃 session 时 endRCA 是 no-op,fail-open。
  registerCleanup(async () => {
    try {
      if (getSession()) endRCA()
    } catch { /* best-effort */ }
  })
  logForDebugging('[RCA] PostSamplingHook registered')
}

/**
 * PostSamplingHook 实现
 * 从消息历史中提取最新一轮的工具结果和错误信号
 */
async function rcaPostSamplingHook(context: REPLHookContext): Promise<void> {
  // 快速门控：未启用或无活跃 session → 跳过
  const decision = decideAndLog('postSamplingHook')
  if (!decision || !decision.active) return

  const session = getSession()
  if (!session) return

  // 从消息尾部提取最新的 assistant + tool_result 消息
  const messages = context.messages
  const evidences = extractEvidencesFromMessages(messages, session.turnCounter)

  // 送入 orchestrator（shadow 模式下 onObservation 仍会记录日志）
  // 增强：通过 evidenceClassifier 自动填充 supports/contradicts
  for (const ev of evidences) {
    try {
      const { classifyEvidence } = await import('./evidenceClassifier.js')
      const classification = await classifyEvidence(ev, session.hypotheses, {
        allowSideQuery: !isRCAShadowMode(),
      })
      ev.supports = classification.supports
      ev.contradicts = classification.contradicts
    } catch {
      // 分类失败不影响证据提交（降级为原始空数组）
    }
    onObservation(ev)

    // 增强：桥接写入 EvidenceLedger（via evidenceBus）
    try {
      const { convergeRCAEvidence } = await import('../autoDream/pipeline/evidenceBus.js')
      void convergeRCAEvidence({
        ...ev,
        id: `e_${session.evidenceCounter}`,
        sessionId: session.sessionId,
      })
    } catch {
      // 桥接失败静默
    }
  }

  // 递增 turn 计数
  session.turnCounter++
}

/**
 * 从消息列表尾部提取证据
 * 扫描最后 10 条消息，提取错误信号和工具结果摘要
 */
function extractEvidencesFromMessages(
  messages: unknown[],
  turnIdx: number,
): Omit<Evidence, 'id' | 'sessionId'>[] {
  const evidences: Omit<Evidence, 'id' | 'sessionId'>[] = []
  // 只扫描尾部消息，避免重复处理
  const tail = messages.slice(-10)

  for (const msg of tail) {
    const m = msg as Record<string, unknown>

    // 错误信号
    if (m.type === 'error' || m.type === 'tool_error') {
      const summary = extractTextContent(m.content)
      if (summary) {
        evidences.push({
          kind: 'error_signal',
          summary: summary.slice(0, 120),
          turnIdx,
          supports: [],
          contradicts: [],
          timestamp: Date.now(),
        })
      }
    }

    // 工具结果（tool_result 类型的 content block）
    if (m.type === 'tool_result' || hasToolResult(m)) {
      const toolName = (m.toolName as string) ?? (m.name as string) ?? 'unknown'
      const summary = extractTextContent(m.content)
      if (summary) {
        evidences.push({
          kind: 'tool_result' as EvidenceKind,
          summary: summary.slice(0, 120),
          toolName,
          turnIdx,
          supports: [],
          contradicts: [],
          timestamp: Date.now(),
        })
      }
    }
  }

  return evidences
}

/** 检查消息是否包含 tool_result content block */
function hasToolResult(msg: Record<string, unknown>): boolean {
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === 'tool_result',
  )
}

/** 从 content 中提取文本摘要 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === 'string') return block
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>).type === 'text'
        ) {
          return (block as Record<string, unknown>).text as string
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
      .slice(0, 200)
  }
  return ''
}
