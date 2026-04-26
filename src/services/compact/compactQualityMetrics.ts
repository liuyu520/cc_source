/**
 * compactQualityMetrics — 压缩质量度量
 *
 * 在 compact 前后测量关键信息的保留率：
 *   - 决策（decision keywords）
 *   - 文件引用（file paths）
 *   - 代码变更（Edit/Write tool_use）
 *
 * 纯计算模块，无 IO，无依赖。
 */

// 复用 importanceScoring 中的决策关键词模式
const DECISION_KEYWORDS = [
  'decide', 'decision', 'chose', 'choose', 'approach', 'strategy',
  'solution', 'plan', 'architecture', 'design', 'trade-off', 'tradeoff',
  'recommend', 'prefer', 'selected', 'concluded', 'determined',
]

// 文件路径匹配：src/xxx、./xxx、/xxx.ext 等
const FILE_REF_PATTERN = /(?:src\/|\.\/|\/[\w-]+\/)[^\s,)}\]'"]+\.\w{1,5}/g

// 代码变更工具名
const CODE_CHANGE_TOOLS = new Set(['Edit', 'Write', 'FileEdit', 'FileWrite', 'NotebookEdit'])

export interface CompactQualitySnapshot {
  decisionCount: number
  fileRefs: Set<string>
  codeChangeCount: number
  totalMessages: number
}

export interface RetentionResult {
  decisionRetention: number   // 0-1
  fileRefRetention: number    // 0-1
  codeChangeRetention: number // 0-1（基于文件名在 summary 中是否出现）
  overallRetention: number    // 加权平均
}

/**
 * 从消息数组中提取质量快照
 * messages 类型为 any[] 以避免引入 Message 类型依赖
 */
export function measureQuality(messages: readonly any[]): CompactQualitySnapshot {
  let decisionCount = 0
  const fileRefs = new Set<string>()
  let codeChangeCount = 0

  for (const msg of messages) {
    const content = extractContentText(msg)
    if (!content) continue

    // 检测决策关键词
    const lower = content.toLowerCase()
    for (const kw of DECISION_KEYWORDS) {
      if (lower.includes(kw)) {
        decisionCount++
        break // 每条消息最多计一次
      }
    }

    // 提取文件引用
    const refs = content.match(FILE_REF_PATTERN)
    if (refs) {
      for (const ref of refs) fileRefs.add(ref)
    }

    // 检测代码变更 tool_use
    if (msg?.message?.content) {
      const blocks = Array.isArray(msg.message.content) ? msg.message.content : []
      for (const block of blocks) {
        if (block.type === 'tool_use' && CODE_CHANGE_TOOLS.has(block.name)) {
          codeChangeCount++
        }
      }
    }
  }

  return {
    decisionCount,
    fileRefs,
    codeChangeCount,
    totalMessages: messages.length,
  }
}

/**
 * 计算 summary 中保留了多少关键信息
 */
export function computeRetentionMetrics(
  pre: CompactQualitySnapshot,
  summaryText: string,
): RetentionResult {
  const lowerSummary = summaryText.toLowerCase()

  // 决策保留率：summary 中出现了多少决策关键词
  let decisionHits = 0
  for (const kw of DECISION_KEYWORDS) {
    if (lowerSummary.includes(kw)) decisionHits++
  }
  const decisionRetention = pre.decisionCount > 0
    ? Math.min(1, decisionHits / Math.min(pre.decisionCount, DECISION_KEYWORDS.length))
    : 1 // 原文无决策则视为完美保留

  // 文件引用保留率：pre 中的文件路径在 summary 中出现的比例
  let fileRefHits = 0
  for (const ref of pre.fileRefs) {
    // 匹配文件名部分（路径前缀可能在摘要中被省略）
    const basename = ref.split('/').pop() || ref
    if (summaryText.includes(basename)) fileRefHits++
  }
  const fileRefRetention = pre.fileRefs.size > 0
    ? fileRefHits / pre.fileRefs.size
    : 1

  // 代码变更保留率：summary 中是否提到了变更的文件
  // 使用文件引用的保留率作为代理指标
  const codeChangeRetention = pre.codeChangeCount > 0
    ? fileRefRetention // 如果文件引用被保留了，代码变更上下文也大概率被保留
    : 1

  // 加权平均：决策最重要
  const overallRetention =
    decisionRetention * 0.4 +
    fileRefRetention * 0.35 +
    codeChangeRetention * 0.25

  return {
    decisionRetention,
    fileRefRetention,
    codeChangeRetention,
    overallRetention,
  }
}

/**
 * 从消息对象中提取文本内容
 */
function extractContentText(msg: any): string {
  if (!msg?.message?.content) return ''

  const content = msg.message.content
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join(' ')
  }

  return ''
}
