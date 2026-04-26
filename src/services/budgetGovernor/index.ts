/**
 * BudgetGovernor · 对外入口层
 *
 * 高层 API:
 *   observeSessionCost(currentCostUsd) — 每次 cost 变化时调用,shadow 模式
 *     会把 verdict 写入 EvidenceLedger domain='harness' kind='budget_verdict',
 *     level 升档时写一次,level 平稳时静默(避免刷屏)。
 *
 * 设计约束:
 *   - fail-open:任何异常都静默吞掉,不能影响主流程
 *   - shadow 默认:不改变任何决策行为,只留下可观察信号
 *   - 不依赖 settings.json schema 修改:配置走环境变量,后续可再接入
 */

import { appendEvidence } from '../harness/evidenceLedger.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getBudgetGovernorMode,
  isBudgetGovernorEnabled,
} from './featureCheck.js'
import {
  evaluateBudget,
  DEFAULT_BUDGET_CONFIG,
  type BudgetConfig,
  type BudgetLevel,
  type BudgetVerdict,
} from './governor.js'

export { getBudgetGovernorMode, isBudgetGovernorEnabled } from './featureCheck.js'
export { evaluateBudget, DEFAULT_BUDGET_CONFIG } from './governor.js'
export type { BudgetConfig, BudgetLevel, BudgetVerdict } from './governor.js'

/** 升档去抖:本 session 观察到的最高 level,降档时不再广播 */
let lastObservedLevel: BudgetLevel = 'ok'
/** 升档去抖:最近一次写 evidence 的 level,同 level 不再重复写 */
let lastEmittedLevel: BudgetLevel | null = null

/** 读环境变量数值,失败回默认 */
function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

/** 从环境变量组装 BudgetConfig */
function loadBudgetConfig(): BudgetConfig {
  return {
    perSessionUsd: readEnvNumber(
      'CLAUDE_BUDGET_GOVERNOR_PER_SESSION_USD',
      DEFAULT_BUDGET_CONFIG.perSessionUsd,
    ),
    softWarnRatio: readEnvNumber(
      'CLAUDE_BUDGET_GOVERNOR_SOFT_WARN_RATIO',
      DEFAULT_BUDGET_CONFIG.softWarnRatio,
    ),
    forceHaltRatio: readEnvNumber(
      'CLAUDE_BUDGET_GOVERNOR_FORCE_HALT_RATIO',
      DEFAULT_BUDGET_CONFIG.forceHaltRatio,
    ),
  }
}

/** level 的升序权重,用于去抖 */
const LEVEL_ORDER: Record<BudgetLevel, number> = {
  ok: 0,
  soft_warn: 1,
  stop_sub_agents: 2,
  force_summary_and_halt: 3,
}

/**
 * 主入口:每次 cost 累计变化后调用。
 * shadow / warn / on 都会写 evidence(升档时),off 直接 no-op。
 * 不返回值,不抛异常。
 */
export function observeSessionCost(currentCostUsd: number): void {
  try {
    if (!isBudgetGovernorEnabled()) return
    const config = loadBudgetConfig()
    const verdict = evaluateBudget(currentCostUsd, config)

    // 仅在 level 升档时写 evidence,避免每 turn 刷屏
    const isHigherThanBefore =
      LEVEL_ORDER[verdict.level] > LEVEL_ORDER[lastObservedLevel]
    if (isHigherThanBefore && verdict.level !== lastEmittedLevel) {
      appendEvidence('harness', 'budget_verdict', {
        mode: getBudgetGovernorMode(),
        level: verdict.level,
        currentUsd: verdict.currentUsd,
        perSessionUsd: verdict.perSessionUsd,
        spentRatio: verdict.spentRatio,
        reason: verdict.reason,
      })
      lastEmittedLevel = verdict.level
    }
    if (LEVEL_ORDER[verdict.level] > LEVEL_ORDER[lastObservedLevel]) {
      lastObservedLevel = verdict.level
    }
  } catch (err) {
    // fail-open:绝不影响主流程
    logForDebugging(
      `[BudgetGovernor] observeSessionCost failed: ${(err as Error).message}`,
    )
  }
}

/** 仅供测试/复位使用 */
export function _resetBudgetGovernorForTesting(): void {
  lastObservedLevel = 'ok'
  lastEmittedLevel = null
}

// ──────────────────────────────────────────────────────────────
// 消费者闭环 · D 线:把 budget_verdict evidence 抽出来给 /cost 用
// 设计原则与 promptCacheMetrics/promptCacheOrdering 保持一致:
//   1. 纯读,不改 observeSessionCost 的写逻辑
//   2. samples=0 时 formatter 返回 null,让调用方决定是否显示 section
//   3. fail-open:任何异常静默吞,返回空摘要
//   4. 动态 require evidenceLedger,避免 /cost 冷启动被 harness 模块阻塞
// ──────────────────────────────────────────────────────────────

