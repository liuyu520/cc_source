/**
 * Dream Feedback Loop — 巩固结果反馈回路
 *
 * 设计理念（闭环控制论）：
 * Observe → Decide → Act → Learn → Observe...
 * 当前系统在 "Learn" 环节断裂：Dream 巩固后不会反向更新 triage 权重、
 * skillSearch 排名、modelRouter 成本估计。本模块闭合这个回路。
 *
 * 反馈路径：
 *   1. Dream 巩固结果 → 更新 triage 的评分因子权重
 *   2. 产出的 episodic cards → 写入 EvidenceLedger skill domain
 *   3. 巩固耗时/模型用量 → 写入 EvidenceLedger router domain
 */

import { logForDebugging } from '../../../utils/debug.js'
import type { MicroDreamResult } from './microDream.js'
import type { TriageDecision } from './types.js'

/** 反馈记录（持久化到 ~/.claude/dream/feedback.json） */
export interface DreamFeedbackRecord {
  timestamp: string
  tier: string
  triageScore: number
  cardsProduced: number
  durationMs: number
  focusSessions: string[]
  /** 各评分因子的实际贡献度（用于在线学习权重调整） */
  factorContributions: {
    novelty: number
    conflict: number
    correction: number
    surprise: number
    error: number
  }
}

/** 在线学习后的权重（默认即当前 triage.ts 的硬编码值） */
export interface TriageWeights {
  novelty: number
  conflict: number
  correction: number
  surprise: number
  error: number
  /**
   * Phase B1 新增：图谱重要性权重。兼容老权重文件（加载时自动回填默认值）。
   */
  graph: number
  /**
   * Phase B1 新增：概念新颖度权重。兼容老权重文件（加载时自动回填默认值）。
   */
  concept: number
  updatedAt: string
}

const DEFAULT_WEIGHTS: TriageWeights = {
  novelty: 0.4,
  conflict: 0.3,
  correction: 0.2,
  surprise: 0.1,
  error: 0.2,
  graph: 0.2,
  concept: 0.15,
  updatedAt: new Date().toISOString(),
}

/**
 * 对外导出默认权重（供 triage.ts 在 loadWeights 失败时回退 / 供 /memory-map 展示 delta）。
 * 注意：不要直接 import 常量去解构后修改，请改用 { ...DEFAULT_WEIGHTS } 克隆。
 */
export { DEFAULT_WEIGHTS }

const LEARNING_RATE = 0.05 // ε — 保守学习率，防止震荡

/**
 * 记录 Dream 执行结果并更新权重
 *
 * 在线学习策略（ε-greedy bandit 简化版）：
 *   如果 cardsProduced > 0（有效巩固）：
 *     → 增强高贡献因子的权重（+ε）
 *   如果 cardsProduced == 0（无效巩固）：
 *     → 降低触发因子的权重（-ε）
 *   权重归一化到总和 = 1.2（与当前默认总和一致）
 */
export async function recordDreamOutcome(
  decision: TriageDecision,
  result: MicroDreamResult,
): Promise<void> {
  try {
    const record: DreamFeedbackRecord = {
      timestamp: new Date().toISOString(),
      tier: decision.tier,
      triageScore: decision.score,
      cardsProduced: result.cards.length,
      durationMs: result.durationMs,
      focusSessions: result.focusSessions,
      factorContributions: decision.breakdown,
    }

    // 持久化反馈记录
    await appendFeedback(record)

    // 在线学习：调整 triage 权重
    const currentWeights = await loadWeights()
    const updatedWeights = updateWeights(currentWeights, record)
    await saveWeights(updatedWeights)

    // 写入 EvidenceLedger（dream domain）
    try {
      const { EvidenceLedger } = await import('../../harness/index.js')
      EvidenceLedger.append({
        ts: record.timestamp,
        domain: 'dream',
        kind: 'consolidation_outcome',
        data: {
          tier: record.tier,
          triageScore: record.triageScore,
          cardsProduced: record.cardsProduced,
          durationMs: record.durationMs,
          focusSessionCount: record.focusSessions.length,
        },
      })
    } catch {
      // EvidenceLedger 不可用不影响反馈
    }

    logForDebugging(
      `[FeedbackLoop] recorded: tier=${record.tier} cards=${record.cardsProduced} ` +
      `weights=[n=${updatedWeights.novelty.toFixed(3)} c=${updatedWeights.conflict.toFixed(3)} ` +
      `cr=${updatedWeights.correction.toFixed(3)} s=${updatedWeights.surprise.toFixed(3)} ` +
      `e=${updatedWeights.error.toFixed(3)}]`,
    )
  } catch (e) {
    logForDebugging(`[FeedbackLoop] recordDreamOutcome failed: ${(e as Error).message}`)
  }
}

