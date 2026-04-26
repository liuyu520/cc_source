# Scheduler-Kernel Wiring Checklist

Run through this list before merging any new entry into one of the five registries.

## Shared (applies to all registries)

- [ ] **Name is unique, kebab-case** — collision silently overwrites (idempotent), no error raised.
- [ ] **Priority chosen thoughtfully** — reserve 0-9 for "must-run-first"; default band is 10-50; sink to 100 for "last resort" fallbacks.
- [ ] **Error isolation verified** — intentionally throw from your callback; registry must log once and continue iterating.
- [ ] **`__reset*ForTests` hook exists** — required for `bun test` isolation.
- [ ] **`/kernel-status` shows the entry** — run `/kernel-status` after registration; verify section renders without `(unavailable)`.
- [ ] **No circular import** — `services/<registry>/index.ts` must not import from consumer modules.
- [ ] **Memory leak check** — no unbounded registry growth. Entries should be module-scope singletons, not per-request.

## RateBucket

- [ ] `limit` is a function (not a number) so env changes don't require restart.
- [ ] `windowMs >= 1000` — sub-second windows cause ledger thrash.
- [ ] One bucket per dimension; no bucket aliasing.
- [ ] `getSnapshot()` included in observability dashboard or `/kernel-status`.

## AutoContinueStrategy

- [ ] `detect()` is synchronous and pure (no `await`, no `fs`, no `process.*` env read in hot path).
- [ ] `prompt()` returns `''` to mean "skip" — not `null`, not `undefined`.
- [ ] `isEnabled?` checks env flags so feature can be toggled without redeploy.
- [ ] `priority` doesn't collide with `max_tokens:10` or `next_step_intent:20` by accident.
- [ ] Strategy registered at module load via a side-effect import in an early-loaded file.

## SnapshotStore

- [ ] `schemaVersion` bumped whenever serialized shape changes.
- [ ] `getSnapshot()` returns `null` (not `{}` or `undefined`) when state is empty — avoids writing junk files.
- [ ] `applySnapshot(snap)` shape-checks defensively before destructuring.
- [ ] Hydrate wired into `startAgentSchedulerBackground` (fire-and-forget) OR a bespoke entry point.
- [ ] Persist hook located at natural seam — do NOT persist inside tight loops.
- [ ] `namespace` filename safe (no `/`, no `..`) — written to `<projectDir>/snapshots/<namespace>.json`.

## ColdStart Candidate

- [ ] Prompt is **read-only** — no "write", "create", "delete", "modify" verbs.
- [ ] `when` correctly gates environment (`always` / `coordinator-only` / `non-coordinator-only`).
- [ ] `agentType` matches an actual registered agent type (run `Agent` tool with subagent_type to verify).
- [ ] Not imported from `coordinator/coordinatorMode.ts` — use env read instead to avoid circular imports.
- [ ] `source` string is short (< 24 chars) and descriptive — shows in `/kernel-status` §11.

## Shadow→Episode Writeback

- [ ] `source: 'shadow'` passed to `createAgentRunEpisode` — triggers importance halving and `source:shadow` tag.
- [ ] SessionId follows `<source>_<agent>_<YYYYMMDD>` convention — do not reuse real user sessionIds.
- [ ] `outcome` mapped correctly: `'failed' | 'timeout' → 'error'` (not `'abort'`).
- [ ] `priority: 'speculation'` tag included — marks as non-foreground sample in agentStats.
- [ ] Fire-and-forget: writeback wrapped in `void appendEpisode(...).then/.catch` — never awaited in tick.
- [ ] Env opt-out (`CLAUDE_CODE_SHADOW_NO_EPISODE`) checked at runtime.

## Cross-Registry Interactions

- [ ] If your feature spans multiple registries, verify **eviction order** — e.g. a SnapshotStore hydrate should fire BEFORE the cold-start burst schedules, so cold-start sees a warm ring buffer.
- [ ] If your feature depends on `/kernel-status` showing related data, add a side-effect import in `kernel-status.ts` to force module load.
- [ ] If your feature adds a periodic task (`registerPeriodicTask`), remember it must be registered in `background.ts::ensureTasksRegistered` or have its own start path; otherwise it won't fire.
