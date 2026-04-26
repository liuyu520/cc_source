// Content for the subsystem-wiring bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import futureCandidatesMd from './subsystem-wiring/examples/future-candidates.md'
import wiringChecklistMd from './subsystem-wiring/examples/wiring-checklist.md'
import skillMd from './subsystem-wiring/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/future-candidates.md': futureCandidatesMd,
  'examples/wiring-checklist.md': wiringChecklistMd,
}
