import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './blastRadiusContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Analyse bash commands for blast radius before execution.'

export function registerBlastRadiusSkill(): void {
  registerBundledSkill({
    name: 'blast-radius',
    description: DESCRIPTION,
    whenToUse:
      'Use when assessing the impact of shell commands before running them, adding blast-radius preview to a new tool, or extending the PEV harness with new effect patterns.',
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
