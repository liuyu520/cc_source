---
name: "local-skill-discovery-reuse"
description: "Reuse existing local first skill search prefetch, signals, ranking, and discovered skill telemetry when improving agent intelligence or smoothness through skill discovery."
---

# Local Skill Discovery Reuse

Use this skill when changing skill discovery timing, write-pivot detection, local ranking, discovery telemetry, or the way discovered skills influence the coding agent.

## Reuse First

- `src/query.ts`
  Keep discovery as a prefetch that starts early and is collected after tools.
- `src/services/skillSearch/signals.ts`
  Reuse signal extraction for turn-zero user intent and write-pivot follow-up turns.
- `src/services/skillSearch/localSearch.ts`
  Reuse local-first ranking over already available skills.
- `src/services/skillSearch/prefetch.ts`
  Reuse the background prefetch and collection path instead of moving discovery back into blocking attachment scans.
- `src/services/skillSearch/featureCheck.ts`
  Reuse feature gates and cheap-first checks before doing heavier work.
- `src/services/skillSearch/remoteSkillLoader.ts` and `src/services/skillSearch/remoteSkillState.ts`
  Keep remote logic as a safe fallback, not the primary path.
- `src/Tool.ts` and `src/services/taskState/index.ts`
  Reuse `discoveredSkillNames` so telemetry and TaskState stay aligned.

## Rules

- Keep post-turn discovery non-blocking.
- Prefer local-first ranking before any remote expansion.
- Reuse existing skill registries in `.claude/skills/`, bundled skills, and MCP-provided skills. Do not build another registry.
- Keep `discoveredSkillNames` accurate whenever discovery results are surfaced.
- Do not bypass remote safety stubs just because the local path works.

## Workflow

1. Add or refine signals first.
2. Adjust local ranking and dedupe before touching query loop timing.
3. Only widen remote behavior after the local path and telemetry are stable.
4. Feed newly surfaced skills into existing downstream consumers rather than special-casing new UI or prompt branches.

## Validation

- Run a real Bun check that exercises `createSkillSearchSignal`, `localSkillSearch`, `startSkillDiscoveryPrefetch`, and `collectSkillDiscoveryPrefetch`.
- Confirm surfaced skills update `discoveredSkillNames`.
- Run `bun run version`.
- If you add repo-local project skills, confirm they live under `.claude/skills/<skill-name>/SKILL.md` so the current loader can see them.

## Anti Patterns

- Blocking the main loop on inter-turn skill discovery.
- Jumping to embeddings or remote search before local heuristics are exhausted.
- Surfacing discovered skills without updating downstream telemetry or active-skill state.
- Treating repo-root `skills/*.md` docs as if the runtime loader already consumes them.
