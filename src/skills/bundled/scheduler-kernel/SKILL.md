---
description: How to extend the agentScheduler kernel's factory+registry abstractions — rate buckets, auto-continue strategies, snapshot stores, cold-start candidates, and shadow→episode writeback. Use when adding new rate-limit dimensions, auto-continue branches, cross-session persistence, cold-start seeds, or shadow-source episode feeders.
---

# Scheduler Kernel Extensions

Use this skill when extending the **agentScheduler kernel** with new registry entries.
The kernel exposes five factory+registry pairs, each with byte-identical public-API
contracts and a `/kernel-status` section for observability. Follow the matching
template exactly — you get priority ordering, error isolation, observability, and
test hooks for free.

## Registry Map

| Registry | Factory | Where it lives | `/kernel-status` section |
|----------|---------|----------------|--------------------------|
| RateBucket | `createRateBucket({dimension, windowMs, limit})` | `services/rateBucket/index.ts` | §4 Rate Buckets |
| AutoContinueStrategy | `registerAutoContinueStrategy({name, priority, detect, prompt})` | `services/autoContinue/strategyRegistry.ts` | §9 Auto-Continue Strategies |
| SnapshotStore | `createSnapshotStore({namespace, schemaVersion, getSnapshot, applySnapshot})` | `services/snapshotStore/snapshotStore.ts` | §10 Snapshot Stores |
| ColdStart | `registerColdStartCandidate({name, agentType, prompt, when})` | `services/agentScheduler/coldStart.ts` | §11 Cold-Start |
| Shadow→Episode | `createAgentRunEpisode({source:'shadow'})` + `appendEpisode` | `services/agentScheduler/codexShadowRunner.ts` + `services/episodicMemory/episodicMemory.ts` | Shadow Agent Runner `ep-writeback` |

All five are env-toggleable, error-isolated, and surface in `/kernel-status`.

## Shared Conventions (all templates follow these)

- **Registry Map semantics** — same `name` re-registered overwrites (idempotent);
  `list*` returns snapshot arrays; `__reset*ForTests()` clears state.
- **Priority ordering** — ascending (lower = earlier); tie-break by insertion order
  or alphabetical `name`. First applicable wins for evaluators.
- **Fire-and-forget persistence** — registry tick/evaluation never awaits an IO write.
  Wrap writes with `void ...` or `.then(...).catch(...)` and record `lastError`.
- **Hit/miss counters** — every registered entry has a monotonic counter; expose via
  `getAll*()` snapshot for `/kernel-status`.
- **Error isolation** — each entry's callback is wrapped in `try { ... } catch(e) { log; continue }`.
  One broken entry must never poison the loop.
- **Env opt-out** — every factory should read at least one `CLAUDE_CODE_*` env
  switch (feature gate) and a per-entry `isEnabled?: () => boolean` override.

## Template 1: RateBucket (sliding-window limiter)

Use when throttling a dimension other than input tokens — output tokens, $ cost,
per-provider concurrency, per-tool calls per minute.

### Step-by-Step

1. Define the dimension string (`'output-tokens'`, `'dollar-cost'`, `'<provider>-rpm'`).
2. Call `createRateBucket` **once** at module load.
3. Use the returned handle's `tryCharge(cost)` at the guard point.
4. Bucket auto-registers to global registry → appears in `/kernel-status` §4.

### Template

```typescript
// services/myFeature/outputTokensBucket.ts
import { createRateBucket } from '../rateBucket/index.js'

const bucket = createRateBucket({
  dimension: 'output-tokens',
  windowMs: 60_000,
  limit: () => Number(process.env.CLAUDE_CODE_OUTPUT_TOKEN_LIMIT) || 50_000,
})

// At guard point:
export function tryChargeOutput(estimate: number): boolean {
  return bucket.tryCharge(estimate)
}
export function getOutputTokenSnapshot() {
  return bucket.getSnapshot()  // used / limit / sampleCount / etc.
}
```

### Rules

- **`limit` is a function** — read env on every call so tests/config changes take effect
  without restart. Return `Infinity` when disabled.
- **One module = one dimension** — do NOT share a bucket across dimensions.
- **`windowMs` >= 1000** — sub-second windows thrash the ledger; use `intervalMs`
  elsewhere for rate-limit clocks under 1s.
- **Reuse existing tokenBudget as reference** — `services/agentScheduler/tokenBudget.ts`
  is a thin wrapper over createRateBucket; match its public-API style.

## Template 2: AutoContinueStrategy (priority-ordered detection)

Use when adding a new trigger for automatic re-prompt after an assistant turn
(e.g. "run tests passed, continue to next file", "max_tokens hit, resume output").

### Step-by-Step

