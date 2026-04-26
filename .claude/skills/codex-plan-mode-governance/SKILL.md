---
name: "codex-plan-mode-governance"
description: "Reuse existing EnterPlanMode prompt variants and provider detection to keep plan mode conservative in Codex and third-party API scenarios, preventing simple tasks from entering unnecessary planning phases."
when_to_use: "Use this skill when plan mode is being triggered too aggressively in Codex or third-party scenarios, when you need to adjust the EnterPlanMode tool prompt strategy per provider, or when simple tasks bypass the conservative prompt and still enter plan mode."
---

# Codex Plan Mode Governance

Use this skill when managing how EnterPlanMode behaves under different API providers, especially to prevent over-triggering in Codex and third-party scenarios.

## Background

EnterPlanMode has two prompt variants:
- **External (aggressive)**: "Prefer using EnterPlanMode for implementation tasks unless they're simple" — 7 broad conditions, "err on the side of planning"
- **Ant (conservative)**: "genuine ambiguity" required, "prefer starting work over entering a full planning phase"

Codex and third-party models tend to follow instructions more literally, making the aggressive prompt especially problematic.

## Reuse First

- `src/tools/EnterPlanModeTool/prompt.ts`
  - `getEnterPlanModeToolPrompt()` routes by provider: `codex` and `thirdParty` use Ant-style conservative prompt.
  - `getEnterPlanModeToolPromptAnt()` is the conservative variant to reuse.
  - `getEnterPlanModeToolPromptExternal()` is the aggressive variant (first-party only).
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
  - `isEnabled()` can disable the tool entirely for specific providers if needed.
  - `mapToolResultToToolResultBlockParam()` controls post-entry instructions.
- `src/utils/model/providers.ts`
  - `getAPIProvider()` returns `'codex'` | `'thirdParty'` | `'firstParty'` | etc.
- `src/utils/messages.ts`
  - Auto mode already has plan mode suppression: "Do not enter plan mode unless the user explicitly asks."
  - Default mode has no such suppression — the tool prompt is the sole gatekeeper.

## Rules

- Codex and thirdParty providers MUST use the conservative (Ant-style) prompt.
- Do not disable EnterPlanMode entirely for Codex — users should still be able to plan genuinely ambiguous tasks.
- If adding a new provider type, default to the conservative prompt unless proven otherwise.
- Keep provider routing logic centralized in `getEnterPlanModeToolPrompt()`, not scattered across tool files.
- Do not add "plan mode" suppression to the system prompt — the tool prompt is the correct injection point.

## Workflow

1. Identify whether the over-trigger is in the tool prompt, the tool's `isEnabled()`, or the model's own reasoning.
2. If prompt-based: adjust `getEnterPlanModeToolPrompt()` provider routing.
3. If the model ignores the conservative prompt: consider adding explicit "When NOT to Use" examples that match the observed misclassified queries.
4. If the entire tool should be unavailable: add the provider check to `isEnabled()`.
5. Verify by checking what prompt the model actually sees for the target provider.

## Validation

- Verify `getEnterPlanModeToolPrompt()` returns the Ant-style prompt for `codex` and `thirdParty` providers.
- Confirm the Ant-style prompt contains "genuine ambiguity" and "When in doubt, prefer starting work".
- Confirm the Ant-style prompt does NOT contain "err on the side of planning".
- Run `bun "./src/bootstrap-entry.ts" --version` after the change.

## Anti-Patterns

- Disabling plan mode entirely instead of using the conservative prompt.
- Adding plan mode suppression to the system prompt instead of the tool prompt.
- Letting new providers default to the external (aggressive) prompt.
- Patching the aggressive prompt text instead of routing to the existing conservative variant.
