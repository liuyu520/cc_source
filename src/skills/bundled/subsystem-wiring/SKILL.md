---
description: How to wire existing function calls into the project's fourteen subsystems (SideQueryScheduler, ProviderRegistry, CompactOrchestrator, MCP LazyLoad, PEV Harness, Dream Pipeline, Intent Recall, Model Router, Tiered Context, Action Registry, Capability Router, Shadow Runner, Context Fingerprint, External Agent Pipeline). Use when integrating a new feature point into scheduling, provider dispatch, compact decision, MCP caching, blast-radius analysis, dream evidence, skill recall classification, multi-provider routing, context rehydration, unified action lookup, external-agent routing/reuse, or multi-stage agent orchestration.
---

# Subsystem Wiring

Use this skill when you need to integrate an existing function into one of the project's fourteen infrastructure subsystems. Each subsystem has a standard wiring template — follow it exactly to get scheduling, error handling, telemetry, and feature flags for free.

> **See also**: `scheduler-kernel` SKILL — documents the agentScheduler kernel's
> five factory+registry abstractions (RateBucket, AutoContinueStrategy, SnapshotStore,
> ColdStart Candidate, Shadow→Episode writeback). If you are extending one of those
> five, go there first; the patterns are more specific and the templates are
> reference-implementation-backed.

## Subsystem Map

| Subsystem | Purpose | Entry Module | Feature Flag |
|-----------|---------|-------------|-------------|
| SideQueryScheduler | Budget-aware async task scheduling | `services/sideQuery/index.js` | `CLAUDE_SIDE_QUERY_SCHEDULER` + per-category |
| ProviderRegistry | LLM provider detection & dispatch | `services/providers/index.js` | `CLAUDE_PROVIDER_REGISTRY` |
| CompactOrchestrator | Context compression decision engine | `services/compact/orchestrator/index.js` | `CLAUDE_COMPACT_ORCHESTRATOR` |
| MCP LazyLoad | MCP manifest cache & lazy connect | `services/mcp/lazyLoad/index.js` | `CLAUDE_MCP_LAZY_LOAD` |
| PEV Harness | Blast-radius analysis before execution | `services/harness/pev/index.js` | `CLAUDE_PEV_DRYRUN` |
| Dream Pipeline | Evidence-driven memory consolidation | `services/autoDream/pipeline/index.js` | `CLAUDE_DREAM_PIPELINE` |
| Intent Recall | Zero-cost intent classification for skill search | `services/skillSearch/intentRouter.js` | `CLAUDE_SKILL_INTENT_ROUTER` |
| Model Router | Multi-provider health / cost / fallback routing | `services/modelRouter/index.js` | `CLAUDE_CODE_MODEL_ROUTER` + `_ENFORCE` + `_FALLBACK` |
| Tiered Context | L4 rehydrate of compacted turns by byte-offset index | `services/compact/tieredContext/index.js` | `CLAUDE_CODE_TIERED_CONTEXT` + `_REHYDRATE` + `_AUTO` |
| Action Registry | Unified commands/tools/skills/macros lookup for recall | `services/actionRegistry/index.js` | `CLAUDE_CODE_UNIFIED_ACTIONS` + `_COMMAND_RECALL` + `_MACROS` |
| Capability Router | Rule-based external-agent (codex/gemini/claude-code) picker | `services/agentRouter/capabilityRouter.js` | `CLAUDE_CODE_AGENT_ROUTER` + `_DEFAULT` + `_RULES_JSON` |
| Shadow Runner | Idle-time pre-run of predicted next AgentTool call | `services/agentScheduler/codexShadowRunner.js` | `CLAUDE_CODE_SHADOW_AGENT` |
| Context Fingerprint | Cross-session coarse-key summary reuse for external agents | `services/externalAgentMemory/index.js` | (always available) |
| External Agent Pipeline | Multi-stage external-agent orchestration with auto prefix injection | `services/externalAgentPipeline/index.js` | (always available) |
| Causal Graph | Cross-subagent sqlite-backed fact/edge store for multi-agent blackboard | `services/causalGraph/index.js` | `CLAUDE_CAUSAL_GRAPH=off\|shadow\|on` |

**Base primitives** (used by most subsystems) live in `services/harness/index.js` — see `harness-primitives/SKILL.md` for `EvidenceLedger`, `CircuitBreaker`, `BudgetGuard`. New subsystems should import from there, not re-implement.

**External-agent playbook**: when wiring a new feature that delegates to codex/gemini/claude-code, read `external-agent-orchestration/SKILL.md` for templates tying the four external-agent subsystems together.

