---
name: "openai-model-catalog-reuse"
description: "Centralized reference for adding new OpenAI/non-Anthropic models: context window mapping (OPENAI_MODEL_CONTEXT in codex/index.ts), pricing table (OPENAI_MODEL_COSTS in modelCost.ts), and capability detection (probeCapabilities). Use when adding a new OpenAI model, updating pricing, or extending support to non-Anthropic model families."
---

# OpenAI Model Catalog Reuse

Use this skill when adding a new OpenAI model, updating model pricing, extending model context window mappings, or adding support for a new non-Anthropic model family (e.g., Google Gemini, Cohere).

## Architecture Overview

OpenAI model metadata is split across two lookup tables that must stay synchronized:

```
Model name (e.g., "gpt-4.1")
         ↓
┌─── OPENAI_MODEL_CONTEXT ──────────────────────┐
│  codex/index.ts                                │
│  Maps model name → context window tokens       │
│  Used by: probeCapabilities(), supports1M      │
└────────────────────────────────────────────────┘
         ↓
┌─── OPENAI_MODEL_COSTS ────────────────────────┐
│  modelCost.ts                                  │
│  Maps model name → pricing (input/output/cache)│
│  Used by: getModelCosts(), calculateUSDCost()  │
└────────────────────────────────────────────────┘
```

Both tables use the **raw OpenAI model name** as key (no `getCanonicalName()` transformation).

## The Two Lookup Tables

### Table 1: Context Window — `OPENAI_MODEL_CONTEXT`

Location: `src/services/providers/impls/codex/index.ts`

```typescript
const OPENAI_MODEL_CONTEXT: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
}
```

Used by:
- `getOpenAIModelContextTokens(model)` — exact match then prefix match
- `probeCapabilities(model)` → `maxContextTokens`, `supports1M`
- Default fallback: `200_000` tokens

**Prefix matching**: `gpt-4o-2024-11-20` matches `gpt-4o` prefix. This handles date-suffixed model variants without explicit entries.

### Table 2: Pricing — `OPENAI_MODEL_COSTS`

Location: `src/utils/modelCost.ts`

```typescript
const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  'gpt-4o': OPENAI_PRICING_GPT4O,
  'gpt-4o-2024-11-20': OPENAI_PRICING_GPT4O,
  'gpt-4o-mini': OPENAI_PRICING_GPT4O_MINI,
  'o3': OPENAI_PRICING_O3,
  'o3-mini': OPENAI_PRICING_O3_MINI,
  'o4-mini': OPENAI_PRICING_O4_MINI,
  'gpt-4.1': OPENAI_PRICING_GPT41,
  'gpt-4.1-mini': OPENAI_PRICING_GPT4O_MINI,
  'gpt-4.1-nano': OPENAI_PRICING_GPT4O_MINI,
}
```

Used by:
- `getModelCosts(model, usage)` — exact match (checked **before** Anthropic canonical name lookup)
- `calculateUSDCost(resolvedModel, usage)` → dollar cost for analytics/display

**No prefix matching**: pricing requires exact model name entries (including date-suffixed variants).

### Pricing Tier Constants

Each pricing tier is a `ModelCosts` object with 5 fields:

```typescript
const OPENAI_PRICING_GPT4O: ModelCosts = {
  inputTokens: 2.5,        // $ per million tokens
  outputTokens: 10,         // $ per million tokens
  promptCacheWriteTokens: 2.5,   // same as input (OpenAI auto-caches)
  promptCacheReadTokens: 1.25,   // 50% discount on cached
  webSearchRequests: 0,     // not applicable for OpenAI
}
```

## Current Model Catalog

