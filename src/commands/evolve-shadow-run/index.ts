/**
 * /evolve-shadow-run <id> [--status shadow|canary] [--tools T1,T2,...]
 *
 * Phase 42 — Minimal shadow runner reviewer entry.
 *
 * 当前默认输出 sandbox-filtered run plan；传 --execute-readonly 时会通过
 * worker-compatible local adapter 执行只读 runtime 工具。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /evolve-shadow-run <id> [--status shadow|canary] [--tools T1,T2,...] [--execute-readonly]
                      [--query-text TEXT] [--target-files a,b,c] [--grep-needle TEXT] [--web-url URL]

Examples:
  /evolve-shadow-run orgm-1234abcd
  /evolve-shadow-run orgm-1234abcd --tools Read,Grep,WebFetch,Bash
  /evolve-shadow-run orgm-1234abcd --status canary --tools Read,Glob,Grep
  /evolve-shadow-run orgm-1234abcd --execute-readonly --grep-needle rollback --target-files src/commands.ts
  /evolve-shadow-run orgm-1234abcd --execute-readonly --web-url https://example.com`

interface ParsedFlags {
  id: string | null
  status: 'shadow' | 'canary'
  tools: string[]
  executeReadOnly: boolean
  queryText?: string
  targetFiles?: string[]
  grepNeedle?: string
  webUrl?: string
  error: string | null
}

function tokenizeArgs(args: string): string[] {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return tokens.map(token => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1)
    }
    return token
  })
}

function parseFlags(args: string): ParsedFlags {
  const tokens = tokenizeArgs(args.trim())
  const out: ParsedFlags = {
    id: null,
    status: 'shadow',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch'],
    executeReadOnly: false,
    error: null,
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--status' || t === '-s') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--status requires a value'
        return out
      }
      if (next !== 'shadow' && next !== 'canary') {
        out.error = `--status must be shadow|canary (got "${next}")`
        return out
      }
      out.status = next
      i++
    } else if (t === '--tools' || t === '-t') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--tools requires a comma-separated list'
        return out
      }
      out.tools = next.split(',').map(x => x.trim()).filter(Boolean)
      i++
    } else if (t === '--execute-readonly') {
      out.executeReadOnly = true
    } else if (t === '--query-text') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--query-text requires a value'
        return out
      }
      out.queryText = next
      i++
    } else if (t === '--target-files') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--target-files requires a comma-separated list'
        return out
      }
      out.targetFiles = next.split(',').map(x => x.trim()).filter(Boolean)
      i++
    } else if (t === '--grep-needle') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--grep-needle requires a value'
        return out
      }
      out.grepNeedle = next
      i++
    } else if (t === '--web-url') {
      const next = tokens[i + 1]
      if (!next) {
        out.error = '--web-url requires a value'
        return out
      }
      out.webUrl = next
      i++
    } else if (t === '--help' || t === '-h') {
      out.error = USAGE
      return out
    } else if (t.startsWith('-')) {
      out.error = `Unknown flag "${t}"\n\n${USAGE}`
      return out
    } else if (!out.id) {
      out.id = t
    } else {
      out.error = `Unexpected extra arg "${t}"\n\n${USAGE}`
      return out
    }
  }
  if (!out.id) {
    out.error = `Missing <id>\n\n${USAGE}`
  }
  return out
}

function renderRunnerModeHint(result: {
  attempted: boolean
  plan?: { worktreeState: string }
}): string | null {
  if (!result.plan) return null
  if (result.plan.worktreeState === 'arena-derived-missing') {
    return result.attempted
      ? 'hint: arena worktree has not been spawned yet; readonly runtime used the derived path directly'
      : 'hint: arena worktree has not been spawned yet; this report is plan-only against the derived path'
  }
  if (result.plan.worktreeState === 'path-missing') {
    return result.attempted
      ? 'hint: manifest worktreePath is missing on disk; readonly runtime still reported against that path'
      : 'hint: manifest worktreePath is missing on disk; fix or respawn the worktree before relying on execution results'
  }
  return null
}

const call: LocalCommandCall = async args => {
  const parsed = parseFlags(args)
  if (parsed.error) return { type: 'text', value: parsed.error }

  const runnerMod = await import('../../services/autoEvolve/arena/shadowRunner.js')
  const result = await runnerMod.startShadowRun({
    organismId: parsed.id!,
    status: parsed.status,
    requestedTools: parsed.tools,
    inputs: {
      queryText: parsed.queryText,
      targetFiles: parsed.targetFiles,
      grepNeedle: parsed.grepNeedle,
      webUrl: parsed.webUrl,
    },
    executeReadOnly: parsed.executeReadOnly,
  })

  const lines: string[] = []
  lines.push('## autoEvolve Shadow Runner (Phase 42)')
  const hint = renderRunnerModeHint(result)
  if (hint) {
    lines.push(hint)
  }
  lines.push('')
  lines.push(...runnerMod.renderSingleShadowRunReport(result))
  return { type: 'text', value: lines.join('\n') }
}

const evolveShadowRun = {
  type: 'local',
  name: 'evolve-shadow-run',
  description:
    'Phase 42 shadow runner. Produces a sandbox-filtered plan for a shadow/canary organism and can optionally execute allow-listed read-only tools through a worker-compatible local adapter.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveShadowRun
