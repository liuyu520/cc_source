# Graph & Concept Signals — Evidence Beyond Activity Counts (Phase B1)

The original `DreamEvidence` leaned on *activity counts* (files edited, tool errors, user corrections). Those signals conflate "busy session" with "important session" — a 30-file refactor of generated code looks just as salient as a 3-file surgical fix touching a load-bearing module.

Phase B1 adds two *structural* signals that mine the existing memory artefacts:

| Signal | Source | Intuition |
|--------|--------|-----------|
| `graphImportance` | `knowledge_graph.json` node importances | "Does this session touch high-PageRank memories?" |
| `conceptualNovelty` | `memory_vectors.json` IDF map | "Did the user discuss rare/new concepts this session?" |

Both are **optional** on `DreamEvidence` — legacy evidence without them scores as 0 on those factors, so the upgrade is backward-compatible.

## Where They're Computed

`src/services/autoDream/pipeline/sessionEpilogue.ts` owns both computations. All IO is parallelised in `onSessionEnd`:

```typescript
const [graphImportance, conceptualNovelty, recentlyDreamedFiles] =
  await Promise.all([
    computeGraphImportance(stats.filesEdited),
    computeConceptualNovelty(stats.filesEdited, stats.userTextSample),
    getRecentlyDreamedFiles(7),          // Phase C2, see other doc
  ])
if (graphImportance !== undefined)   evidence.graphImportance = graphImportance
if (conceptualNovelty !== undefined) evidence.conceptualNovelty = conceptualNovelty
```

Undefined (i.e. IO failed or empty graph) stays undefined on the evidence object — triage then treats it as 0 via `ev.graphImportance ?? 0`.

## computeGraphImportance — Reuse `loadGraph`, Don't Re-implement PageRank

```typescript
async function computeGraphImportance(filesEdited: string[]): Promise<number | undefined> {
  if (filesEdited.length === 0) return undefined
  try {
    const { loadGraph } = await import('../../../memdir/knowledgeGraph.js')
    const { loadVectorCache } = await import('../../../memdir/vectorIndex.js')
    const { getAutoMemPath } = await import('../../../memdir/paths.js')
    const { basename } = await import('path')
    const memoryDir = getAutoMemPath()
    // Parallel IO — graph gives importance, vectorCache gives decayScore.
    const [graph, vectorCache] = await Promise.all([
      loadGraph(memoryDir),
      loadVectorCache(memoryDir).catch(() => null),
    ])
    if (Object.keys(graph.nodes).length === 0) return 0

    // Build basename → fullKey index once, so we can match edits
    // against the graph even when only the file name matches.
    const baseKeyMap = new Map<string, string>()
    for (const key of Object.keys(graph.nodes)) baseKeyMap.set(basename(key), key)

    // Pre-index decayScore by basename for O(1) lookup in the hot loop.
    const decayByBase = new Map<string, number>()
    if (vectorCache) {
      for (const [k, doc] of Object.entries(vectorCache.documents)) {
        if (typeof doc.decayScore === 'number') decayByBase.set(basename(k), doc.decayScore)
      }
    }

    let sum = 0, matched = 0
    for (const file of filesEdited) {
      const node = graph.nodes[file] ?? graph.nodes[baseKeyMap.get(basename(file)) ?? '']
      if (node) {
        // Phase B1+ — multiply by decayScore (clamped [0,1]) so stale
        // memdir entries can't inflate graph importance. Missing → 1.0.
        const decay = Math.max(0, Math.min(1, decayByBase.get(basename(file)) ?? 1))
        sum += (node.importance ?? 0.15) * decay
        matched++
      }
    }
    if (matched === 0) return 0
    // Normalize: Σ / max(5, matched), cap 1.
    // The 'max(5, …)' denominator keeps single-file high-score sessions
    // from maxing out the signal just because they happened to touch a
    // central node — we want density, not a single lucky hit.
    const normalized = Math.min(1, sum / Math.max(5, matched))
    return Math.round(normalized * 1000) / 1000
  } catch { return undefined }
}
```

Matching strategy (heuristic, intentionally not perfect):
1. Full-path hit against `graph.nodes` keys.
2. `basename` fallback — catches memdir entries stored under relative paths.
3. No match → contributes 0. Unknown files shouldn't fabricate importance.

### Phase B1+ — graph × memoryLifecycle coupling (shadow-importance fix)

The knowledge-graph node `importance` is a PageRank-like **structural** score. It's decoupled from whether the underlying memdir file is still hot: an `artifact` node written six months ago by an early dream cycle can still carry a high PageRank score because lots of episodes link to it. Without coupling, such nodes inject **shadow importance** into `graphImportance` long after the underlying memory has decayed into `archive_candidate`.

The fix is **pull-based**, not event-based: on each compute, we read `decayScore` from the vector cache (populated by the same lifecycle used in `findRelevantMemories.ts:177/208`) and multiply it into each node's contribution. This reuses the existing precedent instead of wiring lifecycle transition events.

