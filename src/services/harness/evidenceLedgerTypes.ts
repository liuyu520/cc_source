/**
 * Harness Primitives — EvidenceLedger 类型定义
 *
 * EvidenceLedger 是跨 domain 的统一证据存储层，用于记录 harness 系统
 * （Dream / Skill / Trust / Router / PEV / Pool / Context 等）的决策、
 * 健康数据、执行痕迹。所有子系统共享同一套 append-only ndjson 存储接口。
 */

/** 证据域：每个 domain 一个独立的 ndjson 文件，互不干扰 */
export type EvidenceDomain =
  | 'dream' // Dream Pipeline 事件（含 session_evidence / rca_observation / consolidation_outcome）
  | 'skill' // Skill Recall V2 事件
  | 'trust' // Trust 评分事件
  | 'router' // Model Router 路由决策 / 健康 / 成本
  | 'routing' // 通用路由 / intent-first-routing 事件
  | 'pev' // PEV Harness plan/verify 事件 + blast_radius_preview
  | 'pool' // 资源池事件
  | 'context' // Tiered Context rehydrate 事件
  | 'memory' // memory recall / decay / verification 事件
  | 'procedural' // 程序性记忆 / 工具序列挖掘
  | 'harness' // 跨子系统 breaker / scheduler / budget 事件
  | 'io' // 派生缓存 / debounce / rebuild 事件
  | 'methodology' // 白皮书 / 方法论自身的演化事件
  | 'rca' // RCA 假设调试事件（hypothesis_update / convergence）
  | 'evolve' // autoEvolve v1.0 进化事件(pattern_mined / skill_compiled / organism_spawned / fitness_scored / promotion_proposal)
  | 'shadow-promote' // shadow→cutover 调度事件(readiness_snapshot / cutover-applied)

/** 单条证据条目 */
export interface EvidenceEntry {
  /** ISO 8601 时间戳 */
  ts: string
  /** 所属域 */
  domain: EvidenceDomain
  /** 业务事件类型（domain-specific），如 'route_decision' / 'tier_indexed' */
  kind: string
  /** 关联的会话 id（可选） */
  sessionId?: string
  /** 事件 payload，任意 JSON 可序列化对象 */
  data: Record<string, unknown>
  /** 可选 TTL（天），超出后被 gc 清理；默认 30 天 */
  ttlDays?: number
}

/** domain 统计快照 */
export interface LedgerSnapshot {
  domain: EvidenceDomain
  totalEntries: number
  oldestTs: string
  newestTs: string
}

/** query 接口的过滤条件 */
export interface LedgerQueryOptions {
  /** 起始时间（含），ISO 8601 */
  since?: string
  /** 结束时间（含），ISO 8601 */
  until?: string
  /** 事件 kind 精确匹配 */
  kind?: string
  /** 最多返回条数，按时间倒序取最近 N 条 */
  limit?: number
  /** 读取模式：默认 tail，只读尾部固定窗口；full 用于兼容旧行为 */
  scanMode?: 'tail' | 'full'
  /** tail 模式下最多读取多少字节，默认 1MB */
  tailBytes?: number
}
