# Subsystem Wiring: Future Integration Candidates

Ready-to-wire function calls that can follow the SideQuery template directly.

## 1. `classifyYoloAction` — P0_blocking

Currently called inline to decide if a tool action is safe for auto-approval.

```typescript
// Current: direct call
const classification = await classifyYoloAction(action, context)

// Wired:
const res = await submitSideQuery<YoloClassification>({
  category: 'yolo_classify',
  priority: 'P0_blocking',
  source: 'side_question',
  dedupeKey: `yolo_classify:${action.toolName}:${hashArgs(action.args)}`,
  run: async () => classifyYoloAction(action, context),
  fallback: () => ({ safe: false, reason: 'scheduler_fallback' }),
})
```

Why P0_blocking: User is waiting; wrong default ('safe') could execute destructive actions.
Why fallback `safe: false`: Conservative — blocks auto-approval on scheduler failure.

## 2. `extractMemories` — P3_background

Post-conversation memory extraction — no user is waiting.

```typescript
const dayBucket = Math.floor(Date.now() / 86_400_000)
void submitSideQuery<void>({
  category: 'memory_extract',
  priority: 'P3_background',
  source: 'side_question',
  dedupeKey: `memory_extract:${sessionId}:${dayBucket}`,
  run: async () => extractMemories(conversation),
  fallback: () => undefined,
})
```

Why P3_background: Fire-and-forget; failure just means memories aren't extracted this session.
Why day bucket in dedupeKey: Same session can trigger multiple times; once per day is enough.

## 3. `autoDream` — P3_background

Background memory consolidation.

```typescript
void submitSideQuery<void>({
  category: 'auto_dream',
  priority: 'P3_background',
  source: 'side_question',
  dedupeKey: `auto_dream:${Math.floor(Date.now() / 86_400_000)}`,
  run: async () => autoDream(),
  fallback: () => undefined,
})
```

## Pattern: All Three Share the Same Shape

```typescript
const { submitSideQuery, isSideQueryCategoryEnabled } = await import(
  '../services/sideQuery/index.js'
)
if (!isSideQueryCategoryEnabled(CATEGORY)) {
  return directCall()
}
const res = await submitSideQuery<T>({
  category: CATEGORY,
  priority: PRIORITY,
  source: 'side_question',
  dedupeKey: `${CATEGORY}:${VARYING_COMPONENT}`,
  run: async () => directCall(),
  fallback: () => SAFE_DEFAULT,
})
```

The only moving parts are: `CATEGORY`, `PRIORITY`, `VARYING_COMPONENT`, `SAFE_DEFAULT`.

## 4. `dreamPipeline.captureEvidence` — P3_background (Phase 2)

Session-end evidence capture for the Dream Pipeline. Fire-and-forget.

```typescript
void submitSideQuery<void>({
  category: 'dream_capture',
  priority: 'P3_background',
  source: 'side_question',
  dedupeKey: `dream_capture:${sessionId}`,
  run: async () => {
    const { captureEvidence } = await import(
      '../services/autoDream/pipeline/index.js'
    )
    captureEvidence(evidence)
  },
  fallback: () => undefined,
})
```

Why P3_background: Append-only journal write, ~200 bytes, no user waiting.

## 5. `intentRouter.classifyIntent` — inline (no SideQuery needed)

Zero-cost regex classifier — too cheap to schedule. Called directly in `prefetch.ts` behind env flag.

```typescript
if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
  const { classifyIntent } = await import('./intentRouter.js')
  const intent = classifyIntent(signal.query)
  // Use intent.class / intent.taskMode to modulate fusion weights
}
```

Why no SideQuery: Pure CPU, <1ms, no IO. Scheduling overhead would exceed the work itself.

## 6. `pevHarness.previewBash` — inline (no SideQuery needed)

Static regex analysis of bash commands. Same reasoning as intentRouter — too cheap to schedule.

```typescript
const { previewBash, recordPevPreview } = await import(
  '../../services/harness/pev/index.js'
)
const radius = previewBash(input.command ?? '')
if (radius) recordPevPreview(radius)
```

## Pattern Insight: Not Everything Needs SideQuery

SideQuery is for async work with non-trivial cost (network, LLM, disk scan). Pure-CPU classifiers (intentRouter, blastRadius) should be called inline with a simple `await import()` + try/catch. The decision tree:

```
Is the function async with IO/network?
  ├── Yes → SideQuery (pick priority by latency tolerance)
  └── No  → Inline import + try/catch (zero scheduling overhead)
```
