import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './selfReviewContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Systematic 9-point audit of optimization code against design principles.'

export function registerSelfReviewSkill(): void {
  registerBundledSkill({
    name: 'self-review',
    description: DESCRIPTION,
    whenToUse:
      'Use after completing any shadow-cutover integration, subsystem wiring, or multi-file refactor. Runs a 9-point checklist to catch zero-value signals, type contract violations, IO amplification, semantic invariant breaks, and template duplication.',
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
