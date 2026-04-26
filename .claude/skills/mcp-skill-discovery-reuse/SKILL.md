---
name: "mcp-skill-discovery-reuse"
description: "Reuse existing fetchMcpSkillsForClient, mcpSkillBuilders registry, parseSkillFrontmatterFields, createSkillCommand, and memoizeWithLRU caching when extending MCP skill discovery, adding new resource-to-Command converters, or wiring MCP skills into new consumption points."
---

# MCP Skill Discovery Reuse

Use this skill when extending MCP skill discovery logic, adding new resource filters or MIME types for skill detection, creating new resource-to-Command conversion paths, wiring MCP skills into new consumption points, or debugging MCP skill loading issues.

## Architecture Overview

```
MCP Server (resources capability)
         ↓
resources/list                           ← MCP protocol, ListResourcesResultSchema
         ↓
filter: skill:// URI or text/x-skill    ← mcpSkills.ts:71-75
         ↓
resources/read (per resource)            ← MCP protocol, ReadResourceResultSchema
         ↓
parseFrontmatter(text, uri)              ← frontmatterParser.ts:130
         ↓
parseSkillFrontmatterFields(fm, md, name) ← loadSkillsDir.ts:194
         ↓
createSkillCommand({...})                ← loadSkillsDir.ts:285
         ↓
Command[] (loadedFrom: 'mcp')
         ↓
merged with fetchCommandsForClient()    ← client.ts:2179
         ↓
getMcpSkillCommands()                    ← commands.ts:559, filters by source
```

Dependency injection breaks the cycle: `mcpSkills.ts → mcpSkillBuilders.ts ← loadSkillsDir.ts`.

## Reuse First

- `src/skills/mcpSkills.ts` — `fetchMcpSkillsForClient` (full file)
  Memoized with LRU (cache key = `client.name`, size = 20). Queries `resources/list`, filters for `skill://` URI prefix or `text/x-skill` MIME type, reads each resource, parses frontmatter, creates Command objects. Guarded by `feature('MCP_SKILLS')` flag in `client.ts`.

- `src/skills/mcpSkillBuilders.ts` — Write-once registry
  `registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })` called at `loadSkillsDir.ts:1110-1113` module init. `getMCPSkillBuilders()` retrieves the registered functions. This pattern breaks circular dependency: `client.ts → mcpSkills.ts → loadSkillsDir.ts → ... → client.ts`. Reuse this registry pattern when a leaf module needs functions from a deeply-connected module.

- `src/skills/loadSkillsDir.ts:194-280` — `parseSkillFrontmatterFields()`
  Extracts all skill frontmatter fields (description, allowedTools, argumentHint, whenToUse, model, hooks, effort, shell, paths, next, depends, etc.) from a `FrontmatterData` object. Returns a typed object ready for `createSkillCommand`.

- `src/skills/loadSkillsDir.ts:285-420` — `createSkillCommand()`
  Constructs a `Command` object from parsed fields. Handles `getPromptForCommand()` closure including argument substitution, `${CLAUDE_SKILL_DIR}` replacement, and inline shell execution. MCP skills skip shell execution (`loadedFrom !== 'mcp'` check at line 395).

- `src/utils/memoize.ts:234-269` — `memoizeWithLRU(fn, cacheFn, maxSize)`
  Signature: `(fn: (...args) => Result, cacheFn: (...args) => string, maxSize?: number)`. Returns function with `.cache` object containing `clear()`, `size()`, `delete(key)`, `get(key)`, `has(key)`. The `.cache.delete(name)` protocol is used by `client.ts` at lines 1392 and 1670 to clear stale entries on reconnect/disconnect.

- `src/services/mcp/client.ts:117-121` — Conditional import
  ```typescript
  const fetchMcpSkillsForClient = feature('MCP_SKILLS')
    ? (require('../../skills/mcpSkills.js')).fetchMcpSkillsForClient
    : null
  ```
  Uses `require()` (not `import`) because feature flags are compile-time constants and tree-shaking needs a synchronous branch.

