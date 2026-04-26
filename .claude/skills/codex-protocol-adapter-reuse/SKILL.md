---
name: "codex-protocol-adapter-reuse"
description: "Reuse the OpenAI Responses API protocol adapter architecture (translator framework, fake SDK client, SSE stream conversion, error type contract, dynamic model capabilities) when adding support for new non-Anthropic API protocols like Google Gemini, Ollama native, Cohere, or any OpenAI-compatible endpoint."
---

# Codex Protocol Adapter Reuse

Use this skill when adding support for a new LLM API protocol that is NOT Anthropic Messages API, creating protocol translators between different API formats, implementing fake/proxy SDK clients, or extending the existing Codex/OpenAI Responses API adapter.

## Architecture Overview

The protocol adapter pattern enables Claude Code to speak any LLM API protocol while keeping the entire existing codebase (claude.ts, withRetry, queryModel, tools) unchanged:

```
Claude Code internal flow (unchanged)
       ↓
  anthropic.beta.messages.create(params)
       ↓
  ProtocolAdapter (fake Anthropic SDK client)
       ├── requestTranslator:  Anthropic params → Target API request
       ├── HTTP transport:     POST to target endpoint (SSE/WebSocket/JSON)
       ├── responseTranslator: Target events → BetaRawMessageStreamEvent stream
       └── errorContract:      Target HTTP errors → APIError instances
       ↓
  Stream<BetaRawMessageStreamEvent>
       ↓
  claude.ts existing stream handler (zero changes)
```

**Core insight**: By faking the Anthropic SDK interface at the Provider layer, the entire 3400-line claude.ts and all retry/streaming/tool logic work unchanged. The protocol translation is fully encapsulated.

## The Five-Layer Translation Model

A complete protocol adapter must translate all five layers:

```
Layer 1: Data Format         ✅ request/response/message/tool translators
Layer 2: Stream Protocol     ✅ SSE parser → Anthropic event sequence
Layer 3: Error Type Contract ✅ Target errors → APIError instances (critical for withRetry)
Layer 4: Default Value Chain ✅ Model name fallback, token counting, cost, betas
Layer 5: Meta-Protocol       ✅ Capabilities, tool filtering, terminal events
```

Layer 3 is the most critical and most commonly missed — see Error Type Contract below.

## Reuse First

### Translator Framework (`src/services/providers/impls/codex/translator/`)

- `requestTranslator.ts`
  Converts Anthropic `BetaMessageStreamParams` → target API request format. Handles: system prompt flattening, thinking→reasoning mapping, tool_choice translation (`auto`/`any`→`required`/`none`/`{type:'tool',name}`→`{type:'function',name}`), stop_sequences→stop 透传。**需要显式支持 `thinking.type === 'adaptive'`**：Claude Code 4.6 默认会走 adaptive thinking，若只处理 `enabled` 会导致推理模型静默失去 reasoning 配置。Codex 当前将 adaptive 映射为上下文感知 effort：有 tools 时 `medium`，否则 `low`。`enabled` 模式使用精细化预算映射：`≤1000→low, ≤4000→medium, >4000→high`。**非 reasoning 模式下有条件透传 temperature 和 top_p**——仅当值不为 Anthropic 默认值 `1` 时才发送，避免兼容端点报 unsupported parameter。**max_output_tokens 默认不发送**，需 `CODEX_ENABLE_MAX_OUTPUT_TOKENS=1` 显式启用（`CODEX_SKIP_MAX_TOKENS=1` 可进一步强制禁用）。Reuse the `translateRequest()` signature and parameter inspection pattern when adding new target protocols.

- `responseTranslator.ts`
  Finite-state-machine driven translator class (`ResponseTranslator`) with explicit states: `Init → MessageStarted → BlockActive ⇄ MessageStarted → Completed/Failed`. Uses composite keys (`${output_index}:${content_index}`) for multi-content-part support. Handles all OpenAI SSE events including `response.incomplete` (maps to `max_tokens` stop_reason). **`handleFailed` 会注入可见的错误文本块**（`[API Error: code] message`），让上游对话循环能看到错误信息，而非静默以 `end_turn` 结束——失败响应先发 content_block_start/delta/stop（错误文本块），再发 message_delta + error 事件。**Usage 语义适配是关键兼容层**：OpenAI `usage.input_tokens` 包含 cached tokens，而 Claude Code 下游很多逻辑按 Anthropic 语义消费 `input_tokens + cache_read_input_tokens`，所以翻译时必须先扣掉 cached 部分，再单独填入 `cache_read_input_tokens`。同时可将 `output_tokens_details.reasoning_tokens` 以扩展字段（如 `reasoning_output_tokens`）透传，供成本跟踪使用。**Critical**: This is the most complex piece — new protocols MUST produce the exact same event sequence that claude.ts expects:
  ```
  message_start → content_block_start → content_block_delta* → content_block_stop → ... → message_delta → message_stop
  ```

