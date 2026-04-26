/**
 * RCA (Root Cause Analysis) 子系统 — 类型定义
 *
 * 核心思想：把"调试"建模为假设空间中的贝叶斯搜索。
 * 每个 Hypothesis 有先验/后验概率，Evidence 是观测到的工具结果
 * 或用户反馈，ProbeAction 是信息增益最大化的下一步建议。
 */

// ---- 假设 ----

export type HypothesisStatus = 'active' | 'confirmed' | 'rejected' | 'merged'

export interface Hypothesis {
  /** 假设 ID，格式 'h_001' */
  id: string
  /** 假设内容，如 "这个 bug 是因为 X 导致 Y" */
  claim: string
  /** 初始概率 0-1（sideQuery 给出） */
  prior: number
  /** 贝叶斯更新后的后验概率 */
  posterior: number
  /** 关联证据的 ID 列表 */
  evidenceRefs: string[]
  status: HypothesisStatus
  /** 创建时的 turn 序号 */
  createdAtTurn: number
  /** 从哪个假设分裂而来（可选） */
  parentId?: string
}

// ---- 证据 ----

export type EvidenceKind =
  | 'tool_result'       // 工具调用返回的观测
  | 'user_feedback'     // 用户纠正 / 确认
  | 'code_observation'  // 代码结构观测
  | 'error_signal'      // 错误 / 异常信号

export interface Evidence {
  /** 证据 ID，格式 'e_001' */
  id: string
  kind: EvidenceKind
  /** 摘要，≤120 字符 */
  summary: string
  /** 工具名称（如 'Grep' / 'Read' / 'Bash'） */
  toolName?: string
  /** 所在 turn 序号 */
  turnIdx: number
  /** 该证据支持的假设 ID 列表 */
  supports: string[]
  /** 该证据反驳的假设 ID 列表 */
  contradicts: string[]
  timestamp: number
  /** 所属 RCA session */
  sessionId: string
}

// ---- 探测动作 ----

export type ProbeCost = 'low' | 'medium' | 'high'

export interface ProbeAction {
  /** 建议使用的工具名称（已注册的 Tool） */
  tool: string
  /** 为什么这个动作信息增益最大 */
  rationale: string
  /** 主要验证哪个假设 */
  targetHypothesis: string
  estimatedCost: ProbeCost
}

// ---- RCA 会话状态 ----

export type RCAStatus = 'investigating' | 'converged' | 'abandoned'

export interface RCASession {
  sessionId: string
  problemStatement: string
  hypotheses: Hypothesis[]
  evidences: Evidence[]
  /** 收敛分数 = max_posterior - second_max_posterior */
  convergenceScore: number
  status: RCAStatus
  /** 开始时的 turn 序号 */
  startTurn: number
  /** 当前 turn 计数器（用于生成 ID） */
  turnCounter: number
  /** 已生成的假设数（用于 ID 自增） */
  hypothesisCounter: number
  /** 已生成的证据数（用于 ID 自增） */
  evidenceCounter: number
}
