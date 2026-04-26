---
name: "api-request-pipeline-reuse"
description: "Reuse existing API request pipeline (paramsFromContext → CapabilityFilter → withRetry → SDK call), beta header construction, retry/fallback logic, error type contract for protocol adapters, and the Codex adapter path when modifying API request flow, adding new request parameters, or changing retry behavior."
---

# API Request Pipeline Reuse

Use this skill when modifying the API request flow, adding new request parameters, changing retry/fallback behavior, intercepting or transforming API requests, building protocol adapters, or debugging API call failures.

## Pipeline Overview

```
paramsFromContext(retryContext)        ← claude.ts:1578, builds BetaMessageStreamParams
         ↓
CapabilityFilter                      ← capabilityFilter.ts, strips unsupported params
         ↓
withRetry(getClient, callback, opts)  ← withRetry.ts:175, retry + fallback + auth refresh
         ↓
anthropic.beta.messages.create()      ← SDK call (streaming or non-streaming)
         ↓                                 ↓ (if codex provider)
     Anthropic API                    CodexAnthropicAdapter
                                      ├── requestTranslator → OpenAI Responses API
                                      ├── HTTP/SSE transport
                                      ├── responseTranslator → Anthropic events
                                      └── APIError contract → withRetry compatible
```

Two parallel paths exist:
- **Streaming** (main loop): `claude.ts:1818` withRetry → callback at `:1837` → `paramsFromContext` → filter → `.create({...filteredParams, stream: true}).withResponse()`
- **Non-streaming** (fallback): `claude.ts:862` withRetry → callback at `:868` → `paramsFromContext` → `adjustParamsForNonStreaming` → filter → `.create(filteredAdjustedParams)`

## Reuse First

- `src/services/api/claude.ts`
  The 3400-line core file. All API parameter construction happens in the `paramsFromContext` closure (~line 1578). Do not build params elsewhere.

- `src/services/api/claude.ts` — `paramsFromContext` (~line 1578)
  Closure that builds the final `BetaMessageStreamParams` from `retryContext`. Assembles: model, messages, system prompt, tools, tool_choice, betas, metadata, max_tokens, thinking, temperature, context_management, output_config, speed, extraBodyParams. Called on **every retry attempt** (not just once).

- `src/utils/betas.ts` — `getAllModelBetas()` (line 236)
  Constructs the beta header list. Has provider-specific early returns: thirdParty skips all Anthropic betas (line 249-258), codex does the same. Dynamic betas (advisor, tool_search, fast_mode, etc.) are appended later in `paramsFromContext`. If adding a new beta feature, add it in `paramsFromContext`, NOT in `getAllModelBetas`.

- `src/services/api/withRetry.ts` — `withRetry()` (line 175)
  Core retry generator. Handles: 401/403 auth refresh, 429 rate limit + backup API switch, 529 overload + model fallback, ECONNRESET stale connection recovery, max_tokens overflow auto-adjust, prompt_too_long reactive compact. 对 Codex/OpenAI 路径还要注意 **503/429 overload 语义**：Anthropic 常用 529 表示过载，但 OpenAI/Codex 更常返回 503，部分限流型 429 也应视为 fallback 候选。Default 10 retries, 500ms base backoff, 32s cap, 25% jitter.

- `src/services/providers/capabilityFilter.ts` — `filterByCapabilities()`
  Intercepts params at SDK call boundary. Strips: unsupported betas (whitelist), thinking param, cache_control blocks, context_management, output_config.effort, caps max_tokens. Pure function, no side effects.

- `src/services/providers/resolveCapabilities.ts` — `resolveCapabilities()`
  Determines what the current provider supports. 6-layer priority merge. Memoized per `${model}:${baseUrl}`.

- `src/services/api/client.ts` — `getAnthropicClient()` (line 88)
  Creates the SDK client. Supports ProviderRegistry dispatch (when enabled) or direct construction. Handles firstParty/bedrock/vertex/foundry/codex/thirdParty. The Codex path creates a fake Anthropic SDK client via protocol adapter.

