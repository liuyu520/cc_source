// Content for the blast-radius bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import bashWiringMd from './blast-radius/examples/bash-wiring.md'
import skillMd from './blast-radius/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/bash-wiring.md': bashWiringMd,
}
