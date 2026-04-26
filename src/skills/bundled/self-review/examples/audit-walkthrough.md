# Self-Review Audit Walkthrough

A complete worked example applying the 9-point audit to the P1-1 Compact Orchestrator query.ts integration.

## Change Description

Wrapped `snipCompactIfNeeded` and `deps.microcompact` in `query.ts:401-470` with `compactOrchestrator.decide()` gating, using the shadow-cutover pattern.

## First Pass (Before Fixes)

```typescript
// query.ts — ORIGINAL (buggy) integration
const plan = compactOrchestrator.decide({
  messageCount: messagesForQuery.length,
  stats: { usedTokens: 0, maxTokens: 0, ratio: 0 },   // ← all zeros
  signal: { kind: 'post_tool', reason: 'query_pre_snip_micro' },
  heavyToolResultCount: 0,                              // ← zero
})
orchestratorPlanStrategy = plan.strategy                // ← single enum

const allowSnip = ... || orchestratorPlanStrategy === 'snip'
const allowMicro = ... || orchestratorPlanStrategy === 'micro_compact'

const microcompactResult = allowMicro
  ? await deps.microcompact(...)
  : { messages: messagesForQuery, compactionInfo: undefined as any }  // ← as any
```

## Audit Results

| # | Checkpoint | Status | Detail |
|---|-----------|--------|--------|
| 1 | Zero-Value Signal | **FAIL** | `ratio: 0, heavyToolResultCount: 0` → planner always returns `noop` → cutover disables both snip and micro |
| 2 | Semantic Invariant | **FAIL** | Comment says "both may run — not mutually exclusive" but `strategy` enum forces single choice |
| 3 | Type Contract | **FAIL** | `compactionInfo: undefined as any` hides missing fields from TS |
| 4 | IO Amplification | PASS | No disk writes in query.ts |
| 5 | Dedup Key | PASS | No dedup keys in this change |
| 6 | Template Duplication | **FAIL** | Same try/catch + isEnabled + shadow + log pattern in query.ts AND autoCompact.ts |
| 7 | Type Erosion | PASS | No `as any` beyond #3 |
| 8 | Name-vs-Reality | PASS | `decide()` does decide |
| 9 | Hot-Path Async | **NOTE** | `await import()` in per-iteration loop; ESM cache mitigates, but noted |

## P0 Fixes Applied

### #1 — Zero-Value Signal

```typescript
// FIXED: compute heavyToolResultCount from real data
const HEAVY_TOOL_RESULT_BYTES = 8 * 1024
let heavyToolResultCount = 0
for (const m of messagesForQuery) {
  const content = (m as any)?.message?.content
  if (!Array.isArray(content)) continue
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    const s = typeof block.content === 'string'
      ? block.content : JSON.stringify(block.content ?? '')
    if (s.length > HEAVY_TOOL_RESULT_BYTES) heavyToolResultCount++
  }
}

// FIXED: planner fallback returns runSnip=true, runMicro=true
// even with ratio=0, legacy behavior is preserved
```

### #2 — Semantic Invariant

```typescript
// BEFORE (buggy): single strategy enum
orchestratorPlanStrategy === 'snip'          // excludes micro
orchestratorPlanStrategy === 'micro_compact' // excludes snip

// AFTER (fixed): independent boolean flags in CompactPlan
allowSnip = decision.plan.runSnip     // independent
allowMicro = decision.plan.runMicro   // independent
// Both can be true simultaneously — invariant preserved
```

### #3 — Type Contract

```typescript
// BEFORE (buggy):
: { messages: messagesForQuery, compactionInfo: undefined as any }

// AFTER (fixed):
: (await import('./services/compact/microCompact.js'))
    .createEmptyMicrocompactResult(messagesForQuery)
// Type-safe passthrough, single source of truth
```

## P1 Fixes Applied

### #6 — Template Duplication

```typescript
// BEFORE: 15 lines of try/catch in query.ts AND autoCompact.ts
try {
  const { isCompactOrchestratorEnabled, isCompactOrchestratorShadowMode, ... } = ...
  if (isCompactOrchestratorEnabled()) {
    const shadow = isCompactOrchestratorShadowMode()
    const plan = compactOrchestrator.decide(input)
    logForDebugging(`[CompactOrchestrator:...] ...`)
    // ...
  }
} catch (e) { logForDebugging(`... failed: ${e}`) }

// AFTER: one helper, all sites are one-liners
const decision = decideAndLog('query', input)
```

## Lessons for Next Integration

1. **Run checkpoint #1 first** — it's the most common P0 and the easiest to miss
2. **Read the 5 lines above your insertion** — checkpoint #2 catches invariant breaks that types can't express
3. **Never write `as any` for passthrough results** — always export a typed constructor from the owning module
4. **If you copy-paste flag-check boilerplate, extract a helper immediately** — don't wait for the third occurrence
