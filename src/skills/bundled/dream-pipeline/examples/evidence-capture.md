# Evidence Capture Integration

How to wire `captureEvidence` into a session-end hook.

## Capture Site

The ideal place is wherever the session transcript is finalized — typically in the same `stopHooks` chain that calls `executeAutoDream`. The capture runs **before** the dream gate, so evidence accumulates even when dream itself is skipped.

```typescript
// In backgroundHousekeeping or stopHooks:
import { captureAndMaybeTrigger } from '../services/autoDream/pipeline/index.js'

// After session metrics are available:
captureAndMaybeTrigger({
  sessionId: getSessionId(),
  endedAt: new Date().toISOString(),
  durationMs: Date.now() - sessionStartMs,
  novelty: computeNovelty(messages),       // rule-based
  conflicts: countConflictSignals(messages),
  userCorrections: countCorrections(messages),
  surprise: countSurpriseEvents(toolResults),
  toolErrorRate: failedTools / totalTools,
  filesTouched: touchedFiles.size,
  memoryTouched: memoryWriteCount > 0,
})
```

## Signal Computation (Zero LLM Cost)

All signals are rule-based, computed from the in-memory message array:

### novelty
```typescript
function computeNovelty(messages: Message[]): number {
  // Count unique file extensions touched for the first time in this project
  // + count of new tool names not seen in prior sessions
  // Normalize to 0..1 by capping at 10
  return Math.min(newExtensions + newTools, 10) / 10
}
```

### conflicts
```typescript
function countConflictSignals(messages: Message[]): number {
  const CONFLICT_PATTERNS = [
    /\bno[,.]?\s+(not|don't|that's wrong|incorrect)/i,
    /\bstop\b/i, /\brevert\b/i, /\bundo\b/i, /\brollback\b/i,
  ]
  return messages
    .filter(m => m.type === 'user')
    .reduce((n, m) => {
      const text = getUserMessageText(m)
      return n + (CONFLICT_PATTERNS.some(p => p.test(text)) ? 1 : 0)
    }, 0)
}
```

### surprise
```typescript
function countSurpriseEvents(toolResults: ToolResult[]): number {
  return toolResults.filter(r =>
    r.is_error || r.retryCount > 0 || /exception|error|failed/i.test(r.output)
  ).length
}
```

## Key Principle

Evidence capture is **append-only, fire-and-forget**. If it fails, the session still ends normally. The journal file grows ~200 bytes per session — at 50 sessions/day that's 10KB/day, trivially small.
