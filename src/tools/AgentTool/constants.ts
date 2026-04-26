export const AGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const VERIFICATION_AGENT_TYPE = 'verification'

// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
])

// Some plugin agents are explicitly meant to be invoked proactively by their
// tool instructions after a local artifact change (for example, reviewing a
// newly-created skill). ExecutionMode may still classify the user request as
// simple/direct_execute, but blocking these reviewer/validator agents makes the
// proactive contract impossible to satisfy. Keep this list narrow: only
// single-purpose plugin agents whose invocation is itself the validation step.
const PROACTIVE_PLUGIN_AGENT_SUFFIXES: ReadonlyArray<string> = [
  'agent-creator',
  'skill-reviewer',
  'plugin-validator',
]

export function isAgentDelegationSuppressionExempt(agentType: string): boolean {
  if (ONE_SHOT_BUILTIN_AGENT_TYPES.has(agentType)) return true
  return PROACTIVE_PLUGIN_AGENT_SUFFIXES.some(
    suffix => agentType === suffix || agentType.endsWith(`:${suffix}`),
  )
}
