---
name: "external-auth-bridge-reuse"
description: "Reuse the external auth bridge pattern (read-only credential file parsing, JWT expiration tracking, OAuth token refresh with Promise dedup, multi-source priority chain) when integrating credentials from external CLI tools like Codex, gcloud, aws-cli."
---

# External Auth Bridge Reuse

Use this skill when integrating credentials from an external CLI tool's auth files (e.g., Codex `~/.codex/auth.json`, gcloud `~/.config/gcloud/`, aws `~/.aws/credentials`), implementing token refresh with dedup, or building multi-source credential priority chains.

## Architecture Overview

```
Environment Variables (highest priority)
       ↓ fallthrough
Memory Cache (TTL-guarded)
       ↓ cache miss or expired
Auth File on Disk (read-only, never write back)
       ↓ if OAuth token near expiry
Token Refresh (Promise dedup, exponential backoff)
       ↓
Cached Credentials (updated in memory only)
```

**Core insight**: Read the external tool's native auth file but NEVER write back to it. This avoids race conditions with the external CLI (e.g., Codex CLI refreshing tokens concurrently). All refreshed tokens are cached in memory only.

## Reference Implementation

`src/services/providers/impls/codex/auth.ts` — complete working example of the pattern.

## Reuse First

### Multi-Source Credential Priority Chain

The canonical priority order (adapt names, keep the pattern):

```typescript
// 1. Explicit env var (highest — user override)
const envKey = process.env.TOOL_API_KEY ?? process.env.FALLBACK_API_KEY
if (envKey) return { token: envKey, tokenType: 'api_key' }

// 2. Memory cache (TTL check)
if (cached && (now - lastReadTime) < CACHE_TTL_MS) {
  // Check OAuth expiry, refresh if needed
  return cached
}

// 3. Disk file (lowest — shared with external tool)
const auth = readAuthFile()
// Parse, cache, return
```

### JWT Expiration Parsing (without verification)

```typescript
function parseJwtExpiration(jwt: string): number | undefined {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const decoded = Buffer.from(payload, 'base64').toString('utf-8')
  const claims = JSON.parse(decoded)
  return typeof claims.exp === 'number' ? claims.exp : undefined
}
```

No signature verification — we trust the token from the local auth file. Only used for expiry-based refresh scheduling.

### Promise Dedup for Token Refresh

Prevents N concurrent requests from triggering N refresh calls:

```typescript
let pendingRefreshPromise: Promise<Credentials | null> | null = null

async function refreshTokenOnce(creds: Credentials): Promise<Credentials | null> {
  if (pendingRefreshPromise) return pendingRefreshPromise
  pendingRefreshPromise = doRefresh(creds).finally(() => {
    pendingRefreshPromise = null
  })
  return pendingRefreshPromise
}
```

### Exponential Backoff with Jitter

```
Retry 1: 1s + random(0-250ms)
Retry 2: 2s + random(0-500ms)
Retry 3: 4s + random(0-1000ms)
Cap: 30s max delay
```

4xx errors (invalid credentials) → stop immediately, don't retry.
5xx errors (server issue) → retry with backoff.

### Cache Invalidation

```typescript
export function clearCredentialsCache(): void {
  cachedCredentials = null
  lastAuthFileReadTime = 0
}
```

Called by `provider.refreshAuth()` when the retry engine detects 401/403. This forces re-reading the disk file on next request.

## Common Tasks

### Adding credentials from a new external tool

1. Create `src/services/providers/impls/<tool>/auth.ts` mirroring the codex auth structure
2. Define the file format interface (e.g., `ToolAuthJson`)
3. Implement the priority chain: env var → cache → disk file
4. If the tool uses OAuth/JWT: add expiry parsing + refresh with Promise dedup
5. Export: `loadCredentials()`, `clearCredentialsCache()`, credential type
6. Wire `clearCredentialsCache()` into `provider.refreshAuth()` method

### Adding a new auth mode to an existing tool

1. Extend the auth file interface with the new mode discriminant
2. Add parsing branch in `loadCredentials()` for the new mode
3. If the new mode has token refresh, wire it through `refreshTokenOnce()`
4. Test: modify `~/.tool/auth.json` manually, verify Claude Code picks it up within TTL

### Debugging auth failures

1. Check env vars first: `echo $TOOL_API_KEY` — env has highest priority
2. Check file exists and is readable: `cat ~/.tool/auth.json`
3. If OAuth: decode JWT manually `echo <token> | base64 -d` — check `exp` claim
4. Check cache TTL: credentials refresh from disk every 30s by default
5. Enable debug: `CLAUDE_CODE_DEBUG=1` and look for `[tool-auth]` log lines

## Rules

- **Never write back** to the external tool's auth file. Memory-only caching.
- **Promise dedup** is mandatory for OAuth refresh. Without it, 10 concurrent requests = 10 refresh calls = 9 wasted tokens + potential rate limiting.
- **Pre-expire by 60 seconds**. Don't wait for actual expiry — refresh proactively.
- **4xx = stop, 5xx = retry**. Client errors (invalid refresh_token) should not be retried.
- **Cache TTL on disk reads** (default 30s). Reading the file on every request is wasteful and causes TOCTOU issues.
- Credential types must be explicit (`api_key` vs `oauth_access_token`) — the adapter needs to know whether to send Account-ID headers.

## Auth File Formats Reference

### Codex (~/.codex/auth.json)
```json
{
  "auth_mode": "apiKey",
  "OPENAI_API_KEY": "sk-..."
}
// or
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "account_id": "..."
  }
}
```

### Codex (~/.codex/config.toml) — OAuth 相关字段
```toml
model = "gpt-5.4"                                            # OAuth 模式使用此模型名
chatgpt_base_url = "http://proxy:8002/api/v1/proxy/chatgpt"  # OAuth 模式 API 代理地址
# openai_base_url = "https://api.openai.com/v1"              # API Key 模式优先使用此地址
```

**OAuth 模式特殊行为**（`auth_mode: "chatgpt"` 或 `"chatgptAuthTokens"`）：
- **模型名**：忽略主循环传入的 Claude 模型名，使用 config.toml 的 `model` 字段或默认 `openai/gpt-5.4`
- **API 地址**：优先使用 `openai_base_url`，未配时回退到 `chatgpt_base_url`（ChatGPT 代理专用地址）
- **请求头**：自动附加 `ChatGPT-Account-ID` header（从 `tokens.account_id` 获取）

### Pattern for new tools
```json
{
  "auth_type": "api_key | oauth | service_account",
  "credentials": { ... },
  "metadata": { "last_refresh": "ISO8601", "source": "cli_login" }
}
```

## Anti-Patterns

- Writing refreshed tokens back to the auth file — races with the external CLI.
- Sharing `pendingRefreshPromise` across different credential sources — each source needs its own dedup.
- Retrying on 401/403 with the same credentials — clear cache first, re-read from disk.
- Synchronous file reads in hot path without TTL caching — amplified by retry loops.
- Hardcoding auth file paths without `$TOOL_HOME` env var override.
- Parsing JWT claims for authorization decisions — we only use `exp` for refresh scheduling.
