/**
 * G7 Step 2(2026-04-26):/session-replay-diff 命令。
 *
 * 目的
 * ----
 * Step 1 的 /session-replay 只是单 session tail;Step 2 做"两条 session 的决策签名差"。
 * 用户拿 baseline session 与怀疑退化的 current session 对比,可立刻看出:
 *   - 哪个 tool 被突然弃用 / 用得更多;
 *   - assistant 轮数、sidechain 触发密度是否异动。
 *
 * 输入
 * ----
 *   /session-replay-diff <pathA|sessionIdA> <pathB|sessionIdB> [--json] [--top N] [--help]
 *
 * 行为
 * ----
 *   - 纯读,零副作用,不重放,不触发工具 / MCP。
 *   - sessionId 同 Step 1:先按 CWD 的 project 找,再跨 project 浅扫 `${id}.jsonl`。
 *   - --top N 限制 markdown 表最多展示 N 条 tool(--json 始终全量)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /session-replay-diff                          auto-pick: latest vs previous (by mtime)
  /session-replay-diff <B>                      auto-pick baseline, diff vs <B>
  /session-replay-diff <A> <B>                  diff two sessions
  /session-replay-diff <A> <B> --top 10         limit tool rows to 10
  /session-replay-diff <A> <B> --json           emit JSON
  /session-replay-diff --help                   this message

<A> / <B> may be absolute paths, relative paths, or sessionId.
When <A>/<B> are omitted, two most recent session jsonl under
~/.claude/projects/*/*.jsonl are auto-picked (latest=B, previous=A).
`

interface ParsedArgs {
  a?: string
  b?: string
  top?: number
  json: boolean
  help: boolean
  error?: string
}

function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedArgs = { json: false, help: false }
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') out.help = true
    else if (t === '--json') out.json = true
    else if (t === '--top') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n <= 0) {
        out.error = '--top 必须是正整数'
        return out
      }
      out.top = n
    } else if (t.startsWith('--')) {
      out.error = `未知参数: ${t}`
      return out
    } else {
      positional.push(t)
    }
  }
  out.a = positional[0]
  out.b = positional[1]
  return out
}

/** 与 /session-replay 的 resolveTarget 完全一致,复制以保持解耦 */
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
      '../../services/sessionReplay/replayParser.js',
    ) as typeof import('../../services/sessionReplay/replayParser.js')
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

function fmtDelta(n: number): string {
  if (n === 0) return '0'
  return n > 0 ? `+${n}` : String(n)
}

function call(args: string): LocalCommandCall {
  const parsed = parseArgs(args)
  if (parsed.help) return { type: 'text', value: USAGE }
  if (parsed.error) return { type: 'text', value: parsed.error }

  const {
    extractSignature,
    diffSignatures,
  } = require(
    '../../services/sessionReplay/decisionSignature.js',
  ) as typeof import('../../services/sessionReplay/decisionSignature.js')
  const { replaySessionFile, findRecentSessionJsonls } = require(
    '../../services/sessionReplay/replayParser.js',
  ) as typeof import('../../services/sessionReplay/replayParser.js')

  // auto-pick 逻辑:缺 A 或 B 时从最近 jsonl 按 mtime 挑
  // 规则:latest → B(current),previous → A(baseline),与 "B - A = 退化嗅探" 语义对齐
  let pathA: string
  let pathB: string
  const autoPickNotes: string[] = []
  if (!parsed.a && !parsed.b) {
    const recents = findRecentSessionJsonls(10)
    if (recents.length < 2) {
      return {
        type: 'text',
        value:
          `auto-pick 失败:~/.claude/projects 下不足 2 条 session jsonl(找到 ${recents.length} 条)。` +
          '请显式传两个 <A> <B>(path 或 sessionId)。',
      }
    }
    pathB = recents[0]!.path
    pathA = recents[1]!.path
    autoPickNotes.push(
      `auto-pick: latest=${recents[0]!.sessionId} (B) vs previous=${recents[1]!.sessionId} (A)`,
    )
  } else if (parsed.a && !parsed.b) {
    // 只传了一个参数:把它当 B(current),自动挑一个比它更早的 session 作 baseline
    pathB = resolveTarget(parsed.a)
    const recents = findRecentSessionJsonls(20)
    const candidate = recents.find(r => r.path !== pathB)
    if (!candidate) {
      return {
        type: 'text',
        value:
          'auto-pick 失败:除指定参数外没有其它 session jsonl 可作 baseline。请显式传两个 <A> <B>。',
      }
    }
    pathA = candidate.path
    autoPickNotes.push(`auto-pick baseline: ${candidate.sessionId} (A)`)
  } else {
    pathA = resolveTarget(parsed.a!)
    pathB = resolveTarget(parsed.b!)
  }

  // 解析时保留 meta,否则 role meta 计数会总是 0,无法诊断 meta 数量异动
  const rA = replaySessionFile(pathA, { keepMeta: true })
  const rB = replaySessionFile(pathB, { keepMeta: true })

  const sigA = extractSignature(rA)
  const sigB = extractSignature(rB)
  const diff = diffSignatures(sigA, sigB)

  if (parsed.json) {
    // toolUseDeltas 里的 toolUses Map 不能 JSON 化,单独处理
    const payload = {
      a: {
        filePath: sigA.filePath,
        totalLines: sigA.totalLines,
        kept: sigA.kept,
        roleCounts: sigA.roleCounts,
        toolUses: Object.fromEntries(sigA.toolUses),
        sidechainCount: sigA.sidechainCount,
        totalToolUses: sigA.totalToolUses,
      },
      b: {
        filePath: sigB.filePath,
        totalLines: sigB.totalLines,
        kept: sigB.kept,
        roleCounts: sigB.roleCounts,
        toolUses: Object.fromEntries(sigB.toolUses),
        sidechainCount: sigB.sidechainCount,
        totalToolUses: sigB.totalToolUses,
      },
      toolUseDeltas: diff.toolUseDeltas,
      addedTools: diff.addedTools,
      removedTools: diff.removedTools,
      roleDeltas: diff.roleDeltas,
      assistantDelta: diff.assistantDelta,
      sidechainDelta: diff.sidechainDelta,
      totalToolUseDelta: diff.totalToolUseDelta,
    }
    return { type: 'text', value: JSON.stringify(payload, null, 2) }
  }

  const out: string[] = []
  out.push('## Session Replay Diff (G7 Step 2)')
  if (autoPickNotes.length > 0) {
    for (const note of autoPickNotes) out.push(`_${note}_`)
  }
  out.push('')
  out.push(`A (baseline) : ${sigA.filePath}`)
  out.push(
    `  totalLines=${sigA.totalLines} kept=${sigA.kept} assistant=${sigA.roleCounts.assistant ?? 0} tool_result=${sigA.roleCounts.tool_result ?? 0} sidechain=${sigA.sidechainCount} totalToolUses=${sigA.totalToolUses}`,
  )
  out.push(`B (current)  : ${sigB.filePath}`)
  out.push(
    `  totalLines=${sigB.totalLines} kept=${sigB.kept} assistant=${sigB.roleCounts.assistant ?? 0} tool_result=${sigB.roleCounts.tool_result ?? 0} sidechain=${sigB.sidechainCount} totalToolUses=${sigB.totalToolUses}`,
  )
  out.push('')
  out.push('### Δ Role Counts (B − A)')
  out.push('| role | A | B | delta |')
  out.push('|---|---:|---:|---:|')
  for (const rd of diff.roleDeltas) {
    out.push(`| ${rd.role} | ${rd.a} | ${rd.b} | ${fmtDelta(rd.delta)} |`)
  }
  out.push('')
  out.push(
    `assistantDelta=${fmtDelta(diff.assistantDelta)} · sidechainDelta=${fmtDelta(diff.sidechainDelta)} · totalToolUseDelta=${fmtDelta(diff.totalToolUseDelta)}`,
  )
  out.push('')

  if (diff.addedTools.length > 0) {
    out.push(`### 🟢 Tools only in B (newly used): ${diff.addedTools.join(', ')}`)
    out.push('')
  }
  if (diff.removedTools.length > 0) {
    out.push(
      `### 🔴 Tools only in A (missing in B — possible regression): ${diff.removedTools.join(', ')}`,
    )
    out.push('')
  }

  const rows = diff.toolUseDeltas.filter(x => x.delta !== 0)
  const limited = parsed.top ? rows.slice(0, parsed.top) : rows
  out.push(`### Δ Tool Uses (B − A, ${rows.length} changed)`)
  if (rows.length === 0) {
    out.push('(no tool usage difference)')
  } else {
    out.push('| tool | A | B | delta | status |')
    out.push('|---|---:|---:|---:|---|')
    for (const t of limited) {
      out.push(
        `| ${t.toolName} | ${t.a} | ${t.b} | ${fmtDelta(t.delta)} | ${t.status} |`,
      )
    }
    if (parsed.top && rows.length > parsed.top) {
      out.push(
        `(...${rows.length - parsed.top} more — use --json for full list)`,
      )
    }
  }
  out.push('')
  out.push(
    'Note: static diff only, no replay / no sandbox. See G7 Step 2 in docs/ai-coding-agent-improvement-spaces-2026-04-25.md.',
  )
  return { type: 'text', value: out.join('\n') }
}

const sessionReplayDiff = {
  type: 'local',
  name: 'session-replay-diff',
  description:
    'G7 Step 2: static decision-signature diff between two session jsonl (baseline vs current).',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default sessionReplayDiff
