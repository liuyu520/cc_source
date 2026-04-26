# Codex Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the footer clearly identify ChatGPT/Codex sessions by inserting a provider brand badge ahead of the existing auth/git/session details without removing current information.

**Architecture:** Keep the change localized to `src/components/PromptInput/PromptInputFooterLeftSide.tsx`. Reuse the existing footer row composition (`renderFooterRow`), `getAuthIdentityLabel()`, and current truncation behavior, then add a small UI-only provider badge helper that detects Codex/OpenAI sessions and inserts a short `Codex` or `ChatGPT` label in the leading badge row.

**Tech Stack:** TypeScript, React, Ink terminal UI, Bun runtime

---

## File map

- Modify: `src/components/PromptInput/PromptInputFooterLeftSide.tsx`
  - Add a UI-only helper for provider branding
  - Insert the provider badge into the existing `leadingParts` sequence
  - Preserve existing auth/git/session rendering and narrow-width behavior
- Verify manually in a real CLI session
  - Codex/OpenAI session should show `Codex` or `ChatGPT`
  - Non-Codex session should keep existing footer behavior

### Task 1: Add provider brand helper

**Files:**
- Modify: `src/components/PromptInput/PromptInputFooterLeftSide.tsx:49-97`

- [ ] **Step 1: Write the failing check mentally against current code**

Current footer code only derives `authIdentityLabel` via `getAuthIdentityLabel()` and never returns a dedicated provider brand string. The missing behavior is: a Codex/OpenAI session should expose a short footer brand label before auth identity.

Expected missing behavior:

```ts
const providerBrandLabel = getProviderBrandLabel()
// Expected for Codex/OpenAI sessions:
// 'Codex' | 'ChatGPT' | null
```

- [ ] **Step 2: Confirm the current code has no provider badge helper**

Run:

```bash
grep -n "getProviderBrandLabel\|providerBrandLabel" src/components/PromptInput/PromptInputFooterLeftSide.tsx
```

Expected: no matches

- [ ] **Step 3: Add the minimal helper above `ModeIndicator`**

Insert this code after `getAuthIdentityLabel()` in `src/components/PromptInput/PromptInputFooterLeftSide.tsx`:

```ts
function getProviderBrandLabel(): 'Codex' | 'ChatGPT' | null {
  const provider = getAPIProvider()
  if (provider !== 'codex') {
    return null
  }

  const model = process.env.ANTHROPIC_MODEL?.toLowerCase() ?? ''
  if (model.includes('codex')) {
    return 'Codex'
  }

  return 'ChatGPT'
}
```

If `getAPIProvider()` does not currently expose `'codex'` as a literal in this repo, adjust the condition to the actual Codex/OpenAI provider identifier used by the codebase, but keep the function signature and return values unchanged.

- [ ] **Step 4: Re-read the helper for scope discipline**

The helper must:
- only return `Codex`, `ChatGPT`, or `null`
- avoid touching auth/provider routing logic
- not replace `getAuthIdentityLabel()`

The helper must not:

```ts
// Do not do any of these in the helper:
// - mutate state
// - read app state hooks
// - rewrite provider selection
// - return long labels like 'Codex via OpenAI OAuth'
```

- [ ] **Step 5: Commit the helper addition**

```bash
git add src/components/PromptInput/PromptInputFooterLeftSide.tsx
git commit -m "feat(codex): add footer provider brand helper"
```

### Task 2: Insert the provider brand badge into the leading footer row

**Files:**
- Modify: `src/components/PromptInput/PromptInputFooterLeftSide.tsx:414-434`

- [ ] **Step 1: Add the derived provider brand label near `authIdentityLabel`**

Update the local derived values in `ModeIndicator` to include:

```ts
const authIdentityLabel = getAuthIdentityLabel()
const providerBrandLabel = getProviderBrandLabel()
const sessionIdShort = getSessionId().slice(0, 8)
const cwdTail = getCwdState().slice(-10)
```

- [ ] **Step 2: Build the leading parts in the new order**

Update `leadingParts` so the provider brand appears before auth identity and after the fixed `modePart` row logic. Use a short dim label so it behaves like the existing inline footer text.

Target structure:

```tsx
const leadingParts = [
  ...(providerBrandLabel
    ? [
        <Text dimColor key="provider-brand">
          {providerBrandLabel}
        </Text>,
      ]
    : []),
  ...(authIdentityLabel
    ? [
        <Text dimColor key="auth-identity">
          {'em:' + authIdentityLabel.slice(0, 15)}
        </Text>,
      ]
    : []),
  ...(gitBranch
    ? [
        <Text dimColor key="git-branch">
          {figures.arrowUp === '↑' ? '⎇git|cl: ' : ''}
          {gitBranch.slice(-15)}
        </Text>,
      ]
    : []),
  ...(sessionIdShort
    ? [
        <Text dimColor key="session-id">
          ⎔ {sessionIdShort}
        </Text>,
      ]
    : []),
]
```

- [ ] **Step 3: Keep the rest of the footer row logic unchanged**

Do not rewrite `renderFooterRow`, `trailingParts`, task pills, or hint selection. This task is complete only if the provider label is added by reusing the existing row/truncation logic.

Guardrail:

```ts
// Keep these existing structures intact:
renderFooterRow([modePart, tasksPart], leadingParts)
renderFooterRow([], trailingParts)
```

- [ ] **Step 4: Review the narrow-width fallback behavior inline**

Confirm the new provider label participates in the same truncation path as existing text parts:

```tsx
<Text wrap="truncate">
  <Byline>{textChildren}</Byline>
</Text>
```

Expected result: in narrow terminals, `providerBrandLabel` truncates with the same row as auth/git/session details instead of introducing a new layout branch.

- [ ] **Step 5: Commit the badge insertion**

```bash
git add src/components/PromptInput/PromptInputFooterLeftSide.tsx
git commit -m "feat(codex): show provider brand in footer"
```

### Task 3: Verify Codex and non-Codex behavior manually

**Files:**
- Verify: `src/components/PromptInput/PromptInputFooterLeftSide.tsx`
- Reference: `docs/superpowers/specs/2026-04-14-codex-statusline-design.md`

- [ ] **Step 1: Start a real Codex/OpenAI-flavored CLI session**

Run the project in a real session that exercises the modified footer.

```bash
bun run dev
```

Expected: CLI opens normally

- [ ] **Step 2: Verify Codex/OpenAI footer branding**

In a Codex/OpenAI session, inspect the footer and confirm the order is:

```text
[permission mode] · [Codex|ChatGPT] · [em:...] · [git branch] · [session id]
```

Expected:
- `Codex` appears when the configured model name clearly indicates Codex
- otherwise `ChatGPT` appears for the Codex/OpenAI provider
- existing auth/git/session details remain visible

- [ ] **Step 3: Verify a non-Codex scenario does not regress**

Run or switch to a non-Codex provider scenario available in your environment and confirm there is no new provider badge.

Expected footer behavior:

```text
[permission mode] · [existing auth/git/session details only]
```

Expected: no `Codex` or `ChatGPT` badge appears outside the target provider path

- [ ] **Step 4: Verify narrow terminal degradation honestly**

Resize the terminal narrower and confirm the footer still renders on the existing truncation path without introducing extra lines or pushing task pills out of place.

Expected:
- provider brand remains early in the row
- auth identity or later details truncate first
- no broken separators

- [ ] **Step 5: Commit the verified implementation**

```bash
git add src/components/PromptInput/PromptInputFooterLeftSide.tsx
git commit -m "feat(codex): enhance footer branding for Codex sessions"
```

## Self-review

### Spec coverage

Spec requirement → plan coverage:
- Add provider brand badge for Codex/ChatGPT → Task 1, Task 2
- Keep change localized to `PromptInputFooterLeftSide.tsx` → Task 1, Task 2
- Reuse `getAuthIdentityLabel()` and existing footer composition → Task 2
- Preserve non-Codex behavior → Task 3
- Validate narrow terminal fallback → Task 3

No spec gaps found.

### Placeholder scan

Checked for:
- `TBD`
- `TODO`
- vague phrases like “handle appropriately” or “write tests later”

No unresolved placeholders remain.

### Type consistency

The plan consistently uses:
- `getProviderBrandLabel()` as the helper name
- return type `'Codex' | 'ChatGPT' | null`
- `providerBrandLabel` as the derived value inserted into `leadingParts`

No naming mismatches found.
