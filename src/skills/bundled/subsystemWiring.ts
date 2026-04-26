import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './subsystemWiringContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'How to wire existing function calls into the project\'s fourteen subsystems.'

export function registerSubsystemWiringSkill(): void {
  registerBundledSkill({
    name: 'subsystem-wiring',
    description: DESCRIPTION,
    whenToUse:
      'Use when integrating a new feature point into SideQueryScheduler, ProviderRegistry, CompactOrchestrator, MCP LazyLoad, PEV Harness, Dream Pipeline, Intent Recall, Model Router, Tiered Context, Action Registry, Capability Router, Shadow Runner, Context Fingerprint, or External Agent Pipeline. Provides templates, priority guides, and pre-flight checklists.',
    userInvocable: true,
    files: SKILL_FILES,
    async getPromptForCommand(args) {
      const parts: string[] = [SKILL_BODY.trimStart()]
      if (args) {
        parts.push(`## User Request\n\n${args}`)
      }
      return [{ type: 'text', text: parts.join('\n\n') }]
    },
  })
}
