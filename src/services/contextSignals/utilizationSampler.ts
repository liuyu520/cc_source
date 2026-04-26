/**
 * ContextSignals · utilizationSampler —— Phase 58 反向采样骨架
 *
 * 目标:
 *   在 turn 结束后, 拿到 model 的输出文本 + 最近 N 秒内 served 的 signals,
 *   做极简 string-overlap 粗估: 若输出里明显命中 signal 的关键字/路径/符号,
 *   则记 `used=true`, 否则 `used=false`。
 *
 * 设计约束:
 * - 本阶段**只提供函数 + API**, 不自动挂钩。自动挂钩留给 Phase 59。
 * - 判断极简, 宁可漏报(false positive 很伤)也不滥打 used=true。
 * - 未来升级空间: token-level cosine / attention-proxy / explicit tool-ref 等。
 *
 * 用法:
 *   import { sampleUtilizationByOverlap } from '.../contextSignals'
 *   sampleUtilizationByOverlap({
 *     modelOutput: response.text,
 *     signals: [{ kind: 'auto-memory', anchors: ['MEMORY.md', '/path/to/a.md'] }],
 *   })
 *   // 内部自动为每个 signal 调 recordSignalUtilization
 */

import { recordSignalUtilization, drainUnsampledServedEvents } from './telemetry.js'
import { recordEvidenceEdge } from './evidenceGraph.js'
import type { ContextSignalKind, SignalServedEvent } from './types.js'

export type UtilizationSampleInput = {
  /** 模型输出文本(可取 assistant message content 的 concat) */
  modelOutput: string
  /** 待采样的 signals, 每个含若干 "anchor" 字符串(文件路径/符号/关键字) */
  signals: ReadonlyArray<{
    kind: ContextSignalKind
    decisionPoint?: string
    /** 若存在任一 anchor 出现在 modelOutput 则判定 used=true */
    anchors: ReadonlyArray<string>
  }>
}

export type UtilizationSampleResult = {
  sampled: number
  used: number
  notUsed: number
}

/**
 * 采样: 逐个 signal 用 anchor 命中判断 used, 调 recordSignalUtilization。
 * 注意:
 * - anchor 长度 < 3 的直接丢弃(噪声太大)
 * - 大小写敏感;模型输出里可能原样引用路径/符号, 这是稳健信号
 * - 失败静默
 */
export function sampleUtilizationByOverlap(
  input: UtilizationSampleInput,
): UtilizationSampleResult {
  let sampled = 0
  let used = 0
  let notUsed = 0
  try {
    const output = input.modelOutput ?? ''
    for (const sig of input.signals) {
      const validAnchors = sig.anchors.filter(
        a => typeof a === 'string' && a.length >= 3,
      )
      if (validAnchors.length === 0) continue
      sampled += 1
      const hit = validAnchors.some(a => output.includes(a))
      recordSignalUtilization({
        kind: sig.kind,
        decisionPoint: sig.decisionPoint,
        used: hit,
        evidence: hit ? 'string-overlap' : 'no-overlap',
      })
      if (hit) used += 1
      else notUsed += 1
    }
  } catch {
    // 采样失败吞掉, 不影响调用方
  }
  return { sampled, used, notUsed }
}

/**
 * Phase 58b · 自动采样: 从 telemetry ring 里 drain 出所有未采样 served events,
 * 对带 anchors 的那些做 string-overlap, 写入 utilization。
 *
 * 调用时机: 在 assistant message 生成完毕时(见 services/api/claude.ts 的 yield 点)。
 * 幂等: drain 过的 events 不会被二次采样。
 *
 * @param modelOutput 模型输出的文本内容(从 assistant message content 拼出)
 * @param windowMs  采样窗口, 默认 60s (超时的 served 事件视为太旧, 不采样)
 */
export function autoSampleSinceLastCall(
  modelOutput: string,
  windowMs = 60_000,
): UtilizationSampleResult {
  try {
    const events: ReadonlyArray<SignalServedEvent> =
      drainUnsampledServedEvents(windowMs)
    // Phase 61(2026-04-24):无论本轮有没有新 served 事件, 都尝试对 model output
    //   做一次 per-memory basename 扫描 —— 这样即便 auto-memory 是上几轮投递的,
    //   本轮 model 里引用它 basename 也能被记一次 used。
    //   独立 try:不因 ledger 失败回波影响主路径采样。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { observeModelOutputForMemoryUsage } = require('./memoryUtilityLedger.js') as typeof import('./memoryUtilityLedger.js')
      if (typeof modelOutput === 'string' && modelOutput.length > 0) {
        observeModelOutputForMemoryUsage(modelOutput)
      }
    } catch {
      // 没有 ledger 模块就跳过, 不影响 overlap 采样
    }
    // Phase 64(2026-04-24):对 dream-artifact tracker 做一次扫描 ——
    //   Phase 63 只记 served,utilRate 永远 n/a;这里命中任一 distilled basename
    //   即给 ContextSignals 记一次 recordSignalUtilization({kind:'dream-artifact', used:true})。
    //   不记 used=false:dream-artifact 稀疏,没命中不等于不值(可能还没到该话题)。
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { observeModelOutputForDreamArtifacts } = require('./dreamArtifactTracker.js') as typeof import('./dreamArtifactTracker.js')
      if (typeof modelOutput === 'string' && modelOutput.length > 0) {
        observeModelOutputForDreamArtifacts(modelOutput)
      }
    } catch {
      // 没有 tracker 模块就跳过, 不影响 overlap 采样
    }
    if (events.length === 0) return { sampled: 0, used: 0, notUsed: 0 }
    // 只采样带 anchors 的事件; 其余归档(drain 已标记为采样过, 不会再来)
    const signals = events
      .filter(ev => ev.anchors && ev.anchors.length > 0)
      .map(ev => ({
        kind: ev.kind as ContextSignalKind,
        decisionPoint: ev.decisionPoint,
        anchors: ev.anchors!,
      }))
    recordEvidenceFromServedEvents(events, modelOutput)
    if (signals.length === 0) return { sampled: 0, used: 0, notUsed: 0 }
    return sampleUtilizationByOverlap({ modelOutput, signals })
  } catch {
    return { sampled: 0, used: 0, notUsed: 0 }
  }
}

function recordEvidenceFromServedEvents(
  events: ReadonlyArray<SignalServedEvent>,
  modelOutput: string,
): void {
  try {
    if (!modelOutput || events.length === 0) return
    for (const ev of events) {
      const anchors = (ev.anchors ?? []).filter(a => typeof a === 'string' && a.length >= 3)
      if (anchors.length === 0) continue
      const matched = anchors.filter(a => modelOutput.includes(a)).slice(0, 5)
      const sourceId = `${ev.kind}:${ev.decisionPoint ?? ev.ts}:${ev.ts}`
      for (const anchor of matched) {
        recordEvidenceEdge({
          from: sourceId,
          to: anchor,
          fromKind: 'source',
          toKind: 'entity',
          relation: 'mentioned-anchor',
          contextItemId: sourceId,
          sourceKind: ev.kind,
        })
      }
      recordEvidenceEdge({
        from: sourceId,
        to: matched.length > 0 ? 'used:string-overlap' : 'unused:no-overlap',
        fromKind: 'source',
        toKind: 'outcome',
        relation: 'sampled-utilization',
        contextItemId: sourceId,
        sourceKind: ev.kind,
      })
    }
  } catch {
    // evidence graph 只是观测层,不得影响 utilization 主路径
  }
}
