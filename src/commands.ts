// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import addDir from './commands/add-dir/index.js'
import autofixPr from './commands/autofix-pr/index.js'
import backfillSessions from './commands/backfill-sessions/index.js'
import btw from './commands/btw/index.js'
import goodClaude from './commands/good-claude/index.js'
import issue from './commands/issue/index.js'
import feedback from './commands/feedback/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import conversations from './commands/conversations/index.js'
import commit from './commands/commit.js'
import copy from './commands/copy/index.js'
import desktop from './commands/desktop/index.js'
import commitPushPr from './commands/commit-push-pr.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
import cost from './commands/cost/index.js'
import diff from './commands/diff/index.js'
import ctx_viz from './commands/ctx_viz/index.js'
import doctor from './commands/doctor/index.js'
import memory from './commands/memory/index.js'
import memoryStats from './commands/memory-stats/index.js'
import memoryMap from './commands/memory-map/index.js'
import kernelStatus from './commands/kernel-status/index.js'
import evolveStatus from './commands/evolve-status/index.js'
// Ph114(2026-04-24):背压决策审计面板
import evolveAudit from './commands/evolve-audit/index.js'
// Ph116(2026-04-24):全量 anomaly 历史面板
import evolveAnomalies from './commands/evolve-anomalies/index.js'
// Ph126(2026-04-24):health-digest 磁盘快照读端(Ph123 的消费面)
import evolveHealth from './commands/evolve-health/index.js'
// Ph144(2026-04-24):观察者告警分诊面板(Ph141/142/143 的独立命令消费面)
import evolveTriage from './commands/evolve-triage/index.js'
import evolveAccept from './commands/evolve-accept/index.js'
import evolveVeto from './commands/evolve-veto/index.js'
import evolveTick from './commands/evolve-tick/index.js'
import evolveArchive from './commands/evolve-archive/index.js'
import evolveInstallHook from './commands/evolve-install-hook/index.js'
import evolveTune from './commands/evolve-tune/index.js'
import evolveMeta from './commands/evolve-meta/index.js'
import evolveMetaApply from './commands/evolve-meta-apply/index.js'
import evolveBench from './commands/evolve-bench/index.js'
import evolveArena from './commands/evolve-arena/index.js'
import evolveKin from './commands/evolve-kin/index.js'
import evolveLineage from './commands/evolve-lineage/index.js'
import evolvePhylogeny from './commands/evolve-phylogeny/index.js'
import evolveDailyDigest from './commands/evolve-daily-digest/index.js'
import evolveReset from './commands/evolve-reset/index.js'
import fossil from './commands/fossil/index.js'
import genealogy from './commands/genealogy/index.js'
import evolveWarmstart from './commands/evolve-warmstart/index.js'
import evolveTuneJoint from './commands/evolve-tune-joint/index.js'
import evolveTunePromotion from './commands/evolve-tune-promotion/index.js'
import evolveTuneArchive from './commands/evolve-tune-archive/index.js'
import evolveTuneOracleDecay from './commands/evolve-tune-oracle-decay/index.js'
import evolveRollbackCheck from './commands/evolve-rollback-check/index.js'
import evolveTuneRollbackThresholds from './commands/evolve-tune-rollback-thresholds/index.js'
import evolveForbiddenZonesCheck from './commands/evolve-forbidden-zones-check/index.js'
import evolveShadowSandboxCheck from './commands/evolve-shadow-sandbox-check/index.js'
import evolveShadowRun from './commands/evolve-shadow-run/index.js'
import evolveDriftCheck from './commands/evolve-drift-check/index.js'
import evolveRareCheck from './commands/evolve-rare-check/index.js'
import evolveGoodhartCheck from './commands/evolve-goodhart-check/index.js'
import evolveVetoCheck from './commands/evolve-veto-check/index.js'
import apiFallbackCheck from './commands/api-fallback-check/index.js'
import planCheck from './commands/plan-check/index.js'
import collapseAudit from './commands/collapse-audit/index.js'
import organismInvocationCheck from './commands/organism-invocation-check/index.js'
import tickBudget from './commands/tick-budget/index.js'
import sandboxAudit from './commands/sandbox-audit/index.js'
import sessionReplay from './commands/session-replay/index.js'
import sessionReplayDiff from './commands/session-replay-diff/index.js'
import sessionReplayRun from './commands/session-replay-run/index.js'
import evolveAutopilot from './commands/evolve-autopilot/index.js'
import toolBandit from './commands/tool-bandit/index.js'
import skillCandidates from './commands/skill-candidates/index.js'
import rehydrateCommand from './commands/rehydrate.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import initVerifiers from './commands/init-verifiers.js'
import keybindings from './commands/keybindings/index.js'
import login from './commands/login/index.js'
import logout from './commands/logout/index.js'
import installGitHubApp from './commands/install-github-app/index.js'
import installSlackApp from './commands/install-slack-app/index.js'
import breakCache from './commands/break-cache/index.js'
import mcp from './commands/mcp/index.js'
import organize from './commands/organize/index.js'
import mobile from './commands/mobile/index.js'
import onboarding from './commands/onboarding/index.js'
import parallel from './commands/parallel/index.js'
import pr_comments from './commands/pr_comments/index.js'
import releaseNotes from './commands/release-notes/index.js'
import rename from './commands/rename/index.js'
import resume from './commands/resume/index.js'
import switchCmd from './commands/switch/index.js'
import review, { ultrareview } from './commands/review.js'
import session from './commands/session/index.js'
import share from './commands/share/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import tasks from './commands/tasks/index.js'
import rca from './commands/rca/index.js'
import teleport from './commands/teleport/index.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const agentsPlatform =
  process.env.USER_TYPE === 'ant'
    ? require('./commands/agents-platform/index.js').default
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
import securityReview from './commands/security-review.js'
import bughunter from './commands/bughunter/index.js'
import terminalSetup from './commands/terminalSetup/index.js'
import usage from './commands/usage/index.js'
import theme from './commands/theme/index.js'
import vim from './commands/vim/index.js'
import shadowPromote from './commands/shadow-promote/index.js'
import shadowHistory from './commands/shadow-history/index.js'
import { feature } from 'bun:bundle'
// Dead code elimination: conditional imports
/* eslint-disable @typescript-eslint/no-require-imports */
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null
const briefCommand =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? require('./commands/brief.js').default
    : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default
  : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null
const remoteControlServerCommand =
  feature('DAEMON') && feature('BRIDGE_MODE')
    ? require('./commands/remoteControlServer/index.js').default
    : null
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./commands/workflows/index.js') as typeof import('./commands/workflows/index.js')
    ).default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('./commands/remote-setup/index.js') as typeof import('./commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('./services/skillSearch/localSearch.js') as typeof import('./services/skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
const torch = feature('TORCH') ? require('./commands/torch.js').default : null
const peersCmd = feature('UDS_INBOX')
  ? (
      require('./commands/peers/index.js') as typeof import('./commands/peers/index.js')
    ).default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (
      require('./commands/fork/index.js') as typeof import('./commands/fork/index.js')
    ).default
  : null
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import('./commands/buddy/index.js')
    ).default
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import thinkback from './commands/thinkback/index.js'
import thinkbackPlay from './commands/thinkback-play/index.js'
import permissions from './commands/permissions/index.js'
import plan from './commands/plan/index.js'
import fast from './commands/fast/index.js'
import passes from './commands/passes/index.js'
import privacySettings from './commands/privacy-settings/index.js'
import hooks from './commands/hooks/index.js'
import files from './commands/files/index.js'
import branch from './commands/branch/index.js'
import rollback from './commands/rollback/index.js'
import agents from './commands/agents/index.js'
import plugin from './commands/plugin/index.js'
import reloadPlugins from './commands/reload-plugins/index.js'
import rewind from './commands/rewind/index.js'
import heapDump from './commands/heapdump/index.js'
import mockLimits from './commands/mock-limits/index.js'
import bridgeKick from './commands/bridge-kick.js'
import version from './commands/version.js'
import summary from './commands/summary/index.js'
import {
  resetLimits,
  resetLimitsNonInteractive,
} from './commands/reset-limits/index.js'
import antTrace from './commands/ant-trace/index.js'
import perfIssue from './commands/perf-issue/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import chrome from './commands/chrome/index.js'
import stickers from './commands/stickers/index.js'
import advisor from './commands/advisor.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
  isExplicitSkillLoadingEnabled,
} from './skills/loadSkillsDir.js'

import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'
import { isUsing3PServices, isClaudeAISubscriber } from './utils/auth.js'
import { isEnvTruthy } from './utils/envUtils.js'
import { isFirstPartyAnthropicBaseUrl } from './utils/model/providers.js'
import env from './commands/env/index.js'
import exit from './commands/exit/index.js'
import exportCommand from './commands/export/index.js'
import exportMdCommand from './commands/export-md/index.js'
import model from './commands/model/index.js'
import tag from './commands/tag/index.js'
import outputStyle from './commands/output-style/index.js'
import remoteEnv from './commands/remote-env/index.js'
import upgrade from './commands/upgrade/index.js'
import {
  extraUsage,
  extraUsageNonInteractive,
} from './commands/extra-usage/index.js'
import rateLimitOptions from './commands/rate-limit-options/index.js'
import statusline from './commands/statusline.js'
import effort from './commands/effort/index.js'
import stats from './commands/stats/index.js'
// insights.ts is 113KB (3200 lines, includes diffLines/html rendering). Lazy
// shim defers the heavy module until /insights is actually invoked.
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Claude Code sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
import oauthRefresh from './commands/oauth-refresh/index.js'
import debugToolCall from './commands/debug-tool-call/index.js'
import { getSettingSourceName } from './utils/settings/constants.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// Re-export types from the centralized location
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// Commands that get eliminated from the external build
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  commit,
  commitPushPr,
  ctx_viz,
  goodClaude,
  issue,
  initVerifiers,
  ...(forceSnip ? [forceSnip] : []),
  mockLimits,
  bridgeKick,
  version,
  ...(ultraplan ? [ultraplan] : []),
  ...(subscribePr ? [subscribePr] : []),
  resetLimits,
  resetLimitsNonInteractive,
  onboarding,
  share,
  summary,
  teleport,
  antTrace,
  perfIssue,
  env,
  oauthRefresh,
  debugToolCall,
  agentsPlatform,
  autofixPr,
].filter(Boolean)

// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module initialization time
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  conversations,
  copy,
  desktop,
  context,
  contextNonInteractive,
  cost,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  memoryStats,
  memoryMap,
  kernelStatus,
  shadowPromote,
  shadowHistory,
  evolveStatus,
  evolveAudit,
  evolveAnomalies,
  evolveHealth,
  evolveTriage,
  evolveAccept,
  evolveVeto,
  evolveTick,
  evolveArchive,
  evolveInstallHook,
  evolveTune,
  evolveMeta,
  evolveMetaApply,
  evolveBench,
  evolveArena,
  evolveKin,
  evolveLineage,
  evolvePhylogeny,
  evolveDailyDigest,
  evolveReset,
  fossil,
  genealogy,
  evolveWarmstart,
  evolveTuneJoint,
  evolveTunePromotion,
  evolveTuneArchive,
  evolveTuneOracleDecay,
  evolveRollbackCheck,
  evolveTuneRollbackThresholds,
  evolveForbiddenZonesCheck,
  evolveShadowSandboxCheck,
  evolveShadowRun,
  evolveDriftCheck,
  evolveRareCheck,
  evolveGoodhartCheck,
  evolveVetoCheck,
  apiFallbackCheck,
  planCheck,
  collapseAudit,
  organismInvocationCheck,
  tickBudget,
  sandboxAudit,
  sessionReplay,
  sessionReplayDiff,
  sessionReplayRun,
  evolveAutopilot,
  toolBandit,
  skillCandidates,
  rehydrateCommand,
  mobile,
  model,
  organize,
  outputStyle,
  parallel,
  remoteEnv,
  plugin,
  pr_comments,
  rca,
  releaseNotes,
  reloadPlugins,
  rename,
  resume,
  rollback,
  session,
  skills,
  stats,
  status,
  statusline,
  stickers,
  switchCmd,
  tag,
  theme,
  feedback,
  review,
  ultrareview,
  rewind,
  securityReview,
  terminalSetup,
  upgrade,
  extraUsage,
  extraUsageNonInteractive,
  rateLimitOptions,
  usage,
  usageReport,
  vim,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(buddy ? [buddy] : []),
  ...(proactive ? [proactive] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  privacySettings,
  hooks,
  exportCommand,
  exportMdCommand,
  sandboxToggle,
  ...(!isUsing3PServices() ? [logout, login()] : []),
  passes,
  ...(peersCmd ? [peersCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(torch ? [torch] : []),
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])

export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
)

