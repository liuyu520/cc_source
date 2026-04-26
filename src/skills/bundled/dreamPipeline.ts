import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './dreamPipelineContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Evidence-driven dream pipeline for memory consolidation lifecycle.'

export function registerDreamPipelineSkill(): void {
  registerBundledSkill({
    name: 'dream-pipeline',
    description: DESCRIPTION,
    whenToUse:
      'Use when extending the dream (memory consolidation) system, adding new evidence signals, tuning triage thresholds, or wiring a new dream stage into the autoDream lifecycle.',
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
