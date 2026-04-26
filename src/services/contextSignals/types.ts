/**
 * ContextSignals — 类型定义(Phase 54)
 *
 * 核心抽象: 把"任何送入 LLM 的上下文块"视为一个 SignalSource 的 served event。
 * 本阶段(Phase 54)只做 observability, 不做 selection/refinery/packing。
 *
 * 设计原则:
 * - 与既有 findRelevantMemories / contextCollapse / tierManager **并行存在**, 不替换任何逻辑。
 * - 纯内存 ring buffer, 进程退出清零; 如需持久化可包一层 snapshotStore(延后)。
 * - 字符串弱类型 kind, 方便新 source 任意接入(家族可扩展)。
 */

export type ContextSignalKind =
  // Phase 54 首个接入: 自动记忆召回(src/memdir/findRelevantMemories.ts)
  | 'auto-memory'
  // 预留位: 未来依次接入 tool-result / history-compact / tier-index / file-attachment / user-input
  | 'tool-result'
  | 'history-compact'
  | 'tier-index'
  | 'file-attachment'
  | 'user-input'
  | 'pattern-miner'
  | 'agent-handoff'
  // Phase 63 (2026-04-24): dream pipeline 产出的语义/情节记忆蒸馏事件。
  // 在 compact auto-distill 等"睡眠整合"节点完成后记入, 服务于 ROI 分析:
  // 可用 utilizationSampler 反查后续 model output 是否引用到 distilled names。
  | 'dream-artifact'
  | string

/**
 * 一次"送入上下文"的记账事件。
 * 把 relevance/cost/level 作为弱显式字段, 允许源不提供(undefined 即可)。
 */
export type SignalServedEvent = {
  /** 写入时间戳 (Date.now()) */
  ts: number
  /** 信号家族 */
  kind: ContextSignalKind
  /** 单次决策点的人类可读标识 (如 turn id / attachment type), 便于追溯 */
  decisionPoint?: string
  /** 估算的 token 成本 (粗估即可, 沿用 roughTokenCountEstimation) */
  tokens: number
  /** 条目数量 (比如 5 条记忆) */
  itemCount: number
  /** 抽象层级: index/summary/full */
  level?: 'index' | 'summary' | 'full'
  /** 源方自行定义的相关性评分, 0..1; 缺省表示"未评分" */
  relevance?: number
  /**
   * 可选 anchors: 该次投递的内容里可能被模型原样引用的"锚点"字符串。
   * 典型: 文件路径 / 工具名 / 关键符号。utilizationSampler 用它做 overlap。
   * 缺省则 sampler 跳过本 event, 不产出 utilization 记录。
   */
  anchors?: ReadonlyArray<string>
  /** 可选的静态扩展字段, 由具体 source 自己约定含义 */
  meta?: Readonly<Record<string, string | number | boolean>>
}

/**
 * 一次"事后看信号是否被用到"的记账事件。
 * Phase 54 不强制填; 留给 Phase 58 (Telemetry+Regret/Hunger) 接入。
 */
export type SignalUtilizationEvent = {
  ts: number
  kind: ContextSignalKind
  decisionPoint?: string
  /** 本次决策是否引用了该 source 提供的内容 */
  used: boolean
  /** 可选: 引用方式(string-overlap / explicit-tool-read / agent-mention 等) */
  evidence?: string
}

/**
 * 每个 kind 的聚合快照, 给 /kernel-status 展示用。
 */
export type ContextSignalKindSnapshot = {
  kind: ContextSignalKind
  servedCount: number
  totalTokens: number
  totalItems: number
  lastServedAt: number
  utilizedCount: number
  notUtilizedCount: number
  /** utilized / (utilized + notUtilized); 0 = 未知 / 未采样 */
  utilizationRate: number
}

/**
 * 面向 /kernel-status 的顶层快照。
 */
export type ContextSignalsSnapshot = {
  enabled: boolean
  ringCapacity: number
  servedRingSize: number
  utilizationRingSize: number
  byKind: ReadonlyArray<ContextSignalKindSnapshot>
  // 方便一眼看最近几条原始事件
  recentServed: ReadonlyArray<SignalServedEvent>
}
