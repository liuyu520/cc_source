/**
 * skillUsageTracker — 技能使用频率追踪
 *
 * 记录每个技能的调用次数、成功率和平均完成时间。
 * 基于统计数据优化技能的加载优先级：
 *   - 高频技能在 POST_COMPACT 时优先重注入
 *   - 从未使用的技能降低发现排名权重
 *
 * 存储: ~/.claude/skill_usage_stats.json
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../utils/debug.js'

export interface SkillUsageRecord {
  skillName: string
  invokeCount: number
  lastInvoked: number
  totalDurationMs: number
  successCount: number
  failureCount: number
}

export interface SkillUsageStats {
  version: number
  records: Record<string, SkillUsageRecord>
  updatedAt: number
}

const STATS_VERSION = 1
const STATS_FILENAME = 'skill_usage_stats.json'

// 内存缓存
let _cachedStats: SkillUsageStats | null = null
let _statsDir: string | null = null

function getStatsPath(): string {
  if (!_statsDir) {
    _statsDir = path.join(process.env.HOME || '~', '.claude')
  }
  return path.join(_statsDir, STATS_FILENAME)
}

/**
 * 同步获取内存缓存的统计数据（零 IO），缓存冷时返回 null
 */
export function getCachedUsageStats(): SkillUsageStats | null {
  return _cachedStats
}

/**
 * 同步加载使用统计（用于 createSkillAttachmentIfNeeded 等同步调用链）
 * 优先返回内存缓存，冷缓存时用 readFileSync 回退
 */
export function loadUsageStatsSync(): SkillUsageStats {
  if (_cachedStats) return _cachedStats

  const statsPath = getStatsPath()
  try {
    const data = fs.readFileSync(statsPath, 'utf-8')
    _cachedStats = JSON.parse(data) as SkillUsageStats
    if (_cachedStats!.version !== STATS_VERSION) {
      _cachedStats = { version: STATS_VERSION, records: {}, updatedAt: Date.now() }
    }
  } catch {
    _cachedStats = { version: STATS_VERSION, records: {}, updatedAt: Date.now() }
  }

  return _cachedStats!
}

/**
 * 加载使用统计
 */
export async function loadUsageStats(): Promise<SkillUsageStats> {
  if (_cachedStats) return _cachedStats

  const statsPath = getStatsPath()
  try {
    const data = await fs.promises.readFile(statsPath, 'utf-8')
    _cachedStats = JSON.parse(data) as SkillUsageStats
    if (_cachedStats!.version !== STATS_VERSION) {
      _cachedStats = { version: STATS_VERSION, records: {}, updatedAt: Date.now() }
    }
  } catch {
    _cachedStats = { version: STATS_VERSION, records: {}, updatedAt: Date.now() }
  }

  return _cachedStats!
}

/**
 * 持久化统计到磁盘
 */
async function saveUsageStats(stats: SkillUsageStats): Promise<void> {
  const statsPath = getStatsPath()
  try {
    stats.updatedAt = Date.now()
    await fs.promises.writeFile(statsPath, JSON.stringify(stats, null, 2), 'utf-8')
  } catch (e) {
    logForDebugging(`[skillUsageTracker] save failed: ${(e as Error).message}`)
  }
}

/**
 * 记录一次技能调用
 */
export async function recordSkillInvocation(
  skillName: string,
  durationMs: number,
  success: boolean,
): Promise<void> {
  const stats = await loadUsageStats()

  if (!stats.records[skillName]) {
    stats.records[skillName] = {
      skillName,
      invokeCount: 0,
      lastInvoked: 0,
      totalDurationMs: 0,
      successCount: 0,
      failureCount: 0,
    }
  }

  const record = stats.records[skillName]
  record.invokeCount++
  record.lastInvoked = Date.now()
  record.totalDurationMs += durationMs
  if (success) {
    record.successCount++
  } else {
    record.failureCount++
  }

  // 异步保存，不阻塞
  saveUsageStats(stats).catch(() => {})
}

/**
 * 获取技能的使用频率分数 (0-1)
 * 用于排序技能加载优先级
 */
export function getSkillFrequencyScore(
  skillName: string,
  stats: SkillUsageStats,
): number {
  const record = stats.records[skillName]
  if (!record) return 0

  const daysSinceLastUse = (Date.now() - record.lastInvoked) / (24 * 60 * 60 * 1000)

  // 因素1: 调用次数（对数增长，避免过度偏重）
  const countScore = Math.min(1, Math.log2(1 + record.invokeCount) / 5)

  // 因素2: 最近使用时间（7天内衰减）
  const recencyScore = Math.max(0, 1 - daysSinceLastUse / 7)

  // 因素3: 成功率
  const totalAttempts = record.successCount + record.failureCount
  const successRate = totalAttempts > 0 ? record.successCount / totalAttempts : 0.5

  // 加权组合
  return countScore * 0.4 + recencyScore * 0.4 + successRate * 0.2
}

/**
 * 获取排序后的技能列表（高频优先）
 */
export async function getSkillPriorityOrder(
  availableSkills: string[],
): Promise<string[]> {
  const stats = await loadUsageStats()

  return [...availableSkills].sort((a, b) => {
    const scoreA = getSkillFrequencyScore(a, stats)
    const scoreB = getSkillFrequencyScore(b, stats)
    return scoreB - scoreA // 降序
  })
}

/**
 * 判断技能是否为高频技能（最近7天内调用 >= 3次）
 */
export function isHighFrequencySkill(
  skillName: string,
  stats: SkillUsageStats,
): boolean {
  const record = stats.records[skillName]
  if (!record) return false

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  return record.lastInvoked > sevenDaysAgo && record.invokeCount >= 3
}

/**
 * 获取使用统计摘要（用于调试）
 */
export async function getUsageSummary(): Promise<string> {
  const stats = await loadUsageStats()
  const records = Object.values(stats.records)
    .sort((a, b) => b.invokeCount - a.invokeCount)
    .slice(0, 10)

  if (records.length === 0) return 'No skill usage recorded yet.'

  return records.map(r => {
    const avgDuration = r.invokeCount > 0
      ? Math.round(r.totalDurationMs / r.invokeCount)
      : 0
    const successRate = (r.successCount + r.failureCount) > 0
      ? Math.round(r.successCount / (r.successCount + r.failureCount) * 100)
      : 0
    return `${r.skillName}: ${r.invokeCount} calls, ${successRate}% success, avg ${avgDuration}ms`
  }).join('\n')
}

/**
 * 重置缓存（用于测试）
 */
export function resetCache(): void {
  _cachedStats = null
}
