# Procedural Memory

Shadow-first procedural learning built on top of existing primitives:

- Evidence source: `EvidenceLedger` domain `procedural`
- Raw signal: repeated tool batches captured at the end of `query.ts`
- Learning hook: `autoDream.ts` runs `runProceduralLearningCycle()` when the dream gate fires
- Candidate store: `<auto-memory>/procedural/candidates/*.md`
- Promote target: `~/.claude/macros/*.json` when `CLAUDE_PROCEDURAL=on`

## Modes

- `CLAUDE_PROCEDURAL=off`: disabled
- `CLAUDE_PROCEDURAL=shadow`: capture tool sequences and write candidate memories
- `CLAUDE_PROCEDURAL=on`: capture, write candidates, and promote matching candidates into macro JSON

## Notes

- This module reuses the shared `EvidenceLedger`; it does not create a new journal.
- Candidate files include `confidence`, `ttl_days`, and `last_verified_at` so they can decay later.
- Promotion is additive only; existing macros are not deleted or rewritten unless the mined shape changes.
