/**
 * contextCollapse operations — Phase 1
 *
 * 把"折叠(contextCollapse)"与"分层索引(tieredContext)"两条路径打通的
 * 轻量 API 集合。不注册为 LLM Tool;供内部调用方(orchestrator / /rehydrate
 * 命令 / ContextBroker 等)按 collapseId 或 turnId 精确回取原文。
 *
 * 依赖关系:
 *   - 读:contextCollapse 内部 committed 列表(通过 getCommittedCollapseInfo)
 *   - 读:tierManager L2/L4 索引
 *   - 无写:纯读路径,对会话状态零副作用
 */

import { contextTierManager } from '../compact/tieredContext/tierManager.js'
import type { RehydrateResult } from '../compact/tieredContext/types.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
// Phase 6 观测性:统一 domain='context' 的证据条目
import { EvidenceLedger } from '../harness/index.js'
// Phase 2 — 复用项目已有的 tool result 外置化基建:
//   persistToolResult 已把大 tool_result 落盘到 ~/.claude/projects/{cwd}/{sessionId}/tool-results/{toolUseId}.{txt|json}
//   这里只在 operations 层补上"按 toolUseId 回取"的统一入口,
//   与 Phase 1 的 rehydrateCollapsed 形成同系列 API,供 ContextBroker(Phase 3)统一调度。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  getToolResultPath,
  getToolResultsDir,
} from '../../utils/toolResultStorage.js'
import {
  getCommittedCollapseInfo,
  listCommittedCollapses,
} from './index.js'

// 保留原有 re-export,维持既有 import 路径向后兼容
export {
  getContextCollapsePreview,
  projectView,
  summarizeContextCollapseState,
} from './index.js'

/**
 * 按 turnId 精确回取某条被折叠消息的原文。
 * 与 RehydrateTool.rehydrateByTurnId 的区别:这里不受 tieredContext feature flag
 * 限制,因为 collapse 路径默认写索引(CLAUDE_CODE_COLLAPSE_TIER_INDEX 默认 ON)。
 */
export function rehydrateCollapsedTurn(turnId: string): RehydrateResult | null {
  if (!turnId) return null
  const sessionId = getSessionId()
  if (!sessionId) return null
  const transcriptPath = getTranscriptPath()
  if (!transcriptPath) return null
  return contextTierManager.rehydrate(sessionId, transcriptPath, turnId)
}

/**
 * 按 collapseId 回取:
 *   - turnId 提供时:精确回取该 turn
 *   - turnId 不提供时:回取跨度内第一条
 * 找不到 collapseId 或跨度为空时返回 null。
 */
export function rehydrateCollapsed(params: {
  collapseId: string
  turnId?: string
}): RehydrateResult | null {
  const info = getCommittedCollapseInfo(params.collapseId)
  if (!info) return null
  const target =
    params.turnId && info.turnIds.includes(params.turnId)
      ? params.turnId
      : info.turnIds[0]
  if (!target) return null
  return rehydrateCollapsedTurn(target)
}

/**
 * 列出 collapseId 跨度内所有 turnId(按原顺序)。
 * 供调用方做"先查后取"。
 */
export function listCollapsedTurns(collapseId: string): string[] {
  const info = getCommittedCollapseInfo(collapseId)
  return info ? info.turnIds : []
}

/**
 * 列出当前会话所有 committed collapse 的摘要(供诊断面板/操作路径)。
 */
export function listCollapses(): Array<{
  collapseId: string
  turnCount: number
  firstArchivedUuid: string
  lastArchivedUuid: string
}> {
  return listCommittedCollapses()
}

// ==================== Phase 2: Tool Result Offload 统一回取 ====================

/** Phase 2 — rehydrateToolResult 的返回结构。复用 RehydrateResult 的字段语义,
 *  但语义映射:
 *    turnId    → 工具调用的 toolUseId
 *    content   → 工具落盘原始内容(字符串或 JSON 文本)
 *    source    → 磁盘路径类型('l4_disk')
 */
export type ToolResultRehydrateResult = RehydrateResult & {
  /** 工具调用 id,等同于 turnId 但语义更明确 */
  toolUseId: string
  /** 是否为 JSON 序列化内容(对应 .json / .txt 扩展名) */
  isJson: boolean
  /** 落盘文件绝对路径(调试用) */
  filepath: string
}