## Template 1: SideQuery Wiring

The most common wiring — wrap any async function to get priority scheduling, deduplication, budget control, and circuit breaking.

### Step-by-Step

1. Pick a `SideQueryCategory` from `services/sideQuery/types.ts`
2. Pick a `Priority` (`P0_blocking` → `P3_background`)
3. Wrap the existing function; provide a `fallback`

### Template

```typescript
// Before: direct call
const result = await existingFunction(args)

// After: scheduled call with fallback
const { submitSideQuery, isSideQueryCategoryEnabled } = await import(
  '../services/sideQuery/index.js'
)
if (!isSideQueryCategoryEnabled('your_category')) {
  // Feature off → legacy direct call
  return existingFunction(args)
}
const res = await submitSideQuery<ReturnType>({
  category: 'your_category',
  priority: 'P1_quality',        // pick appropriate priority
  source: 'side_question',
  dedupeKey: `your_category:${stableInputHash}`,
  run: async (signal) => existingFunction(args),
  fallback: () => safeDefault,    // never throw in fallback
})
if (res.status === 'ok' || res.status === 'fallback') return res.value
return safeDefault
```

### Priority Guide

| Priority | Use When | Timeout | Budget |
|----------|---------|---------|--------|
| `P0_blocking` | User is waiting for this result (e.g. `classifyYoloAction`) | 10s | Always allowed |
| `P1_quality` | Improves response quality (e.g. `memory_recall`) | 10s | Always allowed |
| `P2_method` | Method-selection hint (e.g. `skill_discovery`) | 10s | Budget-checked |
| `P3_background` | Fire-and-forget (e.g. `mcp_manifest_probe`, `extractMemories`) | 30s | Budget-checked |

### Concrete Examples

**memory_recall** (`src/utils/attachments.ts:2365`):
```typescript
const res = await submitSideQuery<Attachment[]>({
  category: 'memory_recall',
  priority: 'P1_quality',
  dedupeKey: `memory_recall:${input.slice(0, 200)}`,
  run: async () => getRelevantMemoryAttachments(input, ..., signal, paths),
  fallback: () => [],
})
```

**skill_discovery** (`src/services/skillSearch/prefetch.ts`):
```typescript
const res = await submitSideQuery<Attachment[]>({
  category: 'skill_discovery',
  priority: 'P2_method',
  dedupeKey: `skill_discovery:${signal.type}:${signal.query}`,
  run: async () => runDiscoveryDirect(signal, toolUseContext),
  fallback: () => runDiscoveryDirect(signal, toolUseContext),
})
```

**mcp_manifest_probe** (`src/services/mcp/useManageMCPConnections.ts`):
```typescript
const dayBucket = Math.floor(Date.now() / 86_400_000)
void submitSideQuery<number>({
  category: 'mcp_manifest_probe',
  priority: 'P3_background',
  dedupeKey: `mcp_manifest_probe:boot:${dayBucket}`,
  run: async () => lazyMcpGateway.probeStaleManifests(),
  fallback: () => 0,
})
```

### Adding a New Category

1. Add to `SideQueryCategory` union in `services/sideQuery/types.ts`
2. Env var auto-derives: `CLAUDE_SIDE_QUERY_<UPPER_SNAKE_CATEGORY>=1`
3. Use `isSideQueryCategoryEnabled('your_category')` at call site

## Template 2: CompactOrchestrator Wiring

Wire a new compact decision point using `decideAndLog`.

```typescript
const { decideAndLog } = await import('./services/compact/orchestrator/index.js')
const decision = decideAndLog('yourCallSite', {
  messageCount: messages.length,
  stats: { usedTokens, maxTokens, ratio: usedTokens / maxTokens },
  signal: { kind: 'post_tool', reason: 'description of trigger' },
  heavyToolResultCount: countHeavyToolResults(messages),
})
if (decision && !decision.shadow) {
  // Use decision.plan.runSnip / decision.plan.runMicro / decision.plan.strategy
} else {
  // Legacy behavior unchanged
}
```

### Rules

- Feed **real signals** — never zeros in cutover path
- Use `runSnip` + `runMicro` (independent booleans), not `strategy`, to gate snip/micro
- `strategy` only gates the heavy path (`full_compact` / `session_memory`) in `autoCompact.ts`

## Template 3: Provider Plugin Wiring

Add a new LLM provider:

1. Create `services/providers/impls/yourProvider.ts`:

