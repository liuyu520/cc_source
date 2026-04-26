---
description: Orchestrate external-agent subscriptions (codex / gemini / claude-code) via the project's four-layer external agent stack — capability router, pipeline runner, shadow runner, and context-fingerprint memory. Use when picking which CLI to delegate to, building a multi-stage agent pipeline, reusing prior agent conclusions, or consulting shadow pre-run output.
---

# External Agent Orchestration

Use this skill when you need to **delegate work to an external agent CLI**(`codex` / `gemini` / `claude-code`) and want it done the idiomatic way for this project — reusing pre-run output, picking the best-fit adapter automatically, chaining multiple agents, and letting future calls inherit this session's conclusions.

The project exposes four cooperating subsystems. This skill is the playbook that ties them together.

## Subsystem Map

| Module | Entry | Purpose | Env Flag |
|--------|-------|---------|----------|
| Capability Router | `services/agentRouter/capabilityRouter.js` | Rule-based scorer picking codex/gemini/claude-code from task text | `CLAUDE_CODE_AGENT_ROUTER=1` (+ `_DEFAULT`, `_RULES_JSON`) |
| Pipeline Runner | `services/externalAgentPipeline/index.js` | Sequential multi-stage runner; per-stage agent (or `auto`); auto prefix injection | (none — always available) |
| Shadow Runner | `services/agentScheduler/codexShadowRunner.js` | Idle-time pre-run of the predicted next AgentTool call | `CLAUDE_CODE_SHADOW_AGENT=codex\|gemini\|claude-code\|auto` |
| Context Fingerprint | `services/externalAgentMemory/index.js` | Coarse-key LRU+TTL store of last summary per (agent, cwd, taskPrefix) | (none — always available) |

Shadow runner writes back to Context Fingerprint on success, so the four layers form a single value chain:

```
idle subscription → predictNextAgentCalls → shadow pre-run
                                              ↓
                                    shadowStore (exact replay)
                                    contextFingerprint (coarse topic)
                                              ↓
                              pipeline next stage / next AgentTool call
                              inherits prior conclusion via buildContextPrefix
```

## Decision Tree — Which Layer To Use?

1. **Single ad-hoc delegation** → `DelegateToExternalAgentTool` directly (existing tool). If unsure which adapter → first call `routeExternalAgent(...)`.
2. **Multi-step workflow** (investigate → plan → apply) → build a `PipelineSpec` and call `runPipeline(spec)`.
3. **Recurring same-topic work** → consult `buildContextPrefix(...)` before building any prompt. Any prior shadow/pipeline success for the same `(sourceAgent, cwd, task prefix)` is reused as a prefix.
4. **Curious whether a prediction already ran** → call `getShadowResult(agentType, prompt, cwd)`; non-null means Codex already produced a reference preview.
5. **Diagnose** why routing / caching / pipelines are behaving a certain way → `/kernel-status` (sections: Capability Router, Shadow Agent Runner, Context Fingerprints, External Agent Pipeline).

Never call the adapters directly — always go through these APIs so the caches, quotas, and routing all stay consistent.

## Template 1 — Route-Then-Delegate

Use when you have one task and want the best-fit adapter rather than hard-coding `codex`.

```typescript
const { routeExternalAgent, isAgentRouterEnabled } = await import(
  'src/services/agentRouter/capabilityRouter.js'
)
if (!isAgentRouterEnabled()) {
  // router disabled → fall back to explicit choice
  return delegateDirectly('codex', task)
}
const decision = await routeExternalAgent({ taskText: task })
if (!decision.chosen) {
  // all candidates unavailable
  return delegateDirectly('codex', task)
}
// hand `decision.chosen` to DelegateToExternalAgentTool as agent_type
```

Key points:
- `decision.candidates[]` includes scores + `available` — useful for logging fallback reasoning.
- Router history (ring buffer of 20) is visible in `/kernel-status`.

## Template 2 — Pipeline Spec

Use when the task splits naturally into stages that could benefit from different agents.

```typescript
import { runPipeline } from 'src/services/externalAgentPipeline/index.js'

const run = await runPipeline({
  name: 'refactor-auth-middleware',
  cwd: process.cwd(),
  stages: [
    {
      name: 'investigate',
      agent: 'claude-code',       // cross-file reasoning
      task: 'Identify every call site that constructs AuthMiddleware. Return a list with file:line.',
    },
    {
      name: 'plan',
      agent: 'auto',              // router-decided (architecture-reasoning rule → claude-code)
      task: (ctx) =>
        `Given the call sites below, draft a migration plan that preserves the legacy /login path for one release.\n\n${ctx.previous}`,
    },
    {
      name: 'apply',
      agent: 'codex',             // bulk mechanical edit
      task: (ctx) =>
        `Apply the migration plan below. Keep /login untouched.\n\n${ctx.previous}`,
      timeoutMs: 180_000,
    },
  ],
})
```