/**
 * 按 toolUseId 回取已外置化的工具结果。
 * 与 rehydrateCollapsedTurn 形成同系列 API(pointer → 原文)。
 *
 * 查找顺序:先 .json(工具返回数组内容) → 再 .txt(字符串内容)。
 * 不存在时返回 null。
 */
export function rehydrateToolResult(params: {
  toolUseId: string
}): ToolResultRehydrateResult | null {
  const { toolUseId } = params
  if (!toolUseId) return null
  const start = Date.now()
  // 复用 getToolResultPath,文件命名规则保持与 persistToolResult 一致
  const candidates: Array<{ path: string; isJson: boolean }> = [
    { path: getToolResultPath(toolUseId, true), isJson: true },
    { path: getToolResultPath(toolUseId, false), isJson: false },
  ]
  for (const { path, isJson } of candidates) {
    if (!existsSync(path)) continue
    try {
      const content = readFileSync(path, 'utf-8')
      return {
        turnId: toolUseId,
        toolUseId,
        isJson,
        filepath: path,
        content,
        tokenCount: Math.max(1, Math.floor(content.length / 4)),
        source: 'l4_disk',
        tookMs: Date.now() - start,
      }
    } catch {
      // 读失败继续尝试下一种扩展名
    }
  }
  return null
}

/**
 * 列出当前会话所有已外置化的工具结果摘要(诊断用)。
 * 目录不存在时返回空数组。
 */
export function listOffloadedToolResults(): Array<{
  toolUseId: string
  isJson: boolean
  filepath: string
  sizeBytes: number
}> {
  let dir: string
  try {
    dir = getToolResultsDir()
  } catch {
    return []
  }
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{
    toolUseId: string
    isJson: boolean
    filepath: string
    sizeBytes: number
  }> = []
  for (const name of entries) {
    const isJson = name.endsWith('.json')
    const isTxt = name.endsWith('.txt')
    if (!isJson && !isTxt) continue
    const filepath = `${dir}/${name}`
    let sizeBytes = 0
    try {
      sizeBytes = statSync(filepath).size
    } catch {
      continue
    }
    // 文件名去掉扩展名 = toolUseId
    const toolUseId = basename(name, isJson ? '.json' : '.txt')
    out.push({ toolUseId, isJson, filepath, sizeBytes })
  }
  return out
}

/**
 * Phase 2 — 统一回取入口:按 ref 自动路由到 Collapsed Turn 或 Tool Result。
 * ref 格式:
 *   - "turn:{uuid}"     → rehydrateCollapsedTurn
 *   - "collapse:{id}"   → rehydrateCollapsed
 *   - "tool:{useId}"    → rehydrateToolResult
 *
 * 给 ContextBroker(Phase 3)用的最小调度器,不受 feature flag 限制。
 *
 * Phase 6 观测性:所有路径(Tool / 命令 / orchestrator)都走这里,
 *   在本函数层统一记 in-memory 计数 + EvidenceLedger,避免入口处重复埋点。
 */
export function rehydrateByRef(
  ref: string,
):
  | RehydrateResult
  | ToolResultRehydrateResult
  | null {
  // —— invalid 早退:格式不合法 ——
  if (!ref) {
    recordRehydrateInvalid('(empty)')
    return null
  }
  const colon = ref.indexOf(':')
  if (colon <= 0) {
    recordRehydrateInvalid(ref)
    return null
  }
  const kind = ref.slice(0, colon)
  const id = ref.slice(colon + 1)
  if (!id) {
    recordRehydrateInvalid(ref)
    return null
  }

  let result: RehydrateResult | ToolResultRehydrateResult | null = null
  switch (kind) {
    case 'turn':
      result = rehydrateCollapsedTurn(id)
      break
    case 'collapse':
      result = rehydrateCollapsed({ collapseId: id })
      break
    case 'tool':
      result = rehydrateToolResult({ toolUseId: id })
      break
    default:
      recordRehydrateInvalid(ref)
      return null
  }

  if (result) {
    recordRehydrateHit(ref, kind as 'turn' | 'collapse' | 'tool', result)
  } else {
    recordRehydrateMiss(ref, kind as 'turn' | 'collapse' | 'tool')
  }
  return result
}

