import type { ToolResult, ToolUseContext, Tools } from '../../../Tool.js'
import { findToolByName } from '../../../Tool.js'
import type { PermissionDecision } from '../../../types/permissions.js'
import {
  assertShadowSandboxToolAllowed,
  type ShadowSandboxVerdict,
} from './sandboxFilter.js'

export type ShadowRuntimeToolName = 'Read' | 'Glob' | 'Grep' | 'WebFetch'

export type ShadowRuntimeGuardResult = {
  ok: true
  verdict: ShadowSandboxVerdict
} | {
  ok: false
  verdict?: ShadowSandboxVerdict
  reason: string
}

export type ShadowRuntimeInvokeResult = {
  ok: true
  verdict: ShadowSandboxVerdict
  toolResult: ToolResult<unknown>
} | {
  ok: false
  verdict?: ShadowSandboxVerdict
  reason: string
}

function deny(reason: string): ShadowRuntimeGuardResult {
  return {
    ok: false,
    reason,
  }
}

async function resolveGuard(args: {
  tools: Tools
  toolName: ShadowRuntimeToolName
  input: Record<string, unknown>
  context: ToolUseContext
}): Promise<
  | {
      ok: true
      tool: NonNullable<ReturnType<typeof findToolByName>>
      verdict: ShadowSandboxVerdict
    }
  | {
      ok: false
      verdict?: ShadowSandboxVerdict
      reason: string
    }
> {
  const { tools, toolName, input, context } = args

  let verdict: ShadowSandboxVerdict
  try {
    verdict = assertShadowSandboxToolAllowed(toolName)
  } catch (e) {
    return deny((e as Error).message)
  }

  const tool = findToolByName(tools, toolName)
  if (!tool) {
    return deny(`[shadowSandbox] ${toolName} is unavailable in runtime tools`)
  }

  const validated = await tool.validateInput?.(input, context)
  if (validated?.result === false) {
    return deny(`[shadowSandbox] ${toolName} validateInput blocked: ${validated.message}`)
  }

  const permission = await tool.checkPermissions(
    input,
    context,
  ) as PermissionDecision<Record<string, unknown>>
  if (permission.behavior !== 'allow') {
    const details = permission.message || 'permission denied'
    return deny(`[shadowSandbox] ${toolName} permission blocked: ${details}`)
  }

  return {
    ok: true,
    tool,
    verdict,
  }
}

export async function guardShadowToolUse(args: {
  tools: Tools
  toolName: ShadowRuntimeToolName
  input: Record<string, unknown>
  context: ToolUseContext
}): Promise<ShadowRuntimeGuardResult> {
  const guard = await resolveGuard(args)
  if (!guard.ok) {
    return guard
  }
  return {
    ok: true,
    verdict: guard.verdict,
  }
}

export async function invokeShadowToolUse(args: {
  tools: Tools
  toolName: ShadowRuntimeToolName
  input: Record<string, unknown>
  context: ToolUseContext
}): Promise<ShadowRuntimeInvokeResult> {
  const guard = await resolveGuard(args)
  if (!guard.ok) {
    return guard
  }

  const toolResult = await guard.tool.call(
    args.input,
    args.context,
    async () => true,
    { message: { id: 'shadow-runtime-tool-call' } } as never,
  )

  return {
    ok: true,
    verdict: guard.verdict,
    toolResult,
  }
}
