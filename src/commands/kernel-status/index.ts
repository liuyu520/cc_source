import type { Command } from '../../commands.js'

const kernelStatus = {
  type: 'local-jsx',
  name: 'kernel-status',
  description:
    'Show scheduler kernel diagnostics: scheduler, cache, token budget, speculation, preflight, periodic tasks',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不在帮助列表中显示
  load: () => import('./kernel-status.js'),
} satisfies Command

export default kernelStatus