| Model | Context | Input $/Mtok | Output $/Mtok | Cache Read $/Mtok | Reasoning |
|-------|---------|-------------|--------------|-------------------|-----------|
| gpt-4o | 128K | $2.50 | $10 | $1.25 | No |
| gpt-4o-mini | 128K | $0.15 | $0.60 | $0.075 | No |
| o3 | 200K | $2 | $8 | $1 | Yes |
| o3-mini | 200K | $1.10 | $4.40 | $0.55 | Yes |
| o4-mini | 200K | $1.10 | $4.40 | $0.55 | Yes |
| gpt-4.1 | 1M | $2 | $8 | $0.50 | No |
| gpt-4.1-mini | 1M | $0.15 | $0.60 | $0.075 | No |
| gpt-4.1-nano | 1M | $0.15 | $0.60 | $0.075 | No |

## Common Tasks

### Adding a new OpenAI model

This is the most common task. Two files, two edits:

**Step 1**: Add context window in `src/services/providers/impls/codex/index.ts`:
```typescript
const OPENAI_MODEL_CONTEXT: Record<string, number> = {
  // ... existing entries
  'new-model': 256_000,     // ← add here
}
```

**Step 2**: Add pricing in `src/utils/modelCost.ts`:
```typescript
// Define pricing tier (reuse existing if same pricing)
const OPENAI_PRICING_NEW: ModelCosts = {
  inputTokens: 3,
  outputTokens: 12,
  promptCacheWriteTokens: 3,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0,
}

const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  // ... existing entries
  'new-model': OPENAI_PRICING_NEW,  // ← add here
}
```

**Done.** `probeCapabilities` and `getModelCosts` automatically pick up the new model. No other changes needed.

### Adding a date-suffixed model variant

Context window table has prefix matching — no entry needed for date variants.
Pricing table requires explicit entries:

```typescript
// Only needed in modelCost.ts
const OPENAI_MODEL_COSTS: Record<string, ModelCosts> = {
  'gpt-4o': OPENAI_PRICING_GPT4O,
  'gpt-4o-2024-11-20': OPENAI_PRICING_GPT4O,  // ← explicit date variant
}
```

### Adding a new reasoning model (o-series)

Reasoning models get special handling in `probeCapabilities()`:

```typescript
const supportsThinking = model.startsWith('o')  // automatic for o-series
```

So adding `o5` or `o5-mini` only needs:
1. Context window entry
2. Pricing entry
3. Reasoning support is auto-detected by the `o` prefix

### Adding a non-OpenAI model family (e.g., Google Gemini)

For a completely new provider:

1. Create context window table in the provider's `index.ts`:
```typescript
const GEMINI_MODEL_CONTEXT: Record<string, number> = {
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.0-pro': 2_000_000,
}
```

2. Create pricing table in `modelCost.ts`:
```typescript
const GEMINI_MODEL_COSTS: Record<string, ModelCosts> = {
  'gemini-2.0-flash': { inputTokens: 0.075, outputTokens: 0.3, ... },
}
```

3. Add early-return in `getModelCosts()`:
```typescript
export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const openaiCosts = OPENAI_MODEL_COSTS[model]
  if (openaiCosts) return openaiCosts
  const geminiCosts = GEMINI_MODEL_COSTS[model]  // ← add new provider
  if (geminiCosts) return geminiCosts
  // ... fall through to Anthropic
}
```

### Updating pricing for an existing model

Just update the pricing constant — all models sharing that tier update automatically:

```typescript
// Updating gpt-4o pricing affects 'gpt-4o' and 'gpt-4o-2024-11-20'
const OPENAI_PRICING_GPT4O: ModelCosts = {
  inputTokens: 2.0,  // was 2.5
  outputTokens: 8,    // was 10
  // ...
}
```

## Capability Detection Logic

`probeCapabilities(model)` in `codex/index.ts` derives capabilities from the model name:

```typescript
async probeCapabilities(model: string): Promise<Partial<ProviderCapabilities>> {
  const contextTokens = getOpenAIModelContextTokens(model)
  const supportsThinking = model.startsWith('o')
  return {
    maxContextTokens: contextTokens,
    supportsThinking,
    supports1M: contextTokens >= 1_000_000,
    supportsEffort: supportsThinking,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCache: false,
    supportsAdaptiveThinking: false,
    supportsInterleavedThinking: false,
    supportsMaxEffort: false,
    supportsToolSearch: false,
    supportedBetas: [],
  }
}
```

