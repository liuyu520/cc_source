# Codex OpenAI Responses API Provider Design

## Summary

Add OpenAI Responses API support to Claude Code via a new `codex` provider, enabling use of any OpenAI-compatible LLM (GPT-4o, o3, Ollama, LMStudio, etc.) by reading Codex's native `~/.codex/auth.json` for authentication. The adapter sits in the Provider plugin layer and masquerades as an Anthropic SDK client, translating protocols transparently so all existing code (claude.ts, withRetry.ts, queryModel) remains untouched.

## Architecture

### Provider Layer Protocol Adapter

```
Claude Code internal flow (unchanged)
       |
  anthropic.beta.messages.create(params)
       |
  CodexAnthropicAdapter (new)
       |-- Request: Anthropic params -> OpenAI Responses API request
       |-- HTTP/SSE: POST /v1/responses (streaming)
       |-- Response: OpenAI SSE events -> BetaRawMessageStreamEvent stream
```

### New Files

```
src/services/providers/impls/codex/
  index.ts                  -- codexProvider: LLMProvider implementation
  adapter.ts                -- CodexAnthropicAdapter: fake Anthropic SDK client
  translator/
    requestTranslator.ts    -- Anthropic Messages -> OpenAI Responses request
    responseTranslator.ts   -- OpenAI SSE events -> BetaRawMessageStreamEvent stream
    toolTranslator.ts       -- Anthropic tool schemas -> OpenAI function definitions
    messageTranslator.ts    -- Anthropic messages[] -> OpenAI input[] (ResponseItem)
  auth.ts                   -- Read ~/.codex/auth.json + token refresh
  streaming.ts              -- SSE parsing + Stream wrapper
  types.ts                  -- OpenAI Responses API type definitions
```

### Modified Files

```
src/services/providers/bootstrap.ts   -- Register codexProvider (before thirdParty)
src/utils/model/providers.ts          -- APIProvider type adds 'codex', detect logic
src/utils/model/configs.ts            -- ModelConfig adds codex mapping (optional)
src/services/providers/presets.ts     -- Add OpenAI API domain capability preset
```

## Authentication

### Source Priority

1. `CODEX_API_KEY` env var (highest)
2. `OPENAI_API_KEY` env var
3. `~/.codex/auth.json` file
   - `auth_mode = "apiKey"` -> read `OPENAI_API_KEY` field
   - `auth_mode = "chatgpt"` -> read `tokens.access_token` (JWT)
4. `~/.codex/config.toml` -> `model_providers[id].env_key`

### Token Refresh

For `auth_mode === "chatgpt"`, parse JWT `exp` field and refresh via `https://auth.openai.com/oauth/token` with `refresh_token` before expiry. Keep tokens in memory only (no write-back to auth.json).

## Protocol Translation

### Request: Anthropic -> OpenAI Responses

| Anthropic | OpenAI Responses |
|-----------|-----------------|
| `model` | `model` |
| `system: [{type:"text", text}]` | `instructions: text` (joined) |
| `messages: Message[]` | `input: ResponseItem[]` |
| `tools: ToolDefinition[]` | `tools: FunctionDefinition[]` |
| `max_tokens` | dropped |
| `stream: true` | `stream: true` |
| `thinking.budget_tokens` | `reasoning.effort` (low/medium/high mapping) |
| `betas` | dropped |
| `cache_control` | dropped |

### Messages: Anthropic -> OpenAI ResponseItem

| Anthropic | OpenAI |
|-----------|--------|
| `{role:"user", content:"text"}` | `{type:"message", role:"user", content:[{type:"input_text", text}]}` |
| `{role:"assistant", content:[{type:"text"}]}` | `{type:"message", role:"assistant", content:[{type:"output_text", text}]}` |
| `{type:"tool_use", id, name, input}` | `{type:"function_call", call_id:id, name, arguments:JSON.stringify(input)}` |
| `{type:"tool_result", tool_use_id, content}` | `{type:"function_call_output", call_id:tool_use_id, output:content}` |
| `{type:"image", source:{type:"base64",...}}` | `{type:"input_image", image_url:"data:...;base64,..."}` |
| `{type:"thinking", thinking, signature}` | `{type:"reasoning", summary:[{type:"summary_text", text:thinking}]}` |

### Tools: Anthropic -> OpenAI Function

| Anthropic | OpenAI |
|-----------|--------|
| `name` | `name` |
| `description` | `description` |
| `input_schema` | `parameters` (identical structure) |

### Streaming: OpenAI SSE -> Anthropic BetaRawMessageStreamEvent

| OpenAI Event | Anthropic Event |
|-------------|----------------|
| `response.created` | `message_start` |
| `response.output_item.added` (message) | `content_block_start` (text) |
| `response.output_item.added` (function_call) | `content_block_start` (tool_use) |
| `response.output_text_delta` | `content_block_delta` (text_delta) |
| `response.function_call_arguments.delta` | `content_block_delta` (input_json_delta) |
| `response.output_item.done` | `content_block_stop` |
| `response.reasoning_summary_text.delta` | `content_block_start` + `content_block_delta` (thinking) |
| `response.completed` | `message_delta` (stop_reason) + `message_stop` |

### Stop Reason Mapping

- OpenAI `status: "completed"` with no function_calls -> `end_turn`
- OpenAI response has function_call items -> `tool_use`
- OpenAI `status: "incomplete"` -> `max_tokens`

## SDK Adapter (adapter.ts)

The `CodexAnthropicAdapter` class mimics the Anthropic SDK interface:

```typescript
class CodexAnthropicAdapter {
  beta = {
    messages: {
      create: (params, options) => {
        const promise = this._doCreate(params, options)
        return Object.assign(promise, {
          withResponse: () => this._doCreateWithResponse(params, options)
        })
      }
    }
  }
}
```

`_doCreateWithResponse()` returns `{ data: Stream, response: Response, request_id: string }`.

## Configuration

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_CODE_USE_CODEX` | Enable codex provider | `0` |
| `OPENAI_BASE_URL` | Override API endpoint | from `~/.codex/config.toml` |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | Override API key | from `~/.codex/auth.json` |
| `ANTHROPIC_MODEL` | Model name override | from `~/.codex/config.toml` |

### Capability Preset

```
api.openai.com: supportsToolUse, supportsStreaming, supportsVision, supportsThinking
```

CapabilityFilter removes: `cache_control`, `betas`, Anthropic-specific `metadata`.

## Error Translation

| HTTP Status | StandardErrorCode |
|------------|-------------------|
| 401, 403 | `auth` |
| 429 | `rate_limit` |
| 500, 502, 503 | `server` |
| 529 | `overloaded` |
| ECONNREFUSED/ETIMEDOUT | `network` |

## Provider Registration

Priority: Bedrock > Vertex > Foundry > **Codex** > thirdParty > firstParty

Detection: `CLAUDE_CODE_USE_CODEX=1` environment variable (explicit opt-in only).
