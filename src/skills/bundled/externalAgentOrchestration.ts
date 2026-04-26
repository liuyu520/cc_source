import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  SKILL_FILES,
  SKILL_MD,
} from './externalAgentOrchestrationContent.js'

const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)

const DESCRIPTION =
  typeof frontmatter.description === 'string'
    ? frontmatter.description
    : "Playbook for the project's four external-agent layers — capability router, pipeline runner, shadow runner, context-fingerprint memory."

export function registerExternalAgentOrchestrationSkill(): void {
  registerBundledSkill({
    name: 'external-agent-orchestration',
    description: DESCRIPTION,
    aliases: ['ext-agents', 'agent-pipeline'],
    whenToUse:
      'Use when delegating work to codex/gemini/claude-code — to auto-route the adapter, build a multi-stage pipeline, reuse a prior summary via context fingerprint, or consult a shadow pre-run before paying for another CLI call.',
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