```typescript
import type { LLMProvider } from '../types.js'

export const yourProvider: LLMProvider = {
  id: 'your_provider',
  detect(): boolean {
    return process.env.YOUR_PROVIDER_ENABLED === '1'
  },
  async createClient(opts) {
    const { getAnthropicClient } = await import('../../api/client.js')
    return getAnthropicClient({ ...opts, _bypassRegistry: true })
  },
  async probeCapabilities(model) {
    return capabilityCache.getOrProbe(this.id, 'your_provider', model, ...)
  },
  translateError(err) {
    return translateAnthropicSdkError(err, this.id)
  },
}
```

2. Register in `services/providers/bootstrap.ts` (detection priority order matters)
3. `_bypassRegistry: true` is mandatory to prevent infinite recursion

## Template 4: MCP LazyLoad Wiring

### Persist manifest on connection

```typescript
const { isMcpLazyLoadEnabled, lazyMcpGateway, toManifestItem } =
  await import('./lazyLoad/index.js')
if (!isMcpLazyLoadEnabled()) return
lazyMcpGateway.updateManifestIfChanged({
  serverName: client.name,
  transport: (client.config as any)?.type ?? 'stdio',
  probedAt: new Date().toISOString(),
  tools: tools.map(toManifestItem),      // type-safe converter
  commands: commands.map(toManifestItem),
  resources: resources.map(toManifestItem),
  consecutiveFailures: 0,
  totalCalls: 0,
})
```

### Register a refresher (React hook)

```typescript
lazyMcpGateway.registerStaleManifestRefresher(async staleNames => {
  const clients = store.getState().mcp.clients
  for (const name of staleNames) {
    const c = clients.find(x => x.name === name)
    if (!c || c.type !== 'connected') continue
    lazyMcpGateway.updateManifestIfChanged({
      serverName: c.name,
      tools: (c.tools ?? []).map(toManifestItem),
      // ...
    })
  }
})
// Cleanup on unmount:
return () => lazyMcpGateway.registerStaleManifestRefresher(null)
```

### Key Utilities

| Function | Module | Purpose |
|----------|--------|---------|
| `toManifestItem(x)` | `lazyLoad/gateway.js` | Type-safe Tool/Command/Resource → McpToolManifestItem |
| `updateManifestIfChanged(m)` | `lazyMcpGateway` | Shape-hash diff, skip write if unchanged |
| `putIfChanged(m)` | `manifestCache` | Low-level disk write with hash guard |
| `probeStaleManifests()` | `lazyMcpGateway` | Enumerate stale + invoke registered refresher |

## Cross-Cutting Rules

1. **Always use `await import()`** for cross-subsystem references — avoids circular deps
2. **Always provide `fallback`** — subsystem failure must never break the main loop
3. **Use `logForDebugging`** — all subsystem decisions must be observable via `--debug`
4. **`dedupeKey` must include a varying component** — avoid process-lifetime locks (use day bucket, input hash, etc.)
5. **Reuse `toManifestItem` / `createEmptyMicrocompactResult`** — single-point type converters prevent `as any` spread

## Template 5: PEV Harness Wiring

Add blast-radius analysis to any tool that executes side-effects.

### Step-by-Step

1. Implement a `preview*` function in `services/harness/pev/blastRadius.ts` (or reuse `analyzeBashBlastRadius`)
2. Call it inside a try/catch before the tool's main execution
3. Feed result to `recordPevPreview` for aggregation

### Template

```typescript
// Before tool execution:
try {
  const { previewBash, recordPevPreview } = await import(
    '../../services/harness/pev/index.js'
  )
  const radius = previewBash(command)
  if (radius) recordPevPreview(radius)
} catch {
  // Shadow layer failure never affects execution
}
// Existing tool execution continues unchanged
```

### Key Property

PEV is a **pure observer** — it never blocks, never throws, never alters the command. The shadow/cutover progression controls whether analysis is informational (log) or authoritative (blocks execution).

## Template 6: Dream Pipeline Wiring

Wire evidence capture or triage into session lifecycle hooks.

### Capture (session-end)

```typescript
import { captureAndMaybeTrigger } from '../services/autoDream/pipeline/index.js'

captureAndMaybeTrigger({
  sessionId,
  endedAt: new Date().toISOString(),
  durationMs,
  novelty,          // 0..1
  conflicts,        // count
  userCorrections,  // count
  surprise,         // count
  toolErrorRate,    // 0..1
  filesTouched,
  memoryTouched,
})
```

### Dispatch (dream entry)

