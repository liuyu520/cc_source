---
name: "plugin-prompt-injection-reuse"
description: "Reuse existing pluginPromptSections registry, systemPromptSection cache wrapper, and plugin enable/disable registration flow when adding custom system prompt sections from plugins, extending prompt injection points, or wiring new plugin types into the prompt pipeline."
---

# Plugin Prompt Injection Reuse

Use this skill when a plugin (builtin or marketplace) needs to inject content into the system prompt, when extending the prompt section registry API, when wiring new plugin lifecycle events to prompt registration, or when debugging missing/stale plugin prompt sections.

## Architecture Overview

```
BuiltinPluginDefinition.systemPromptSections     ← types/plugin.ts:32
LoadedPlugin.systemPromptSections                ← types/plugin.ts:74
         ↓
registerPluginPromptSection(entry)               ← pluginPromptSections.ts:45
         ↓
registeredSections[]  (module-level array)        ← pluginPromptSections.ts:37
         ↓
getPluginPromptSections()                         ← pluginPromptSections.ts:73
         ↓
systemPromptSection(name, compute)               ← systemPromptSections.ts, cache wrapper
         ↓
prompts.ts dynamicSections array                  ← prompts.ts:623
         ↓
resolveSystemPromptSections(dynamicSections)      ← systemPromptSections.ts, batch resolve
         ↓
final system prompt string
```

Two registration paths exist:
1. **Builtin plugins**: `builtinPlugins.ts:97-114` — registers on enable, removes on disable
2. **Marketplace plugins**: `refresh.ts:169-179` — clears all, re-registers on refresh

## Reuse First

- `src/services/pluginPromptSections.ts` — Registry module (4 exported functions)
  - `registerPluginPromptSection(entry)` — Register a section. Same pluginName+sectionName pair deduplicates (last wins). Content can be static string or `() => string | null` function.
  - `removePluginPromptSections(pluginName)` — Remove all sections for a plugin (call on disable).
  - `getPluginPromptSections()` — Returns `SystemPromptSection[]` wrapped via `systemPromptSection()`. Each section name is prefixed `plugin_{pluginName}_{sectionName}` to avoid collisions with built-in sections.
  - `clearPluginPromptSections()` — Empties the registry (used by refresh and tests).

- `src/constants/systemPromptSections.ts` — `systemPromptSection(name, compute)`
  Creates a cached section. Compute function runs once, result cached until `/clear` or `/compact`. Use `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` only for truly volatile content (breaks prompt cache).

- `src/constants/prompts.ts:623-624` — Consumption point
  ```typescript
  ...getPluginPromptSections(),
  ```
  Spread into `dynamicSections` array, resolved alongside built-in dynamic sections by `resolveSystemPromptSections()`.

- `src/types/plugin.ts:32-35` — `BuiltinPluginDefinition.systemPromptSections`
  Content can be string or function (`() => string | null`). Functions enable dynamic content based on runtime state.

- `src/types/plugin.ts:74-77` — `LoadedPlugin.systemPromptSections`
  Content is static string only (serialization-safe for marketplace plugins loaded from disk).

- `src/plugins/builtinPlugins.ts:97-114` — Builtin plugin registration flow
  When `isEnabled`: iterates `definition.systemPromptSections`, calls `registerPluginPromptSection()` for each. When disabled: calls `removePluginPromptSections(name)`.

- `src/utils/plugins/refresh.ts:169-179` — Marketplace plugin refresh flow
  Calls `clearPluginPromptSections()` first, then re-registers all enabled plugins' sections. This ensures stale sections from removed plugins are cleaned up.

## Common Tasks

### Registering a static prompt section from a builtin plugin

1. Add `systemPromptSections` to your `BuiltinPluginDefinition`:
```typescript
registerBuiltinPlugin({
  name: 'my-plugin',
  description: 'My awesome plugin',
  systemPromptSections: [
    {
      name: 'guidelines',
      content: 'Always follow XYZ conventions when editing files in this project.',
    },
  ],
})
```
Done. The `builtinPlugins.ts` registration flow handles enable/disable automatically.

### Registering a dynamic prompt section (computed at runtime)

Use a function for content that depends on runtime state:
```typescript
registerBuiltinPlugin({
  name: 'context-aware-plugin',
  description: 'Adapts to project context',
  systemPromptSections: [
    {
      name: 'project-rules',
      content: () => {
        const settings = getInitialSettings()
        if (!settings.myFeatureEnabled) return null  // null = section omitted
        return `Project-specific rules: ${settings.myRules}`
      },
    },
  ],
})
```
Return `null` to omit the section entirely. The `systemPromptSection()` wrapper caches the result.

