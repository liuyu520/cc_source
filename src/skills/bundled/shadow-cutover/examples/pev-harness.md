# Shadow-Cutover: PEV Harness Example

## Context

`PEV Harness` (Plan-Execute-Verify) adds blast-radius analysis to BashTool. It follows the same four-phase progression as CompactOrchestrator and ProviderRegistry.

## Env Vars

| Var | Default | Phase |
|-----|---------|-------|
| `CLAUDE_PEV_DRYRUN=1` | off | 0 → 1 |
| `CLAUDE_PEV_SHADOW=0` | on | 1 → 2 |

## Phase 0 → Phase 1: Shadow Wiring

```typescript
// BashTool.tsx — before runShellCommand
try {
  const { previewBash, recordPevPreview } = await import(
    '../../services/harness/pev/index.js'
  )
  const radius = previewBash(input.command ?? '')
  if (radius) recordPevPreview(radius)
} catch {
  // Shadow layer failure never affects command execution
}
```

`previewBash` internally checks `isPevDryRunEnabled()` — returns `null` when flag off (Phase 0). When flag on, it runs `analyzeBashBlastRadius` and logs via `logForDebugging`.

## Phase 1 → Phase 2: Cutover

When `CLAUDE_PEV_SHADOW=0`:

```typescript
const radius = previewBash(input.command ?? '')
if (radius && !isPevShadowMode()) {
  // Phase 2: blast radius drives permission decisions
  if (radius.requiresExplicitConfirm) {
    // Block and show BlastRadius UI to user
    yield { type: 'blast_radius_preview', radius }
  }
}
```

## Phase 3: Cleanup

Remove the `isPevShadowMode()` check, make blast-radius preview the only path. Delete the env-var guard and the shadow logging branch.

## Key Difference from Other Subsystems

PEV is a **pre-action observer**, not a decision-router. It doesn't replace a legacy path — it adds a new dimension (effect analysis) before the unchanged execution. The shadow/cutover progression controls whether that analysis is *informational* (log) or *authoritative* (blocks execution).