async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const skipPluginRuntimeLoadForTest = isEnvTruthy(
      process.env.CLAUDE_CODE_SKIP_PLUGIN_RUNTIME_LOAD_FOR_TEST,
    )

    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging(
          'Skill directory commands failed to load, continuing without them',
        )
        return []
      }),
      skipPluginRuntimeLoadForTest
        ? (logForDebugging(
            'Skipping plugin skills load for test (CLAUDE_CODE_SKIP_PLUGIN_RUNTIME_LOAD_FOR_TEST)',
          ),
          Promise.resolve([]))
        : getPluginSkills().catch(err => {
            logError(toError(err))
            logForDebugging(
              'Plugin skills failed to load, continuing without them',
            )
            return []
          }),
    ])
    // Bundled skills are registered synchronously at startup
    const bundledSkills = getBundledSkills()
    // Built-in plugin skills come from enabled built-in plugins
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // This should never happen since we catch at the Promise level, but defensive
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./tools/WorkflowTool/createWorkflowCommand.js') as typeof import('./tools/WorkflowTool/createWorkflowCommand.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters commands by their declared `availability` (auth/provider requirement).
 * Commands without `availability` are treated as universal.
 * This runs before `isEnabled()` so that provider-gated commands are hidden
 * regardless of feature-flag state.
 *
 * Not memoized — auth state can change mid-session (e.g. after /login),
 * so this must be re-evaluated on every getCommands() call.
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key user = direct 1P API customer (not 3P, not claude.ai).
        // Excludes 3P (Bedrock/Vertex/Foundry) who don't set ANTHROPIC_BASE_URL
        // and gateway users who proxy through a custom base URL.
        if (
          !isClaudeAISubscriber() &&
          !isUsing3PServices() &&
          isFirstPartyAnthropicBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  return false
}

