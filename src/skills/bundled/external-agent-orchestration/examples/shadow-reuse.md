# Shadow & Fingerprint Reuse — Recipe

How to consult pre-run output and prior conclusions **before** paying for another external-agent run.

## The two stores

| Store | Key granularity | Written by | Read via |
|-------|----------------|------------|----------|
| shadowStore | `computePromptSignature(agentType, prompt, cwd)` — precise | `codexShadowRunner` on successful pre-run | `getShadowResult(agentType, prompt, cwd)` |
| contextFingerprint | `sourceAgent` + `cwd` + normalized taskPrefix — coarse | Shadow success (auto cross-write) + pipeline stage success | `getContextFingerprint(sourceAgent, cwd, taskText)` or `buildContextPrefix(...)` |

Both are pure in-memory, LRU+TTL, per-process — no persistence.

## Recipe A — Exact replay check

When you're about to invoke `AgentTool` and the subagent + prompt are well-known:

```typescript
import { getShadowResult } from 'src/services/agentScheduler/index.js'

const hit = getShadowResult(subagentType, prompt, process.cwd())
if (hit?.status === 'success' && hit.output) {
  // Use as hint prefix:
  return `Prior reference answer (shadow, ${Math.round((Date.now() - hit.finishedAt) / 1000)}s old):\n${hit.output}\n\nProceed with the task.`
}
```

Design rule: never *skip* the real AgentTool call based on a shadow hit — treat the shadow as a reference draft, not a cache replacement.

## Recipe B — Topic-level prefix

When the prompt wording may vary slightly but the topic is recurring:

```typescript
import { buildContextPrefix } from 'src/services/externalAgentMemory/index.js'

const prefix = buildContextPrefix('codex', process.cwd(), userTask)
if (prefix) {
  // prefix is already formatted as a standalone block with a disclaimer.
  // Prepend it; don't edit its structure or the external agent may mistake
  // it for the task itself.
  task = `${prefix}\n\n${userTask}`
}
```

The prefix includes how long ago the prior summary was produced and how many times this topic has been seen — the model can decide how much weight to give it.

## Recipe C — Manual write-back

If you invoked an external agent via a non-pipeline path and want future runs to inherit the summary:

```typescript
import { putContextFingerprint } from 'src/services/externalAgentMemory/index.js'

if (delegate.status === 'completed' && delegate.result) {
  putContextFingerprint('codex', process.cwd(), userTask, {
    summary: summarizeForReuse(delegate.result),
    tokens: delegate.tokens,
  })
}
```

Two guidelines:
- **Summarize, don't dump** — the fingerprint summary caps at 1200 chars; long dumps get truncated.
- **Only persist success** — fingerprint should represent a state worth inheriting.

## Recipe D — Probing whether shadow is live

If the user is interactive and you want to tell them whether shadow pre-run is active:

```typescript
import {
  isShadowRunnerEnabled,
  getShadowRunnerState,
  resolveShadowAgentName,
} from 'src/services/agentScheduler/index.js'

if (!isShadowRunnerEnabled()) {
  // inform user that CLAUDE_CODE_SHADOW_AGENT is unset
}
const s = getShadowRunnerState()
// s.fingerprintWriteBacks is the three-chain cross-write counter
```

Or just point the user at `/kernel-status` → "Shadow Agent Runner" section, which shows all of this plus the ticks that have been dropped (no slot / already shadowed / unavailable CLI).

## Anti-patterns

- **Reading shadow output into AgentTool's cache layer** — shadow deliberately lives in a separate store to avoid format-mismatch regressions. Use it as prompt hint only.
- **Using fingerprint prefix to override a fresh user instruction** — the prefix includes a "historical reference; ignore if mismatched" disclaimer for a reason.
- **Writing fingerprint from failed or timeout runs** — corrupts future reuse. The pipeline runner already enforces this; respect the same rule in any custom integration.
