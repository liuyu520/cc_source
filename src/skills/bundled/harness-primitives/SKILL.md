---
description: Reusable decide/schedule/fallback/evidence primitives (EvidenceLedger, CircuitBreaker, BudgetGuard) for building new harness subsystems. Use when adding a new decision engine, health tracker, cost monitor, or audit log that needs shadow→enforce→fallback rollout.
---

# Harness Primitives

Use this skill when you are building a **new subsystem** that needs any of:
- Decision logging that survives across sessions (audit trail / shadow-mode observability)
- Per-resource health tracking with automatic failure-rate-based degradation
- Token / RPM / budget control with automatic rejection on overrun
- A feature-flag three-stage rollout (off → shadow → enforce → fallback)

Instead of re-inventing these, import from `services/harness/` and follow the pattern below.

## The Four Elements of a Harness Subsystem

Every harness-style subsystem has the same four concerns. Name them explicitly:

```
decide    — what to do (router, planner, classifier)
schedule  — when to do it (budget, priority, dedupe)
fallback  — what to do on failure (legacy path, empty default, circuit-breaker open)
evidence  — what to record (ndjson append-only, per-domain ledger)
```

**If your new subsystem is missing one of these four, you are rebuilding a primitive from scratch** — stop and reuse the existing one.

## Primitive 1: EvidenceLedger

Persistent append-only event log per-domain. Use for decision audit, health history, usage tracking, and any shadow-mode observability that needs to outlive the process.

### Import

```typescript
import { EvidenceLedger, type EvidenceDomain } from '../harness/index.js'
```

### Append

```typescript
EvidenceLedger.append({
  ts: new Date().toISOString(),
  domain: 'router',              // one of: dream | skill | trust | router | pev | pool | context
  kind: 'route_decision',        // domain-specific event kind
  sessionId: getSessionId(),
  data: { provider, reason, shadow },
  ttlDays: 30,                   // optional, defaults to 30
})
```

### Query

```typescript
const entries = EvidenceLedger.query('router', {
  since: '2026-04-01T00:00:00Z',
  kind: 'route_decision',
  limit: 100,
})
```

### GC & Snapshot

```typescript
const deleted = EvidenceLedger.gc('router')           // purge expired entries
const snap = EvidenceLedger.snapshot('router')        // { totalEntries, oldestTs, newestTs }
```

### Rules

1. **Zero-cost when disabled**: `append()` is a no-op only when `CLAUDE_CODE_HARNESS_PRIMITIVES=0/false`. Default is enabled, so you can safely sprinkle it at every decision point.
2. **One file per domain**: `~/.claude/evidence/{domain}.ndjson` — isolation by design, no cross-domain interference.
3. **Never throw**: write failures are silently swallowed. Evidence must never break the main loop.
4. **Adding a new domain**: add to the `EvidenceDomain` union in `services/harness/evidenceLedgerTypes.ts`. Do not use `'other'` — opacity defeats the purpose.

## Primitive 2: CircuitBreaker (per-resource)

Three-state state machine (`closed → open → half`). Use when you have a failing dependency (provider, MCP server, remote API) that should be excluded from routing after N consecutive failures.

### Import

```typescript
import { CircuitBreaker } from '../harness/index.js'
```

### Per-resource instance

```typescript
// One breaker per tracked resource, kept in a Map
const breakers = new Map<string, CircuitBreaker>()
function getBreaker(name: string): CircuitBreaker {
  let b = breakers.get(name)
  if (!b) {
    b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 })
    breakers.set(name, b)
  }
  return b
}
```

### Use in decide()

```typescript
function decide(candidates: Resource[]): Resource | null {
  const healthy = candidates.filter((c) => getBreaker(c.name).allow())
  // If all breakers are open, fall back to the full list — don't return null
  const pool = healthy.length > 0 ? healthy : candidates
  return pickByPriority(pool)
}
```

### Record outcome

```typescript
try {
  const result = await callResource(chosen)
  getBreaker(chosen.name).recordSuccess()
} catch (e) {
  getBreaker(chosen.name).recordFailure()
  throw e
}
```

### Rules

1. **One breaker per resource**, never one global breaker — a failing dependency should not excommunicate healthy siblings.
2. **Fall back to full pool if all open** — returning `null` from `decide()` breaks the caller.
3. **Couple with EvidenceLedger**: every `recordFailure` should `append({ domain, kind: 'health_failure' })` for post-mortem visibility.

## Primitive 3: BudgetGuard (rolling window)

Token / call-count budget control over a rolling time window. Use when a side activity could burn quota if unbounded (e.g., LLM-powered recall, background summarization).

### Import

```typescript
import { BudgetGuard } from '../harness/index.js'
```

### Example

```typescript
const budget = new BudgetGuard({ windowMs: 60_000, maxTokens: 50_000 })

if (!budget.allow(estimatedTokens)) {
  // Over budget — use cheap fallback path
  return localFallback()
}
const result = await expensiveSideCall()
budget.record(actualTokensUsed)
```

### Rules

1. **P0/P1 priorities bypass budget** — user-blocking work must never be denied by a background budget.
2. **Record actual, not estimated** — `allow()` uses estimated tokens to gate entry, `record()` tracks reality.
3. **Reuse per category, not per call** — instantiate once at module scope.

## The "decide/schedule/fallback/evidence" Template