- `src/services/mcp/client.ts:2171-2178, 2344-2350` — Call sites
  `fetchMcpSkillsForClient` is called in `Promise.all` alongside `fetchToolsForClient` and `fetchCommandsForClient`. Results merged: `const commands = [...mcpCommands, ...mcpSkills]`.

- `src/commands.ts:559` — `getMcpSkillCommands()`
  Filters MCP skills from the full command list by `source === 'mcp'` and skill-specific criteria.

- `src/utils/frontmatterParser.ts:130` — `parseFrontmatter(markdown, sourcePath?)`
  YAML frontmatter parser (between `---` delimiters). Returns `{ frontmatter: FrontmatterData, content: string }`. Handles malformed YAML with auto-quoting retry.

## Common Tasks

### Adding a new MCP resource filter for skill discovery

Edit `src/skills/mcpSkills.ts`, modify the filter at line 71-75:
```typescript
const skillResources = listResult.resources.filter(
  r =>
    r.uri.startsWith(SKILL_URI_PREFIX) ||
    r.mimeType === SKILL_MIME_TYPE ||
    r.mimeType === 'text/x-my-new-skill-type',  // ← add new filter
)
```
Add a new constant for the MIME type at the top of the file.

### Creating a new resource-to-Command converter (non-frontmatter)

If the resource content doesn't use SKILL.md frontmatter format:

1. Keep `fetchMcpSkillsForClient` as the entry point
2. After reading resource content, branch by MIME type or URI pattern
3. For the new format, build `createSkillCommand` args manually instead of using `parseSkillFrontmatterFields`:
```typescript
const command = createSkillCommand({
  skillName: `mcp__${client.name}__skill__${rawName}`,
  displayName: 'My Custom Skill',
  description: 'Parsed from custom format',
  hasUserSpecifiedDescription: true,
  markdownContent: resourceContent,
  allowedTools: [],
  argumentHint: undefined,
  argumentNames: [],
  whenToUse: undefined,
  version: undefined,
  model: undefined,
  disableModelInvocation: false,
  userInvocable: true,
  source: 'mcp',
  baseDir: undefined,
  loadedFrom: 'mcp',
  hooks: undefined,
  executionContext: undefined,
  agent: undefined,
  paths: undefined,
  effort: undefined,
  shell: undefined,
  next: undefined,
  depends: undefined,
  workflowGroup: undefined,
})
```

### Applying the write-once registry pattern to break a new cycle

Follow the `mcpSkillBuilders.ts` pattern:

1. Create a leaf module (no imports except types):
```typescript
// src/myModule/myBuilders.ts
import type { myFunction } from './myImpl.js'  // type-only import
export type MyBuilders = { myFunction: typeof myFunction }
let builders: MyBuilders | null = null
export function registerMyBuilders(b: MyBuilders): void { builders = b }
export function getMyBuilders(): MyBuilders {
  if (!builders) throw new Error('Not registered yet')
  return builders
}
```

2. Register at module init in the implementation file:
```typescript
// src/myModule/myImpl.ts (bottom of file)
import { registerMyBuilders } from './myBuilders.js'
registerMyBuilders({ myFunction })
```

3. Consume from the calling module:
```typescript
// src/other/consumer.ts
import { getMyBuilders } from '../myModule/myBuilders.js'
const { myFunction } = getMyBuilders()
```

### Wiring MCP skills into a new consumption point

MCP skills are already merged into the `commands` array at `client.ts:2179`. To consume them separately:
```typescript
import { getMcpSkillCommands } from '../commands.js'
const mcpSkills = getMcpSkillCommands(allCommands)
```

### Invalidating MCP skill cache on reconnect

The `.cache.delete(name)` protocol is already wired at `client.ts:1392` and `client.ts:1670`. If you add a new fetch function that needs the same invalidation, add it to both sites:
```typescript
fetchMcpSkillsForClient!.cache.delete(name)
myNewFetchFunction.cache.delete(name)
```

## Rules

