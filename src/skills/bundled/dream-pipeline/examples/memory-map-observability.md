# /memory-map — The Observability Lens on the Feedback Loop (Phase A–D)

`/memory-stats` shows **what is stored** (documents, graph size). `/memory-map` answers a different question: **is the closed loop actually turning?** Each section maps to a specific upgrade phase, so this command doubles as an integration test for Phases A–D when changes touch the dream pipeline.

Command file: `src/commands/memory-map/memory-map.ts` (invoked as `/memory-map`, registered via `src/commands.ts` → `memoryMap` from `src/commands/memory-map/index.ts`).

## Why a Separate Command

Keeping all seven sections in one printer has a deliberate benefit: **every section is in one visual frame**, which makes stale feedback loops glaring. An isolated "weights inspector" would make it easier to ship a Phase A regression where `triage` stops reading `weights.json` but `weights.json` still updates — the two panels would look healthy independently.

## The Seven Sections — each has an independent `try/catch`

| # | Section | Observes Phase | What "healthy" looks like |
|---|---------|----------------|---------------------------|
| 1 | Memory Lifecycle | (baseline) | Non-zero `active`/`decaying` counts; `Top accessed` populated after a few recalls |
| 2 | Knowledge Graph | **C1** | Node/edge counts grow over time; `top-importance` includes recent artefacts |
| 3 | Dream Journal (7d) | (baseline + B1) | `Evidence entries > 0`; recent rows show `nv=… cf=… sp=…` |
| 4 | **Learned Triage Weights vs DEFAULT** | **A + B1** | `Updated at` is recent; at least one Δ value is non-zero |
| 5 | Dream Feedback Loop | **A** | `effective=X/Y` ratio is trending up; tier histogram isn't all `skip` |
| 6 | Procedural Memory | (separate loop) | Enabled + recent learning cycle |
| 7 | **Dream Pipeline Flags** | **D** | Shows the live env-var state (did the user actually flip shadow off?) |

Every section writes to the same `lines: string[]` buffer. A single `onDone(lines.join('\n'))` at the end emits the report. Adding a new section = a new `try/catch` block + `lines.push(...)`.

## Section 4 — The Phase A Diagnostic

```typescript
const { loadWeights, DEFAULT_WEIGHTS } = await import(
  '../../services/autoDream/pipeline/feedbackLoop.js'
)
const w = await loadWeights()
lines.push('### Learned Triage Weights (vs DEFAULT)')
lines.push(`Updated at: ${w.updatedAt}  (${fmtTs(w.updatedAt)})`)
lines.push(`  novelty    = ${fmtDelta(w.novelty,    DEFAULT_WEIGHTS.novelty)}`)
lines.push(`  conflict   = ${fmtDelta(w.conflict,   DEFAULT_WEIGHTS.conflict)}`)
lines.push(`  correction = ${fmtDelta(w.correction, DEFAULT_WEIGHTS.correction)}`)
lines.push(`  surprise   = ${fmtDelta(w.surprise,   DEFAULT_WEIGHTS.surprise)}`)
lines.push(`  error      = ${fmtDelta(w.error,      DEFAULT_WEIGHTS.error)}`)
lines.push(`  graph      = ${fmtDelta(w.graph,      DEFAULT_WEIGHTS.graph)}`)
lines.push(`  concept    = ${fmtDelta(w.concept,    DEFAULT_WEIGHTS.concept)}`)
```

### What `fmtDelta` prints

```typescript
function fmtDelta(learned: number, defaultVal: number): string {
  const delta = learned - defaultVal
  const sign = delta > 0 ? '+' : ''
  if (Math.abs(delta) < 0.005) return `${learned.toFixed(3)} (·)`   // unchanged
  return `${learned.toFixed(3)} (${sign}${delta.toFixed(3)})`
}
```

- `0.400 (·)` → weight untouched since the default — either never trained, or bandit decided default was optimal.
- `0.520 (+0.120)` → bandit is rewarding this factor; the pipeline thinks it's predictive of useful consolidations.
- `0.310 (-0.090)` → bandit has been punishing this factor; the signal is noisy or misaligned.

If **every** line reads `(·)` after dozens of dream cycles, you have a broken Phase A loop — likely `recordDreamOutcome` isn't being called, or it's swallowing its own errors. Cross-check with section 5.

## Section 3 — The Phase B1 Diagnostic (dry-run triage)

```typescript
const evidences = listRecent(7 * 24 * 3600 * 1000)
if (evidences.length > 0) {
  const dryDecision = triageSync(evidences)   // ← DEFAULT weights, not learned
  lines.push(`Dry-run triage (DEFAULT weights): tier=${dryDecision.tier} score=${dryDecision.score}`)
  const bd = dryDecision.breakdown
  lines.push(
    `  contrib: novelty=${bd.novelty} conflict=${bd.conflict} correction=${bd.correction} ` +
    `surprise=${bd.surprise} error=${bd.error} graph=${bd.graph ?? 0} concept=${bd.concept ?? 0}`,
  )
  // plus the last 3 raw evidence rows
}
```

