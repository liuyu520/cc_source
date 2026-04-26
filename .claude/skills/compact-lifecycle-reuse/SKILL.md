---
name: "compact-lifecycle-reuse"
description: "Reuse compact lifecycle hooks (pre-compact snapshot, post-compact cleanup, orchestrator decide/execute) when adding behavior before/after conversation compaction, extending compact strategies, or debugging compact flow."
---

# Compact Lifecycle Reuse

Use this skill when hooking into the compact lifecycle (pre/post compact behavior), extending compact strategies, adding new compact side effects, or debugging compact flow.

## Compact Architecture

```
query.ts budget prefetch             ← contextBudget.ts + orchestrator signals
         ↓
autoCompactIfNeeded()                ← autoCompact.ts, heavy-path threshold check
         ↓
CompactOrchestrator.decide(input)    ← orchestrator/index.ts:47, pure function → CompactPlan
         ↓
CompactOrchestrator.execute(plan)    ← orchestrator/index.ts:57, dispatches by strategy
         ↓
┌────────────────────────────────────┐
│ full_compact → compactConversation │ ← compact.ts:388, forked-agent summary
│ micro_compact → microCompact       │ ← microCompact.ts, keep by relevance+recency
│ session_memory → sessionMemory     │ ← sessionMemoryCompact.ts, keep recent msgs
│ noop → skip                        │
└────────────────────────────────────┘
```

## Reuse First

- `src/services/compact/compact.ts` — `compactConversation()` (line ~388)
  Main full compact entry. Takes messages + context, returns CompactionResult. Pre-compact hooks run here. **This is the only place that destroys original messages** — micro and session-memory compacts are non-destructive.

- `src/services/compact/snapshot.ts` — Pre-compact snapshot module
  `savePreCompactSnapshot(sessionId, messages)` — serialize full messages before compact
  `loadPreCompactSnapshot(sessionId)` — restore messages (returns Message[] | null)
  `deletePreCompactSnapshot(sessionId)` — cleanup after rollback
  `hasPreCompactSnapshot(sessionId)` — existence check
  Pattern: best-effort (failure logged, never blocks compact).

- `src/services/compact/orchestrator/index.ts` — `CompactOrchestrator`
  Singleton. `decide()` is pure (no side effects), returns `CompactPlan`. `execute()` dispatches via `ExecuteContext` closures. Shadow mode (`isCompactOrchestratorShadowMode()`) skips execution for safe rollout.

- `src/services/compact/orchestrator/planner.ts` — `plan()`
  Decision logic: token stats → strategy selection. Pure function.

- `src/services/compact/orchestrator/types.ts` — `CompactPlan`
  Fields: strategy, reason, estimatedTokensSaved, runSnip, runMicro, preserveAsEpisodic.

- `src/services/compact/contextBudget.ts`
  Shared `system / tools / history / output` allocator. Reuse this when adding new compact triggers or proactive prefetch logic.

- `src/services/compact/orchestrator/importance.ts`
  Shared relevance scoring. Use this before creating another message-priority heuristic.

- `src/services/compact/autoCompact.ts` — `shouldAutoCompact()` (line 160)
  Heavy-path trigger. Reuse budget allocation and keep the circuit breaker behavior.

- `src/services/compact/microCompact.ts` — `COMPACTABLE_TOOLS` (line 41-50)
  Time-based smart compact for old `tool_result` content. Relevance + recency decide what stays; summaries replace cleared content when available.

- `src/services/compact/toolResultSummary.ts`
  Reuse this for ephemeral tool-result summaries. It already handles forked-agent summarization and fallback.

- `src/services/api/promptCacheBreakDetection.ts`
  Reuse section volatility if a new compact decision should react to which prompt segment is changing most often.

- `src/services/compact/sessionMemoryCompact.ts`
  No LLM call. Keeps recent messages (≥10K tokens or 5 messages, cap 40K tokens). Non-destructive.

## Common Tasks

### Adding pre-compact behavior (like snapshot)

