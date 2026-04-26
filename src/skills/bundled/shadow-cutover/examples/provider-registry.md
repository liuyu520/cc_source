# Shadow-Cutover: Provider Registry Example

## Context

`ProviderRegistry` abstracts 5 provider branches (Bedrock/Vertex/Foundry/thirdParty/firstParty) behind a unified `LLMProvider` interface. The shadow-cutover pattern lets the registry dispatch API calls while keeping the original `getAnthropicClient` as instant rollback.

## Phase 1: Shadow Dispatch in client.ts

```typescript
// src/services/api/client.ts — top of getAnthropicClient()
if (!_bypassRegistry) {
  try {
    const { isProviderRegistryEnabled } = await import('../providers/featureCheck.js')
    if (isProviderRegistryEnabled()) {
      const { getProvider } = await import('../providers/index.js')
      const provider = getProvider()
      logForDebugging(`[ProviderRegistry] dispatch id=${provider.id}`)
      return provider.createClient({ apiKey, maxRetries, model, fetchOverride, source })
    }
  } catch (e) {
    logForDebugging(`[ProviderRegistry] dispatch failed, falling back`)
  }
}
// ... original 330-line body continues unchanged
```

## Key Pattern: `_bypassRegistry` Anti-Recursion

Each provider's `createClient()` delegates back to `getAnthropicClient()` (reusing the existing SDK construction logic). Without a guard, this creates infinite recursion:

```
getAnthropicClient → registry.getProvider().createClient()
  → getAnthropicClient → registry.getProvider().createClient() → ...
```

Fix: providers pass `{ _bypassRegistry: true }` when calling back:

```typescript
// src/services/providers/impls/thirdParty.ts
async createClient(opts: CreateClientOpts) {
  const { getAnthropicClient } = await import('../../api/client.js')
  return getAnthropicClient({ ...opts, _bypassRegistry: true })
}
```

## Phase 2: translateError in withRetry.ts

```typescript
// Second trigger — provider-aware error classification
let shouldTriggerBackupSwitch = error instanceof APIError && error.status === 429
try {
  const { isProviderRegistryEnabled } = await import('../providers/featureCheck.js')
  if (isProviderRegistryEnabled() && !shouldTriggerBackupSwitch) {
    const { getProvider } = await import('../providers/index.js')
    const std = getProvider().translateError(error)
    if (std.code === 'quota_exceeded' || std.code === 'rate_limit') {
      shouldTriggerBackupSwitch = true
    }
  }
} catch { /* translateError fail doesn't affect original path */ }
```

## Reuse Principle

Providers don't duplicate SDK construction — they delegate back to the 330-line `getAnthropicClient` body via `_bypassRegistry`. The registry only owns **detection** (`detect()`) and **error translation** (`translateError()`), not client creation.
