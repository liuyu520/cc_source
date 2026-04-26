import type { Command } from '../../commands.js'

/**
 * Phase 126(2026-04-24)— /evolve-health
 *
 * 读 ~/.claude/autoEvolve/health-digest.json(Phase 123 周期沉淀),展示
 * 最新一次 emergence tick 写盘的健康快照。
 *
 * 与 /kernel-status 的区别:
 *   - /kernel-status 运行时聚合 20+ 个数据源(活的进程状态,含 scheduler / runtime)
 *   - /evolve-health 只读磁盘,显示上一次 tick 末尾的冷态摘要(audit / anomaly /
 *     adaptive / contract health)。面向运维 / CI / 监控脚本场景。
 *
 * 参数:
 *   --json  直接吐出 digest 原始 JSON(脚本消费用)
 *
 * 零副作用,只读。
 */
const evolveHealth = {
  type: 'local-jsx',
  name: 'evolve-health',
  description:
    'Show the last periodic health digest snapshot (Ph123) from autoEvolve/health-digest.json',
  isEnabled: () => true,
  isHidden: true,
  load: () => import('./evolve-health.js'),
} satisfies Command

export default evolveHealth
