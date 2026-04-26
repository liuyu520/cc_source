# Conversation Rollback & Pre-Compact Snapshot Design

**Date:** 2026-04-11
**Status:** Draft
**Scope:** `/rollback` command + automatic pre-compact snapshot

## 1. Problem Statement

When Claude Code performs a **full compact**, all original messages are irreversibly replaced with a forked-agent-generated summary. Users cannot undo this operation, even if the compact summary loses important context or the user wants to explore a different direction from before the compact.

**Existing gaps:**
- `/branch` exists (copies transcript to new session) but doesn't solve undo — it creates a new session rather than restoring the current one
- `CompactOrchestrator` has `preserveAsEpisodic` in CompactPlan but no full message snapshot
- Micro compact and session memory compact are non-destructive (don't lose original content), so they don't need rollback

## 2. Solution Overview

Two components:

1. **Auto-snapshot**: Before every full compact, serialize the complete `messages` array to a snapshot file
2. **`/rollback` command**: Restore messages from the most recent snapshot, undoing the compact

```
User conversation (N messages)
         │
    full compact triggered
         │
    ┌────▼────────────────────┐
    │ savePreCompactSnapshot() │  ← NEW: serialize messages to {sessionId}.pre-compact-snapshot.jsonl
    └────┬────────────────────┘
         │
    compactConversation()        ← existing: summarize & replace messages
         │
         ▼
User types /rollback
         │
    ┌────▼────────────────────┐
    │ loadPreCompactSnapshot()  │  ← NEW: read snapshot file
    └────┬────────────────────┘
         │
    setMessages(() => snapshot)  ← existing: restore full conversation
         │
    deletePreCompactSnapshot()   ← NEW: cleanup consumed snapshot
```

## 3. Snapshot Module

**File:** `src/services/compact/snapshot.ts` (NEW)

### 3.1 API

```typescript
// 保存快照 — compact 前调用
export async function savePreCompactSnapshot(
  sessionId: string,
  messages: Message[],
): Promise<string>  // returns snapshot file path

// 加载快照 — /rollback 时调用
export async function loadPreCompactSnapshot(
  sessionId: string,
): Promise<Message[] | null>  // null = no snapshot exists

// 删除快照 — rollback 成功后清理
export async function deletePreCompactSnapshot(
  sessionId: string,
): Promise<void>

// 检查快照是否存在
export async function hasPreCompactSnapshot(
  sessionId: string,
): Promise<boolean>
```

### 3.2 Storage

- **Location:** Same directory as session JSONL files (resolved via `resolveSessionFilePath()` from `sessionStoragePortable.ts`, typically `~/.claude/projects/<sanitized-cwd>/{sessionId}.jsonl`)
- **Filename:** `{sessionId}.pre-compact-snapshot.jsonl`
- **Format:** One JSON object per line, matching existing session JSONL serialization (reuse `MessageWithMetadata` format from `sessionStoragePortable.ts`)
- **Lifecycle:**
  - Created: before each full compact
  - Consumed: by `/rollback`
  - Overwritten: by next compact (only latest snapshot retained)
  - Deleted: after successful rollback

### 3.3 Implementation Notes

- Reuse existing `MessageWithMetadata` serialization from `sessionStoragePortable.ts` for format consistency
- Resolve snapshot file path using the same session directory resolution as the main JSONL file (reuse `resolveSessionFilePath()` or equivalent)
- Write atomically: write to `.tmp` then rename, to avoid corrupt snapshot on crash during write

## 4. Compact Integration

**File:** `src/services/compact/compact.ts` (MODIFY)

**Insertion point:** `compactConversation()` (~line 397), after the `messages.length === 0` check, before any processing begins.

```typescript
// 自动快照：compact 前保存完整消息，供 /rollback 恢复
const sessionId = getSessionId()
if (sessionId) {
  try {
    await savePreCompactSnapshot(sessionId, messages)
  } catch (e) {
    // 快照失败不阻断 compact 流程 — best effort
    logForDebugging(`[Snapshot] Failed to save pre-compact snapshot: ${(e as Error).message}`)
  }
}
```

**Rules:**
- Snapshot is **best-effort** — failure does not block compact
- Only `compactConversation()` triggers snapshot — NOT micro compact (`microCompact.ts`) or session memory compact (`sessionMemoryCompact.ts`), because they don't destroy original messages
- Each compact overwrites the previous snapshot (single snapshot per session)

## 5. `/rollback` Command

**File:** `src/commands/rollback/rollback.ts` (NEW)

### 5.1 Command Spec

```typescript
export const spec = {
  name: 'rollback',
  description: 'Rollback conversation to the state before the last compact',
  isEnabled: true,
  isHidden: false,
  userFacing: true,
  argDescription: '',  // no arguments
}
```

### 5.2 Behavior

```typescript
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  // 1. Get current session ID
  // 2. Load snapshot — if null, inform user "no snapshot available"
  // 3. Restore: context.setMessages(() => snapshot)
  // 4. Cleanup: deletePreCompactSnapshot(sessionId)
  // 5. Report: "Rolled back to pre-compact state (N messages restored)."
}
```

### 5.3 Edge Cases

| Scenario | Behavior |
|----------|----------|
| No snapshot exists | Display: "No pre-compact snapshot available. A snapshot is created automatically before each full compact." |
| Repeated rollback | First rollback deletes snapshot; second shows "no snapshot" message |
| Multiple compacts | Each compact overwrites snapshot; rollback restores to state before most recent compact only |
| Rollback after /branch | Works normally — snapshot is per-session, branch creates new session |
| Snapshot file corrupted | Treat as "no snapshot" with error logged |

### 5.4 Registration

**File:** `src/commands.ts` (MODIFY)

Import and register `/rollback` in the command registry, following the existing pattern (alphabetical order in the import list).

## 6. Files Changed Summary

| Operation | File | Change |
|-----------|------|--------|
| NEW | `src/services/compact/snapshot.ts` | Snapshot save/load/delete/has |
| MODIFY | `src/services/compact/compact.ts` | Add `savePreCompactSnapshot()` call at `compactConversation()` entry |
| NEW | `src/commands/rollback/rollback.ts` | `/rollback` command implementation |
| MODIFY | `src/commands.ts` | Register `/rollback` command |

**Total: 2 new files, 2 modified files.**

## 7. What We Don't Do

- **No CompactOrchestrator changes** — avoid shadow mode coupling
- **No `/branch` modifications** — existing branch semantics are correct and separate
- **No settings fields** — no user configuration needed
- **No TTL/auto-cleanup** — single snapshot per session, space is bounded
- **No micro/session-memory compact snapshots** — they don't destroy messages
- **No multi-snapshot history** — only the latest pre-compact state is retained

## 8. Reuse Points

| Reused Component | How |
|-----------------|-----|
| `setMessages()` from `LocalJSXCommandContext` | Same pattern as `/clear` command for restoring messages |
| `MessageWithMetadata` serialization | Same JSONL format as session storage |
| Session file path resolution | Same directory as `{sessionId}.jsonl` |
| `logForDebugging()` | Consistent debug logging |
| Command registration pattern | Same as `/branch`, `/clear`, etc. |
| `getSessionId()` | Existing session ID accessor |

## 9. Validation

1. **Snapshot creation:** Boot CLI → have a conversation → trigger compact → verify `{sessionId}.pre-compact-snapshot.jsonl` exists alongside the session JSONL
2. **Rollback:** After compact, type `/rollback` → verify messages are restored to pre-compact state, snapshot file is deleted
3. **No-snapshot case:** Fresh session → `/rollback` → verify friendly "no snapshot" message
4. **Compact failure path:** Verify that if snapshot write fails, compact proceeds normally
5. **Import check:** `bun run version` — no import breakage
