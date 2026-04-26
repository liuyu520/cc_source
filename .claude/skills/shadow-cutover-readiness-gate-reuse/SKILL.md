---
name: "shadow-cutover-readiness-gate-reuse"
description: "Reuse the 9-line shadow→cutover readiness gate pattern when wiring a new env-gated subsystem (RCA, ModelRouter, BudgetGovernor, etc.) into /shadow-promote. Covers ledger telemetry, compute function template, threshold + bake floor, env lever, recommendMode/revertMode, and the three surfaces (/kernel-status, /evolve-status, /memory-audit) that auto-propagate."
---

# Shadow Cutover Readiness Gate Reuse

Use this skill when a new env-gated subsystem has **shadow-mode telemetry** and needs
a promotion gate before flipping to real decisions. The 9-line tracker in
`src/services/shadowPromote/readiness.ts` provides the uniform sampling + bake +
threshold + audit + revert machinery — DO NOT rebuild any of it.

## Current 9 Lines (as of 2026-04-25)

```
G  CLAUDE_PROMPT_CACHE_METRICS       ≥? samples · 24h bake
Q9 CLAUDE_PROMPT_CACHE_ORDER         diff samples · 24h bake
D  CLAUDE_BUDGET_GOVERNOR            ≥20 samples · peak≤soft_warn · 48h bake
E  CLAUDE_CAUSAL_GRAPH               graph non-empty · 48h bake
F  CLAUDE_SKILL_LEARN                ≥200 samples · ≥10 unique skills · 72h bake
A  CLAUDE_PROCEDURAL                 candidate .md count · 72h bake
C  CLAUDE_EDIT_GUARD                 ≥100 samples · ≤5% fail-ratio · 24h bake
B  CLAUDE_CODE_MODEL_ROUTER_ENFORCE  ≥100 samples · ≤20% fallback · 48h bake
R  CLAUDE_CODE_RCA_SHADOW            ≥10 sessions · ≥60% converged · 48h bake
```

## Pattern Parts (every line has all six)

1. **env lever** — a single `CLAUDE_*` variable whose value synthesizes
   `currentMode ∈ {off, shadow, on/1}`. Pick the var that gates the decision,
   not the base-enablement var (B uses `_ENFORCE`, not `_MODEL_ROUTER`).
2. **recommendMode** / **revertMode** — what `--apply` writes (e.g. `'on'`)
   and what `--revert` writes back to the shadow-safe floor (usually `'shadow'`).
3. **telemetry source** — an EvidenceLedger domain (or equivalent NDJSON);
   write decision events (`route_decision`, `session_end`, …) during shadow
   so readiness has something to sample. DO NOT invent a new store.
4. **compute function** — reads ledger, counts samples + quality metric,
   returns `LineReadiness`. Always run through `gateByBake(line, ...)` so
   the bake floor is enforced uniformly.
5. **bake floor** — hours defined in `DEFAULT_BAKE_FLOOR_HOURS`; overridable
   per-line via `CLAUDE_SHADOW_BAKE_MIN_HOURS_<L>` env.
6. **samples field** — human-meaningful count (sessions/decisions/events),
   surfaced directly in one-liner and compact views.

## Adding a New Line (Checklist)

Files to edit (never more than these):

- `src/services/shadowPromote/readiness.ts`
  - Add `'X'` to `LineReadiness.line` union
  - Add `X: <hours>` to `DEFAULT_BAKE_FLOOR_HOURS`
  - Add `computeXLineReadiness()` — copy-paste B-line or R-line as template
  - Add to `computeAllShadowReadiness()` Promise.all
- `src/commands/shadow-promote/shadow-promote.ts`
  - Add `'X'` to `VALID_LINES`
- `src/commands/shadow-history/shadow-history.ts`
  - Update usage help count if present