- `messageTranslator.ts`
  Converts Anthropic `messages[]` (role/content blocks) → target format conversation items. One Anthropic message with mixed content (text + tool_use) splits into multiple target items. **Thinking 块映射为 ReasoningItem 时加 `[Full reasoning trace]` 前缀**——OpenAI ReasoningItem 仅支持 `summary` 字段，但传入的是完整推理过程而非摘要，前缀让模型区分完整推理 trace 和压缩摘要。**Tool result 图片完整透传**：正常大小图片（<10MB）转为完整 data URL（`data:{media_type};base64,{data}`），仅超大图片（>10MB）截断并输出 console.error 警告。Handles image blocks in tool_result content.

- `toolTranslator.ts`
  Converts Anthropic tool definitions → target function definitions. 在 **Codex/OpenAI Responses API** 这条适配链里，当前策略是**不做任何过滤**：所有工具（包括 Anthropic 服务端工具类型）都转换为 function 工具传递给 OpenAI 模型。这是当前目标协议下的兼容策略，不是所有新 adapter 的通用规则。

### SDK Adapter (`src/services/providers/impls/codex/adapter.ts`)

The `CodexAnthropicAdapterImpl` class fakes the Anthropic SDK chain. **重试职责应尽量收敛到外层 `withRetry`**：adapter 内部默认 `maxRetries` 应为 0，避免与外层默认 10 次重试形成乘法放大。只有目标协议存在 `withRetry` 无法感知的瞬时错误语义时，才应考虑增加 adapter 内部重试。
```typescript
anthropic.beta.messages.create(params, opts).withResponse()
// Returns: { data: AsyncIterable<BetaRawMessageStreamEvent>, response, request_id }
```

Key compatibility points to maintain for any new adapter:
1. `.create()` returns a Promise with `.withResponse()` method attached
2. `.withResponse()` resolves to `{ data, response, request_id }`
3. `data` must be `AsyncIterable` with a `.controller` property (AbortController)
4. Non-streaming mode must emit a synthetic event sequence (message_start → content_block_start/delta/stop per block → message_delta → message_stop)
5. **Errors MUST be `APIError` instances** (see Error Type Contract below)

### SSE Streaming (`src/services/providers/shared/sseParser.ts`)

Shared SSE parser used by all SSE-based providers:

- Handles `:` comment lines (keep-alive heartbeats) — explicitly skipped
- Handles `data: [DONE]` sentinel — explicitly skipped (not swallowed via parse error)
- Handles missing `event:` lines — uses `'message'` as default event type (OpenAI-compatible endpoint tolerance)
- Handles multi-line `data:` fields — concatenated with newlines per SSE spec

`createAnthropicCompatibleStream()` in `streaming.ts` wraps the parser with `ResponseTranslator` and attaches `.controller`. `createAnthropicMessageFromResponse()` 将非流式 JSON 响应转换为 Anthropic BetaMessage 格式，**支持 `reasoning` output item**——提取 summary text 转为 `{ type: 'thinking', thinking, signature: '' }` content block。

### Error Type Contract

**This is the most critical compatibility requirement.** The adapter MUST throw `APIError` instances from `@anthropic-ai/sdk`, not plain `Error` objects.

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

Why this matters:
- `withRetry.ts` line 426: `!(error instanceof APIError) || !shouldRetry(error)` → non-APIError = immediate CannotRetryError
- `withRetry.ts` line 280: `error.headers?.get('retry-after')` → requires Headers instance with `.get()` method
- `withRetry.ts` line 382: `error instanceof APIError && error.status === 429` → backup API switch
- `withRetry.ts` line 332: `is529Error(error)` → model fallback on overload

Without `APIError`, the entire retry/backoff/fallback infrastructure is bypassed.

### Auth Bridge (`src/services/providers/impls/codex/auth.ts`)

Reads `~/.codex/auth.json` with JWT expiration tracking and token refresh. See `external-auth-bridge-reuse` skill for the full pattern.

