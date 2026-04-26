# Pipeline Spec — Walkthrough

A realistic 3-stage pipeline that leverages all four layers. Scenario: refactoring a shared logger utility across a monorepo.

## Stage plan

1. **map** — claude-code walks the repo and lists every call site.
2. **design** — gemini (long context) proposes the new API signature against the call-site catalog.
3. **apply** — codex performs the mechanical edits.

## Full spec

```typescript
import { runPipeline } from 'src/services/externalAgentPipeline/index.js'

const run = await runPipeline({
  name: 'logger-api-refactor',
  cwd: '/Users/you/repo/monorepo',
  variables: { targetModule: 'packages/logger' },
  stages: [
    {
      name: 'map',
      agent: 'claude-code',
      task: (ctx) =>
        `List every import or call site of packages/logger in ${ctx.cwd}. Output format: file:line  signature`,
      timeoutMs: 120_000,
      fingerprintTaskText: 'map logger call sites',
    },
    {
      name: 'design',
      agent: 'gemini',
      task: (ctx) =>
        [
          'Given the call-site catalog below, propose a new public API for the logger module.',
          'Constraints: preserve log levels, keep `createLogger(name)` signature.',
          'Output a single TypeScript .d.ts block.',
          '',
          ctx.previous ?? '(no catalog available)',
        ].join('\n'),
      timeoutMs: 120_000,
      fingerprintTaskText: 'design logger new public API',
    },
    {
      name: 'apply',
      agent: 'codex',
      task: (ctx) =>
        [
          'Apply the new public API design below.',
          'Keep old signatures exported as deprecation shims for one release.',
          '',
          ctx.previous ?? '(design missing — abort)',
        ].join('\n'),
      timeoutMs: 180_000,
      fingerprintTaskText: 'apply logger refactor',
      // If codex times out mid-apply, we do NOT want to continue pretending it succeeded.
      continueOnError: false,
    },
  ],
})
```

## Behavior notes

- Because `map` and `design` use different agents, `previous` is piped as plain text (no structured handoff).
- Each stage's `fingerprintTaskText` is chosen to be **topic-stable** — so the next time someone runs a "map logger call sites" stage (even against a slightly reworded task), `buildContextPrefix` will inject the prior catalog summary.
- Persistence is per-stage: if `map` succeeds and `design` fails, only `map` writes back to the fingerprint store. `run.status` will be `partial` (unless `continueOnError: false` triggers `failed` + skipped tail).
- Token accounting is per stage; sum `run.stages[].tokens.input/output` for the whole run.

## Observing the result

After running, `/kernel-status` will show:

```
### External Agent Pipeline (P1 流水线分工)
History: 1 run(s)
[pipeline_1_...] "logger-api-refactor" status=success dur=4m10s stages=3
   - map              claude-code success 1m02s in=2100/out=4400 fp=yes
   - design           gemini      success 1m40s in=4800/out=5200 fp=yes
   - apply            codex       success 1m28s in=5200/out=6100 fp=yes
```

And the fingerprint store will have three new entries that any future pipeline or ad-hoc delegation can reuse via `buildContextPrefix`.

## When NOT to use this template

- Single-stage work → just call `DelegateToExternalAgentTool` (optionally via `routeExternalAgent`).
- Stages that need to branch/loop → pipeline is strictly sequential. Drive branching from Claude's main loop and call `runPipeline` for each linear segment.
- Human approval between stages → pipeline is fire-once. Split into multiple `runPipeline` invocations with the human decision in between.
