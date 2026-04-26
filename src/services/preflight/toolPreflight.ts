/**
 * Tool Preflight Gate — 用 ToolStats 驱动的"调度前健康检查"
 *
 * 本模块是 #3 Preflight Registry 的第二个内置 gate(第一个是 agent)。
 * 数据源是 in-memory ring buffer 的 ToolStats(src/services/agentScheduler/toolStats.ts),
 * 所以天然是"本 session 窗口"的统计视角 —— 与 agent gate 读取磁盘聚合后的
 * 长期统计形成互补。
 *
 * 使用方式:
 *   - 默认关闭,靠 CLAUDE_CODE_TOOL_PREFLIGHT=1 启用
 *   - 调用方在具体工具 call 前判断:
 *       const d = checkToolPreflight('Bash')
 *       if (d.decision === 'block') throw new Error(d.reason)
 *       if (d.decision === 'warn') logForDebugging(d.reason)
 *   - 运行完成后由 toolStats.recordToolCall 通过动态 require 反向调 recordToolOutcome
 *     (见下方,不需要调用方显式管理)
 *
 * 阈值与 agent 不同 —— tool 调用比 agent 快、频,阈值更宽松:
 *   - minSamples 20(agent 是 10;tool 一 session 内很容易过 20)
 *   - warnErrorRate 0.5(tool 本身 error 被 LLM 吸收/重试场景更多,略放宽)
 *   - warnP95Ms 30_000(30s;agent 是 120s)
 *   - blockConsecutiveFails 5(比 agent 的 3 宽松,避免误伤交互工具)
 *
 * 这里不把 gate 接到某个具体 tool 的执行入口 —— 只提供 decision API,
 * 由后续 PR 按需在 Bash/WebFetch/MCP call 前接入。保持"基础设施先行,接入渐进"。
 */

import {
  createPreflightGate,
  type PreflightDecision as GenericPreflightDecision,
  type PreflightOutcome as GenericPreflightOutcome,
} from './index.js'
import {
  getToolStatsSnapshot,
  type ToolStat,
} from '../agentScheduler/toolStats.js'

// ── 阈值 ──────────────────────────────────────────────────

const TOOL_THRESHOLDS = {
  minSamples: 20,
  warnErrorRate: 0.5,
  warnP95Ms: 30_000,
  blockConsecutiveFails: 5,
}

// ── Gate 实例 ──────────────────────────────────────────────

/**
 * 取当前 ToolStats 快照中某 toolName 的 stat。
 * 注意:每次调用都触发一次聚合(O(n),n<=2000),频率低(只在 check 时),
 * 可接受。若未来 check 频率显著增加,可以给 ToolStats 加个 TTL 缓存层。
 */
function getToolStat(toolName: string): ToolStat | null {
  const snap = getToolStatsSnapshot()
  return snap.byToolName[toolName] ?? null
}

const gate = createPreflightGate<ToolStat>({
  name: 'tool',
  thresholds: TOOL_THRESHOLDS,
  isEnabled: () => process.env.CLAUDE_CODE_TOOL_PREFLIGHT === '1',
  getStatSnapshot: getToolStat,
  reasonTemplates: {
    block: (toolName, fails) =>
      `tool '${toolName}' 本 session 已连续失败 ${fails} 次,暂时拦截。调 resetToolPreflight('${toolName}') 解除。`,
    warnErrorRate: (toolName, stat, rate) =>
      `tool '${toolName}' 本 session 错误率 ${(rate * 100).toFixed(0)}% (${stat.totalRuns} 次调用),可能指示异常。`,
    warnP95: (toolName, stat) =>
      `tool '${toolName}' p95 耗时 ${Math.round(stat.p95DurationMs / 1000)}s,考虑拆分或排查环境。`,
  },
})

// ── 公共 API ──────────────────────────────────────────────

export type ToolPreflightDecision = GenericPreflightDecision<ToolStat>

export function isToolPreflightEnabled(): boolean {
  return gate.isEnabled()
}

export function checkToolPreflight(toolName: string): ToolPreflightDecision {
  return gate.check(toolName)
}

/**
 * 记录一次 tool outcome。由 toolStats.recordToolCall 通过动态 require 调用 —— 实际
 * 使用中通常无需业务代码显式调用这个函数。暴露为公共 API 仅为了让上层(测试、手动
 * 诊断、特殊场景)也能直接喂反馈。
 */
export function recordToolOutcome(
  toolName: string,
  outcome: GenericPreflightOutcome,
): void {
  gate.recordOutcome(toolName, outcome)
}

export function resetToolPreflight(toolName: string): void {
  gate.resetKey(toolName)
}

export function clearToolPreflightState(): void {
  gate.resetAll()
}

export function getToolPreflightFails(): Map<string, number> {
  return gate.getFails()
}
