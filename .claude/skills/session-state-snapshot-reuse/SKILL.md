---
name: "session-state-snapshot-reuse"
description: "Reuse session state snapshot/restore patterns (messages serialization, setMessages recovery, JSONL file I/O, atomic writes) when building features that save, restore, or manipulate conversation state."
---

# Session State Snapshot & Restore Reuse

Use this skill when saving conversation state to disk, restoring from a saved state, manipulating the messages array, or building features that need conversation checkpointing.

## Core Pattern: Snapshot → Store → Restore

```
Save:   messages[] → JSON.stringify per line → writeFile (atomic: .tmp + rename)
Load:   readFile → split lines → JSON.parse per line → Message[]
Apply:  context.setMessages(() => loadedMessages)
Clean:  unlink(snapshotFile)
```

## Reuse First

- `src/services/compact/snapshot.ts` — Pre-compact snapshot module
  Complete reference implementation for save/load/delete/has pattern:
  ```typescript
  savePreCompactSnapshot(sessionId, messages)  → Promise<string>   // returns path
  loadPreCompactSnapshot(sessionId)            → Promise<Message[] | null>
  deletePreCompactSnapshot(sessionId)          → Promise<void>
  hasPreCompactSnapshot(sessionId)             → Promise<boolean>
  ```

- `src/utils/sessionStorage.ts` — Session JSONL storage
  `getTranscriptPath()` (line 204) — current session's JSONL path
  `getTranscriptPathForSession(sessionId)` (line 209) — any session's path
  `getProjectDir(cwd)` — project-specific storage directory
  `appendEntryToFile(path, entry)` (line 2574) — sync JSONL append

- `src/utils/sessionStoragePortable.ts` — Portable session utilities
  `resolveSessionFilePath(sessionId, dir?)` (line 457) — resolve session to disk path with worktree fallback
  `getProjectDir(projectDir)` (line 383) — `~/.claude/projects/<sanitized>/`
  `canonicalizePath(dir)` (line 393) — NFC-normalized realpath, handles symlinks

- `src/utils/json.ts` — JSONL parsing utilities
  `parseJSONL<T>(data)` (line 182) — runtime-optimized JSONL parser (Bun-native fast path, Buffer fallback). Reuse this instead of manual `split('\n').map(JSON.parse)` for production-quality parsing.

- `src/utils/slowOperations.ts` — `jsonStringify()` (line 170)
  Project-standard JSON serializer. Reuse for consistency with existing JSONL files.

- `src/bootstrap/state.ts` — Session state accessors
  `getSessionId()` — current session UUID
  `getSessionProjectDir()` — current session's project directory (set by switchActiveSession)
  `getOriginalCwd()` — original working directory (never changes mid-session)
  `switchSession(id, dir)` — atomically updates both sessionId and projectDir

- `src/utils/messages.ts` — Message creation & introspection
  `createUserMessage()` (line 460), `createAssistantMessage()` (line 411), `createSystemMessage()` (line 4371), `createProgressMessage()` (line 603). Reuse these instead of manually constructing message objects.

- `src/types/message.ts` — Message type (line 124)
  Union of: UserMessage | AssistantMessage | ProgressMessage | SystemMessage | AttachmentMessage | HookResultMessage | ToolUseSummaryMessage | TombstoneMessage | GroupedToolUseMessage

- `src/commands/branch/branch.ts` — `createFork()` (line 61)
  Full session fork implementation: copies JSONL, adds `forkedFrom` metadata, handles content replacements. Reuse this if your snapshot needs to create a new session rather than restoring in-place.

- `src/hooks/useSessionBackgrounding.ts` — `setMessages` usage in hooks
  Shows how hooks use `setMessages([])` (line 60) and `setMessages([...taskMessages])` (line 96) for background task state management. Reference for non-command setMessages usage.

## Common Tasks

### Saving conversation state to disk

