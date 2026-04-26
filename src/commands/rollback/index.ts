import type { Command } from '../../commands.js'

const rollback = {
  type: 'local-jsx',
  name: 'rollback',
  description: 'Rollback conversation to the state before the last compact',
  isEnabled: () => true,
  isHidden: false,
  userFacing: true,
  load: () => import('./rollback.js'),
} satisfies Command

export default rollback
