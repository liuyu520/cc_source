# Shadow-Cutover: Dream Pipeline Example

## Context

The Dream Pipeline replaces autoDream's rigid time+session gate with evidence-driven triage. It uses the standard four-phase shadow-cutover progression but adds a **three-tier decision** (skip/micro/full) instead of binary on/off.

## Env Vars

| Var | Default | Phase |
|-----|---------|-------|
| `CLAUDE_DREAM_PIPELINE=0` | on | 0 → disabled |
| `CLAUDE_DREAM_PIPELINE_SHADOW=0` | on | 1 → 2 |
| `CLAUDE_DREAM_PIPELINE_MICRO=0` | on | 2a (micro tier disabled) |

## Phase 0 → Phase 1: Shadow Wiring

```typescript
// autoDream.ts — after isGateOpen() passes
try {
  const { dispatchDream } = await import('./pipeline/index.js')
  const decision = dispatchDream({ windowMs: cfg.minHours * 3600 * 1000 })
  // In shadow mode (default), decision.action === 'legacy'
  // with decision.shadow containing the would-be tier
  if (decision.shadow) {
    logForDebugging(
      `[DreamPipeline:shadow] would=${decision.shadow.tier} ` +
        `score=${decision.shadow.score}`,
    )
  }
} catch (e) {
  logForDebugging(`[DreamPipeline] dispatch failed: ${e}`)
}
// Legacy time+session gate continues unchanged
```

## Phase 1 → Phase 2: Cutover

When `CLAUDE_DREAM_PIPELINE_SHADOW=0`:

```typescript
const decision = dispatchDream(opts)
switch (decision.action) {
  case 'skip':
    return  // triage says no dream needed — early exit
  case 'micro':
    // Only replay focusSessions (top-3 by score)
    await runMicroDream(decision.decision.focusSessions)
    return
  case 'full':
    // Proceed with legacy full consolidation
    break
}
```

## Three-Tier Nuance

Unlike binary shadow-cutover, Dream Pipeline has **three output tiers**. The progression is:

```
Phase 0: OFF         → legacy always runs
Phase 1: SHADOW      → log what tier would be chosen, legacy runs
Phase 2a: CUTOVER    → skip tier active, micro falls back to legacy
Phase 2b: +MICRO     → skip + micro tiers active, full = legacy
Phase 3: CLEANUP     → remove legacy time+session gate entirely
```

This is a generalisation of the two-phase pattern: the cutover itself has sub-phases, each controlled by an additional flag.
