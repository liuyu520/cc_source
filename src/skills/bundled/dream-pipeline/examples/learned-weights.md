# Learned Triage Weights — Closing the Feedback Loop (Phase A)

Before Phase A, `triage.ts` multiplied every evidence signal by a **hardcoded** weight (`novelty×0.4`, `conflict×0.3`, …). At the same time `feedbackLoop.ts` was dutifully persisting learned weights to `~/.claude/dream/weights.json` — but nobody read them back. The "Observe → Decide → Act → Learn" loop was open at the `Learn → Decide` hand-off.

Phase A closes that gap: `triage()` is now `async` and loads the learned weights from disk on each call.

## The Loop

```
 ┌─────────────────────────────────────────────────────────────┐
 │  1. Observe     sessionEpilogue.onSessionEnd(stats)          │
 │                  → convergeDreamEvidence(evidence)           │
 │                  → journal.ndjson                            │
 │                                                              │
 │  2. Decide      triage(evidences)                            │
 │                  ├─ w = await loadWeights()   ← Phase A      │
 │                  │     (falls back to DEFAULT_WEIGHTS        │
 │                  │      on missing / corrupt file)           │
 │                  └─ score = Σ (signal × w[signal])           │
 │                                                              │
 │  3. Act         dispatchDream → executeMicroDream            │
 │                  → persistEpisodicCards                      │
 │                                                              │
 │  4. Learn       recordDreamOutcome(decision, result)         │
 │                  ├─ appendFeedback(record)                   │
 │                  ├─ currentWeights = await loadWeights()     │
 │                  ├─ updated = updateWeights(…)    (ε-greedy) │
 │                  └─ saveWeights(updated)                     │
 │                                                              │
 │  → back to Observe with new weights                          │
 └─────────────────────────────────────────────────────────────┘
```

## Canonical Call Site

```typescript
// src/services/autoDream/pipeline/triage.ts
import { DEFAULT_WEIGHTS, loadWeights, type TriageWeights } from './feedbackLoop.js'

export async function triage(
  evidences: DreamEvidence[],
  weights?: TriageWeights,
): Promise<TriageDecision> {
  // Callers may inject pre-loaded weights to avoid duplicate IO.
  // When omitted, we ALWAYS hit feedbackLoop — that's the whole point of Phase A.
  const w = weights ?? (await loadWeights().catch(() => ({ ...DEFAULT_WEIGHTS })))
  // … score with w …
  return { /* …, weightsUsed: { ...w } */ }   // snapshot for /memory-map
}
```

The `weightsUsed` snapshot on every `TriageDecision` is what lets `/memory-map` print the *actual* weights that drove a run (not just the on-disk copy, which might have been updated afterward).

## ε-greedy Bandit — What `updateWeights` Actually Does

```
learning_rate ε = 0.05  (conservative — prevents oscillation)
top_factor       = argmax(breakdown)     // the factor that contributed most this cycle
direction        = cardsProduced > 0 ? +1 : -1

for each factor f:
  boost = (f == top_factor) ? 1.5ε : 0.5ε
  w[f] += direction × boost
  w[f]  = max(0.01, w[f])               // never hit zero

# Re-normalize so Σ(w) stays at TARGET_SUM = 1.2
scale = 1.2 / (w.novelty + w.conflict + w.correction + w.surprise + w.error)
w.novelty *= scale; …                    // graph & concept are NOT in the 1.2 budget
```

Why `graph` and `concept` live *outside* the 1.2 budget: they're additive novelty-style boosters, not replacements for the original five factors. Treating them as separate dimensions lets the bandit tune the five "classical" signals without dragging the new signals along for the ride. The defaults (`graph=0.2`, `concept=0.15`) are hand-tuned and stay put unless you extend the bandit.

## Backward-Compat Backfill

Users with pre-Phase-B1 `weights.json` on disk don't have `graph` or `concept` keys. `loadWeights()` quietly fills them with `DEFAULT_WEIGHTS` values so old deployments keep working:

```typescript
const parsed = JSON.parse(content) as Partial<TriageWeights>
if (typeof parsed.novelty === 'number') {
  return {
    novelty: parsed.novelty,
    conflict:  parsed.conflict   ?? DEFAULT_WEIGHTS.conflict,
    correction: parsed.correction ?? DEFAULT_WEIGHTS.correction,
    surprise:  parsed.surprise   ?? DEFAULT_WEIGHTS.surprise,
    error:     parsed.error      ?? DEFAULT_WEIGHTS.error,
    graph:     parsed.graph      ?? DEFAULT_WEIGHTS.graph,    // ← Phase B1 backfill
    concept:   parsed.concept    ?? DEFAULT_WEIGHTS.concept,  // ← Phase B1 backfill
    updatedAt: parsed.updatedAt  ?? new Date().toISOString(),
  }
}
```

Never delete fields from `weights.json` during migration — always backfill.

## Two Triage Entry Points

| API | Loads IO? | Uses learned weights? | Use case |
|-----|-----------|-----------------------|----------|
| `triage(evidences)` | yes | **yes** | Real dispatch path (Phase A default) |
| `triageSync(evidences)` | no  | no (DEFAULT only) | Snapshot printers (`/memory-map`, tests) |

`triageSync` is intentionally weight-agnostic: it's meant to answer "what *would* happen with default weights right now?" which is what the `/memory-map` dry-run section prints. If you want the *live* decision, call the async `triage`.

## Extending With a New Signal

When you add a new evidence field:

1. Extend `DreamEvidence` in `types.ts`.
2. Add the weight key to `TriageWeights` in `feedbackLoop.ts`.
3. Add it to `DEFAULT_WEIGHTS` — this is the backfill value.
4. Backfill in `loadWeights()` so old `weights.json` files don't crash.
5. Add the product term to **both** `triage()` and `triageSync()` score functions (keep them in sync).
6. Decide: should the bandit learn this weight (include in the 1.2 budget) or hold it fixed (out of budget, like `graph`/`concept`)?

Forgetting step 4 is the most common regression — it manifests as `NaN` scores after a format bump.
