---
name: "token-efficiency-methodology-reuse"
description: "Reuse the five token efficiency principles (information density, invariant deduplication, lazy loading, progressive detail, output economy), four anti-patterns (parrot, arsenal, library, journal), evaluation framework, and the env-var-gated provider-aware optimization pattern when designing new token-saving features or auditing token consumption for third-party APIs."
---

# Token Efficiency Methodology Reuse

Use this skill when designing new token-saving features for third-party API usage, auditing token consumption in the message pipeline, adding new env-var-gated optimizations, or extending the existing token efficiency infrastructure. The full methodology document is at `docs/token-efficiency-methodology.md`.

## Core Insight

```
Stateless API protocol  ←→  Stateful conversation requirement

Anthropic's prompt caching makes repeated tokens cheap (1/10 price).
Third-party APIs typically have NO prompt caching.
→ Every repeated token is full price. Every unused token is waste.
```

This means optimizations that are unnecessary for first-party API become critical for third-party.

## Five Principles

```
1. Information Density Maximization
   Every token should carry information relevant to the current task.
   → Tool description trimming (api.ts:180), system prompt compaction (prompts.ts:468)

2. Invariant Deduplication
   Same information should not be transmitted repeatedly across turns.
   → gitStatus differential (context.ts:184), prompt caching (first-party)

3. Lazy Loading
   Inject information only when needed, not preemptively.
   → Skills listing lazy gate (attachments.ts:2756), dynamic tool set (toolRouter.ts)

4. Progressive Detail
   Start with summary, expand on demand.
   → snipCompact three-tier compression (snipCompact.ts), tool result truncation

5. Output Economy
   Minimize verbose model output (5x more expensive than input).
   → Concise system prompt instructions, compact tool call parameters
```

## Four Anti-Patterns

| Anti-pattern | Description | Project solution |
|-------------|-------------|-----------------|
| Parrot | Repeat unchanged system instructions every turn | gitStatus diff injection, CLAUDE.md size limit |
| Arsenal | Send all tool schemas when only a few are needed | Dynamic tool routing (Tier1+LRU+intent) |
| Library | Stuff entire knowledge base into context | Skills lazy injection, CLAUDE.md truncation |
| Journal | Preserve full conversation history forever | snipCompact layered compression, autoCompact |

## The Provider-Aware Optimization Pattern

Every token optimization in this project follows the same structural pattern:

```typescript
// 1. Env var gating (highest priority — user override)
const envFlag = readEnvFlag('CLAUDE_CODE_MY_FEATURE')
if (envFlag === 'off') return original  // force OFF
if (envFlag === 'on') return optimized  // force ON

// 2. Provider detection (default behavior)
const isThirdParty = getAPIProvider() === 'thirdParty'
if (!isThirdParty) return original  // first-party: prompt cache handles it

// 3. Apply optimization
return optimized
```

This three-step pattern appears in:
- `snipCompact.ts:76` — `isLayeredEnabled()`
- `context.ts:200` — gitStatus differential gating
- `attachments.ts:2756` — skills listing lazy gate
- `toolRouter.ts:121` — `isDynamicToolsEnabled()`
- `api.ts:180` — tool description trimming

## Implemented Optimizations Audit

