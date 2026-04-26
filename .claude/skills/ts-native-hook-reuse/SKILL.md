---
name: "ts-native-hook-reuse"
description: "Reuse existing TsHookSchema, execTsHook executor, and hook dispatch integration when writing TS/JS native hooks, adding new hook types to the discriminated union, or extending hook execution behavior."
---

# TS Native Hook Reuse

Use this skill when writing a TS/JS native hook module, adding a new serializable hook type to the discriminated union, extending hook execution or dispatch logic, or debugging hook path resolution and timeout behavior.

## Architecture Overview

```
settings.json hooks config
         ↓
HookCommandSchema (Zod discriminated union on 'type')
         ↓
executeHooks() dispatch              ← hooks.ts:2142+, generator function
         ↓
┌────────────────────────────────────┐
│ 'callback' → direct call           │ ← internal only
│ 'function' → direct call           │ ← internal only
│ 'prompt'   → execPromptHook()      │ ← hooks/execPromptHook.ts
│ 'agent'    → execAgentHook()       │ ← hooks/execAgentHook.ts
│ 'ts'       → execTsHook()          │ ← hooks/execTsHook.ts (import())
│ 'http'     → execHttpHook()        │ ← hooks/execHttpHook.ts
│ 'command'  → execCommandHook()     │ ← hooks.ts (child_process.spawn)
└────────────────────────────────────┘
         ↓
HookResult { message, blockingError, outcome }
```

Key difference: `ts` hooks execute in-process via `import()`, zero subprocess overhead. Default timeout is 30s (vs 10min for shell hooks).

## Reuse First

- `src/schemas/hooks.ts` — `TsHookSchema` (line 166-187)
  Part of `buildHookSchemas()` return object and `HookCommandSchema` discriminated union. Follow this pattern when adding a 6th hook type: define schema in `buildHookSchemas()`, add to return object, add to `z.discriminatedUnion` array, export type via `Extract<HookCommand, { type: 'xxx' }>`.

- `src/utils/hooks/execTsHook.ts` — `execTsHook()` (line 53)
  Full TS hook executor. Reuse the 10-step pattern (path resolve → security check → timeout → import → validate export → abort check → call → null check → schema validate → decision handling) when creating new hook executors.

- `src/utils/hooks.ts:2297-2321` — TS hook dispatch branch
  Uses lazy `await import('./hooks/execTsHook.js')` to avoid loading the module when no TS hooks are used. Follow this pattern for new hook types. Injects timing fields (`command`, `durationMs`) into attachment after execution.

- `src/utils/hooks/hooksSettings.ts` — `getHookDisplayText()` (line ~120)
  Display text for hook type in UI. Add a `case 'ts': return \`ts:\${hook.path}\`` style entry for new types.

- `src/types/hooks.ts` — `hookJSONOutputSchema()` (line 169-176)
  Zod union of `AsyncHookJSONOutput` and `SyncHookJSONOutput`. All hook executors that accept JSON output must validate against this schema.

- `src/types/hooks.ts` — `HookResult` (line 260-275)
  Return type for all hook executors. Fields: `message`, `blockingError`, `outcome` ('success' | 'blocking' | 'non_blocking_error' | 'cancelled'), `hook`.

- `src/utils/combinedAbortSignal.ts` — `createCombinedAbortSignal(signal, { timeoutMs })`
  Merges external abort signal with timeout. Returns `{ signal, cleanup }`. Always call `cleanup()` after use.

- `src/utils/attachments.ts` — `createAttachmentMessage()`
  Creates hook result messages. Types: `hook_success`, `hook_non_blocking_error`, `hook_cancelled`. Used by all hook executors.

## Common Tasks

### Writing a TS hook module

Create a `.ts` file that default-exports an async function:

```typescript
// .claude/hooks/validate-bash.ts
export default async function(
  input: {
    hook_event_name: string
    tool_name?: string
    tool_input?: Record<string, unknown>
  },
  signal: AbortSignal,
) {
  // Return null/undefined for pass-through (no action)
  if (input.tool_name !== 'Bash') return null

  const cmd = input.tool_input?.command as string
  if (cmd?.includes('rm -rf /')) {
    return { decision: 'block', reason: 'Dangerous command blocked' }
  }
  return null // approve by default
}
```

