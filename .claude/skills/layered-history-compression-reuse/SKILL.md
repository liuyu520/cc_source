---
name: "layered-history-compression-reuse"
description: "Reuse the snipCompact three-tier age-based compression pattern (recent verbatim / middle truncated / old elided), toolPairSanitizer defensive repair, env var gating, and SnipResult return contract when adding new compression tiers, extending content reduction strategies, or building pre-compact lightweight compression for third-party APIs."
---

# Layered History Compression Reuse

Use this skill when adding new compression tiers or content reduction strategies to the conversation history, extending the snipCompact layered compression, implementing pre-compact lightweight compression for third-party APIs, or working with tool_use/tool_result pair safety.

## Architecture Overview

```
query.ts message processing pipeline (line ~497):
  messages
    ↓
  snipCompactIfNeeded()       ← lightweight layered compression (this skill)
    ↓
  microcompactMessages()      ← time-based tool_result cleanup
    ↓
  autoCompactIfNeeded()       ← heavy full-context LLM summarization
```

snipCompact runs BEFORE microcompact and autoCompact — it's the cheapest (zero LLM calls) and most granular (per-block content reduction). It operates on the live message window in-place, reducing tokens without destroying message structure.

```
Three Tiers (counted from end of conversation):

  ┌─────────────────────────────────────────────────────┐
  │ age ≤ 6 (RECENT_KEEP)  ≈ last 3 turns              │
  │ → VERBATIM: no modification                         │
  ├─────────────────────────────────────────────────────┤
  │ age 7-20 (middle zone)  ≈ turns 4-10               │
  │ → TRUNCATE: tool_result content → head 200 chars    │
  │   + "[+N chars truncated by snipCompact]"           │
  │   tool_use input: untouched                         │
  ├─────────────────────────────────────────────────────┤
  │ age > 20 (OLD_BOUNDARY)  ≈ turns 10+               │
  │ → ELIDE: tool_result → "[old tool_result elided]"   │
  │   tool_use input → {_elided: "{...}", _origChars: N}│
  │   (skipped if input < 80 chars — would inflate)     │
  └─────────────────────────────────────────────────────┘

  ↓ after all tiers applied
  toolPairSanitizer — defensive repair of orphaned pairs
```

## Reuse First

- `src/services/compact/snipCompact.ts` — Full implementation (332 lines)
  Main entry: `snipCompactIfNeeded<T>(messages, options?)` returns `SnipResult<T>`. Three-tier age-based compression. Handles string content, array-of-blocks content, and non-content messages (pass-through). Uses `toolPairSanitizer` defensively after compression.

- `src/services/compact/snipCompact.ts:116` — `truncateMiddleResult(content)`
  Handles both string and array-of-text-blocks content shapes. Preserves non-text blocks (images, etc.) untouched. Reuse when adding new content truncation.

- `src/services/compact/snipCompact.ts:157` — `elideOldResult(block)` / `:172` — `elideOldToolUse(block)`
  Full elision for old content. Preserves `tool_use_id` and `is_error` for API pair validity. The tool_use elision has a size guard (< 80 chars → skip) to avoid inflating small inputs. Reuse when adding more aggressive elision tiers.

- `src/services/compact/snipCompact.ts:187` — `compressMessage(msg, age)`
  Per-message dispatcher. Determines tier by age, iterates content blocks, applies appropriate compression. Reuse this dispatch pattern when adding new block-level transformations.

- `src/services/compact/toolPairSanitizer.ts` — `sanitizeToolPairs(messages)`
  Defensive repair: ensures every tool_use has a matching tool_result and vice versa. Inserts stubs for orphaned pairs. MUST be called after any operation that might break pairs (even if "theoretically impossible"). Returns `{ messages, changes }` where `changes` tracks what was repaired.

- `src/services/compact/snipCompact.ts:69` — `readEnvFlag(name)` / `:76` — `isLayeredEnabled()`
  Shared env var gating pattern: `off → force OFF`, `on → force ON`, `unset → auto per provider`. Copy this pattern for new feature gates.

## SnipResult Contract

```typescript
type SnipResult<T> = {
  messages: T          // same type as input (generic passthrough)
  changed: boolean     // true if any modification was made
  tokensFreed: number  // estimated tokens freed (chars / 4)
  boundaryMessage?: unknown  // unused by snipCompact, reserved for compat
}
```

Callers (query.ts:497, QueryEngine.ts:1281) rely on this exact shape. Any new compression function plugged into the pipeline MUST return this type.

## Content Shape Handling

Messages in the pipeline have content in various shapes:

```typescript
// Shape 1: tool_result with string content
{ type: 'tool_result', tool_use_id: '...', content: 'long string here...' }

// Shape 2: tool_result with array of text blocks
{ type: 'tool_result', tool_use_id: '...', content: [
  { type: 'text', text: 'long text...' },
  { type: 'image', source: { ... } }  // preserved untouched
] }

// Shape 3: tool_use with input object
{ type: 'tool_use', id: '...', name: 'Bash', input: { command: '...' } }

// Shape 4: text block (not compressed by snipCompact)
{ type: 'text', text: '...' }
```

`truncateMiddleResult` handles shapes 1 and 2 correctly. `elideOldResult` replaces any shape with string stub. `elideOldToolUse` replaces shape 3's `input` with elision marker. Text blocks (shape 4) are always passed through — user/assistant text is never compressed by snipCompact (that's autoCompact's job).

## Common Tasks

### Adding a fourth compression tier

