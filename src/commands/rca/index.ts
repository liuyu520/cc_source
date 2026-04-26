import type { Command } from '../../commands.js'
import { isRCAEnabled } from '../../services/rca/featureCheck.js'

const rca = {
  type: 'local',
  name: 'rca',
  description:
    'Root Cause Analysis: manage hypothesis-driven debugging sessions. Usage: /rca <start|board|why|end> [args]',
  isEnabled: () => isRCAEnabled(),
  aliases: ['debug-why'],
  supportsNonInteractive: false,
  argumentHint: '<start|board|why|end> [args]',
  load: () => import('./rca.js'),
} satisfies Command

export default rca
