import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import { SKILL_FILES, SKILL_MD } from './statuslineCopyContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : 'Optimize bottom status-line copy with minimal display-layer changes.'

export function registerStatuslineCopySkill(): void {
  registerBundledSkill({
    name: 'statusline-copy',
    description: DESCRIPTION,
    whenToUse:
      'Use when editing the bottom footer/status line copy in PromptInputFooterLeftSide.tsx. Helps keep changes display-only, reuse existing value sources, add explicit labels only where they improve recognition, and avoid redundant wording.',
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