/** /cost 消费者读到的 budget 摘要 */
export interface BudgetGovernorSummary {
  /** 当前环境变量宣告的 mode */
  mode: 'off' | 'shadow' | 'warn' | 'on'
  /** 窗口内 evidence 条数(只统计 budget_verdict) */
  samples: number
  /** 窗口内最新一次的 level;samples=0 时为 'ok' */
  latestLevel: BudgetLevel
  /** 窗口内曾经达到过的最高 level(按 LEVEL_ORDER 权重) */
  maxLevel: BudgetLevel
  /** 最新一次的 spentRatio(0~1);samples=0 时为 0 */
  latestSpentRatio: number
  /** 最新一次的 currentUsd;samples=0 时为 0 */
  latestCurrentUsd: number
  /** 最新一次的 perSessionUsd;samples=0 时为 0 */
  latestPerSessionUsd: number
  /** 窗口最旧 / 最新 evidence 时间戳 */
  oldestTs?: string
  newestTs?: string
}

/**
 * 读最近 N 条 harness/budget_verdict evidence 聚合。
 * - mode=off 时仍尝试读历史(允许用户从 shadow 切 off 后回看)
 * - 读失败 fail-open,返回 samples=0
 */
export function getBudgetGovernorSummary(window = 50): BudgetGovernorSummary {
  const empty: BudgetGovernorSummary = {
    mode: getBudgetGovernorMode(),
    samples: 0,
    latestLevel: 'ok',
    maxLevel: 'ok',
    latestSpentRatio: 0,
    latestCurrentUsd: 0,
    latestPerSessionUsd: 0,
  }
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const el = require('../harness/evidenceLedger.js') as typeof import('../harness/evidenceLedger.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const entries = el.EvidenceLedger.queryByDomain('harness', {})
    const bvEntries = entries.filter(e => e.kind === 'budget_verdict')
    if (bvEntries.length === 0) return empty
    const cap = Math.max(1, Math.floor(window))
    const tail = bvEntries.slice(-cap)
    const latest = tail[tail.length - 1]
    const latestData = (latest.data ?? {}) as Record<string, unknown>
    let maxLevel: BudgetLevel = 'ok'
    for (const e of tail) {
      const d = (e.data ?? {}) as Record<string, unknown>
      const lvl = String(d.level ?? 'ok') as BudgetLevel
      if (LEVEL_ORDER[lvl] != null && LEVEL_ORDER[lvl] > LEVEL_ORDER[maxLevel]) {
        maxLevel = lvl
      }
    }
    return {
      mode: getBudgetGovernorMode(),
      samples: tail.length,
      latestLevel: String(latestData.level ?? 'ok') as BudgetLevel,
      maxLevel,
      latestSpentRatio: Number(latestData.spentRatio ?? 0),
      latestCurrentUsd: Number(latestData.currentUsd ?? 0),
      latestPerSessionUsd: Number(latestData.perSessionUsd ?? 0),
      oldestTs: tail[0]?.ts,
      newestTs: latest.ts,
    }
  } catch (err) {
    logForDebugging(
      `[BudgetGovernor] summary failed: ${(err as Error).message}`,
    )
    return empty
  }
}

/**
 * /cost 人类可读摘要:
 *   samples=0 → null(零回归保护,无样本不显示)
 *   否则 → "Budget: <level> at X.X% spent ($A.AA / $B.BB, window=N, mode=M)"
 *   若 maxLevel 比 latestLevel 高,附加一行提示 "peak=<maxLevel>"
 */
export function formatBudgetGovernorSummary(
  window = 50,
): string | null {
  const s = getBudgetGovernorSummary(window)
  if (s.samples === 0) return null
  const pct = (s.latestSpentRatio * 100).toFixed(1)
  const cur = s.latestCurrentUsd.toFixed(2)
  const cap = s.latestPerSessionUsd.toFixed(2)
  const lines = [
    `Budget: ${s.latestLevel} at ${pct}% spent ($${cur} / $${cap}, window=${s.samples}, mode=${s.mode})`,
  ]
  if (
    LEVEL_ORDER[s.maxLevel] != null &&
    LEVEL_ORDER[s.latestLevel] != null &&
    LEVEL_ORDER[s.maxLevel] > LEVEL_ORDER[s.latestLevel]
  ) {
    lines.push(`  peak=${s.maxLevel} reached earlier in window`)
  }
  return lines.join('\n')
}
