/**
 * P6 Agent Preflight Gating
 *
 * 本模块在 2026-04-18 之后改为使用通用 preflight gate
 * (src/services/preflight/registry.ts)。所有决策/状态逻辑都迁到 gate 内部,
 * 本文件只做两件事:
 *   1. 声明 "agent" gate 的阈值和数据源(getCachedAgentStatsSnapshot)
 *   2. 把 gate 的方法重新导出为历史 API 签名,保证 AgentTool.tsx / runAgent.ts
 *      等调用方**零改动**
 *
 * 历史背景(保留,方便理解为何要拆):
 *   agentStats 已经积累了 per-agentType 的 successRate / p95 / errorRate,但 P1~P5
 *   只把它用在配额自适应上 —— "观察"路径。真正让数据干活,是在调度前做干预:
 *   若目标 agent 最近错得多,给用户预警;若本 session 连续失败 N 次,临时 blacklist。
 *
 * 设计原则(不变):
 *   - 默认关闭(env CLAUDE_CODE_AGENT_PREFLIGHT=1 才启用),保守上线
 *   - 只读 stats + 本 session 状态,不写磁盘,无 side effect
 *   - 样本不足(< 阈值)一律放行 —— 避免早期误伤
 *   - 'block' 只在连续失败达到硬阈值时触发;其它情况最多是 'warn'
 */

import {
  getCachedAgentStatsSnapshot,
  type AgentStat,
} from '../../services/agentScheduler/agentStats.js'
import {
  createPreflightGate,
  type PreflightDecision as GenericPreflightDecision,
  type PreflightOutcome as GenericPreflightOutcome,
} from '../../services/preflight/index.js'

// ── 阈值(维持原值) ──────────────────────────────────────

const AGENT_THRESHOLDS = {
  minSamples: 10,
  warnErrorRate: 0.4,
  warnP95Ms: 120_000,
  blockConsecutiveFails: 3,
}

// ── Gate 实例(注册到进程级 registry) ──────────────────

const gate = createPreflightGate<AgentStat>({
  name: 'agent',
  thresholds: AGENT_THRESHOLDS,
  isEnabled: () => process.env.CLAUDE_CODE_AGENT_PREFLIGHT === '1',
  getStatSnapshot: (agentType) => {
    const snap = getCachedAgentStatsSnapshot()
    return snap?.byAgentType[agentType] ?? null
  },
  // 自定义文案 —— 与历史版本一字不差,保证 UI/日志输出兼容
  reasonTemplates: {
    block: (agentType, fails) =>
      `agent '${agentType}' 本 session 已连续失败 ${fails} 次,暂时拦截。修复后调用 resetAgentPreflight('${agentType}') 清除状态。`,
    warnErrorRate: (agentType, stat, rate) =>
      `agent '${agentType}' 历史错误率 ${(rate * 100).toFixed(0)}% (样本 ${stat.totalRuns}),建议确认。`,
    warnP95: (agentType, stat) =>
      `agent '${agentType}' p95 耗时 ${Math.round(stat.p95DurationMs / 1000)}s,考虑拆分任务。`,
  },
})

// ── 历史公共 API ─────────────────────────────────────────

export type PreflightOutcome = GenericPreflightOutcome

/** 字段形状与历史 PreflightDecision 一致(`stat` 指向 AgentStat | null) */
export type PreflightDecision = GenericPreflightDecision<AgentStat>

/** env 开关查询 —— 与历史 API 等价 */
export function isAgentPreflightEnabled(): boolean {
  return gate.isEnabled()
}

/** 调度前检查 —— 与历史 API 等价 */
export function checkAgentPreflight(agentType: string): PreflightDecision {
  return gate.check(agentType)
}

/** agent 跑完后上报 outcome —— 与历史 API 等价 */
export function recordAgentOutcome(
  agentType: string,
  outcome: PreflightOutcome,
): void {
  gate.recordOutcome(agentType, outcome)
}

/** 手动清除某 agent 的失败计数 —— 与历史 API 等价 */
export function resetAgentPreflight(agentType: string): void {
  gate.resetKey(agentType)
}

/** 清空所有 preflight 状态 —— 与历史 API 等价 */
export function clearAgentPreflightState(): void {
  gate.resetAll()
}

/** 查询当前所有连续失败计数 —— 与历史 API 等价 */
export function getAgentPreflightFails(): Map<string, number> {
  return gate.getFails()
}
