/**
 * Capability Filter — remove tools incompatible with current provider.
 *
 * For example, if supportsVision=false, remove vision-dependent tools.
 * If the provider doesn't support tool_search beta, remove ToolSearch.
 *
 * The mapping from capability to tool is hardcoded here (not in the
 * toolset definition) because it represents provider-level constraints,
 * not logical grouping. A toolset might include a vision tool that the
 * DAG resolver enables — but this filter removes it if the provider
 * can't handle vision input.
 */

import type { ProviderCapabilities } from '../providers/providerCapabilities.js'
import type { ToolsetRegistry } from './registry.js'

/** Tools gated by specific provider capabilities */
const CAPABILITY_GATES: Array<{
  capability: keyof ProviderCapabilities
  tools: string[]
  invertedGate?: boolean // true = tool requires capability to be FALSE
}> = [
  {
    capability: 'supportsToolSearch',
    tools: ['ToolSearch'],
  },
  {
    capability: 'supportsVision',
    tools: ['ScreenshotTool'],
  },
]

/**
 * Filter a tool list by provider capabilities. Removes tools whose
 * required capability is not supported.
 */
export function filterByCapabilities(
  tools: string[],
  capabilities: ProviderCapabilities,
  _registry: ToolsetRegistry,
): string[] {
  const blocked = new Set<string>()

  for (const gate of CAPABILITY_GATES) {
    const capValue = capabilities[gate.capability]
    const isBlocked = gate.invertedGate ? capValue === true : capValue === false
    if (isBlocked) {
      for (const tool of gate.tools) {
        blocked.add(tool)
      }
    }
  }

  if (blocked.size === 0) return tools
  return tools.filter((t) => !blocked.has(t))
}
