/**
 * Dream Pipeline 入口 (v1+: Capture + Triage + learned weights)
 *
 * 用法：
 *   import { captureEvidence, runTriage, isDreamPipelineEnabled } from '.../pipeline'
 *
 *   // session 结束时
 *   if (isDreamPipelineEnabled()) captureEvidence({...})
 *
 *   // 后台调度（建议走 SideQueryScheduler P3）
 *   const decision = await runTriage({ windowMs: 24*3600*1000 })
 *
 * 影子模式 (默认)：decision 只打日志，不替换 autoDream.ts 的原始门控。
 *
 * Phase A 升级：runTriage / dispatchDream 改异步，内部
 * feedbackLoop.loadWeights() 闭合反馈回路（triage 评分基于学到的权重）。
 */

import { logForDebugging } from '../../../utils/debug.js'
import {
  isDreamMicroEnabled,
  isDreamPipelineEnabled,
  isDreamPipelineShadow,
} from './featureCheck.js'
import { captureEvidence, journalFilePath, listRecent } from './journal.js'
import { triage, triageSync } from './triage.js'
import type { DreamEvidence, TriageDecision } from './types.js'

export * from './types.js'
export {
  isDreamMicroEnabled,
  isDreamPipelineEnabled,
  isDreamPipelineShadow,
} from './featureCheck.js'
export { captureEvidence, journalFilePath, listRecent } from './journal.js'
export { triage, triageSync } from './triage.js'

export interface RunTriageOpts {
  /** 扫描最近多少毫秒的 evidence，默认 24h */
  windowMs?: number
}

/**
 * 读取 journal，产出 TriageDecision（使用 learned weights），并在影子模式下打日志。
 * 返回 null 表示 pipeline 未启用，调用方应回退到 legacy autoDream 行为。
 */
export async function runTriage(
  opts: RunTriageOpts = {},
): Promise<TriageDecision | null> {
  if (!isDreamPipelineEnabled()) {
    logForDebugging('[DreamPipeline:triage] skipped: pipeline disabled')
    return null
  }
  const windowMs = opts.windowMs ?? 24 * 3600 * 1000
  const evidences = listRecent(windowMs)
  logForDebugging(
    `[DreamPipeline:triage] input: windowMs=${windowMs} journal=${journalFilePath()} evidenceCount=${evidences.length}`,
  )
  const decision = await triage(evidences)

  const wu = decision.weightsUsed
  logForDebugging(
    `[DreamPipeline:triage] tier=${decision.tier} score=${decision.score} ` +
      `n=${decision.evidenceCount} shadow=${isDreamPipelineShadow()} ` +
      `focus=${decision.focusSessions.join(',')} ` +
      (wu
        ? `w=[n=${wu.novelty.toFixed(2)} c=${wu.conflict.toFixed(2)} cr=${wu.correction.toFixed(2)} s=${wu.surprise.toFixed(2)} e=${wu.error.toFixed(2)} g=${wu.graph.toFixed(2)} cn=${wu.concept.toFixed(2)}]`
        : ''),
  )
  return decision
}

/**
 * 对外统一调度接口：供 autoDream 或 SideQueryScheduler 调用。
 *  - flag OFF              → 返回 { action: 'legacy' } 表示走旧路径
 *  - shadow mode (默认)    → 返回 { action: 'legacy', shadow: decision }
 *  - 切流 + micro 档位     → 返回 { action: 'micro', decision }
 *  - 切流 + full           → 返回 { action: 'full',  decision }
 *  - 切流 + skip           → 返回 { action: 'skip',  decision }
 */
export type DreamDispatch =
  | { action: 'legacy'; shadow?: TriageDecision }
  | { action: 'skip'; decision: TriageDecision }
  | { action: 'micro'; decision: TriageDecision }
  | { action: 'full'; decision: TriageDecision }

export async function dispatchDream(
  opts: RunTriageOpts = {},
): Promise<DreamDispatch> {
  const decision = await runTriage(opts)
  if (!decision) return { action: 'legacy' }

  if (isDreamPipelineShadow()) {
    return { action: 'legacy', shadow: decision }
  }

  switch (decision.tier) {
    case 'skip':
      return { action: 'skip', decision }
    case 'micro':
      // micro 档位要求额外 flag，否则退回 legacy
      return isDreamMicroEnabled()
        ? { action: 'micro', decision }
        : { action: 'legacy', shadow: decision }
    case 'full':
      return { action: 'full', decision }
  }
}

/** 便捷 helper：给单个 evidence 打分的入口（用于调用方自己做门控） */
export function captureAndMaybeTrigger(ev: DreamEvidence): void {
  if (!isDreamPipelineEnabled()) return
  captureEvidence(ev)
}