1. Pick a `name` (kebab-case, unique across registry).
2. Pick a `priority` — ascending, lower first; see existing built-ins:
   - `max_tokens` → 10
   - `next_step_intent` → 20
3. Implement `detect(ctx)` — pure function returning boolean.
4. Implement `prompt(ctx)` — returns the re-prompt text (empty string = skip).

### Template

```typescript
// services/myFeature/testPassedStrategy.ts
import { registerAutoContinueStrategy } from '../autoContinue/index.js'

registerAutoContinueStrategy({
  name: 'test-passed',
  priority: 15,
  isEnabled: () => process.env.CLAUDE_CODE_AUTO_CONTINUE_ON_TEST === '1',
  detect: ctx =>
    ctx.stopReason !== 'tool_use' &&
    /tests? (passed|succeeded)/i.test(ctx.text),
  prompt: _ctx => '测试通过,请继续下一步骤。',
})
```

At module load, `evaluateAutoContinue(ctx)` will ask each strategy in priority order
and return the first non-empty prompt.

### Rules

- **Detect must be pure** — no IO, no async. Failure is caught, strategy skipped.
- **Prompt factory may return `''`** — equivalent to "don't continue" (registry
  records `detect=hit`, `prompt=skip`).
- **Priority collisions** — registry sorts by `(priority, name)`. Don't rely on
  insertion order.
- **Register at module load** — import the file early (e.g. via a side-effect
  import in `utils/autoContinueTurn.ts`) so the strategy is available on first use.

## Template 3: SnapshotStore (cross-session persistence)

Use when a ring buffer, aggregated stat, or learned model needs to survive
process restart and hydrate on next launch.

### Step-by-Step

1. Pick a `namespace` (kebab-case filename: `<projectDir>/snapshots/<namespace>.json`).
2. Bump `schemaVersion` whenever serialized shape changes.
3. Implement `getSnapshot()` — return `null` to skip this save (empty state).
4. Implement `applySnapshot(data)` — restore in-memory state from disk.
5. Call `saveNow(projectDir)` from a fire-and-forget hook at natural seams.

### Template

```typescript
// services/myFeature/learnedModelSnapshot.ts
import { createSnapshotStore } from '../snapshotStore/index.js'

const store = createSnapshotStore<LearnedModel>({
  namespace: 'learned-model',
  schemaVersion: 2,
  getSnapshot: () => (model.sampleCount > 0 ? model : null),
  applySnapshot: snap => {
    // Shape-check defensively — stale schemas can slip past version check
    if (!snap || typeof snap !== 'object') return
    Object.assign(model, snap)
  },
})

// Hydrate on startup
export async function hydrateModel(projectDir: string): Promise<boolean> {
  return store.loadNow(projectDir)
}
// Persist at seams (e.g. every N updates, or in background tick)
export async function persistModel(projectDir: string): Promise<boolean> {
  return store.saveNow(projectDir)
}
```

### Rules

- **Atomic write** is handled by factory — don't roll your own `writeFile`.
- **Schema mismatch = silent skip** — `loadNow` returns `false`, state stays empty.
  This is intentional: stale snapshots must never corrupt running process.
- **Hydrate in `startAgentSchedulerBackground`** — fire-and-forget, parallel with
  other init paths (not blocking UI first paint).
- **Persist on frequent-change paths via `void saveNow(dir)`** — never block hot
  path on disk. Also wire a periodic-maintenance task for crash-safety if writes
  are rare.

## Template 4: ColdStart Candidate (speculation bootstrap)

Use when a module has a sensible "warm up the agent subprocess" prompt that
should fire on fresh projects (no episode history yet), especially in coordinator
mode where waiting 360s for speculation to kick in is unacceptable.

### Step-by-Step

1. Pick a `name` (kebab-case, unique).
2. Pick the correct `when`:
   - `'always'` — fires regardless of coordinator mode
   - `'coordinator-only'` — fires only when `CLAUDE_CODE_COORDINATOR_MODE=1`
   - `'non-coordinator-only'` — fires only in normal REPL
3. Pick a `priority` (lower = earlier); consider bumping to 10 if this should
   dominate the default candidate set.
4. Write a **short, read-only** prompt. Avoid destructive verbs.

### Template

```typescript
// coordinator/coordinatorColdStart.ts (or anywhere; register on module load)
import { registerColdStartCandidate } from '../services/agentScheduler/index.js'

registerColdStartCandidate({
  name: 'coordinator-repo-probe',
  agentType: 'general-purpose',
  prompt: 'Describe the repository structure at a high level using the Glob tool. Read-only, do not modify files.',
  priority: 10,
  source: 'coordinator-mode',
  when: 'coordinator-only',
})
```

### Rules

- **Read-only prompts only** — cold-start runs with confidence=0 and no user
  confirmation. A "create a branch" candidate is a bug.
