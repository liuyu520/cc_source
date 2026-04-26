---
name: "provider-brand-display-reuse"
description: "Reuse existing provider brand display patterns (footer brand badge, top logo billingType, StatusLine JSON provider field) when adding new provider scene identification to the terminal UI, extending brand detection logic, or customizing per-provider display labels."
---

# Provider Brand Display Reuse

Use this skill when adding a new provider's brand to the terminal UI (footer, top logo, or status line), extending brand detection for a new provider, customizing per-provider display labels, or debugging why a provider scene is not showing in the UI.

## Architecture Overview

```
getAPIProvider()                    ← src/utils/model/providers.ts (single source of truth)
       ↓
Three independent display surfaces:
  ├── Footer brand badge             ← PromptInputFooterLeftSide.tsx
  │     getProviderBrandLabel()  →  modeBrandPart  →  renderFooterRow([modePart, modeBrandPart, ...])
  ├── Top logo billingType           ← logoV2Utils.ts
  │     getLogoDisplayData()     →  billingType field  →  LogoV2 / CondensedLogo
  └── StatusLine JSON                ← StatusLine.tsx
        buildStatusLineCommandInput()  →  provider field  →  external status line command
```

**Core principle**: Brand detection always reuses `getAPIProvider()`. Display layer never touches auth/routing/model logic.

## Reuse First

### Brand Detection (`src/components/PromptInput/PromptInputFooterLeftSide.tsx`)

- `getProviderBrandLabel(): 'Codex' | null`
  Lightweight brand label for footer display. Only returns a label when the provider can be unambiguously identified. Returns `null` when unsure — non-matching scenarios show nothing extra.

  To add a new provider brand:
  ```typescript
  function getProviderBrandLabel(): 'Codex' | 'NewBrand' | null {
    const provider = getAPIProvider()
    if (provider === 'codex') return 'Codex'
    if (provider === 'newProvider') return 'NewBrand'
    return null
  }
  ```

  Rules:
  - Only use `getAPIProvider()` — do NOT mix in auth source, email, or other identity signals
  - Return `null` for any ambiguous case — false positive brand display is worse than no brand
  - Keep the return type union explicit for type safety

### Brand Badge Styling

Brand badge 使用主题色而非 ANSI 原始色。当前 Codex 场景用 `color="error"` + `bold`，与 bypass permissions 模式一致：

```tsx
// ✅ 正确：使用主题色 key
<Text color="error" bold key="provider-brand">{providerBrandLabel}</Text>

// ❌ 错误：使用 ANSI 原始色（不同主题下颜色不一致，且偏淡）
<Text color="red" key="provider-brand">{providerBrandLabel}</Text>
<Text color="red" bold key="provider-brand">{providerBrandLabel}</Text>
```

主题色定义在 `src/utils/theme.ts`，`error` 在不同主题下映射不同 RGB/ANSI 值：
- dark 主题: `rgb(171,43,63)`
- light 主题: `rgb(255,107,128)`
- ansi 主题: `ansi:red` / `ansi:redBright`
- 色盲友好主题: `rgb(204,0,0)` / `rgb(255,102,102)`

如需为其他 provider 选择不同品牌色，从 `ThemeColors` 中选取语义化 key（如 `success`, `warning`, `autoAccept`），不要硬编码 hex/rgb。

### Auth Identity Label (`src/components/PromptInput/PromptInputFooterLeftSide.tsx`)

- `getAuthIdentityLabel(): string | null`
  Shows auth/billing identity in the footer (email, API domain, provider name). This is SEPARATE from brand — brand is "who" (Codex), identity is "how" (api.minimaxi.com).

  Depends on:
  - `getAPIProvider()` from `src/utils/model/providers.ts`
  - `getAuthTokenSource()` from `src/utils/auth.ts`
  - `getOauthAccountInfo()` from `src/utils/auth.ts`

  Both `getAuthTokenSource` and `getOauthAccountInfo` must be imported explicitly.

