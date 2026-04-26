/**
 * organismInvocationLedger.ts — G2 Step 1 观察层
 *
 * 现状:arenaController.recordOrganismInvocation 只写 manifest.invocationCount
 *       + lastInvokedAt(Phase 5),没有 ndjson 时间序列,也不覆盖 shadow/canary/
 *       非 skill 的 GenomeKind。
 *
 * 本模块提供一个纯旁路的时间序列 ledger:
 *
 *   recordOrganismInvocationEvent({ organismId, kind, status, source? })
 *     → append 一行到 oracle/organism-invocation.ndjson
 *
 * 约束:
 *   - fail-open:任何异常吞掉,不影响主调用路径;
 *   - shadow-only:开关关闭时直接返回;
 *   - 不改 manifest,不改 arenaController 主流程;
 *   - 与其它 oracle ledger 共享 rotation/size 策略。
 *
 * 与 G5/G4 ledger 风格对齐:简单 append-only NDJSON + 只读命令消费。
 */

import { appendJsonLine } from '../oracle/ndjsonLedger.js'
import { getOrganismInvocationLedgerPath } from '../paths.js'
import type { GenomeKind, OrganismStatus } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

export interface OrganismInvocationEvent {
  /** stable/canary/shadow/... organism id(来自 manifest.id) */
  organismId: string
  /** 基因种类(skill/command/hook/agent/prompt) */
  kind: GenomeKind
  /** 记录这次调用时的 status */
  status: OrganismStatus
  /**
   * 可选的 source 标签,标识"谁触发的":
   *   - 'skill-loader':从 loadSkillsDir → getPromptForCommand 进入
   *   - 'manual':用户 /<skill-name>
   *   - 'command':command organism 被 registerCommand 命中
   *   - 'agent':agent organism 被 AgentTool 派发
   *   - 其他自定义字符串
   */
  source?: string
}

/** 环境开关:CLAUDE_ORGANISM_INVOCATION_LEDGER=off/0/false 时完全不写。*/
function isLedgerEnabled(): boolean {
  const raw = (process.env.CLAUDE_ORGANISM_INVOCATION_LEDGER ?? '')
    .toString()
    .trim()
    .toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}

/**
 * 写一条 invocation 事件到 ndjson ledger。
 *
 * 返回 true 表示已追加,false 表示被开关关闭或写失败。
 * 永远不抛。
 */
export function recordOrganismInvocationEvent(
  ev: OrganismInvocationEvent,
): boolean {
  if (!isLedgerEnabled()) return false
  try {
    const payload = {
      at: new Date().toISOString(),
      organismId: ev.organismId,
      kind: ev.kind,
      status: ev.status,
      source: ev.source,
      pid: process.pid,
    }
    return appendJsonLine(getOrganismInvocationLedgerPath(), payload)
  } catch (e) {
    logForDebugging(
      `[organismInvocationLedger] append failed: ${(e as Error).message}`,
    )
    return false
  }
}