`triageSync` is intentionally used here — the point is to show *what the raw signals would do* using the hand-picked defaults, **separately** from whatever the bandit has since learned. Section 4 shows how learning has moved away from defaults; section 3 shows what defaults produce. Together they diagnose whether drift is real or noise.

If `graph` and `concept` contributions are `0` over 7 days, either:
- The memdir graph/vector indexes are empty (brand-new installation — expected).
- `sessionEpilogue` isn't populating those fields — check `onSessionEnd` logs for `graph=… concept=…`.

## Section 5 — The Phase A Outcome Tally

```typescript
const fbPath = join(dir, 'dream', 'feedback.ndjson')
// … parse last 50 records …
const effective = records.filter(r => r.cardsProduced > 0).length
lines.push(
  `Recent ${total} outcomes: effective=${effective}/${total} ` +
  `(${total > 0 ? Math.round((effective / total) * 100) : 0}%) ` +
  `| avg=${(avgMs / 1000).toFixed(1)}s`,
)
```

The critical number is `effective/total`. If micro-dream runs but produces zero cards for most attempts, either:
- The sub-agent is hallucinating malformed JSON (check `parseEpisodicCards` in `microDream.ts`).
- Transcripts are coming through as `(transcript unavailable)` (check `getSessionTranscriptSummary`).

Effective ratio plus section 2's node-count trend is how you tell the loop is *producing something useful*, not just cycling.

## Section 7 — The Phase D Flag Inspector

```typescript
const {
  isDreamPipelineEnabled,
  isDreamPipelineShadow,
  isDreamMicroEnabled,
} = await import('../../services/autoDream/pipeline/featureCheck.js')
lines.push('### Dream Pipeline Flags')
lines.push(`CLAUDE_DREAM_PIPELINE         = ${isDreamPipelineEnabled() ? 'on' : 'off'}`)
lines.push(`CLAUDE_DREAM_PIPELINE_SHADOW  = ${isDreamPipelineShadow() ? 'on (decision-only)' : 'off (live dispatch)'}`)
lines.push(`CLAUDE_DREAM_PIPELINE_MICRO   = ${isDreamMicroEnabled() ? 'on' : 'off'}`)
```

### The Phase D contract, in one picture

| Env var | Default (Phase D) | Meaning |
|---------|-------------------|---------|
| `CLAUDE_DREAM_PIPELINE`        | **on** | Evidence capture + triage run (observation) |
| `CLAUDE_DREAM_PIPELINE_SHADOW` | **on** | `dispatchDream` returns `legacy` — no real behavior change |
| `CLAUDE_DREAM_PIPELINE_MICRO`  | **on** | Micro executor wired (but suppressed while shadow is on) |

Only `SHADOW=0` or `SHADOW=false` actually opens the gate to live dispatch. This is the **only** dial users need to flip to go from "silent observation" (default) to "real consolidation".

```typescript
// featureCheck.ts — opt-out semantics, not opt-in
function envDisabled(name: string): boolean {
  const v = process.env[name]
  return v === '0' || v === 'false'
}
export function isDreamPipelineEnabled(): boolean { return !envDisabled('CLAUDE_DREAM_PIPELINE') }
```

Why opt-out: the pipeline is strictly additive in shadow mode (journals + weights files, no behavioural change). Opt-in would leave the baseline observation dark for most users and defeat the whole "learn from real usage" premise.

## Extending /memory-map with a new section

```typescript
try {
  // 1. Dynamic import the module you want to probe — keeps command cold-start cheap.
  const { myNewModule } = await import('../../services/.../myNewModule.js')
  const status = await myNewModule.readStatus()
  lines.push('### My New Loop')
  lines.push(`counter=${status.counter}  lastEvent=${fmtTs(status.lastEvent)}`)
  lines.push('')
} catch (e) {
  lines.push('### My New Loop')
  lines.push(`(unavailable: ${(e as Error).message})`)
  lines.push('')
}
```

Rules the existing sections all follow:
1. **Independent `try/catch`** — one module failing must not silence the rest.
2. **Graceful "(unavailable: …)"** — the empty state is informational, not a bug.
3. **Dynamic `await import`** — heavy modules load only when `/memory-map` runs.
4. **Trailing `lines.push('')`** — a blank line before the next section keeps the report readable.
5. **Use `fmtTs`/`fmtDelta`** from the same file — consistency is cheap.

## When to run /memory-map

- **After a dream-pipeline code change** — confirm the section you changed still renders and shows the new value you intended.
- **As part of weekly housekeeping** — effective ratio + weight drift give an at-a-glance health score.
- **When debugging "the model isn't learning from corrections"** — compare sections 3, 4, and 5 for an open loop (see the detective flow in `learned-weights.md`).
