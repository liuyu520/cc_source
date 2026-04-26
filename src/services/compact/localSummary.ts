/**
 * localSummary — 本地工具结果结构化摘要
 *
 * 为第三方 API 提供智能的工具结果截断策略，替代粗暴的固定字符串替换。
 * 根据工具类型选择不同的截断策略：
 *   - Read/Grep: 保留头部 + 关键行 + 尾部
 *   - Bash: 提取关键信息（错误、最后N行输出）
 *   - Edit/Write: 保留文件路径和操作摘要
 *   - 通用: 头尾截断
 */

import { logForDebugging } from '../../utils/debug.js'

// 关键词正则 — 匹配值得保留的行
const KEYWORD_PATTERN = /error|warning|fail|success|function\s|class\s|export\s|import\s|interface\s|type\s|TODO|FIXME|HACK|BUG|def\s|async\s/i

// Bash 输出中的关键信息模式
const BASH_KEY_PATTERNS = [
  /error/i,
  /warning/i,
  /fail/i,
  /success/i,
  /exit\s*(code|status)/i,
  /\d+\s*(passed|failed|skipped)/i,
  /PASS/,
  /FAIL/,
  /✓|✗|✘|✔/,
  /npm\s+ERR/i,
  /ENOENT|EACCES|EPERM/,
]

/**
 * 估算字符串的 token 数（粗略：4字符≈1token）
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * 结构化截断 — 适用于文件内容和搜索结果
 * 保留: 头部N行 + 包含关键词的行 + 尾部M行
 */
export function structuredTruncate(
  content: string,
  maxTokens: number,
  options?: { headLines?: number; tailLines?: number; maxKeywordLines?: number },
): string {
  if (estimateTokens(content) <= maxTokens) return content

  const headLines = options?.headLines ?? 25
  const tailLines = options?.tailLines ?? 10
  const maxKeywordLines = options?.maxKeywordLines ?? 15

  const lines = content.split('\n')
  if (lines.length <= headLines + tailLines) return content

  const head = lines.slice(0, headLines)
  const tail = lines.slice(-tailLines)

  // 从中间区域提取关键行（保留行号信息）
  const middleStart = headLines
  const middleEnd = lines.length - tailLines
  const keywordLines: string[] = []
  for (let i = middleStart; i < middleEnd && keywordLines.length < maxKeywordLines; i++) {
    if (KEYWORD_PATTERN.test(lines[i])) {
      keywordLines.push(`  L${i + 1}: ${lines[i].trim()}`)
    }
  }

  const omittedCount = middleEnd - middleStart
  const separator = keywordLines.length > 0
    ? `\n... [${omittedCount} lines omitted, ${keywordLines.length} key matches:]\n${keywordLines.join('\n')}\n...`
    : `\n... [${omittedCount} lines omitted] ...`

  const result = [...head, separator, ...tail].join('\n')

  // 如果结果仍然超出预算，进一步截断
  if (estimateTokens(result) > maxTokens) {
    const maxChars = maxTokens * 4
    return result.slice(0, maxChars) + `\n[truncated at ${maxTokens} tokens]`
  }

  return result
}

/**
 * Bash 输出摘要 — 提取关键信息
 */
export function extractBashKeyInfo(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content

  const lines = content.split('\n')

  // 收集关键行
  const keyLines: { index: number; line: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of BASH_KEY_PATTERNS) {
      if (pattern.test(lines[i])) {
        keyLines.push({ index: i, line: lines[i] })
        break
      }
    }
  }

  // 保留: 前3行(通常是命令本身) + 关键行 + 最后10行
  const head = lines.slice(0, 3)
  const tail = lines.slice(-10)
  const keyContent = keyLines
    .filter(k => k.index >= 3 && k.index < lines.length - 10) // 排除已包含的
    .slice(0, 10)
    .map(k => `  L${k.index + 1}: ${k.line.trim()}`)

  const parts: string[] = [...head]
  if (keyContent.length > 0) {
    parts.push(`\n... [${lines.length - 13} lines omitted, ${keyContent.length} key lines:]`)
    parts.push(...keyContent)
  } else {
    parts.push(`\n... [${lines.length - 13} lines omitted] ...`)
  }
  parts.push('', ...tail)

  const result = parts.join('\n')
  if (estimateTokens(result) > maxTokens) {
    const maxChars = maxTokens * 4
    return result.slice(0, maxChars) + `\n[truncated at ${maxTokens} tokens]`
  }

  return result
}

