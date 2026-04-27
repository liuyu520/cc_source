---
name: "lazy-context-injection-reuse"
description: "Reuse the lazy/deferred context injection pattern (module-scope trigger with TTL decay, multi-point hooks, first-full-then-short differential, lazy-stub + ranker + dormant gate for listing-type content, env var gating) when adding new context sections that should skip injection until needed, or reducing per-turn overhead for invariant/listing content in third-party API mode."
---

# Lazy Context Injection Reuse

Use this skill when adding new content sections to the system prompt or conversation context that should be deferred until actually needed, implementing first-full-then-short differential injection for invariant context, or when you are about to ship listing-type content (skills/commands/tools catalog) that should not be eagerly injected into a third-party API system prompt.

## Architecture Overview

Three complementary patterns solve the same problem — invariant or long content being repeatedly sent to APIs without prompt caching:

```
Pattern A: TTL-decayed Lazy Trigger (Skills Listing, 2026-04-27)
  Default: skip catalog entirely for third-party / Codex providers
  Trigger: SkillTool.call() / /skill slash command → markSkillsTriggered()
           OR user input includes "load skill" → enableExplicitSkillLoading()
  After trigger: inject catalog on subsequent turns WITHIN 15 min
  After TTL:     auto-decay back to lazy — avoids session-wide eager lock-in
  Stub when lazy: one-shot ~40-token stub ("lazy-loaded, type 'load skill'")
                  instead of empty attachment, to suppress hallucinated
                  /<skill-name> calls
  Env overrides: CLAUDE_CODE_ENABLE_SKILLS=1         → always eager
                 CLAUDE_CODE_SKILL_TRIGGER_TTL_MS=N  → change window
                 CLAUDE_CODE_DISABLE_LAZY_SKILL_STUB=1 → suppress the stub

Pattern B: First-Full-Then-Short (gitStatus)
  Turn 1: inject full content (100-500 tokens)
  Turn 2+: inject "unchanged since conversation start" (6 tokens)
  Cache clear: reset counter → next turn is "new Turn 1"
  Env override: CLAUDE_CODE_GIT_STATUS_DIFF=0 → always full

Pattern C: Listing Ranker + Dormant Gate + Folding (listing-type content)
  Even when Pattern A fires, the catalog itself can be noisy. Apply:
  • Ranker:  keyword(Jaccard) + frequency + bundled + (optional) route prior
  • Dormant: hide items with no invocation in N days, unless rescued by
             keyword match or ε-greedy exploration picks the oldest one
  • Folding: non-bundled items with same prefix and ≥ N members collapse
             to `- prefix-* (N entries: a, b, c, ...)` after a protected top
  • Counter-metric: read-only `/skill-roi` command surfaces Top + dormant
    + switch matrix for audit.
```

All three patterns share the same building blocks:

```
module-scope flag / counter / timestamp  ← process-local state, reset on cache clear
   ↓
multi-point trigger hooks                 ← user action / tool call / slash command
   ↓
env var gating (force on/off)             ← escape hatch for debugging / A/B testing
   ↓
provider detection                        ← getAPIProvider() === 'thirdParty' → apply
```

## Reuse First

- `src/utils/attachments.ts:2870-2908` — `lastSkillsTriggeredAt` (timestamp, NOT a boolean) + `markSkillsTriggered()` / `isSkillsTriggered()` / `resetSkillsTriggered()`.
  15-min TTL gate, overridable via `CLAUDE_CODE_SKILL_TRIGGER_TTL_MS`. Replaces the older boolean latch. Copy this pattern for any new lazy content that should *auto-decay* back to inactive after a burst of usage.

- `src/utils/attachments.ts:2823` — `LAZY_SKILL_STUB_SENTINEL` + one-shot stub emission at `:2955-2979`.
  Emits a tiny attachment instead of `[]` when the gate is closed. Placed AFTER the SkillTool availability check so sub-agents without the tool see nothing. Template for "absence is information" — suppresses hallucinated tool use without spending real budget.

- `src/skills/loadSkillsDir.ts:858` — `enableExplicitSkillLoading()` module-level flag for the disk-scan gate.
  Four short-circuit points in `loadSkillsDir.ts` (main scan / dynamic directories / dynamic skills / additional discovery) all read the same flag. Template for multi-entry scans that should stay entirely cold until the user opts in.

- `src/screens/REPL.tsx:3304` — REPL substring trigger `input.includes('load skill')` → `enableExplicitSkillLoading()` + `skillChangeDetector.initialize()` + `clearCommandsCache()`.
  Template for user-intent-keyword triggers that need BOTH a flag flip and a downstream cache reset / detector warm-up.

