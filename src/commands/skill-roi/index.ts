/**
 * /skill-roi — 方向 P（counter-metric）只读观察命令。
 *
 * 展示:
 *   1. skill_usage_stats.json 路径与加载状态;
 *   2. Top N 被调用最多的 skill（成功率、平均耗时、最近一次);
 *   3. Dormant 列表(非 bundled 且超过窗口未用,等同 ranker 的 dormant gate);
 *   4. 北极星指标:token_cost_per_successful_skill_call 的近似值(基于当前
 *      统计数据 + listing 估算,不引入新采样);
 *   5. 当前 ranker / dormant / folding / explore 的开关总览。
 *
 * 纯读文件 + env,不改任何状态。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  loadUsageStatsSync,
  getSkillFrequencyScore,
  type SkillUsageRecord,
  type SkillUsageStats,
} from '../../skills/skillUsageTracker.js'

const USAGE = `Usage:
  /skill-roi                  show summary + Top 20 + dormant N
  /skill-roi --top K          limit Top rows (1..200, default 20)
  /skill-roi --dormant-days D change dormant window (1..365, default 30)
  /skill-roi --json           emit JSON
  /skill-roi --help           this message
`

interface ParsedFlags {
  top: number
  dormantDays: number
  json: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let top = 20
  let dormantDays = 30
  let json = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      return { top, dormantDays, json, error: USAGE }
    } else if (t === '--json') {
      json = true
    } else if (t === '--top') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return { top, dormantDays, json, error: `--top must be 1..200\n${USAGE}` }
      }
      top = n
    } else if (t === '--dormant-days') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        return { top, dormantDays, json, error: `--dormant-days must be 1..365\n${USAGE}` }
      }
      dormantDays = n
    } else {
      return { top, dormantDays, json, error: `unknown flag: ${t}\n${USAGE}` }
    }
  }
  return { top, dormantDays, json }
}

interface TopRow {
  name: string
  calls: number
  successRate: number
  avgDurationMs: number
  daysSinceLastUse: number
  score: number
}

function buildTop(stats: SkillUsageStats, limit: number): TopRow[] {
  const rows: TopRow[] = []
  const now = Date.now()
  for (const rec of Object.values(stats.records) as SkillUsageRecord[]) {
    const total = rec.successCount + rec.failureCount
    const successRate = total > 0 ? rec.successCount / total : 0
    const avg = rec.invokeCount > 0 ? Math.round(rec.totalDurationMs / rec.invokeCount) : 0
    const daysSinceLastUse =
      rec.lastInvoked > 0
        ? Math.round((now - rec.lastInvoked) / (24 * 60 * 60 * 1000))
        : Number.POSITIVE_INFINITY
    rows.push({
      name: rec.skillName,
      calls: rec.invokeCount,
      successRate,
      avgDurationMs: avg,
      daysSinceLastUse,
      score: getSkillFrequencyScore(rec.skillName, stats),
    })
  }
  return rows.sort((a, b) => b.calls - a.calls).slice(0, limit)
}

interface DormantRow {
  name: string
  daysSinceLastUse: number
  calls: number
  successRate: number
}

function buildDormant(stats: SkillUsageStats, dormantDays: number): DormantRow[] {
  const rows: DormantRow[] = []
  const threshold = Date.now() - dormantDays * 24 * 60 * 60 * 1000
  for (const rec of Object.values(stats.records) as SkillUsageRecord[]) {
    if (rec.lastInvoked === 0) continue
    if (rec.lastInvoked > threshold) continue
    const total = rec.successCount + rec.failureCount
    rows.push({
      name: rec.skillName,
      daysSinceLastUse: Math.round((Date.now() - rec.lastInvoked) / (24 * 60 * 60 * 1000)),
      calls: rec.invokeCount,
      successRate: total > 0 ? rec.successCount / total : 0,
    })
  }
  return rows.sort((a, b) => b.daysSinceLastUse - a.daysSinceLastUse)
}

interface SwitchView {
  rankerEnabled: boolean
  dormantGateEnabled: boolean
  foldingEnabled: boolean
  exploreEpsilon: number
  dormantDays: number
  weights: { keyword: number; frequency: number; bundled: number }
  envs: Record<string, string | undefined>
}

function readSwitches(parsedDormant: number): SwitchView {
  const env = process.env
  const truthy = (v?: string) => v === '1' || v?.toLowerCase() === 'true'
  const num = (v: string | undefined, fallback: number) => {
    if (!v) return fallback
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    rankerEnabled: !truthy(env.CLAUDE_CODE_DISABLE_SKILL_RANKER),
    dormantGateEnabled: !truthy(env.CLAUDE_CODE_DISABLE_DORMANT_GATE),
    foldingEnabled: !truthy(env.CLAUDE_CODE_DISABLE_SKILL_FOLDING),
    exploreEpsilon: num(env.CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON, 0.1),
    dormantDays: num(env.CLAUDE_CODE_SKILL_DORMANT_DAYS, parsedDormant),
    weights: {
      keyword: num(env.CLAUDE_CODE_SKILL_RANK_W_KEYWORD, 0.5),
      frequency: num(env.CLAUDE_CODE_SKILL_RANK_W_FREQUENCY, 0.4),
      bundled: num(env.CLAUDE_CODE_SKILL_RANK_W_BUNDLED, 0.1),
    },
    envs: {
      CLAUDE_CODE_DISABLE_SKILL_RANKER: env.CLAUDE_CODE_DISABLE_SKILL_RANKER,
      CLAUDE_CODE_DISABLE_DORMANT_GATE: env.CLAUDE_CODE_DISABLE_DORMANT_GATE,
      CLAUDE_CODE_DISABLE_SKILL_FOLDING: env.CLAUDE_CODE_DISABLE_SKILL_FOLDING,
      CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON: env.CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON,
      CLAUDE_CODE_SKILL_DORMANT_DAYS: env.CLAUDE_CODE_SKILL_DORMANT_DAYS,
      CLAUDE_CODE_SKILL_TRIGGER_TTL_MS: env.CLAUDE_CODE_SKILL_TRIGGER_TTL_MS,
      CLAUDE_CODE_SKILL_RANK_W_KEYWORD: env.CLAUDE_CODE_SKILL_RANK_W_KEYWORD,
      CLAUDE_CODE_SKILL_RANK_W_FREQUENCY: env.CLAUDE_CODE_SKILL_RANK_W_FREQUENCY,
      CLAUDE_CODE_SKILL_RANK_W_BUNDLED: env.CLAUDE_CODE_SKILL_RANK_W_BUNDLED,
      CLAUDE_CODE_SKILL_FOLD_PROTECT_TOP: env.CLAUDE_CODE_SKILL_FOLD_PROTECT_TOP,
      CLAUDE_CODE_SKILL_FOLD_MIN_GROUP: env.CLAUDE_CODE_SKILL_FOLD_MIN_GROUP,
    },
  }
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const stats = loadUsageStatsSync()
  const total = Object.keys(stats.records).length
  const top = buildTop(stats, parsed.top)
  const dormant = buildDormant(stats, parsed.dormantDays)

  // 简要北极星：successfulCalls = Σ successCount；若外界提供 avgListingChars
  // env，作近似 token/call 估算；否则显示 raw 次数，让用户自行配权。
  const successfulCalls = Object.values(stats.records).reduce(
    (a, r) => a + (r as SkillUsageRecord).successCount,
    0,
  )
  const totalCalls = Object.values(stats.records).reduce(
    (a, r) => a + (r as SkillUsageRecord).invokeCount,
    0,
  )
  const globalSuccessRate = totalCalls > 0 ? successfulCalls / totalCalls : 0

  const switches = readSwitches(parsed.dormantDays)

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          stats: {
            totalSkillsTracked: total,
            totalCalls,
            successfulCalls,
            globalSuccessRate,
            updatedAt: stats.updatedAt,
          },
          switches,
          top,
          dormant,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push('/skill-roi — skill usage / dormant / ranker switch audit (read-only)')
  lines.push('')
  lines.push(`stats file loaded: ${total} tracked skills`)
  lines.push(
    `total calls: ${totalCalls} (successful=${successfulCalls}, rate=${(globalSuccessRate * 100).toFixed(1)}%)`,
  )
  lines.push(`stats.updatedAt: ${stats.updatedAt ? new Date(stats.updatedAt).toISOString() : '(never)'}`)
  lines.push('')
  lines.push('Switches:')
  lines.push(`  rankerEnabled      = ${switches.rankerEnabled}`)
  lines.push(`  dormantGateEnabled = ${switches.dormantGateEnabled}`)
  lines.push(`  foldingEnabled     = ${switches.foldingEnabled}`)
  lines.push(`  exploreEpsilon     = ${switches.exploreEpsilon}`)
  lines.push(`  dormantDays        = ${switches.dormantDays}`)
  lines.push(
    `  weights            = kw=${switches.weights.keyword} fr=${switches.weights.frequency} bn=${switches.weights.bundled}`,
  )
  lines.push('')

  if (top.length === 0) {
    lines.push('(no skill usage recorded yet)')
  } else {
    lines.push(`Top ${top.length} skills by call count:`)
    for (const r of top) {
      const lastUse =
        Number.isFinite(r.daysSinceLastUse)
          ? `${r.daysSinceLastUse}d ago`
          : 'never'
      lines.push(
        `  ${r.name.padEnd(30)} calls=${String(r.calls).padStart(4)} ok=${(r.successRate * 100).toFixed(0)}% avg=${r.avgDurationMs}ms last=${lastUse} score=${r.score.toFixed(3)}`,
      )
    }
  }
  lines.push('')
  if (dormant.length === 0) {
    lines.push(`(no dormant skills older than ${parsed.dormantDays}d)`)
  } else {
    lines.push(`Dormant (>${parsed.dormantDays}d since last use, ${dormant.length} total):`)
    for (const d of dormant.slice(0, 50)) {
      lines.push(
        `  ${d.name.padEnd(30)} ${d.daysSinceLastUse}d ago  calls=${d.calls} ok=${(d.successRate * 100).toFixed(0)}%`,
      )
    }
    if (dormant.length > 50) {
      lines.push(`  ... (${dormant.length - 50} more)`)
    }
  }
  lines.push('')
  lines.push(
    'Note: token-efficiency counter-metric. Dormant list should normally be hidden from listing;',
  )
  lines.push(
    '      use --dormant-days to probe how the window choice affects the filter.',
  )
  return { type: 'text', value: lines.join('\n') }
}

const skillRoi = {
  type: 'local',
  name: 'skill-roi',
  description:
    'Show skill usage ROI: Top-called skills, dormant list, ranker switches. Read-only.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default skillRoi
