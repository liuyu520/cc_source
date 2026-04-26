---
name: "intent-router-hardening"
description: "Reuse existing intentRouter, localSearch, and prefetch hooks to tune simple-task detection and skill recall de-weighting in both Chinese and English, without hard-suppressing recall for mid-length requests."
when_to_use: "Use this skill when direct requests are mis-classified (too aggressively suppressed or too eagerly escalated) in skill recall, when you add or adjust IntentClass / TaskMode rules, or when you need to separate skill-recall suppression from execution/model-router escalation suppression."
---

# Intent Router Hardening

Use this skill when tuning intent-classification boundaries, especially when direct requests should **down-weight** skill recall instead of being hard-suppressed, or when a new intent class needs different semantics for recall vs. execution/model-router escalation.

## Two Suppression Channels (critical distinction)

`intentRouter.ts` exports **two** suppression predicates — they are **not interchangeable**:

| Function | Returns true for | Consumers | Semantics |
|---|---|---|---|
| `shouldSuppressEscalationForIntent` | `simple_task`, `chitchat` | `executionMode/decision.ts`, `modelRouter/router.ts` | Don't upgrade execution mode / model tier for this query |
| `shouldSuppressSkillRecallForIntent` | `chitchat` **only** | `skillSearch/localSearch.ts` | Don't even attempt skill recall |

Why the split: `simple_task` requests ("update deps", "请修复这个bug") should not escalate execution/model tier, but they can still benefit from a perfectly-matched skill (e.g. `/commit`, `/review`). Hard-suppressing recall for `simple_task` historically caused "skills disappear for ordinary requests" regressions.

## Reuse First

- `src/services/skillSearch/intentRouter.ts`
  - Reuse `classifyIntent()`, `fusionWeightsFor()`, `getTaskModeHints()`.
  - Extend existing regex and priority ordering before introducing new abstractions.
  - `SIMPLE_DIRECT_TASK` targets **真·单动词短指令**: length ≤ 30, Chinese/English verbs only.
  - Chinese lookahead: `(?=$|\s|这|这个|一下|下|到)` (do NOT use `\b` — fails at Unicode boundaries).
  - English: `\b` word boundary works for ASCII verbs.
- `src/services/skillSearch/localSearch.ts`
  - Reuse `localSkillSearch()` pruning / RRF flow.
  - Call `shouldSuppressSkillRecallForIntent()` (not the escalation variant) before recall.
- `src/services/skillSearch/prefetch.ts`
  - Reuse `runDiscoveryDirect()` as the shadow logging hook for intent evidence (env `CLAUDE_SKILL_INTENT_ROUTER=1`).
- `.claude/skills/local-skill-discovery-reuse/SKILL.md`
  - Follow the same local-first, no-new-registry, non-blocking discovery rules.

## Rules

- Keep intent hardening rule-based and local-first.
- Prefer extending `SIMPLE_DIRECT_TASK`, `MODE_KEYWORDS`, or nearby existing logic before adding helper layers.
- **Don't hard-suppress recall** for a task class that has any chance of matching a real skill. Use `fusionWeightsFor(...).minScore` to down-weight instead.
- **Only `chitchat` deserves a hard `return []` in `localSkillSearch`.** Everything else goes through scoring.
- Do not create a second classifier, a second retrieval registry, or a semantic-only bypass.
- Keep `command`, `chitchat`, `simple_task`, `ambiguous`, and `inferred` boundaries explicit and observable.
- When adding a new `IntentClass`, audit BOTH suppression predicates and all 3 consumers (`localSearch`, `executionMode/decision`, `modelRouter/router`).
- When expanding `SIMPLE_DIRECT_TASK`, use Chinese lookahead, not `\b`. Keep the length gate tight (≤ 30) — wider gates re-introduce the false-positive regression.
- `fusionWeightsFor` `minScore: 9999` is a code smell. If a class truly should never recall, use `shouldSuppressSkillRecallForIntent` instead; mixing both doubles the failure surface.

## Current Coverage

Length gate: **`q.length <= 30`**

**Chinese verbs**: 看下, 看看, 解释, 说明, 告诉我, 分析, 检查, 确认, 修复, 添加, 删除, 更新, 运行, 重命名, 移动, 打开
**English verbs**: fix, review, add, run, update, delete, remove, rename, show, find, list, change, move, open, close, read, get, set
**Prefixes stripped**: 请, 帮我, 麻烦, 直接, please

## Weight Table (`fusionWeightsFor`)

| class | wLexical | wSemantic | minScore | Conservative provider override |
|---|---|---|---|---|
| `command` | 1.0 | 0.0 | 50 | — |
| `inferred` | 0.4 | 0.6 | 20 | 0.35 / 0.45 / 35 |
| `ambiguous` | 0.6 | 0.4 | 30 | 0.2 / 0.1 / **9999** (hard-suppressed on thirdParty) |
| `simple_task` | 0.25 | 0.2 | **120** (de-weight, not suppress) | — |
| `chitchat` | 0 | 0 | 9999 (also hard-short-circuited in localSearch) | — |

## Workflow

1. Reproduce the mis-classification with a real query string.
2. Read `classifyIntent()` and determine whether the issue is in:
   - `SIMPLE_DIRECT_TASK` (length or verb coverage)
   - `MODE_KEYWORDS`
   - slash-command handling
   - short-query fallback
3. If the request should bypass recall entirely → it is `chitchat`. Otherwise adjust weights, not the predicate.
4. Re-check all 3 downstream consumers when a new intent class changes behavior.
5. Use `CLAUDE_SKILL_INTENT_ROUTER=1` for shadow logs; do not add a parallel logger.

## Validation

Real Bun one-liner that covers both predicates and the fusion weights:

```bash
bun -e "import('./src/services/skillSearch/intentRouter.ts').then(m => {
  const cases = ['帮我看下 X','请修复这个bug','update deps','fix','hello','/commit','重构 auth 模块'];
  for (const q of cases) {
    const r = m.classifyIntent(q);
    console.log(JSON.stringify({q, class:r.class, suppressSkillRecall: m.shouldSuppressSkillRecallForIntent(r), suppressEscalation: m.shouldSuppressEscalationForIntent(r), weights: m.fusionWeightsFor(r.class)}));
  }
})"
```

Expected:
- `chitchat`: `suppressSkillRecall: true`
- `simple_task`: `suppressSkillRecall: false`, `suppressEscalation: true`, `minScore: 120`
- `command` / `ambiguous` / `inferred`: `suppressSkillRecall: false`, `suppressEscalation: false`

Run `bun "./src/bootstrap-entry.ts" --version` after changes.

## Anti-Patterns

- Folding `simple_task` back into `shouldSuppressSkillRecallForIntent` — re-creates the "skills disappear for ordinary requests" regression.
- Widening `SIMPLE_DIRECT_TASK` length gate past 30 without adding exclusion anchors.
- Setting `minScore: 9999` when de-weighting is sufficient (it's a magic-number equivalent of hard-disabling).
- Using `\b` word boundary for Chinese text.
- Adding a new classifier file for what is a boundary fix in `intentRouter.ts`.
- Letting a new `IntentClass` affect recall in one place while downstream routing still executes normally — audit all 3 consumers.
