import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
// Import as module object so spyOn works in tests (direct imports bypass spies)
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

let initialHooksConfig: HooksSettings | null = null

/**
 * Get hooks from allowed sources.
 * If allowManagedHooksOnly is set in policySettings, only managed hooks are returned.
 * If disableAllHooks is set in policySettings, no hooks are returned.
 * If disableAllHooks is set in non-managed settings, only managed hooks are returned
 * (non-managed settings cannot disable managed hooks).
 * Otherwise, returns merged hooks from all sources (backwards compatible).
 */
function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // If managed settings disables all hooks, return empty
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // If allowManagedHooksOnly is set in managed settings, only use managed hooks
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // strictPluginOnlyCustomization: block user/project/local settings hooks.
  // Plugin hooks (registered channel, hooks.ts:1391) are NOT affected —
  // they're assembled separately and the managedOnly skip there is keyed
  // on shouldAllowManagedHooksOnly(), not on this policy. Agent frontmatter
  // hooks are gated at REGISTRATION (runAgent.ts:~535) by agent source —
  // plugin/built-in/policySettings agents register normally, user-sourced
  // agents skip registration under ["hooks"]. A blanket execution-time
  // block here would over-kill plugin agents' hooks.
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // If disableAllHooks is set in non-managed settings, only managed hooks still run
  // (non-managed settings cannot override managed hooks)
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // Otherwise, use all hooks (merged from all sources) - backwards compatible
  return mergedSettings.hooks ?? {}
}

/**
 * Check if only managed hooks should run.
 * This is true when:
 * - policySettings has allowManagedHooksOnly: true, OR
 * - disableAllHooks is set in non-managed settings (non-managed settings
 *   cannot disable managed hooks, so they effectively become managed-only)
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // If disableAllHooks is set but NOT from managed settings,
  // treat as managed-only (non-managed hooks disabled, managed hooks still run)
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

/**
 * Check if all hooks (including managed) should be disabled.
 * This is only true when managed/policy settings has disableAllHooks: true.
 * When disableAllHooks is set in non-managed settings, managed hooks still run.
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * Capture a snapshot of the current hooks configuration
 * This should be called once during application startup
 * Respects the allowManagedHooksOnly setting
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Update the hooks configuration snapshot
 * This should be called when hooks are modified through the settings
 * Respects the allowManagedHooksOnly setting
 */
export function updateHooksConfigSnapshot(): void {
  // Reset the session cache to ensure we read fresh settings from disk.
  // Without this, the snapshot could use stale cached settings when the user
  // edits settings.json externally and then runs /hooks - the session cache
  // may not have been invalidated yet (e.g., if the file watcher's stability
  // threshold hasn't elapsed).
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * Get the current hooks configuration from snapshot
 * Falls back to settings if no snapshot exists
 * @returns The hooks configuration
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * Reset the hooks configuration snapshot (useful for testing)
 * Also resets SDK init state to prevent test pollution
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null
  resetSdkInitState()
}

// ── Phase 45 / autoEvolve:tool-failure 候选"已有 hook 保护"前置过滤 ──
//
// Pattern Miner 产出 tool-failure candidate 时要判断该工具是否已经被用户的
// PreToolUse hook 保护 —— 若是,则不应再建议 auto-preflight hook(避免
// 假阳性、减少 reviewer 噪声)。
//
// 只判断 settings 来源的 hooks(getHooksConfigFromSnapshot):
//   - 不依赖 AppState(Miner 运行在 REPL 之外)
//   - 不触及 plugin/session-derived hook(那些是运行时动态注入,Miner 时刻
//     无法稳定观测,且通常不是"用户自觉的保护"语义)
//
// matcher 语义最小子集(对齐 hooks.ts:matchesPattern 但不依赖其未导出身份):
//   - '' 或 '*' → 保护所有工具
//   - 仅字母/数字/下划线/竖线:`Bash` 或 `Bash|Edit` 作精确/列表匹配
//   - 其它字符:当正则处理;无效正则静默算作"不匹配"
//
// fail-open 原则:snapshot 读失败或设置异常时返回 false —— 宁愿多生成一个
// 候选走 covered/vetoed/quarantined 三道门,也不要因此卡死 Miner。
const HOOK_EVENTS_THAT_GUARD_TOOLS: ReadonlyArray<'PreToolUse' | 'PostToolUse'> =
  ['PreToolUse', 'PostToolUse']

function hookMatcherMatchesToolName(
  matcher: string,
  toolName: string,
): boolean {
  if (!matcher || matcher === '*') return true
  // 简单 token / pipe 列表:精确匹配(不走 regex,避免误命中)
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      return matcher.split('|').map(s => s.trim()).includes(toolName)
    }
    return matcher === toolName
  }
  // 其它视为正则
  try {
    return new RegExp(matcher).test(toolName)
  } catch {
    return false
  }
}

/**
 * 给定 toolName,判断 settings 源的 PreToolUse / PostToolUse hooks 里是否有
 * matcher 能匹配到该工具。命中任一即返回 true,用于 Pattern Miner 跳过
 * "已经被保护的工具"。
 *
 * 注意:此函数只读 snapshot,不触发新的设置加载;若 snapshot 还没 capture,
 * getHooksConfigFromSnapshot() 会内部懒加载一次。
 */
export function isToolProtectedBySettingsHook(toolName: string): boolean {
  if (!toolName) return false
  let cfg: ReturnType<typeof getHooksConfigFromSnapshot>
  try {
    cfg = getHooksConfigFromSnapshot()
  } catch {
    return false // fail-open
  }
  if (!cfg) return false
  for (const ev of HOOK_EVENTS_THAT_GUARD_TOOLS) {
    const matchers = cfg[ev]
    if (!Array.isArray(matchers) || matchers.length === 0) continue
    for (const m of matchers) {
      // HookMatcher shape: { matcher?: string, hooks: [...] }
      // 有些来源的 matcher 可能缺省(== 匹配所有),用空字符串走上面"*"规则
      const matcherStr = typeof m?.matcher === 'string' ? m.matcher : ''
      if (hookMatcherMatchesToolName(matcherStr, toolName)) return true
    }
  }
  return false
}
