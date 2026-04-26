# Subsystem Wiring Checklist

Use this checklist before merging any new subsystem integration.

## Pre-Flight

- [ ] **Category / Provider / Strategy defined** — new enum variant added to the subsystem's types file
- [ ] **Feature flag env var documented** — follows `CLAUDE_<SUBSYSTEM>_<DETAIL>` convention
- [ ] **`await import()`** used for cross-module flag check — no top-level import of the subsystem
- [ ] **Real signals fed** — no placeholder zeros that would produce wrong decisions in cutover
- [ ] **Fallback provided** — subsystem failure degrades gracefully to legacy behavior
- [ ] **`logForDebugging`** at decision/dispatch point — observable via `--debug`
- [ ] **`dedupeKey` includes varying component** — day bucket, input hash, or session ID
- [ ] **Type-safe converters used** — `toManifestItem`, `createEmptyMicrocompactResult`, etc.
- [ ] **Semantic invariants preserved** — read upstream comments before wrapping

## SideQuery-Specific

- [ ] `SideQueryCategory` union updated in `services/sideQuery/types.ts`
- [ ] Priority chosen correctly (P0=blocking, P1=quality, P2=method, P3=background)
- [ ] `fallback` returns a safe default (empty array, zero, noop), never throws
- [ ] `dedupeKey` stable for identical inputs but not globally constant

## CompactOrchestrator-Specific

- [ ] Used `decideAndLog` helper, not raw try/catch
- [ ] `runSnip` / `runMicro` used as independent booleans (not mutual-exclusion enum)
- [ ] `heavyToolResultCount` computed from real message scan

## ProviderRegistry-Specific

- [ ] Provider impl passes `_bypassRegistry: true` in `createClient`
- [ ] `translateError` maps provider-specific errors to `StandardErrorCode`
- [ ] Registration order in `bootstrap.ts` reflects detection priority

## MCP LazyLoad-Specific

- [ ] `updateManifestIfChanged` used instead of `put` (avoids IO amplification)
- [ ] `toManifestItem` used for all Tool/Command/Resource conversions
- [ ] Refresher registered on mount, unregistered on unmount

## PEV Harness-Specific

- [ ] `previewBash` (or custom `preview*`) called in inner try/catch before execution
- [ ] Result fed to `recordPevPreview` for aggregator
- [ ] Gated by `isPevDryRunEnabled()` — zero cost when off
- [ ] New pattern groups added to `blastRadius.ts` with correct `effects` + `reversibility`
- [ ] Shadow path never blocks, never throws, never alters the command

## Dream Pipeline-Specific

- [ ] Evidence signals are rule-computed (regex/counting), never LLM
- [ ] `captureEvidence` is append-only, fire-and-forget — journal write failure silent
- [ ] Triage thresholds respected: `<5 skip`, `5-15 micro`, `≥15 full`
- [ ] `dispatchDream` returns `'legacy'` when flag off — no behavioural change
- [ ] New evidence fields added to both `DreamEvidence` type and `scoreEvidence` function

## Intent Recall-Specific

- [ ] `classifyIntent` is pure CPU (<1ms) — never scheduled via SideQuery
- [ ] New `TaskMode` inserted at correct priority position in `MODE_KEYWORDS`
- [ ] `guessModeFromCommandName` updated for slash-command → mode mapping
- [ ] `fusionWeightsFor` returns sensible weights for the new class (if any)
- [ ] Shadow log via `logForDebugging('[SkillRecall:intent]')` present