/** 基于反馈调整权重 */
function updateWeights(
  current: TriageWeights,
  record: DreamFeedbackRecord,
): TriageWeights {
  const { factorContributions: fc } = record
  const isEffective = record.cardsProduced > 0
  const direction = isEffective ? 1 : -1

  // 找到贡献最大的因子，给予额外奖励/惩罚
  const factors = [
    { key: 'novelty' as const, val: fc.novelty },
    { key: 'conflict' as const, val: fc.conflict },
    { key: 'correction' as const, val: fc.correction },
    { key: 'surprise' as const, val: fc.surprise },
    { key: 'error' as const, val: fc.error },
  ]
  factors.sort((a, b) => b.val - a.val)
  const topFactor = factors[0]?.key

  const updated = { ...current, updatedAt: new Date().toISOString() }

  for (const f of factors) {
    const boost = f.key === topFactor ? LEARNING_RATE * 1.5 : LEARNING_RATE * 0.5
    const key = f.key as keyof Omit<TriageWeights, 'updatedAt'>
    updated[key] = Math.max(0.01, updated[key] + direction * boost)
  }

  // 归一化到总和 = 1.2（保持与默认值总和一致）
  const TARGET_SUM = 1.2
  const sum = updated.novelty + updated.conflict + updated.correction +
    updated.surprise + updated.error
  if (sum > 0) {
    const scale = TARGET_SUM / sum
    updated.novelty *= scale
    updated.conflict *= scale
    updated.correction *= scale
    updated.surprise *= scale
    updated.error *= scale
  }

  // 四舍五入到 3 位小数
  updated.novelty = Math.round(updated.novelty * 1000) / 1000
  updated.conflict = Math.round(updated.conflict * 1000) / 1000
  updated.correction = Math.round(updated.correction * 1000) / 1000
  updated.surprise = Math.round(updated.surprise * 1000) / 1000
  updated.error = Math.round(updated.error * 1000) / 1000

  return updated
}

// --- 持久化工具 ---

function getFeedbackDir(): string {
  const { join } = require('path')
  const { homedir } = require('os')
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'dream')
}

async function appendFeedback(record: DreamFeedbackRecord): Promise<void> {
  const { appendFileSync, mkdirSync } = await import('fs')
  const { join } = await import('path')
  const dir = getFeedbackDir()
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, 'feedback.ndjson'), JSON.stringify(record) + '\n', 'utf-8')
}

export async function loadWeights(): Promise<TriageWeights> {
  try {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const filepath = join(getFeedbackDir(), 'weights.json')
    const content = readFileSync(filepath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<TriageWeights>
    if (typeof parsed.novelty === 'number') {
      // 向后兼容：老 weights.json 没有 graph/concept 字段，用 DEFAULT 回填。
      return {
        novelty: parsed.novelty,
        conflict: parsed.conflict ?? DEFAULT_WEIGHTS.conflict,
        correction: parsed.correction ?? DEFAULT_WEIGHTS.correction,
        surprise: parsed.surprise ?? DEFAULT_WEIGHTS.surprise,
        error: parsed.error ?? DEFAULT_WEIGHTS.error,
        graph: parsed.graph ?? DEFAULT_WEIGHTS.graph,
        concept: parsed.concept ?? DEFAULT_WEIGHTS.concept,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      }
    }
  } catch {
    // 文件不存在或损坏 → 返回默认值
  }
  return { ...DEFAULT_WEIGHTS }
}

async function saveWeights(weights: TriageWeights): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('fs')
  const { join } = await import('path')
  const dir = getFeedbackDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'weights.json'), JSON.stringify(weights, null, 2), 'utf-8')
}

/** 导出供 triage.ts 使用的动态权重加载器 */
export { loadWeights as getLearnedWeights }

// ───────────────────────────────────────────────────────────
// autoEvolve v1.0 适配器 —— 把本文件的 ε-greedy learner 泛化成
// Learner<TriageWeights, DreamFeedbackRecord>,供 autoEvolve/index.ts
// 的 Learner Registry 统一调度。
//
// 重要:本适配器只做"绑定",不修改任何既有函数的行为。
//   - recordDreamOutcome 的原调用路径保持不变
//   - 纯新增出口,dreamTriageLearner 被 ensureBuiltinLearners() 懒注册
// ───────────────────────────────────────────────────────────

import type { Learner } from '../../autoEvolve/types.js'

export const dreamTriageLearner: Learner<TriageWeights, DreamFeedbackRecord> = {
  domain: 'dream-triage',
  defaults: DEFAULT_WEIGHTS,
  load: loadWeights,
  // saveWeights / updateWeights 在本模块内是私有函数,但 ESM 同模块内
  // 可以直接引用(作为闭包绑定),无需额外 export。
  save: saveWeights,
  update: updateWeights,
  // normalize 已内嵌在 updateWeights 里(TARGET_SUM=1.2),无需再暴露
}
