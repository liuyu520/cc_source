---
name: "claude-version-bump-reuse"
description: "Reuse package.json as the single source of truth when updating Claude Code 版本号, syncing current version strings in docs, and validating CLI version output in this repo."
---

# Claude Version Bump Reuse

Use this skill when bumping the repo's Claude Code version, syncing current-version examples in docs, or checking which file actually owns the displayed version.

## Reuse First

- `package.json`
  The primary source of truth for the repo version.
- `src/bootstrapMacro.ts`
  `MACRO.VERSION` already comes from `pkg.version`. Reuse this propagation path instead of creating another runtime constant.
- `src/entrypoints/cli.tsx` and `src/main.tsx`
  The normal CLI `--version` output is derived from `MACRO.VERSION`.
- `src/dev-entry.ts`
  The restored dev workspace path prints `pkg.version` directly.
- `README.md` and `docs/`
  These may contain current-version examples or expected output that should stay in sync.
- `rg`
  Search the exact old version string, including both plain and `v`-prefixed forms.

## Rules

- Prefer a single source-of-truth change in `package.json` over editing multiple runtime display sites.
- Preserve existing logic. If `src/bootstrapMacro.ts` already fans out `pkg.version`, do not add a parallel version constant.
- Update docs only when they describe the current expected output. Leave clearly historical records alone.
- Search exact strings before editing. Do not blindly replace generic semver-like fragments.
- Validation must be real. Do not claim a version bump is done without running the CLI commands.

## Workflow

1. Read `package.json`, `src/bootstrapMacro.ts`, and the version output entrypoints to confirm ownership.
2. Search the exact old version string with and without a leading `v`.
3. Update `package.json` first.
4. Sync current-version references in `README.md`, `docs/`, and active plan/design notes when they represent today's expected output.
5. Re-run the old-version search and inspect any leftovers before deciding they are intentional.
6. Validate with real commands:
   - `bun run version`
   - `bun run dev:restore-check --version`
   - `git diff --check`

## Validation

- `bun run version` prints the new version.
- `bun run dev:restore-check --version` prints the same base version for the dev workspace path.
- Exact old-version search returns no unexpected leftovers.
- `git diff --check` passes.

## Anti Patterns

- Editing `src/main.tsx`, `src/entrypoints/cli.tsx`, and other display sites directly while leaving `package.json` unchanged.
- Only updating docs without changing the source-of-truth version.
- Replacing `0.2` with `0.3` globally instead of using exact old-version search.
- Declaring success without running the real verification commands.
