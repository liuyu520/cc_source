# Graph Writeback & Novelty Dedup — Closing the Storage Loop (Phase C1 + C2)

Phases A + B1 closed the **decision** feedback loop (triage re-reads learned weights) and enriched the **observation** layer (graph/concept signals). Phase C closes the remaining gap: dream output must **flow back into the same memory substrate** that future sessions observe, so that yesterday's consolidation shapes tomorrow's novelty score.

Two symmetric pieces:

- **C1 — Graph Writeback**: Every episodic card persisted by `microDream` also registers as a node in `knowledge_graph.json`, with `depends_on` edges to its artefacts.
- **C2 — Novelty Deflation**: Session epilogue checks which files were recently dreamed about, and discounts novelty accordingly so the system doesn't re-consolidate the same material every week.

Together they create the "already-dreamed-about" feedback: consolidation output → graph → next session's novelty score.

## C1 — persistEpisodicCards → Knowledge Graph

Location: `src/services/autoDream/pipeline/microDream.ts`, inside `persistEpisodicCards`.

```typescript
// After writing all card .md files to memdir/episodes/, enrich the graph.
if (writtenCards.length > 0) {
  try {
    const { loadGraph, saveGraph, ensureNode, addEdge } = await import(
      '../../../memdir/knowledgeGraph.js'
    )
    const graph = await loadGraph(memoryRoot)
    for (const { card, relPath } of writtenCards) {
      ensureNode(graph, relPath, 'episodic')            // card itself → episodic node
      for (const artifact of card.artifacts) {
        if (!artifact || typeof artifact !== 'string') continue
        ensureNode(graph, artifact, 'artifact')         // card.artifacts[] → artifact nodes
        addEdge(graph, relPath, artifact, 'depends_on', 0.7)
      }
    }
    await saveGraph(memoryRoot, graph)
  } catch (e) {
    logForDebugging(`[MicroDream] graph update skipped: ${(e as Error).message}`)
    // ← independent try/catch: graph failure must not corrupt card persistence
  }
}
```

### Design choices

- **`relPath = episodes/<sanitized-id>.episode.md`** — matches how `memoryScan` normalises filenames (`basename` after a `readdir({ recursive: true })`). Keeps the graph key space stable across modules.
- **Two node types**: `episodic` (the card file itself) and `artifact` (each file it summarises). `ensureNode` is idempotent — re-running the same dream won't explode the graph.
- **Edge weight 0.7**: lower than strong in-memdir cross-references (which are 0.9+) but strictly > 0.5 — it's a real dependency, not a loose hint.
- **Independent try/catch**: card files on disk are the canonical output. The graph is an *index*; it can be rebuilt, so a failure here is strictly downgrade, never data loss.

### Effect on downstream observers

- `computeGraphImportance` (Phase B1) now finds these new nodes. Sessions that touch an artefact that was dreamed about gain importance.
- `getRecentlyDreamedFiles` (Phase C2) reads these same artefact nodes to discount novelty — see below.
- `/memory-map`'s "Knowledge Graph" section shows higher node/edge counts over time as dreams accumulate — concrete evidence the loop is turning.

## C2 — getRecentlyDreamedFiles + Novelty Deflation

Location: `src/services/autoDream/pipeline/sessionEpilogue.ts`.

```typescript
/**
 * Set of files persisted as artifact nodes within `daysBack` days.
 * Empty Set on IO failure → callers treat as "nothing dreamed recently"
 * (no deflation, conservative fallback).
 */
async function getRecentlyDreamedFiles(daysBack: number): Promise<Set<string>> {
  try {
    const { loadGraph } = await import('../../../memdir/knowledgeGraph.js')
    const { getAutoMemPath } = await import('../../../memdir/paths.js')
    const graph = await loadGraph(getAutoMemPath())
    const cutoff = Date.now() - daysBack * 86_400_000
    const files = new Set<string>()
    for (const node of Object.values(graph.nodes)) {
      if (node.type === 'artifact' && node.lastUpdated >= cutoff) {
        files.add(node.filename)
      }
    }
    return files
  } catch {
    return new Set<string>()
  }
}
```

- **Relies on C1**: without C1 writing `artifact` nodes, this Set is always empty and deflation is a no-op. The two patches are deliberately coupled.
- **`lastUpdated` cutoff**: reused from the graph's own per-node timestamp, which `ensureNode`/`addEdge` already refresh on every write. No extra bookkeeping.
- **Quiet failure**: empty Set preserves backward behaviour — important so enabling C1 without C2 (or vice-versa) never degrades scores.

