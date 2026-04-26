/**
 * /evolve-shadow-sandbox-check [ToolName ...]
 *
 * Phase 42 — Shadow sandbox policy reviewer entry.
 *
 * 不传参数时打印一组常见工具的 allow/deny 结果;
 * 传 ToolName 时只解释这些工具在 shadow mode 下是否允许。
 */

import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import { explainShadowSandboxPolicy } from '../../services/autoEvolve/arena/sandboxFilter.js'

const DEFAULT_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'Bash',
  'Edit',
  'Write',
  'Agent',
  'AskUserQuestion',
  'TaskStop',
]

const USAGE = `Usage:
  /evolve-shadow-sandbox-check [ToolName ...]
    - no args: print common tool policy
    - with args: explain the given tools only`

const call: LocalCommandCall = async args => {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.includes('--help') || tokens.includes('-h')) {
    return { type: 'text', value: USAGE }
  }
  const toolNames = tokens.length > 0 ? tokens : DEFAULT_TOOLS
  const verdicts = explainShadowSandboxPolicy(toolNames)
  const lines: string[] = []
  lines.push('## autoEvolve Shadow Sandbox Check (Phase 42)')
  lines.push('')
  for (const v of verdicts) {
    lines.push(
      `${v.decision.toUpperCase().padEnd(5)} ${v.toolName}  [${v.matchedBy}]  ${v.rationale}`,
    )
  }
  lines.push('')
  lines.push('Policy: shadow forks are observational by default; unknown tools default to DENY.')
  return { type: 'text', value: lines.join('\n') }
}

const evolveShadowSandboxCheck = {
  type: 'local',
  name: 'evolve-shadow-sandbox-check',
  description:
    'Phase 42 shadow sandbox reviewer check. Explains which tools are allowed in observational shadow mode and which are denied because they write files, mutate runtime state, or interact with users/external agents.',
  isEnabled: () => true,
  isHidden: true,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default evolveShadowSandboxCheck
