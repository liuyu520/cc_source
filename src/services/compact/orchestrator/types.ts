/**
 * P1-1 CompactOrchestrator — 类型定义
 *
 * 编排器只做"何时压 / 压哪段 / 用哪个策略"的决策，真正的压缩执行
 * 仍复用 compact.ts / microCompact.ts / sessionMemoryCompact.ts / snipCompact.ts。
 */

export type CompactStrategy =
  | 'full_compact' // compact.ts 的 runCompact
  | 'micro_compact' // microCompact.ts
  | 'session_memory' // sessionMemoryCompact.ts
  | 'snip' // snipCompact.ts
  | 'rehydrate' // [Phase 2] Tiered Context: 直接从 L4 取回被压缩的 turn
  | 'rehydrate_then_snip' // [Phase 2] 先取回相关 turn，再对其余做 snip
  | 'noop'

export type CompactTriggerKind =
  | 'token_pressure' // token 使用率超阈值
  | 'heavy_tool_result' // 工具结果过大
  | 'user_idle' // 用户空闲
  | 'time_based' // 时间窗口到达
  | 'manual' // /compact 命令
  | 'post_tool' // 某些工具结束后
  | 'none'

export interface TriggerSignal {
  kind: CompactTriggerKind
  reason?: string
}

export interface TokenStats {
  usedTokens: number
  maxTokens: number
  ratio: number
}

export interface CompactPlan {
  /**
   * 主策略：决定本轮 autoCompact 阶段执行的重量级压缩路径。
   * snip / micro 不再占据 strategy 槽位 —— 它们由下方 runSnip/runMicro
   * 两个独立开关控制，以保留 query.ts 原注释 "snip before micro, both may run"
   * 的不变量（#9 修复）。
   */
  strategy: Exclude<CompactStrategy, 'snip' | 'micro_compact'> | 'micro_compact'
  /** 目标消息范围（相对 transcript 的下标，[start, end) 半开区间） */
  targetRange?: { startIdx: number; endIdx: number }
  reason: string
  estimatedTokensSaved: number
  /** 重要性低于该分数的消息将被压缩 */
  importanceFloor: number
  /** query.ts 轻量阶段：是否执行 snip（legacy 默认 true） */
  runSnip: boolean
  /** query.ts 轻量阶段：是否执行 microcompact（legacy 默认 true） */
  runMicro: boolean
  /**
   * "压缩即降级"：被压缩但值得保留为 episodic 记忆的消息引用。
   * planner 在 full_compact / session_memory 策略时填充此字段，
   * executor 在丢弃前将这些片段推入 autoDream journal 队列。
   */
  preserveAsEpisodic?: MessageRef[]
  /**
   * Phase 3 — 影子接入 contextCollapse / toolResultOffload 两条执行路径。
   *
   * runCollapse: planner 建议 contextCollapse 可以提前触发(ratio 尚未达
   *   到自身 0.9 阈值,但 planner 判断折叠收益已值得)。消费方:
   *   contextCollapse.applyCollapsesIfNeeded 读取此字段决定是否早起跑。
   *
   * runOffload: planner 建议对 heavyToolResultCount > 0 的场景,触发更
   *   积极的 tool result 外置化(当前由 applyToolResultBudget 按自身预算
   *   自判,未利用此字段)。预留给 Phase 4 消费。
   *
   * 两个字段均为可选,老消费方不读 = 零行为变化。
   */
  runCollapse?: boolean
  runOffload?: boolean
}

/**
 * 消息引用——指向 transcript 中一段值得降级保留的消息
 */
export interface MessageRef {
  startIdx: number
  endIdx: number
  /** 来自 scoreMessage() 的重要性分数 */
  importanceScore: number
  /** planner 初判的因果标签（可选） */
  suggestedCause?: string
}

export interface CompactLayerEntry {
  layer: 'L1' | 'L2' | 'L3'
  /** transcript 中原文的 hash，用于 RecallHistory 回溯 */
  originalHash: string
  summary?: string
  /** L3 才有：向量索引（复用未来统一的 embedding 基础设施） */
  embeddingRef?: string
  accessCount: number
  lastAccessedAt: number
}

export interface QualityReport {
  similarity: number
  regression: boolean
  probeCount: number
}