### Footer Rendering (`src/components/PromptInput/PromptInputFooterLeftSide.tsx`)

The footer has a fixed-position area and flexible parts:

```
renderFooterRow(fixedParts, leadingParts)
                  ↑              ↑
        [modePart, modeBrandPart, tasksPart]    [authIdentity, gitBranch, sessionId]
```

Brand badge (`modeBrandPart`) is in the **fixed area**, not in `leadingParts`. This ensures:
1. Brand always appears right after permission mode
2. Brand is never pushed away by tasks pill or other dynamic content
3. Order is stable: `permission mode → brand → tasks → auth → git → session`

Two rendering paths must both include brand:
```tsx
// hasTeammatePills branch
{renderFooterRow([modePart, modeBrandPart], leadingParts)}

// Normal main path
{renderFooterRow([modePart, modeBrandPart, tasksPart], leadingParts)}
```

### Top Logo (`src/utils/logoV2Utils.ts`)

- `getLogoDisplayData()` returns `billingType` field consumed by both `LogoV2` and `CondensedLogo`.
  Provider brand overrides the default billing type:

  ```typescript
  const provider = getAPIProvider()
  const billingType = provider === 'codex'
    ? 'Codex'
    : isClaudeAISubscriber()
      ? getSubscriptionName()
      : 'API Usage Billing'
  ```

  To add a new provider:
  ```typescript
  const billingType = provider === 'codex'
    ? 'Codex'
    : provider === 'newProvider'
      ? 'NewBrand'
      : isClaudeAISubscriber()
        ? getSubscriptionName()
        : 'API Usage Billing'
  ```

  Import needed: `import { getAPIProvider } from './model/providers.js'`

### StatusLine JSON (`src/components/StatusLine.tsx`)

- `buildStatusLineCommandInput()` includes a `provider` field so external status line commands can identify the current scene:

  ```typescript
  const apiProvider = getAPIProvider();
  return {
    ...createBaseHookInput(),
    provider: apiProvider,
    // ...
  }
  ```

  `StatusLineCommandInput` is `Record<string, unknown>` — no type change needed for new fields.

  Import needed: `import { getAPIProvider } from '../utils/model/providers.js'`

## Common Tasks

### Adding brand display for a new provider

1. Add provider type to `APIProvider` union in `src/utils/model/providers.ts` (if not already)
2. Add detection in `getAPIProvider()` in `src/utils/model/providers.ts`
3. Add brand label in `getProviderBrandLabel()` in `PromptInputFooterLeftSide.tsx`
4. Add billingType branch in `getLogoDisplayData()` in `logoV2Utils.ts`
5. StatusLine JSON `provider` field is automatic (uses `getAPIProvider()` directly)
6. Done — all three surfaces pick up the new brand

### Customizing what shows in the footer for a provider

The footer information architecture:
```
permission mode → Provider brand → tasks pill → auth identity → git branch → session ID
     fixedParts                                      leadingParts
```

- To change brand label: modify `getProviderBrandLabel()`
- To change auth identity: modify `getAuthIdentityLabel()`
- To change order: modify the arrays passed to `renderFooterRow()`
- To add new info: add to `leadingParts` or `trailingParts` arrays

### Debugging "brand not showing"

1. Check `getAPIProvider()` returns expected value: `bun -e "import { getAPIProvider } from './src/utils/model/providers.ts'; console.log(getAPIProvider())"` (with appropriate env vars)
2. Check `getProviderBrandLabel()` returns non-null for your provider
3. Check both rendering paths include `modeBrandPart` in the fixed area
4. Check env var is set: `CLAUDE_CODE_USE_CODEX=1` for Codex

## Key Files

