/**
 * AgentInvocationStats — "Agent 工具(subagent_type)被调用了多少次,失败率多少" per-subagent_type
 *
 * Phase 49(2026-04-23) v1:
 *   Pattern Miner 第三/四 source —— 路线图 §2.4 Agent Breeder:
 *     "某个 sub-agent 被反复调用(高频)或大量失败(高失败率)时,暗示需要
 *      一个专门化 variant —— 这个 variant 应当通过 shadow 合成 + 比武来发现。"
 *
 *   与既有 source 的区别(刻意独立建模):
 *     toolStats          : 工具调用,是否成功(含所有工具,包括 Agent)     —— 系统视角
 *     userCorrectionStats: 用户立刻说"错了",纠正上一次工具调用             —— 人类视角
 *     agentInvocationStats: Agent 工具(专指 subagent_type 维度)的使用画像 —— 子 agent 视角
 *   toolStats 虽然也会记录 Agent 工具,但只拿到 toolName='Agent' 粒度,无法区分
 *   subagent_type。Agent Breeder 需要的是"哪个 subagent_type 有进化价值",所以
 *   必须独立建模。
 *
 * 结构:完全镜像 userCorrectionStats.ts(ring buffer + createSnapshotStore + aggregate)。
 *   记录 `{agentType, outcome, ts}`,outcome 二元 success|failure,聚合出 totalRuns /
 *   successCount / failureCount,miner 再算 failureRate + invocationCount 两维阈值。
 *
 * 记录入口:services/autoDream/pipeline/sessionEpilogue.ts extractSessionStats
 *   遍历 messages 检测 assistant 的 tool_use(name='Agent'),再在同 session 的
 *   user.tool_result 里查 is_error 判定 outcome。session-scoped 批量写入。
 *
 * 持久化:与 toolStats/userCorrectionStats 同体系 <projectDir>/snapshots/<ns>.json,
 *   由 background.ts 的 periodic task 每 60s 落盘。
 */

import { createSnapshotStore } from '../snapshotStore/index.js'

// ── 类型 ────────────────────────────────────────────────

export type AgentInvocationOutcome = 'success' | 'failure'

export interface AgentInvocationRecord {
  /** Agent 工具的 subagent_type 参数(如 general-purpose / feature-dev:code-reviewer) */
  agentType: string
  outcome: AgentInvocationOutcome
  ts: number
}

export interface AgentInvocationStat {
  agentType: string
  totalRuns: number
  successCount: number
  failureCount: number
  lastInvokedAt: number
}

export interface AgentInvocationStatsSnapshot {
  generatedAt: number
  totalSamples: number
  byAgentType: Record<string, AgentInvocationStat>
}

// ── 配置 ────────────────────────────────────────────────

const DEFAULT_MAX_RECORDS = 2000

function readMaxRecords(): number {
  const raw = process.env.CLAUDE_CODE_AGENT_INVOCATION_STATS_MAX
  if (!raw) return DEFAULT_MAX_RECORDS
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RECORDS
  return n
}

// ── 状态 ────────────────────────────────────────────────

const records: AgentInvocationRecord[] = []

// ── 跨会话持久化 ────────────────────────────────────────

const AGENT_INVOCATION_STATS_NAMESPACE = 'agent-invocation-stats'
const AGENT_INVOCATION_STATS_SCHEMA_VERSION = 1

const agentInvocationStatsSnapshotStore = createSnapshotStore<
  AgentInvocationRecord[]
>({
  namespace: AGENT_INVOCATION_STATS_NAMESPACE,
  schemaVersion: AGENT_INVOCATION_STATS_SCHEMA_VERSION,
  getSnapshot: () => (records.length > 0 ? records.slice() : null),
  applySnapshot: data => {
    if (!Array.isArray(data)) return
    const max = readMaxRecords()
    const keep = data
      .filter(
        r =>
          r &&
          typeof r === 'object' &&
          typeof (r as AgentInvocationRecord).agentType === 'string' &&
          typeof (r as AgentInvocationRecord).ts === 'number' &&
          ((r as AgentInvocationRecord).outcome === 'success' ||
            (r as AgentInvocationRecord).outcome === 'failure'),
      )
      .slice(-max)
    records.length = 0
    records.push(...keep)
  },
})

// ── 记录点 ──────────────────────────────────────────────

/**
 * 记录一次 Agent 工具调用。
 * - 空 agentType 直接丢弃(sessionEpilogue 负责取 input.subagent_type,缺失即无法归类)
 * - fire-and-forget,零异常
 */
export function recordAgentInvocation(record: {
  agentType: string
  outcome: AgentInvocationOutcome
}): void {
  try {
    if (!record.agentType) return
    if (record.outcome !== 'success' && record.outcome !== 'failure') return
    records.push({
      agentType: record.agentType,
      outcome: record.outcome,
      ts: Date.now(),
    })
    const max = readMaxRecords()
    if (records.length > max) {
      records.splice(0, records.length - max)
    }
  } catch {
    // 永不抛
  }
}

// ── 聚合 ────────────────────────────────────────────────

function aggregateRecords(
  src: AgentInvocationRecord[],
): AgentInvocationStatsSnapshot {
  const buckets = new Map<
    string,
    { total: number; success: number; failure: number; lastAt: number }
  >()
  for (const r of src) {
    let b = buckets.get(r.agentType)
    if (!b) {
      b = { total: 0, success: 0, failure: 0, lastAt: 0 }
      buckets.set(r.agentType, b)
    }
    b.total++
    if (r.outcome === 'success') b.success++
    else b.failure++
    if (r.ts > b.lastAt) b.lastAt = r.ts
  }
  const byAgentType: Record<string, AgentInvocationStat> = {}
  for (const [agentType, b] of buckets) {
    byAgentType[agentType] = {
      agentType,
      totalRuns: b.total,
      successCount: b.success,
      failureCount: b.failure,
      lastInvokedAt: b.lastAt,
    }
  }
  return {
    generatedAt: Date.now(),
    totalSamples: src.length,
    byAgentType,
  }
}

export function getAgentInvocationStatsSnapshot(): AgentInvocationStatsSnapshot {
  return aggregateRecords(records)
}

/**
 * 时间窗变体:
 *   - windowMs ≤ 0 或非有限值 → 全量
 *   - 否则过滤 ts >= now - windowMs 的事件
 *
 * 与 userCorrectionStats 同语义,让"半年前调用过的 agent"自然 fade out。
 */
export function getRecentAgentInvocationStatsSnapshot(
  windowMs: number,
): AgentInvocationStatsSnapshot {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return aggregateRecords(records)
  }
  const cutoff = Date.now() - windowMs
  const recent: AgentInvocationRecord[] = []
  for (const r of records) {
    if (r.ts >= cutoff) recent.push(r)
  }
  return aggregateRecords(recent)
}

// ── 工具方法 ────────────────────────────────────────────

export function getAgentInvocationStatsRecordCount(): number {
  return records.length
}

export function clearAgentInvocationStats(): void {
  records.length = 0
}

// ── 跨会话持久化对外 API ──────────────────────────────

export async function hydrateAgentInvocationStatsFromDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentInvocationStatsSnapshotStore.loadNow(projectDir)
}

export async function persistAgentInvocationStatsToDisk(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentInvocationStatsSnapshotStore.saveNow(projectDir)
}

export async function deleteAgentInvocationStatsSnapshotFile(
  projectDir: string,
): Promise<boolean> {
  if (!projectDir) return false
  return agentInvocationStatsSnapshotStore.deleteNow(projectDir)
}
