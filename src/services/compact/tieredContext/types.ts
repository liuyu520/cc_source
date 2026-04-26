/**
 * Tiered Context Rehydration — 类型定义
 *
 * compact 时把被压缩掉的 turn 的位置信息写到 L4 索引，后续需要时从磁盘
 * 精确读回原文。形成 L1 (hot) / L2 (warm cache) / L3 (compact summary) /
 * L4 (cold disk rehydrate) 四级上下文金字塔。
 */

/** L4 索引中的单条 turn 记录 */
export interface TierEntry {
  /** message UUID 或 turn 的稳定 id */
  turnId: string
  role: 'user' | 'assistant'
  /** 在 transcript JSONL 文件中的字节 offset */
  byteOffset: number
  /** 该条目在文件中占用的字节长度 */
  byteLength: number
  /** 粗估 token 数 */
  tokenEstimate: number
  /** 来自 orchestrator/importance.ts 的 scoreMessage() 分数 */
  importanceScore: number
  /** ISO 8601 时间戳：这条 turn 被 compact 掉的时间 */
  compactedAt: string
  /** 前 100 字符预览，用于 search 时的关键词匹配 */
  summarySnippet?: string
}

/** 单 session 的完整 L4 索引 */
export interface TierIndex {
  sessionId: string
  /** 原始 transcript JSONL 文件路径 */
  transcriptPath: string
  entries: TierEntry[]
  createdAt: string
  lastUpdatedAt: string
}

/** rehydrate() 的返回结果 */
export interface RehydrateResult {
  turnId: string
  /** 原始消息内容（JSON 字符串序列化） */
  content: string
  tokenCount: number
  /** 数据来源：L2 内存缓存 or L4 磁盘 */
  source: 'l4_disk' | 'l2_cache'
  tookMs: number
}
