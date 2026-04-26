/**
 * autoDistill — 自动蒸馏管道
 *
 * 检测情景记忆中的重复模式，自动蒸馏为语义记忆（memdir）。
 * 触发条件：
 *   1. 用户连续3次在不同会话中纠正同一类行为 → feedback 记忆
 *   2. 同一文件/模块被反复操作（>= 5次） → project 知识
 *   3. 重复的调试模式 → reference 记忆
 *
 * 蒸馏在会话结束时或 compact 后异步执行。
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../utils/debug.js'
import type { Episode } from '../services/episodicMemory/episodicMemory.js'

export interface DistillCandidate {
  type: 'feedback' | 'project' | 'reference'
  title: string
  content: string
  sourceEpisodes: string[] // episode IDs
  confidence: number       // 0-1
}

// 需要至少多少个相似事件才触发蒸馏
const MIN_PATTERN_COUNT = 3
// 蒸馏后的记忆文件名前缀
const DISTILL_PREFIX = 'distilled_'

/**
 * 从情景记忆中检测可蒸馏的模式
 */
export function detectDistillablePatterns(episodes: Episode[]): DistillCandidate[] {
  const candidates: DistillCandidate[] = []

  // 模式1: 重复的用户反馈/纠正
  const feedbackEpisodes = episodes.filter(e => e.type === 'user_feedback')
  const feedbackGroups = groupBySimilarity(feedbackEpisodes)
  for (const group of feedbackGroups) {
    if (group.length >= MIN_PATTERN_COUNT) {
      candidates.push({
        type: 'feedback',
        title: `User prefers: ${extractCommonTheme(group)}`,
        content: buildFeedbackContent(group),
        sourceEpisodes: group.map(e => e.id),
        confidence: Math.min(1, group.length / 5),
      })
    }
  }

  // 模式2: 频繁操作的文件/模块
  const fileChanges = episodes.filter(e => e.type === 'file_changed')
  const fileGroups = groupByFile(fileChanges)
  for (const [file, changes] of fileGroups) {
    if (changes.length >= 5) {
      candidates.push({
        type: 'project',
        title: `Frequently modified: ${path.basename(file)}`,
        content: buildFileKnowledge(file, changes),
        sourceEpisodes: changes.map(e => e.id),
        confidence: Math.min(1, changes.length / 10),
      })
    }
  }

  // 模式3: 重复的调试模式
  const errorEpisodes = episodes.filter(
    e => e.type === 'discovery' && e.tags.includes('error'),
  )
  const resolvedEpisodes = episodes.filter(e => e.type === 'error_resolved')
  if (errorEpisodes.length >= MIN_PATTERN_COUNT) {
    const debugPatterns = detectDebugPatterns(errorEpisodes, resolvedEpisodes)
    candidates.push(...debugPatterns)
  }

  return candidates
}

/**
 * 按内容相似度分组事件
 */
function groupBySimilarity(episodes: Episode[]): Episode[][] {
  if (episodes.length === 0) return []

  const groups: Episode[][] = []
  const used = new Set<string>()

  for (let i = 0; i < episodes.length; i++) {
    if (used.has(episodes[i].id)) continue

    const group = [episodes[i]]
    used.add(episodes[i].id)

    for (let j = i + 1; j < episodes.length; j++) {
      if (used.has(episodes[j].id)) continue
      if (isSimilar(episodes[i].content, episodes[j].content)) {
        group.push(episodes[j])
        used.add(episodes[j].id)
      }
    }

    groups.push(group)
  }

  return groups
}

/**
 * 简单的文本相似度检测（共享关键词比例）
 */
function isSimilar(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3))
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3))
  if (wordsA.size === 0 || wordsB.size === 0) return false

  const intersection = [...wordsA].filter(w => wordsB.has(w))
  const overlap = intersection.length / Math.min(wordsA.size, wordsB.size)
  return overlap > 0.3
}

/**
 * 按文件路径分组
 */
function groupByFile(episodes: Episode[]): Map<string, Episode[]> {
  const groups = new Map<string, Episode[]>()
  for (const ep of episodes) {
    for (const file of ep.context.files) {
      if (!groups.has(file)) groups.set(file, [])
      groups.get(file)!.push(ep)
    }
  }
  return groups
}

/**
 * 提取一组相似事件的共同主题
 */
function extractCommonTheme(episodes: Episode[]): string {
  // 取第一个事件的标题作为主题（简化实现）
  return episodes[0].title.slice(0, 100)
}

/**
 * 构建反馈类记忆内容
 */
