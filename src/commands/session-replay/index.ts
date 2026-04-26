/**
 * G7 Step 1 (2026-04-26) —— /session-replay 只读命令。
 *
 * 动机:
 *   回应 docs/ai-coding-agent-improvement-spaces-2026-04-25.md §G7 "Session 可复现/Replay 工具缺失"。
 *   MVP 只做"纯读"——让用户/调试者能快速 tail 一条 conversation.jsonl 的可读摘要,
 *   不触发任何 resume / 工具 / MCP 副作用,不修改任何 state。
 *
 * 范围(Step 1):
 *   - 输入:绝对路径 或 sessionId(后者会在当前 project dir 下查找);
 *   - 过滤:--from N / --to M (行号闭区间)、--grep PAT(子串 case-insensitive);
 *   - 展示:text 默认(line + role + tool_uses + summary); --json 输出结构化数组;
 *   - 开关:--keep-meta 允许展示 file-history-snapshot 等 meta;
 *   - --summary-max N 调整摘要截断长度;默认 200。
 *
 * 非目标:
 *   - 不重放工具调用;不做 decision diff 对比(留待 Step 2);
 *   - 不改 sessionStorage 加载路径(那会带 MCP/resume 副作用)。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = `Usage:
  /session-replay <path|sessionId>          tail all readable messages
  /session-replay <x> --from N              start at line N (1-based)
  /session-replay <x> --to M                stop at line M (inclusive)
  /session-replay <x> --grep PATTERN        filter summary (case-insensitive)
  /session-replay <x> --keep-meta           include meta entries
  /session-replay <x> --summary-max N       truncate summary to N chars (default 200)
  /session-replay <x> --json                emit JSON
  /session-replay --help                    this message
`

interface ParsedArgs {
  target?: string
  from?: number
  to?: number
  grep?: string
  summaryMax?: number
  keepMeta: boolean
  json: boolean
  help: boolean
  error?: string
}

function parseArgs(args: string): ParsedArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: ParsedArgs = { keepMeta: false, json: false, help: false }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--help' || t === '-h') {
      out.help = true
      continue
    }
    if (t === '--json') {
      out.json = true
      continue
    }
    if (t === '--keep-meta') {
      out.keepMeta = true
      continue
    }
    if (t === '--from' || t === '--to' || t === '--summary-max') {
      const next = tokens[++i]
      const n = next ? parseInt(next, 10) : NaN
      if (!Number.isFinite(n) || n < 1) {
        return { ...out, error: `${t} requires positive integer\n${USAGE}` }
      }
      if (t === '--from') out.from = n
      else if (t === '--to') out.to = n
      else out.summaryMax = n
      continue
    }
    if (t === '--grep') {
      const next = tokens[++i]
      if (!next) return { ...out, error: `--grep requires a pattern\n${USAGE}` }
      out.grep = next
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

function resolveTarget(target: string): string {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    // 绝对路径或相对路径,含分隔符或 .jsonl 后缀 -> 按路径
    if (target.includes('/') || target.includes('\\') || target.endsWith('.jsonl')) {
      return target
    }
    // 否则当作 sessionId
    const { resolveSessionJsonlPath } = require(
      '../../services/sessionReplay/replayParser.js',
    ) as typeof import('../../services/sessionReplay/replayParser.js')
    // 先尝试提供 projectDir=CWD 的 sanitize 查找
    const cwd = process.cwd()
    const pathViaCwd = resolveSessionJsonlPath({ sessionId: target, projectDir: cwd })
    if (fs.existsSync(pathViaCwd)) return pathViaCwd
    // fallback: 跨 project 扫描
    const { getProjectsDir } = require('../../utils/sessionStorage.js') as any
    const projectsDir = getProjectsDir() as string
    if (fs.existsSync(projectsDir)) {
      const sub = fs.readdirSync(projectsDir)
      for (const d of sub) {
        const p = require('node:path').join(projectsDir, d, `${target}.jsonl`)
        if (fs.existsSync(p)) return p
      }
    }
    return pathViaCwd // 不存在也返回,让 parser 报 0 lines
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
      value: `missing <path|sessionId>\n${USAGE}`,
    }
  }

  const filePath = resolveTarget(parsed.target)
  const { replaySessionFile } = require(
    '../../services/sessionReplay/replayParser.js',
  ) as typeof import('../../services/sessionReplay/replayParser.js')

  const result = replaySessionFile(filePath, {
    from: parsed.from,
    to: parsed.to,
    grep: parsed.grep,
    summaryMaxChars: parsed.summaryMax,
    keepMeta: parsed.keepMeta,
  })

  if (parsed.json) {
    return { type: 'text', value: JSON.stringify(result, null, 2) }
  }

  const out: string[] = []
  out.push(`file: ${result.filePath}`)
  out.push(
    `totalLines=${result.totalLines} kept=${result.kept} ` +
      `skippedMeta=${result.skippedMeta} skippedInvalid=${result.skippedInvalid}`,
  )
  if (result.messages.length === 0) {
    out.push('(no messages — empty file or filters matched nothing)')
  } else {
    out.push('')
    for (const m of result.messages) {
      const ts = m.timestamp ? m.timestamp : '-'
      const side = m.isSidechain ? ' [sidechain]' : ''
      const tools = m.toolUses && m.toolUses.length > 0 ? ` tools=[${m.toolUses.join(',')}]` : ''
      out.push(`#${m.lineNumber} ${ts} ${m.role}${side}${tools}`)
      out.push(`  ${m.summary}`)
    }
  }
  out.push('')
  out.push('Note: read-only; no tool/MCP side-effects. See G7 in docs/ai-coding-agent-improvement-spaces-2026-04-25.md.')
  return { type: 'text', value: out.join('\n') }
}

const sessionReplay = {
  type: 'local',
  name: 'session-replay',
  description:
    'G7 observation: read-only tail of conversation jsonl (path or sessionId) for bug replay.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default sessionReplay