- **Do NOT import coordinatorMode.ts** — coldStart.ts reads `CLAUDE_CODE_COORDINATOR_MODE`
  env directly to avoid circular imports.
- **Byte-signature match is unlikely** — cold-start candidates are for agent
  subprocess warm-up + agentStats seeding, not for prefetch. True cache hits
  require exact `computePromptSignature(agentType, prompt, cwd)` match from the
  real user call.
- **Burst frequency** — `scheduleColdStartBurst(projectDir)` fires 3× 20s by default.
  Tune via `{ totalTicks, intervalMs }` only if you have evidence the default
  is wrong for your workload.

## Template 5: Shadow→Episode Writeback

Use when an **external-agent pre-run** produces a result that should feed the
`predictNextAgentCalls` score and `agentStats` aggregation — turning "wasted
Codex quota" into "predictive training data".

### Step-by-Step

1. Run the external agent (Codex / Gemini / claude-code subprocess) and collect
   `{agentType, prompt, status, durationMs}`.
2. After `putShadowResult(...)`, synthesize a sessionId `<source>_<agent>_<YYYYMMDD>`.
3. Call `createAgentRunEpisode({source: 'shadow', ...})` and `appendEpisode(projectDir, ep)`.
4. Track `episodeWriteBacks` and `lastEpisodeError` on the runner state.

### Template

```typescript
// Inside your shadow runner (pattern mirrors codexShadowRunner.ts)
import {
  appendEpisode,
  createAgentRunEpisode,
} from '../episodicMemory/episodicMemory.js'

const writebackEnabled =
  (process.env.CLAUDE_CODE_SHADOW_NO_EPISODE ?? '').trim().toLowerCase() !== '1'

if (writebackEnabled && projectDir) {
  try {
    const dateKey = new Date(finishedAt).toISOString().slice(0, 10).replace(/-/g, '')
    const sessionId = `shadow_${sourceAgent}_${dateKey}`
    const ep = createAgentRunEpisode({
      agentType, durationMs,
      outcome: status === 'success' ? 'success' : 'error',
      priority: 'speculation',
      sessionId,
      projectPath: projectDir,
      description: prompt,
      source: 'shadow',  // critical — marks sample non-canonical
    })
    void appendEpisode(projectDir, ep)
      .then(() => { state.episodeWriteBacks++ })
      .catch(e => { state.lastEpisodeError = (e as Error).message })
  } catch (e) {
    state.lastEpisodeError = (e as Error).message
  }
}
```

### Rules

- **`source: 'shadow'` is mandatory** — it adds the `source:shadow` tag AND halves
  importance in `createAgentRunEpisode`. Downstream aggregators can filter on tag.
- **Synthetic sessionId per day** — `shadow_<agent>_<YYYYMMDD>` groups samples
  without polluting real user session files, and plays nicely with
  `cleanupOldEpisodes(maxAgeDays)`.
- **Outcome mapping** — `'success' → 'success'`, `'failed' / 'timeout' → 'error'`.
  No `'abort'` — that's reserved for user-cancelled.
- **Fire-and-forget** — never `await` the append in a tick callback.
- **Opt-out env**: `CLAUDE_CODE_SHADOW_NO_EPISODE=1` disables writeback project-wide.

## Cross-Template Cross-Checks

All five registries share these observability guarantees — verify all apply:

- [ ] `getAll<Registry>()` returns entries sorted by `(priority, name)`.
- [ ] Each entry snapshot includes `{name, hits, lastError?}` minimum.
- [ ] `/kernel-status` shows a dedicated section titled with the registry purpose.
- [ ] Errors inside a user-provided callback are logged once and swallowed;
      the loop keeps iterating.
- [ ] `__reset<Registry>ForTests()` exists and clears all in-memory state.
- [ ] Public API exports reside in `services/<registry>/index.ts` as re-exports.

## When NOT to Add a Registry Entry

Consider these **anti-patterns** before registering:

- **Don't register a cold-start candidate that issues writes** — cold-start runs
  speculatively with confidence 0; destructive verbs cause surprise.
- **Don't register an auto-continue strategy for error recovery** — use preflight
  gates or the retry loop. Auto-continue is for natural turn-chain continuation
  after a "complete-looking" assistant message.
- **Don't create a new snapshot store for config/flags** — env vars and
  `~/.claude/config.json` are already durable. Snapshots are for learned state
  (ring buffers, aggregated stats, LRUs).
- **Don't generalize rateBucket to a non-sliding-window limiter** — token buckets,
  leaky buckets, semaphores need different data structures. Add a sibling
  abstraction instead of overloading rateBucket.
- **Don't feed non-agent samples into episode writeback** — episodes carry
  `agent_run` semantics. For tool calls use `recordToolCall` in `toolStats.ts`.

See `examples/` for concrete wired-in reference implementations.