```typescript
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { Message } from '../../types/message.js'

async function saveState(filePath: string, messages: Message[]): Promise<void> {
  const tmpPath = filePath + '.tmp'
  // 确保目录存在
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  // 序列化：每行一个 message JSON
  const content = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n'
  // 原子写入：先写 tmp 再 rename，防止 crash 时损坏
  await writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmpPath, filePath)
}
```

**Key rules:**
- Use `mode: 0o600` for files, `mode: 0o700` for directories (security)
- Atomic write via `.tmp` + `rename()` prevents corruption on crash
- One `JSON.stringify(msg)` per line — compatible with existing JSONL tooling

### Loading conversation state from disk

```typescript
import { readFile } from 'fs/promises'
import type { Message } from '../../types/message.js'

async function loadState(filePath: string): Promise<Message[] | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    return lines.map(line => JSON.parse(line))
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null  // 不存在
    return null  // 解析失败等 — 视为无可用状态
  }
}
```

### Restoring conversation via setMessages

```typescript
// 完全替换（如 /rollback）
context.setMessages(() => restoredMessages)

// 清空（如 /clear）
context.setMessages(() => [])

// 追加
context.setMessages(prev => [...prev, newMessage])

// 过滤
context.setMessages(prev => prev.filter(m => m.type !== 'progress'))

// 截断到某一点
context.setMessages(prev => prev.slice(0, checkpointIndex))
```

### Resolving file paths for snapshots

```typescript
import { getSessionId, getSessionProjectDir, getOriginalCwd } from '../../bootstrap/state.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { join } from 'path'

// 与 session JSONL 同目录
function getMyFeaturePath(sessionId: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.my-feature.jsonl`)
}
```

**Convention:** `{sessionId}.{feature-name}.jsonl` — keeps feature files co-located with session.

### Cleaning up snapshot files

```typescript
import { unlink } from 'fs/promises'

async function cleanup(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (e: unknown) {
    // ENOENT = 已不存在，忽略
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(`[MyFeature] Cleanup failed: ${(e as Error).message}`)
    }
  }
}
```

## Integration Points

| Component | File | Key location |
|-----------|------|-------------|
| Snapshot save/load | `compact/snapshot.ts` | Full reference implementation |
| Session JSONL path | `sessionStorage.ts` | line 204 (`getTranscriptPath`) |
| Session path for ID | `sessionStorage.ts` | line 209 (`getTranscriptPathForSession`) |
| Project directory | `sessionStoragePortable.ts` | line 383 (`getProjectDir`) |
| Session ID | `bootstrap/state.ts` | `getSessionId()` |
| setMessages API | `types/command.ts` | line 82 |
| Message type | `types/message.ts` | line 124 |
| JSONL append | `sessionStorage.ts` | line 2574 (`appendEntryToFile`) |
| JSONL parse | `utils/json.ts` | `parseJSONL()` |

## File Naming Convention

```
~/.claude/projects/<sanitized-cwd>/
  {sessionId}.jsonl                           ← main session transcript
  {sessionId}.pre-compact-snapshot.jsonl      ← compact snapshot (snapshot.ts)
  {sessionId}.{your-feature}.jsonl            ← your feature's state file
```

## Validation

1. Save → verify file exists with `ls` or `stat()`
2. Load → verify message count matches original
3. setMessages → verify UI updates correctly
4. Cleanup → verify file is removed
5. ENOENT handling → verify graceful handling when file doesn't exist
6. `bun run version` → no import breakage

## Anti-Patterns

- Using `JSON.stringify(messages)` (whole array) — breaks JSONL format, can't stream-parse large files
- Using `writeFileSync` — blocks event loop, use async `writeFile` + `rename`
- Writing directly without `.tmp` + `rename()` — crash during write corrupts the file
- Forgetting `mode: 0o600` — session data may contain sensitive content
- Storing snapshots outside the session project directory — breaks lifecycle binding
- Not handling ENOENT in load/delete — file may not exist, this is normal
- Using `existsSync` before read — TOCTOU race; just try to read and catch ENOENT
- Modifying `prev` array directly in setMessages — always return a new array