| # | Optimization | Location | Gate | Per-turn savings |
|---|-------------|----------|------|-----------------|
| 1 | Compact threshold override | autoCompact.ts | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 5K-15K (mid-late) |
| 2 | CLAUDE.md size limit | claudemd.ts | `CLAUDE_MD_MAX_CHARS` | 1K-5K |
| 3 | Skills listing lazy injection | attachments.ts:2756 | `CLAUDE_CODE_ENABLE_SKILLS` | ~4K |
| 4 | Tool schema description trim | api.ts:180 | auto (thirdParty) | 1.2K-1.8K |
| 5 | gitStatus differential | context.ts:184 | `CLAUDE_CODE_GIT_STATUS_DIFF` | 100-400 |
| 6 | Layered history compression | snipCompact.ts:230 | `CLAUDE_CODE_SNIP_LAYERED` | 5K-15K |
| 7 | Tool result budget truncation | toolResultStorage.ts | auto | 5K-50K (per tool call) |
| 8 | Memory prompt truncation | prompts.ts | auto | 0-6K |
| 9 | Dynamic tool set | toolRouter.ts | `CLAUDE_CODE_DYNAMIC_TOOLS` | ~1.7K |
| 10 | System prompt compaction | prompts.ts:468 | `CLAUDE_CODE_FULL_SYSTEM_PROMPT` | ~2.8K |
| 11 | Third-party core tool subset | tools.ts:295 | `CLAUDE_CODE_FULL_TOOLS` | 3K-5K |
| 12 | Post-compact budget downgrade | compact.ts:138 | auto (thirdParty) | variable |
| 13 | Third-party microcompact | microCompact.ts:328 | auto | variable |
| 14 | Tool description per-provider | api.ts:180 | auto | 40-60% of schema |
| 15 | prependUserContext trim | api.ts:468 | auto | 200-500 |

## Env Var Quick Reference

```bash
# Phase 0: Zero code change
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50   # Compact at 50% context (default ~83%)

# Phase 1: Content limits
CLAUDE_MD_MAX_CHARS=12000            # CLAUDE.md total char limit (default: no limit)
CLAUDE_CODE_GIT_STATUS_DIFF=0|1     # gitStatus diff (default: auto per provider)

# Phase 2: Lazy loading
CLAUDE_CODE_ENABLE_SKILLS=1          # Force eager skills injection (default: lazy for 3P)
CLAUDE_CODE_SNIP_LAYERED=0|1         # Layered compression (default: auto per provider)

# Phase 3: Dynamic filtering
CLAUDE_CODE_DYNAMIC_TOOLS=1          # Dynamic tool set (default: off, opt-in)

# Overrides
CLAUDE_CODE_FULL_SYSTEM_PROMPT=1     # Force full system prompt (bypass trimming)
CLAUDE_CODE_FULL_TOOLS=1             # Force full tool set (bypass all filtering)
CLAUDE_CODE_SIMPLE=1                 # Minimal mode: Bash + Read + Edit only
```

## Common Tasks

### Designing a new token optimization

1. Identify the wasteful content: what is being sent that doesn't need to be?
2. Classify the waste by principle: is it repeated (invariant)? unused (lazy)? too detailed (progressive)? never needed (density)?
3. Choose the right pattern:
   - **Repeated but always needed** → First-full-then-short (gitStatus pattern)
   - **Sometimes never needed** → Lazy trigger gate (skills pattern)
   - **Too detailed for older content** → Age-based compression (snipCompact pattern)
   - **Too many options sent** → Demand-driven filtering (toolRouter pattern)
   - **Too large individual items** → Budget truncation (toolResultStorage pattern)
4. Implement with the provider-aware pattern: env var gate → provider check → optimization
5. Default to OFF for first-party (prompt cache), ON for third-party (no cache)
6. Add env var override for escape hatch
7. Update `docs/token-efficiency-methodology.md` audit table

### Auditing token consumption for a new feature

1. Estimate the token cost of the new content:
   - System prompt additions: count chars / 4
   - Tool schema additions: serialize the JSON Schema, count chars / 4
   - Per-turn content: multiply single-turn cost by expected conversation length
2. Check against the token efficiency evaluation:
   - Efficiency = useful tokens / total tokens
   - Target: >70% for healthy, <30% = severe waste
3. If the new feature adds >500 tokens/turn for third-party, implement one of the optimization patterns

### Measuring actual token savings

1. `CLAUDE_CODE_DEBUG=1` — all optimization modules log their actions
2. Look for log prefixes: `[snipCompact]`, `[toolRouter]`, `[skills]`, `[CapabilityFilter]`
3. Compare API usage with and without the optimization (toggle via env vars)

