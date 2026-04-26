---
description: Optimize bottom status-line copy in PromptInputFooterLeftSide with minimal changes, explicit action labels only where helpful, and reuse of existing value sources/truncation logic.
---

# Statusline Copy

Use this skill when editing the bottom status bar / footer copy, especially `src/components/PromptInput/PromptInputFooterLeftSide.tsx`.

## Goal

Improve readability and user recognition speed without changing state sources, interaction flow, or layout structure.

## Core Rules

1. **Prefer display-layer only changes**
   - Change labels, separators, truncation presentation, and wording.
   - Do **not** change where values come from unless the task explicitly asks for it.
   - Reuse existing values such as:
     - `getAuthIdentityLabel()`
     - `getProviderBrandLabel()`
     - `getSessionId().slice(0, 8)`
     - `getCwdState().slice(-10)`
     - `useGitBranch()`

2. **Preserve layout pipeline**
   - Keep `leadingParts`, `trailingParts`, and `renderFooterRow()` intact unless the user explicitly asks for structural change.
   - Do not add extra Box nesting if the same result can be achieved by editing existing text parts.
   - Respect the existing split between fixed parts and truncating text parts.

3. **Use explicit labels selectively**
   - Add labels to high-action / high-ambiguity fields when it improves recognition.
   - Good candidates:
     - `session ⎔ resume:xxxxxxxx`
     - `git ⎇ branch-name`
   - Avoid wrapping already self-descriptive values in redundant labels.
   - Example: keep `API Usage Billing` / provider host / email as-is instead of `auth API Usage Billing` when the value is already the semantic label.

4. **Favor semantic wording over implementation wording**
   - If the second row visually communicates project identity, prefer `project` or even bare directory tail over `cwd`.
   - Prefer words users mentally map to actions or objects, not internal implementation terms.

5. **Minimize visual noise**
   - Remove redundant prefixes like duplicated `git|...`-style wording when an icon already conveys the same meaning.
   - Prefer compact separators like `·` when multiple short state tokens are grouped.
   - Keep kernel/feature pills short; avoid inflating them with verbose labels unless the user explicitly asks.

## Heuristics from prior optimization

### Recommended defaults

- Kernel feature group: keep short
  - Example: `⎈ dream·auto·llm`
- Auth identity: reuse existing wording directly
  - Example: `API Usage Billing`
  - Example: `api.minimaxi.com`
  - Example: `user@example.com`
- Git branch: explicit label is useful
  - Example: `git ⎇ main20260418`
- Session resume hint: explicit label is useful
  - Example: `session ⎔ resume:b600e331`
- Project tail / cwd tail:
  - Prefer `project minimaxOk2` or bare `minimaxOk2` if the row already reads naturally
  - Avoid overly technical `cwd minimaxOk2` unless the task explicitly wants implementation vocabulary

## Safe edit checklist

Before editing:

1. Read `PromptInputFooterLeftSide.tsx`
2. Reuse existing helper functions instead of adding new ones
3. Keep field order unless the user explicitly asks to reorder
4. Prefer string-template changes over structural refactors
5. Preserve comments that explain render-path constraints

After editing:

1. Re-read the modified region
2. Confirm no value-source logic changed unintentionally
3. Confirm labels did not become semantically redundant
4. Confirm the status line still follows the existing two-row model

## Anti-patterns

Do **not**:

- Rebuild the footer from scratch
- Add a new abstraction for one-off copy changes
- Replace semantic existing values with more verbose wrappers without clear benefit
- Change `sessionIdShort`, `cwdTail`, or branch source logic just to support copy edits
- Add fake preview/demo data for verification

## Example decisions

### Good

```tsx
{'session ⎔ resume:' + sessionIdShort}
```

Why: the field now exposes the actual `/resume` action affordance while fully reusing the existing short-id logic.

### Good

```tsx
{'git ' + (figures.arrowUp === '↑' ? '⎇ ' : '') + gitBranch.slice(-15)}
```

Why: branch fields are operational; explicit labeling improves scan speed.

### Good

```tsx
{authIdentityLabel.length > 20 ? authIdentityLabel.slice(0, 20) + '…' : authIdentityLabel}
```

Why: auth identity values are already semantic; do not wrap them in redundant labels.

### Usually avoid

```tsx
{'auth ' + authIdentityLabel}
```

Why: produces awkward copy like `auth API Usage Billing`.

## If the user asks to "举一反三"

Apply the same principle to neighboring footer fields:

- make action-oriented fields more explicit
- keep already-semantic values concise
- reuse existing helper/value logic
- avoid structural refactors for wording-only requests
