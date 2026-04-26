/**
 * /evolve-bench <subcommand> [options]
 *
 * autoEvolve(v1.0) — Phase 28:Oracle-level anti-Goodhart。
 *
 * 思路:Phase 22 的 goodhartGuard 在单个 organism 级别抓作弊(完美分 + 少
 * 试用 + 无 userConfirm);Phase 28 更上一层,防止 Oracle 自己被 metaEvolver
 * / thresholdTuner 调成偏科打分器。用户手工挑 canonical benchmark,每次
 * 权重切换后对这些 benchmark 重新打分,computeDrift 如果发现"多条 benchmark
 * 在不同 weightsVersion 下分数跳太多",就软门禁 /evolve-meta --apply。
 *
 * 子命令(互斥,每次只选一个):
 *   /evolve-bench --list
 *       → 打印当前 benchmarks.json 里所有条目
 *   /evolve-bench --add <id> --desc "..." [--criteria "..."]
 *       → 追加一条 benchmark 定义(id 冲突则覆盖描述,createdAt 保留原值)
 *   /evolve-bench --record --id <benchmarkId> --score <n> [--organism <id>]
 *                 [--weights-version <str>]
 *       → 人工记录一次 benchmark 打分。weights-version 缺省从
 *         loadOracleWeights().version 读取,打分瞬间的 Oracle 状态即 key
 *   /evolve-bench --drift [--threshold 0.3] [--min-benchmarks 3]
 *                 [--window 500]
 *       → 立即计算 drift 报告,打印所有两两对比行 + suspicious 标记
 *
 * 安全:
 *   --list / --drift 永远只读
 *   --add 不动老字段,只合并(benchmarks.json 是 user-editable,保守兼容)
 *   --record 追加 benchmark-runs.ndjson(Phase 12 轮换),不触发 fitness 聚合
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-bench --list
      list all canonical benchmarks

  /evolve-bench --add <id> --desc "..." [--criteria "..."]
      add (or overwrite-description) a benchmark entry

  /evolve-bench --record --id <benchmarkId> --score <n>
                [--organism <id>] [--weights-version <str>]
      record one benchmark run (score is the FitnessScore total, not a dim)

  /evolve-bench --drift [--threshold 0.3] [--min-benchmarks 3] [--window 500]
      compute the inter-oracleWeightsVersion drift report

  /evolve-bench --mine [--top 10] [--window 2000] [--min-delta 0.3]
                [--min-extremity 0.5] [--include-registered]
      (Phase 29) mine high-signal subjects from fitness.ndjson and propose them
      as canonical benchmark candidates — read-only, no write. Reviewer still
      has to run \`--add\` to register them.

  Exactly one mode flag (--list / --add / --record / --drift / --mine) is required.`

type Mode = 'list' | 'add' | 'record' | 'drift' | 'mine' | null

interface ParsedFlags {
  mode: Mode
  // --add
  addId?: string
  desc?: string
  criteria?: string
  // --record
  recordId?: string
  score?: number
  organism?: string
  weightsVersion?: string
  // --drift
  driftThreshold?: number
  driftMinBenchmarks?: number
  driftWindow?: number
  // --mine (Phase 29)
  mineTopK?: number
  mineMinDelta?: number
  mineMinExtremity?: number
  mineIncludeRegistered?: boolean
  error: string | null
}

function takeValue(
  tokens: string[],
  i: number,
  flag: string,
): { value: string; nextI: number } | { error: string } {
  const next = tokens[i + 1]
  if (!next || next.startsWith('--')) {
    return { error: `${flag} requires a value` }
  }
  return { value: next, nextI: i + 1 }
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedFlags = { mode: null, error: null }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    switch (t) {
      case '--list':
      case '-l':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --list`
          return out
        }
        out.mode = 'list'
        break
      case '--add':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --add`
          return out
        }
        {
          const r = takeValue(tokens, i, '--add')
          if ('error' in r) {
            out.error = r.error
            return out
          }
          out.addId = r.value
          i = r.nextI
        }
        out.mode = 'add'
        break
      case '--desc': {
        const r = takeValue(tokens, i, '--desc')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        out.desc = r.value
        i = r.nextI
        break
      }
      case '--criteria': {
        const r = takeValue(tokens, i, '--criteria')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        out.criteria = r.value
        i = r.nextI
        break
      }
      case '--record':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --record`
          return out
        }
        out.mode = 'record'
        break
      case '--id': {
        const r = takeValue(tokens, i, '--id')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        out.recordId = r.value
        i = r.nextI
        break
      }
      case '--score': {
        const r = takeValue(tokens, i, '--score')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number(r.value)
        if (!Number.isFinite(n)) {
          out.error = `--score must be a finite number (got "${r.value}")`
          return out
        }
        out.score = n
        i = r.nextI
        break
      }
      case '--organism': {
        const r = takeValue(tokens, i, '--organism')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        out.organism = r.value
        i = r.nextI
        break
      }
      case '--weights-version': {
        const r = takeValue(tokens, i, '--weights-version')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        out.weightsVersion = r.value
        i = r.nextI
        break
      }
      case '--drift':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --drift`
          return out
        }
        out.mode = 'drift'
        break
      case '--mine':
        if (out.mode) {
          out.error = `mode already set to "${out.mode}" — cannot combine with --mine`
          return out
        }
        out.mode = 'mine'
        break
      case '--top': {
        const r = takeValue(tokens, i, '--top')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number.parseInt(r.value, 10)
        if (!Number.isFinite(n) || n < 1 || n > 500) {
          out.error = `--top must be a positive integer 1..500 (got "${r.value}")`
          return out
        }
        out.mineTopK = n
        i = r.nextI
        break
      }
      case '--min-delta': {
        const r = takeValue(tokens, i, '--min-delta')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number(r.value)
        if (!Number.isFinite(n) || n < 0) {
          out.error = `--min-delta must be a non-negative number (got "${r.value}")`
          return out
        }
        out.mineMinDelta = n
        i = r.nextI
        break
      }
      case '--min-extremity': {
        const r = takeValue(tokens, i, '--min-extremity')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number(r.value)
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          out.error = `--min-extremity must be a number in [0,1] (got "${r.value}")`
          return out
        }
        out.mineMinExtremity = n
        i = r.nextI
        break
      }
      case '--include-registered':
        out.mineIncludeRegistered = true
        break
      case '--threshold': {
        const r = takeValue(tokens, i, '--threshold')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number(r.value)
        if (!Number.isFinite(n) || n <= 0) {
          out.error = `--threshold must be a positive number (got "${r.value}")`
          return out
        }
        out.driftThreshold = n
        i = r.nextI
        break
      }
      case '--min-benchmarks': {
        const r = takeValue(tokens, i, '--min-benchmarks')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number.parseInt(r.value, 10)
        if (!Number.isFinite(n) || n < 1) {
          out.error = `--min-benchmarks must be a positive integer (got "${r.value}")`
          return out
        }
        out.driftMinBenchmarks = n
        i = r.nextI
        break
      }
      case '--window': {
        const r = takeValue(tokens, i, '--window')
        if ('error' in r) {
          out.error = r.error
          return out
        }
        const n = Number.parseInt(r.value, 10)
        if (!Number.isFinite(n) || n <= 0 || n > 100000) {
          out.error = `--window must be a positive integer 1..100000 (got "${r.value}")`
          return out
        }
        out.driftWindow = n
        i = r.nextI
        break
      }
      case '--help':
      case '-h':
        out.error = USAGE
        return out
      default:
        out.error = `Unknown flag "${t}"\n\n${USAGE}`
        return out
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

  // 懒加载:避免冷启动多读一堆 JSON
  const benchMod = await import(
    '../../services/autoEvolve/oracle/benchmarkLedger.js'
  )
  const pathsMod = await import('../../services/autoEvolve/paths.js')

  // ── --list ───────────────────────────────────────────────────────
  if (parsed.mode === 'list') {
    const file = benchMod.readBenchmarks()
    const lines: string[] = []
    lines.push(`## autoEvolve Benchmarks (Phase 28)`)
    lines.push('')
    lines.push(`path: ${pathsMod.getBenchmarksPath()}`)
    lines.push('')
    if (file.benchmarks.length === 0) {
      lines.push(
        `(no benchmarks yet — use \`/evolve-bench --add <id> --desc "..." [--criteria "..."]\` to register one)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    for (const b of file.benchmarks) {
      lines.push(`- **${b.id}**  (createdAt: ${b.createdAt})`)
      lines.push(`  description: ${b.description}`)
      if (b.acceptanceCriteria) {
        lines.push(`  acceptance: ${b.acceptanceCriteria}`)
      }
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --add ────────────────────────────────────────────────────────
  if (parsed.mode === 'add') {
    if (!parsed.addId || !parsed.desc) {
      return {
        type: 'text',
        value: `--add requires both <id> and --desc "..."\n\n${USAGE}`,
      }
    }
    const res = benchMod.addBenchmark({
      id: parsed.addId,
      description: parsed.desc,
      acceptanceCriteria: parsed.criteria ?? '',
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Benchmarks — add (Phase 28)`)
    lines.push('')
    if (res.ok && res.entry) {
      lines.push(`  wrote ${res.path}`)
      lines.push(`  id: ${res.entry.id}`)
      lines.push(`  createdAt: ${res.entry.createdAt}`)
      lines.push(`  description: ${res.entry.description}`)
      if (res.entry.acceptanceCriteria) {
        lines.push(`  acceptance: ${res.entry.acceptanceCriteria}`)
      }
    } else {
      lines.push(`  !! add failed: ${res.error}`)
      lines.push(`  path: ${res.path}`)
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --record ─────────────────────────────────────────────────────
  if (parsed.mode === 'record') {
    if (!parsed.recordId || !Number.isFinite(parsed.score)) {
      return {
        type: 'text',
        value: `--record requires --id <benchmarkId> and --score <n>\n\n${USAGE}`,
      }
    }
    // 先确认 benchmark 已注册
    const file = benchMod.readBenchmarks()
    const hit = file.benchmarks.find(b => b.id === parsed.recordId)
    if (!hit) {
      return {
        type: 'text',
        value: `unknown benchmark id "${parsed.recordId}". Register it first with \`/evolve-bench --add\`.`,
      }
    }
    // weightsVersion 缺省:从 loadOracleWeights().version 读
    let weightsVersion = parsed.weightsVersion
    if (!weightsVersion) {
      const oracleMod = await import(
        '../../services/autoEvolve/oracle/fitnessOracle.js'
      )
      weightsVersion = oracleMod.loadOracleWeights().version
    }
    const res = benchMod.appendBenchmarkRun({
      benchmarkId: parsed.recordId,
      organismId: parsed.organism,
      at: new Date().toISOString(),
      oracleWeightsVersion: weightsVersion,
      score: parsed.score as number,
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Benchmarks — record (Phase 28)`)
    lines.push('')
    if (res.ok && res.run) {
      lines.push(`  appended ${res.path}`)
      lines.push(`  runId: ${res.run.runId}`)
      lines.push(`  benchmarkId: ${res.run.benchmarkId}`)
      lines.push(
        `  organismId: ${res.run.organismId ?? '(not provided — treating as Oracle-level sample)'}`,
      )
      lines.push(`  at: ${res.run.at}`)
      lines.push(`  oracleWeightsVersion: ${res.run.oracleWeightsVersion}`)
      lines.push(`  score: ${res.run.score.toFixed(4)}`)
      lines.push(`  signature: ${res.run.signature}`)
    } else {
      lines.push(`  !! record failed: ${res.error}`)
      lines.push(`  path: ${res.path}`)
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --drift ──────────────────────────────────────────────────────
  if (parsed.mode === 'drift') {
    const report = benchMod.computeDrift({
      windowRuns: parsed.driftWindow,
      driftThreshold: parsed.driftThreshold,
      minSuspiciousBenchmarks: parsed.driftMinBenchmarks,
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Benchmark Drift Report (Phase 28)`)
    lines.push('')
    lines.push(
      `driftThreshold: ${report.driftThreshold}  |  minSuspiciousBenchmarks: ${report.minSuspiciousBenchmarks}`,
    )
    lines.push(
      `suspicious: ${report.suspicious ? '**YES**' : 'no'}   reason: ${report.reason}`,
    )
    lines.push('')
    if (report.allRows.length === 0) {
      lines.push(
        `(no benchmark runs to compare — record at least 2 oracleWeightsVersion per benchmark first)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    lines.push(
      `  ${'benchmarkId'.padEnd(28)}  ${'ver A'.padEnd(20)}  ${'ver B'.padEnd(20)}  ${'meanA'.padStart(7)}  ${'meanB'.padStart(7)}  ${'Δ'.padStart(6)}  susp?`,
    )
    lines.push(
      '  ' +
        '-'.repeat(28) +
        '  ' +
        '-'.repeat(20) +
        '  ' +
        '-'.repeat(20) +
        '  -------  -------  ------  -----',
    )
    for (const r of report.allRows) {
      const sus = r.delta > report.driftThreshold ? '  YES' : '  .'
      lines.push(
        `  ${r.benchmarkId.padEnd(28)}  ${r.versionA.slice(0, 20).padEnd(20)}  ${r.versionB.slice(0, 20).padEnd(20)}  ${r.meanA.toFixed(3).padStart(7)}  ${r.meanB.toFixed(3).padStart(7)}  ${r.delta.toFixed(3).padStart(6)}${sus}`,
      )
    }
    lines.push('')
    if (report.suspicious) {
      lines.push(
        `!! Oracle drift detected — \`/evolve-meta --apply\` will refuse to write tuned weights unless passed \`--force\`.`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  // ── --mine (Phase 29) ─────────────────────────────────────────────
  if (parsed.mode === 'mine') {
    const result = benchMod.mineBenchmarkCandidates({
      // --window 在 parser 里被记到 driftWindow(同一 token),语义上是通用
      // 的"往回看多少行",mine 与 drift 复用 —— 不再单独拆一个 mineWindow。
      windowLines: parsed.driftWindow,
      topK: parsed.mineTopK,
      minDelta: parsed.mineMinDelta,
      minExtremity: parsed.mineMinExtremity,
      // 默认 true: excludeRegistered;--include-registered 显式开 false
      excludeRegistered: parsed.mineIncludeRegistered ? false : true,
    })
    const lines: string[] = []
    lines.push(`## autoEvolve Benchmark Candidate Miner (Phase 29)`)
    lines.push('')
    lines.push(
      `scanned: ${result.scanned} fitness.ndjson line(s)  |  candidates: ${result.candidates.length}`,
    )
    if (result.reason) {
      lines.push(`note: ${result.reason}`)
    }
    lines.push('')
    if (result.candidates.length === 0) {
      lines.push(
        `(no candidate passed min-delta/min-extremity filters — try a wider --window or lower thresholds)`,
      )
      return { type: 'text', value: lines.join('\n') }
    }
    // 表格
    lines.push(
      `  ${'#'.padStart(3)}  ${'suggested-id'.padEnd(40)}  ${'info'.padStart(5)}  ${'Δver'.padStart(5)}  ${'mean'.padStart(6)}  ${'n'.padStart(4)}  rationale`,
    )
    lines.push(
      '  ' +
        '-'.repeat(3) +
        '  ' +
        '-'.repeat(40) +
        '  -----  -----  ------  ----  ' +
        '-'.repeat(30),
    )
    for (let i = 0; i < result.candidates.length; i++) {
      const c = result.candidates[i]
      lines.push(
        `  ${String(i + 1).padStart(3)}  ${c.suggestedId.padEnd(40)}  ${c.informativeness
          .toFixed(2)
          .padStart(5)}  ${c.maxVersionDelta.toFixed(2).padStart(5)}  ${c.meanScore
          .toFixed(2)
          .padStart(6)}  ${String(c.sampleCount).padStart(4)}  ${c.rationale}`,
      )
    }
    lines.push('')
    lines.push(`To register one, copy the suggested-id and run:`)
    lines.push(
      `  /evolve-bench --add <suggested-id> --desc "..." [--criteria "..."]`,
    )
    lines.push('')
    lines.push(`Mined subjects (for reference — map id back to the original fitness subject):`)
    for (const c of result.candidates) {
      lines.push(
        `  ${c.suggestedId}  ←  subjectId=${c.subjectId}${c.organismId ? `  organismId=${c.organismId}` : ''}  (versions=${c.oracleVersions.length})`,
      )
    }
    return { type: 'text', value: lines.join('\n') }
  }

  return { type: 'text', value: USAGE }
}

const evolveBench = {
  type: 'local',
  name: 'evolve-bench',
  description:
    'Phase 28 Oracle-level anti-Goodhart entry. Subcommands --list / --add / --record / --drift manage canonical benchmark tasks (benchmarks.json) and their per-oracleWeightsVersion run log (benchmark-runs.ndjson). `--drift` computes cross-version regression to soft-gate `/evolve-meta --apply` when Oracle starts over-fitting to a single evaluation style.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveBench
