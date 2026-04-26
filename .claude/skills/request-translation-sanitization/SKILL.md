---
name: "request-translation-sanitization"
description: "Reuse the existing Codex request translator and API request pipeline rules to keep Anthropic-to-Responses translation minimal, explicit, and compatible with third-party OpenAI/Codex endpoints."
when_to_use: "Use this skill when Anthropic request fields are being translated to Codex/ChatGPT/OpenAI Responses APIs, when unsupported parameter errors appear, or when you need to decide which default fields should be omitted, gated, or passed through only for explicit non-default values."
---

# Request Translation Sanitization

Use this skill when tightening Anthropic → Codex/ChatGPT/OpenAI Responses request translation, especially around default-value passthrough, reasoning incompatibilities, and endpoint-specific unsupported parameters.

## Reuse First

- `src/services/providers/impls/codex/translator/requestTranslator.ts`
  - Reuse `translateRequest()`, `translateThinking()`, and `translateToolChoice()`.
  - Keep compatibility logic close to the request assembly block instead of spreading it across new helpers.
- `src/services/providers/impls/codex/types.ts`
  - Reuse the existing `ResponsesApiRequest` shape when deciding whether a field should exist at all.
- `.claude/skills/api-request-pipeline-reuse/SKILL.md`
  - Follow the existing pipeline rule: prefer adapting parameters inside the current request path instead of creating a second path.
- `src/skills/bundled/adapterAudit.ts`
  - Reuse its adapter-audit mindset for request contract checks, especially around “looks legal but endpoint rejects it” failures.
- `skills/api-message-sanitization.md`
- `skills/third-party-performance-tuning.md`
  - Reuse their existing “trim request surface area first” principle.

## Rules

- Default values should not be passed through just because they exist upstream.
- Prefer “only send explicit non-default values” for sampling-style fields.
- Keep reasoning-mode incompatibilities explicit; if a field is forbidden with reasoning, omit it instead of hoping the target endpoint ignores it.
- Reuse existing env-gated behavior before adding new flags.
- Keep the request envelope minimal first, then widen only when real endpoint behavior proves it is needed.
- Do not split translation policy across multiple files unless the existing translator can no longer hold the logic clearly.

## Workflow

1. Start in `translateRequest()` and inspect the final request object assembly.
2. Classify each candidate field into one of four groups:
   - always required
   - safe optional passthrough
   - explicit non-default only
   - mode-gated / env-gated
3. Reuse current patterns for:
   - `temperature !== 1`
   - `top_p !== 1`
   - `CODEX_ENABLE_MAX_OUTPUT_TOKENS === '1'`
4. If a field is endpoint-fragile, prefer omitting it by default rather than inventing a compatibility shim.
5. When touching request translation, read nearby routing and adapter code only as needed; keep the actual policy centralized in the translator.

## Validation

- Use a real Bun script that imports `translateRequest()` and verifies:
  - default `temperature=1` is omitted
  - default `top_p=1` is omitted
  - `max_output_tokens` is absent unless the explicit env gate is enabled
  - explicit non-default sampling values still pass through
  - `stream` and `store` behavior stay unchanged
- If changing reasoning behavior, verify the translated request shape with and without `thinking`.
- Run `bun "./src/bootstrap-entry.ts" --version` after the change.

## Anti-Patterns

- Passing Anthropic defaults through to a third-party endpoint “just in case”.
- Adding a new compatibility abstraction when one conditional near `translateRequest()` is enough.
- Mixing request-shape policy with response/event translation fixes.
- Treating all OpenAI-compatible endpoints as equally permissive.
