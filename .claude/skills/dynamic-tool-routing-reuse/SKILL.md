---
name: "dynamic-tool-routing-reuse"
description: "Reuse the toolRouter dynamic tool set pattern (Tier1 always-on + Tier2 LRU/intent unlock + fallback safety) when adding new tools to the routing table, extending intent keyword detection, or implementing similar demand-driven resource filtering for third-party APIs."
---

# Dynamic Tool Routing Reuse

Use this skill when adding new tools to the Tier1/Tier2 routing table, extending intent keyword detection for tool unlock, implementing similar demand-driven resource filtering (e.g., MCP tool subsets), or debugging tool availability issues in third-party API mode.

## Architecture Overview

```
User message → processUserInput.ts:156
                 ↓
              recordUserPrompt(text)         ← intent keyword scan
                 ↓
tools.ts:319 → getTools()
                 ↓
              shouldIncludeToolInDynamicSet(name)
              ├── isDynamicToolsEnabled()? no → true (passthrough to CORE_TOOL_NAMES)
              ├── fallbackToFullSet? yes → true (safety valve)
              ├── TIER1_TOOL_NAMES.has(name)? → true (always available)
              ├── usedTools.has(name)? → true (LRU sticky)
              ├── intentUnlocked.has(name)? → true (keyword match)
              └── false (tool not in current dynamic set)

Tool execution → toolExecution.ts
  ├── tool found (:426) → recordToolUsage(name)    ← LRU sticky
  └── unknown tool (:375) → recordUnknownToolFallback()  ← safety valve
```

Three unlock mechanisms work in parallel:
1. **LRU sticky**: Once a tool is called, it stays in the set for the process lifetime
2. **Intent keywords**: User message contains trigger words → corresponding tools unlocked
3. **Fallback safety**: Model tries an unavailable tool → ALL tools unlocked permanently

## Reuse First

- `src/utils/toolRouter.ts` — Full implementation (215 lines)
  Exports: `shouldIncludeToolInDynamicSet`, `recordToolUsage`, `recordUserPrompt`, `recordUnknownToolFallback`, `isDynamicToolsEnabled`, `isFallbackActive`, `getUnlockedTier2`, `resetToolRouter`.

- `src/utils/toolRouter.ts:30` — `TIER1_TOOL_NAMES` / `:41` — `TIER2_TOOL_NAMES`
  The tool classification. Tier1 (5 tools) covers 90%+ of coding tasks. Tier2 (11 tools) are the remaining CORE_TOOL_NAMES. Add new tools to the appropriate set.

- `src/utils/toolRouter.ts:59` — `INTENT_KEYWORDS`
  Array of `{ tools, words }` objects. 8 keyword groups covering web, file creation, agents, notebooks, LSP, user interaction, and task management. Add new keyword groups here.

- `src/tools.ts:319` — Third-party tool filter integration
  The actual filter call: `toolRouter.shouldIncludeToolInDynamicSet(tool.name)`. Uses `require()` (sync) with try/catch fallback. The filter is applied AFTER `CORE_TOOL_NAMES` membership check — toolRouter only narrows, never widens.

- `src/services/tools/toolExecution.ts:426` — LRU recording hook
  `recordToolUsage(tool.name)` called when a tool is found and about to execute. This is the LRU mechanism — once used, always available.

- `src/services/tools/toolExecution.ts:375` — Fallback safety hook
  `recordUnknownToolFallback(reason)` called when model requests a tool not in the current set. Flips the permanent fallback flag.

- `src/utils/processUserInput/processUserInput.ts:156` — Intent scan hook
  `recordUserPrompt(inputString)` called on user message input. Scans for intent keywords and unlocks corresponding Tier2 tools.

## Tier Classification

| Tier | Tools | Unlock condition | Schema cost |
|------|-------|-----------------|-------------|
| Tier1 | Bash, Read, Edit, Glob, Grep (5) | Always available | ~800 tokens |
| Tier2 | Write, Agent, WebFetch, WebSearch, NotebookEdit, LSP, AskUserQuestion, TaskStop, DelegateToExternalAgent, CheckDelegateStatus, GetDelegateResult (11) | LRU / intent / fallback | ~1700 tokens |
| Full set | All 16 CORE_TOOL_NAMES | CLAUDE_CODE_FULL_TOOLS=1 or fallback active | ~2500 tokens |

