import type { Command } from '../../commands.js'

/**
 * /evolve-status — autoEvolve(v1.0) 诊断面板
 *
 * 展示:
 *   - 特性开关(CLAUDE_EVOLVE / _SHADOW / _ARENA)
 *   - Arena 摘要(proposal/shadow/canary/stable/vetoed/archived 计数)
 *   - 最近 shadow organisms
 *   - Pattern Miner 预览(dry-run,不写磁盘)
 *   - Oracle 权重 + 最近打分
 *   - 已注册的 Learners
 *
 * 只读,零副作用。
 */
const evolveStatus = {
  type: 'local-jsx',
  name: 'evolve-status',
  description:
    'Show autoEvolve kernel status: arena, patterns, organisms, oracle weights, fitness scores',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不在 /help 列出
  load: () => import('./evolve-status.js'),
} satisfies Command

export default evolveStatus
