/**
 * Fitness Observer — DreamEvidence → FitnessInput 映射 + scoreSubject 桥接
 *
 * 目的:
 *   Phase 3 最小增量 —— 让 Fitness Oracle 真正开始积累数据。
 *   Dream Pipeline 每 session 都会 captureEvidence() 一份 DreamEvidence,
 *   里面已经包含了用户纠错/surprise/toolErrorRate 等信号,正好是 Oracle 要的原材料。
 *
 *   我们不让 Oracle 直接耦合 Dream Pipeline:
 *     Dream Pipeline → evidenceBus.convergeDreamEvidence() ──► journal / EvidenceLedger
 *                                                       │
 *                                                       └──► observeDreamEvidence()  ← 本模块
 *                                                                    ↓
 *                                                            scoreSubject()
 *                                                                    ↓
 *                                                        ~/.claude/autoEvolve/oracle/fitness.ndjson
 *
 * 纪律:
 *   - 纯观察,不改行为
 *   - 失败静默,不向 Dream Pipeline 抛异常
 *   - 没有开关守卫 —— fitness.ndjson 本身就是 autoEvolve 私有存储,
 *     scoreSubject 写入不会影响任何其它子系统
 *   - 映射函数 dreamEvidenceToFitnessInput 是纯函数,可独立测试
 */

import { logForDebugging } from '../../../utils/debug.js'
import type { DreamEvidence } from '../../autoDream/pipeline/types.js'
import type { FitnessInput } from './fitnessOracle.js'

/**
 * 把 DreamEvidence 映射成 FitnessInput。
 *
 * 映射依据:
 *   - userRevert:  conflicts + userCorrections > 0 视为用户做过纠正
 *   - taskCompleted: memoryTouched —— session 末尾写了新记忆,说明有可回忆的进展
 *   - skepticalBlocked: 暂无 DreamEvidence 字段承载,保守留 false(Phase 4 可从 EvidenceLedger reviewer domain 补)
 *   - toolRetries: surprise 是 tool error / exception / retry 合流值,直接用
 *   - blastRadiusScore: 用 -toolErrorRate(0..1)映射到 [-1, 0],toolErrorRate 高即质量低
 *   - durationMs:  直接透传(当前无 baseline,Performance 维度会得 0)
 *   - touchedForbiddenZone: DreamEvidence 不承载,保守 false
 *   - meta: 保留原始 novelty / filesTouched / toolErrorRate 供后续审计
 */
export function dreamEvidenceToFitnessInput(ev: DreamEvidence): FitnessInput {
  const userInterrupted = (ev.conflicts ?? 0) + (ev.userCorrections ?? 0) > 0
  const errorRate = typeof ev.toolErrorRate === 'number' ? ev.toolErrorRate : 0

  return {
    subjectId: ev.sessionId,
    userRevert: userInterrupted || undefined,
    taskCompleted: Boolean(ev.memoryTouched) || undefined,
    // Phase 3 占位:DreamEvidence 没有 skeptical 字段
    skepticalBlocked: undefined,
    toolRetries: ev.surprise ?? 0,
    // blastRadius 替代信号:error 越多代码质量越低
    blastRadiusScore: errorRate > 0 ? -Math.min(1, errorRate) : 0,
    durationMs: ev.durationMs,
    // baseline 暂未接入,performance 维度得 0
    tokensUsed: undefined,
    tokensBaseline: undefined,
    durationBaseline: undefined,
    touchedForbiddenZone: false,
    meta: {
      source: 'dreamEvidence',
      novelty: ev.novelty ?? null,
      conflicts: ev.conflicts ?? 0,
      userCorrections: ev.userCorrections ?? 0,
      toolErrorRate: errorRate,
      filesTouched: ev.filesTouched ?? 0,
      memoryTouched: Boolean(ev.memoryTouched),
      hasEpisodicPayload: Boolean(ev.episodicPayload),
      graphImportance: ev.graphImportance ?? null,
      conceptualNovelty: ev.conceptualNovelty ?? null,
    },
  }
}

/**
 * 桥接入口 —— 由 evidenceBus.convergeDreamEvidence 末尾调用。
 * 所有失败在本函数内消化,绝不向上游抛。
 *
 * Phase 26:在 cwd 向上查找 `.autoevolve-organism` marker。
 *   - 命中 → 把 organismId 注入 FitnessInput,让 aggregator 直接归属,
 *     跳过 Phase 7 的 session-organisms 反查。
 *   - 未命中 → 不填,走原 Phase 7 反查路径(完全兼容老数据)。
 *   - marker 读取失败静默 → 不打断主路径,降级为未命中。
 */
export async function observeDreamEvidence(ev: DreamEvidence): Promise<void> {
  try {
    const input = dreamEvidenceToFitnessInput(ev)
    // Phase 26:cwd 上嗅 marker。动态 import paths 避免冷启动依赖。
    try {
      const { readOrganismMarker } = await import('../paths.js')
      const organismId = readOrganismMarker(process.cwd())
      if (organismId) input.organismId = organismId
    } catch {
      // 非 Node 环境 / paths 模块加载失败 — 降级为未命中
    }
    // 动态导入避免启动时拉 Oracle 全家桶(evidenceBus 在 Dream 主路径上,要冷)
    const { scoreSubject } = await import('./fitnessOracle.js')
    scoreSubject(input)
  } catch (e) {
    logForDebugging(
      `[autoEvolve:fitnessObserver] observeDreamEvidence failed: ${(e as Error).message}`,
    )
  }
}