- `src/services/providers/impls/codex/adapter.ts` — `createCodexAdapter()`
  Protocol adapter that fakes `anthropic.beta.messages.create().withResponse()`. The entire pipeline (paramsFromContext → CapabilityFilter → withRetry → SDK call) flows through unchanged — the adapter intercepts at the SDK boundary, translates Anthropic params to OpenAI Responses API, and returns translated events.

- `src/services/providers/impls/codex/index.ts` — `codexProvider.createClient()`
  **OAuth 模式**（`tokenType === 'oauth_access_token'`）有两个关键差异：
  1. **模型名**：忽略 `opts.model`（Claude 模型名），使用 `config.model` > `ANTHROPIC_MODEL` env > `'openai/gpt-5.4'`
  2. **Base URL**：额外回退到 `config.chatgptBaseUrl`（`~/.codex/config.toml` 的 `chatgpt_base_url`），避免请求直连 `api.openai.com`

- `src/services/api/errors.ts`
  ~20 error pattern matchers for 400 errors (tool_use mismatches, invalid beta headers, context overflow, etc.). Extend here for new error patterns.

## Error Type Contract (Critical for Protocol Adapters)

**This is the most critical compatibility requirement for protocol adapters.** The `withRetry` engine uses `instanceof APIError` checks — plain `Error` objects bypass the entire retry/fallback infrastructure.

```typescript
import { APIError } from '@anthropic-ai/sdk'

// ✅ CORRECT: withRetry recognizes this, enables retry/fallback/backup
throw new APIError(
  response.status,           // number
  errorObject,               // parsed JSON body or { message: string }
  '[adapter] API failed',    // human-readable context
  response.headers,          // Headers instance (not plain object!)
)

// ❌ WRONG: withRetry throws CannotRetryError immediately
const err = new Error('API failed')
err.status = 429  // monkey-patched properties are invisible to instanceof
throw err
```

### Why `APIError` matters

| `withRetry.ts` location | What it checks | Consequence if plain Error |
|--------------------------|----------------|--------------------------|
| Line 426 | `!(error instanceof APIError)` | → immediate `CannotRetryError` |
| Line 280 | `error.headers?.get('retry-after')` | → no backoff from server hint |
| Line 382 | `error instanceof APIError && error.status === 429` | → no backup API switch |
| Line 332 | `is529Error(error)` | → no model fallback on overload |

### Headers must be `Headers` instances

```typescript
// ✅ CORRECT: response.headers from fetch() is already a Headers instance
throw new APIError(status, body, msg, response.headers)

// ❌ WRONG: plain object has no .get() method
throw new APIError(status, body, msg, { 'retry-after': '5' })
```

`withRetry` calls `error.headers?.get('retry-after')` — a plain object will throw `TypeError: .get is not a function`.

### Error body parsing

Protocol adapters should parse the response body as JSON and pass the structured object:

```typescript
let errorBody: Record<string, unknown>
try {
  errorBody = await response.json()
} catch {
  errorBody = { message: await response.text() }
}
throw new APIError(response.status, errorBody, `[adapter] ${response.status}`, response.headers)
```

This allows `translateError()` to inspect error messages for quota/rate-limit distinction (see `codex/index.ts` line 149).

## Common Tasks

### Adding a new API parameter

1. Add construction in `paramsFromContext` (~line 1578 in claude.ts), following the spread pattern:
```typescript
...(myFeatureEnabled && { my_param: myValue }),
```
2. If the param is provider-specific, add a stripping rule in `capabilityFilter.ts`:
```typescript
if ((filtered as any).my_param && !capabilities.supportsMyFeature) {
  delete (filtered as any).my_param
  stripped.push('my_param')
}
```
3. Add `supportsMyFeature` to `ProviderCapabilities` interface and both constants.
4. Add to SettingsSchema `providerCapabilities` object.

