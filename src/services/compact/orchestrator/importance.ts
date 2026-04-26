/**
 * 重要性评分 (P1-1) — 给消息打 0-1 分，供 Planner 决定哪些消息优先保留。
 *
 * 评分规则：
 *   - 用户消息 +0.3
 *   - 错误消息 +0.3
 *   - plan/todo 变更 +0.15 ~ 0.2
 *   - compact 边界永不压缩 → 1.0
 *   - frontmatter importance: high → 1.0
 *   - 距离当前轮次越远按 0.95^age 衰减（参考 skillUsageTracking 的半衰期思路）
 *
 * 本文件故意使用宽松类型以避免与 types/message.ts 的内部类型耦合，
 * 这样在影子模式期间不影响任何既有导入关系。
 */

export interface ScoringContext {
  currentTurn: number
  relevance?: RelevanceHint
}

interface LooseMessage {
  type?: string
  isCompactBoundary?: boolean
  turnIdx?: number
  content?: unknown
  message?: { content?: unknown }
  metadata?: Record<string, unknown>
}

export interface RelevanceHint {
  intent?: string
  keywords: string[]
  paths: string[]
  toolNames: string[]
}

const STOPWORDS = new Set([
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'then',
  'into',
  'have',
  'need',
  'will',
  'just',
  'when',
  'what',
  'where',
  'which',
  '继续',
  '实现',
  '当前',
  '现在',
  '需要',
  '一下',
  '这个',
  '那个',
  '问题',
])

function containsKeyword(value: unknown, kws: string[]): boolean {
  if (typeof value !== 'string') return false
  const lower = value.toLowerCase()
  return kws.some(k => lower.includes(k))
}

function collectBlockText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object' || !('type' in block)) {
        return ''
      }
      switch (block.type) {
        case 'text':
          return 'text' in block && typeof block.text === 'string'
            ? block.text
            : ''
        case 'tool_use':
          return [
            'name' in block ? String(block.name) : '',
            'input' in block && block.input
              ? JSON.stringify(block.input)
              : '',
          ].join(' ')
        case 'tool_result':
          if (!('content' in block)) return ''
          return collectBlockText(block.content)
        case 'thinking':
          return 'thinking' in block && typeof block.thinking === 'string'
            ? block.thinking
            : ''
        case 'redacted_thinking':
          return 'data' in block && typeof block.data === 'string'
            ? block.data
            : ''
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join(' ')
}

function messageText(msg: LooseMessage): string {
  return collectBlockText(msg.content ?? msg.message?.content)
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !STOPWORDS.has(token))
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function extractPaths(text: string): string[] {
  const matches =
    text.match(
      /(?:[A-Za-z]:\\|\/|\.{1,2}\/)?(?:[\w.-]+[\\/])+[\w.-]+\.\w+/g,
    ) ?? []
  return unique(matches.map(path => path.toLowerCase())).slice(0, 8)
}

function extractToolNames(message: LooseMessage): string[] {
  const content = message.content ?? message.message?.content
  if (!Array.isArray(content)) {
    return []
  }
  return unique(
    content
      .map(block =>
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'tool_use' &&
        'name' in block
          ? String(block.name).toLowerCase()
          : '',
      )
      .filter(Boolean),
  )
}

function keywordOverlap(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) {
    return 0
  }
  const lower = text.toLowerCase()
  return keywords.reduce(
    (count, keyword) => (lower.includes(keyword) ? count + 1 : count),
    0,
  )
}

export function buildRelevanceHint(messages: LooseMessage[]): RelevanceHint {
  const lastUserText = [...messages]
    .reverse()
    .find(message => message.type === 'user' && messageText(message).trim())
  const intent = lastUserText ? messageText(lastUserText).trim() : undefined
  const keywords = intent ? unique(tokenize(intent)).slice(0, 14) : []
  const paths = intent ? extractPaths(intent) : []
  const toolNames = unique(
    messages
      .slice(-12)
      .flatMap(message => extractToolNames(message))
      .slice(-8),
  )

  return {
    intent,
    keywords,
    paths,
    toolNames,
  }
}

export function scoreMessage(msg: LooseMessage, ctx: ScoringContext): number {
  if (msg.isCompactBoundary) return 1.0
  if (msg.metadata?.importance === 'high') return 1.0

  let score = 0.5
  const text = messageText(msg)

  if (msg.type === 'user') score += 0.3
  if (msg.type === 'error' || msg.type === 'tool_error') score += 0.3

  // plan / todo 变更启发式检测
  if (
    containsKeyword(text, ['plan.md', 'todowrite', 'todoupdate', 'task #'])
  ) {
    score += 0.2
  }

  // RCA 证据/假设消息提权，确保调试链路不被压缩
  if (msg.metadata?.rcaEvidence) score += 0.25
  if (msg.metadata?.rcaHypothesis) score += 0.2

  const relevance = ctx.relevance
  if (relevance) {
    const overlap = keywordOverlap(text, relevance.keywords)
    score += Math.min(0.25, overlap * 0.05)

    if (
      relevance.paths.length > 0 &&
      relevance.paths.some(path => text.toLowerCase().includes(path))
    ) {
      score += 0.2
    }

    const toolNameHit = extractToolNames(msg).some(toolName =>
      relevance.toolNames.includes(toolName),
    )
    if (toolNameHit) {
      score += 0.15
    }

    if (
      relevance.keywords.length > 0 &&
      overlap === 0 &&
      msg.type !== 'user' &&
      msg.type !== 'error' &&
      msg.type !== 'tool_error'
    ) {
      score -= 0.08
    }
  }

  // 衰减
  if (typeof msg.turnIdx === 'number') {
    const age = Math.max(0, ctx.currentTurn - msg.turnIdx)
    score *= Math.pow(0.95, age)
  }

  return Math.max(0, Math.min(score, 1.0))
}

/** 批量评分 */
export function scoreMessages(
  messages: LooseMessage[],
  ctx: ScoringContext,
): number[] {
  return messages.map(m => scoreMessage(m, ctx))
}

export function scoreMessagesAgainstCurrentTask(
  messages: LooseMessage[],
): number[] {
  return scoreMessages(
    messages.map((message, turnIdx) => ({ ...message, turnIdx })),
    {
      currentTurn: Math.max(0, messages.length - 1),
      relevance: buildRelevanceHint(messages),
    },
  )
}