## Intent Keywords

| Keyword group | Target tools | Example triggers |
|--------------|-------------|-----------------|
| Web access | WebFetch, WebSearch | `https://`, `www.`, `fetch`, `url`, `搜索`, `网页` |
| File creation | Write | `新文件`, `create file`, `写入文件` |
| Sub-agent | Agent | `agent`, `子代理`, `并行`, `分派`, `调研` |
| External delegation | DelegateToExternalAgent + Check + Get | `codex`, `gemini`, `委派`, `external agent` |
| Notebook | NotebookEdit | `.ipynb`, `notebook`, `jupyter` |
| LSP | LSP | `lsp`, `diagnostics`, `跳转定义` |
| User interaction | AskUserQuestion | `问我`, `ask me`, `请确认` |
| Task management | TaskStop | `停止任务`, `kill task`, `终止任务` |

## Common Tasks

### Adding a new Tier2 tool

1. Add tool name to `TIER2_TOOL_NAMES` set in `toolRouter.ts:41`:
```typescript
export const TIER2_TOOL_NAMES: ReadonlySet<string> = new Set([
  // ... existing tools
  'MyNewTool',
])
```

2. Add intent keywords (if the tool has natural language triggers):
```typescript
const INTENT_KEYWORDS = [
  // ... existing groups
  {
    tools: ['MyNewTool'],
    words: ['my trigger', '我的触发词'],
  },
]
```

3. Ensure the tool name is in `CORE_TOOL_NAMES` in `tools.ts:310` — toolRouter only filters within CORE_TOOL_NAMES, never adds tools outside it.

### Moving a tool from Tier2 to Tier1

1. Remove from `TIER2_TOOL_NAMES`, add to `TIER1_TOOL_NAMES`:
```typescript
export const TIER1_TOOL_NAMES: ReadonlySet<string> = new Set([
  // ... existing 5
  'Write',  // promoted: commonly used even in simple tasks
])
```

2. Remove any intent keywords for the promoted tool (now always available, no trigger needed).

### Adding a new intent keyword group

1. Add to `INTENT_KEYWORDS` array in `toolRouter.ts:59`:
```typescript
{
  tools: ['TargetTool1', 'TargetTool2'],
  words: ['keyword1', 'keyword2', '中文关键词'],
},
```

2. Keywords are case-insensitive, substring match (`text.toLowerCase().includes(word.toLowerCase())`).
3. Keep keywords specific enough to avoid false positives — `"file"` would unlock Write on nearly every coding message.

### Implementing similar demand-driven filtering for other resources

Follow the same three-mechanism pattern:
1. **Always-on set**: resources needed in 90%+ of sessions
2. **Demand-triggered set**: unlocked by user action or content analysis
3. **Safety fallback**: if the model or system needs a resource that's unavailable, unlock all

Example: MCP tool subset filtering
```typescript
const MCP_TIER1 = new Set(['tool1', 'tool2'])  // always available
const mcpUsed = new Set<string>()               // LRU sticky
let mcpFallback = false                         // safety valve

function shouldIncludeMCPTool(name: string): boolean {
  if (mcpFallback) return true
  if (MCP_TIER1.has(name)) return true
  if (mcpUsed.has(name)) return true
  return false
}
```

## Gate Hierarchy

```
CLAUDE_CODE_FULL_TOOLS=1     → ALL tools (overrides everything)
CLAUDE_CODE_SIMPLE=1         → SIMPLE tools only (overrides dynamic)
CLAUDE_CODE_DYNAMIC_TOOLS=1  → dynamic routing (this skill)
fallbackToFullSet=true        → ALL CORE_TOOL_NAMES (safety override)
(default)                     → fixed CORE_TOOL_NAMES (no dynamic routing)
```

The env var checks in `tools.ts` run BEFORE toolRouter — `FULL_TOOLS` and `SIMPLE` bypass dynamic routing entirely. This is by design: the router only narrows within the normal third-party set.

