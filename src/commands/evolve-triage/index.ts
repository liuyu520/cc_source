import type { Command } from '../../commands.js'

/**
 * Phase 144(2026-04-24)— /evolve-triage
 *
 * 告警分诊面板:整合 Ph141 实时 + Ph142/143 历史,独立命令输出:
 *   1. Live Warnings:三 ledger 当前 warnings(与 kernel Summary 同算法)
 *   2. Historical Distribution:跨全 history 累计 byLedger / byCode
 *   3. Most Persistent Codes:top 10 高频 CODE(带示例)
 *   4. Recent Timeline:最近 N 条(默认 20)observer-history 倒序
 *
 * 参数:--limit N(最大 200);--json(结构化整合)。
 * 只读、零副作用。
 */
const evolveTriage = {
  type: 'local-jsx',
  name: 'evolve-triage',
  description:
    'Triage autoEvolve observer warnings: live state + historical byLedger/byCode + persistent codes + recent timeline',
  isEnabled: () => true,
  isHidden: true, // 诊断命令,不进 /help 正式列表
  load: () => import('./evolve-triage.js'),
} satisfies Command

export default evolveTriage