| File | Role | Key function |
|------|------|-------------|
| `src/utils/model/providers.ts` | Provider detection (source of truth) | `getAPIProvider()` |
| `src/utils/theme.ts` | 主题色定义（品牌 badge 颜色来源） | `ThemeColors`, `error`/`success`/`warning` 等语义色 key |
| `src/components/PromptInput/PromptInputFooterLeftSide.tsx` | Footer brand badge + auth identity | `getProviderBrandLabel()`, `getAuthIdentityLabel()` |
| `src/utils/logoV2Utils.ts` | Top logo billing type | `getLogoDisplayData()` |
| `src/components/StatusLine.tsx` | Status line JSON output | `buildStatusLineCommandInput()` |
| `src/components/LogoV2/LogoV2.tsx` | Full logo renderer | consumes `getLogoDisplayData()` |
| `src/components/LogoV2/CondensedLogo.tsx` | Condensed logo renderer | consumes `getLogoDisplayData()` |
| `src/utils/auth.ts` | Auth identity helpers | `getAuthTokenSource()`, `getOauthAccountInfo()` |

## Rules

- Brand detection ONLY uses `getAPIProvider()`. Never mix auth source, email, or base URL into brand logic.
- `getProviderBrandLabel()` returns `null` for any ambiguous case — no false positives.
- Brand badge 颜色必须使用 `src/utils/theme.ts` 中的语义化主题色 key（如 `error`），不得使用 ANSI 原始色名（如 `"red"`）。原因：ANSI 原始色在不同主题/终端下表现不一致，会出现偏淡、偏粉等问题。
- Brand badge goes in the fixed area of `renderFooterRow()`, not in `leadingParts` — prevents tasks pill from pushing brand out of position.
- Both footer rendering paths (teammate pills + normal main) must include brand.
- Top logo billingType uses provider check BEFORE the subscription check — provider brand takes priority.
- StatusLine `provider` field uses raw `getAPIProvider()` value, not the display label.
- Non-matching providers see zero UI changes — no brand, no modified billing type, no extra fields.
- When adding `getAuthIdentityLabel()` or `getOauthAccountInfo()` usage, ensure the imports from `src/utils/auth.ts` are present — missing imports cause runtime `is not defined` errors that only surface at startup.

## Validation

- Footer brand test: `CLAUDE_CODE_USE_CODEX=1 bun run dev --dangerously-skip-permissions` — verify footer shows `Codex` after permission mode
- Top logo test: same command — verify top logo shows `Codex` instead of `API Usage Billing`
- Non-Codex test: `bun run dev --dangerously-skip-permissions` (without CODEX env) — verify no brand shows
- Import check: `bun run version` — confirms no missing imports
- Provider detection: `CLAUDE_CODE_USE_CODEX=1 bun -e "import { getAPIProvider } from './src/utils/model/providers.ts'; console.log(getAPIProvider())"` — should print `codex`

## Anti-Patterns

- 品牌 badge 使用 ANSI 原始色名（`"red"`, `"green"` 等）而非主题色 key（`"error"`, `"success"` 等）— 不同终端主题下颜色表现不一致，浅色背景偏淡偏粉。必须用 `src/utils/theme.ts` 中定义的语义色 key。
- Using auth source or email to infer brand — brand and identity are separate concerns.
- Putting brand badge in `leadingParts` — it gets pushed around by tasks pill.
- Only adding brand to one rendering path (teammate pills or normal) — both must have it.
- Checking `ANTHROPIC_BASE_URL` to determine brand — use `getAPIProvider()` which already encapsulates all detection logic.
- Modifying `getSubscriptionName()` in `auth.ts` for non-Anthropic providers — use the `getLogoDisplayData()` provider branch instead.
- Adding provider-specific display logic in `LogoV2.tsx` or `CondensedLogo.tsx` — keep it in `logoV2Utils.ts` so both consumers share the same logic.
- Forgetting to import `getAuthTokenSource` / `getOauthAccountInfo` when `getAuthIdentityLabel()` uses them — causes runtime crash at startup.