- `src/context.ts:174` — `gitStatusInjectionCount` counter + `getEffectiveSystemContext()`
  First call returns full, subsequent calls return short placeholder. Reset in `setSystemPromptInjection()` when cache is cleared. Pattern B template.

- `src/tools/SkillTool/SkillTool.ts:601` — SkillTool trigger hook: `await import('../../utils/attachments.js').then(m => m.markSkillsTriggered())` in the `call()` method.

- `src/utils/processUserInput/processSlashCommand.tsx:388` — Slash-command trigger hook for `/skill*`.

- `src/context.ts:30` — `setSystemPromptInjection()` cache clear + counter reset. Any new differential injection must wire into this reset path.

- `src/skills/skillListingRanker.ts` — ranker + dormant gate + ε-greedy (Pattern C core).
  `rankSkillsForListing(commands, userInput?, routeSnapshot?)` returns a stable-reordered list. Bundled skills are pinned first; non-bundled bucket is sorted by keyword × frequency × route. Dormant (> `CLAUDE_CODE_SKILL_DORMANT_DAYS`, default 30) items are dropped unless rescued by keyword or the epsilon-greedy rescue roll.

- `src/tools/SkillTool/prompt.ts:106-169` — `maybeFoldNonBundled()` same-prefix grouping. Called inside `formatCommandsWithinBudget()` at `:173`. Protects the top N (default 20) and bundled skills from being folded.

- `src/commands/skill-roi/index.ts` — read-only `/skill-roi` counter-metric command. Template for observability commands that audit a lazy/ranked subsystem from a user-visible angle without changing its behaviour.

## Module-Scope State Pattern

All lazy injection uses the **module-scope process-level state** idiom — lightweight, no serialization, automatic cleanup on process exit.

TTL-decayed trigger (preferred — replaces the old boolean latch):
```typescript
// Timestamp of most recent trigger fire, null when never triggered.
let lastTriggeredAt: number | null = null
const DEFAULT_TTL_MS = 15 * 60 * 1000

function getTtlMs(): number {
  const raw = process.env.MY_CONTENT_TRIGGER_TTL_MS
  if (!raw) return DEFAULT_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS
}

export function markTriggered(): void {
  lastTriggeredAt = Date.now()
}

export function isTriggered(): boolean {
  if (lastTriggeredAt === null) return false
  return Date.now() - lastTriggeredAt <= getTtlMs()
}

// Required for cache-clear / test reset
export function resetTrigger(): void {
  lastTriggeredAt = null
}
```

For counter-based differential (Pattern B, gitStatus):
```typescript
let injectionCount = 0
const UNCHANGED_MARKER = 'unchanged since conversation start'

export function getEffectiveContent(fullContent: string): string {
  injectionCount++
  if (injectionCount <= 1) return fullContent
  // env flag check, provider check...
  return UNCHANGED_MARKER
}

export function resetInjectionCount(): void {
  injectionCount = 0
}
```

## Common Tasks

### Adding a new lazy-injectable content section

1. Add the TTL-decayed flag module-scope (template above).
2. Add the gate in the content generation function:
```typescript
function getMyContent(): string | null {
  try {
    const { getAPIProvider } = require('./model/providers.js')
    if (getAPIProvider() === 'thirdParty') {
      const eager = !!process.env.MY_CONTENT_EAGER
      if (!eager && !isTriggered()) return null
    }
  } catch {}
  return actualContent
}
```
3. Add trigger hooks at ALL entry points (tool call, slash command, user-intent keyword in REPL).
4. Wire `resetTrigger()` into `setSystemPromptInjection()` in `context.ts` if the content is injected via system prompt.
5. Consider emitting a tiny stub instead of `[]` when gated, to suppress hallucinated invocations — see the `LAZY_SKILL_STUB_SENTINEL` template. De-dupe the stub per agent by sharing the same sentinel key the content uses.

### Adding a listing-type content section (catalog / registry)

If the new content is a *list of options* the model chooses from (skills, MCP tools, catalogs), Pattern A alone is not enough. Also apply Pattern C:

1. Build a small ranker that scores each entry on `[0,1]` against a few weak signals (keyword Jaccard against user input, historical usage frequency from a JSON stats file, baseline bundled bonus, optional learner prior).
2. Add a dormant gate with a keyword-rescue path and a small ε-greedy exploration rate so entries never permanently disappear.
3. In the budget formatter, collapse same-prefix groups after a protected top N; keep bundled items un-folded.
4. Add a read-only audit command mirroring `/skill-roi` so the behavior is observable without patching prints.
5. Keep every knob behind a `CLAUDE_CODE_<NAMESPACE>_*` env var with a safe default.

