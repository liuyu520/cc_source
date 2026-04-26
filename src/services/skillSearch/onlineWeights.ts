/**
 * skillSearch Online Learning · Shadow 样本种子
 *
 * 目标:在 skill 被调用时,把 (skill, intent, context hash) 追加到本地
 * outcomes.ndjson,为未来的 logistic 权重学习积累样本种子。
 *
 * 当前 MVP 只做 "append-only 样本收集",不做:
 *   - 任何 "success/failure" 判定(缺乏可靠信号,需要独立设计)
 *   - 任何 weights.json 计算或写入
 *   - 任何 intentRouter 行为修改
 *
 * 存储位置:
 *   ${CLAUDE_CONFIG_HOME}/skillSearch/outcomes.ndjson
 *
 * 每行一条 JSON,schema:
 *   {
 *     ts: ISO8601,
 *     skill: string,            // skill 名
 *     intentClass: string|null, // classifyIntent 的 class(未知时 null)
 *     taskMode: string|null,    // classifyIntent 的 taskMode(未知时 null)
 *     contextHash: string,      // 简短上下文哈希(截短 8 字符)
 *     sessionId: string|null,
 *   }
 *
 * fail-open:所有异常静默吞掉,不影响 skill 调用主流程。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { isSkillLearnEnabled } from './onlineLearnFeatureCheck.js'

export interface SkillOutcomeSample {
  skill: string
  intentClass?: string | null
  taskMode?: string | null
  /** 触发当前 skill 的 query / 上下文(用于哈希,不落盘明文) */
  contextText?: string
  /** 可选,未提供时内部读 getSessionId() */
  sessionId?: string | null
}

/** outcomes 目录 */
function getOutcomesDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'skillSearch')
}

function getOutcomesFile(): string {
  return path.join(getOutcomesDir(), 'outcomes.ndjson')
}

function ensureOutcomesDir(): void {
  const dir = getOutcomesDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/** 取上下文的 8 字符 sha1 哈希,用于后期分组但不泄露明文 */
function hashContext(text: string): string {
  if (!text) return ''
  try {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8)
  } catch {
    return ''
  }
}

/**
 * 追加一条 skill 调用样本。shadow 模式与 on 模式都写;off 模式直接 no-op。
 * 不抛异常,失败静默吞掉。
 */
export function appendSkillOutcome(sample: SkillOutcomeSample): void {
  try {
    if (!isSkillLearnEnabled()) return
    ensureOutcomesDir()
    const entry = {
      ts: new Date().toISOString(),
      skill: sample.skill,
      intentClass: sample.intentClass ?? null,
      taskMode: sample.taskMode ?? null,
      contextHash: hashContext(sample.contextText ?? ''),
      sessionId: sample.sessionId ?? null,
    }
    fs.appendFileSync(getOutcomesFile(), JSON.stringify(entry) + '\n')
  } catch (err) {
    // fail-open
    logForDebugging(
      `[skillLearn] appendSkillOutcome failed: ${(err as Error).message}`,
    )
  }
}

/**
 * 读最近 N 条样本(默认 200),用于后续分析/权重学习 —— 目前 MVP 阶段
 * 只有此读取接口,消费端(autoDream micro / intentRouter 权重加载)留作后续。
 * fail-open:失败返回空数组。
 */
export function readRecentSkillOutcomes(limit = 200): Array<Record<string, unknown>> {
  try {
    const file = getOutcomesFile()
    if (!fs.existsSync(file)) return []
    const content = fs.readFileSync(file, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim().length > 0)
    const tail = lines.length > limit ? lines.slice(-limit) : lines
    const out: Array<Record<string, unknown>> = []
    for (const line of tail) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }
    return out
  } catch (err) {
    logForDebugging(
      `[skillLearn] readRecentSkillOutcomes failed: ${(err as Error).message}`,
    )
    return []
  }
}

export { getOutcomesFile as _getOutcomesFileForTesting }

// ──────────────────────────────────────────────────────────────
// 消费者闭环 · F 线:把 outcomes.ndjson 聚合成 top-skill 分布,供
// /memory-audit 等消费端在通用 byKind 之外看到"谁用得多"。
// 设计与其他消费者保持一致:
//   - samples=0 时 formatter 返回 null,消费端决定是否展示
//   - 异常统一 fail-open
// ──────────────────────────────────────────────────────────────

export interface SkillOutcomesSummary {
  total: number
  bySkill: Record<string, number>
  byIntentClass: Record<string, number>
  byTaskMode: Record<string, number>
  oldestTs: string | null
  newestTs: string | null
}

/**
 * 读最近 limit 条样本并聚合。
 * - file 不存在或为空 → total=0,其他字段空对象
 * - fail-open,异常返回空摘要
 */
export function getSkillOutcomesSummary(limit = 500): SkillOutcomesSummary {
  const empty: SkillOutcomesSummary = {
    total: 0,
    bySkill: {},
    byIntentClass: {},
    byTaskMode: {},
    oldestTs: null,
    newestTs: null,
  }
  try {
    const rows = readRecentSkillOutcomes(limit)
    if (rows.length === 0) return empty
    const bySkill: Record<string, number> = {}
    const byIntentClass: Record<string, number> = {}
    const byTaskMode: Record<string, number> = {}
    let oldestTs: string | null = null
    let newestTs: string | null = null
    for (const r of rows) {
      const skill = String(r.skill ?? 'unknown')
      bySkill[skill] = (bySkill[skill] ?? 0) + 1
      const ic = r.intentClass == null ? 'n/a' : String(r.intentClass)
      byIntentClass[ic] = (byIntentClass[ic] ?? 0) + 1
      const tm = r.taskMode == null ? 'n/a' : String(r.taskMode)
      byTaskMode[tm] = (byTaskMode[tm] ?? 0) + 1
      const ts = typeof r.ts === 'string' ? r.ts : null
      if (ts) {
        if (!oldestTs) oldestTs = ts
        newestTs = ts
      }
    }
    return {
      total: rows.length,
      bySkill,
      byIntentClass,
      byTaskMode,
      oldestTs,
      newestTs,
    }
  } catch (err) {
    logForDebugging(
      `[skillLearn] getSkillOutcomesSummary failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * 人类可读摘要,total=0 → null(消费端零回归)。
 * 默认只展示 top-5 skill + top-3 intentClass,避免刷屏。
 */
export function formatSkillOutcomesSummary(
  opts: { limit?: number; topSkills?: number; topIntents?: number } = {},
): string | null {
  const s = getSkillOutcomesSummary(opts.limit ?? 500)
  if (s.total === 0) return null
  const topN = Math.max(1, opts.topSkills ?? 5)
  const topInt = Math.max(1, opts.topIntents ?? 3)
  const rankSkill = Object.entries(s.bySkill)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k, c]) => `${k}×${c}`)
    .join(', ')
  const rankIntent = Object.entries(s.byIntentClass)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topInt)
    .map(([k, c]) => `${k}×${c}`)
    .join(', ')
  const lines = [
    `SkillSearch outcomes summary (window=${s.total}):`,
    `  top skills: ${rankSkill || '(none)'}`,
    `  top intentClass: ${rankIntent || '(none)'}`,
  ]
  if (s.newestTs) lines.push(`  window ts: ${s.oldestTs ?? '?'} → ${s.newestTs}`)
  return lines.join('\n')
}
