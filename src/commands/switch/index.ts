/**
 * Switch command - minimal metadata only.
 * Implementation is lazy-loaded from switch.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const switchCmd = {
  type: 'local-jsx',
  name: 'switch',
  description: 'Switch to another session by ID or index',
  immediate: true,
  argumentHint: '<session-id|index>',
  load: () => import('./switch.js'),
} satisfies Command

export default switchCmd