### Provider Registration

- `src/services/providers/impls/codex/index.ts` — `LLMProvider` implementation with `detect()`, `createClient()`, `probeCapabilities()`, `translateError()`.
- `src/services/providers/bootstrap.ts` — Registration order determines priority.
- `src/utils/model/providers.ts` — `APIProvider` union type and `getAPIProvider()` detection.
- `src/services/api/client.ts` — Legacy path fallback (when ProviderRegistry is disabled).

### Dynamic Model Capabilities

`probeCapabilities(model)` returns model-specific capabilities:

```typescript
// OpenAI 模型上下文窗口映射 (codex/index.ts)
const OPENAI_MODEL_CONTEXT: Record<string, number> = {
  'gpt-4o': 128_000,
  'o3': 200_000,
  'gpt-4.1': 1_000_000,
  // ...
}
```

The `probeCapabilities` method uses model name to determine:
- `maxContextTokens` — per-model context window
- `supportsThinking` — `o*` models support reasoning
- `supports1M` — true when context >= 1M

### Default Model Name & OAuth Mode Model Selection

The Codex provider MUST prevent Claude model names (e.g., `claude-opus-4-6`) from leaking to the OpenAI API.

**OAuth 模式**（`tokenType === 'oauth_access_token'`）：
`opts.model` 来自主循环，始终是 Claude 模型名，必须忽略。优先级：
```typescript
const model = config?.model ?? process.env.ANTHROPIC_MODEL ?? 'openai/gpt-5.4'
```
- `config?.model` — 来自 `~/.codex/config.toml` 的 `model` 字段（如 `gpt-5.4`）
- `ANTHROPIC_MODEL` 环境变量 — 手动覆盖
- `'openai/gpt-5.4'` — 硬编码默认值

**API Key 模式**：保留原始优先级链：
```typescript
const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? config?.model ?? 'gpt-4o'
```

### OAuth Mode Base URL Selection

OAuth 模式（ChatGPT 账号授权）通常需要通过 ChatGPT 专用代理地址访问，而非直接访问 `api.openai.com`。

**OAuth 模式 URL 优先级**：
```typescript
const baseUrl =
  process.env.OPENAI_BASE_URL ??
  config?.baseUrl ??              // config.toml 的 openai_base_url
  config?.chatgptBaseUrl ??       // config.toml 的 chatgpt_base_url（仅 OAuth 模式）
  'https://api.openai.com/v1'
```

**API Key 模式 URL 优先级**（不使用 `chatgpt_base_url`）：
```typescript
const baseUrl =
  process.env.OPENAI_BASE_URL ??
  config?.baseUrl ??
  'https://api.openai.com/v1'
```

`chatgpt_base_url` 在 `~/.codex/config.toml` 中配置，是 Codex CLI 原生支持的 ChatGPT 代理地址字段。

### Token Estimation (`src/services/tokenEstimation.ts`)

Codex 模式使用本地结构化估算替代 API 调用（adapter 不实现 `countTokens()`）：

```typescript
if (getAPIProvider() === 'codex') {
  return estimateTokensLocally(messages, tools)
}
```

`estimateTokensLocally()` 按内容类型分别估算：
- **text/thinking**: `bytes / 4`（英文文本平均 4 bytes/token）
- **tool_use/JSON**: `bytes / 2`（结构化 JSON 更密集）
- **image**: 固定 `2000` tokens
- **per-message overhead**: `4` tokens（role + separators）
- **per-tool definition overhead**: `10` tokens（name + description + schema）

相比旧的 `return null`（由各调用方独立回退到 `content.length / 4`），结构化估算能更准确地处理混合内容消息。

### System Prompt Model Identity (`src/constants/prompts.ts`)

Codex 模式下，系统提示词中的模型身份使用实际 OpenAI 模型名，而非 Claude 模型名：

```typescript
} else if (getAPIProvider() === 'codex') {
  const { loadCodexConfig } = await import('../services/providers/impls/codex/auth.js')
  const codexConfig = loadCodexConfig()
  const codexModel = codexConfig?.model ?? process.env.ANTHROPIC_MODEL ?? 'gpt-4o'
  modelDescription = `You are powered by the model ${codexModel}, running inside Claude Code (a coding CLI tool).`
}
```

