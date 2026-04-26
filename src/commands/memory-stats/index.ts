import type { Command } from '../../commands.js'

const memoryStats = {
  type: 'local-jsx',
  name: 'memory-stats',
  description: 'Show cognitive memory system health and diagnostics',
  isEnabled: () => true,
  isHidden: true, // 诊断命令，不在帮助列表中显示
  load: () => import('./memory-stats.js'),
} satisfies Command

export default memoryStats