### Converting existing eager content to lazy

1. Identify the content and its per-turn token cost.
2. Identify the trigger condition (tool call, user-intent keyword, slash command).
3. Add timestamp flag + gate + hooks following the TTL-decayed template.
4. Add env var override (force eager + TTL length) for escape hatch.
5. Update `docs/token-efficiency-methodology.md` audit table.

### Adding first-full-then-short for invariant context

1. Add counter (not timestamp) at module scope — counters track "how many times injected".
2. Add `getEffective*()` wrapper that returns full on first call, short on subsequent.
3. Wire counter reset into cache-clear path.
4. Add env var: `*_DIFF=0` force off, `=1` force on, unset → auto per provider.

## Trigger Point Checklist

Any lazy-injectable content needs triggers at ALL points where the user might need it:

| Trigger type         | Where to hook                               | Example                          |
|----------------------|---------------------------------------------|----------------------------------|
| Tool call            | Tool's `call()` method                      | SkillTool.ts:601                 |
| Slash command        | processSlashCommand.tsx                     | :388                             |
| User intent keyword  | REPL input handler (substring match, trim)  | REPL.tsx:3304 `includes('load skill')` |
| Auto-detect          | The gate function itself                    | `knownSkillNames.size > 0`       |

Missing a trigger means the content won't be injected when needed — resulting in degraded model behavior without clear error messages.

## Env Var Convention

Follow the existing naming convention:

```bash
# Lazy injection (boolean: eager=always inject, unset=lazy with TTL)
CLAUDE_CODE_ENABLE_SKILLS=1               # Skills listing: force eager inject
CLAUDE_CODE_SKILL_TRIGGER_TTL_MS=900000   # TTL window override (default 15 min)
CLAUDE_CODE_DISABLE_LAZY_SKILL_STUB=1     # Suppress the absence-stub
MY_CONTENT_EAGER=1                        # Your new content: force eager inject
MY_CONTENT_TRIGGER_TTL_MS=N               # Your new content: override window

# Differential injection (tri-state: 0=always full, 1=force diff, unset=auto)
CLAUDE_CODE_GIT_STATUS_DIFF=0             # gitStatus: always full (disable diff)
CLAUDE_CODE_GIT_STATUS_DIFF=1             # gitStatus: force diff (even first-party)

# Listing ranker / dormant / folding (Pattern C)
CLAUDE_CODE_DISABLE_SKILL_RANKER=1        # Full bypass, original order
CLAUDE_CODE_DISABLE_DORMANT_GATE=1        # Keep scoring, skip dormant removal
CLAUDE_CODE_DISABLE_SKILL_FOLDING=1       # No same-prefix collapsing
CLAUDE_CODE_SKILL_DORMANT_DAYS=30         # Dormant window
CLAUDE_CODE_SKILL_RANK_EXPLORE_EPSILON=0.1 # ε-greedy rescue rate
CLAUDE_CODE_SKILL_RANK_W_KEYWORD=0.5      # Per-signal weights
CLAUDE_CODE_SKILL_RANK_W_FREQUENCY=0.4
CLAUDE_CODE_SKILL_RANK_W_BUNDLED=0.1
CLAUDE_CODE_SKILL_RANK_W_ROUTE=0.1
CLAUDE_CODE_SKILL_FOLD_PROTECT_TOP=20     # Top N never folded
CLAUDE_CODE_SKILL_FOLD_MIN_GROUP=3        # Group must have ≥N members to fold
```

Auto behavior: third-party API / Codex → apply optimization; first-party → skip (prompt cache handles it).

## Integration Points

| Component                       | File                                | Key line                          |
|---------------------------------|-------------------------------------|-----------------------------------|
| Skills trigger timestamp        | `attachments.ts`                    | :2870-2908                        |
| Skills lazy-stub sentinel       | `attachments.ts`                    | :2823 + :2955-2979                |
| Skills listing ranker wire      | `attachments.ts`                    | :3056 (`rankSkillsForListing`)    |
| Skills tool trigger             | `SkillTool.ts`                      | :601 (`markSkillsTriggered`)      |
| Skills command trigger          | `processSlashCommand.tsx`           | :388 (`markSkillsTriggered`)      |
| Skills REPL substring trigger   | `REPL.tsx`                          | :3304 (`includes('load skill')`)  |
| Disk-scan gate                  | `loadSkillsDir.ts`                  | :858 (`enableExplicitSkillLoading`) |
| Listing ranker module           | `skills/skillListingRanker.ts`      | `rankSkillsForListing()`          |
| Folding logic                   | `tools/SkillTool/prompt.ts`         | :106 (`maybeFoldNonBundled`)      |
| Budget formatter wire           | `tools/SkillTool/prompt.ts`         | :173 (`formatCommandsWithinBudget`) |
| Counter-metric command          | `commands/skill-roi/index.ts`       | whole file                        |
| gitStatus counter               | `context.ts`                        | :174 (`gitStatusInjectionCount`)  |
| gitStatus differential          | `context.ts`                        | :184 (`getEffectiveSystemContext`) |
| gitStatus call site             | `query.ts`                          | :552                              |
| Counter reset on cache clear    | `context.ts`                        | :36 (`setSystemPromptInjection`)  |
| Provider detection              | `utils/model/providers.ts`          | :38 (`getAPIProvider`)            |

