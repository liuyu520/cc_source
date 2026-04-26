/**
 * G6 Step 1 (2026-04-26) —— /skill-candidates 只读命令。
 *
 * 展示 procedural candidates 中符合更严格 "skill-worthy" 阈值的条目,
 * 按 score = successRate * log(support+1) * confidence 降序排列。
 *
 * 阈值可调(flags),默认 minSupport=6 / minRate=0.9 / minConf=0.6 / limit=20。
 *
 * 纯只读:不 promote、不写 skill 目录、不改 candidate 文件。
 * 数据源:listRecentProceduralCandidates → findSkillWorthyCandidates。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /skill-candidates                       show skill-worthy candidates (defaults)
  /skill-candidates --min-support N       support >= N  (1..1000, default 6)
  /skill-candidates --min-rate R          successRate >= R (0..1, default 0.9)
  /skill-candidates --min-conf C          confidence >= C (0..1, default 0.6)
  /skill-candidates --limit N             cap output rows (1..200, default 20)
  /skill-candidates --json                emit JSON
  /skill-candidates --help                this message
`

interface ParsedFlags {
  minSupport: number
  minRate: number
  minConf: number
  limit: number
  json: boolean
  help: boolean
  error?: string
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  let minSupport = 6
  let minRate = 0.9
  let minConf = 0.6
  let limit = 20
  let json = false
  let help = false

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      help = true
      continue
    }
    if (t === '--json') {
      json = true
      continue
    }
    if (t === '--min-support') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 1000) {
        return {
          minSupport,
          minRate,
          minConf,
          limit,
          json,
          help,
          error: `--min-support must be 1..1000\n${USAGE}`,
        }
      }
      minSupport = n
      continue
    }
    if (t === '--min-rate') {
      const next = tokens[++i]
      const n = next ? parseFloat(next) : NaN
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return {
          minSupport,
          minRate,
          minConf,
          limit,
          json,
          help,
          error: `--min-rate must be 0..1\n${USAGE}`,
        }
      }
      minRate = n
      continue
    }
    if (t === '--min-conf') {
      const next = tokens[++i]
      const n = next ? parseFloat(next) : NaN
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return {
          minSupport,
          minRate,
          minConf,
          limit,
          json,
          help,
          error: `--min-conf must be 0..1\n${USAGE}`,
        }
      }
      minConf = n
      continue
    }
    if (t === '--limit') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return {
          minSupport,
          minRate,
          minConf,
          limit,
          json,
          help,
          error: `--limit must be 1..200\n${USAGE}`,
        }
      }
      limit = n
      continue
    }
    return {
      minSupport,
      minRate,
      minConf,
      limit,
      json,
      help,
      error: `unknown flag: ${t}\n${USAGE}`,
    }
  }
  return { minSupport, minRate, minConf, limit, json, help }
}

function call(args: string): LocalCommandCall {
  const parsed = parseFlags(args)
  if (parsed.help) return { type: 'text', value: USAGE }
  if (parsed.error) return { type: 'text', value: parsed.error }

  const { findSkillWorthyCandidates } = require(
    '../../services/proceduralMemory/skillCandidateMiner.js',
  ) as typeof import('../../services/proceduralMemory/skillCandidateMiner.js')

  const rows = findSkillWorthyCandidates({
    minSupport: parsed.minSupport,
    minSuccessRate: parsed.minRate,
    minConfidence: parsed.minConf,
    limit: parsed.limit,
  })

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          thresholds: {
            minSupport: parsed.minSupport,
            minSuccessRate: parsed.minRate,
            minConfidence: parsed.minConf,
          },
          total: rows.length,
          candidates: rows,
        },
        null,
        2,
      ),
    }
  }

  const lines: string[] = []
  lines.push(
    `skill-candidates (support>=${parsed.minSupport} rate>=${parsed.minRate} conf>=${parsed.minConf})`,
  )
  if (rows.length === 0) {
    lines.push('(no skill-worthy candidates — thresholds too tight or dir empty)')
  } else {
    lines.push('score    sup  rate  conf  name                                  description')
    for (const r of rows) {
      const score = r.score.toFixed(4).padStart(7)
      const sup = String(r.support).padStart(3)
      const rate = r.successRate.toFixed(2).padStart(4)
      const conf = r.confidence.toFixed(2).padStart(4)
      const name = (r.name || '').padEnd(36).slice(0, 36)
      const desc = (r.description || '').slice(0, 60)
      lines.push(`${score}  ${sup}  ${rate}  ${conf}  ${name}  ${desc}`)
    }
  }
  lines.push('')
  lines.push(
    'Note: read-only — no auto-promote. See docs §G6 for planned Step 2 (reuse-rate closure).',
  )
  return { type: 'text', value: lines.join('\n') }
}

const skillCandidates = {
  type: 'local',
  name: 'skill-candidates',
  description:
    'G6 observation: list procedural candidates meeting skill-worthy thresholds.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default skillCandidates
