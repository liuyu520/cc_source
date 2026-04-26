---
name: "agent-memory-continuity-reuse"
description: "Reuse existing query loop, session memory, relevant memories, context collapse, tasks, and meta reminders when improving long dialog memory, TaskState, resume behavior, or 长对话 多轮 连续性."
---

# Agent Memory Continuity Reuse

Use this skill when changing long-dialog continuity, current working state, resume behavior, session memory, or context pressure handling.

For this repo, create real loadable project skills in `.claude/skills/<skill-name>/SKILL.md`. The repo-root `skills/*.md` files are documentation only unless the loader is changed.

## Reuse First

- `src/query.ts`
  Keep the existing query order: tool-result budget, snip, microcompact, context collapse, autocompact, then the TaskState reminder near `callModel`.
- `src/services/memoryRouter/index.ts`
  Reuse this as the normalization layer for session memory, durable relevant memories, team memories, freshness, and summaries.
- `src/services/taskState/index.ts`
  Reuse this for intent, verified facts, open loops, failed attempts, active skills, and memory refs.
- `src/services/compact/contextBudget.ts`
  Reuse the shared budget allocator for `system / tools / history / output`. Do not reintroduce one-off ratio math in `query.ts` or `autoCompact.ts`.
- `src/services/compact/orchestrator/importance.ts`
  Reuse `buildRelevanceHint()` and `scoreMessagesAgainstCurrentTask()` for current-task relevance before inventing another history scorer.
- `src/services/compact/microCompact.ts` and `src/services/compact/toolResultSummary.ts`
  Reuse the existing time-based smart microcompact path, keep-set selection, and tool-result summary fallback instead of clearing content blindly.
- `src/services/SessionMemory/sessionMemoryUtils.ts`
  Read the current session summary from the existing file. Do not create a second session summary store.
- `src/utils/attachments.ts`
  Reuse `relevant_memories` attachments and `collectRecentSuccessfulTools`.
- `src/utils/tasks.ts`
  Reuse task list state for open loops instead of inventing another task tracker.
- `src/memdir/memoryAge.ts` and `src/memdir/teamMemPaths.ts`
  Reuse freshness and team-memory routing logic.
- `src/services/contextCollapse/index.ts` and `src/services/compact/autoCompact.ts`
  Keep collapse ahead of autocompact.
- `src/services/api/promptCacheBreakDetection.ts`
  Reuse section volatility from prompt hashing when deciding which context areas are changing most often.
- `src/utils/forkedAgent.ts`
  Reuse `runForkedAgent()` for ephemeral summaries such as compact or tool-result summaries. Do not create a second subagent execution path.

## Rules

- Do not add a second persistent memory store.
- Do not move TaskState into the static system prompt by default.
- Prefer a short hidden `isMeta` user reminder close to `callModel` so prefix caching survives.
- Keep output budget separate from input-budget decisions. Reuse the allocator rather than treating the whole context window as history space.
- Use prompt-section volatility and current-task relevance as signals. Do not add parallel counters or another message-importance framework.
- If tool results need to be compressed, prefer structured summaries first and fall back cleanly. Do not replace everything with empty markers as the primary path.
- Treat stale durable memories as hints. Current code, current tool output, and current task files win.
- If a retry path materially rewrites the visible message set, keep derived reminders consistent with the current view.
- Keep transcript persistence separate from model-visible projection. Reuse projection, do not mutate raw history unless the existing storage path already does it.

## Workflow

1. Inspect `src/query.ts`, `src/services/compact/contextBudget.ts`, and the existing memory/task sources before adding fields.
2. Extend `MemoryRouter` before adding a new attachment type.
3. Extend `TaskStateSnapshot` only with cheap deterministic signals from existing messages, tasks, and memory attachments.
4. Route context-pressure changes through the shared allocator, relevance scorer, and smart microcompact path before touching full compact logic.
5. Keep current-state conditioning ephemeral unless there is a clear resume or analytics requirement.
6. Preserve the existing order: tool-result budget, snip, microcompact, context collapse, autocompact, then the TaskState reminder near `callModel`.

## Validation

- Run a real Bun script that writes and restores `getSessionMemoryPath()` content.
- Create and delete a real task via `createTask` and `deleteTask`.
- Inject real `relevant_memories` attachments and print the routed snapshot and reminder text.
- Run `bun test src/services/compact/contextBudget.test.ts src/services/compact/microCompact.test.ts`.
- Run `bun run version`.
- Import `./src/query.ts`, `./src/services/compact/microCompact.ts`, and `./src/services/compact/contextBudget.ts` after the edit to confirm the main loop still loads.
- If repo-wide `tsc` still fails on existing `bun` typings or deprecated `baseUrl`, report that as a repo baseline issue. Do not claim full type-clean success.

## Anti Patterns

- A second memory router or parallel task state store.
- Persisting every working-state hint into transcript history.
- Replacing freshness metadata with raw timestamps only.
- Letting long-session continuity bypass current tool evidence.
- Re-adding local token-threshold math in callers that should use `contextBudget.ts`.
- Building a second relevance scorer or volatility tracker outside the shared compact path.
