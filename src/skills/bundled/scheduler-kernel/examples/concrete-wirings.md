# Concrete Kernel Extensions Already Wired

Every template in `SKILL.md` has a live reference implementation in the codebase.
Read these first before inventing a new pattern.

## 1. RateBucket — `tokenBudget.ts` (input tokens)

`services/agentScheduler/tokenBudget.ts` is a **thin wrapper** over `createRateBucket`.
It preserves 8 historical exports byte-identically while delegating all logic to
the registry:

```typescript
// tokenBudget.ts (simplified)
const inputTokenBucket = createRateBucket({
  dimension: 'input-tokens',
  windowMs: 60_000,
  limit: readInputTokenLimitFromEnv,
})

export const canCharge   = inputTokenBucket.canCharge
export const tryCharge   = inputTokenBucket.tryCharge
export const getCurrentTokenUsage = () => inputTokenBucket.getSnapshot().used
// ... 5 more re-exports
```

**Takeaway**: when replacing a legacy one-off limiter with a rateBucket, wrap it
as a thin adapter. Don't break call sites.

## 2. AutoContinueStrategy — two built-in branches

`utils/autoContinueTurn.ts` registers two strategies at module load:

```typescript
registerAutoContinueStrategy({
  name: 'max_tokens',
  priority: 10,
  detect: ctx => ctx.stopReason === 'max_tokens',
  prompt: ctx => resolveAutoContinuePrompt(ctx.text),
})

registerAutoContinueStrategy({
  name: 'next_step_intent',
  priority: 20,
  detect: ctx => ctx.stopReason !== 'tool_use' && detectNextStepIntent(ctx.text),
  prompt: ctx => resolveAutoContinuePrompt(ctx.text),
})
```

`screens/REPL.tsx` calls `evaluateAutoContinue({text, stopReason})` — returns
either `{strategyName, prompt}` or `null`. The hardcoded `if (!detectNextStepIntent(text)) return` has been replaced.

**Takeaway**: to add a third branch (e.g. test-passed, commit-finished), register
a new strategy at priority 15 or 25. No edit to REPL.tsx needed.

## 3. SnapshotStore — AgentStats + ToolStats

Two stores created via `createSnapshotStore`:

```typescript
// agentStats.ts
const agentStatsSnapshotStore = createSnapshotStore<AgentStatsSnapshot>({
  namespace: 'agent-stats',
  schemaVersion: 1,
  getSnapshot: () => statsCache?.snapshot ?? null,
  applySnapshot: snap => { statsCache = { snapshot: snap, expiresAt: 0 } },
})

// toolStats.ts — different data shape, same pattern
const toolStatsSnapshotStore = createSnapshotStore<ToolStat[]>({
  namespace: 'tool-stats',
  schemaVersion: 1,
  getSnapshot: () => records.length > 0 ? records.slice() : null,
  applySnapshot: snap => {
    // Defensive shape-check
    const keep = snap.filter(r => r && typeof r.tool === 'string').slice(-MAX_RECORDS)
    records.length = 0
    records.push(...keep)
  },
})
```

Both hydrate fire-and-forget in `background.ts::startAgentSchedulerBackground`.
AgentStats persists on every `getAgentStats` then-chain (no periodic task needed).
ToolStats persists via `TASK_TOOL_STATS_PERSIST` every 60s (high-frequency writes).

**Takeaway**: pick persistence strategy by write rate. One-off compute results
persist on the write path. High-rate ring buffers persist on a timer.

## 4. ColdStart — No default candidates

`coldStart.ts` intentionally ships **empty** — no default candidates registered.
The integration wires through `background.ts`:

```typescript
// background.ts::startAgentSchedulerBackground
setColdStartProvider(pickColdStartPrediction)
if (isSpeculationEnabled()) {
  scheduleColdStartBurst(projectDir)
}
```

Candidates are expected to be **user-supplied or feature-supplied**. E.g.
a coordinator feature could register its own warm-up prompts on boot:

```typescript
// hypothetical coordinator/coordinatorBoot.ts
if (isCoordinatorMode()) {
  registerColdStartCandidate({
    name: 'coord-plan-overview',
    agentType: 'general-purpose',
    prompt: 'List all open task files and their status.',
    priority: 10,
    source: 'coordinator-boot',
    when: 'coordinator-only',
  })
}
```

**Takeaway**: cold-start is infrastructure. Features plug in candidates via the
registry, not by editing `coldStart.ts`.

## 5. Shadow→Episode — codexShadowRunner

Reference implementation lives in `codexShadowRunner.ts::runOneShadow`:

```typescript
// After putShadowResult(...) and putContextFingerprint(...):
if (isShadowEpisodeWritebackEnabled() && projectDir) {
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
      source: 'shadow',
    })
    void appendEpisode(projectDir, ep)
      .then(() => { state.episodeWriteBacks++ })
      .catch(e => { state.lastEpisodeError = (e as Error).message })
  } catch (e) {
    state.lastEpisodeError = (e as Error).message
  }
}
```

The result flows:

1. `putShadowResult` → `shadowStore` (in-memory, 30min TTL) — fuels `/kernel-status`.
2. `putContextFingerprint` → `contextFingerprint` store — fuels pipeline prefix reuse.
3. `appendEpisode` → `<projectDir>/episodes/shadow_<agent>_<date>.jsonl` — fuels
   `predictNextAgentCalls` and `agentStats`. **This is the one added in #8.**

**Takeaway**: the three writes are independent; errors in one don't roll back
the others. When wiring a new external-agent source, follow the same tri-write
pattern.

## Quick Ref: Where to Find Each Registry's Observability

- `/kernel-status` §4 Rate Buckets → iterates `getAllRateBuckets()`
- `/kernel-status` §9 Auto-Continue Strategies → iterates `getAllAutoContinueStrategies()`
- `/kernel-status` §10 Snapshot Stores → iterates `getAllSnapshotStores()`
- `/kernel-status` §11 Cold-Start → `getColdStartState()` + `listColdStartCandidates()`
- `/kernel-status` Shadow Agent Runner → `getShadowRunnerState().episodeWriteBacks`
