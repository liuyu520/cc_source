import type { Command } from '../../commands.js'

/**
 * Phase 116(2026-04-24)— /evolve-anomalies
 *
 * 读 ~/.claude/autoEvolve/anomaly-history.ndjson(Ph115 沉淀),展示全量 anomaly
 * 历史的聚合视图。与 Ph114 /evolve-audit 结构对称(四节面板),但关注点不同:
 *   - /evolve-audit   → 背压决策回溯(observe/env-on/env-off/auto-gate 分布)
 *   - /evolve-anomalies → 全量 anomaly 趋势(4 种 kind 的分布 + target 聚合)
 *
 * 只读、零副作用、fail-open(与 /evolve-audit 同样的分节隔离)。
 */
const evolveAnomalies = {
  type: 'local-jsx',
  name: 'evolve-anomalies',
  description:
    'Show autoEvolve anomaly history: kind distribution, target kinds, recent timeline',
  isEnabled: () => true,
  isHidden: true, // 诊断命令
  load: () => import('./evolve-anomalies.js'),
} satisfies Command

export default evolveAnomalies
