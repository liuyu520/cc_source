# BashTool Wiring Example

How the PEV dry-run shadow layer is integrated into `src/tools/BashTool/BashTool.tsx`.

## Call Site (line ~644)

```typescript
try {
  // PEV dry-run 影子层：默认 OFF，仅在 CLAUDE_PEV_DRYRUN=1 时做静态
  // blast radius 分析并落入内存 aggregator。不阻塞主路径。
  try {
    const { previewBash, recordPevPreview } = await import(
      '../../services/harness/pev/index.js'
    )
    const radius = previewBash(input.command ?? '')
    if (radius) recordPevPreview(radius)
  } catch {
    // 影子层失败绝不影响命令执行
  }

  // Use the new async generator version of runShellCommand
  const commandGenerator = runShellCommand({ ... })
```

## Why This Pattern

1. **Dynamic import** — `await import()` keeps the PEV module out of hot path when disabled; ESM cache makes repeated imports near-free.
2. **Double try/catch** — outer catch is for `runShellCommand`; inner catch is exclusively for the shadow layer, ensuring PEV failures never propagate.
3. **`previewBash` returns `null` when flag off** — the function itself checks `isPevDryRunEnabled()`, so calling code doesn't need flag awareness.
4. **`recordPevPreview`** — feeds the in-memory aggregator (`pevSnapshot()`) for `/doctor` observability; no disk IO, no network.

## Pattern Reuse for Other Tools

The same three-line pattern (`import → preview → record`) can be inserted into any tool's execution path:

```typescript
// In FileEditTool, FileWriteTool, etc.:
try {
  const { previewFileEdit, recordPevPreview } = await import(
    '../../services/harness/pev/index.js'
  )
  const radius = previewFileEdit(filePath, oldContent, newContent)
  if (radius) recordPevPreview(radius)
} catch {}
```

Each tool would implement its own `preview*` function in `blastRadius.ts`, all returning the same `BlastRadius` shape and feeding the same aggregator.
