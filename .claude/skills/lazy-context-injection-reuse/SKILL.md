---
name: "lazy-context-injection-reuse"
description: "Reuse the lazy/deferred context injection pattern (module-scope trigger flag, multi-point hooks, first-full-then-short differential, env var gating) when adding new context sections that should skip injection until needed, or reducing per-turn overhead for invariant content in third-party API mode."
---

# Lazy Context Injection Reuse

Use this skill when adding new content sections to the system prompt or conversation context that should be deferred until actually needed, implementing first-full-then-short differential injection for invariant context, or reducing per-turn token overhead for third-party APIs without prompt caching.

## Architecture Overview

Two complementary patterns solve the same problem — invariant content being repeatedly sent to APIs without prompt caching:

```
Pattern A: Lazy Trigger (Skills Listing)
  Default: skip entirely for third-party API
  Trigger: SkillTool.call() / /skill slash command → markSkillsTriggered()
  After trigger: inject normally on all subsequent turns
  Env override: CLAUDE_CODE_ENABLE_SKILLS=1 → always inject (eager)

Pattern B: First-Full-Then-Short (gitStatus)
  Turn 1: inject full content (100-500 tokens)
  Turn 2+: inject "unchanged since conversation start" (6 tokens)
  Cache clear: reset counter → next turn is "new Turn 1"
  Env override: CLAUDE_CODE_GIT_STATUS_DIFF=0 → always full
```

Both patterns share the same building blocks:

```
module-scope flag/counter      ← process-local state, reset on cache clear
   ↓
multi-point trigger hooks      ← user action / tool call / slash command
   ↓
env var gating (force on/off)  ← escape hatch for debugging / A/B testing
   ↓
provider detection             ← getAPIProvider() === 'thirdParty' → apply
```

## Reuse First

- `src/utils/attachments.ts:2721` — `skillsTriggered` flag + `markSkillsTriggered()` / `resetSkillsTriggered()`
  Module-scope boolean that flips from `false` to `true` when any trigger fires. The gate logic at `:2756` checks `eager || skillsTriggered || knownSkillNames.size > 0`. Copy this pattern for new lazy-injectable content sections.

- `src/context.ts:174` — `gitStatusInjectionCount` counter + `getEffectiveSystemContext()`
  Module-scope counter that increments on each call. First call (count <= 1) returns original content; subsequent calls return short placeholder. Reset in `setSystemPromptInjection()` when cache is cleared. Copy this pattern for content that's always eventually needed but doesn't change.

- `src/tools/SkillTool/SkillTool.ts:597` — SkillTool trigger hook
  `await import('../../utils/attachments.js').then(m => m.markSkillsTriggered())` in the `call()` method. Template for tool-triggered injection.

- `src/utils/processUserInput/processSlashCommand.tsx:388` — Slash command trigger hook
  Same pattern, fires on `/skill` dispatch. Template for command-triggered injection.

- `src/context.ts:30` — `setSystemPromptInjection()` cache clear + counter reset
  When caches are cleared, injection counters must reset so the next turn gets full content again. Any new differential injection must wire into this reset path.

## Module-Scope State Pattern

All lazy injection uses the **module-scope process-level state** idiom — lightweight, no serialization, automatic cleanup on process exit:

```typescript
// The trigger flag — starts false, flips once, stays true for the process lifetime
let myContentTriggered = false

export function markMyContentTriggered(): void {
  if (!myContentTriggered) {
    myContentTriggered = true
    logForDebugging('[myContent] lazy-injection triggered')
  }
}

// Required for cache-clear / test reset
export function resetMyContentTriggered(): void {
  myContentTriggered = false
}
```

For counter-based differential (gitStatus pattern):
```typescript
let injectionCount = 0
const UNCHANGED_MARKER = 'unchanged since conversation start'

export function getEffectiveContent(fullContent: string): string {
  injectionCount++
  if (injectionCount <= 1) return fullContent
  // env flag check, provider check...
  return UNCHANGED_MARKER
}

// Wire into cache-clear path
export function resetInjectionCount(): void {
  injectionCount = 0
}
```

## Common Tasks

### Adding a new lazy-injectable content section

1. Add module-scope flag in the file where the content is generated:
```typescript
let myContentTriggered = false
export function markMyContentTriggered(): void { /* flip once */ }
export function resetMyContentTriggered(): void { myContentTriggered = false }
```

2. Add gate in the content generation function:
```typescript
function getMyContent(): string | null {
  try {
    const { getAPIProvider } = require('./model/providers.js')
    if (getAPIProvider() === 'thirdParty') {
      const eager = !!process.env.MY_CONTENT_EAGER
      if (!eager && !myContentTriggered) return null
    }
  } catch {}
  return actualContent
}
```

3. Add trigger hooks at all entry points (tool call, slash command, user intent):
```typescript
// In the tool's call() method:
try {
  const { markMyContentTriggered } = await import('./myModule.js')
  markMyContentTriggered()
} catch {}
```