### Adding a new beta header

1. Define the constant in `src/utils/betas.ts` (e.g., `MY_BETA_HEADER = 'my-feature-2025-...'`)
2. Add it in `paramsFromContext` after `getMergedBetas()`:
```typescript
if (myFeatureEnabled) betasParams.push(MY_BETA_HEADER)
```
3. The CapabilityFilter will auto-strip it for thirdParty (whitelist mode, empty = strip all).
4. If a specific thirdParty provider supports it, add to their preset's `supportedBetas` array.
5. For protocol adapter providers (codex), the early return in `getAllModelBetas()` prevents Anthropic betas from being generated at all.

### Adding a new protocol adapter

Follow the pipeline compatibility checklist:

1. **Fake SDK interface**: `anthropic.beta.messages.create(params).withResponse()` → `{ data, response, request_id }`
2. **`data` is `AsyncIterable`** with `.controller` property (AbortController)
3. **Errors are `APIError` instances** with `Headers` instance (not plain objects)
4. **Add early return in `getAllModelBetas()`** for the new provider
5. **Add token counting local estimation** in `tokenEstimation.ts`（参考 codex 的 `estimateTokensLocally()` 按内容类型分别估算）
6. **Set default model name** to prevent Claude model name leakage
7. **Keep retry authority single-sourced**：优先复用外层 `withRetry`，避免 adapter 内部默认重试和外层重试叠加放大
8. **Register in `bootstrap.ts`** and extend `APIProvider` type

### Modifying retry behavior

- **Change retry count**: `withRetry.ts` DEFAULT_MAX_RETRIES
- **Add new error pattern**: `withRetry.ts` switch cases in the main retry loop
- **Add new fallback trigger**: Follow `FallbackTriggeredError` pattern (line 340-352)
- **Background query 529 behavior**: line 323-329 drops instead of retrying

### Debugging API failures

1. `CLAUDE_CODE_DEBUG=1` — enables `logForDebugging` output
2. `[CapabilityFilter]` log prefix — shows what params were stripped
3. `withRetry` logs retry attempts, backoff times, fallback triggers
4. Codex overload triage: inspect whether the failure is 503/429 (OpenAI-style) vs 529 (Anthropic-style) before concluding fallback is broken
5. `[codex-adapter]` log prefix — shows adapter-level request/response details
6. `errors.ts` pattern matchers — check if your error is already recognized

## withRetry Compatibility Checklist

When building anything that plugs into the retry pipeline, verify these requirements:

| Requirement | Why | How to verify |
|-------------|-----|---------------|
| Errors are `APIError` instances | `instanceof` check at line 426 | `err instanceof APIError === true` |
| Error `.headers` is `Headers` | `.get('retry-after')` at line 280 | `err.headers?.get?.('retry-after')` works |
| Error `.status` is a number | Status-based branching throughout | `typeof err.status === 'number'` |
| Stream has `.controller` property | `claude.ts` uses `'controller' in e.value` | `stream.controller instanceof AbortController` |
| Non-streaming emits full event sequence | `claude.ts` processes content via events | message_start → blocks → message_delta → message_stop |
| Provider has `translateError()` | ProviderRegistry error normalization | Returns `StandardApiError` with correct code |

## Rules

- `paramsFromContext` is called on **every retry attempt**. Do not put one-time setup logic inside it.
- The CapabilityFilter runs **inside** the withRetry callback (after paramsFromContext, before SDK call). This means each retry gets freshly filtered params.
- `withRetry` is an `async function*` (generator). It yields status events. Do not convert it to a regular async function.
- Never skip the CapabilityFilter when adding new SDK call paths. Both streaming and non-streaming paths must be filtered.
- The `thinking → temperature` invariant: when thinking is enabled, temperature is NOT set by `paramsFromContext`. If the filter removes thinking, it adds `temperature: 1`. Maintain this linkage.
- For Codex/OpenAI adapters, `thinking.type === 'adaptive'` must be mapped deliberately (Codex uses medium effort) rather than silently dropped.
- `extraBodyParams` (from `CLAUDE_CODE_EXTRA_BODY` env var) are spread last in params. They can override anything, by design.
- **Protocol adapters MUST throw `APIError` instances.** This is non-negotiable. Plain `Error` objects make withRetry immediately give up with `CannotRetryError`.
- **Error `.headers` MUST be a `Headers` instance**, not a plain object. `withRetry` calls `.get('retry-after')`.
- Every new provider needs an early return in `getAllModelBetas()` to prevent Anthropic beta headers from leaking.

