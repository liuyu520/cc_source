import type { Command } from '../../commands.js'

const parallel = {
  type: 'local-jsx',
  name: 'parallel',
  description:
    'Run a temporary independent task in parallel without session history',
  immediate: true,
  argumentHint: '<task>',
  whenToUse:
    'Use for a temporary task that is completely independent from the current conversation and should not create transcript/session state.',
  load: () => import('./parallel.js'),
} satisfies Command

export default parallel
