---
name: "slash-command-creation-reuse"
description: "Reuse existing slash command patterns (spec, call, index.ts, commands.ts registration) when creating new /commands. Covers command types, context access, setMessages, onDone, resume, and registration flow."
---

# Slash Command Creation Reuse

Use this skill when creating a new `/command`, modifying existing command behavior, or understanding the command registration and execution flow.

## Command Architecture

```
User types /mycommand
         ↓
commands.ts COMMANDS array          ← memoized list, alphabetical
         ↓
Command.load()                      ← lazy import of implementation module
         ↓
module.call(onDone, context, args)  ← execution with full ToolUseContext
         ↓
onDone(message, options?)           ← signal completion to REPL
```

## File Structure Convention

```
src/commands/
  my-command/              ← kebab-case directory name
    index.ts               ← Command descriptor (type, name, description, load)
    my-command.ts           ← Implementation (spec + call function)
```

## Step-by-Step: Creating a New Command

### 1. Create index.ts (descriptor)

```typescript
// src/commands/my-command/index.ts
import type { Command } from '../../commands.js'

const myCommand = {
  type: 'local-jsx',            // most commands use this type
  name: 'my-command',           // matches what user types after /
  description: 'Short description shown in command picker',
  isEnabled: true,
  isHidden: false,
  userFacing: true,
  argumentHint: '[optional-arg]', // shown in help, omit if no args
  load: () => import('./my-command.js'),
} satisfies Command

export default myCommand
```

**Reference:** `src/commands/branch/index.ts`, `src/commands/rollback/index.ts`

### 2. Create implementation file

```typescript
// src/commands/my-command/my-command.ts
import React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export const spec = {
  name: 'my-command',
  description: 'Short description',
  isEnabled: true,
  isHidden: false,
  userFacing: true,
  argDescription: '',  // describe args if any
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  // Implementation here

  onDone('Success message', { display: 'system' })
  return null
}
```

**Reference:** `src/commands/rollback/rollback.ts`, `src/commands/branch/branch.ts`

### 3. Register in commands.ts

```typescript
// src/commands.ts — two changes:

// 1. Add import (alphabetical order among other command imports)
import myCommand from './commands/my-command/index.js'

// 2. Add to COMMANDS array (alphabetical position)
const COMMANDS = memoize((): Command[] => [
  // ...
  myCommand,
  // ...
])
```

**Reference:** `src/commands.ts` lines 137-155 (imports), lines 264-330 (COMMANDS array)

## Context API (`LocalJSXCommandContext`)

The `context` parameter extends `ToolUseContext` with command-specific fields:

| Field | Type | Purpose | Example |
|-------|------|---------|---------|
| `setMessages` | `(updater: (prev: Message[]) => Message[]) => void` | Modify conversation history | `context.setMessages(() => newMsgs)` |
| `resume` | `(sessionId, log, entrypoint) => Promise<void>` | Switch to another session | Used by `/branch`, `/resume` |
| `canUseTool` | `CanUseToolFn` | Check tool permissions | |
| `options.theme` | `ThemeName` | Current UI theme | |
| `onChangeAPIKey` | `() => void` | Trigger API key change flow | |

### Modifying conversation state

```typescript
// Replace all messages (like /rollback)
context.setMessages(() => restoredMessages)

// Clear all messages (like /clear)
context.setMessages(() => [])

// Append a message
context.setMessages(prev => [...prev, newMessage])

// Filter messages
context.setMessages(prev => prev.filter(m => m.type !== 'progress'))
```

### Signaling completion

```typescript
// Simple text output
onDone('Operation complete')

// System-style display (dimmed, non-conversation)
onDone('Branched successfully.', { display: 'system' })
```

### Switching sessions (like /branch)

```typescript
if (context.resume) {
  await context.resume(newSessionId, forkLog, 'fork')
  onDone('Switched to new session.', { display: 'system' })
}
```

## Command Types

| Type | Description | Example |
|------|-------------|---------|
| `local-jsx` | Most common. Returns ReactNode, has full context access. | `/branch`, `/rollback`, `/clear` |
| `local` | Simpler commands, no JSX return. | `/version`, `/exit` |
| `prompt` | Injects text into the conversation as a user prompt. | `/review`, `/commit` |

## Reuse First

- `src/types/command.ts` — `CommandBase` (line 175), `Command` (line 211)
  Full type definition for all command fields: `availability`, `isEnabled`, `isHidden`, `aliases`, `argumentHint`, `whenToUse`, `immediate`, `isSensitive`, `next`, `depends`, `workflowGroup`. Check these before inventing new fields.

- `src/types/command.ts` — `LocalJSXCommandContext` (line 80)
  Full type definition for command context. Includes `setMessages`, `resume`, `options`, `canUseTool`, `onChangeAPIKey`.

- `src/types/command.ts` — `getCommandName()` (line 215), `isCommandEnabled()` (line 219)
  Shared helpers for resolving display name and enabled state. Reuse these instead of direct field access.

- `src/commands.ts` — `COMMANDS` array (line 264)
  Memoized command list. All commands registered here. `getCommands(cwd)` (line 488) applies `meetsAvailabilityRequirement()` + `isCommandEnabled()` filters.

- `src/commands.ts` — `meetsAvailabilityRequirement()` (line 429)
  Provider-gating: checks `availability` field against current auth type (claude-ai, console). Reuse this for commands that should only appear for specific providers.

- `src/commands.ts` — `loadAllCommands()` (line 461)
  Merges COMMANDS + skill dir commands + plugin commands + MCP commands. Memoized per cwd. Call `clearCommandsCache()` (line 544) when dynamically adding commands.

- `src/commands/branch/branch.ts` — Complex command example
  Shows: session forking via `createFork()`, JSONL file creation, `context.resume()`, `saveCustomTitle()`, error handling.

- `src/commands/rollback/rollback.ts` — Simple command example
  Shows: session state restore via `setMessages()`, service layer interaction, best-effort cleanup.

- `src/commands/clear/conversation.ts` — State clearing example
  Shows: `setMessages(() => [])`, session regeneration, `executeSessionEndHooks()`, hook execution.

- `src/utils/messages.ts` — Message creation utilities
  `createUserMessage()` (line 460), `createAssistantMessage()` (line 411), `createSystemMessage()` (line 4371), `createProgressMessage()` (line 603). Reuse these instead of manually constructing message objects.

- `src/utils/sessionStorage.ts` — `saveCustomTitle()` (line 2619), `searchSessionsByCustomTitle()` (line 3149)
  Reuse these for commands that create or rename sessions.

## Validation

1. `bun run version` — verify no import breakage after registration
2. Boot CLI → type `/my-command` → verify it appears in command picker
3. Execute command → verify `onDone` message appears correctly
4. Check edge cases: no session, empty args, error paths

## Anti-Patterns

- Putting implementation directly in `index.ts` — always use lazy `load: () => import(...)` for code splitting
- Forgetting to add to both import AND COMMANDS array in `commands.ts` — command won't appear
- Using `console.log` instead of `onDone` — breaks REPL output flow
- Modifying `context` object directly — it's shared; use `setMessages` updater pattern
- Blocking on external I/O without try/catch — commands should handle errors gracefully
- Adding command to non-alphabetical position — breaks convention, harder to find