Key points:
- Previous stage `result` is auto-piped into `ctx.previous`; you don't concatenate manually.
- `buildContextPrefix` is auto-injected when prior fingerprint exists for the same `(agent, cwd, stage task)` — set `injectContextPrefix: false` on the spec to disable.
- Failed stage aborts remaining stages (`status: 'skipped'`). Set `continueOnError: true` on a stage to let the pipeline keep going.
- Successful stage writes its `result` back to `contextFingerprint` automatically.
- See `examples/pipeline-spec.md` for a fuller walkthrough.

## Template 3 — Consult Before Delegating

Before you build any prompt for an external agent, ask the fingerprint store whether a prior run already covered this topic.

```typescript
import { buildContextPrefix } from 'src/services/externalAgentMemory/index.js'

const prefix = buildContextPrefix('codex', process.cwd(), userTask)
const finalTask = prefix ? `${prefix}\n\n${userTask}` : userTask
// hand `finalTask` to DelegateToExternalAgentTool
```

If `prefix` is non-null, the caller inherits up to 1200 chars of the last summary (TTL 60 min, max 20 entries). Fingerprint sample count and age are visible in `/kernel-status`.

## Template 4 — Opportunistic Shadow Reuse

Shadow runner writes plain-text previews keyed by `(agentType, prompt, cwd)`. If you're about to invoke AgentTool and want to check for a pre-baked reference:

```typescript
import { getShadowResult } from 'src/services/agentScheduler/index.js'

const shadow = getShadowResult(subagentType, prompt, process.cwd())
if (shadow?.status === 'success') {
  // shadow.output is a reference answer from an idle-time Codex run
  // — show it to the model as a hint, don't treat it as authoritative
}
```

The shadow store is independent from AgentTool's main cache; reading never changes AgentTool hit rates.

## Environment Flags Summary

| Flag | Effect |
|------|--------|
| `CLAUDE_CODE_AGENT_ROUTER=1` | Enable capability router (required for `auto`) |
| `CLAUDE_CODE_AGENT_ROUTER_DEFAULT=<name>` | Agent to use when no rule matches (default `claude-code`) |
| `CLAUDE_CODE_AGENT_ROUTER_RULES_JSON=<json>` | Override default rules array |
| `CLAUDE_CODE_SHADOW_AGENT=codex\|gemini\|claude-code\|auto` | Enable shadow pre-run; `auto` requires router |

Everything is opt-in. With every flag unset the modules are inert (no CLI spawned, no background work).

## Observation — `/kernel-status` Sections

After routing or running a pipeline, check:

- **Capability Router** — rulesCount, last 5 decisions with chosen / reasoning / candidate scores.
- **Shadow Agent Runner** — ticks, executed, completed success/failed/timeout, `fp-writeback` count, recent entries.
- **Context Fingerprints** — per-entry sourceAgent, sampleCount, age, task + summary preview.
- **External Agent Pipeline** — last 5 runs with per-stage status, resolved adapter, tokens, fingerprint-persisted flag.

Each section is wrapped in try/catch so a missing module never hides the others.

## Do / Don't

**Do**
- Route before delegating when the task topic isn't obviously codex/gemini/claude-code.
- Use pipeline for ≥2 clearly separable stages; don't re-implement sequential orchestration.
- Write a stage `fingerprintTaskText` when the raw `task` is a long closure — the fingerprint should key on the topic, not the prompt text.
- Use short, topic-clear `stage.name` — it shows up in `/kernel-status` history.

**Don't**
- Bypass the router to write hard-coded `agent_type: 'codex'` in new code without a comment explaining why the rules don't apply.
- Mutate shadowStore from new runners — only `codexShadowRunner` writes there. Build a sibling store if you need new semantics.
- Write the fingerprint during failure paths — by design only stage success persists, so a stale success isn't overwritten by a fresh failure.
- Assume fingerprint presence — `buildContextPrefix` returns `null` on miss, always guard the caller.

## See Also

- `/codex` skill — low-level single-task delegation to Codex.
- `subsystem-wiring` skill — 10 base subsystems (scheduler, compact, MCP, harness…) that these external-agent modules sit on top of.
- `/kernel-status` — live diagnostics for all four layers.
