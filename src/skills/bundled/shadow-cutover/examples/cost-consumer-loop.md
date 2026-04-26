# Shadow-Cutover: Cost-Command Consumer Loop

## Context

Shadow subsystems that only emit evidence without any reader become tech debt. The consumer-loop pattern closes that gap by surfacing aggregated evidence in a user-visible command (e.g. `/cost`), without affecting existing output when the evidence file is empty.

Landed 2026-04-25 for all seven shadow lines (every emitter now has at
least one user-visible semantic consumer — the shadow-without-consumer
gap is fully closed):

- **G-line** — `utils/promptCacheMetrics.ts` → `/cost` via
  `formatPromptCacheSummary`.
- **Q9** — `utils/promptCacheOrdering.ts` → `/cost` via
  `formatPromptCacheOrderingSummary`.
- **D-line** — `services/budgetGovernor` (`harness/budget_verdict`) →
  `/cost` via `formatBudgetGovernorSummary`.
- **E-line** — `services/causalGraph` (sqlite) → `/kernel-status` via
  `formatCausalGraphSummaryLines` (string[] variant).
- **F-line** — `services/skillSearch/onlineWeights.ts` (`outcomes.ndjson`)
  → `/memory-audit` via `formatSkillOutcomesSummary` top-N view.
- **A-line** — `services/proceduralMemory` (`<autoMem>/procedural/candidates/*.md`)
  → `/memory-audit` via `formatRecentProceduralCandidatesSummary`.
- **C-line** — `services/editGuard` (`pev.ndjson` edit_parse_ok/failed) →
  `/memory-audit` via `formatEditGuardSummary` (ok/failed ratio + byTool
  + byParser + last failure).

All of them follow the same three-function template described below.

## Env Vars

| Var | Default | Effect |
|-----|---------|--------|
| `CLAUDE_PROMPT_CACHE_METRICS` | `off` | `shadow\|on` → emit evidence; reader independent |
| `CLAUDE_PROMPT_CACHE_ORDER` | `off` | `shadow\|on` → emit evidence; reader independent |

The reader (`getXxxSummary` / `formatXxxSummary`) does **not** require the emitter env to be on — it still reads historic samples after the switch flips off, which supports `shadow → off → review-history` workflows.

## Three-Function Template

```typescript
// 1) Summary struct — what a consumer sees
export interface XxxSummary {
  mode: 'off' | 'shadow' | 'on'
  samples: number
  // …aggregated numerics
  oldestTs?: string
  newestTs?: string
}

// 2) Reader — tail-scan EvidenceLedger, fail-open, zero samples returns empty
export function getXxxSummary(window = 50): XxxSummary {
  const empty: XxxSummary = { mode: getMode(), samples: 0, /* zeros */ }
  try {
    const el = require('../services/harness/evidenceLedger.js') as
      typeof import('../services/harness/evidenceLedger.js')
    const rows = el.EvidenceLedger.queryByDomain('<domain>', {})
      .filter(e => e.kind === '<eventKind>')
    if (rows.length === 0) return empty
    const tail = rows.slice(-Math.max(1, Math.floor(window)))
    // …fold into aggregate
    return { /* aggregated */ }
  } catch {
    return empty
  }
}

// 3) Formatter — returns null when samples=0, so callers render nothing
export function formatXxxSummary(window = 50): string | null {
  const s = getXxxSummary(window)
  if (s.samples === 0) return null
  return `Xxx: <metric> (window=${s.samples}, mode=${s.mode})`
}
```

## Consumer Appender (Command Side)

```typescript
// commands/cost/cost.ts
import { formatPromptCacheSummary } from '../../utils/promptCacheMetrics.js'
import { formatPromptCacheOrderingSummary } from '../../utils/promptCacheOrdering.js'
import { formatBudgetGovernorSummary } from '../../services/budgetGovernor/index.js'

function appendShadowSummaries(base: string): string {
  const metrics = formatPromptCacheSummary(50)
  const ordering = formatPromptCacheOrderingSummary(50)
  const budget = formatBudgetGovernorSummary(50)
  if (!metrics && !ordering && !budget) return base  // ← zero-regression guard
  const parts = [base]
  if (metrics) parts.push('', metrics)
  if (ordering) parts.push(ordering)
  if (budget) parts.push(budget)
  return parts.join('\n')
}
```

Pass every existing command output through the appender. When all sources are empty the function is an identity, so users who never enabled any shadow see byte-identical output.

## Consumer Appender (Multi-Line Surfaces)

For surfaces like `/kernel-status` that already push line arrays, the formatter returns `string[]` (not `string | null`):

```typescript
// commands/kernel-status/kernel-status.ts
const { formatCausalGraphSummaryLines } = await import(
  '../../services/causalGraph/index.js'
)
const cgLines = formatCausalGraphSummaryLines({ indent: '  ', recentLimit: 20 })
if (cgLines.length > 0) {
  lines.push(...cgLines)
  lines.push('')
}
```

`cgLines.length === 0` is the same zero-regression guard — when causalGraph is off and the graph is empty, `/kernel-status` gets no new section.

## Validation (real, not mocked)

```bash
CLAUDE_PROMPT_CACHE_METRICS=shadow CLAUDE_PROMPT_CACHE_ORDER=shadow \
CLAUDE_CONFIG_DIR=/tmp/cost-dual bun -e "
  // …seed 2 metrics samples + 3 ordering samples
  // assert formatter output:
  //   Prompt cache: 56.3% hit (window=2, mode=shadow)
  //     cacheRead=0.9k cacheCreation=0.5k totalPrompt=1.6k
  //   Attachment ordering: 42.9% avg inversions (min 0.0% / max 100.0%, window=3, mode=shadow)
"
```

Always seed real evidence via the actual emitter function (`observePromptCacheUsage`, `observeAttachmentOrdering`) — do **not** hand-write ndjson. If the emitter's schema changes, your fake rows drift from the production format and the reader silently returns zeros.

## Why This Matters

- **No observability = no cutover.** Without a reader, you cannot judge when a shadow is safe to flip to `on`. The `/cost` (or `/kernel-status`) surface becomes the feedback loop.
- **Zero visual regression.** `samples=0 → null` is load-bearing. It lets you ship the consumer before anyone turns the emitter on.
- **Colocate reader with emitter.** Keep `getXxxSummary` / `formatXxxSummary` in the same file as the emitter. One schema, one test file, one place to update when the event shape evolves.
- **Reusable across commands.** The same formatter plugs into `/cost`, `/kernel-status`, `/memory-audit shadow`. Three call sites, one source of truth.

## Future Candidates (Not Yet Closed)

All seven shadow emitters now have a semantic consumer. Remaining work
is no longer "add a consumer" but "gate the cutover":

| Shadow line | Cutover blocker |
|-------------|-----------------|
| A/B/C/D/E/F/G/Q9 | Real bake data (no closure gap left) |

Next iteration should focus on:

1. Defining a per-line "readiness threshold" (e.g. samples, failure
   ratio, drift) that a consumer can compute from its own summary.
2. Wiring those thresholds into `/evolve-meta-apply` or a new
   `/shadow-promote <line>` command so cutover becomes an explicit,
   reviewable action rather than a manual env flip.
3. Resist adding new emitters until the cutover pipeline is codified
   — more shadows without more cutovers is pure debt.
