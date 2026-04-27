import { feature } from 'bun:bundle'
import { shouldAutoEnableClaudeInChrome } from 'src/utils/claudeInChrome/setup.js'
import { registerBatchSkill } from './batch.js'
import { registerClaudeInChromeSkill } from './claudeInChrome.js'
import { registerDebugSkill } from './debug.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerLoremIpsumSkill } from './loremIpsum.js'
import { registerMemoryAuditSkill } from './memoryAudit.js'
import { registerRememberSkill } from './remember.js'
import { registerCodexSkill } from './codex.js'
import { registerFeishuFetchSkill } from './feishuFetch.js'
import { registerAdapterAuditSkill } from './adapterAudit.js'
import { registerBackupApiFallbackSkill } from './backupApiFallback.js'
import { registerEngineMigrateSkill } from './engineMigrate.js'
import { registerExportMdSkill } from './exportMd.js'
import { registerFeatureSwitchSkill } from './featureSwitch.js'
import { registerForceOauthSkill } from './forceOauth.js'
import { registerOauthProxySkill } from './oauthProxy.js'
import { registerApiModeDetectSkill } from './apiModeDetect.js'
import { registerUserSettingsRoutingSkill } from './userSettingsRouting.js'
import { registerMultiEntryAuditSkill } from './multiEntryAudit.js'
import { registerSelfReviewSkill } from './selfReview.js'
import { registerShadowCutoverSkill } from './shadowCutover.js'
import { registerSimplifySkill } from './simplify.js'
import { registerStreamProtocolSkill } from './streamProtocol.js'
import { registerSubsystemWiringSkill } from './subsystemWiring.js'
import { registerToolBridgeSkill } from './toolBridge.js'
import { registerStatuslineCopySkill } from './statuslineCopy.js'
import { registerSkillifySkill } from './skillify.js'
import { registerStuckSkill } from './stuck.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerVerifySkill } from './verify.js'
import { registerBlastRadiusSkill } from './blastRadius.js'
import { registerDreamPipelineSkill } from './dreamPipeline.js'
import { registerExternalAgentOrchestrationSkill } from './externalAgentOrchestration.js'
import { registerHttpServerSkill } from './httpServer.js'
import { registerIntentRecallSkill } from './intentRecall.js'
import { registerSchedulerKernelSkill } from './schedulerKernel.js'
import { registerUiThemeSkill } from './uiTheme.js'
import { registerTerminalTitleSkill } from './terminalTitle.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerVerifySkill()
  registerDebugSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerMemoryAuditSkill()
  registerSimplifySkill()
  registerExportMdSkill()
  registerEngineMigrateSkill()
  registerCodexSkill()
  registerFeishuFetchSkill()
  registerAdapterAuditSkill()
  registerToolBridgeSkill()
  registerStreamProtocolSkill()
  registerMultiEntryAuditSkill()
  registerFeatureSwitchSkill()
  registerForceOauthSkill()
  registerOauthProxySkill()
  registerApiModeDetectSkill()
  registerUserSettingsRoutingSkill()
  registerBackupApiFallbackSkill()
  registerBatchSkill()
  registerStuckSkill()
  registerShadowCutoverSkill()
  registerSubsystemWiringSkill()
  registerStatuslineCopySkill()
  registerSelfReviewSkill()
  registerBlastRadiusSkill()
  registerDreamPipelineSkill()
  registerIntentRecallSkill()
  registerHttpServerSkill()
  registerExternalAgentOrchestrationSkill()
  registerSchedulerKernelSkill()
  registerUiThemeSkill()
  registerTerminalTitleSkill()
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerDreamSkill } = require('./dream.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerHunterSkill } = require('./hunter.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerHunterSkill()
  }
  if (feature('AGENT_TRIGGERS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerLoopSkill } = require('./loop.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    // /loop's isEnabled delegates to isKairosCronEnabled() — same lazy
    // per-invocation pattern as the cron tools. Registered unconditionally;
    // the skill's own isEnabled callback decides visibility.
    registerLoopSkill()
  }
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerClaudeApiSkill()
  }
  if (shouldAutoEnableClaudeInChrome()) {
    registerClaudeInChromeSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerRunSkillGeneratorSkill } = require('./runSkillGenerator.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerRunSkillGeneratorSkill()
  }
}
