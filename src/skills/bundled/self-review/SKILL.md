---
description: Systematic audit of optimization code against design principles. Use after completing any subsystem wiring, shadow-cutover integration, or multi-file refactor to catch zero-value signals, type contract violations, IO amplification, semantic invariant breaks, and template duplication.
---

# Self-Review

Use this skill after completing a non-trivial code change — especially shadow-cutover integrations, subsystem wirings, or any modification that wraps existing code paths with new decision logic. The goal is to catch defects that compile fine but silently regress behavior.

## Goal

Find conflicts between your changes and the codebase's existing design principles, semantic invariants, and performance contracts before they reach users.

## The 9-Point Audit

Work through each checkpoint in order. For each, state "pass" or describe the defect found.

### 1. Zero-Value Signal Trap

**Question:** Does every `decide()` / `plan()` / `route()` call receive **real** input signals?

**How to check:** Find every call to a decision function. For each numeric input (`ratio`, `count`, `tokens`), verify it comes from a real computation — not a hardcoded `0`. Trace the value back to its source.

**Why it matters:** A planner that receives `ratio: 0` always hits its fallback branch. In shadow mode this is harmless (legacy runs anyway). In cutover mode, the fallback may disable features (e.g., `noop` → snip+micro both off → regression).

**Red flag:** `stats: { usedTokens: 0, maxTokens: 0, ratio: 0 }` in a cutover path.

### 2. Semantic Invariant Violation

**Question:** Does the new code preserve invariants stated in **comments near the wrapped code**?

**How to check:** Read 5 lines above and below every insertion point. Look for comments like "both may run", "not mutually exclusive", "must run before X", "order matters".

**Why it matters:** Comments document invariants that aren't enforced by types. A single-choice enum replacing a "both may run" pair is a silent semantic break.

**Red flag:** Original says "A and B are independent" but new code makes them mutually exclusive via a single `strategy` field.

### 3. Type Contract Violation (Fake Results)

**Question:** When the new code skips an existing function, does the **passthrough result** match the real function's return type **completely**?

**How to check:** Find every `? realCall() : fakeResult` ternary. Compare `fakeResult`'s shape to the real function's return type. Check if downstream code accesses fields beyond what the fake provides.

**Why it matters:** `{ messages, compactionInfo: undefined as any }` compiles but silently drops fields that downstream code may read (boundary messages, telemetry data, token counts).

**Fix pattern:** Export a `createEmptyXxxResult(input)` from the module that owns the type. Single source of truth for the passthrough shape.

### 4. IO Amplification

**Question:** Does any new disk/network write sit on a **high-frequency callback path**?

**How to check:** For every `writeFileSync`, `writeFile`, `fetch`, or cache `.put()` you added, trace the call chain upward. Is it inside a loop? Inside a notification handler (`tools/list_changed`)? Inside a per-message callback?

**Why it matters:** `manifestCache.put()` inside `onConnectionAttempt` fires on every `tools/list_changed` notification — synchronous `readFileSync + writeFileSync` of the entire JSON on every tool refresh.

**Fix pattern:** Shape-hash diff (`putIfChanged`), debounce window, or "write only on first connect" guard.

### 5. Dedup Key Staleness

**Question:** Can a `dedupeKey` become a **permanent lock** that prevents legitimate re-execution?

**How to check:** For every `dedupeKey` string, check if it includes a **varying component** (time bucket, input hash, session ID). A constant string like `'mcp_manifest_probe:boot'` means the task runs at most once per process — even if conditions change.

**Fix pattern:** Include a day bucket: `` `${category}:${Math.floor(Date.now()/86_400_000)}` ``

### 6. Template Duplication

**Question:** Is the same try/catch + feature-flag + log pattern written in **two or more** places?

**How to check:** Grep for the subsystem's feature-check function name. If it appears at 2+ call sites with surrounding try/catch + logForDebugging, it's duplicated boilerplate.

**Why it matters:** Duplicated boilerplate diverges over time. One site gets a bugfix, the other doesn't. Extract a helper (e.g., `decideAndLog`) after the second occurrence.

**Fix pattern:** `decideAndLog(site, input)` — one function, all sites call it.

### 7. Type Erosion (`as any` Spread)

**Question:** Are there **3+ `as any` casts** in a single function touching the same domain objects?

**How to check:** Count `as any` in each modified function. If the same object type (Tool, Command, Resource) is cast repeatedly, it needs a converter.

**Fix pattern:** Export a type-safe converter function (`toManifestItem(x: unknown): McpToolManifestItem`) from the module that owns the target type.

### 8. Name-vs-Reality Mismatch

**Question:** Does every function/task **actually do what its name claims**?

**How to check:** Read the function body. A function named `probeStaleManifests` that only counts stale entries without probing anything is misleading. A "prewarming" task that only reads a cache isn't warming anything.

**Why it matters:** Future developers (including AI agents) will call the function expecting the named behavior. If it doesn't deliver, the caller's assumptions silently break.

### 9. Hot-Path Async Injection

**Question:** Did the change turn a **synchronous hot path into async** via `await import()`?

**How to check:** For every `await import()` added, check if it's inside a per-message or per-token loop. ESM module cache makes the cost small after first call, but the first call involves a microtask + promise allocation — and it changes the generator's yield ordering.

**Risk level:** Low for most sites (ESM caches modules), but worth noting if the surrounding code has timing-sensitive invariants (yield order in generators, synchronous state reads).

## Workflow

1. List all files you modified.
2. For each file, run checkpoints 1-9 against your changes.
3. Collect findings into three buckets:
   - **P0 (fix now):** Would cause regression when cutover flag is flipped (#1, #2, #3)
   - **P1 (fix before merge):** Performance or correctness risk under load (#4, #5, #6, #8)
   - **P2 (track):** Code quality / maintainability (#7, #9)
4. Fix P0 items immediately. Create tasks for P1/P2.

## Reporting Format

```
## Self-Review: [change description]

### Files Modified
- path/to/file.ts — what changed

### Findings
| # | Checkpoint | Status | Detail |
|---|-----------|--------|--------|
| 1 | Zero-Value Signal | PASS / FAIL | ... |
| 2 | Semantic Invariant | PASS / FAIL | ... |
| ... | ... | ... | ... |

### P0 Fixes Required
- ...

### P1 Fixes Before Merge
- ...

### P2 Tracked
- ...
```

## When to Use

- After any shadow-cutover integration
- After any SideQuery / Provider / Orchestrator / MCP LazyLoad wiring
- After any multi-file refactor that wraps existing behavior
- Before requesting code review from others
- When the change touches 3+ files or adds decision logic

## Anti-Patterns This Catches

| Anti-Pattern | Checkpoint | Typical Symptom |
|-------------|-----------|----------------|
| "Empty shell cutover" | #1 | Decision engine always returns noop |
| "Broke the invariant" | #2 | Mutually exclusive enum replaces independent flags |
| "as any escape hatch" | #3, #7 | Downstream reads undefined from fake result |
| "Write storm" | #4 | Disk thrash on every notification |
| "One-shot dedup" | #5 | Background task never re-runs |
| "Copy-paste flag check" | #6 | Bug fixed in one site, not the other |
| "Probe that doesn't probe" | #8 | Function name promises more than body delivers |
| "Sync → async surprise" | #9 | Generator yield order changes |

See `examples/audit-walkthrough.md` for a complete worked example.
