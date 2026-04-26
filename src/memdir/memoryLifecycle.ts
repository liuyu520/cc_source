// src/memdir/memoryLifecycle.ts
// 记忆生命周期管理：衰减评分模型
// 被动触发：在向量索引更新时计算衰减分，在召回排序时使用

/**
 * 向量缓存中单个文档的结构
 * 被 vectorIndex.ts 引用
 */
export type VectorDocument = {
  mtimeMs: number                    // 文件修改时间
  vector: Record<string, number>     // TF-IDF 稀疏向量
  decayScore?: number                // 衰减分数 (0~1+)
  accessCount?: number               // 被召回次数
  lastAccessMs?: number              // 最后召回时间戳
}

/**
 * 记忆生命周期状态
 */
export type LifecycleState = 'active' | 'decaying' | 'archive_candidate'

/**
 * 不同记忆类型的衰减速率调整
 * feedback 衰减最慢（用户反馈长期有效），project 最快（状态变化频繁）
 */
const TYPE_DECAY_RATE: Record<string, number> = {
  feedback: 0.01,    // 每天衰减 1%
  user: 0.015,       // 每天衰减 1.5%
  reference: 0.015,  // 每天衰减 1.5%
  project: 0.025,    // 每天衰减 2.5%
  episodic: 0.03,    // 每天衰减 3%（情节记忆时效性更强，但 accessBoost 保护高频召回的不消亡）
  // autoEvolve(v1.0) 基因文件:被命中即行为有效,衰减最慢;长期 0 命中的基因由
  // decayScore 自动滑入 archive_candidate,由 Arena Controller 移入化石层。
  genome: 0.005,
}

const DEFAULT_DECAY_RATE = 0.02 // 默认每天衰减 2%

/**
 * 计算衰减分数
 * 公式：base(1.0) - ageDays * decayRate + accessBoost * 0.1 + recencyBoost * 0.3
 *
 * @param doc 文档数据
 * @param memoryType 记忆类型（影响衰减速率）
 * @returns 衰减分数，≥ 0
 */
export function computeDecayScore(
  doc: Pick<VectorDocument, 'mtimeMs' | 'accessCount' | 'lastAccessMs'>,
  memoryType?: string,
): number {
  const ageDays = (Date.now() - doc.mtimeMs) / 86400000
  const decayRate = memoryType
    ? (TYPE_DECAY_RATE[memoryType] ?? DEFAULT_DECAY_RATE)
    : DEFAULT_DECAY_RATE

  // 访问频率提升：log2(1 + accessCount)，缓慢增长
  const accessBoost = Math.log2(1 + (doc.accessCount ?? 0))

  // 最近召回提升：30天内线性衰减到0
  const recencyBoost = doc.lastAccessMs
    ? Math.max(0, 1 - (Date.now() - doc.lastAccessMs) / (30 * 86400000))
    : 0

  return Math.max(0, 1.0 - ageDays * decayRate + accessBoost * 0.1 + recencyBoost * 0.3)
}

/**
 * 根据衰减分数判断生命周期状态
 */
export function getLifecycleState(decayScore: number): LifecycleState {
  if (decayScore > 0.3) return 'active'
  if (decayScore > 0.1) return 'decaying'
  return 'archive_candidate'
}

/**
 * 判断一个文档是否为归档候选
 */
export function isArchiveCandidate(doc: VectorDocument): boolean {
  const score = doc.decayScore ?? computeDecayScore(doc)
  return getLifecycleState(score) === 'archive_candidate'
}