## Integration Points

| Component | File | Key line |
|-----------|------|----------|
| Params construction | `claude.ts` | ~1578 (`paramsFromContext`) |
| Beta header assembly | `betas.ts` | 236 (`getAllModelBetas`) |
| Beta codex early return | `betas.ts` | after thirdParty block |
| Dynamic beta append | `claude.ts` | 1094, 1197, 1238 (advisor, tool_search, prompt_caching_scope) |
| Streaming call | `claude.ts` | ~1851 (`.create({...filteredParams, stream:true})`) |
| Non-streaming call | `claude.ts` | ~881 (`.create({...filteredAdjustedParams})`) |
| Capability filter | `capabilityFilter.ts` | `filterByCapabilities()` |
| Retry engine | `withRetry.ts` | 175 (`withRetry()`) |
| Error patterns | `errors.ts` | 560-810 |
| Client creation | `client.ts` | 88 (`getAnthropicClient()`) |
| Codex adapter path | `client.ts` | codex branch (`codexProvider.createClient()`) |
| Protocol adapter | `codex/adapter.ts` | `CodexAnthropicAdapterImpl._executeRequest()` |
| Token counting gate | `tokenEstimation.ts` | `countTokensWithAPI()` codex local estimation via `estimateTokensLocally()` |
| Prompt caching gate | `claude.ts` | 335 (`getPromptCachingEnabled()`) |

## Validation

- After modifying params: `CLAUDE_CODE_DEBUG=1 bun run dev` → send a message → check debug logs for `[CapabilityFilter]` output.
- After modifying retry: simulate by setting `ANTHROPIC_BASE_URL` to an invalid URL and observe retry behavior.
- After adding new beta: verify with `bun -e "import { getAllModelBetas } from './src/utils/betas.ts'; console.log(getAllModelBetas('claude-opus-4-6'))"`.
- APIError compatibility test:
```bash
bun -e "
import { APIError } from '@anthropic-ai/sdk'
const h = new Headers({ 'retry-after': '5' })
const err = new APIError(429, { message: 'rate limited' }, 'test', h)
console.log('instanceof:', err instanceof APIError, 'headers.get:', err.headers?.get?.('retry-after'))
"
```
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Building API params outside `paramsFromContext` — causes them to be missing on retries.
- Adding provider-specific if-else in `withRetry` casually — use CapabilityFilter for param adaptation, withRetry for transport-level resilience. Only add provider-aware retry/fallback branches when the upstream overload semantics genuinely differ (e.g. Codex/OpenAI 503/429 vs Anthropic 529).
- Calling SDK directly without going through withRetry — loses all retry, auth refresh, and fallback logic.
- Modifying the params object in-place — `filterByCapabilities` creates a shallow copy; `paramsFromContext` is called fresh per retry. Keep both patterns.
- Adding synchronous disk I/O inside the retry loop — `paramsFromContext` is called per-retry, disk I/O there becomes amplified.
- **Throwing plain `Error` with monkey-patched `.status` in protocol adapters** — withRetry needs `instanceof APIError`, not duck typing. This is the #1 cause of "adapter works but never retries".
- **Using plain object for error `.headers`** — withRetry calls `.get()` which doesn't exist on plain objects.
- Skipping the beta early return for new providers — Anthropic betas leak to the target API → 400 errors.
