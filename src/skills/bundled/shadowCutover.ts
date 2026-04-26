import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './shadowCutoverContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Safe feature introduction via env-flag → shadow → cutover → cleanup progression.'

export function registerShadowCutoverSkill(): void {
  registerBundledSkill({
    name: 'shadow-cutover',
    description: DESCRIPTION,
    whenToUse:
      'Use when introducing a new subsystem, decision engine, or code path that replaces or augments existing behavior. Covers env-var conventions, decideAndLog pattern, legacy fallback rules, and zero-regression checklist.',
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
