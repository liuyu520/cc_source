/**
 * causalGraph · 类型定义
 *
 * 把 agent 在调试/探索过程中产生的"事实"、"假设"、"观察"与"任务"等
 * 语义单元组织为有向带权图,落在 SQLite 里。E 线(多 Agent 因果黑板)
 * 在子 agent 之间共享已有事实,避免重复推理。
 */

/** 节点类型(对齐 RCA 术语,但保持独立演化) */
export type CausalNodeKind =
  | 'fact' // 确认成立的事实
  | 'hypothesis' // 待验证的假设
  | 'observation' // 原始观察(日志/输出)
  | 'task' // 任务描述(父 agent 发起的问题)

/** 边类型 */
export type CausalEdgeKind =
  | 'supports' // from 支持 to
  | 'contradicts' // from 反驳 to
  | 'causes' // from 导致 to(因果)
  | 'related' // 相关但关系未明

export interface CausalNode {
  /** 稳定 id:kind + sha1(text) 前 16 位,允许同文本去重 */
  id: string
  text: string
  kind: CausalNodeKind
  sessionId: string | null
  createdAt: string // ISO 8601
}

export interface CausalEdge {
  id: number // 自增主键
  fromId: string
  toId: string
  kind: CausalEdgeKind
  weight: number // 默认 1.0,后续支持衰减
  sessionId: string | null
  metaJson: string | null
  createdAt: string
}

export interface AddFactOpts {
  kind?: CausalNodeKind // 默认 'fact'
  sessionId?: string | null
  metaJson?: string | null
}

export interface AddEdgeOpts {
  kind?: CausalEdgeKind // 默认 'related'
  weight?: number
  sessionId?: string | null
  metaJson?: string | null
}

export interface GraphStats {
  nodes: number
  edges: number
  byKind: Record<string, number>
}
