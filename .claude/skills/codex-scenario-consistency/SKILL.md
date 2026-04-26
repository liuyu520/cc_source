---
name: “codex-scenario-consistency”
description: “Reuse existing intent, local recall, model routing, plan mode prompt, and request translation paths to keep Codex/ChatGPT scenario optimizations consistent across all relevant entry points.”
when_to_use: “Use this skill when a Codex or ChatGPT optimization was fixed in one layer but may still be inconsistent in recall, model routing, plan mode, request translation, or nearby adapter logic, and you want the smallest possible follow-through patch.”
---

# Codex Scenario Consistency

Use this skill when improving a Codex/ChatGPT scenario and you need to make sure the fix does not stop at a single file while neighboring entry points still amplify, bypass, or contradict the new behavior.

## Reuse First

- `src/services/skillSearch/intentRouter.ts`
  - Reuse the current `IntentClass` and `TaskMode` definitions as the source of truth.
  - `simple_task` 分类可抑制简单请求的 skill recall。
- `src/services/skillSearch/localSearch.ts`
  - Reuse the existing early-return and ranked discovery path before changing wider recall behavior.
- `src/services/modelRouter/router.ts`
  - Reuse `classifyRouteIntent()` to keep routing intent aligned with skill intent.
- `src/tools/EnterPlanModeTool/prompt.ts`
  - Codex/thirdParty provider 已走保守版 prompt（Ant-style），仅在 “genuine ambiguity” 时建议 plan mode。
  - 修改 plan mode 行为时检查 `getEnterPlanModeToolPrompt()` 的 provider 分支。
- `src/services/providers/impls/codex/translator/requestTranslator.ts`
  - Reuse the existing minimal passthrough policy when request-shape consistency is part of the scenario.
- `src/skills/bundled/codex.ts`
- `src/skills/bundled/adapterAudit.ts`
- `src/skills/bundled/intent-recall/SKILL.md`
  - Reuse their existing task framing before inventing a new Codex-only workflow story.

## Rules

- Do not stop at the first file that appears to fix the symptom.
- If you add or change an `IntentClass`, inspect all obvious downstream consumers before calling the work done.
- Prefer one small consistency patch per affected layer instead of a shared abstraction introduced too early.
- Keep request-translation policy centralized in the translator, routing policy centralized in the router, recall policy centralized in skill search, plan mode policy centralized in prompt.ts.
- Reuse existing conditionals and ordering before creating new feature switches.
- Codex 场景三大过度触发根因：skill recall 阈值过低、plan mode prompt 过于激进、superpowers skill 无条件注入。修复时需同时检查这三条路径。

## Workflow

1. Start from the observed symptom and identify the first fixed layer.
2. Trace the same concept across nearby entry points in this order:
   - `intentRouter.ts` (skill recall 意图分类)
   - `localSearch.ts` (skill discovery 和 fusion 权重)
   - `EnterPlanModeTool/prompt.ts` (plan mode 触发策略)
   - `modelRouter/router.ts` (模型路由)
   - `requestTranslator.ts` (请求参数翻译)
3. Ask whether the new behavior can still be re-expanded downstream.
   - Example: recall suppressed, but plan mode prompt still encourages “err on the side of planning”.
   - Example: plan mode prompt fixed, but superpowers skill still forces brainstorming → plan.
4. Apply the smallest follow-through patch only where inconsistency remains.
5. Re-verify the end-to-end behavior with real calls instead of trusting the local patch in isolation.

## Validation

- For intent-class consistency:
  - call `classifyIntent()` with a real query
  - call `localSkillSearch()` with the same query
  - inspect `classifyRouteIntent()` behavior for the same request text
- For plan mode consistency:
  - verify `getEnterPlanModeToolPrompt()` returns conservative prompt for `codex` and `thirdParty` provider
  - confirm simple tasks hit “When NOT to Use” criteria in Ant-style prompt
- For request-shape consistency:
  - call `translateRequest()` with both default and non-default values
  - confirm the resulting request object matches the intended policy
- Run `bun “./src/bootstrap-entry.ts” --version` after the changes.

## Anti-Patterns

- Declaring the scenario fixed after patching only recall or only routing.
- Fixing skill recall but leaving plan mode prompt in aggressive “external” mode.
- Solving a two-condition inconsistency by introducing a new shared framework abstraction.
- Adding Codex-specific branches in multiple places when one downstream condition update is enough.
- Skipping real end-to-end verification because each local function “looks right”.
