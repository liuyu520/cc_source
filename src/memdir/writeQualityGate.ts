// src/memdir/writeQualityGate.ts
// 记忆写入质量门控：检测写入的记忆文件是否有质量问题
// 检测通过 PostToolUse(Write) 触发，以 system-reminder 软提醒方式反馈

import { basename } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { findSimilarMemories, type VectorCache } from './vectorIndex.js'
import { MEMORY_TYPES } from './memoryTypes.js'

/**
 * 质量检查结果
 */
export type QualityIssue = {
  severity: 'warning' | 'info'
  message: string
}

/**
 * 反模式正则：不适合存入记忆的内容
 */
const ANTI_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /```[\s\S]{50,}```/,
    message: '正文含有较长的代码块，这类信息可从代码库直接获取，不适合存入记忆',
  },
  {
    pattern: /\b[a-f0-9]{7,40}\b/i,
    message: '正文含有 git hash，这类信息可从 git log 获取',
  },
  {
    pattern: /(?:\/[\w.-]+){3,}\.(?:ts|js|py|go|rs|java|tsx|jsx)\b/,
    message: '正文含有源代码文件路径，这类信息可从代码库直接获取',
  },
  {
    pattern: /(?:npm|pip|bun|cargo|yarn|pnpm)\s+install\b/,
    message: '正文含有包安装命令，这类信息可从 package.json 等配置文件获取',
  },
]

// 有效的记忆类型
const VALID_TYPES = new Set(MEMORY_TYPES)

// 正文最大字数建议
const MAX_BODY_LENGTH = 500

/**
 * 检查记忆文件的写入质量
 * @param content 写入的文件完整内容
 * @param filename 文件名（相对路径）
 * @param vectorCache 向量缓存（用于重复检测）
 * @returns 质量问题列表，空列表表示通过
 */
export function checkMemoryQuality(
  content: string,
  filename: string,
  vectorCache?: VectorCache,
): QualityIssue[] {
  const issues: QualityIssue[] = []

  // 解析 frontmatter
  const { frontmatter, content: body } = parseFrontmatter(content, filename)

  // 检查1：frontmatter 结构完整性
  if (!frontmatter.name) {
    issues.push({
      severity: 'warning',
      message: '缺少 frontmatter name 字段，请补充以确保索引准确性',
    })
  }
  if (!frontmatter.description) {
    issues.push({
      severity: 'warning',
      message: '缺少 frontmatter description 字段，这是召回时判断相关性的关键',
    })
  }

  // 检查2：类型校验
  if (frontmatter.type && !VALID_TYPES.has(frontmatter.type)) {
    issues.push({
      severity: 'warning',
      message: `frontmatter type "${frontmatter.type}" 无效，必须为 ${[...VALID_TYPES].join('/')} 之一`,
    })
  }
  if (!frontmatter.type) {
    issues.push({
      severity: 'info',
      message: '缺少 frontmatter type 字段，建议补充以支持分类管理',
    })
  }

  // 检查3：反模式检测
  for (const { pattern, message } of ANTI_PATTERNS) {
    if (pattern.test(body)) {
      issues.push({ severity: 'info', message })
    }
  }

  // 检查4：长度检测
  if (body.length > MAX_BODY_LENGTH) {
    issues.push({
      severity: 'info',
      message: `正文超过 ${MAX_BODY_LENGTH} 字（当前 ${body.length} 字），建议精简到关键信息`,
    })
  }

  // 检查5：重复检测（需要向量缓存）
  if (vectorCache) {
    const similar = findSimilarMemories(
      content,
      vectorCache,
      0.85,
      filename,
    )
    if (similar.length > 0) {
      const top = similar[0]!
      issues.push({
        severity: 'warning',
        message: `与现有记忆 "${top.filename}" 相似度 ${top.similarity.toFixed(2)}，建议更新该文件而非新建`,
      })
    }
  }

  return issues
}

/**
 * 检查是否有关联建议（相似度 0.7~0.85 的文件）
 * 用于自动建立 related 关联
 */
export function findRelatedSuggestions(
  content: string,
  filename: string,
  vectorCache: VectorCache,
): string[] {
  // 找 0.5~0.85 相似度的文件（不完全重复但有关联）
  const similar = findSimilarMemories(content, vectorCache, 0.5, filename)
  return similar
    .filter(s => s.similarity < 0.85)
    .slice(0, 3)
    .map(s => s.filename)
}

/**
 * 格式化质量问题为 system-reminder 文本
 */
export function formatQualityReminder(
  filename: string,
  issues: QualityIssue[],
): string {
  if (issues.length === 0) return ''

  const issueLines = issues
    .map(i => `- ${i.message}`)
    .join('\n')

  return `[Memory Quality Notice] 刚写入的记忆文件 "${basename(filename)}" 存在以下问题:\n${issueLines}\n请检查并修正。`
}