4. Wire reset into `setSystemPromptInjection()` in `context.ts` if the content is injected via system prompt:
```typescript
export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  gitStatusInjectionCount = 0
  // NEW: reset your counter
  resetMyContentTriggered()
}
```

### Converting existing eager content to lazy

1. Identify the content and its per-turn token cost
2. Identify the trigger condition (tool call, user intent keyword, slash command)
3. Add flag + gate + hooks following the pattern above
4. Add env var override (force eager) for escape hatch
5. Update `docs/token-efficiency-methodology.md` audit table

### Adding first-full-then-short for invariant context

1. Add counter (not boolean) at module scope — counters track "how many times injected"
2. Add `getEffective*()` wrapper that returns full on first call, short on subsequent
3. Wire counter reset into cache-clear path
4. Add env var: `*_DIFF=0` force off, `=1` force on, unset → auto per provider

## Trigger Point Checklist

Any lazy-injectable content needs triggers at ALL points where the user might need it:

| Trigger type | Where to hook | Example |
|-------------|--------------|---------|
| Tool call | Tool's `call()` method | SkillTool.ts:597 |
| Slash command | processSlashCommand.tsx | :388 |
| User intent keyword | processUserInput.ts | (via toolRouter.ts pattern) |
| Auto-detect from context | The gate function itself | `knownSkillNames.size > 0` |

Missing a trigger means the content won't be injected when needed — resulting in degraded model behavior without clear error messages.

## Env Var Convention

Follow the existing naming convention:

```bash
# Lazy injection (boolean: eager=always inject, unset=lazy)
CLAUDE_CODE_ENABLE_SKILLS=1        # Skills listing: force eager inject
MY_CONTENT_EAGER=1                 # Your new content: force eager inject

# Differential injection (tri-state: 0=always full, 1=force diff, unset=auto)
CLAUDE_CODE_GIT_STATUS_DIFF=0      # gitStatus: always full (disable diff)
CLAUDE_CODE_GIT_STATUS_DIFF=1      # gitStatus: force diff (even first-party)
```

Auto behavior: third-party API → apply optimization; first-party → skip (prompt cache handles it).

## Integration Points

| Component | File | Key line |
|-----------|------|----------|
| Skills lazy flag | `attachments.ts` | :2721 (`skillsTriggered`) |
| Skills gate | `attachments.ts` | :2756 (eager/triggered check) |
| Skills tool trigger | `SkillTool.ts` | :597 (`markSkillsTriggered`) |
| Skills command trigger | `processSlashCommand.tsx` | :388 (`markSkillsTriggered`) |
| gitStatus counter | `context.ts` | :174 (`gitStatusInjectionCount`) |
| gitStatus differential | `context.ts` | :184 (`getEffectiveSystemContext`) |
| gitStatus call site | `query.ts` | :552 (`getEffectiveSystemContext(systemContext)`) |
| Counter reset on cache clear | `context.ts` | :36 (`setSystemPromptInjection`) |
| Provider detection | `providers.ts` | :38 (`getAPIProvider`) |

## Rules

- Module-scope state MUST be resettable — always export a `reset*()` function for cache-clear and tests.
- Trigger hooks MUST be wrapped in try/catch — module import failures must never block the primary code path.
- Use `await import()` (dynamic import) in tools/commands, `require()` (sync) in hot paths like message processing.
- The lazy pattern (Pattern A) is for content that may never be needed. The differential pattern (Pattern B) is for content that's always needed but doesn't change. Don't mix them up.
- Never rely on a single trigger point — if SkillTool triggers skills injection but `/skill` doesn't, users get inconsistent behavior.
- `getAPIProvider()` requires BOTH `ANTHROPIC_BASE_URL` (non-Anthropic host) AND `ANTHROPIC_API_KEY` to return `'thirdParty'`. Don't test with only one.
- First-party API should NOT use differential injection by default — prompt caching already handles invariant deduplication. Force-on env var is for debugging only.

## Validation

- Lazy injection off: `ANTHROPIC_BASE_URL=https://api.test.com ANTHROPIC_API_KEY=test bun -e "import { resetSkillsTriggered } from './src/utils/attachments.ts'; console.log('flag system works')"` — verify module loads.
- Differential injection: set both `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`, then call `getEffectiveSystemContext()` twice — first should return full, second should return marker.
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Using global mutable state (singleton class, global object) instead of module-scope primitives — over-engineered for a boolean/counter.
- Forgetting to wire reset into cache-clear path — stale flags cause content to be injected forever or never re-injected after compact.
- Testing third-party detection with only `ANTHROPIC_BASE_URL` — `getAPIProvider()` also needs `ANTHROPIC_API_KEY` to return `'thirdParty'`.
- Making the lazy gate async — the content generation function may be synchronous; async gates force all callers to become async.
- Putting all trigger hooks in one central file — triggers belong at the point of user action (tool call, command dispatch), not in a centralized "trigger registry".
- Applying differential injection to content that DOES change during the session — e.g., conversation history should use compression (scheme 6), not differential injection.