/**
 * Loads all command sources (skills, plugins, workflows). Memoized by cwd
 * because loading is expensive (disk I/O, dynamic imports).
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const skipPluginRuntimeLoadForTest = isEnvTruthy(
    process.env.CLAUDE_CODE_SKIP_PLUGIN_RUNTIME_LOAD_FOR_TEST,
  )

  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    // Skills can be expensive to scan, so defer them until the user explicitly
    // asks with plain input `load skill`.
    isExplicitSkillLoadingEnabled()
      ? getSkills(cwd)
      : Promise.resolve({
          skillDirCommands: [],
          pluginSkills: [],
          bundledSkills: [],
          builtinPluginSkills: [],
        }),
    skipPluginRuntimeLoadForTest
      ? (logForDebugging(
          'Skipping plugin commands load for test (CLAUDE_CODE_SKIP_PLUGIN_RUNTIME_LOAD_FOR_TEST)',
        ),
        Promise.resolve([]))
      : getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
  ]
})

/**
 * Returns commands available to the current user. The expensive loading is
 * memoized, but availability and isEnabled checks run fresh every call so
 * auth changes (e.g. /login) take effect immediately.
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // Get dynamic skills discovered during file operations, but only after the
  // user explicitly asks to load skills.
  const dynamicSkills = isExplicitSkillLoadingEnabled() ? getDynamicSkills() : []

  // Build base commands without dynamic skills
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  if (dynamicSkills.length === 0) {
    return baseCommands
  }

  // Dedupe dynamic skills - only add if not already present
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // Insert dynamic skills after plugin skills but before built-in commands
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/**
 * Clears only the memoization caches for commands, WITHOUT clearing skill caches.
 * Use this when dynamic skills are added to invalidate cached command lists.
 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // getSkillIndex in skillSearch/localSearch.ts is a separate memoization layer
  // built ON TOP of getSkillToolCommands/getCommands. Clearing only the inner
  // caches is a no-op for the outer — lodash memoize returns the cached result
  // without ever reaching the cleared inners. Must clear it explicitly.
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * Filter AppState.mcp.commands to MCP-provided skills (prompt-type,
 * model-invocable, loaded from MCP). These live outside getCommands() so
 * callers that need MCP skills in their skill index thread them through
 * separately.
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool shows ALL prompt-based commands that the model can invoke
// This includes both skills (from /skills/) and commands (from /commands/)
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // Always include skills from /skills/ dirs, bundled skills, and legacy /commands/ entries
        // (they all get an auto-derived description from the first line if frontmatter is missing).
        // Plugin/MCP commands still require an explicit description to appear in the listing.
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
  },
)

// Filters commands to include only skills. Skills are commands that provide
// specialized capabilities for the model to use. They are identified by
// loadedFrom being 'skills', 'plugin', or 'bundled', or having disableModelInvocation set.
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    try {
      const allCommands = await getCommands(cwd)
      return allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
    } catch (error) {
      logError(toError(error))
      // Return empty array rather than throwing - skills are non-critical
      // This prevents skill loading failures from breaking the entire system
      logForDebugging('Returning empty skills array due to load failure')
      return []
    }
  },
)

/**
 * Commands that are safe to use in remote mode (--remote).
 * These only affect local TUI state and don't depend on local filesystem,
 * git, shell, IDE, MCP, or other local execution context.
 *
 * Used in two places:
 * 1. Pre-filtering commands in main.tsx before REPL renders (prevents race with CCR init)
 * 2. Preserving local-only commands in REPL's handleRemoteInit after CCR filters
 */
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // Shows QR code / URL for remote session
  exit, // Exit the TUI
  clear, // Clear screen
  help, // Show help
  theme, // Change terminal theme
  color, // Change agent color
  vim, // Toggle vim mode
  cost, // Show session cost (local cost tracking)
  usage, // Show usage info
  copy, // Copy last message
  btw, // Quick note
  feedback, // Send feedback
  plan, // Plan mode toggle
  keybindings, // Keybinding management
  statusline, // Status line toggle
  stickers, // Stickers
  mobile, // Mobile QR code
])

/**
 * Builtin commands of type 'local' that ARE safe to execute when received
 * over the Remote Control bridge. These produce text output that streams
 * back to the mobile/web client and have no terminal-only side effects.
 *
 * 'local-jsx' commands are blocked by type (they render Ink UI) and
 * 'prompt' commands are allowed by type (they expand to text sent to the
 * model) — this set only gates 'local' commands.
 *
 * When adding a new 'local' command that should work from mobile, add it
 * here. Default is blocked.
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // Shrink context — useful mid-session from a phone
    clear, // Wipe transcript
    cost, // Show session cost
    summary, // Summarize conversation
    releaseNotes, // Show changelog
    files, // List tracked files
  ].filter((c): c is Command => c !== null),
)

/**
 * Whether a slash command is safe to execute when its input arrived over the
 * Remote Control bridge (mobile/web client).
 *
 * PR #19134 blanket-blocked all slash commands from bridge inbound because
 * `/model` from iOS was popping the local Ink picker. This predicate relaxes
 * that with an explicit allowlist: 'prompt' commands (skills) expand to text
 * and are safe by construction; 'local' commands need an explicit opt-in via
 * BRIDGE_SAFE_COMMANDS; 'local-jsx' commands render Ink UI and stay blocked.
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return false
  if (cmd.type === 'prompt') return true
  return BRIDGE_SAFE_COMMANDS.has(cmd)
}

/**
 * Filter commands to only include those safe for remote mode.
 * Used to pre-filter commands when rendering the REPL in --remote mode,
 * preventing local-only commands from being briefly available before
 * the CCR init message arrives.
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}

export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * Formats a command's description with its source annotation for user-facing UI.
 * Use this in typeahead, help screens, and other places where users need to see
 * where a command comes from.
 *
 * For model-facing prompts (like SkillTool), use cmd.description directly.
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
