---
description: Evidence-driven dream pipeline — capture session evidence, triage via learned weights into skip/micro/full tiers, close the loop through graph writeback + novelty dedup, and observe via /memory-map.
---

# Dream Pipeline

Use this skill when you need to **extend the dream (memory consolidation) system**, add new evidence signals, tune triage thresholds, close a feedback loop, or wire a new dream stage into the existing `autoDream.ts` lifecycle.

## Overview

The legacy `autoDream` used a rigid time+session double gate (`minHours=24`, `minSessions=5`). The Dream Pipeline replaces that with a **closed, evidence-driven loop**:

```
Observe  →  Decide  →  Act  →  Learn  →  (loop back)
```

- **Observe** — `sessionEpilogue.onSessionEnd` mines session statistics + knowledge-graph + IDF index for multi-source evidence.
- **Decide** — `triage(evidences)` reads learned weights and scores each evidence into `skip`/`micro`/`full`.
- **Act** — `dispatchDream` hands `micro`/`full` off to executors; on `micro`, `persistEpisodicCards` writes cards *and* feeds artefacts back into the knowledge graph.
- **Learn** — `recordDreamOutcome` runs an ε-greedy bandit that nudges weights based on whether the cycle actually produced cards.

The loop is observable at any time via `/memory-map`.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Session ends                                                          │
│    │                                                                   │
│    ├─ sessionEpilogue.extractSessionStats → SessionStats               │
│    │                                                                   │
│    └─ sessionEpilogue.onSessionEnd                                     │
│        ├─ computeEvidence(stats)                                       │
│        ├─ parallel IO (Phase B1 + C2):                                 │
│        │    • computeGraphImportance(filesEdited)   [B1]               │
│        │    • computeConceptualNovelty(files+text)  [B1]               │
│        │    • getRecentlyDreamedFiles(7d)           [C2]               │
│        ├─ evidence.novelty *= deflateByRecentDreams [C2]               │
│        └─ convergeDreamEvidence(evidence) ─► ~/.claude/dream/journal   │
│                                                                        │
│  ... gate passes ...                                                   │
│                                                                        │
│  autoDream.ts → await dispatchDream({ windowMs })                      │
│    ├─ listRecent(windowMs)                                             │
│    ├─ await triage(evidences)                                          │
│    │    ├─ w = await loadWeights()                   [Phase A]         │
│    │    ├─ score = Σ (signal × w[signal])            (7 factors)       │
│    │    └─ return { tier, score, focusSessions, weightsUsed }          │
│    └─ switch (action)                                                  │
│         ├─ 'skip'   → record outcome (0 cards) ─► bandit               │
│         ├─ 'micro'  → executeMicroDream → persistEpisodicCards         │
│         │             └─ ensureNode + addEdge into knowledge_graph [C1]│
│         │             → recordDreamOutcome → updateWeights     [A]     │
│         ├─ 'full'   → legacy 4-phase consolidation                     │
│         └─ 'legacy' → shadow mode on / pipeline off                    │
└────────────────────────────────────────────────────────────────────────┘
```

Every arrow exists in code. `/memory-map` prints the state of each stage.

## Evidence Schema

```typescript
interface DreamEvidence {
  sessionId: string
  endedAt: string          // ISO timestamp
  durationMs: number
  novelty: number          // 0..1 (rule-estimated, then C2-deflated)
  conflicts: number        // user said "no"/"wrong"/rollback
  userCorrections: number  // explicit correction count
  surprise: number         // tool errors / retries / exceptions
  toolErrorRate: number    // 0..1
  filesTouched: number
  memoryTouched: boolean
  // Phase B1 — optional, absent = old captures or empty indexes
  graphImportance?: number   // 0..1, PageRank-ish density over edited files
  conceptualNovelty?: number // 0..1, high-IDF + unseen tokens
}
```

New fields are **optional** so old journal rows stay valid; `triage` uses `ev.graphImportance ?? 0`.

## Triage Scoring — Dynamic Weights (Phase A)

```
score = novelty          × w.novelty
      + conflicts        × w.conflict
      + userCorrections  × w.correction
      + surprise         × w.surprise
      + toolErrorRate    × w.error
      + graphImportance  × w.graph     ← Phase B1
      + conceptualNovelty× w.concept   ← Phase B1