Configure in `settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "ts",
        "path": ".claude/hooks/validate-bash.ts",
        "timeout": 10
      }]
    }]
  }
}
```

### Adding a new serializable hook type

1. Define schema in `buildHookSchemas()` in `src/schemas/hooks.ts`:
```typescript
const MyNewHookSchema = z.object({
  type: z.literal('mynew'),
  // ... fields
  if: IfConditionSchema(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
})
```
2. Add `MyNewHookSchema` to `buildHookSchemas()` return object
3. Add `MyNewHookSchema` to `HookCommandSchema` `z.discriminatedUnion` array
4. Export type: `export type MyNewHook = Extract<HookCommand, { type: 'mynew' }>`
5. Create executor `src/utils/hooks/execMyNewHook.ts` following `execTsHook` pattern
6. Add dispatch branch in `src/utils/hooks.ts` (after 'agent', before 'http')
7. Add display text in `hooksSettings.ts` `getHookDisplayText()`

### Debugging hook path resolution

Set `CLAUDE_CODE_DEBUG=1` and look for log lines:
- `Hooks: TS hook resolving path: ./foo.ts → /absolute/path/foo.ts`
- `TS hook blocked: path "..." is outside project directory and ~/.claude/`

Path is resolved via `path.resolve(getCwd(), hook.path)` for relative paths. Only paths under `getCwd()` or `getClaudeConfigHomeDir()` are allowed.

## Rules

- TS hook modules MUST default-export an async function. Named exports are ignored.
- Return `null`/`undefined` for pass-through (treated as success with no output).
- Return `{ decision: 'block', reason: '...' }` to block the operation.
- Output is validated against `hookJSONOutputSchema()` — invalid returns become non-blocking errors.
- Path security: modules must reside under project directory or `~/.claude/`. This is enforced by `isPathAllowed()` in `execTsHook.ts:36`.
- Default timeout is 30 seconds (`DEFAULT_TS_HOOK_TIMEOUT_MS`). Override via `timeout` field in seconds.
- Dispatch uses lazy import (`await import('./hooks/execTsHook.js')`) — do the same for new hook executors to avoid loading unused modules.
- Always inject timing fields (`command`, `durationMs`) into the attachment message after execution, matching the pattern at `hooks.ts:2307-2314`.

## Integration Points

| Component | File | Key location |
|-----------|------|-------------|
| TsHookSchema definition | `src/schemas/hooks.ts` | line 166-187 |
| Discriminated union | `src/schemas/hooks.ts` | line 209-215 (`HookCommandSchema`) |
| TsHook type export | `src/schemas/hooks.ts` | line 248 |
| Executor implementation | `src/utils/hooks/execTsHook.ts` | line 53 (`execTsHook`) |
| Path security check | `src/utils/hooks/execTsHook.ts` | line 36 (`isPathAllowed`) |
| Default timeout constant | `src/utils/hooks/execTsHook.ts` | line 31 (`DEFAULT_TS_HOOK_TIMEOUT_MS`) |
| Dispatch branch | `src/utils/hooks.ts` | line 2297-2321 |
| Display text | `src/utils/hooks/hooksSettings.ts` | `getHookDisplayText()` |
| Output schema | `src/types/hooks.ts` | line 169 (`hookJSONOutputSchema`) |
| HookResult type | `src/types/hooks.ts` | line 260 |

## Validation

- Configure a `type: 'ts'` hook in `settings.json`, trigger the hook event, and verify the module is called.
- Test path outside project dir → expect `TS hook blocked` error.
- Test module without default export → expect `does not export a default function` error.
- Test invalid return value → expect `output validation failed` error.
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Running heavy computation or I/O in TS hooks without respecting the abort signal — always check `signal.aborted` and pass `signal` to async operations.
- Using `require()` instead of `export default` in hook modules — only ES module default export is supported.
- Placing hook modules outside project directory or `~/.claude/` — they will be blocked by the security check.
- Using top-level `import` for `execTsHook` in the dispatch — use lazy `await import()` to avoid loading unused code.
- Hardcoding hook type checks with string matching instead of using the Zod discriminated union pattern.
- Creating a new hook executor that returns raw data instead of `HookResult` — all executors must return `HookResult` for the dispatch to work uniformly.
