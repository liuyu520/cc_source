---
description: Analyse bash commands for blast radius (affected files, reversibility, network egress) before execution. Part of the PEV (Plan-Execute-Verify) harness.
---

# Blast-Radius Analysis

Use this skill when you need to **assess the impact of a shell command before running it**, add blast-radius preview to a new tool, or extend the PEV harness with new effect patterns.

## Overview

The PEV harness intercepts every `BashTool` invocation and produces a `BlastRadius` descriptor — a structured summary of *what* the command will touch, *how reversible* it is, and *whether* it needs explicit user confirmation. This happens **before** execution, at zero cost (pure regex, no LLM call).

## Core Concepts

### Effect Tags

Every command is tagged with one or more effects:

| Tag | Meaning |
|-----|---------|
| `read` | Only reads files / state |
| `write` | Creates or modifies files |
| `exec` | Runs a process (catch-all) |
| `network` | Makes outbound connections |
| `destructive-write` | Deletes or irreversibly overwrites data |
| `vcs-mutate` | Changes git state (commit, push, rebase…) |
| `package-install` | Mutates dependency tree |
| `external-visible` | Side-effect visible outside local machine |

### Reversibility

| Level | Meaning | Examples |
|-------|---------|----------|
| `reversible` | Can undo trivially | `cat`, `ls`, `grep` |
| `partially` | Undo possible with effort | `pnpm install`, `git commit` |
| `irreversible` | Cannot undo without backup | `rm -rf`, `git push --force`, `DROP TABLE` |

### BlastRadius Shape

```typescript
interface BlastRadius {
  summary: string              // human-readable one-liner
  resources: AffectedResource[] // structured list
  reversibility: Reversibility
  requiresExplicitConfirm: boolean
  networkEgress: boolean
  effects: EffectTag[]
}
```

## How It Works

```
BashTool call
  │
  ├── import('services/harness/pev/index.js')
  │     └── previewBash(command)
  │           └── analyzeBashBlastRadius(command)
  │                 ├── match against 5 pattern tables
  │                 ├── compute effects + reversibility
  │                 └── return BlastRadius
  │
  ├── recordPevPreview(radius)   // in-memory aggregator
  │
  └── runShellCommand(...)       // unchanged legacy path
```

Key property: **the shadow layer is a pure observer**. It never blocks, never throws, never alters the command. Failures are silently caught.

## Adding New Patterns

To recognise a new command class (e.g. Docker mutations):

1. Open `src/services/harness/pev/blastRadius.ts`
2. Add a new `RegExp[]` pattern group (e.g. `CONTAINER_MUTATE_PATTERNS`)
3. In `analyzeBashBlastRadius`, add a block that tests the command and pushes appropriate `effects` + `resources`
4. Update `reversibility` if the new class is destructive

Example — Docker:

```typescript
const CONTAINER_PATTERNS: RegExp[] = [
  /\bdocker\s+(rm|rmi|system\s+prune)\b/,
  /\bdocker\s+push\b/,
]

// in analyzeBashBlastRadius:
if (anyMatch(cmd, CONTAINER_PATTERNS)) {
  effects.add('destructive-write')
  effects.add('exec')
  if (/\bdocker\s+push\b/.test(cmd)) {
    effects.add('external-visible')
    effects.add('network')
  }
  reversibility = 'irreversible'
  requiresExplicitConfirm = true
  resources.push({ kind: 'process', detail: 'container mutation' })
}
```

## Env Vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_PEV_DRYRUN` | off | Enable blast-radius analysis |
| `CLAUDE_PEV_SHADOW` | on | Shadow-only (log, don't block) |

## Observability

- Debug log tag: `[PEV:dryrun]`
- Aggregator: `pevSnapshot()` → `{ totalPreviews, byReversibility, byEffect, flagged }`

## Checklist — Adding PEV to a New Tool

- [ ] Define an `ActionContract` implementation with `dryRunPreview` + `classifyFailure`
- [ ] Call `previewBash` (or your custom preview) in a try/catch before the tool's main execution
- [ ] Feed the result to `recordPevPreview` for aggregation
- [ ] Gate behind `isPevDryRunEnabled()` — never run analysis when flag is off
- [ ] Test: verify the shadow path returns `null` when flag is off, and a valid `BlastRadius` when on

See `examples/bash-wiring.md` for the actual BashTool integration code.
