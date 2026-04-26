/**
 * G3 Step 1 (2026-04-26) —— tool bandit shadow reward ledger (纯观察)。
 *
 * 动机:
 *   docs/ai-coding-agent-improvement-spaces-2026-04-25.md §G3 指出"工具选择缺真实 MAB"。
 *   完整方案需要 ε-greedy policy + context features + shadow ghost log,风险面大。
 *   Step 1 只做最轻量的"真实奖励数据收集层":每次 recordToolCall 旁路写一行
 *   {toolName, outcome, durationMs, reward, ts},后续 policy/regret 分析只读这份 ledger。
 *
 * 为什么不直接复用 toolStats ring buffer?
 *   - ring buffer 默认 2000 条上限,会被旧数据覆盖,不利于长周期 bandit regret 计算;
 *   - 进程退出即销(进程级 in-memory),跨 session 看不到趋势;
 *   - 未来 policy 模块要跑 off-policy evaluation,需要持久时间序列数据源。
 *
 * Step 1 范围:
 *   - 纯 append-only ndjson,不暴露 reward 给任何 policy 决策点;
 *   - CLAUDE_TOOL_BANDIT_LEDGER=off|0|false 可关(默认开,与其它 oracle ledger 约定一致);
 *   - reward 映射: success=+1, error=-1, abort=-0.5 (固定表,不引入延迟/retry bonus)。
 *
 * 后续 Step 2 计划(不在本 commit 实现):
 *   - per-context bucket(repo size / file size / turn depth)+ ε-greedy policy ghost log;
 *   - advisor Rule 14 "tool.bandit.regret.high"。
 */

import { appendJsonLine } from '../autoEvolve/oracle/ndjsonLedger.js'
import { getToolBanditRewardLedgerPath } from '../autoEvolve/paths.js'
import { logForDebugging } from '../../utils/debug.js'

export type ToolBanditOutcome = 'success' | 'error' | 'abort'

export interface ToolBanditSample {
  /** 工具名,直接透传自 recordToolCall */
  toolName: string
  /** 执行结果 */
  outcome: ToolBanditOutcome
  /** 本次调用耗时(ms),非有限值时 caller 应先规范化 */
  durationMs: number
}

/** 固定 reward 表 —— 纯函数,便于 probe 直接断言 */
export function mapOutcomeToReward(outcome: ToolBanditOutcome): number {
  if (outcome === 'success') return 1
  if (outcome === 'error') return -1
  return -0.5 // abort
}

function isLedgerEnabled(): boolean {
  const raw = (process.env.CLAUDE_TOOL_BANDIT_LEDGER ?? '')
    .trim()
    .toLowerCase()
  if (raw === 'off' || raw === '0' || raw === 'false') return false
  return true
}

/**
 * 落一条 reward 样本。
 * 返回值:true=写入成功;false=未写(关闭、toolName 空、或异常)。
 * 永不抛异常。
 */
export function recordToolBanditReward(sample: ToolBanditSample): boolean {
  if (!isLedgerEnabled()) return false
  try {
    if (!sample.toolName) return false
    const durationMs =
      Number.isFinite(sample.durationMs) && sample.durationMs >= 0
        ? Math.round(sample.durationMs)
        : 0
    const reward = mapOutcomeToReward(sample.outcome)
    const payload = {
      at: new Date().toISOString(),
      toolName: sample.toolName,
      outcome: sample.outcome,
      durationMs,
      reward,
      pid: process.pid,
    }
    const ok = appendJsonLine(getToolBanditRewardLedgerPath(), payload)

    // G3 Step 3:shadow ghost recommendation 旁路。
    // 仅当 CLAUDE_TOOL_BANDIT_GHOST 开时跑 policy,独立 try/catch,
    // 任何异常不影响 reward ledger 主路径(fail-open)。candidates 取
    // 24h 窗内实际出现过的 toolName 并集,避免硬编码工具族;若历史只有
    // 一种工具,policy 返回 cold-start-tie/exploit with gap=0,ghost 自然
    // 记录 isMatch=true,无副作用。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ghostMod = require('./ghostLog.js') as typeof import('./ghostLog.js')
      if (ghostMod.isToolBanditGhostEnabledForTest()) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pol = require('./policy.js') as typeof import('./policy.js')
        const rows = pol.readRecentRewardRows()
        const candidateSet = new Set<string>()
        for (const r of rows) if (r.toolName) candidateSet.add(r.toolName)
        // 保证本次工具也在候选集里(避免历史未出现时 recommend 空 pick)
        candidateSet.add(sample.toolName)
        const rec = pol.recommendTool({
          candidates: Array.from(candidateSet),
          ledgerRows: rows,
        })
        ghostMod.recordToolBanditGhost({
          actualTool: sample.toolName,
          actualReward: reward,
          recommendation: rec,
        })
      }
    } catch (e) {
      // ghost 层独立 swallow,不升到主链路
      logForDebugging(
        `[toolBanditGhost-sidechannel] ${(e as Error).message}`,
      )
    }

    return ok
  } catch (e) {
    logForDebugging(
      `[toolBanditRewardLedger] append failed: ${(e as Error).message}`,
    )
    return false
  }
}
