/**
 * P0-1 SideQueryScheduler — 统一侧查询调度器类型定义
 *
 * 侧查询 = 非主循环的 LLM 或重计算任务（记忆召回/skill 召回/yolo 分类/
 * extractMemories/autoDream/microCompact/agentSummary 等）。
 *
 * 所有侧查询通过 SideQueryScheduler.submit() 统一提交，获得：
 *   - 优先级队列与并发上限
 *   - token 预算控制
 *   - 熔断与本地 fallback 降级
 *   - 去重（相同 dedupeKey 的请求复用结果）
 *   - 统一埋点
 */

import type { QuerySource } from '../../constants/querySource.js'

/** 优先级：决定队列顺序与并发槽位 */
export type SideQueryPriority =
  | 'P0_blocking' // 阻塞主循环：权限分类
  | 'P1_quality' // 影响回答质量：记忆召回
  | 'P2_method' // 影响方法选择：skill 召回
  | 'P3_background' // 后台整理：extractMemories / autoDream

/** 业务分类 — 与现有侧查询入口一一对应 */
export type SideQueryCategory =
  | 'memory_recall'
  | 'skill_discovery'
  | 'yolo_classify'
  | 'extract_memories'
  | 'auto_dream'
  | 'micro_compact'
  | 'agent_summary'
  | 'prompt_suggest'
  | 'magic_docs'
  | 'tool_use_summary'
  | 'compact_quality_check'
  | 'mcp_manifest_probe'
  // Harness Phase 0+ 新增：与 services/harness/ 基础层一一对应
  | 'model_router' // Phase 1: Model Router 路由决策 / 健康检测
  | 'context_rehydrate' // Phase 2: Tiered Context 取回被压缩的 turn
  | 'action_recall' // Phase 3: Unified Action Registry 召回
  | 'other'

export interface SideQueryTask<T = unknown> {
  /** 任务唯一 id（用于日志追踪），调用方可传，否则自动生成 */
  id?: string
  category: SideQueryCategory
  priority: SideQueryPriority
  /** 传给 withRetry 的 source；与 constants/querySource.ts 对齐 */
  source: QuerySource
  /** 真正执行 LLM 调用的闭包；收到的 signal 需被尊重以支持超时/取消 */
  run: (signal: AbortSignal) => Promise<T>
  /** 本地降级实现（无 LLM）。熔断打开或主 run 失败时调用 */
  fallback?: () => Promise<T> | T
  /** 预估 token 消耗（用于预算控制）。默认按 priority 推断 */
  estimatedTokens?: number
  /** 单次任务超时 ms，默认 15000 */
  timeoutMs?: number
  /**
   * 去重 key：相同 key 且正在执行的任务会复用同一个 Promise。
   * 例：`memory_recall:${sha1(userMessage)}`
   */
  dedupeKey?: string
}

export type SideQueryStatus =
  | 'ok'
  | 'fallback'
  | 'skipped'
  | 'error'
  | 'aborted'

export interface SideQueryResult<T = unknown> {
  status: SideQueryStatus
  value?: T
  error?: Error
  tookMs: number
  /** 队列等待耗时 */
  queueWaitMs: number
  /** 是否命中 dedupe 缓存 */
  dedupeHit: boolean
  /** 熔断是否处于打开状态 */
  circuitBreakerOpen: boolean
  /** 是否走了 fallback */
  fallbackUsed: boolean
}