```

Weights come from `feedbackLoop.loadWeights()`. Defaults (bandit-learnable "classical 5" sum to a 1.2 budget; `graph`/`concept` live outside that budget as structural boosters):

```typescript
DEFAULT_WEIGHTS = {
  novelty: 0.4, conflict: 0.3, correction: 0.2,
  surprise: 0.1, error: 0.2,    // Σ = 1.2 (bandit-tuned)
  graph: 0.2, concept: 0.15,    // additive, held by default
}
```

| Score | Tier | Action |
|-------|------|--------|
| < 5   | `skip`  | No dream |
| 5–15  | `micro` | Replay top-K focus sessions (`FOCUS_TOP_K = 3`) |
| ≥ 15  | `full`  | Full consolidation (legacy path) |

See `examples/learned-weights.md` for the full feedback-loop walkthrough (including ε-greedy details and backward-compat backfill).

## Two Triage Entry Points

| API | IO | Weights | Use case |
|-----|----|---------|----------|
| `triage(evidences)` — async | reads `weights.json` | **learned** | Real dispatch |
| `triageSync(evidences)` — sync | none | DEFAULT only | Snapshots, `/memory-map` dry-run |

`dispatchDream` is `async` and always uses `triage`. Never swap `triageSync` into live dispatch — it will decouple decisions from learned weights and re-open the Phase A loop.

## Phase B1 — Structural Signals

Beyond raw activity counts, the epilogue mines two structural dimensions from the memdir:

- `graphImportance` — sum of `node.importance` over matched edited files (basename fallback), normalised by `max(5, matched)`.
- `conceptualNovelty` — high-IDF tokens (p75 threshold, floor 1.5) + unseen-token bonus (capped `log(docCount)`), normalised by `max(10, uniqueTerms)`.

Both gracefully return `undefined` on IO failure or empty indexes → triage treats as 0. Computed in parallel via `Promise.all` to keep session-end latency constant.

See `examples/graph-concept-signals.md` for the full computation and the tokenisation contract.

## Phase C — Closing the Storage Loop

Phase A closed the decision loop; Phase C closes the storage loop so dream output **flows back** to influence future observations.

- **C1 — Graph Writeback**: `persistEpisodicCards` creates an `episodic` node per card and an `artifact` node per referenced file, linked by `depends_on` edges (weight 0.7). Independent `try/catch` — graph failure never corrupts card persistence.
- **C2 — Novelty Deflation**: `getRecentlyDreamedFiles(7d)` returns the `artifact` nodes written in the last week; `deflateNoveltyByRecentDreams` halves novelty proportionally to overlap. `overlap=100%` → `×0.5`; `overlap=0%` → `×1.0` (never zeroes out — re-learning still has value).

See `examples/graph-writeback-novelty-dedup.md` for the coupling contract and common pitfalls.

## Phase D — Flipped Env Var Defaults

```typescript
// featureCheck.ts — opt-out semantics
function envDisabled(name: string) {
  const v = process.env[name]
  return v === '0' || v === 'false'
}
export const isDreamPipelineEnabled  = () => !envDisabled('CLAUDE_DREAM_PIPELINE')
export const isDreamPipelineShadow   = () => !envDisabled('CLAUDE_DREAM_PIPELINE_SHADOW')
export const isDreamMicroEnabled     = () => !envDisabled('CLAUDE_DREAM_PIPELINE_MICRO')
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_DREAM_PIPELINE` | **on** | Capture + triage (observation) |
| `CLAUDE_DREAM_PIPELINE_SHADOW` | **on** | `dispatchDream` returns `legacy` — no behaviour change |
| `CLAUDE_DREAM_PIPELINE_MICRO` | **on** | Micro executor wired (suppressed by shadow) |

Default state = **silent observation**: journal + graph + weights all update, but the user's dream dispatch still runs the legacy path. Flipping `CLAUDE_DREAM_PIPELINE_SHADOW=0` is the single dial that moves from shadow to live.

## Adding a New Evidence Signal

1. Extend `DreamEvidence` in `src/services/autoDream/pipeline/types.ts` (keep new fields **optional**).
2. Populate the field inside `sessionEpilogue.onSessionEnd` — prefer parallel IO via `Promise.all`, return `undefined` on failure.
3. Add the weight key to `TriageWeights` and `DEFAULT_WEIGHTS` in `feedbackLoop.ts`.
4. **Backfill in `loadWeights()`** — `parsed.newField ?? DEFAULT_WEIGHTS.newField`. Skipping this breaks old deployments.
5. Add the product term to both `triage()` and `triageSync()` (keep them in sync).
6. Decide: include in the bandit's 1.2 budget (the "classical 5") or hold fixed out of budget (like `graph`/`concept`).
7. Shadow-observe via `/memory-map` for ≥ 1 week before adjusting tier thresholds.

## Wiring Into autoDream

The dispatch is inserted at the top of `runAutoDream` (after `isGateOpen` passes):

```typescript
try {
  const { dispatchDream } = await import('./pipeline/index.js')
  const decision = await dispatchDream({ windowMs: cfg.minHours * 3600 * 1000 })
  //              ^^^^^ — Phase A made this async; missing the await silently
  //                     resolves to a Promise, defeats triage, hides bugs.
  if (decision.action === 'skip')  return
  if (decision.action === 'micro') { /* executeMicroDream path */ }
  else if (decision.action === 'full')   { /* proceed legacy */ }
  else if (decision.action === 'legacy') { /* shadow or pipeline off */ }
} catch (e) { /* fallback to legacy */ }
```

## Observability

- Debug tags: `[SessionEpilogue]`, `[DreamPipeline]`, `[DreamPipeline:shadow]`, `[DreamPipeline:triage]`, `[MicroDream]`, `[MicroDream:dryRun]`
- Journal:  `~/.claude/dream/journal.ndjson`    (append-only, tail-read)
- Weights:  `~/.claude/dream/weights.json`      (overwritten on each update)
- Feedback: `~/.claude/dream/feedback.ndjson`   (append-only outcome ledger)
- Episodes: `<memoryRoot>/episodes/<sid>.episode.md`
- Graph:    `<memoryRoot>/knowledge_graph.json` (artefact nodes added on each dream)

`/memory-map` is the one-shot inspector for all of the above. See `examples/memory-map-observability.md`.

## Example Files

| File | Phase | Topic |
|------|-------|-------|
| `examples/evidence-capture.md` | baseline | Wiring `captureEvidence` into session-end hooks |
| `examples/learned-weights.md` | **A** | Closed feedback loop, ε-greedy bandit, backfill |
| `examples/graph-concept-signals.md` | **B1** | `computeGraphImportance` + `computeConceptualNovelty` |
| `examples/graph-writeback-novelty-dedup.md` | **C1 + C2** | Graph writeback + novelty deflation coupling |
| `examples/memory-map-observability.md` | **A–D** | Reading `/memory-map` as a loop health check |

## Future Stages (v3+)

| Stage | Purpose | Status |
|-------|---------|--------|
| Capture | Session evidence journal | ✅ v1 |
| Triage | Score → tier (learned weights) | ✅ v2 (Phase A) |
| Structural signals | graph + concept | ✅ v2 (Phase B1) |
| Storage loop | Graph writeback + novelty dedup | ✅ v2 (Phase C) |
| Default flip | Observation-on, dispatch shadowed | ✅ v2 (Phase D) |
| Replay | Per-session sharded extraction | Planned |
| Weave | Cross-session conflict detection + merge | Planned |
| Audit/Decay | Confidence decay + forgetting | Partial (memoryLifecycle) |