### The Deflation Function

```typescript
/**
 * Halve novelty credit proportionally to how much of this session
 * overlaps with recently-dreamed files.
 *
 * overlap=100% → novelty × 0.5  (still not zero — re-dreaming has some value)
 * overlap=50%  → novelty × 0.75
 * overlap=0%   → novelty × 1.0  (untouched)
 */
function deflateNoveltyByRecentDreams(
  rawNovelty: number,
  filesEdited: string[],
  recentlyDreamedFiles: Set<string>,
): number {
  if (recentlyDreamedFiles.size === 0 || filesEdited.length === 0) return rawNovelty
  const overlap = filesEdited.filter(f => recentlyDreamedFiles.has(f)).length
  const overlapRatio = overlap / filesEdited.length
  const discount = 1 - overlapRatio * 0.5
  return Math.round(rawNovelty * discount * 1000) / 1000
}
```

### Why 50% max deflation, not 100%?

A session that re-edits only already-dreamed files **still has value**:
- The user may be *challenging* a past consolidation (correction signal would rise).
- New surprise/error on known files is often the most informative kind.

Hard-zeroing novelty would mask those re-learning moments. Halving it is enough to redirect the pipeline's attention towards truly new work without silencing repeated-work sessions entirely.

### Wiring in `onSessionEnd`

```typescript
// Parallel IO — all three reads hit disk; no dependencies between them.
const [graphImportance, conceptualNovelty, recentlyDreamedFiles] =
  await Promise.all([
    computeGraphImportance(stats.filesEdited),
    computeConceptualNovelty(stats.filesEdited, stats.userTextSample),
    getRecentlyDreamedFiles(7),             // ← Phase C2
  ])

if (graphImportance !== undefined) evidence.graphImportance = graphImportance
if (conceptualNovelty !== undefined) evidence.conceptualNovelty = conceptualNovelty

// Apply deflation *after* the rest of evidence is assembled, so logs can show
// both the raw and deflated novelty side by side.
const originalNovelty = evidence.novelty
evidence.novelty = deflateNoveltyByRecentDreams(
  evidence.novelty,
  stats.filesEdited,
  recentlyDreamedFiles,
)

await convergeDreamEvidence(evidence)
logForDebugging(
  `[SessionEpilogue] captured evidence for session=${stats.sessionId} ` +
  `novelty=${evidence.novelty}${
    originalNovelty !== evidence.novelty
      ? `(raw=${originalNovelty}, deflated by recent dreams=${recentlyDreamedFiles.size})`
      : ''
  } …`
)
```

The log line is deliberately chatty on the deflation path — it's how we verify in production that the discount actually fires (rather than quietly always being 1.0).

## The Loop Diagram

```
 sessionEpilogue.onSessionEnd
   ├─ computeGraphImportance      ← reads knowledge_graph.json
   ├─ computeConceptualNovelty    ← reads memory_vectors.json
   ├─ getRecentlyDreamedFiles(7)  ← reads knowledge_graph.json (artifact nodes)
   └─ evidence.novelty *= (1 − overlapRatio×0.5)     (C2)
              │
              ▼
 triage (async, learned weights) → dispatchDream → executeMicroDream
              │
              ▼
 persistEpisodicCards
   ├─ write memdir/episodes/<sid>.episode.md
   └─ ensureNode(episodic) + ensureNode(artifact) + addEdge(depends_on)   (C1)
              │                                                            │
              ▼                                                            │
       knowledge_graph.json  ◄───────────────────────────────────────────┘
              │
              ▼
 (next session's) computeGraphImportance / getRecentlyDreamedFiles
```

Every arrow shown actually exists in code. No hypothetical wiring. Run `/memory-map` after a dream cycle and the "Knowledge Graph" node count should tick up; the next session's evidence line will show `(raw=…, deflated=…)` if its files overlap.

## Common Pitfalls

1. **Skipping C1 but enabling C2 in tests** — `getRecentlyDreamedFiles` returns an empty Set, deflation is a no-op, and it *looks* like the feature is broken. Always enable them together.
2. **Changing the `artifact` node type name** — Phase C2's filter is literal: `node.type === 'artifact'`. Renaming requires updating both files atomically.
3. **Moving graph writeback out of `persistEpisodicCards`** — doing it on an earlier code path means you write graph nodes even for cards that failed to persist, which desyncs the index from the on-disk ground truth. Keep writeback *after* the card `writeFileSync` loop.
