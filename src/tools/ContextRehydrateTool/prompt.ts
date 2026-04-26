// Phase 5 — ContextRehydrateTool 静态文案与常量
// 提供给 LLM 的最小使用说明,专供回取被 Phase 1/2 外置的折叠/工具结果。

export const CONTEXT_REHYDRATE_TOOL_NAME = 'ContextRehydrate'

export const DESCRIPTION =
  'Rehydrate previously collapsed or offloaded context by reference. Read-only. ' +
  'Use when a user question requires the original content of a <collapsed id="X"> ' +
  'placeholder, an archived turn inside one, or an offloaded tool result.'

export const PROMPT = `Rehydrate collapsed or offloaded context by reference.

When to call this tool:
- You see a <collapsed id="X" turns="u1,u2,..." count="N"> placeholder and need the
  full original content (e.g. to answer a question about a past exchange that was
  summarized).
- A tool result earlier in the session is missing its body because it was offloaded
  to disk. Its placeholder will carry a toolUseId you can reference as "tool:<id>".
- You want one specific archived turn inside a collapse span — use "turn:<uuid>".

Reference formats:
  "turn:<uuid>"       — a single archived message by its UUID (from the turns="..." attr)
  "collapse:<id>"     — the full contiguous block summarized by one <collapsed id="...">
  "tool:<useId>"      — an offloaded tool result body

Behavior:
- Read-only; touches no state. Safe to call at any time.
- Returns { success, ref, source, tokenCount, content } on hit.
- Returns { success: false, ref, error } when the ref does not resolve (the disk
  record may have been pruned, or the id is wrong — do not retry with a guess).

Tips:
- Prefer "turn:" over "collapse:" when you only need one specific message — it is
  dramatically cheaper in tokens.
- Do NOT call this speculatively. Only call when the answer actually depends on the
  archived content. Every call re-injects tokens into the context window.`