| Underlying file state | `decayScore` | Contribution multiplier |
|-----------------------|--------------|-------------------------|
| `active` (fresh, often accessed) | ≥ 0.3 (often 1.0+, clamped to 1.0) | full importance |
| `decaying` | 0.1 – 0.3 | 10–30% importance |
| `archive_candidate` | < 0.1 | near-zero contribution |
| not in vectorCache | — | default 1.0 (don't punish unindexed nodes) |

The `[0,1]` clamp is deliberate: `computeDecayScore` can exceed 1.0 via `accessBoost + recencyBoost`, and letting a "hot" file inflate `graphImportance` past its PageRank ceiling would break the `max(5, matched)` normalisation guarantee.

## computeConceptualNovelty — IDF-based Bag-of-Words

```typescript
async function computeConceptualNovelty(
  filesEdited: string[],
  userTextSample: string | undefined,
): Promise<number | undefined> {
  try {
    const { loadVectorCache } = await import('../../../memdir/vectorIndex.js')
    const cache = await loadVectorCache(getAutoMemPath())
    const idfEntries = Object.entries(cache.idfMap)
    if (idfEntries.length === 0) return 0

    // Cheap tokenizer: keep en/zh/underscore/dash, drop short + numeric.
    const rawText = [
      ...filesEdited.flatMap(p => p.split(/[\/\\._-]+/)),
      userTextSample ?? '',
    ].join(' ')
    const terms = rawText.toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff_]+/)
      .filter(t => t.length >= 3 && !/^\d+$/.test(t))
    if (terms.length === 0) return 0

    // High-idf threshold = 75th percentile of the corpus IDF, floored at 1.5.
    const idfValues = idfEntries.map(([, v]) => v).sort((a, b) => a - b)
    const p75 = idfValues[Math.min(idfValues.length - 1,
                                   Math.floor(idfValues.length * 0.75))] ?? 1.5
    const threshold = Math.max(p75, 1.5)

    const unique = new Set(terms)
    let highIdfCount = 0, unseenCount = 0
    for (const t of unique) {
      const idf = cache.idfMap[t]
      if (idf === undefined) unseenCount++
      else if (idf >= threshold) highIdfCount++
    }
    // Unseen tokens ≈ log(docCount) worth of "new concept" evidence, capped at 2.
    const docCount = Object.keys(cache.documents).length
    const unseenWeight = docCount > 1 ? Math.log(docCount) : 1
    const novelty = highIdfCount + unseenCount * Math.min(unseenWeight, 2)
    return Math.round(Math.min(1, novelty / Math.max(10, unique.size)) * 1000) / 1000
  } catch { return undefined }
}
```

Why this design works:
- **p75 not p90**: we want a signal that moves on a decent fraction of sessions, not only the top 10%.
- **Floor at 1.5**: in a brand-new corpus almost every IDF is low; the floor prevents early sessions from being drowned in "high idf" noise.
- **Unseen weight capped at 2**: keeps corpus-size growth from ballooning novelty scores over time.
- **`max(10, unique.size)` denominator**: short sessions can't max the signal.

## Where `userTextSample` Comes From

`extractSessionStats` in the same file collects up to 1600 chars of user text, sliced per-message at 400 chars:

```typescript
const userTextParts: string[] = []
const USER_TEXT_BUDGET = 1600
// …per message:
if (text && userTextParts.join(' ').length < USER_TEXT_BUDGET) {
  userTextParts.push(text.slice(0, 400))
}
// …at return:
const userTextSample = userTextParts.join(' ').slice(0, USER_TEXT_BUDGET)
return {
  /* …, */
  userTextSample: userTextSample.length > 0 ? userTextSample : undefined,
}
```

The budget keeps memory overhead constant; the per-message slice stops a single giant paste from eating the whole budget. If `userTextSample` is missing, `computeConceptualNovelty` gracefully falls back to *only* the tokenised file paths.

## How Triage Consumes These

```typescript
// triage.ts
function scoreEvidence(ev: DreamEvidence, w: TriageWeights): number {
  return (
    ev.novelty * w.novelty +
    ev.conflicts * w.conflict +
    ev.userCorrections * w.correction +
    ev.surprise * w.surprise +
    ev.toolErrorRate * w.error +
    (ev.graphImportance ?? 0) * w.graph +      // ← 0 when missing
    (ev.conceptualNovelty ?? 0) * w.concept    // ← 0 when missing
  )
}
```

Default weights: `graph=0.2`, `concept=0.15`. These live **outside** the 1.2 bandit budget (see `learned-weights.md`) because they're additive structural boosters, not replacements for activity-based signals.

## Testing Without Disk IO

Both compute functions are designed to return `undefined` on any error / empty index, so they can be omitted safely in test fixtures. Unit tests should assert that `triage` degrades cleanly:

```typescript
const ev: DreamEvidence = {
  sessionId: 's1', endedAt: new Date().toISOString(), durationMs: 60_000,
  novelty: 0.5, conflicts: 0, userCorrections: 0,
  surprise: 0, toolErrorRate: 0,
  filesTouched: 3, memoryTouched: false,
  // graphImportance & conceptualNovelty intentionally omitted
}
// triageSync(ev) must still produce a sensible score using novelty only.
```