function buildFeedbackContent(episodes: Episode[]): string {
  const lines = [
    `User has consistently provided this feedback across ${episodes.length} instances:`,
    '',
  ]
  // 取最近3个实例
  const recent = episodes.slice(-3)
  for (const ep of recent) {
    lines.push(`- ${ep.content.slice(0, 200)}`)
  }
  lines.push('')
  lines.push(`**Why:** Repeated correction pattern detected from episodic memory.`)
  lines.push(`**How to apply:** Follow this preference in future interactions.`)
  return lines.join('\n')
}

/**
 * 构建文件知识记忆内容
 */
function buildFileKnowledge(file: string, episodes: Episode[]): string {
  const tools = [...new Set(episodes.flatMap(e => e.context.tools))]
  return [
    `File \`${file}\` has been modified ${episodes.length} times.`,
    `Common operations: ${tools.join(', ')}`,
    `Last modified: ${new Date(episodes[episodes.length - 1].timestamp).toISOString().slice(0, 10)}`,
    '',
    `**Why:** High-frequency modification target detected from episodic memory.`,
    `**How to apply:** This file is likely relevant when working on related features.`,
  ].join('\n')
}

/**
 * 检测调试模式
 */
function detectDebugPatterns(
  errors: Episode[],
  resolved: Episode[],
): DistillCandidate[] {
  const candidates: DistillCandidate[] = []

  // 检测重复的错误类型
  const errorKeywords = new Map<string, Episode[]>()
  for (const ep of errors) {
    const keywords = ep.content.toLowerCase().match(/\b(error|exception|fail|timeout|null|undefined)\b/g)
    if (keywords) {
      for (const kw of keywords) {
        if (!errorKeywords.has(kw)) errorKeywords.set(kw, [])
        errorKeywords.get(kw)!.push(ep)
      }
    }
  }

  for (const [keyword, eps] of errorKeywords) {
    if (eps.length >= MIN_PATTERN_COUNT) {
      candidates.push({
        type: 'reference',
        title: `Common ${keyword} pattern`,
        content: [
          `Recurring "${keyword}" errors detected (${eps.length} occurrences).`,
          `Common contexts: ${[...new Set(eps.flatMap(e => e.context.files))].slice(0, 5).join(', ')}`,
          '',
          `**Why:** Repeated error pattern detected from episodic memory.`,
          `**How to apply:** Check for this pattern when debugging similar issues.`,
        ].join('\n'),
        sourceEpisodes: eps.map(e => e.id),
        confidence: Math.min(1, eps.length / 5),
      })
    }
  }

  return candidates
}

/**
 * 将蒸馏结果写入 memdir 记忆文件
 */
export async function writeDistilledMemory(
  memoryDir: string,
  candidate: DistillCandidate,
): Promise<string | null> {
  const sanitizedTitle = candidate.title
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()
    .slice(0, 50)

  const filename = `${DISTILL_PREFIX}${sanitizedTitle}.md`
  const filepath = path.join(memoryDir, filename)

  // 检查是否已存在
  try {
    await fs.promises.access(filepath)
    logForDebugging(`[autoDistill] memory already exists: ${filename}`)
    return null // 已存在，跳过
  } catch { /* 不存在，继续 */ }

  const content = [
    '---',
    `name: ${candidate.title}`,
    `description: Auto-distilled from ${candidate.sourceEpisodes.length} episodic events`,
    `type: ${candidate.type}`,
    '---',
    '',
    candidate.content,
  ].join('\n')

  try {
    await fs.promises.writeFile(filepath, content, 'utf-8')
    logForDebugging(`[autoDistill] created memory: ${filename} (confidence: ${candidate.confidence.toFixed(2)})`)
    return filename
  } catch (e) {
    logForDebugging(`[autoDistill] write failed: ${(e as Error).message}`)
    return null
  }
}

/**
 * 执行完整的蒸馏流程
 */
export async function runDistillation(
  memoryDir: string,
  episodes: Episode[],
): Promise<string[]> {
  const candidates = detectDistillablePatterns(episodes)

  // 只蒸馏高置信度的候选
  const highConfidence = candidates.filter(c => c.confidence >= 0.5)
  if (highConfidence.length === 0) return []

  logForDebugging(
    `[autoDistill] found ${highConfidence.length} distillable patterns from ${episodes.length} episodes`,
  )

  const written: string[] = []
  for (const candidate of highConfidence) {
    const filename = await writeDistilledMemory(memoryDir, candidate)
    if (filename) written.push(filename)
  }

  return written
}
