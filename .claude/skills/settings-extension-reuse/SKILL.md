---
name: "settings-extension-reuse"
description: "Reuse existing SettingsSchema, settings loading/caching, onChangeAppState side-effect pattern, and multi-source merge when adding new settings fields, integrating settings-driven features, or wiring settings changes to runtime behavior."
---

# Settings Extension Reuse

Use this skill when adding new fields to settings.json, wiring settings changes to runtime behavior, adding new settings sources, or debugging settings loading/caching issues.

## Settings Lifecycle

```
SettingsSchema (Zod)            ← types.ts:255, defines valid fields
         ↓
getSettingsForSource(source)    ← settings.ts:309, reads one source file
         ↓
getInitialSettings()            ← settings.ts:812, merges all sources with lodash mergeWith
         ↓
AppState.settings               ← stored in app state
         ↓
onChangeAppState()              ← onChangeAppState.ts:44, diff-driven side effects
         ↓
clearXxxCache() / apply...()    ← runtime behavior update
```

## Reuse First

- `src/utils/settings/types.ts` — `SettingsSchema` (line 255)
  Zod v4 schema wrapped in `lazySchema()`. All fields MUST be `.optional()`. Uses `.passthrough()` to preserve unknown fields. Backward compat rules at line 209-240: only add optional fields, never remove or tighten.

- `src/utils/settings/settings.ts` — Settings loading
  - `getInitialSettings()` (line 812) — main entry, returns merged `SettingsJson`. Uses internal cache.
  - `getSettingsForSource(source)` (line 309) — reads and parses a single source. Cached per source.
  - `getSettingsWithSources()` (line 836) — returns merge + per-source originals. Resets cache first.
  - `getSettingsWithErrors()` (line 856) — merge all sources with `lodash-es/mergeWith`.
  - `resetSettingsCache()` — clears the internal cache. Called by `getSettingsWithSources`.

- `src/utils/settings/settingsCache.ts` — File-level cache
  Avoids repeated disk I/O. Invalidated when `getSettingsWithSources()` is called.

- `src/state/onChangeAppState.ts` — Side effects on change (line 44)
  Pattern: `if (newState.xxx !== oldState.xxx) { doSomething() }`. Already handles: model changes → persist to userSettings, settings changes → clear auth caches + clear provider capability cache + apply env vars, verbose/expandedView → persist to global config.

- `src/utils/settings/applySettingsChange.ts` — Disk write path
  `updateSettingsForSource(source, patch)` writes changes back to the settings file.

- `src/utils/settings/allErrors.ts` — Extended error reporting
  `getSettingsWithAllErrors()` (line 23) includes MCP and other extension errors.

## Common Tasks

### Adding a new settings field

1. Add Zod field to `SettingsSchema` in `src/utils/settings/types.ts`:
```typescript
myNewField: z.string().optional().describe('What this field does'),
```
RULES:
- MUST be `.optional()` (backward compat)
- Use `.describe()` for documentation
- For complex types, use `.passthrough()` on nested objects for forward compat
- For records/maps, use `z.record(z.string(), z.object({...}).passthrough()).optional()`

2. Access the field:
```typescript
import { getInitialSettings } from 'src/utils/settings/settings.js'
const settings = getInitialSettings()
const value = settings.myNewField  // typed from schema
```

3. If the field needs runtime reaction on change, add to `onChangeAppState.ts`:
```typescript
if (newState.settings !== oldState.settings) {
  // your side effect here
}
```
Use the EXISTING settings diff block — do not create a new one.

### Adding a memoized feature that depends on settings

Follow the `resolveCapabilities` pattern:
1. Implement core logic with `lodash/memoize`
2. Export a `clearXxxCache()` function
3. Wire `clearXxxCache()` into `onChangeAppState.ts` settings diff block
4. Import from `src/state/onChangeAppState.ts` using relative path

Example:
```typescript
// myFeature.ts
import memoize from 'lodash/memoize.js'
const computeMemo = memoize(computeImpl, (key) => key)
export function compute(key: string) { return computeMemo(key) }
export function clearComputeCache() { computeMemo.cache.clear?.() }

// onChangeAppState.ts — add to existing settings diff block:
import { clearComputeCache } from '../path/to/myFeature.js'
// inside if (newState.settings !== oldState.settings):
clearComputeCache()
```

### Adding a new settings source

Settings sources are defined in `src/utils/settings/settings.ts`. Each source maps to a file path. Existing sources: `userSettings` (~/.claude/settings.json), `localSettings` (.claude/settings.local.json), `projectSettings` (.claude/settings.json), `flagSettings`, `policySettings`, managed settings.

To add a new source:
1. Add to `SettingsSource` type
2. Add path mapping in `getSettingsPath()`
3. Add to `getEnabledSettingSources()` with appropriate priority

## Rules

- Never add required fields to SettingsSchema — only `.optional()`.
- Never remove existing fields — invalid fields are preserved via `.passthrough()`.
- Never tighten validation (e.g., adding `.min()` to existing number field).
- Use `getInitialSettings()` for high-frequency access — it's cached. Use `getSettingsWithSources()` only when you need per-source breakdown (it resets cache).
- Side effects go in `onChangeAppState.ts`, not in settings accessors.
- Settings merge uses `lodash-es/mergeWith` — arrays are replaced not concatenated, objects are deep-merged.

## Settings Sources Priority (high → low)

1. `policySettings` — enterprise managed
2. `flagSettings` — feature flag overrides
3. `localSettings` — `.claude/settings.local.json` (gitignored)
4. `projectSettings` — `.claude/settings.json` (committed)
5. `userSettings` — `~/.claude/settings.json` (global user)

Higher priority sources override lower ones during merge.

## Integration Points

| Component | File | Key line |
|-----------|------|----------|
| Schema definition | `types.ts` | 255 (`SettingsSchema`) |
| Main accessor | `settings.ts` | 812 (`getInitialSettings`) |
| Per-source accessor | `settings.ts` | 309 (`getSettingsForSource`) |
| Cache reset | `settings.ts` | `resetSettingsCache()` |
| Side effects | `onChangeAppState.ts` | 44 (`onChangeAppState`) |
| Disk write | `applySettingsChange.ts` | 31 (`updateSettingsForSource`) |
| Extended errors | `allErrors.ts` | 23 (`getSettingsWithAllErrors`) |
| Capability cache clear | `onChangeAppState.ts` | `clearResolveCapabilitiesCache()` |
| Auth cache clear | `onChangeAppState.ts` | `clearApiKeyHelperCache()` etc. |

## Validation

- After adding a field: `bun -e "import { SettingsSchema } from './src/utils/settings/types.ts'; console.log(SettingsSchema().safeParse({}).success, SettingsSchema().safeParse({ myField: 'test' }).success)"` — both should be `true`.
- After wiring onChange: modify `~/.claude/settings.json`, restart CLI, verify the side effect fires.
- Run `bun run version` to confirm no import breakage.

## Anti-Patterns

- Adding required fields to schema — breaks all existing settings files.
- Reading settings with `getSettingsWithSources()` in hot paths — it resets cache on every call.
- Putting runtime side effects inside settings accessors instead of `onChangeAppState`.
- Creating a parallel settings file or cache instead of extending the existing schema.
- Using `JSON.parse(fs.readFileSync(...))` instead of `getSettingsForSource()` — bypasses validation and caching.
- Duplicating the settings diff check pattern — reuse the existing `if (newState.settings !== oldState.settings)` block in `onChangeAppState.ts`.
