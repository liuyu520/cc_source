import type { Command } from '../../commands.js'

/**
 * Phase 114(2026-04-24)— /evolve-audit
 *
 * 读 ~/.claude/autoEvolve/backpressure-audit.ndjson(Phase 113 沉淀),展示:
 *   1. 总条目数 + 首末时间范围
 *   2. Decision 分布(observe / env-off / env-on / auto-gate + 百分比)
 *   3. Top auto-gated kinds(按命中次数排名)
 *   4. 最近 N 条时间线(默认 20,--limit 可调)
 *
 * 只读、零副作用,单次调用即返回结果。
 */
const evolveAudit = {
  type: 'local-jsx',
  name: 'evolve-audit',
  description:
    'Show autoEvolve backpressure audit: decision distribution, auto-gated kinds, recent timeline',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不进 /help 正式列表
  load: () => import('./evolve-audit.js'),
} satisfies Command

export default evolveAudit