### Registering from a marketplace plugin

Marketplace plugins use static strings only. Add `systemPromptSections` to `LoadedPlugin`:
```typescript
const plugin: LoadedPlugin = {
  name: 'external-plugin',
  // ... other fields
  systemPromptSections: [
    { name: 'coding-style', content: 'Use tabs, not spaces.' },
  ],
}
```
The `refresh.ts` flow at line 169-179 handles registration during `refreshActivePlugins()`.

### Adding a new registration trigger point

If a new plugin lifecycle event needs to trigger section registration:
1. Import `registerPluginPromptSection` and `removePluginPromptSections` from `src/services/pluginPromptSections.js`
2. Call `registerPluginPromptSection()` when the plugin is activated
3. Call `removePluginPromptSections(pluginName)` when deactivated
4. Follow the `builtinPlugins.ts` pattern — always pair registration with removal

### Debugging missing plugin prompt sections

1. Set `CLAUDE_CODE_DEBUG=1` and use `--dump-system-prompt` flag
2. Check if the plugin is in the `enabled` list (not `disabled`)
3. Verify the section name isn't colliding — sections are prefixed `plugin_{pluginName}_{sectionName}`
4. For marketplace plugins, verify `refreshActivePlugins()` was called (check for `refreshActivePlugins:` log lines)
5. For dynamic content, check if the function returns `null` (section is omitted when null)

## Rules

- Plugin prompt sections are **cached** by `systemPromptSection()` — they compute once and persist until `/clear` or `/compact`. Do not use them for truly volatile state. Use `DANGEROUS_uncachedSystemPromptSection` only with explicit reason.
- Section names are auto-prefixed with `plugin_{pluginName}_{sectionName}` — no risk of collision with built-in sections like `tools`, `mcp`, `brief`.
- Same pluginName+sectionName pair is deduplicated (last registration wins). This is safe for idempotent re-registration.
- `clearPluginPromptSections()` must be called before re-registering all plugins during refresh — otherwise disabled plugins' sections persist.
- `LoadedPlugin.systemPromptSections` content is string-only (not functions). Only `BuiltinPluginDefinition` supports function content.
- Always pair `registerPluginPromptSection()` with `removePluginPromptSections()` on disable — orphaned sections pollute the system prompt.

## Integration Points

| Component | File | Key location |
|-----------|------|-------------|
| Registry module | `src/services/pluginPromptSections.ts` | full file (90 lines) |
| Register function | `pluginPromptSections.ts` | line 45 (`registerPluginPromptSection`) |
| Remove function | `pluginPromptSections.ts` | line 60 (`removePluginPromptSections`) |
| Get sections | `pluginPromptSections.ts` | line 73 (`getPluginPromptSections`) |
| Clear registry | `pluginPromptSections.ts` | line 88 (`clearPluginPromptSections`) |
| Cache wrapper | `src/constants/systemPromptSections.ts` | `systemPromptSection()` |
| Consumption in prompt | `src/constants/prompts.ts` | line 623 (`...getPluginPromptSections()`) |
| Builtin definition type | `src/types/plugin.ts` | line 32-35 |
| LoadedPlugin type | `src/types/plugin.ts` | line 74-77 |
| Builtin registration | `src/plugins/builtinPlugins.ts` | line 97-114 |
| Refresh registration | `src/utils/plugins/refresh.ts` | line 169-179 |

## Validation

- Create a builtin plugin with `systemPromptSections`, run CLI with `--dump-system-prompt`, verify the section content appears in the output.
- Disable the plugin, dump prompt again, verify the section is gone.
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Directly modifying the `dynamicSections` array in `prompts.ts` for plugin-specific content — use the registry instead.
- Forgetting `clearPluginPromptSections()` before re-registration in refresh paths — causes disabled plugin sections to persist.
- Using function content in `LoadedPlugin.systemPromptSections` — only `BuiltinPluginDefinition` supports functions. Marketplace plugins serialize from disk.
- Creating a parallel prompt injection mechanism instead of using the existing registry — all plugin prompt sections should flow through `pluginPromptSections.ts`.
- Using `DANGEROUS_uncachedSystemPromptSection` without a documented reason — it breaks prompt caching and increases API costs.
- Registering sections without a corresponding removal path — leads to orphaned sections when plugins are disabled or removed.
