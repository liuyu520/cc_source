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
  /skill-candidates --emit [--apply] [--top N]
                                          G6 Step 3: turn qualifying candidates
                                          into shadow organism proposals
                                          (default dry-run prints mapped
                                          PatternCandidate[]);
                                          --apply needs env
                                          CLAUDE_SKILL_CANDIDATE_EMIT=on and
                                          compiles top N (1..50, default 3) to
                                          genome/shadow/.
  /skill-candidates --help                this message
`

interface ParsedFlags {
  minSupport: number
  minRate: number
  minConf: number
  limit: number
  json: boolean
  help: boolean
  emit: boolean
  apply: boolean
  top: number
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
  let emit = false
  let apply = false
  let top = 3

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
          emit,
          apply,
          top,
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
          emit,
          apply,
          top,
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
          emit,
          apply,
          top,
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
          emit,
          apply,
          top,
          error: `--limit must be 1..200\n${USAGE}`,
        }
      }
      limit = n
      continue
    }
    if (t === '--emit') {
      emit = true
      continue
    }
    if (t === '--apply') {
      apply = true
      continue
    }
    if (t === '--top') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        return {
          minSupport,
          minRate,
          minConf,
          limit,
          json,
          help,
          emit,
          apply,
          top,
          error: `--top must be 1..50\n${USAGE}`,
        }
      }
      top = n
      continue
    }
    return {
      minSupport,
      minRate,
      minConf,
      limit,
      json,
      help,
      emit,
      apply,
      top,
      error: `unknown flag: ${t}\n${USAGE}`,
    }
  }
  return { minSupport, minRate, minConf, limit, json, help, emit, apply, top }
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

  // ── G6 Step 3(2026-04-26)· shadow 自动接管的显式入口 ────────────
  //
  //   /skill-candidates --emit              dry-run,列出 mapped PatternCandidate[]
  //   /skill-candidates --emit --apply      真正 compile 到 genome/shadow
  //
  //   双闸门:
  //     1. --apply 必须显式输入(缺省就是 dry-run)
  //     2. 环境变量 CLAUDE_SKILL_CANDIDATE_EMIT 必须为 on/1/true/yes
  //        (避免 CI/自动化脚本里误跑)
  //
  //   未通过 --emit 时,该段不输出任何内容,维持原 Step 2 读-only 行为。
  if (parsed.emit) {
    lines.push('')
    lines.push(`--- emit (top ${parsed.top}) ---`)
    if (rows.length === 0) {
      lines.push('(no eligible candidates — nothing to emit)')
      return { type: 'text', value: lines.join('\n') }
    }
    const { buildSkillProposalsFromCandidates } = require(
      '../../services/proceduralMemory/skillCandidateMiner.js',
    ) as typeof import('../../services/proceduralMemory/skillCandidateMiner.js')
    const proposals = buildSkillProposalsFromCandidates(
      rows.slice(0, parsed.top),
    )
    lines.push(`prepared ${proposals.length} proposal(s):`)
    for (const p of proposals) {
      lines.push(
        `  [${p.id}] kind=${p.suggestedRemediation.kind} name=${p.suggestedRemediation.nameSuggestion}`,
      )
    }

    const envRaw = (process.env.CLAUDE_SKILL_CANDIDATE_EMIT ?? '')
      .trim()
      .toLowerCase()
    const envOn = envRaw === 'on' || envRaw === '1' || envRaw === 'true' || envRaw === 'yes'
    if (!parsed.apply) {
      lines.push('')
      lines.push('dry-run — pass --apply and set CLAUDE_SKILL_CANDIDATE_EMIT=on to compile.')
      return { type: 'text', value: lines.join('\n') }
    }
    if (!envOn) {
      lines.push('')
      lines.push(
        '--apply refused: CLAUDE_SKILL_CANDIDATE_EMIT is not on (set to on/1/true/yes).',
      )
      return { type: 'text', value: lines.join('\n') }
    }
    try {
      const { compileCandidates } = require(
        '../../services/autoEvolve/emergence/skillCompiler.js',
      ) as typeof import('../../services/autoEvolve/emergence/skillCompiler.js')
      // overwrite:false —— 重复 emit 不覆盖已有 shadow,交给 Promotion FSM 演化
      const results = compileCandidates(proposals, { overwrite: false })
      lines.push('')
      lines.push(`compiled ${results.length} shadow organism(s):`)
      for (const r of results) {
        lines.push(
          `  [${r.manifest.id}] status=${r.manifest.status} kind=${r.manifest.kind} name=${r.manifest.name}\n     manifest=${r.manifestPath}`,
        )
      }
    } catch (e) {
      lines.push('')
      lines.push(`compile failed: ${(e as Error).message}`)
    }
  }

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
