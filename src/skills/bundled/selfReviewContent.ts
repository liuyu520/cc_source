// Content for the self-review bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import auditWalkthroughMd from './self-review/examples/audit-walkthrough.md'
import skillMd from './self-review/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/audit-walkthrough.md': auditWalkthroughMd,
}
