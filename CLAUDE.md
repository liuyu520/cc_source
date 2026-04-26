# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **restored Claude Code source tree** reconstructed from source maps, with modifications to bypass Anthropic's preflight authentication checks. It supports any Anthropic-compatible third-party LLM API (e.g., MiniMax-M2.7). Package version: `260405.0.0-hanjun`.

## 提交代码时注意
必须排除 bin/ 目录下的磁盘文件


## Development Commands

```bash
bun install              # Install dependencies (including local shim packages)
bun run dev              # Start the CLI (main entry: src/bootstrap-entry.ts)
bun run start            # Alias for dev
bun run version          # Print CLI version
bun run dev:restore-check  # Scan missing imports, output restoration status report
```

There are **no lint, test, or build scripts**. Bun runs TypeScript directly. Validation is manual smoke-testing: boot the CLI, verify the affected feature path.

## Runtime Requirements

- **Bun >= 1.3.5**
- **Node.js >= 24**

## Environment Variables for Third-Party API

```bash
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic  # Third-party API endpoint
ANTHROPIC_API_KEY=YOUR_KEY                               # API key
ANTHROPIC_MODEL=MiniMax-M2.7                             # Model name override
```

Also supports `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` for other providers.

## Architecture

### Startup Chain

1. `src/bootstrap-entry.ts` — Sets global MACROs (VERSION, BUILD_TIME), dynamically imports the CLI entry
2. `src/entrypoints/cli.tsx` — `main()`: handles `--version`, `--dump-system-prompt`, MCP modes, or full CLI startup
3. `src/main.tsx` (~4690 lines) — Commander.js command setup, auth/policy init, calls `launchRepl()`
4. `src/replLauncher.tsx` — Renders `<App>` + `<REPL>` into the Ink terminal UI

### Core Source Layout (`src/`)

| Directory | Purpose |
|-----------|---------|
| `entrypoints/` | CLI, MCP, SDK entry points |
| `commands/` | ~100 slash commands (commit, review, mcp, plugin, etc.) |
| `commands.ts` | Command registry — aggregates all command imports |
| `tools/` | ~54 AI tools (Bash, FileEdit, Grep, Agent, etc.) |
| `tools.ts` | Tool registry |
| `Tool.ts` | Tool base type definition |
| `components/` | ~148 React/Ink terminal UI components |
| `screens/` | Top-level screens: REPL, Doctor, ResumeConversation |
| `services/` | API client, MCP, analytics, compact, LSP, OAuth |
| `services/api/claude.ts` | Core Claude API interaction (~3400 lines) |
| `services/api/client.ts` | Anthropic SDK client creation (first-party/Bedrock/Vertex/Foundry) |
| `services/mcp/` | MCP connection management, config, permissions |
| `hooks/` | ~87 React hooks |
| `ink/` | Custom Ink terminal rendering engine (DOM, layout, focus, cursor) |
| `state/` | AppState management (Store pattern) |
| `utils/` | ~335 utility modules |
| `utils/model/` | Model config, provider routing, capability detection |
| `constants/` | System constants, prompts, API limits |
| `skills/` | Bundled skills (claude-api, verify) |
| `coordinator/` | Multi-agent coordinator mode |
| `query.ts` / `QueryEngine.ts` | Single query execution and message/tool-call loop |

### Key Support Directories

| Directory | Purpose |
|-----------|---------|
| `shims/` | 7 local npm packages replacing unrecoverable private/native modules |
| `vendor/` | 4 native module source stubs (audio-capture, image-processor, modifiers-napi, url-handler) |

### Tech Stack

- **Language**: TypeScript (ESM, react-jsx, strict: false)
- **Runtime**: Bun + Node.js
- **UI**: React + Ink (terminal TUI) with custom rendering engine in `src/ink/`
- **AI SDK**: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`
- **MCP**: `@modelcontextprotocol/sdk`
- **CLI**: Commander.js (`@commander-js/extra-typings`)
- **Observability**: OpenTelemetry
- **Experiments**: GrowthBook

## Coding Conventions

- Match surrounding file style exactly (many files omit semicolons)
- Single quotes, camelCase variables/functions, PascalCase for React components and Manager classes
- kebab-case for command directory names (e.g., `src/commands/install-slack-app/`)
- Keep imports stable when comments warn against reordering
- Prefer small, focused modules over broad utility dumps

## Restoration-Specific Notes

- Many files end with base64 source map comments — this is expected
- Feature flags via `feature()` from `bun:bundle` control dead-code elimination (e.g., `BRIDGE_MODE`, `COORDINATOR_MODE`, `VOICE_MODE`)
- `process.env.USER_TYPE === 'ant'` gates Anthropic-internal functionality
- Some modules contain restoration-time fallbacks; document any new workarounds
- All dependency versions in package.json use `*` wildcards
- The 7 shim packages in `shims/` provide stub implementations for private Anthropic packages (`@ant/*`) and native NAPI modules

## Third-Party API Integration Points

The key files modified for third-party API support:
- `src/utils/model/providers.ts` — `isFirstPartyAnthropicBaseUrl()` check
- `src/utils/model/model.ts` — `getMainLoopModel()` respects `ANTHROPIC_MODEL` env var
- `src/services/api/client.ts` — SDK client creation with custom base URL