Insert at `compactConversation()` entry, after the `messages.length === 0` check:

```typescript
// compact.ts — compactConversation() entry
import { myPreCompactHook } from './myHook.js'

// After messages.length check, before preCompactTokenCount:
const sessionId = getSessionId()
if (sessionId) {
  try {
    await myPreCompactHook(sessionId, messages)
  } catch (e) {
    // Best-effort — never block compact
    logForDebugging(`[MyHook] Failed: ${(e as Error).message}`)
  }
}
```

**Rules:**
- Always wrap in try/catch — compact must not fail due to hook errors
- Only hook into `compactConversation()` for destructive operations (full compact)
- micro/session-memory compacts don't need hooks (they're non-destructive)

### Adding post-compact cleanup

Use `postCompactCleanup.ts` pattern or add after `buildPostCompactMessages()` return in compact.ts.

### Extending compact strategies

1. Add new strategy to `CompactStrategy` type in `orchestrator/types.ts`
2. Add decision logic in `orchestrator/planner.ts`
3. Add dispatch case in `CompactOrchestrator.execute()`
4. Inject implementation via `ExecuteContext` closure

### Adding or changing compact signals

1. Start in `src/services/compact/contextBudget.ts` if the signal depends on system/tools/history/output pressure.
2. Reuse `src/services/api/promptCacheBreakDetection.ts` if the signal depends on which prompt section churns most often.
3. Reuse `src/services/compact/orchestrator/importance.ts` if the signal depends on message relevance.
4. Only promote a signal into `autoCompact.ts` after it is represented in the shared allocator or scorer.

### Adding a new command that reads compact state

Follow the `/rollback` pattern:
```typescript
// Your command
import { loadPreCompactSnapshot } from '../../services/compact/snapshot.js'
const snapshot = await loadPreCompactSnapshot(sessionId)
if (!snapshot) { onDone('No snapshot available.'); return null }
context.setMessages(() => snapshot)
```

## Integration Points

| Component | File | Key location |
|-----------|------|-------------|
| Full compact entry | `compact.ts` | ~line 388 (`compactConversation`) |
| Pre-compact snapshot | `snapshot.ts` | `savePreCompactSnapshot()` |
| Snapshot restore | `snapshot.ts` | `loadPreCompactSnapshot()` |
| Orchestrator decide | `orchestrator/index.ts` | line 47 |
| Orchestrator execute | `orchestrator/index.ts` | line 57 |
| Unified decide+log | `orchestrator/index.ts` | line 94 (`decideAndLog`) |
| Auto-compact trigger | `autoCompact.ts` | line 160 |
| Micro compact | `microCompact.ts` | `COMPACTABLE_TOOLS` |
| Session memory | `sessionMemoryCompact.ts` | keeps recent messages |
| Post-compact boundary | `compact.ts` | `createCompactBoundaryMessage()` |
| Compact prompt | `prompt.ts` | `getCompactPrompt()` |

## Snapshot Storage Convention

- Location: same directory as session JSONL (`~/.claude/projects/<sanitized-cwd>/`)
- Filename: `{sessionId}.pre-compact-snapshot.jsonl`
- Format: one JSON.stringify(message) per line
- Atomic write: write to `.tmp` then `rename()`
- Lifecycle: created before compact, consumed by `/rollback`, overwritten by next compact

## Anti-Patterns

- Blocking compact on hook failure — always use try/catch with best-effort semantics
- Hooking into micro/session-memory compact for "message loss" scenarios — they don't lose messages
- Modifying messages in pre-compact hooks — hooks should be read-only observers
- Storing snapshots outside the session directory — breaks session lifecycle binding
- Relying on CompactOrchestrator for all compact paths — legacy code may bypass it (check `isCompactOrchestratorEnabled()`)
- Reintroducing separate threshold math in `query.ts` or `autoCompact.ts` instead of reusing `contextBudget.ts`
- Adding a second tool-result summarizer instead of reusing `toolResultSummary.ts`