1. Define new boundary constant in snipCompact.ts:
```typescript
const VERY_OLD_BOUNDARY = 40  // messages older than 40 from end
```

2. Add compression function:
```typescript
function compressVeryOld(block: ContentBlock): { block: ContentBlock; freed: number } {
  // e.g., remove text blocks entirely, keep only tool pairs
}
```

3. Extend `compressMessage()` dispatch:
```typescript
const isVeryOld = age > VERY_OLD_BOUNDARY
const isOld = !isVeryOld && age > OLD_BOUNDARY
// ... add isVeryOld handling
```

4. `toolPairSanitizer` call remains at the end — no change needed.

### Adding a new block type to compression

1. Add handler in `compressMessage()`:
```typescript
if (blk.type === 'my_new_type' && isOld) {
  const r = elideMyNewType(blk)
  nextContent.push(r.block)
  totalFreed += r.freed
}
```

2. Ensure the block's pairing semantics are preserved (if it's a paired type like tool_use/tool_result).

### Debugging compression behavior

1. `CLAUDE_CODE_DEBUG=1` — shows `[snipCompact] layered compress: N msgs, ~X chars freed` log
2. `CLAUDE_CODE_SNIP_LAYERED=0` — disable layered compression to isolate issues
3. `CLAUDE_CODE_SNIP_SANITIZE_SHADOW=1` — run sanitizer in observe-only mode (logs orphaned pairs without fixing)

### Plugging a new compression function into the pipeline

1. Follow the `SnipResult<T>` return contract
2. Insert at the correct position in query.ts pipeline: `snip → microcompact → autoCompact`
3. If your function modifies tool blocks, call `sanitizeToolPairs()` defensively after
4. Return `{ messages, changed: false, tokensFreed: 0 }` for no-op cases (short-circuit)

## Tier Boundary Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `RECENT_KEEP` | 6 | Messages from end preserved verbatim (~3 turns) |
| `OLD_BOUNDARY` | 20 | Messages older than this get full elision (~10 turns) |
| `HEAD_KEEP_CHARS` | 200 | Middle-tier truncation head size |
| Min messages | RECENT_KEEP + 4 = 10 | Below this, no compression (not worth it) |

## Integration Points

| Component | File | Key line |
|-----------|------|----------|
| Main entry | `snipCompact.ts` | :230 (`snipCompactIfNeeded`) |
| Middle-tier truncation | `snipCompact.ts` | :116 (`truncateMiddleResult`) |
| Old-tier result elision | `snipCompact.ts` | :157 (`elideOldResult`) |
| Old-tier tool_use elision | `snipCompact.ts` | :172 (`elideOldToolUse`) |
| Per-message dispatch | `snipCompact.ts` | :187 (`compressMessage`) |
| Feature gate | `snipCompact.ts` | :76 (`isLayeredEnabled`) |
| Pair sanitizer | `toolPairSanitizer.ts` | `sanitizeToolPairs` |
| Pipeline call (query) | `query.ts` | :497 |
| Pipeline call (QueryEngine) | `QueryEngine.ts` | :1281 |
| Compat stubs | `snipCompact.ts` | :309 (`isSnipMarkerMessage` etc.) |

## Rules

- Never remove message objects — only modify their content blocks. Removing messages breaks conversation structure and may orphan tool pairs.
- Always call `sanitizeToolPairs()` after any content modification, even if you "know" pairs can't break. It's idempotent and catches edge cases.
- Preserve `tool_use_id` and `is_error` on tool_result blocks — these are required for API validity.
- The 80-char guard on tool_use elision is intentional — replacing `{ command: "ls" }` with `{ _elided: "{...}", _originalChars: 12 }` would inflate the content.
- Return `SnipResult<T>` with the SAME generic type as input — callers depend on type passthrough.
- Compat stub exports (`isSnipMarkerMessage`, `isSnipRuntimeEnabled`, `SNIP_NUDGE_TEXT`, `shouldNudgeForSnips`) must be maintained — they're imported by `Message.tsx`, `messages.ts`, `attachments.ts` for the HISTORY_SNIP ant-only feature flag.
- Don't compress user/assistant text content — that's autoCompact's domain (LLM-summarized). snipCompact only touches tool_result and tool_use blocks.
- First-party API should NOT enable layered compression by default — prompt cache makes repeated content cheap. Force-on env var is for debugging.

## Validation

- Feature gate: `ANTHROPIC_BASE_URL=https://api.test.com ANTHROPIC_API_KEY=test bun -e "import { snipCompactIfNeeded } from './src/services/compact/snipCompact.ts'; console.log(snipCompactIfNeeded([]))"` — should return `{ messages: [], changed: false, tokensFreed: 0 }`.
- Three-tier test: Create 25+ mock messages with large tool_result content, run `snipCompactIfNeeded` with `force: true`, verify recent are untouched, middle are truncated, old are elided.
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Removing messages instead of compressing their content — breaks conversation structure and tool pair semantics.
- Compressing user/assistant text blocks — these carry semantic context that only an LLM can meaningfully summarize.
- Skipping `sanitizeToolPairs()` after modifying content blocks — "it can't break pairs" is always wrong in edge cases (concurrent modifications, nested content shapes).
- Creating a separate compression pipeline instead of extending snipCompact — the existing pipeline order (snip → micro → auto) is intentional and tested.
- Hardcoding provider checks instead of using `isLayeredEnabled()` — the env var override exists for a reason.
- Forgetting the size guard on tool_use elision — small inputs get inflated by the elision marker, wasting tokens instead of saving them.