```typescript
const { dispatchDream } = await import('./pipeline/index.js')
const decision = dispatchDream({ windowMs: cfg.minHours * 3600 * 1000 })
switch (decision.action) {
  case 'skip':  return               // triage says no
  case 'micro': /* ... */ break      // lightweight replay
  case 'full':  /* legacy */ break   // full consolidation
  case 'legacy': break               // flag off or shadow
}
```

### Rules

- `captureEvidence` is append-only, fire-and-forget — never throw
- Evidence signals must be rule-computed (regex/counting), never LLM
- Triage thresholds: `<5 skip`, `5-15 micro`, `≥15 full`

## Template 7: Intent Recall Wiring

Add intent classification to any retrieval entry point.

### Template

```typescript
if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
  try {
    const { classifyIntent, fusionWeightsFor } = await import('./intentRouter.js')
    const intent = classifyIntent(query)
    const weights = fusionWeightsFor(intent.class)
    // Use weights.wLexical / weights.wSemantic / weights.minScore
    // to modulate search scoring
  } catch { /* shadow — never blocks */ }
}
```

### Reuse Across Retrieval Points

The same `classifyIntent` works for any retrieval pipeline:

| Retrieval Point | Query Source | Effect |
|-----------------|-------------|--------|
| Skill prefetch | `signal.query` | Adjust RRF fusion weights |
| Memory recall | `userMessage` | Skip recall on `chitchat` |
| MCP tool filter | `toolUse.input` | Filter by `taskMode` |
| Agent dispatch | `userMessage` | Map `taskMode` → subagent_type |

### Rules

- Intent classification is pure CPU (<1ms) — never schedule via SideQuery
- Always use `await import()` + try/catch, never top-level import
- `classifyIntent` returns `null`-safe defaults for empty/undefined input

## Template 8: Model Router Wiring

Use when adding a new integration point that should respect multi-provider health / cost / fallback routing. Model Router sits **above** ProviderRegistry — ProviderRegistry dispatches to the detected provider type; Model Router picks among configured providers within that type based on runtime health.

### At an API-client call site (shadow hook)

```typescript
try {
  const { isModelRouterEnabled } = await import('../modelRouter/featureCheck.js')
  if (isModelRouterEnabled()) {
    const { modelRouter } = await import('../modelRouter/index.js')
    modelRouter.decide({
      requiredCapabilities: ['chat', 'tool_use'],
      preferredModel: model,
    })
    // Decision auto-appended to EvidenceLedger domain='router'.
    // Shadow mode: returns but never alters the outgoing request.
  }
} catch (e) {
  logForDebugging(`[ModelRouter] shadow hook failed: ${(e as Error).message}`)
}
```

### Record outcome after the call

```typescript
const start = Date.now()
try {
  const response = await client.messages.create(...)
  modelRouter.recordOutcome(decision, {
    success: true,
    latencyMs: Date.now() - start,
    tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
  })
} catch (err) {
  modelRouter.recordOutcome(decision, {
    success: false,
    latencyMs: Date.now() - start,
    error: err,
  })
  throw err
}
```

### Adding a new provider

Create `~/.claude/providers.json` (not yaml — intentionally avoids new deps):

```json
[
  { "name": "minimax", "endpoint": "https://api.minimaxi.com/anthropic",
    "model": "MiniMax-M2.7", "apiKeyEnv": "ANTHROPIC_API_KEY",
    "capabilities": ["chat", "tool_use"], "pricePerMToken": 0.20, "priority": 0 },
  { "name": "anthropic", "endpoint": "https://api.anthropic.com",
    "model": "claude-opus-4-6", "apiKeyEnv": "ANTHROPIC_API_KEY",
    "capabilities": ["chat", "tool_use", "vision", "cache", "extended_thinking"],
    "pricePerMToken": 15.00, "priority": 10 }
]
```

### Rules

- **ProviderRegistry dispatches first, ModelRouter picks within**: the two coexist. Router runs only if `isProviderRegistryEnabled()` dispatch already happened or was bypassed.
- **`decide()` returns `null` when flag off** — callers must handle null as "no decision, legacy path".
- **CircuitBreaker per-provider**, never global. See `healthTracker.ts` for reference.
- **Shadow first, enforce later**: ship `CLAUDE_CODE_MODEL_ROUTER=1` alone for a bake period, observe `~/.claude/evidence/router.ndjson`, then flip `_ENFORCE=1`.

## Template 9: Tiered Context Wiring

Use when a code path can benefit from **re-fetching a previously compacted turn** from disk — e.g., PEV verify needs the original command, RCA needs an earlier error trace, or the LLM references an old turnId that was compacted away.

### Index on compact (automatic if enabled)

