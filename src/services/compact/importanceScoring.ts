/**
 * importanceScoring — 消息重要性评分系统
 *
 * 为上下文窗口中的每条消息计算重要性分数(0-1)，用于智能淘汰决策。
 * 评分维度：时效性(recency)、引用度(reference)、决策性(decision)、
 * 代码变更(codeChange)、用户消息(userExplicit)。
 *
 * 替代 snipCompact 的纯年龄分层，实现"重要的留下，不重要的先淘汰"。
 */

import { logForDebugging } from '../../utils/debug.js'

// 决策相关关键词（中英文）
const DECISION_KEYWORDS = [
  // 英文
  'decide', 'decision', 'chose', 'choose', 'approach', 'strategy',
  'solution', 'concluded', 'recommendation', 'trade-off', 'tradeoff',
  'alternative', 'option', 'selected', 'picked', 'going with',
  // 中文
  '决定', '选择', '方案', '策略', '结论', '建议', '取舍', '替代',
]

// 错误/调试关键词 — 修复过程有较高保留价值
const ERROR_KEYWORDS = [
  'error', 'bug', 'fix', 'fixed', 'issue', 'problem', 'resolved',
  'root cause', 'workaround',
  '错误', '修复', '问题', '原因', '解决',
]

// 代码修改相关工具名
const CODE_CHANGE_TOOLS = new Set([
  'FileEditTool', 'Edit', 'FileWriteTool', 'Write',
  'file_edit', 'file_write',
])

// 只读/探索工具 — 重要性较低
const READONLY_TOOLS = new Set([
  'FileReadTool', 'Read', 'GlobTool', 'Glob',
  'GrepTool', 'Grep', 'LS', 'LSP',
])

export interface ImportanceFactors {
  recency: number      // 时间衰减 (0-1)
  reference: number    // 被后续消息引用 (0-1)
  decision: number     // 包含决策内容 (0-1)
  codeChange: number   // 关联代码变更 (0-1)
  userExplicit: number // 用户消息 (0-1)
  errorFix: number     // 包含错误修复 (0-1)
}

export interface MessageImportance {
  index: number
  score: number
  factors: ImportanceFactors
}

// 权重配置 — 各维度对最终分数的贡献
const WEIGHTS = {
  recency: 0.25,
  reference: 0.15,
  decision: 0.20,
  codeChange: 0.15,
  userExplicit: 0.10,
  errorFix: 0.15,
}

/**
 * 从消息内容中提取纯文本（跳过二进制/图片等）
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        } else if (block.type === 'tool_result' && typeof block.content === 'string') {
          parts.push(block.content)
        } else if (block.type === 'tool_use' && block.input) {
          try {
            parts.push(JSON.stringify(block.input).slice(0, 500))
          } catch { /* 忽略序列化失败 */ }
        }
      }
    }
    return parts.join(' ')
  }
  return ''
}

/**
 * 提取消息中涉及的文件路径和符号名
 */
function extractFileReferences(content: unknown): Set<string> {
  const refs = new Set<string>()
  const text = extractText(content)
  // 匹配文件路径模式: src/foo/bar.ts, ./foo.js, /path/to/file
  const pathRegex = /(?:\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.\w{1,6}/g
  const matches = text.match(pathRegex)
  if (matches) {
    for (const m of matches) refs.add(m)
  }
  // 匹配函数/类名模式: functionName(), ClassName
  const symbolRegex = /\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:_[a-z][a-zA-Z0-9]*)*)(?=\s*\()/g
  const symMatches = text.match(symbolRegex)
  if (symMatches) {
    for (const m of symMatches) {
      if (m.length > 3) refs.add(m) // 忽略短名称
    }
  }
  return refs
}

/**
 * 提取消息中使用的工具名
 */
function extractToolNames(content: unknown): string[] {
  const tools: string[] = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use' && block.name) {
        tools.push(block.name as string)
      }
    }
  }
  return tools
}

/**
 * 计算时效性分数 — 指数衰减，最近消息最高
 */
function computeRecency(index: number, total: number): number {
  const distFromEnd = total - 1 - index
  // 最近5条 = 1.0，之后每5条衰减0.15
  if (distFromEnd <= 5) return 1.0
  return Math.max(0, 1.0 - (distFromEnd - 5) * 0.03)
}

/**
 * 计算引用度分数 — 被后续消息引用的文件/符号越多越重要
 */
function computeReference(
  myRefs: Set<string>,
  laterRefs: Set<string>[],
): number {
  if (myRefs.size === 0) return 0
  let hitCount = 0
  for (const laterRefSet of laterRefs) {
    for (const ref of myRefs) {
      if (laterRefSet.has(ref)) {
        hitCount++
        break // 每条后续消息最多算一次
      }
    }
  }
  // 标准化到 0-1，最多被5条后续消息引用就满分
  return Math.min(1, hitCount / 5)
}

/**
 * 计算决策性分数 — 包含决策关键词
 */
function computeDecision(text: string): number {
  const lowerText = text.toLowerCase()
  let hits = 0
  for (const kw of DECISION_KEYWORDS) {
    if (lowerText.includes(kw)) hits++
  }
  return Math.min(1, hits * 0.3)
}

/**
 * 计算代码变更分数
 */
function computeCodeChange(toolNames: string[]): number {
  let changeTools = 0
  let readonlyTools = 0
  for (const t of toolNames) {
    if (CODE_CHANGE_TOOLS.has(t)) changeTools++
    if (READONLY_TOOLS.has(t)) readonlyTools++
  }
  if (changeTools > 0) return Math.min(1, 0.5 + changeTools * 0.25)
  if (readonlyTools > 0) return 0.1 // 只读操作仍有一定价值
  return 0
}