Key derivation rules:
- `supportsThinking` = `model.startsWith('o')` (o1, o3, o4 series)
- `supportsEffort` = same as `supportsThinking`
- `thinking.type === 'adaptive'` from Claude Code should still be mapped in the request translator for reasoning models; capability detection alone is not enough
- `supports1M` = `contextTokens >= 1_000_000`
- `supportsPromptCache` = always `false` (OpenAI caches automatically)
- `supportedBetas` = always `[]` (no Anthropic betas)

## Token Estimation

Codex 模式使用本地结构化估算（`estimateTokensLocally()` in `tokenEstimation.ts`），不依赖 API 调用。估算按内容类型分别计算：
- text/thinking: `bytes / 4`
- JSON/tool_use: `bytes / 2`
- image: 固定 `2000` tokens
- per-message overhead: `4` tokens
- per-tool definition: `10` tokens

添加新 OpenAI 模型时无需修改 token 估算逻辑——它对所有模型通用。

## Usage Semantics Reminder

模型目录表只解决“模型是什么”，不解决“usage 怎么解释”。如果上游 API（如 OpenAI Responses）把 cached prompt tokens 计入 `input_tokens`，则适配层必须在 `responseTranslator.ts` 中先扣除 cached 部分，再写入 `cache_read_input_tokens`。否则 Claude Code 下游做总量/成本聚合时会双重计数。这里只保留提醒；usage 语义规范以协议适配/请求链路相关 skill 为准。

## Rules

- **Both tables must be updated together.** A model in one but not the other causes either wrong cost display or wrong context window.
- **Model catalog changes do not fix request translation by themselves.** If the new model is a reasoning model, also verify `thinking`/`adaptive` mapping in `requestTranslator.ts`.
- **Use raw model names, not canonical names.** OpenAI model names bypass `getCanonicalName()`.
- **Reuse pricing tier constants** when multiple models share the same pricing (e.g., `gpt-4.1-mini` and `gpt-4.1-nano` both use `OPENAI_PRICING_GPT4O_MINI`).
- **Prefix matching is only for context windows**, not pricing. Date-suffixed variants need explicit pricing entries.
- **Default context window is 200K tokens.** If a model isn't in the table, `getOpenAIModelContextTokens()` returns `200_000`.
- **`webSearchRequests` is always 0** for OpenAI models (not tracked separately).
- **Pricing source**: https://openai.com/api/pricing/ — verify before adding new entries.

## Validation

After adding a new model, verify both lookups:

```bash
# Context window check
bun -e "
import { codexProvider } from './src/services/providers/impls/codex/index.ts'
const caps = await codexProvider.probeCapabilities('new-model')
console.log('context:', caps.maxContextTokens, 'thinking:', caps.supportsThinking, '1M:', caps.supports1M)
"

# Pricing check
bun -e "
import { getModelCosts } from './src/utils/modelCost.ts'
const costs = getModelCosts('new-model', { input_tokens: 0, output_tokens: 0 } as any)
console.log('input:', costs.inputTokens, 'output:', costs.outputTokens, 'cache_read:', costs.promptCacheReadTokens)
"
```

Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Adding model entries in only one of the two tables — causes either wrong pricing or wrong context window.
- Using `getCanonicalName()` on OpenAI model names — it maps them to Anthropic canonical names, producing wrong results.
- Hardcoding `supports1M: true` instead of deriving from `contextTokens >= 1_000_000`.
- Creating a separate pricing system for non-Anthropic models instead of extending `OPENAI_MODEL_COSTS`.
- Not checking the `o` prefix for reasoning detection — adding `supportsThinking: true` in the context table instead of letting `probeCapabilities()` derive it.
- Forgetting to verify pricing against https://openai.com/api/pricing/ — stale pricing causes incorrect cost tracking.
