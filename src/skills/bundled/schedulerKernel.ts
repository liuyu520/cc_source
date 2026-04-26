import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './schedulerKernelContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'How to extend the agentScheduler kernel\'s factory+registry abstractions — rate buckets, auto-continue strategies, snapshot stores, cold-start candidates, shadow→episode writeback.'

export function registerSchedulerKernelSkill(): void {
  registerBundledSkill({
    name: 'scheduler-kernel',
    description: DESCRIPTION,
    whenToUse:
      'Use when adding a new rate-limit dimension (createRateBucket), a new auto-continue strategy (registerAutoContinueStrategy), a new cross-session persistence target (createSnapshotStore), a new cold-start candidate (registerColdStartCandidate), or wiring a shadow pre-run to feed episode history (appendEpisode + source:shadow). Provides templates, priority guides, and pre-flight checklists.',
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
