/**
 * /evolve-kin <subcommand>
 *
 * autoEvolve(v1.0) — Phase 31:跨 organism 知识迁移(kinship index)
 *
 * 背景:Phase 30 之前每个 organism 的提案都是"独生子",完全看不到已经存活
 * 下来的近亲;Phase 31 用 token-Jaccard 在 stable/ 上做粗粒度相似度检索,
 * 让提案可以"借"一段已验证的 body 当起点。
 *
 * 子命令(互斥):
 *   /evolve-kin --match "<proposal text>" [--top N] [--min-sim F] [--no-body]
 *       只查 top-K 近亲、不改任何文件,返回相似度 + 身份信息 + preview。
 *   /evolve-kin --seed "<proposal text>" [--top N] [--min-sim F] [--no-body]
 *       先查 top1 近亲,再回带一段"kin-seeded body"(含 HTML 注释头,审计友好)。
 *
 * 安全:
 *   纯只读;不依赖 CLAUDE_EVOLVE_ARENA;不 mutate stable/;stable/ 空时返回 reason。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-kin --match "<proposal text>" [--top N] [--min-sim F] [--no-body]
      查 token-Jaccard 下与 proposal 最相似的 stable organisms(read-only)。

  /evolve-kin --seed "<proposal text>" [--top N] [--min-sim F] [--no-body]
      在 --match 基础上,额外把 top1 近亲的 primary body 作为 kin-seeded
      body 返回(附 <!-- kin-seeded ... --> 注释头,方便下游审计)。

  可选 flag:
    --top N          返回前 N 个近亲(默认 5,范围 1..50)
    --min-sim F      最低相似度阈值(默认 0.1,范围 0..1)
    --no-body        只看 manifest 的 name/rationale/winCondition,不纳入 primary body

  恰好需要一个 mode flag (--match / --seed)。`

type Mode = 'match' | 'seed' | null

interface ParsedFlags {
  mode: Mode
  // --match / --seed 后可能出现"带空格的提案文本",所以我们把后续非 flag token 拼起来
  texts: string[]
  topK?: number
  minSim?: number
  // 默认 true,--no-body 时置 false
  includeBody: boolean
  error: string | null
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().match(/"[^"]*"|\S+/g) ?? []
  const out: ParsedFlags = {
    mode: null,
    texts: [],
    includeBody: true,
    error: null,
  }

  function stripQuotes(s: string): string {
    return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--match':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --match`
          return out
        }
        out.mode = 'match'
        break
      case '--seed':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --seed`
          return out
        }
        out.mode = 'seed'
        break
      case '--top': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--top requires a positive integer'
          return out
        }
        const n = Number.parseInt(stripQuotes(next), 10)
        if (!Number.isFinite(n) || n < 1 || n > 50) {
          out.error = `--top must be 1..50 (got "${next}")`
          return out
        }
        out.topK = n
        i++
        break
      }
      case '--min-sim': {
        const next = tokens[i + 1]
        if (!next || next.startsWith('--')) {
          out.error = '--min-sim requires a number in [0, 1]'
          return out
        }
        const f = Number.parseFloat(stripQuotes(next))
        if (!Number.isFinite(f) || f < 0 || f > 1) {
          out.error = `--min-sim must be in [0, 1] (got "${next}")`
          return out
        }
        out.minSim = f
        i++
        break
      }
      case '--no-body':
        out.includeBody = false
        break
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        if (t.startsWith('--')) {
          out.error = `Unknown flag "${t}"\n\n${USAGE}`
          return out
        }
        out.texts.push(stripQuotes(t))
    }
  }

  if (!out.mode) {
    out.error = `no mode specified\n\n${USAGE}`
  }
  return out
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const kinMod = await import(
    '../../services/autoEvolve/arena/kinshipIndex.js'
  )

  const proposalText = parsed.texts.join(' ').trim()
  if (proposalText.length === 0) {
    return {
      type: 'text',
      value: `--${parsed.mode} requires a non-empty proposal text\n\n${USAGE}`,
    }
  }

  const opts = {
    topK: parsed.topK,
    minSimilarity: parsed.minSim,
    includeManifestBody: parsed.includeBody,
  }

  // ── --match ───────────────────────────────────────────
  if (parsed.mode === 'match') {
    const result = kinMod.findKinStableOrganisms(proposalText, opts)
    const lines: string[] = []
    lines.push(`## autoEvolve Kinship — match (Phase 31)`)
    lines.push('')
    lines.push(`scanned stable organisms: ${result.scanned}`)
    lines.push(
      `filter: topK=${opts.topK ?? 5}, minSim=${opts.minSim ?? 0.1}, includeBody=${opts.includeManifestBody ?? true}`,
    )
    if (result.reason) lines.push(`reason: ${result.reason}`)
    lines.push('')
    if (result.matches.length === 0) {
      lines.push('(no kin matches)')
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'#'.padStart(2)}  ${'stableId'.padEnd(32)}  ${'sim'.padStart(6)}  name`,
    )
    lines.push(
      '  ' + '-'.repeat(2) + '  ' + '-'.repeat(32) + '  ' + '-'.repeat(6) + '  ' + '-'.repeat(40),
    )
    result.matches.forEach((m, idx) => {
      lines.push(
        `  ${String(idx + 1).padStart(2)}  ${m.stableId.padEnd(32)}  ${m.similarity.toFixed(3).padStart(6)}  ${m.name}`,
      )
      if (m.rationalePreview) {
        lines.push(`      rationale: ${m.rationalePreview}`)
      }
      if (m.bodyFilename) {
        lines.push(
          `      body: ${m.bodyFilename} — ${m.bodyPreview ?? ''}`,
        )
      }
    })
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --seed ────────────────────────────────────────────
  if (parsed.mode === 'seed') {
    const result = kinMod.suggestSeedBody(proposalText, opts)
    const lines: string[] = []
    lines.push(`## autoEvolve Kinship — seed (Phase 31)`)
    lines.push('')
    lines.push(`strategy: ${result.strategy}`)
    lines.push(`reason:   ${result.reason}`)
    if (result.chosenKin) {
      lines.push(
        `chosen:   stableId=${result.chosenKin.stableId} similarity=${result.chosenKin.similarity.toFixed(3)} name="${result.chosenKin.name}"`,
      )
      if (result.chosenKin.bodyPath) {
        lines.push(`bodyPath: ${result.chosenKin.bodyPath}`)
      }
    }
    lines.push('')
    if (result.seedBody.length === 0) {
      lines.push('(seedBody is empty — caller should fall back to a blank template)')
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push('--- BEGIN seedBody ---')
    // 太大的 body 截前 2000 字符(命令行预览即可;真正下游消费者直接调 suggestSeedBody)
    const maxPreview = 2000
    if (result.seedBody.length > maxPreview) {
      lines.push(result.seedBody.slice(0, maxPreview))
      lines.push(
        `... (truncated: seedBody total ${result.seedBody.length} chars)`,
      )
    } else {
      lines.push(result.seedBody)
    }
    lines.push('--- END seedBody ---')
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: USAGE }
}

const evolveKin = {
  type: 'local',
  name: 'evolve-kin',
  description:
    'Phase 31 kinship index across stable organisms. --match returns token-Jaccard nearest stable organisms; --seed returns a kin-seeded body (top1 primary body with audit header). Read-only; independent of CLAUDE_EVOLVE_ARENA.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveKin
