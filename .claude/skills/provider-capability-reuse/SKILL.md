---
name: "provider-capability-reuse"
description: "Reuse existing ProviderCapabilities type, resolveCapabilities resolver, CapabilityFilter interceptor, PROVIDER_PRESETS, dynamic probeCapabilities pattern, beta three-line filter, and OpenAI model pricing integration when adding new third-party API providers, extending capability fields, or modifying API parameter filtering."
---

# Provider Capability Reuse

Use this skill when adding a new third-party API provider, extending provider capability fields, modifying the API parameter filtering logic, integrating model pricing for non-Anthropic providers, or debugging third-party API compatibility issues.

## Architecture Overview

```
settings.json / env vars / presets
         ↓
resolveCapabilities(model, baseUrl)   ← 6-layer priority merge
         ↓
ProviderCapabilities                  ← unified type (12 fields + supportedBetas)
         ↓
filterByCapabilities(params, caps)    ← pure function, strips unsupported params
         ↓
anthropic.beta.messages.create()      ← SDK call with filtered params
```

Three defense lines exist:
1. `src/utils/betas.ts:249-258` — coarse filter (thirdParty/codex skip all Anthropic betas)
2. `src/services/providers/capabilityFilter.ts` — fine filter (whitelist-based, catches anything leaked)
3. `src/services/tokenEstimation.ts` — token counting short-circuit (non-Anthropic providers skip `countTokensWithAPI`)

## Reuse First

- `src/services/providers/providerCapabilities.ts`
  The single source of truth for the `ProviderCapabilities` interface, `FULL_CAPABILITIES` (firstParty), and `CONSERVATIVE_DEFAULTS` (thirdParty fallback). Extend this type when adding new capability dimensions.

- `src/services/providers/presets.ts`
  Add new provider presets to `PROVIDER_PRESETS` by domain key. `findPresetForUrl()` matches URL hostname against preset keys. Do not create a separate preset system.

- `src/services/providers/resolveCapabilities.ts`
  6-layer priority resolver: settings.json → `ANTHROPIC_PROVIDER_CAPABILITIES` env → `modelSupportOverrides` bridge → capabilityCache → PROVIDER_PRESETS → CONSERVATIVE_DEFAULTS. Uses lodash `memoize` with key `${model}:${baseUrl}`. Call `clearResolveCapabilitiesCache()` when inputs change.

- `src/services/providers/capabilityFilter.ts`
  Pure function `filterByCapabilities(params, capabilities)` → `{ params, stripped }`. Add new parameter stripping rules here. Returns stripped items list for debug logging.

- `src/utils/model/modelSupportOverrides.ts`
  Existing per-tier env var overrides (`ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES`). The resolver bridges these automatically. Do not duplicate this bridge.

- `src/services/providers/capabilityCache.ts`
  Disk cache at `~/.claude/provider-capabilities.json` with 7-day TTL. Currently async-only API (`getOrProbe`), so the synchronous resolver skips it. If you make it sync-accessible, wire it into `resolveCapabilitiesImpl` layer 4.

- `src/utils/betas.ts`
  `getAllModelBetas()` is the coarse beta filter. Has per-provider early returns for **both** thirdParty and codex. Do NOT modify it for new per-provider logic — use `capabilityFilter.ts` instead. See Beta Three-Line Filter below.

- `src/utils/modelCost.ts`
  Model pricing lookup. Contains both Anthropic `MODEL_COSTS` and OpenAI `OPENAI_MODEL_COSTS` tables. `getModelCosts()` checks OpenAI pricing first, then falls back to Anthropic canonical name lookup. When adding a new non-Anthropic provider, add a separate pricing table here.

- `src/services/tokenEstimation.ts`
  Token counting. Has provider-specific short-circuits: `getAPIProvider() === 'codex'` uses `estimateTokensLocally()` 进行本地结构化估算（按内容类型分别计算：text=bytes/4, JSON/tool_use=bytes/2, image=2000 固定值），而非返回 null。Bedrock 使用 AWS SDK 的 `countTokens`。其他 non-Anthropic providers 应参考 codex 的本地估算模式。

- `src/constants/prompts.ts`
  System prompt 的模型身份。`computeEnvInfo()` 和 `computeSimpleEnvInfo()` 对 Codex 模式有专门分支：读取 `~/.codex/config.toml` 获取实际模型名（如 `gpt-5.4`），而非使用 Claude 模型名。新 provider 如需自定义模型身份，应在这两个函数中添加类似分支。

## Provider-Level `capabilityDeclaration`

Providers implementing `LLMProvider` can declare a `capabilityDeclaration` field directly on the provider object. This is used by `resolveCapabilities()` at Layer 4.5, taking priority over disk cache (Layer 5) and domain presets (Layer 6).

```typescript
export const myProvider: LLMProvider = {
  id: 'my-provider',
  capabilityDeclaration: {
    supportsThinking: true,
    supportsStreaming: true,
    // ... all 12 fields
  } satisfies ProviderCapabilities,
  // ...
}
```

Use `capabilityDeclaration` when:
- The provider knows its capabilities at registration time (no network probe needed)
- You want the provider to be the authority on its own capabilities
- The preset may not cover all deployment scenarios (e.g., custom base URLs)

The `satisfies ProviderCapabilities` ensures type completeness at compile time.

Reference: `src/services/providers/impls/codex/index.ts` — `codexProvider.capabilityDeclaration`

## Dynamic `probeCapabilities()` Pattern

For providers where capabilities vary by model (e.g., OpenAI's `o3` supports reasoning but `gpt-4o` doesn't), implement `probeCapabilities(model)` on the `LLMProvider`:

```typescript
async probeCapabilities(model: string): Promise<Partial<ProviderCapabilities>> {
  const contextTokens = getModelContextTokens(model)  // per-model lookup table
  const supportsThinking = model.startsWith('o')       // model family heuristic
  return {
    maxContextTokens: contextTokens,
    supportsThinking,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsVision: true,
    supportsEffort: supportsThinking,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsMaxEffort: false,
    supports1M: contextTokens >= 1_000_000,
    supportsToolSearch: false,
    supportedBetas: [],
  }
}
```

Key patterns:
- **Context window mapping**: Use a `Record<string, number>` with exact + prefix matching for model variants (e.g., `gpt-4o-2024-11-20` matches `gpt-4o` prefix)
- **Model family detection**: Use `model.startsWith('o')` for reasoning-capable models, not hardcoded model lists
- **`adaptive` thinking mapping**: Claude Code may send `thinking.type === 'adaptive'` by default. Capability declaration alone is not enough; if the provider supports reasoning, request translation must map adaptive explicitly instead of only handling `enabled`.
- **`supports1M` derivation**: `contextTokens >= 1_000_000`, never hardcoded
- **Full field set**: Always return all 12 fields — partial returns get merged with defaults

Reference: `src/services/providers/impls/codex/index.ts` — `codexProvider.probeCapabilities()`

## Beta Three-Line Filter

Beta headers pass through three filtering stages. When adding a new provider, ensure all three are addressed:

```
Stage 1: betas.ts — getAllModelBetas()
  ├── thirdParty → early return (skip all Anthropic betas)
  ├── codex → early return (skip all Anthropic betas)
  └── firstParty → full beta list construction

Stage 2: capabilityFilter.ts — filterByCapabilities()
  └── Whitelist-based: only betas in capabilities.supportedBetas pass through

Stage 3: per-provider adapter
  └── Protocol adapters strip betas entirely (OpenAI doesn't understand them)
```

When adding a new provider:
1. Add early return in `getAllModelBetas()` in `betas.ts` (like codex/thirdParty)
2. Set `supportedBetas: []` in `capabilityDeclaration` (defense in depth)
3. If adapter-based, ensure adapter ignores any betas that leak through

Reference: `src/utils/betas.ts` — codex early return block

## Domain Matching Safety

`findPresetForUrl()` uses `matchesDomain()` for safe subdomain matching:

```typescript
function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith('.' + domain)
}
```

This prevents `evil-api.openai.com.attacker.com` from matching the `api.openai.com` preset. Always use exact or suffix matching, never `includes()`.

## OpenAI Model Pricing Integration

Non-Anthropic model pricing lives alongside Anthropic pricing in `src/utils/modelCost.ts`:

```typescript
// OpenAI pricing table (separate from Anthropic MODEL_COSTS)
const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  'gpt-4o': OPENAI_PRICING_GPT4O,
  'o3': OPENAI_PRICING_O3,
  // ...
}

// getModelCosts() checks OpenAI first, then Anthropic
export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const openaiCosts = OPENAI_MODEL_COSTS[model]
  if (openaiCosts) return openaiCosts
  // ... fall through to Anthropic canonical name lookup
}
```

Key rules:
- OpenAI model names are used **as-is** (no `getCanonicalName()` transformation)
- Each provider's pricing is a flat `Record<string, ModelCosts>` — no nesting
- `getModelCosts()` priority: OpenAI exact match → Anthropic canonical name → default tier
- When adding a new provider, add its pricing table and an early-return check in `getModelCosts()`

## Common Tasks

### Adding a new third-party provider

1. Add preset to `PROVIDER_PRESETS` in `src/services/providers/presets.ts`:
```typescript
'api.newprovider.com': {
  supportsThinking: false,
  supportsPromptCache: false,
  supportsStreaming: true,
  maxContextTokens: 128_000,
  supportedBetas: [],
},
```
2. Done. The resolver auto-matches by URL hostname.

### Adding a protocol adapter provider (like Codex)

1. Add a preset in `presets.ts` for the target API domain
2. Add `capabilityDeclaration` to the `LLMProvider` object with `satisfies ProviderCapabilities`
3. Implement `probeCapabilities(model)` returning full `Partial<ProviderCapabilities>` (all 12 fields)
4. Add early return in `getAllModelBetas()` in `betas.ts` for the new provider
5. Add token counting local estimation in `tokenEstimation.ts`（参考 codex 的 `estimateTokensLocally()` 模式）
6. Add model pricing table in `modelCost.ts` with early-return in `getModelCosts()`
7. Add model context window mapping in provider's `index.ts`
8. **Usage 语义审计**：确认 provider 的 usage 字段与 Anthropic 下游语义一致；若上游把 cached tokens 算进 `input_tokens`，适配层必须先归一化
9. The declaration wins over preset in `resolveCapabilities()`, so the provider is always authoritative
10. **系统提示词模型身份**：在 `src/constants/prompts.ts` 的 `computeEnvInfo()` 和 `computeSimpleEnvInfo()` 中添加 provider 分支，读取实际模型名
11. **OAuth 模式特殊处理**：如果 provider 支持 OAuth 认证（如 Codex ChatGPT 模式），`createClient()` 中必须：
   - 忽略 `opts.model`（防止 Claude 模型名泄漏），使用 config 或默认 OpenAI 模型名
   - 回退到 OAuth 专用 base URL（如 `chatgpt_base_url`），而非直连 `api.openai.com`

### Adding a new capability dimension

1. Add field to `ProviderCapabilities` interface in `providerCapabilities.ts`
2. Set defaults in both `FULL_CAPABILITIES` and `CONSERVATIVE_DEFAULTS`
3. Add Zod field in `src/utils/settings/types.ts` SettingsSchema `providerCapabilities`
4. Add stripping rule in `filterByCapabilities()` in `capabilityFilter.ts`
5. Update presets if the new capability affects existing providers

### Adding a new OpenAI model

1. Add context window to `OPENAI_MODEL_CONTEXT` in `src/services/providers/impls/codex/index.ts`
2. Add pricing to `OPENAI_MODEL_COSTS` in `src/utils/modelCost.ts`
3. Done — `probeCapabilities` and `getModelCosts` auto-pick up the new model

### Debugging "400 Bad Request" from third-party API

1. Set `CLAUDE_CODE_DEBUG=1` and look for `[CapabilityFilter] Stripped` log lines
2. If a parameter is NOT being stripped, check:
   - Is `resolveCapabilities` returning the right capabilities? (Add `logForDebugging` in resolver)
   - Is the parameter handled in `filterByCapabilities`? (May need new stripping rule)
   - Is it a parameter added AFTER the filter runs? (Should not happen — filter is at SDK call boundary)

### Enabling a capability for an existing provider

User-side: add to `~/.claude/settings.json`:
```json
{
  "providerCapabilities": {
    "https://api.minimaxi.com/*": {
      "supportsThinking": true
    }
  }
}
```
settings.json takes highest priority and overrides presets.

## Rules

- Do not create a second capability type system. Extend `ProviderCapabilities`.
- Do not add provider-specific if-else in `claude.ts`. Use the filter pattern.
- Do not modify `betas.ts` for per-provider logic beyond early returns. The coarse filter is intentional as first defense; the fine filter in `capabilityFilter.ts` is the right place.
- Keep `filterByCapabilities` a pure function. No side effects, no async.
- The `thinking → temperature` linkage is critical: when thinking is stripped, temperature must be set to 1. See `capabilityFilter.ts` rule 2.
- `FULL_CAPABILITIES` uses reference equality check for fast-path (`capabilities === FULL_CAPABILITIES`). Do not create copies of it.
- OpenAI model names bypass `getCanonicalName()` — they are used as-is in pricing lookup.
- Token counting must use local estimation for non-Anthropic providers — the adapter doesn't implement `countTokens()`。参考 codex 的 `estimateTokensLocally()` 模式（按内容类型分别估算），而非简单返回 null。
- If the upstream provider reports cached prompt tokens inside `input_tokens`（如 OpenAI Responses），适配层必须在 usage 翻译时扣除 cached 部分，再填充 `cache_read_input_tokens`，否则 Claude Code 下游会双重计数。
- Every new provider needs three things: beta early return, token counting local estimation, pricing table.
- For reasoning-capable third-party models, capability declaration is only half the job; request translation must still map Claude thinking modes (`adaptive`, `enabled`, `disabled`) correctly.

## Integration Points

| Insertion point | File | Line (approx) |
|----------------|------|----------------|
| Streaming SDK call | `src/services/api/claude.ts` | ~1851 |
| Non-streaming SDK call | `src/services/api/claude.ts` | ~881 |
| Settings cache clear | `src/state/onChangeAppState.ts` | settings diff block |
| Preset lookup | `src/services/providers/presets.ts` | `findPresetForUrl()` |
| Beta coarse filter | `src/utils/betas.ts` | `getAllModelBetas()` |
| Token counting | `src/services/tokenEstimation.ts` | `countTokensWithAPI()` codex local estimation |
| Model pricing | `src/utils/modelCost.ts` | `getModelCosts()` |
| Model context windows | `codex/index.ts` | `OPENAI_MODEL_CONTEXT` |
| System prompt identity | `src/constants/prompts.ts` | `computeEnvInfo()` codex branch |

## Validation

- Run `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_API_KEY=test bun -e "import { resolveCapabilities } from './src/services/providers/resolveCapabilities.ts'; console.log(resolveCapabilities('test', 'https://api.minimaxi.com/anthropic'))"` to verify preset loading.
- Run filter test: `bun -e "import { filterByCapabilities } from './src/services/providers/capabilityFilter.ts'; import { CONSERVATIVE_DEFAULTS } from './src/services/providers/providerCapabilities.ts'; console.log(filterByCapabilities({ model:'t', messages:[], max_tokens:1000, betas:['test'], thinking:{type:'enabled',budget_tokens:1000} }, CONSERVATIVE_DEFAULTS))"` to verify stripping.
- Run beta test: `bun -e "import { getAllModelBetas } from './src/utils/betas.ts'; console.log('codex should be empty:', getAllModelBetas('gpt-4o'))"` (with CLAUDE_CODE_USE_CODEX=1).
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Adding provider-specific branches in `claude.ts` or `withRetry.ts` instead of using the capability filter.
- Creating a parallel capability cache or preset system.
- Hardcoding capability checks with `if (baseUrl.includes('minimax'))` instead of using `resolveCapabilities`.
- Modifying `FULL_CAPABILITIES` to disable features for firstParty — it should always represent full capability.
- Forgetting to update `CONSERVATIVE_DEFAULTS` when adding new capability fields (breaks third-party providers).
- Using `getCanonicalName()` on non-Anthropic model names — OpenAI models use raw names.
- Skipping the beta early return for new providers — Anthropic betas leak to the target API → 400 errors.
- Calling `countTokensWithAPI()` for non-Anthropic providers — the adapter doesn't implement it。应使用 `estimateTokensLocally()` 模式进行本地估算。
- 在 `prompts.ts` 系统提示词中对新 provider 仍使用 Claude 模型名 — AI 会误认为自己是 Claude，应添加 provider 分支读取实际模型名。
