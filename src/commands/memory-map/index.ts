import type { Command } from '../../commands.js'

const memoryMap = {
  type: 'local-jsx',
  name: 'memory-map',
  description:
    'Show memory-system map: lifecycle distribution, knowledge graph tops, dream journal + learned weights + feedback loop',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不在帮助列表中显示
  load: () => import('./memory-map.js'),
} satisfies Command

export default memoryMap
