import type { Command } from '../../commands.js'

const shadowHistory = {
  type: 'local',
  name: 'shadow-history',
  description:
    'Read shadow-promote audit ledger: verdict transitions per line + cutover-applied events. Read-only archaeology complementing /shadow-promote.',
  isHidden: false,
  supportsNonInteractive: true,
  load: () => import('./shadow-history.js'),
} satisfies Command

export default shadowHistory
