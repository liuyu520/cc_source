// Content for the scheduler-kernel bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.

import wiringChecklistMd from './scheduler-kernel/examples/wiring-checklist.md'
import concreteWiringsMd from './scheduler-kernel/examples/concrete-wirings.md'
import skillMd from './scheduler-kernel/SKILL.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'examples/wiring-checklist.md': wiringChecklistMd,
  'examples/concrete-wirings.md': concreteWiringsMd,
}
