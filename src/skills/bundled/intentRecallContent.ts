// Content for the intent-recall bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import multiTriggerMd from './intent-recall/examples/multi-trigger.md'
import skillMd from './intent-recall/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/multi-trigger.md': multiTriggerMd,
}
