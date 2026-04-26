import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './intentRecallContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Layered skill recall with intent classification.'

export function registerIntentRecallSkill(): void {
  registerBundledSkill({
    name: 'intent-recall',
    description: DESCRIPTION,
    whenToUse:
      'Use when improving skill discovery accuracy, adding new task-mode recognition rules, tuning fusion weights between lexical and semantic recall layers, or extending the retrieval pipeline with a new recall dimension.',
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
