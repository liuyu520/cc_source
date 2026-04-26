/**
 * Conversations command - minimal metadata only.
 * Implementation is lazy-loaded from conversations.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const conversations = {
  type: 'local-jsx',
  name: 'conversations',
  description: 'List and search sessions for the current project',
  immediate: true,
  argumentHint: '[--category <type>|--pinned|--archived|--search <query>]',
  load: () => import('./conversations.js'),
} satisfies Command

export default conversations
