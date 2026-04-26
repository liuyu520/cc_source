/**
 * Toolset Resolver — decide which tools to present based on context.
 *
 * Uses the ToolsetRegistry DAG to compute the final tool list, then
 * filters by provider capabilities. This replaces the flat "all tools
 * always" approach with a context-aware one.
 *
 * Currently a thin pass-through skeleton. The real context-sensitive
 * logic (e.g. "disable notebook tools if no .ipynb files exist") can
 * be layered in without touching callers.
 */

import { getToolsetRegistry } from './registry.js'
import { filterByCapabilities } from './capabilityFilter.js'
import type { ProviderCapabilities } from '../providers/providerCapabilities.js'
import { logForDebugging } from '../../utils/debug.js'

export interface ResolveContext {
  /** All toolset names to enable (default: all registered) */
  enabledSets?: string[]
  /** Provider capabilities for filtering */
  capabilities?: ProviderCapabilities
  /** Additional tool names to force-include regardless of sets */
  forceInclude?: string[]
  /** Tool names to force-exclude */
  forceExclude?: string[]
}

/**
 * Resolve the final tool list for this context.
 * 1. Resolve DAG → flat tool list
 * 2. Filter by provider capabilities
 * 3. Apply force-include / force-exclude
 */
export function resolveToolList(ctx: ResolveContext = {}): string[] {
  const registry = getToolsetRegistry()
  const allSets = registry.getAll().map((d) => d.name)
  const enabledSets = ctx.enabledSets ?? allSets

  let tools = registry.resolveTools(enabledSets)

  if (ctx.capabilities) {
    tools = filterByCapabilities(tools, ctx.capabilities, registry)
  }

  if (ctx.forceInclude) {
    for (const name of ctx.forceInclude) {
      if (!tools.includes(name)) {
        tools.push(name)
      }
    }
  }

  if (ctx.forceExclude) {
    const excluded = new Set(ctx.forceExclude)
    tools = tools.filter((t) => !excluded.has(t))
  }

  logForDebugging(
    `[ToolsetResolver] resolved ${tools.length} tools from ${enabledSets.length} sets`,
  )
  return tools
}
