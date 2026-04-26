/**
 * Dream Pipeline —— 五阶段类型定义 (v1 只落 Capture + Triage)
 *
 * 目标：把 auto dream 从"定时批 consolidation"升级为"证据驱动的
 * 记忆生命周期"。v1 仅在影子模式下记录 evidence 并给出 triage 决策，
 * 不改变现有 autoDream.ts 的执行路径。
 */

import type { MessageRef } from '../../compact/orchestrator/types.js'

export interface DreamEvidence {
  sessionId: string
  endedAt: string // ISO
  /** 会话时长（毫秒） */
  durationMs: number
  /** 本 session 命中的新颖度（0..1），规则估计 */
  novelty: number
  /** 冲突信号：user 是否纠正 assistant（"not that"/"no"/"wrong"/rollback 等） */
  conflicts: number
  /** user 显式纠错次数 */
  userCorrections: number
  /** assistant 意外/surprise 信号（tool error / exception / retry） */
  surprise: number
  /** tool 调用失败率（0..1） */
  toolErrorRate: number
  /** 本 session 触碰的文件数 */
  filesTouched: number
  /** 是否有 memory 写入 / 更新 */
  memoryTouched: boolean
  /**
   * 本 session 涉及文件在知识图谱中的聚合重要性（PageRank-ish，0..1）。
   * 由 sessionEpilogue 从 knowledge_graph.json 计算，缺失时视为 0。
   * 升级方案 Phase B1：让 triage 能感知"这次 session 碰到了图谱里很重要的节点"。
   */
  graphImportance?: number
  /**
   * 概念新颖度（0..1）：session 触碰的关键词中，有多少是 vector idfMap
   * 里 IDF 高（罕见）、或压根未见过的新概念。由 sessionEpilogue 计算。
   * 升级方案 Phase B1：让 triage 能感知"这次 session 引入了全新术语"。
   */
  conceptualNovelty?: number
  /**
   * "压缩即降级"载荷：compact executor 在丢弃消息前填充此字段，
   * autoDream micro 路径消费它来生成 episodic 记忆文件。
   */
  episodicPayload?: {
    preservedMessages: MessageRef[]
    compactReason: string
    originalTokenCount: number
  }
}

export type TriageTier = 'skip' | 'micro' | 'full'

export interface TriageDecision {
  tier: TriageTier
  /** 本次打分 */
  score: number
  /** 参与评分的 evidence 条数 */
  evidenceCount: number
  /** 评分细分，供 /doctor 与 telemetry 用 */
  breakdown: {
    novelty: number
    conflict: number
    correction: number
    surprise: number
    error: number
    /** Phase B1：图谱重要性贡献（可选，兼容老 decision 记录） */
    graph?: number
    /** Phase B1：概念新颖度贡献（可选） */
    concept?: number
  }
  /** 强制 micro 时要重点 replay 的 sessionId 列表（top-K） */
  focusSessions: string[]
  /**
   * 本次打分使用的权重快照（用于 /memory-map 观测 & 反馈回路审计）。
   * 可选字段：老调用方若拿到的 decision 没有此字段，忽略即可。
   */
  weightsUsed?: {
    novelty: number
    conflict: number
    correction: number
    surprise: number
    error: number
    graph: number
    concept: number
  }
}
