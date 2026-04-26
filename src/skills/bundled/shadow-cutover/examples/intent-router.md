# Shadow-Cutover: Intent Router Example

## Context

The Intent Router adds a zero-cost Layer-A classifier to skill recall. Unlike other subsystems, it has **no legacy path to replace** — it's purely additive. But it still follows the shadow-cutover pattern for safe introduction.

## Env Vars

| Var | Default | Phase |
|-----|---------|-------|
| `CLAUDE_SKILL_INTENT_ROUTER=1` | off | 0 → 1 |

No separate shadow var needed — Phase 1 IS the shadow (log-only). Phase 2 means the classification result drives fusion weights in `localSkillSearch`.

## Phase 0 → Phase 1: Shadow Wiring

```typescript
// prefetch.ts — inside runDiscoveryDirect, before localSkillSearch
if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
  try {
    const { classifyIntent } = await import('./intentRouter.js')
    const intent = classifyIntent(signal.query)
    logForDebugging(
      `[SkillRecall:intent] class=${intent.class} mode=${intent.taskMode}`,
    )
  } catch { /* shadow — never blocks */ }
}
const skills = await localSkillSearch(signal, toolUseContext)
```

## Phase 1 → Phase 2: Cutover

Pass `IntentResult` into `localSkillSearch` to modulate scoring:

```typescript
const intent = classifyIntent(signal.query)
const weights = fusionWeightsFor(intent.class)
const skills = await localSkillSearch(signal, toolUseContext, {
  wLexical: weights.wLexical,
  minScore: weights.minScore,
})
```

## Phase 3: Cleanup

Make intent classification mandatory (remove the env-var guard). The `classifyIntent` call becomes unconditional, and `localSkillSearch` always receives weights.

## Pattern: Additive Subsystem

When there's no legacy to replace, the shadow-cutover pattern simplifies:

- Phase 0: code exists but never runs
- Phase 1 = shadow: code runs, results logged, no effect on output
- Phase 2 = cutover: results influence output
- Phase 3: remove flag guard

Only one env var needed (the main toggle). The "shadow" env var is implicit in the fact that Phase 1 only logs.
