/**
 * Toolset DAG Registry — declare groups of tools that compose into DAGs.
 *
 * Ported from hermes-agent `tool_composer.py:20-95`.
 *
 * Problem: Claude's tools are a flat list. Some tools logically depend on
 * others (e.g. "Edit" requires a prior "Read"), form semantic groups (e.g.
 * "file ops" = Read + Write + Edit + Glob), or should be enabled/disabled
 * together. A flat list can't express these relationships.
 *
 * Solution: Toolsets are named groups of tools with optional dependency
 * edges forming a DAG. The resolver (resolver.ts) uses this DAG to:
 *   - Enable entire semantic groups at once
 *   - Ensure if tool B depends on A, enabling B also enables A
 *   - Detect cycles at registration time (not at runtime)
 *
 * ENV gate:
 *   CLAUDE_CODE_TOOLSET_DAG=1  → enable (default OFF)
 *
 * When off, the existing flat tool list is preserved unchanged.
 */

import { logForDebugging } from '../../utils/debug.js'

export interface ToolsetDefinition {
  /** Unique name for this toolset (e.g. 'file-ops', 'git-ops') */
  name: string
  /** Human-readable description */
  description: string
  /** Tool names included in this set */
  tools: string[]
  /** Toolsets this one depends on (enables them transitively) */
  dependsOn?: string[]
  /** Optional: provider capabilities required (e.g. 'supportsVision') */
  requiredCapabilities?: string[]
}

type AdjacencyList = Map<string, Set<string>>

function isEnabled(): boolean {
  const raw = (process.env.CLAUDE_CODE_TOOLSET_DAG ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * Detect cycles in the DAG using iterative DFS. Returns the first cycle
 * found as a path array, or null if acyclic.
 */
function detectCycle(adj: AdjacencyList): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()

  for (const node of adj.keys()) {
    color.set(node, WHITE)
    parent.set(node, null)
  }

  for (const start of adj.keys()) {
    if (color.get(start) !== WHITE) continue
    const stack: string[] = [start]
    color.set(start, GRAY)

    while (stack.length > 0) {
      const node = stack[stack.length - 1]!
      const neighbors = adj.get(node) ?? new Set()
      let pushed = false

      for (const neighbor of neighbors) {
        const nc = color.get(neighbor)
        if (nc === WHITE) {
          color.set(neighbor, GRAY)
          parent.set(neighbor, node)
          stack.push(neighbor)
          pushed = true
          break
        }
        if (nc === GRAY) {
          // Found cycle — reconstruct path
          const cycle: string[] = [neighbor]
          let cur = node
          while (cur !== neighbor) {
            cycle.push(cur)
            cur = parent.get(cur) ?? neighbor
          }
          cycle.push(neighbor)
          return cycle.reverse()
        }
      }

      if (!pushed) {
        color.set(node, BLACK)
        stack.pop()
      }
    }
  }

  return null
}

export class ToolsetRegistry {
  private definitions = new Map<string, ToolsetDefinition>()
  private adjacency: AdjacencyList = new Map()

  /**
   * Register a toolset. Validates that adding it doesn't create a cycle.
   * Throws if a cycle is detected.
   */
  register(def: ToolsetDefinition): void {
    // Build tentative adjacency with new definition
    const tentative = new Map(this.adjacency)
    if (!tentative.has(def.name)) {
      tentative.set(def.name, new Set())
    }
    for (const dep of def.dependsOn ?? []) {
      tentative.get(def.name)!.add(dep)
      if (!tentative.has(dep)) {
        tentative.set(dep, new Set())
      }
    }

    const cycle = detectCycle(tentative)
    if (cycle) {
      const msg = `Toolset cycle detected: ${cycle.join(' → ')}`
      logForDebugging(`[ToolsetRegistry] ${msg}`)
      throw new Error(msg)
    }

    this.definitions.set(def.name, def)
    this.adjacency = tentative
    logForDebugging(
      `[ToolsetRegistry] registered "${def.name}" (${def.tools.length} tools, deps=[${(def.dependsOn ?? []).join(',')}])`,
    )
  }

  /**
   * Resolve all tools for a given set of enabled toolset names.
   * Transitively includes tools from dependsOn sets.
   */
  resolveTools(enabledSets: string[]): string[] {
    if (!isEnabled()) return []
    const visited = new Set<string>()
    const tools = new Set<string>()

    const visit = (name: string) => {
      if (visited.has(name)) return
      visited.add(name)
      const def = this.definitions.get(name)
      if (!def) return
      for (const tool of def.tools) {
        tools.add(tool)
      }
      for (const dep of def.dependsOn ?? []) {
        visit(dep)
      }
    }

    for (const name of enabledSets) {
      visit(name)
    }

    return [...tools]
  }

  /**
   * Get all registered toolset definitions.
   */
  getAll(): ToolsetDefinition[] {
    return [...this.definitions.values()]
  }

  /**
   * Get a single toolset by name.
   */
  get(name: string): ToolsetDefinition | undefined {
    return this.definitions.get(name)
  }

  /**
   * Check if any toolsets have the given required capability.
   */
  getSetsByCapability(capability: string): ToolsetDefinition[] {
    return [...this.definitions.values()].filter(
      (def) => def.requiredCapabilities?.includes(capability),
    )
  }
}

// Singleton
let instance: ToolsetRegistry | null = null

export function getToolsetRegistry(): ToolsetRegistry {
  if (!instance) {
    instance = new ToolsetRegistry()
    registerBuiltinToolsets(instance)
  }
  return instance
}

/**
 * Register the default toolset definitions. These encode the implicit
 * groupings that already exist in claude's tool list.
 */
function registerBuiltinToolsets(registry: ToolsetRegistry): void {
  registry.register({
    name: 'core-io',
    description: 'Core file I/O tools',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS'],
  })

  registry.register({
    name: 'shell',
    description: 'Shell execution',
    tools: ['Bash'],
    dependsOn: ['core-io'],
  })

  registry.register({
    name: 'notebook',
    description: 'Jupyter notebook tools',
    tools: ['NotebookEdit', 'NotebookRead'],
    dependsOn: ['core-io'],
  })

  registry.register({
    name: 'web',
    description: 'Web access tools',
    tools: ['WebFetch', 'WebSearch'],
  })

  registry.register({
    name: 'subagent',
    description: 'Sub-agent delegation',
    tools: ['Agent', 'SendMessage'],
    dependsOn: ['core-io', 'shell'],
  })

  registry.register({
    name: 'scheduled',
    description: 'Scheduled task tools',
    tools: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
  })

  registry.register({
    name: 'memory',
    description: 'Memory management tools',
    tools: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'],
  })
}
