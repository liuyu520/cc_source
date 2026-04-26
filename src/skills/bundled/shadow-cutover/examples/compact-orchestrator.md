# Shadow-Cutover: Compact Orchestrator Example

## Context

`CompactOrchestrator` controls when/how to compress conversation history. It wraps two existing functions (`snipCompactIfNeeded`, `deps.microcompact`) in `query.ts`, and `autoCompactIfNeeded` in `autoCompact.ts`.

## Phase 0 → Phase 1: Shadow Wiring

```typescript
// autoCompact.ts — shadow observation only
const { decideAndLog } = await import('./orchestrator/index.js')
decideAndLog('autoCompact', {
  messageCount: messages.length,
  stats: { usedTokens: 0, maxTokens, ratio: shouldCompact ? 0.9 : 0.5 },
  signal: { kind: shouldCompact ? 'token_pressure' : 'none', reason: '...' },
  heavyToolResultCount: 0,
})
// Legacy shouldCompact path continues unchanged
```

## Phase 1 → Phase 2: Cutover with Real Signals

```typescript
// query.ts — real signals + independent snip/micro flags
const HEAVY_TOOL_RESULT_BYTES = 8 * 1024
let heavyToolResultCount = 0
for (const m of messagesForQuery) {
  const content = (m as any)?.message?.content
  if (!Array.isArray(content)) continue
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    const s = typeof block.content === 'string'
      ? block.content : JSON.stringify(block.content ?? '')
    if (s.length > HEAVY_TOOL_RESULT_BYTES) heavyToolResultCount++
  }
}

const decision = decideAndLog('query', {
  messageCount: messagesForQuery.length,
  stats: { usedTokens: 0, maxTokens: 0, ratio: 0 },
  signal: { kind: heavyToolResultCount > 0 ? 'post_tool' : 'none', ... },
  heavyToolResultCount,
})

if (decision && !decision.shadow) {
  allowSnip = decision.plan.runSnip     // independent flag
  allowMicro = decision.plan.runMicro   // independent flag
}
```

## Key Lesson: Invariant Preservation

Original comment: "both may run — they are not mutually exclusive"

First attempt used a single `strategy` enum (`'snip' | 'micro_compact'`) → mutual exclusion → broke the invariant.

Fix: `CompactPlan` exposes `runSnip: boolean` + `runMicro: boolean` independently. The planner sets both to `true` by default (legacy), only setting `false` under extreme token pressure (`ratio > 0.85`).

## Key Lesson: Zero-Value Signal Trap

First attempt passed `{ usedTokens: 0, maxTokens: 0, ratio: 0, heavyToolResultCount: 0 }`.

With zero ratio, planner always returns `noop`. In cutover mode (`shadow=false`), this disabled both snip and micro entirely — a silent regression.

Fix: (a) compute `heavyToolResultCount` from real message scan, (b) planner's fallback branch returns `runSnip=true, runMicro=true` so even zero-ratio inputs behave like legacy.