// ─────────────────────────────────────────────────────────────
// Phase 6 观测性 —— in-memory 计数 + EvidenceLedger(domain='context')
// 面板读 in-memory 计数(零 IO),长期审计走磁盘 ledger。
// 进程重启后 in-memory 归零,ledger 保留(30d TTL)。
// ─────────────────────────────────────────────────────────────

const rehydrateStats = {
  calls: 0,
  hits: 0,
  misses: 0,
  invalid: 0,
  // 按 kind 分桶
  hitsByKind: { turn: 0, collapse: 0, tool: 0 } as Record<string, number>,
  // 累计 token/耗时,用于算均值
  totalTokensRehydrated: 0,
  totalTookMs: 0,
  lastHitAt: 0,
  lastMissAt: 0,
  lastInvalidAt: 0,
  lastSource: '' as string,
}

function safeLedgerAppend(
  kind: string,
  data: Record<string, unknown>,
): void {
  // EvidenceLedger 写失败绝不应破坏回取主流程
  try {
    let sid: string | undefined
    try {
      sid = getSessionId()
    } catch {
      sid = undefined
    }
    EvidenceLedger.append({
      ts: new Date().toISOString(),
      domain: 'context',
      kind,
      sessionId: sid,
      data,
    })
  } catch {
    // swallow
  }
}

function recordRehydrateHit(
  ref: string,
  kind: 'turn' | 'collapse' | 'tool',
  result: RehydrateResult | ToolResultRehydrateResult,
): void {
  rehydrateStats.calls += 1
  rehydrateStats.hits += 1
  rehydrateStats.hitsByKind[kind] = (rehydrateStats.hitsByKind[kind] || 0) + 1
  rehydrateStats.totalTokensRehydrated += result.tokenCount || 0
  rehydrateStats.totalTookMs += result.tookMs || 0
  rehydrateStats.lastHitAt = Date.now()
  rehydrateStats.lastSource = result.source || ''
  safeLedgerAppend('rehydrate_hit', {
    ref,
    kind,
    source: result.source,
    tokenCount: result.tokenCount,
    tookMs: result.tookMs,
  })
}

function recordRehydrateMiss(
  ref: string,
  kind: 'turn' | 'collapse' | 'tool',
): void {
  rehydrateStats.calls += 1
  rehydrateStats.misses += 1
  rehydrateStats.lastMissAt = Date.now()
  safeLedgerAppend('rehydrate_miss', { ref, kind })
}

function recordRehydrateInvalid(ref: string): void {
  rehydrateStats.calls += 1
  rehydrateStats.invalid += 1
  rehydrateStats.lastInvalidAt = Date.now()
  safeLedgerAppend('rehydrate_invalid', { ref })
}

/**
 * Phase 6 —— 暴露给 /kernel-status 的只读快照。
 * avgTokens / avgTookMs / hitRate 在这里算完,面板消费端无需再算。
 */
export function getRehydrateStats(): {
  calls: number
  hits: number
  misses: number
  invalid: number
  hitRate: number
  hitsByKind: Record<string, number>
  avgTokens: number
  avgTookMs: number
  lastHitAt: number
  lastMissAt: number
  lastInvalidAt: number
  lastSource: string
} {
  const hits = rehydrateStats.hits
  const divisor = hits > 0 ? hits : 1
  const observed = rehydrateStats.hits + rehydrateStats.misses
  return {
    calls: rehydrateStats.calls,
    hits: rehydrateStats.hits,
    misses: rehydrateStats.misses,
    invalid: rehydrateStats.invalid,
    hitRate: observed > 0 ? Number((hits / observed).toFixed(4)) : 0,
    hitsByKind: { ...rehydrateStats.hitsByKind },
    avgTokens: Math.round(rehydrateStats.totalTokensRehydrated / divisor),
    avgTookMs: Math.round(rehydrateStats.totalTookMs / divisor),
    lastHitAt: rehydrateStats.lastHitAt,
    lastMissAt: rehydrateStats.lastMissAt,
    lastInvalidAt: rehydrateStats.lastInvalidAt,
    lastSource: rehydrateStats.lastSource,
  }
}
