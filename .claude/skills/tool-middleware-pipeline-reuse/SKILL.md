---
name: "tool-middleware-pipeline-reuse"
description: "Reuse the shared tool execution middleware pipeline when adding tool metrics, caching, concurrency limits, audit logging, or new execution interceptors."
---

# Tool Middleware Pipeline Reuse

Use this skill when changing shared tool execution behavior rather than one specific tool implementation. Typical triggers: tool metrics, structured audit logs, read-result caching, shared concurrency control, or new pre/post execution interceptors.

## Reuse First

- `src/services/tools/toolMiddleware.ts`
  This is the shared middleware chain. Add new interception behavior here before creating another execution path.
- `src/services/tools/toolExecution.ts`
  This is the canonical runtime path that wraps `tool.call()` and bridges middleware state into logs and telemetry.
- `src/services/tools/toolHooks.ts`
  Reuse existing pre/post tool hook boundaries instead of inventing another interception layer around tool execution.
- `src/services/tools/toolConcurrency.ts`
  Reuse the shared concurrency source and `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` wiring.
- `src/utils/hooks.ts`
  Reuse the hook execution engine when a middleware concern should also surface as hook-style lifecycle behavior.
- `src/tools.ts`
  Keep `assembleToolPool()` focused on merge and dedupe. Do not move execution behavior into tool assembly.

## Rules

- Keep per-tool `validateInput()` and `checkPermissions()` on the tool itself. Middleware is for cross-cutting execution behavior, not tool-specific business rules.
- Insert shared behavior between assembled tools and actual `tool.call()`.
- Prefer middleware state that can be reused by logging, analytics, and tracing. Do not hide important execution facts in ad hoc local variables.
- Cache only deterministic read-style tools unless the invalidation story is explicit and already wired.
- Use structured logs and OpenTelemetry-friendly fields. Do not add `console.log` debugging as the final design.
- Reuse the existing shared semaphore and cache invalidation flow before adding new env vars or global state.

## Workflow

1. Inspect `src/services/tools/toolExecution.ts` to confirm the current canonical call path.
2. Extend `src/services/tools/toolMiddleware.ts` with a focused middleware instead of branching `tool.call()` in multiple places.
3. If the change affects concurrency, route it through `src/services/tools/toolConcurrency.ts`.
4. If the change should be observable outside execution, thread the middleware result into existing logs, analytics, or spans instead of emitting a separate side channel.
5. Keep `src/tools.ts` as assembly-only unless the user explicitly asks to redesign tool discovery.

## Validation

- Run `bun test src/services/tools/toolMiddleware.test.ts`.
- Run `bun run version`.
- Import `./src/services/tools/toolExecution.ts` after the edit to confirm the shared execution path still loads.
- If repo-wide `tsc` still fails on existing `bun` typings or deprecated `baseUrl`, report that as a repo baseline issue.

## Anti Patterns

- Re-implementing middleware logic separately inside each tool.
- Adding a second shared execution path that bypasses `executeToolMiddlewareChain()`.
- Putting caching or concurrency logic into `assembleToolPool()`.
- Caching write or mutation tools by default.
- Emitting final audit or metrics data only through debug text instead of structured state.