Already wired in `services/compact/compact.ts` — when `CLAUDE_CODE_TIERED_CONTEXT=1`, every successful `compactConversation()` calls:

```typescript
contextTierManager.indexCompactedTurns(sessionId, transcriptPath, messages, scores)
```

No further wiring needed at compact sites.

### Rehydrate by turnId (precise)

```typescript
try {
  const { isRehydrateEnabled } = await import('./tieredContext/featureCheck.js')
  if (isRehydrateEnabled()) {
    const { rehydrateByTurnId } = await import('./tieredContext/rehydrateTool.js')
    const result = rehydrateByTurnId({ sessionId, transcriptPath, turnId })
    if (result) {
      // result.content is the original JSONL-encoded turn
      // result.source === 'l2_cache' | 'l4_disk'
      return result.content
    }
  }
} catch { /* silent fallback */ }
```

### Rehydrate by query (fuzzy)

```typescript
const { searchAndRehydrate } = await import('./tieredContext/rehydrateTool.js')
const result = searchAndRehydrate({
  sessionId, transcriptPath,
  query: 'authentication migration rollout',
})
// Returns top-1 candidate scored by (importanceScore * 0.5 + keywordHit * 0.5)
```

### Rules

- **Never bypass `isRehydrateEnabled()`** — the helpers already short-circuit when flag off.
- **L2 cache is per-process**: fine for one session, do not expect it to span restarts (L4 does).
- **Importance scores are computed via `scoreMessagesAgainstCurrentTask()`** from `orchestrator/importance.ts` — reuse, don't re-derive.
- **Evidence domain is `'context'`** — all rehydrate events land there for audit.

## Template 10: Action Registry Wiring

Use when you need to **look up a command/tool/skill/macro by name** from a single source of truth, or when you want slash commands to participate in skill recall.

### Sync existing registries into the unified table

At a natural seam (where commands/tools are already loaded — NOT in the hot path):

```typescript
try {
  const { isUnifiedActionsEnabled } = await import('../actionRegistry/featureCheck.js')
  if (isUnifiedActionsEnabled()) {
    const { actionRegistry } = await import('../actionRegistry/registry.js')
    actionRegistry.syncFromCommands(allCommands)  // Command[] → slash/skill ActionEntry
    actionRegistry.syncFromTools(allTools)        // Tool[] → tool ActionEntry
    // macros are loaded once at startup via loadMacros()
  }
} catch { /* flag off */ }
```

`syncFrom*` methods are **idempotent** and use shallow-equal diffing — safe to call repeatedly.

### Query recall-eligible entries

```typescript
const { actionRegistry } = await import('../actionRegistry/index.js')
const eligible = actionRegistry.getRecallEligible()
// Already filtered: skills always eligible; slash commands eligible only when
// CLAUDE_CODE_COMMAND_RECALL=1 and the command has whenToUse metadata
```

Used inside `skillSearch/localSearch.ts` — the search layer automatically merges registry entries into its index when the flag is on, no further wiring needed.

### Subscribe to changes (cache invalidation)

```typescript
const unsubscribe = actionRegistry.subscribe(() => {
  clearSkillIndexCache()     // or your equivalent cache
})
// Later: unsubscribe()
```

### Execute a macro

Macros live in `~/.claude/macros/*.json` (one file per macro):

```json
{
  "description": "Ship current branch: verify, commit, push, open PR",
  "steps": [
    { "action": "/verify", "args": "quick" },
    { "action": "/commit", "args": "${prev_output}" },
    { "action": "/pr", "args": "--draft" }
  ],
  "onFailure": "abort"
}
```

Execute via the decoupled `StepInvoker` pattern — the executor does not know how to run slash commands or tools, you supply the invoker:

```typescript
const { executeMacro } = await import('../actionRegistry/index.js')
const result = await executeMacro(macroDefinition, async (action, args) => {
  // Caller maps action name → Command/Tool invocation
  const entry = actionRegistry.get(action)
  if (!entry?.originalCommand) return { success: false, error: 'not found' }
  const output = await runCommand(entry.originalCommand, args)
  return { success: true, output }
})
```

### Rules

- **No ambient coupling** to `commands.ts` or `tools.ts` — Action Registry reads via the same public interfaces those modules already expose.
- **Macros cannot nest** — `composable: false` is enforced at registration time.
- **`${prev_output}` is the only variable** supported in args — keep macros declarative, not Turing-complete.
- **Evidence domain is `'pev'`** for macro execution (shared with PEV harness, since macros are batched side-effect plans).

## Cross-Cutting Rules
