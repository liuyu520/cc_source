/**
 * Organize command - minimal metadata only.
 * Implementation is lazy-loaded from organize.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const organize = {
  type: 'local-jsx',
  name: 'organize',
  description: 'Organize session metadata (pin, category, archive)',
  immediate: true,
  argumentHint: '[--pin|--unpin|--category <type>|--archive|--unarchive]',
  load: () => import('./organize.js'),
} satisfies Command

export default organize
