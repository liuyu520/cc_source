import type { Command } from '../../commands.js'

const exportMdCommand = {
  type: 'local',
  name: 'export-md',
  description: 'Export the current conversation to a Markdown file with full details',
  aliases: ['exportmd'],
  argumentHint: '[filename]',
  load: () => import('./export-md.js'),
} satisfies Command

export default exportMdCommand