## Token Consumption Heat Map (20-turn conversation)

```
Component           │ Per-turn │ 20 turns  │ Optimizable?
────────────────────┼──────────┼───────────┼─────────────
Conversation history│ variable │ 40-70%    │ snipCompact + autoCompact
Tool schemas        │ 2-3K     │ 10-20%    │ dynamic toolset + trim
System prompt       │ ~150     │ <1%       │ already compacted
CLAUDE.md           │ 0.5-5K   │ 3-15%    │ size limit
Memory (MEMORY.md)  │ 0-6.25K  │ 0-18%    │ truncation
Skills listing      │ 0-4K     │ 0-12%    │ lazy injection
gitStatus           │ 0.1-0.5K │ <2%      │ differential
envInfo             │ ~0.1K    │ <1%      │ already minimal
```

## Related Skills

- `lazy-context-injection-reuse` — Detailed pattern for deferred/differential injection (schemes 3, 5)
- `layered-history-compression-reuse` — Detailed pattern for snipCompact three-tier compression (scheme 6)
- `dynamic-tool-routing-reuse` — Detailed pattern for Tier1+LRU+intent tool filtering (scheme 9)
- `compact-lifecycle-reuse` — Full compact lifecycle hooks and strategies
- `api-request-pipeline-reuse` — API pipeline and CapabilityFilter (where tool schemas are ultimately sent)

## Integration Points

| Pipeline stage | File | Purpose |
|---------------|------|---------|
| System prompt | `prompts.ts:468` | Third-party compact prompt |
| Tool schemas | `api.ts:180` | Per-provider description trim |
| Tool filtering | `tools.ts:295` | CORE_TOOL_NAMES subset |
| Dynamic tools | `toolRouter.ts` | Tier1+LRU+intent |
| Skills gate | `attachments.ts:2756` | Lazy injection |
| gitStatus diff | `context.ts:184` | First-full-then-short |
| History compression | `snipCompact.ts:230` | Three-tier age-based |
| Microcompact | `microCompact.ts:328` | Time-based tool_result cleanup |
| Auto compact | `autoCompact.ts:62` | Heavy LLM summarization |
| Tool result budget | `toolResultStorage.ts:924` | Per-result size cap |
| CLAUDE.md limit | `claudemd.ts:1198` | Total char cap |
| Message pipeline | `query.ts:488` | snip → micro → auto ordering |

## Rules

- Every new optimization MUST have an env var override to disable it. Users need escape hatches.
- Default behavior: first-party API = skip optimization (prompt cache is sufficient); third-party API = apply optimization.
- Never combine multiple optimizations in a single function — keep them composable and independently toggleable.
- The message pipeline order matters: snipCompact (cheap, granular) → microCompact (cheap, time-based) → autoCompact (expensive, LLM call). Don't insert new compression between micro and auto.
- Token estimation: use chars/4 as rough approximation. Don't import heavy tokenizer libraries for estimation — the savings from fewer tokens outweigh estimation accuracy.
- Update `docs/token-efficiency-methodology.md` audit table whenever adding a new optimization. This is the single source of truth for what's implemented.

## Anti-Patterns

- Optimizing for first-party API — prompt caching already handles invariant deduplication. Focus on third-party.
- Building a "smart" system that predicts what the model needs — demand-driven (reactive) beats predictive (proactive). The model will tell you when it needs something (by trying to use it).
- Combining multiple optimizations into one toggle — each optimization should be independently measurable and disableable.
- Over-compressing recent context to save tokens — the model needs recent context for coherent responses. Only compress older content.
- Ignoring output token costs — output tokens are 5x more expensive than input. A terse system prompt instruction saves more money than trimming tool descriptions.
- Adding optimization without measuring — always estimate per-turn token savings before implementing. If the savings is <100 tokens/turn, it's not worth the code complexity.
