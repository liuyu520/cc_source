# Multi-Trigger Recall Pattern

How to reuse `classifyIntent` at multiple entry points beyond the initial user-message prefetch.

## Problem

The current skill recall fires once per user message (`prefetch.ts`). But during a long tool loop the user's *effective* intent drifts — a task that started as `code_edit` may shift to `debug` after a test failure, or to `git_workflow` when the fix is ready.

## Solution: Trigger at Three Points

```
User message  ───────────►  prefetch (existing)
                                │
Tool loop                       │
  ├── pre_tool_use  ────────►  mini-recall (P2_method)
  │     query = tool_use.input snippet
  │
  ├── post_error    ────────►  error-recall (P2_method)
  │     query = error message
  │
  └── compact_boundary ─────►  refresh-recall (P3_background)
        query = latest user message (re-scored)
```

Each trigger calls `classifyIntent` independently — intent may differ at each point:

```typescript
// pre_tool_use example:
const toolInput = JSON.stringify(toolUse.input).slice(0, 200)
const intent = classifyIntent(toolInput)
if (intent.taskMode !== lastKnownMode) {
  // Mode shifted — re-run skill discovery with new weights
  const weights = fusionWeightsFor(intent.class)
  // ... re-score existing candidates or submit new prefetch
}
```

## Deduplication via SideQueryScheduler

All three triggers go through `submitSideQuery` with category `'skill_discovery'` and a dedupeKey that encodes the trigger type + query hash:

```typescript
const dedupeKey = `skill_discovery:${trigger}:${hashQuery(query)}`
```

This ensures:
- Same query at same trigger → deduplicated (no redundant work)
- Different trigger or different query → separate task (correct re-evaluation)
- Budget guard prevents runaway token spend on rapid tool loops

## When to Add a New Trigger

Ask:
1. Does the user's effective intent change at this point?
2. Is the existing skill set potentially stale?
3. Can we construct a meaningful query from the available context?

If all three are yes, add a trigger. If not, skip — unnecessary triggers waste budget and pollute telemetry.