## Integration Points

| Component | File | Key line |
|-----------|------|----------|
| Tier1/Tier2 sets | `toolRouter.ts` | :30, :41 |
| Intent keywords | `toolRouter.ts` | :59 (`INTENT_KEYWORDS`) |
| Filter entry | `toolRouter.ts` | :187 (`shouldIncludeToolInDynamicSet`) |
| LRU recording | `toolRouter.ts` | :129 (`recordToolUsage`) |
| Intent scanning | `toolRouter.ts` | :141 (`recordUserPrompt`) |
| Fallback trigger | `toolRouter.ts` | :166 (`recordUnknownToolFallback`) |
| Tool filter integration | `tools.ts` | :330 (thirdParty branch) |
| LRU hook | `toolExecution.ts` | :426 |
| Fallback hook | `toolExecution.ts` | :375 |
| Intent scan hook | `processUserInput.ts` | :156 |

## Rules

- toolRouter only NARROWS the tool set, never WIDENS it. Tools must be in `CORE_TOOL_NAMES` (tools.ts) to be eligible at all.
- `TIER1_TOOL_NAMES ∪ TIER2_TOOL_NAMES` should equal the set of tools in `CORE_TOOL_NAMES` that toolRouter knows about. Any tool NOT in either set is implicitly Tier1 (always passes through).
- The fallback mechanism (`recordUnknownToolFallback`) is permanent for the process — once triggered, dynamic routing is effectively disabled. This is intentional: a single unknown-tool error means the model's expectations don't match the tool set.
- Intent keyword matching is case-insensitive substring. Avoid overly short/generic keywords like `"file"`, `"test"`, `"run"` that would unlock tools on nearly every message.
- All module-scope state (`usedTools`, `intentUnlocked`, `fallbackToFullSet`) is process-local. There's no persistence — state resets when the process restarts.
- `isDynamicToolsEnabled()` defaults to OFF. This is opt-in (`CLAUDE_CODE_DYNAMIC_TOOLS=1`) to avoid behavior changes for existing users.
- Trigger hooks (`recordToolUsage`, `recordUserPrompt`, `recordUnknownToolFallback`) use `require()` with try/catch — toolRouter.ts import failures must never block tool execution.

## Validation

- Dynamic tools disabled (default): `bun -e "import { isDynamicToolsEnabled } from './src/utils/toolRouter.ts'; console.log(isDynamicToolsEnabled())"` → `false`
- Dynamic tools enabled: `CLAUDE_CODE_DYNAMIC_TOOLS=1 bun -e "import { shouldIncludeToolInDynamicSet } from './src/utils/toolRouter.ts'; console.log('Bash:', shouldIncludeToolInDynamicSet('Bash'), 'Write:', shouldIncludeToolInDynamicSet('Write'))"` → `Bash: true, Write: false`
- Intent unlock: `CLAUDE_CODE_DYNAMIC_TOOLS=1 bun -e "import { recordUserPrompt, shouldIncludeToolInDynamicSet } from './src/utils/toolRouter.ts'; recordUserPrompt('请帮我fetch这个url'); console.log('WebFetch:', shouldIncludeToolInDynamicSet('WebFetch'))"` → `WebFetch: true`
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Adding tools to Tier1 "just in case" — defeats the purpose. Only promote if the tool is genuinely needed in 90%+ of sessions.
- Using regex for intent matching — unnecessary performance cost. Substring match (`includes`) is sufficient and faster.
- Making the fallback temporary (auto-reset after N turns) — a model that tried an unavailable tool will likely try again. Permanent fallback is safer.
- Putting demand-driven logic in `tools.ts` itself — keep routing decisions in `toolRouter.ts` and the simple filter call in `tools.ts`.
- Creating separate route tables per provider — the current design works with any `CORE_TOOL_NAMES` set. Provider-specific tool sets are handled by `tools.ts`, not `toolRouter.ts`.
- Forgetting the try/catch around `require('./toolRouter.js')` — if the module fails to load, tool execution must still work (fall back to full set behavior).
