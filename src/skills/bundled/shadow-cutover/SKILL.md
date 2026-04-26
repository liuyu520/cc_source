---
description: Safe feature introduction via env-flag → shadow → cutover → cleanup progression. Use when adding new subsystems, decision engines, or replacing existing code paths without regression.
---

# Shadow-Cutover Pattern

Use this skill when introducing a new subsystem, decision engine, or code path that replaces or augments existing behavior. The pattern ensures zero regression through a four-phase progression.

## Goal

Ship new logic alongside old logic, validate via shadow observation, then switch traffic with a single env-var flip — never by deleting old code.

## Four Phases

```
Phase 0: OFF (default)     — new code exists but never runs; legacy unchanged
Phase 1: SHADOW            — new code runs in parallel, results logged, legacy drives
Phase 2: CUTOVER           — new code drives, legacy available as instant rollback
Phase 3: CLEANUP           — old code removed after bake period
```

## Env-Var Convention

Every subsystem gets exactly two env vars:

| Var | Values | Effect |
|-----|--------|--------|
| `CLAUDE_<SUBSYSTEM>=1` | 0 (default) / 1 | Phase 0 → Phase 1 |
| `CLAUDE_<SUBSYSTEM>_SHADOW=0` | 1 (default) / 0 | Phase 1 → Phase 2 |

Examples from this codebase:

- `CLAUDE_COMPACT_ORCHESTRATOR` + `CLAUDE_COMPACT_ORCHESTRATOR_SHADOW`
- `CLAUDE_MCP_LAZY_LOAD` + `CLAUDE_MCP_LAZY_LOAD_SHADOW`
- `CLAUDE_SIDE_QUERY_SCHEDULER` + per-category `CLAUDE_SIDE_QUERY_<CATEGORY>`
- `CLAUDE_PROVIDER_REGISTRY` + `CLAUDE_PROVIDER_CAPABILITY_PROBE`
- `CLAUDE_PEV_DRYRUN` + `CLAUDE_PEV_SHADOW` (Phase 2: blast-radius drives permissions)
- `CLAUDE_DREAM_PIPELINE` + `CLAUDE_DREAM_PIPELINE_SHADOW` + `CLAUDE_DREAM_PIPELINE_MICRO`
- `CLAUDE_SKILL_INTENT_ROUTER` (additive — Phase 1 is already the shadow)

### Tri-state (`off | shadow | on`) subsystems

Some newer subsystems collapse the two-flag pattern into a single enum variable. The semantics are identical — `off` ↔ Phase 0, `shadow` ↔ Phase 1, `on` ↔ Phase 2 — just fewer moving parts. **Default remains `off`** in every case.

| Env var | Subsystem | Phase-2 consumer |
|---------|-----------|------------------|
| `CLAUDE_BUDGET_GOVERNOR` | `services/budgetGovernor/` — session cost verdict | `query.ts` stop hook (not yet wired) |
| `CLAUDE_EDIT_GUARD` | `services/editGuard/` — file parse validation | FileEdit/FileWrite snapshot+rollback (not yet wired) |
| `CLAUDE_SKILL_LEARN` | `services/skillSearch/onlineWeights.ts` — outcome collection | `intentRouter` weight loading (needs success signal) |
| `CLAUDE_PROMPT_CACHE_METRICS` | `utils/promptCacheMetrics.ts` — cache hit ratio evidence | cache-aware prompt ordering (not yet wired) |
| `CLAUDE_CAUSAL_GRAPH` | `services/causalGraph/` — cross-subagent fact sharing | subagent prompt injection (not yet wired) |

When `off` these subsystems do **zero IO**. When `shadow`, they write `EvidenceLedger` but do not mutate any decision path. The `on` cutover is per-subsystem — each must gather its own bake-period evidence before flipping, never as a batch.

## The `decideAndLog` Template

Every decision point follows a single helper pattern to avoid try/catch + flag + log boilerplate spreading:

```typescript
// In the subsystem's index.ts:
export function decideAndLog(
  site: string,
  input: DecideInput,
): { plan: CompactPlan; shadow: boolean } | null {
  try {
    if (!isEnabled()) return null          // Phase 0: no-op
    const shadow = isShadowMode()
    const plan = decide(input)
    logForDebugging(`[Subsystem:${site}] ... shadow=${shadow}`)
    return { plan, shadow }
  } catch (e) {
    logForDebugging(`[Subsystem:${site}] failed, legacy: ${e}`)
    return null
  }
}

// At every call site (query.ts, autoCompact.ts, etc.):
const decision = decideAndLog('query', input)
if (decision && !decision.shadow) {
  // Phase 2: use decision.plan to gate behavior
} else {
  // Phase 0/1: legacy behavior unchanged
}
```

## Rules

### 1. Legacy Fallback = Zero Regression

The "no trigger" / default branch of any planner/router MUST return output equivalent to legacy behavior. If legacy runs snip+micro unconditionally, the planner's fallback must set `runSnip=true, runMicro=true`. Never default to `noop` / "all off".

### 2. Never Delete Old Code Until Phase 3

Shadow and cutover phases keep old code intact. The old path is the instant rollback — removing it prematurely turns a flag flip into a deploy.

### 3. Dynamic Import for Cross-Module Flags

Use `await import()` for flag checks to avoid circular dependencies and keep disabled-path cost at zero:

```typescript
const { decideAndLog } = await import('./orchestrator/index.js')
```

ESM module cache makes repeated imports near-free; explicit top-level import risks pulling the entire subsystem into bundles where it's disabled.

### 4. Signal Quality ≥ Decision Quality

A decision engine is only as good as its input. Before wiring a `decide()` call, verify you can supply **real signals** (token ratio, heavy-tool-result count, message count) — not placeholder zeros. Placeholder zeros will route to the fallback branch in shadow mode (harmless) but produce wrong decisions in cutover (regression).

### 5. Preserve Semantic Invariants

Read the comments around the code you're wrapping. If the original says "both may run — not mutually exclusive", your decision model must preserve that invariant (e.g., independent `runSnip` + `runMicro` flags, not a single-choice enum).

## Checklist

Before shipping a shadow-cutover integration:

- [ ] Two env vars defined, both default OFF
- [ ] `decideAndLog` or equivalent helper used (no raw try/catch at call site)
- [ ] Planner/router fallback branch returns legacy-equivalent output
- [ ] Real signals fed to decision input (no placeholder zeros in cutover path)
- [ ] Original semantic invariants preserved (read upstream comments)
- [ ] `logForDebugging` at decision point for shadow observation
- [ ] Old code path reachable by flipping env var back to OFF

See `examples/compact-orchestrator.md`, `examples/provider-registry.md`, `examples/pev-harness.md`, `examples/dream-pipeline.md`, `examples/intent-router.md`, and `examples/cost-consumer-loop.md`.

For subsystems using the tri-state pattern, see also `harness-primitives/SKILL.md`.