Every new harness subsystem follows this skeleton. Compare to `services/modelRouter/router.ts` as reference:

```typescript
// services/yourSubsystem/types.ts
export interface Decision { /* ... */ }

// services/yourSubsystem/featureCheck.ts
export function isEnabled(): boolean { /* env flag */ }
export function isEnforceMode(): boolean { /* env flag */ }
export function isFallbackEnabled(): boolean { /* env flag */ }

// services/yourSubsystem/healthTracker.ts
//  - one CircuitBreaker per resource
//  - recordSuccess/recordFailure
//  - getHealth(): ResourceHealth
//  - all events append to EvidenceLedger domain='yours'

// services/yourSubsystem/router.ts
class Subsystem {
  decide(ctx: Context): Decision | null {
    if (!isEnabled()) return null
    const candidates = load()
      .filter(matchesCapabilities)
      .filter((c) => healthTracker.getBreaker(c.name).allow())
    candidates.sort(byPriority)
    const chosen = candidates[0]
    const decision = { resource: chosen, shadow: !isEnforceMode(), fallbackChain: candidates.slice(1) }
    EvidenceLedger.append({ domain: 'yours', kind: 'decision', data: {...} })
    logForDebugging(`[YourSubsystem] ${decision.shadow ? 'shadow' : 'enforce'} ...`)
    return decision
  }
  recordOutcome(decision: Decision, outcome: Outcome): void {
    if (outcome.success) healthTracker.recordSuccess(decision.resource.name, outcome.latencyMs)
    else healthTracker.recordFailure(decision.resource.name, outcome.error)
  }
}
```

### At call site

```typescript
if (!_bypassRegistry) {
  try {
    const { isEnabled } = await import('../yourSubsystem/featureCheck.js')
    if (isEnabled()) {
      const { yourRouter } = await import('../yourSubsystem/index.js')
      yourRouter.decide(ctx)
      // shadow mode: decision logged, legacy path continues
    }
  } catch (e) {
    logForDebugging(`[YourSubsystem] shadow hook failed: ${(e as Error).message}`)
  }
}
// ... existing path unchanged ...
```

## Where the Primitives Are Used Today

| Subsystem | EvidenceLedger domain | CircuitBreaker | BudgetGuard |
|-----------|----------------------|----------------|-------------|
| Model Router (Phase 1) | `router` | ✓ per provider | — (cost tracker instead) |
| Tiered Context (Phase 2) | `context` | — | — |
| Action Registry (Phase 3) | `pev` (for macro execution) | — | — |
| SideQueryScheduler (pre-existing) | — | ✓ per category | ✓ global |
| MCP LazyLoad (pre-existing) | — | ✓ per server | — |
| PEV Harness (pre-existing) | `pev` | — | — |
| Dream Pipeline (pre-existing) | `dream` | — | — |

When you add a new subsystem, pick the column(s) you need and reuse. **Do not instantiate parallel implementations** of any of these three.

## Rules

1. **Zero regression default**: `featureCheck()` returns `false` unless env var is explicitly `1`. Nothing should change when flags are OFF.
2. **Three feature flags, not one**:
   - `CLAUDE_CODE_<NAME>=1` — shadow mode (log decisions, do not enforce)
   - `CLAUDE_CODE_<NAME>_ENFORCE=1` — actually use the decision
   - `CLAUDE_CODE_<NAME>_FALLBACK=1` — auto-retry fallback chain on failure
3. **Evidence before enforcement**: ship shadow mode first, observe ledger for a bake period, then flip enforce.
4. **Dynamic import across subsystems**: `await import()` — keeps disabled paths at zero cost and avoids circular deps.
5. **Never couple primitives to specific domains**: CircuitBreaker knows nothing about "providers"; EvidenceLedger knows nothing about "routing". If you find yourself putting domain logic into the primitives, stop — build on top instead.

## Checklist

Before shipping a new harness subsystem:

- [ ] `services/<name>/` directory with `index.ts` + `types.ts` + `featureCheck.ts`
- [ ] Three env flags (OFF / SHADOW / ENFORCE / FALLBACK)
- [ ] `decide()` returns `null` when flag off — callers treat as no-op
- [ ] EvidenceLedger domain added if new; events `appended` at every decision + outcome
- [ ] CircuitBreaker instance per-resource if dependency is fallible
- [ ] BudgetGuard if the subsystem runs unbounded LLM/expensive calls
- [ ] Call site integrated via `await import()`, inside try/catch
- [ ] `logForDebugging` at decision point with shadow/enforce suffix
- [ ] Unit-testable: `decide()` is pure given loaded config + injected health state

## Anti-Patterns

1. **New global cache**: If you are writing `const cache = new Map(...)` — stop. Ledger or skill-search token cache already solves it.
2. **Ad-hoc log file**: If you are writing `fs.appendFileSync('~/.claude/my-log.txt')` — use EvidenceLedger with a new domain.
3. **Single global breaker**: One healthy resource must not be excluded because a sibling failed.
4. **Evidence inside the hot path**: Never `query()` or `gc()` in the request hot path — those are disk reads. Only `append()` is cheap.

See also:
- `shadow-cutover/SKILL.md` — the rollout discipline this builds on
- `subsystem-wiring/SKILL.md` — how to integrate at call sites
- `services/modelRouter/router.ts` — reference implementation of the template
