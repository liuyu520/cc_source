---
description: Layered skill recall with intent classification — zero-cost Layer-A router that classifies user queries into intent classes and task modes before keyword/semantic search.
---

# Intent Recall

Use this skill when you need to **improve skill discovery accuracy**, add new task-mode recognition rules, tune fusion weights between lexical and semantic recall layers, or extend the retrieval pipeline with a new recall dimension.

## Overview

The existing skill search (`localSearch.ts`) uses two-dimensional RRF (keyword + context). Intent Recall adds a **Layer-A zero-cost classifier** that runs before search and produces:

1. **IntentClass** — how clear the user's intent is (`command | inferred | ambiguous | chitchat`)
2. **TaskMode** — what kind of work they're doing (`code_edit | debug | git_workflow | test | deps | …`)

These signals dynamically adjust fusion weights so that explicit commands get pure lexical matching while vague queries lean on semantic matching (Layer-C, future).

## Architecture

```
user query
  │
  ├── classifyIntent(query)       // Layer-A: regex + keyword, 0 tokens
  │     └── { class, taskMode, evidence, confidence }
  │
  ├── localSkillSearch(signal)    // Layer-B: existing keyword + context RRF
  │
  ├── (future) semanticSearch()   // Layer-C: embedding KNN
  │
  └── fusionWeightsFor(class)     // dynamic weight selection
        ├── command:   wLex=1.0, wSem=0.0, minScore=50
        ├── inferred:  wLex=0.4, wSem=0.6, minScore=20
        ├── ambiguous: wLex=0.6, wSem=0.4, minScore=30
        └── chitchat:  wLex=0,   wSem=0,   minScore=9999 (no recall)
```

## IntentClass

| Class | Trigger | Confidence | Example |
|-------|---------|------------|---------|
| `command` | `/commit`, `/review` | 0.95 | `/commit -m "fix bug"` |
| `inferred` | Task keyword matched | 0.75 | `"fix the auth bug in login"` |
| `ambiguous` | ≤3 words, no keyword | 0.30 | `"clean this"` |
| `chitchat` | Greeting/ack, <20 chars | 0.85 | `"thanks"`, `"ok"` |

## TaskMode (10 categories)

Priority-ordered scan — first match wins:

| Priority | Mode | Pattern Examples |
|----------|------|------------------|
| 1 | `git_workflow` | commit, push, pull, merge, rebase, branch, PR |
| 2 | `test` | test, spec, jest, vitest, pytest, coverage |
| 3 | `debug` | debug, fix, bug, error, crash, exception |
| 4 | `deps` | install, upgrade, package.json, pnpm, npm |
| 5 | `refactor` | refactor, rename, extract, restructure |
| 6 | `code_edit` | add, implement, write, create, update, modify |
| 7 | `shell_ops` | bash, shell, command, script, chmod |
| 8 | `data_query` | sql, query, select, join, database |
| 9 | `docs_read` | docs, readme, explain, understand |
| 10 | `review` | review, audit, inspect, lint |

## Adding a New TaskMode

1. Add the mode to the `TaskMode` type in `intentRouter.ts`
2. Insert a `[mode, /regex/i]` entry into `MODE_KEYWORDS` at the right priority position
3. Add a case to `guessModeFromCommandName` for slash-command → mode mapping
4. (Optional) Add a static skill mapping for the mode in a future `taskModeSkills.ts`

Example — adding `deploy` mode:

```typescript
// In MODE_KEYWORDS (insert between deps and refactor):
['deploy', /\b(deploy|ship|release|publish|rollout)\b/i],

// In guessModeFromCommandName:
if (/(deploy|release|publish)/.test(n)) return 'deploy'
```

## Prefetch Integration

The router is wired into `prefetch.ts:runDiscoveryDirect` as a shadow observer:

```typescript
if (process.env.CLAUDE_SKILL_INTENT_ROUTER === '1') {
  try {
    const { classifyIntent } = await import('./intentRouter.js')
    const intent = classifyIntent(signal.query)
    logForDebugging(
      `[SkillRecall:intent] class=${intent.class} mode=${intent.taskMode} ` +
        `conf=${intent.confidence} ev=${intent.evidence.join('|')}`,
    )
  } catch { /* shadow — never blocks */ }
}
```

## Env Vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAUDE_SKILL_INTENT_ROUTER` | off | Enable intent classification shadow logging |

## Observability

- Debug log tag: `[SkillRecall:intent]`
- Fields logged: `class`, `taskMode`, `confidence`, `evidence`

## Reuse Across Subsystems

The same `classifyIntent` function can drive:

- **Memory recall** (`getRelevantMemoryAttachments`) — skip recall on `chitchat`, boost on `debug`
- **MCP tool selection** — filter long tool lists by `taskMode`
- **Agent subtype dispatch** — map `taskMode` → preferred `subagent_type`
- **Dream pipeline triage** — use `taskMode` distribution as a novelty signal

This is why `intentRouter.ts` lives in `skillSearch/` but exports a generic `IntentResult` — it's a **shared harness primitive** masquerading as a skill-search helper.

See `examples/multi-trigger.md` for the multi-entry-point pattern.