- Source subsystem (e.g. `orchestrator.ts` for X)
  - Ensure a shadow-mode decision path writes to the chosen ledger domain
    (one new `EvidenceLedger.appendEvent(...)` call at the decision point)
  - Register a `registerCleanup()` for tail-flush when relevant
    (RCA's `registerRCAHook()` does this for `endRCA`)
- **Do NOT** touch `/kernel-status` / `/evolve-status` / `/memory-audit` —
  they already call `computeAllShadowReadiness()` and render every line.

## Compute Function Skeleton

```ts
async function computeXLineReadiness(): Promise<LineReadiness> {
  const envVar = 'CLAUDE_CODE_X_ENFORCE'          // the lever
  let currentMode = 'off'
  const base: LineReadiness = {
    line: 'X',
    envVar,
    currentMode,
    recommendMode: '1',
    revertMode: '0',                              // shadow-safe floor
    verdict: 'unknown',
    samples: 0,
    reason: '',
    firstSampleAt: null,
    bakeMs: null,
  }
  try {
    const fc = await import('../../services/xSubsystem/featureCheck.js')
    const enabled = fc.isXEnabled()
    const enforcing = fc.isXEnforceMode()
    currentMode = !enabled ? 'off' : enforcing ? '1' : 'shadow'
    base.currentMode = currentMode
    if (!enabled) {
      return { ...base, verdict: 'disabled', reason: '... set it to 1 first' }
    }
    const { EvidenceLedger } = await import('../../services/harness/evidenceLedger.js')
    const entries = EvidenceLedger.queryByDomain('x' as never, { scanMode: 'full' })
    // count samples + bad events, compute firstTs, quality ratio
    // return gateByBake('X', { ...base, verdict: 'ready', reason: '...' })
  } catch (err) {
    logForDebugging(`[shadowPromote] X-line failed: ${(err as Error).message}`)
    return { ...base, verdict: 'unknown', reason: 'read error (fail-open)' }
  }
}
```

## Threshold Design Guide

- **Samples floor**: what's "enough" for the subsystem? Router needs ≥100
  because route decisions are frequent. RCA uses ≥10 because sessions are
  rare. Pick N such that ~1 day of normal traffic hits it.
- **Quality metric**: a ratio that goes wrong direction on regressions.
  Edit-guard uses fail-ratio (lower = better); Router uses fallback-ratio;
  RCA uses converged-ratio (higher = better).
- **Bake floor**: 24h for high-frequency lines (G/Q9/C); 48h for per-session
  lines (D/E/B/R); 72h for learning-type lines where patterns need
  multiple task cycles to stabilize (F/A).

## Pitfalls

- **currentMode synthesis** must map all 3 states. Forgetting the
  "base-unset" case gives `verdict='ready'` on empty data (fail-closed bug).
- **gateByBake** must wrap ready results — never return `verdict:'ready'`
  without it or you bypass the bake floor.
- **fail-open everywhere** — the gate MUST NOT throw; wrap the whole
  compute in try/catch → verdict='unknown'. Shadow-promote is not
  allowed to break panel rendering.
- **`revertMode` != `'off'`** — revert brings a line back to shadow, not
  to hard-off. Only B uses `'0'` because its lever is the ENFORCE flag
  (shadow already runs under `_MODEL_ROUTER=1`).
- **`--apply` writes settings.json via `updateSettingsForSource`**; the
  process env is NOT updated until restart. Do NOT try to hot-reload.

## Audit Surfaces (free, auto)

Every `/shadow-promote` run writes `readiness_snapshot`; every `--apply`
success writes `cutover-applied`; every `--revert` success writes
`cutover-reverted` — all under `EvidenceDomain 'shadow-promote'`. Use
`/shadow-history --line X` to replay any line's history.

## Consumer Hooks (already wired)

- `/kernel-status` trailing one-liner
- `/evolve-status` trailing one-liner
- `/memory-audit` compact block
- `advisor.ts` Rule 9 emits `shadow.cutover.ready` advisory when any
  `verdict='ready'`
- `/rca shadow` is the subsystem-local deep view template — copy it
  (`src/commands/rca/rca.ts handleShadow`) when adding X-side visibility.