/**
 * 计算错误修复分数
 */
function computeErrorFix(text: string): number {
  const lowerText = text.toLowerCase()
  let hits = 0
  for (const kw of ERROR_KEYWORDS) {
    if (lowerText.includes(kw)) hits++
  }
  return Math.min(1, hits * 0.25)
}

/**
 * 对消息数组计算每条消息的重要性分数
 */
export function scoreMessages(messages: readonly unknown[]): MessageImportance[] {
  const total = messages.length
  if (total === 0) return []

  // 第一遍：提取每条消息的引用集合
  const allRefs: Set<string>[] = new Array(total)
  const allTexts: string[] = new Array(total)
  const allTools: string[][] = new Array(total)

  for (let i = 0; i < total; i++) {
    const msg = messages[i] as { type?: string; message?: { content?: unknown; role?: string } }
    const content = msg?.message?.content
    allRefs[i] = extractFileReferences(content)
    allTexts[i] = extractText(content)
    allTools[i] = extractToolNames(content)
  }

  // 第二遍：计算各维度分数
  const results: MessageImportance[] = new Array(total)
  for (let i = 0; i < total; i++) {
    const msg = messages[i] as { type?: string; message?: { role?: string } }
    const isUserMsg = msg?.type === 'user' || msg?.message?.role === 'user'

    const factors: ImportanceFactors = {
      recency: computeRecency(i, total),
      reference: computeReference(allRefs[i], allRefs.slice(i + 1)),
      decision: computeDecision(allTexts[i]),
      codeChange: computeCodeChange(allTools[i]),
      userExplicit: isUserMsg ? 1.0 : 0,
      errorFix: computeErrorFix(allTexts[i]),
    }

    // 加权求和
    const score = Math.min(1, Math.max(0,
      factors.recency * WEIGHTS.recency +
      factors.reference * WEIGHTS.reference +
      factors.decision * WEIGHTS.decision +
      factors.codeChange * WEIGHTS.codeChange +
      factors.userExplicit * WEIGHTS.userExplicit +
      factors.errorFix * WEIGHTS.errorFix
    ))

    results[i] = { index: i, score, factors }
  }

  return results
}

/**
 * 根据重要性分数决定每条消息应用的压缩层级
 * 返回: 'keep' | 'light' | 'heavy' | 'elide'
 */
export function decideCompressionLevel(
  importance: MessageImportance,
  age: number,
  recentKeep: number,
): 'keep' | 'light' | 'heavy' | 'elide' {
  // 最近的消息始终保留
  if (age <= recentKeep) return 'keep'

  // 高重要性消息（>保护阈值）最多轻量压缩
  if (importance.score > _protectionThreshold) return 'light'

  // 中等重要性（0.3-0.6）根据年龄决定
  if (importance.score > 0.3) {
    return age > 30 ? 'heavy' : 'light'
  }

  // 低重要性（<0.3）更积极压缩
  return age > 15 ? 'elide' : 'heavy'
}

/**
 * 将消息分为保护组和可压缩组
 * protectedIndices: 因重要性得到保护的消息索引
 * compressibleIndices: 按优先级排序的可压缩消息索引（最不重要的在前）
 */
export function partitionByImportance(
  scores: MessageImportance[],
  recentKeep: number,
): { protectedIndices: Set<number>; compressibleIndices: number[] } {
  const total = scores.length
  const protectedIndices = new Set<number>()
  const compressible: MessageImportance[] = []

  for (const s of scores) {
    const age = total - s.index
    if (age <= recentKeep || s.score > _protectionThreshold) {
      protectedIndices.add(s.index)
    } else {
      compressible.push(s)
    }
  }

  // 按分数升序排列（最不重要的在前，优先被压缩）
  compressible.sort((a, b) => a.score - b.score)
  const compressibleIndices = compressible.map(s => s.index)

  logForDebugging(
    `[importanceScoring] ${total} msgs: ${protectedIndices.size} protected, ${compressibleIndices.length} compressible`,
  )

  return { protectedIndices, compressibleIndices }
}

// ---- 自适应阈值管理 ----

// Session-scoped 保护阈值：分数高于此值的消息受保护（最多轻量压缩）
let _protectionThreshold = 0.6
let _consecutiveRetriggers = 0

/**
 * compact 后仍超阈值（willRetriggerNextTurn）时调用，降低保护阈值以更积极压缩
 */
export function adjustThresholdsForRetrigger(): void {
  _consecutiveRetriggers++
  // 每次 retrigger 降 0.05，最低到 0.35
  _protectionThreshold = Math.max(0.35, 0.6 - _consecutiveRetriggers * 0.05)
  logForDebugging(
    `[importanceScoring] adaptive: protection=${_protectionThreshold.toFixed(2)}, retriggers=${_consecutiveRetriggers}`,
  )
}

/**
 * compact 成功（未 retrigger）时重置自适应状态
 */
export function resetAdaptiveThresholds(): void {
  _protectionThreshold = 0.6
  _consecutiveRetriggers = 0
}

/**
 * 获取当前保护阈值（供 /memory-stats 诊断命令使用）
 */
export function getProtectionThreshold(): number {
  return _protectionThreshold
}

/**
 * 获取连续 retrigger 次数（供诊断使用）
 */
export function getConsecutiveRetriggers(): number {
  return _consecutiveRetriggers
}
