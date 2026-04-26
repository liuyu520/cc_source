import type { Command } from '../../commands.js'

const shadowPromote = {
  type: 'local',
  name: 'shadow-promote',
  description:
    'Readiness gate + cutover executor for the 8 shadow subsystems (G/Q9/D/E/F/A/C/B). Default dry-run; --apply flips ready lines in settings.json.',
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./shadow-promote.js'),
} satisfies Command

export default shadowPromote