- `fetchMcpSkillsForClient` MUST use `memoizeWithLRU` (not `memoize` or `memoizeWithTTL`) because `client.ts` calls `.cache.delete(name)` on it. LRU is the only memoize variant that exposes `.cache.delete()`.
- MCP skills MUST set `loadedFrom: 'mcp'` — this triggers the security check in `createSkillCommand` that skips inline shell execution (`!cmd` syntax) for remote/untrusted content.
- Skill naming convention: `mcp__${serverName}__skill__${skillName}` — matches the `mcp__` prefix pattern used by `fetchCommandsForClient` for MCP prompts.
- The `mcpSkillBuilders` registry MUST be registered before any MCP server connects. This is guaranteed because `loadSkillsDir.ts` is eagerly evaluated at startup via static import chain from `commands.ts`.
- Feature flag `MCP_SKILLS` guards the conditional import in `client.ts`. When disabled, `fetchMcpSkillsForClient` is `null` and call sites use `Promise.resolve([])`.
- Resource content must be text (`'text' in content`). Binary resources are skipped with a debug log.

## Integration Points

| Component | File | Key location |
|-----------|------|-------------|
| MCP skill fetcher | `src/skills/mcpSkills.ts` | full file (~170 lines) |
| Skill URI prefix | `mcpSkills.ts` | line 29 (`SKILL_URI_PREFIX = 'skill://'`) |
| Skill MIME type | `mcpSkills.ts` | line 31 (`SKILL_MIME_TYPE = 'text/x-skill'`) |
| Cache size | `mcpSkills.ts` | line 36 (`MCP_SKILL_CACHE_SIZE = 20`) |
| Builder registry | `src/skills/mcpSkillBuilders.ts` | full file (45 lines) |
| Builder registration | `src/skills/loadSkillsDir.ts` | line 1110-1113 |
| Frontmatter parser | `src/skills/loadSkillsDir.ts` | line 194 (`parseSkillFrontmatterFields`) |
| Command creator | `src/skills/loadSkillsDir.ts` | line 285 (`createSkillCommand`) |
| Shell execution skip | `src/skills/loadSkillsDir.ts` | line 395 (`loadedFrom !== 'mcp'`) |
| Conditional import | `src/services/mcp/client.ts` | line 117-121 |
| Call site (reconnect) | `src/services/mcp/client.ts` | line 2171-2178 |
| Call site (connect) | `src/services/mcp/client.ts` | line 2344-2350 |
| Cache invalidation | `src/services/mcp/client.ts` | line 1392, 1670 |
| MCP skill command filter | `src/commands.ts` | line 559 (`getMcpSkillCommands`) |
| LRU memoize | `src/utils/memoize.ts` | line 234 (`memoizeWithLRU`) |
| Frontmatter YAML parser | `src/utils/frontmatterParser.ts` | line 130 (`parseFrontmatter`) |

## Validation

- MCP server exposing a `skill://test/hello` resource with SKILL.md frontmatter content → verify skill appears in `/skills` list.
- Run `bun run version` to confirm no import breakage.
- Verify `fetchMcpSkillsForClient.cache.delete('serverName')` doesn't throw (LRU cache compatibility).
- Check that MCP skills don't execute inline `!cmd` blocks (security: `loadedFrom: 'mcp'` prevents it).

## Anti-Patterns

- Using `memoize` or `memoizeWithTTL` for MCP fetch functions — only `memoizeWithLRU` supports the `.cache.delete(key)` protocol required by `client.ts`.
- Directly importing `createSkillCommand` or `parseSkillFrontmatterFields` from `loadSkillsDir.ts` in `mcpSkills.ts` — this creates a circular dependency. Always go through `mcpSkillBuilders.ts`.
- Setting `loadedFrom` to anything other than `'mcp'` for MCP-sourced skills — this would allow untrusted remote content to execute shell commands via `!cmd` syntax.
- Creating a separate MCP skill loading path outside `fetchMcpSkillsForClient` — all MCP skill discovery should go through this single function to benefit from the shared LRU cache and cache invalidation protocol.
- Forgetting to add `.cache.delete(name)` calls when adding new memoized MCP fetch functions — stale cache entries persist after reconnection, returning tools/skills from a dead connection.
- Using literal dynamic import (`await import('./mcpSkills.js')`) instead of `require()` for feature-flag-guarded imports — literal import is tracked by dep-cruiser and may create unwanted cycle violations.