## Rules

- Module-scope state MUST be resettable — always export a `reset*()` function for cache-clear and tests.
- Trigger hooks MUST be wrapped in try/catch — module import failures must never block the primary code path.
- Use `await import()` (dynamic import) in tools/commands, `require()` (sync) in hot paths like message processing.
- Prefer the **TTL-decayed timestamp** over a boolean latch. A latch causes session-wide eager lock-in after one trigger; the timestamp decays back automatically.
- For listing-type content, never ship Pattern A alone. Combine with Pattern C (ranker + dormant + folding). Otherwise a lazy catalog becomes an eager catalog as soon as the trigger fires, and you have only delayed the waste.
- Emit an absence-stub instead of `[]` for content the model might attempt to invoke anyway — cheaper than hallucination recovery. Skip the stub for sub-agents that can't use the tool.
- Never rely on a single trigger point — REPL + tool.call() + /command all need hooks so user behavior is consistent.
- `getAPIProvider()` requires BOTH `ANTHROPIC_BASE_URL` (non-Anthropic host) AND `ANTHROPIC_API_KEY` to return `'thirdParty'`. Don't test with only one.
- First-party API should NOT use differential / lazy injection by default — prompt caching already handles invariant deduplication. Force-on env var is for debugging only.
- Default all Pattern C knobs to *safe fail-open* values. If the ranker crashes, the listing should degrade to original order, not crash the attachment.

## Validation

- Trigger decay: `ANTHROPIC_BASE_URL=https://api.test.com ANTHROPIC_API_KEY=test bun -e "import { markSkillsTriggered, isSkillsTriggered } from './src/utils/attachments.ts'; markSkillsTriggered(); console.log('after mark:', isSkillsTriggered())"` — must print `true`.
- Lazy-stub one-shot: call `getSkillListingAttachments` twice in the same agentId with no trigger — first call returns stub, second returns `[]`.
- Ranker fail-open: `CLAUDE_CODE_DISABLE_SKILL_RANKER=1 bun -e "...rankSkillsForListing(cmds,'x')"` must return the input order.
- Dormant gate rescue: feed an input whose tokens intersect the dormant skill's name — it must NOT be dropped.
- Folding protection: the top N (default 20) after ranking must never appear inside `prefix-* (...)` collapses.
- Smoke `/skill-roi`: loads without error, reports total/top/dormant/switches.
- Differential injection: set both `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`, then call `getEffectiveSystemContext()` twice — first full, second short marker.
- `bun run version` to confirm no import breakage.

## Anti-Patterns

- Using a boolean latch for a trigger that should decay back to inactive — session-wide eager lock-in.
- Using global mutable state (singleton class, global object) instead of module-scope primitives — over-engineered for a timestamp/counter.
- Forgetting to wire reset into cache-clear path — stale flags cause content to be injected forever or never re-injected after compact.
- Testing third-party detection with only `ANTHROPIC_BASE_URL` — `getAPIProvider()` also needs `ANTHROPIC_API_KEY` to return `'thirdParty'`.
- Making the lazy gate async — the content generation function may be synchronous; async gates force all callers to become async.
- Putting all trigger hooks in one central file — triggers belong at the point of user action (tool call, command dispatch), not in a centralized "trigger registry".
- Applying differential injection to content that DOES change during the session — e.g., conversation history should use compression (scheme 6), not differential injection.
- Shipping Pattern A (lazy trigger) on listing-type content without Pattern C (ranker + dormant + folding) — you only delayed the waste, not reduced it.
- Returning `[]` from a gated content path when the model might still hallucinate invoking it — a tiny stub is almost always cheaper than recovery.
- Creating a new env var namespace per feature — follow `CLAUDE_CODE_*` and keep names discoverable; avoid per-feature prefixes that won't be found via grep.
