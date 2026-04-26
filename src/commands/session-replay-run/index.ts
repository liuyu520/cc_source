// G7 Step 3 command:/session-replay-run
// 作用:按 session.jsonl 里历史 Read/Glob/LS 调用,在当前代码库下 **真实** 重放,
// 报告 match/drift/missing/error/skipped 数量。
// 默认 dry-run;--execute 需要同时导出 CLAUDE_SESSION_REPLAY_EXECUTE=1 双开关。
// 该命令只调用纯读工具(文件存在性/目录/glob),不触发 Bash/Edit/Agent 等副作用路径。
import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /session-replay-run <sessionId | path/to.jsonl> [--execute] [--limit N] [--json] [--help]

Options:
  --execute       真实重放(默认 dry-run)。需同时设 CLAUDE_SESSION_REPLAY_EXECUTE=1。
  --limit N       只回放最后 N 条可回放调用(默认全部)。
  --json          以 JSON 输出,便于 pipeline。
  --help          显示本帮助。

Notes:
  - 只重放纯读工具(Read/Glob/LS);Bash/Edit/Grep/Agent/Write 一律 skip。
  - 历史 is_error=true 的调用 skip,不评估回归。
  - outcome=missing 或 drift 即潜在回归候选,建议手动复核。`

interface ParsedArgs {
  target?: string
  execute: boolean
  limit?: number
  json: boolean
  help: boolean
  error?: string
}

function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedArgs = { execute: false, json: false, help: false }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      out.help = true
      continue
    }
    if (t === '--execute') {
      out.execute = true
      continue
    }
    if (t === '--json') {
      out.json = true
      continue
    }
    if (t === '--limit') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n <= 0) {
        return { ...out, error: `--limit 需要正整数\n${USAGE}` }
      }
      out.limit = n
      continue
    }
    if (t.startsWith('--')) {
      return { ...out, error: `unknown flag: ${t}\n${USAGE}` }
    }
    if (!out.target) {
      out.target = t
    } else {
      return { ...out, error: `too many positional args\n${USAGE}` }
    }
  }
  return out
}

// 与 /session-replay 同一套 target 解析策略:绝对/相对路径或 sessionId。
function resolveTarget(target: string): string {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    if (
      target.includes('/') ||
      target.includes('\\') ||
      target.endsWith('.jsonl')
    ) {
      return target
    }
    const { resolveSessionJsonlPath } = require(
      '../../utils/sessionStorage.js',
    ) as any
    const cwd = process.cwd()
    const pathViaCwd = resolveSessionJsonlPath({
      sessionId: target,
      projectDir: cwd,
    })
    if (fs.existsSync(pathViaCwd)) return pathViaCwd
    const { getProjectsDir } = require('../../utils/sessionStorage.js') as any
    const projectsDir = getProjectsDir() as string
    if (fs.existsSync(projectsDir)) {
      const sub = fs.readdirSync(projectsDir)
      for (const d of sub) {
        const p = require('node:path').join(
          projectsDir,
          d,
          `${target}.jsonl`,
        )
        if (fs.existsSync(p)) return p
      }
    }
    return pathViaCwd
  } catch {
    return target
  }
}

function call(args: string): LocalCommandCall {
  const parsed = parseArgs(args)
  if (parsed.help) return { type: 'text', value: USAGE }
  if (parsed.error) return { type: 'text', value: parsed.error }
  if (!parsed.target) {
    return {
      type: 'text',
      value: `请指定 sessionId 或 jsonl 路径\n${USAGE}`,
    }
  }

  const filePath = resolveTarget(parsed.target)
  const { runReplay } = require(
    '../../services/sessionReplay/replayRunner.js',
  ) as typeof import('../../services/sessionReplay/replayRunner.js')

  const result = runReplay(filePath, {
    execute: parsed.execute,
    limit: parsed.limit,
  })

  if (parsed.json) {
    return {
      type: 'text',
      value: JSON.stringify(
        {
          filePath,
          ...result,
          rows: result.rows.map(r => ({
            id: r.call.id,
            name: r.call.name,
            outcome: r.outcome,
            detail: r.detail,
          })),
        },
        null,
        2,
      ),
    }
  }

  const out: string[] = []
  out.push(`file: ${filePath}`)
  out.push(
    `total=${result.total} replayed=${result.replayed} ` +
      `dryRun=${result.dryRun}` +
      (result.reason ? ` reason=${result.reason}` : ''),
  )
  out.push(
    `buckets: match=${result.buckets.match} drift=${result.buckets.drift} ` +
      `missing=${result.buckets.missing} error=${result.buckets.error} ` +
      `skipped=${result.buckets.skipped}`,
  )
  out.push('')
  // 优先展示回归候选(missing / drift / error),后面补部分 match/skipped。
  const priority: Record<string, number> = {
    missing: 0,
    drift: 1,
    error: 2,
    match: 3,
    skipped: 4,
  }
  const sorted = [...result.rows].sort(
    (a, b) =>
      (priority[a.outcome] ?? 9) - (priority[b.outcome] ?? 9),
  )
  const showN = Math.min(sorted.length, 30)
  for (let i = 0; i < showN; i++) {
    const r = sorted[i]!
    const argKey =
      r.call.name === 'Read'
        ? r.call.input.file_path
        : r.call.name === 'Glob'
          ? r.call.input.pattern
          : r.call.input.path
    out.push(`- [${r.outcome}] ${r.call.name} ${String(argKey ?? '?')}`)
    out.push(`    ${r.detail}`)
  }
  if (sorted.length > showN) {
    out.push(`... (+${sorted.length - showN} more, use --json for full list)`)
  }
  out.push('')
  out.push(
    'Note: pure read-only replay — Bash/Edit/Agent/Write never invoked. See G7 Step 3 in docs/ai-coding-agent-improvement-spaces-2026-04-25.md.',
  )
  return { type: 'text', value: out.join('\n') }
}

const sessionReplayRun = {
  type: 'local',
  name: 'session-replay-run',
  description:
    'G7 Step 3: dry-run/real replay of historical Read/Glob/LS calls; flags regressions.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default sessionReplayRun