此逻辑在 `computeEnvInfo()` 和 `computeSimpleEnvInfo()` 两处都有实现。模型名优先级：
1. `~/.codex/config.toml` 的 `model` 字段
2. `ANTHROPIC_MODEL` 环境变量
3. 默认 `gpt-4o`

## Common Tasks

### Adding a new protocol adapter (e.g., Google Gemini API)

1. Create `src/services/providers/impls/gemini/` directory mirroring the codex structure
2. Implement `ResponseTranslator` for the target protocol's event format (hardest part)
3. **Ensure adapter throws `APIError` instances** (Layer 3 — don't skip this!)
4. Set a sensible default model name (prevent Claude model name leakage)
5. Decide tool translation based on the target API. **Codex/OpenAI 当前策略是不做工具过滤**，但其他 adapter 不应机械套用。
6. Decide unsupported request params based on the target API. **Codex/OpenAI 当前不会发送 `temperature/top_p`**，但这同样不是所有协议的通用规则。
7. Handle all terminal events: `completed`, `incomplete`, `failed`, `cancelled`
8. Register: add to `bootstrap.ts`, extend `APIProvider` type, add env var detection
9. Add capability preset in `presets.ts` + model context window mapping

### Extending the Codex adapter for a new OpenAI feature

1. Add type to `types.ts` (request field or SSE event type)
2. Handle in `requestTranslator.ts` (outbound) or `responseTranslator.ts` (inbound)
3. If new SSE event: add to `EVENT_MAP`, add state transition, implement handler
4. Test with live API: `CLAUDE_CODE_USE_CODEX=1 bun -e "..."`

### Adding a new OpenAI model

1. Add context window to `OPENAI_MODEL_CONTEXT` in `codex/index.ts`
2. Add pricing to `OPENAI_MODEL_COSTS` in `modelCost.ts`
3. Done — `probeCapabilities` and `getModelCosts` auto-pick up the new model

### Fixing a protocol translation bug

1. Enable debug: `CLAUDE_CODE_DEBUG=1`
2. Check the `[codex-adapter]` and `[codex-metrics]` log lines
3. Identify: is the issue in request translation (wrong params sent) or response translation (events misinterpreted)?
4. Check state machine: `translator.state` shows current FSM state
5. Write a minimal reproducer using `ResponseTranslator` directly

## Protocol Translation Reference

### Event Sequence Invariants

claude.ts REQUIRES this exact event ordering:

```
message_start                              ← exactly once, first event
  content_block_start(index=0)             ← per content block
    content_block_delta(index=0)*          ← zero or more deltas
  content_block_stop(index=0)              ← closes the block
  content_block_start(index=1)             ← next block (text, tool_use, or thinking)
    content_block_delta(index=1)*
  content_block_stop(index=1)
message_delta                              ← exactly once, carries stop_reason + usage
message_stop                               ← exactly once, terminal event
```

Violating this sequence causes: RangeError ("Content block not found"), missing tool calls, or infinite hangs.

### Terminal Event Types

| OpenAI event | Anthropic stop_reason | Notes |
|-------------|----------------------|-------|
| `response.completed` + status:completed | `end_turn` or `tool_use` | Normal completion |
| `response.completed` + status:incomplete | `max_tokens` | Truncated by token limit |
| `response.incomplete` | `max_tokens` | Independent incomplete event (distinct from above) |
| `response.failed` | `end_turn` + error text block + error event | 注入 `[API Error: code] msg` 文本块，让上游可见 |

**`response.incomplete` handling**: If received before `response.created` (Init state), the translator emits a synthetic `message_start` first, then `message_delta(max_tokens)` → `message_stop`.

### Stop Reason Mapping

| Condition | Anthropic stop_reason |
|-----------|----------------------|
| Response has function_call items | `tool_use` |
| Response completed normally | `end_turn` |
| Response incomplete (truncated) | `max_tokens` |

### Content Block Type Mapping

| Source content | Anthropic block type | Required delta type |
|---------------|---------------------|-------------------|
| Text output | `text` | `text_delta` |
| Tool/function call | `tool_use` | `input_json_delta` |
| Reasoning/thinking | `thinking` | `thinking_delta` |

### Error Code Mapping (translateError)

| HTTP Status | StandardApiError code | Retryable | Notes |
|------------|----------------------|-----------|-------|
| 401/403 | `auth` | No | Triggers credential refresh |
| 402 | `quota_exceeded` | No | Triggers backup API switch |
| 429 + quota keywords | `quota_exceeded` | No | Body heuristic: `quota`, `exceeded`, `billing`, `insufficient_quota` |
| 429 (other) | `rate_limit` | Yes | Normal rate limiting |
| 500/502/503 | `server` | Yes | OpenAI/Codex overload commonly surfaces as 503 |
| 529 | `overloaded` | Yes | Anthropic-specific overload code |
| 429 (non-quota) in Codex path | `rate_limit` | Yes | Can also be treated as fallback-worthy overload by outer `withRetry` |
| 400 + context_length | `context_length` | No | |

## Rules

- Never modify `claude.ts` or `withRetry.ts` for protocol-specific behavior. All translation happens inside the adapter.
- Preserve the existing system prompt main structure. Adapter/request translation may map provider-specific fields, but should not casually delete or rewrite the core system prompt semantics.
- Usage translation must preserve Anthropic semantics for downstream consumers: if the target API reports cached prompt tokens inside `input_tokens`, subtract them before populating `cache_read_input_tokens`.
- Preserve non-standard but valuable usage extensions when available (for Codex/OpenAI, `reasoning_output_tokens` can be forwarded as an extra field instead of being dropped).
- `thinking.type === 'adaptive'` must not be silently dropped. Map it to a sensible target reasoning default rather than treating it as unsupported.
- Prefer a single retry authority. In the Codex path, outer `withRetry` owns retry/fallback behavior; adapter-level retries should default to off.
- **Adapter errors MUST be `APIError` instances.** This is the single most critical rule. Plain `Error` objects bypass withRetry's entire retry infrastructure.
- **`response.headers` MUST be a `Headers` instance**, not a plain object. `withRetry` calls `.get('retry-after')`.
- The adapter MUST return objects with a `.controller` property on the stream. claude.ts uses `'controller' in e.value` to distinguish streams from error messages.
- `ResponseTranslator` must be stateful (one instance per request). It tracks block indices across events. Never share instances.
- Non-streaming responses must emit the full synthetic event sequence, not just `message_start`. claude.ts processes content blocks via `content_block_start/delta/stop` events.
- Keep `store: false` in OpenAI Responses API requests — ChatGPT proxy endpoints require it.
- Do not send `max_output_tokens` by default — some proxies reject it. Use `CODEX_ENABLE_MAX_OUTPUT_TOKENS=1` env var to opt-in（`CODEX_SKIP_MAX_TOKENS=1` 可进一步强制禁用）。
- **Codex/OpenAI 当前策略是不做工具过滤** — 在这条适配链里，所有 Anthropic 工具（包括服务端工具类型如 `computer_20241022`、`text_editor_*`）都直接传递给 OpenAI 模型，不做任何过滤；但这不是所有新 adapter 的通用铁律，其他协议应按目标 API 能力决定。
- **不发送 temperature 和 top_p 的 Anthropic 默认值** — 仅当值不为 `1`（Anthropic 默认）时才透传，避免兼容端点报 unsupported parameter。reasoning 模式下完全不发送（OpenAI API 限制）。
- Provider MUST declare a default model name — otherwise `claude-sonnet-4-6` leaks to the target API.
- **OAuth mode MUST ignore `opts.model`** — 主循环传入的 Claude 模型名不适用于 OpenAI API，应使用 config.toml 中的 `model` 字段或默认 `openai/gpt-5.4`。
- **OAuth mode MUST fall back to `chatgpt_base_url`** — config.toml 中的 `chatgpt_base_url` 是 ChatGPT 代理地址，OAuth 模式在 `openai_base_url` 未配置时应使用它。
- `getAllModelBetas()` in `betas.ts` must have an early return for your provider (like codex/thirdParty) to prevent Anthropic beta headers from being generated.
- Token counting (`countTokensWithAPI`) must be short-circuited for non-Anthropic providers — the adapter doesn't implement `countTokens()`，应走本地估算路径而不是简单返回 null。

## Validation

- Module import chain: `bun -e "import { codexProvider } from './src/services/providers/impls/codex/index.ts'; console.log(codexProvider.id, codexProvider.detect())"`
- Translator unit test:
```bash
bun -e "
import { translateRequest } from './src/services/providers/impls/codex/translator/requestTranslator.ts'
const r = translateRequest({ model:'test', messages:[{role:'user',content:'hi'}], system:'sys', max_tokens:100, stream:true, thinking: { type: 'adaptive' } }, 'o3')
console.log(JSON.stringify(r, null, 2))
// Expected: reasoning = { effort: 'low', summary: 'auto' }（无 tools 时 adaptive → low）
// 带 tools 时 adaptive → medium
"
```
- Response.incomplete test:
```bash
bun -e "
import { ResponseTranslator } from './src/services/providers/impls/codex/translator/responseTranslator.ts'
const t = new ResponseTranslator()
const events = t.translate({ type: 'response.incomplete', response: { id: 'test', object: 'response', status: 'incomplete', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
console.log(events.map(e => e.type))
// Expected: ['message_start', 'message_delta', 'message_stop']
"
```
- Usage normalization test:
```bash
bun -e "
import { ResponseTranslator } from './src/services/providers/impls/codex/translator/responseTranslator.ts'
const t = new ResponseTranslator()
t.translate({ type: 'response.created', response: { id: 'r1', object: 'response', model: 'o3', status: 'in_progress', output: [] } as any })
t.translate({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } as any })
t.translate({ type: 'response.output_item.done', output_index: 0, item: { type: 'message' } as any })
const events = t.translate({
  type: 'response.completed',
  response: {
    id: 'r1', object: 'response', model: 'o3', status: 'completed', output: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      input_tokens_details: { cached_tokens: 300 },
      output_tokens_details: { reasoning_tokens: 50 },
    },
  } as any,
})
console.log(JSON.stringify(events.find(e => e.type === 'message_delta'), null, 2))
// Expected usage: input_tokens=700, cache_read_input_tokens=300, reasoning_output_tokens=50
"
```
- APIError compatibility:
```bash
bun -e "
import { APIError } from '@anthropic-ai/sdk'
const h = new Headers({ 'retry-after': '5' })
const err = new APIError(429, { message: 'rate limited' }, 'test', h)
console.log('instanceof:', err instanceof APIError, 'headers.get:', err.headers?.get?.('retry-after'))
"
```
- Live E2E test: `CLAUDE_CODE_USE_CODEX=1 bun -e "..."` (see adapter.ts for pattern)
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- **Throwing plain `Error` with monkey-patched `.status`** — withRetry needs `instanceof APIError`, not duck typing. This is the #1 cause of "adapter works but never retries".
- **Using plain object for error `.headers`** — withRetry calls `.get()` which doesn't exist on plain objects.
- Adding `if (provider === 'codex')` branches in claude.ts — all protocol differences must be absorbed by the adapter.
- Creating a second streaming loop for the new protocol — reuse the existing `for await (const part of stream)` loop in claude.ts.
- Sharing `ResponseTranslator` instances across requests — block index state will corrupt.
- Returning raw target API events without translation — claude.ts will crash on unrecognized event types.
- Hardcoding API base URLs in the adapter — use config/env vars. The same adapter should work with proxies and direct endpoints.
- Skipping the `.withResponse()` chain compatibility — claude.ts destructures `{ data, response, request_id }` from it.
- **对 Codex/OpenAI 机械过滤工具** — 当前这条适配链不应排除 Anthropic 工具类型；但为其他新协议做适配时，也不要机械套用“不过滤”规则，需按目标 API 能力判断。
- **无条件透传 Anthropic 默认 temperature=1 / top_p=1** — 兼容端点可能报 unsupported parameter 400 错误，应过滤掉默认值只透传显式非默认设置。reasoning 模式下必须完全不发送。
- Not handling `response.incomplete` as a terminal event — stream hangs without `message_stop`.
- Not setting a default model name — `claude-sonnet-4-6` leaks to the target API.
- **OAuth mode using `opts.model` directly** — 主循环传入的是 Claude 模型名（如 `claude-opus-4-6`），直接发到 OpenAI 会返回 400。OAuth 模式必须忽略 `opts.model`，使用 config.toml 的 `model` 或默认 `openai/gpt-5.4`。
- **OAuth mode 忽略 `chatgpt_base_url`** — 导致请求发到 `api.openai.com`（国内不可达）。OAuth 模式在 `openai_base_url` 未配时必须回退到 `chatgpt_base_url`。
- **Usage 直接透传上游 token 语义** — 如果上游 `input_tokens` 已包含 cached tokens，而适配层又额外填充 `cache_read_input_tokens`，Claude Code 下游会双重计数。
- **Adapter 内外双重重试默认同时开启** — 会把单次失败放大成多轮重复请求；默认应由外层 `withRetry` 统一负责。