/**
 * 头尾截断 — 通用策略
 */
export function headTailTruncate(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content

  const maxChars = maxTokens * 4
  const headChars = Math.floor(maxChars * 0.7) // 头部占70%
  const tailChars = Math.floor(maxChars * 0.25) // 尾部占25%

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  const omitted = content.length - headChars - tailChars

  return `${head}\n\n... [${omitted} chars omitted] ...\n\n${tail}`
}

/**
 * 根据工具名称和内容选择最优截断策略
 */
export function smartTruncate(
  toolResult: string,
  toolName: string,
  maxTokens: number,
): string {
  if (estimateTokens(toolResult) <= maxTokens) return toolResult

  // 文件读取和搜索工具 — 保留结构
  if (['FileReadTool', 'Read', 'GrepTool', 'Grep', 'GlobTool', 'Glob'].includes(toolName)) {
    return structuredTruncate(toolResult, maxTokens)
  }

  // Shell/Bash 工具 — 提取关键信息
  if (['Bash', 'Shell', 'BashTool'].includes(toolName) ||
      toolName.toLowerCase().includes('shell') ||
      toolName.toLowerCase().includes('bash')) {
    return extractBashKeyInfo(toolResult, maxTokens)
  }

  // 文件编辑工具 — 保留操作摘要
  if (['FileEditTool', 'Edit', 'FileWriteTool', 'Write'].includes(toolName)) {
    return structuredTruncate(toolResult, maxTokens, {
      headLines: 15,
      tailLines: 5,
      maxKeywordLines: 10,
    })
  }

  // Web 工具 — 头尾截断
  if (['WebFetchTool', 'WebFetch', 'WebSearchTool', 'WebSearch'].includes(toolName)) {
    return headTailTruncate(toolResult, maxTokens)
  }

  // 通用截断
  return headTailTruncate(toolResult, maxTokens)
}

/**
 * 对 tool_result content 数组进行智能摘要
 * 处理 string 和 [{type:'text', text:'...'}] 两种格式
 */
export function summarizeToolResult(
  content: unknown,
  toolName: string,
  maxTokens: number,
): { content: unknown; freed: number } {
  if (typeof content === 'string') {
    const before = content.length
    const result = smartTruncate(content, toolName, maxTokens)
    return { content: result, freed: Math.max(0, before - result.length) }
  }

  if (Array.isArray(content)) {
    let totalFreed = 0
    const newContent: unknown[] = []
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          const before = (b.text as string).length
          const truncated = smartTruncate(b.text as string, toolName, maxTokens)
          newContent.push({ ...b, text: truncated })
          totalFreed += Math.max(0, before - truncated.length)
          continue
        }
      }
      newContent.push(block)
    }
    return { content: newContent, freed: totalFreed }
  }

  return { content, freed: 0 }
}

/**
 * 根据 tool_use 块查找工具名称
 */
export function findToolNameForResult(
  toolUseId: string,
  messages: readonly unknown[],
): string {
  for (const msg of messages) {
    const m = msg as { message?: { content?: unknown[] } }
    if (!Array.isArray(m?.message?.content)) continue
    for (const block of m.message.content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (b.type === 'tool_use' && b.id === toolUseId && typeof b.name === 'string') {
          return b.name as string
        }
      }
    }
  }
  return 'unknown'
}
