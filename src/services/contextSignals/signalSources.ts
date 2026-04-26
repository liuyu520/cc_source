/**
 * Ph54(v2, 2026-04-24) · ContextSignalSource 接口抽象
 *
 * 背景
 * ────
 * Ph54 v1 只做了"账本"(recordSignalServed / recordSignalUtilization), 没做"接口"。
 * 所有调用点散写 `recordSignalServed({ kind: 'tool-result', ... })`, 每处都要硬编码 kind
 * 字符串和 decisionPoint 字符串, 新增一类 signal 需要改多个地方。
 *
 * 本模块提供一个**向后兼容的**薄层抽象:
 *   - 基类 `ContextSignalSource` 固定 kind, 调用方 `.serve(payload)` 即可
 *   - 预置子类对每个已知 kind 绑定一个"默认 decisionPoint", 减少样板
 *   - 不重写散写点(保留现状), 新增调用点可直接用新接口
 *
 * 设计原则(不破坏既有)
 * ─────────────────────
 *   1. 新接口内部全部走 recordSignalServed/Utilization —— 底层存储不变,
 *      telemetry / sampler / ledger 全部不受影响。
 *   2. 子类 kind 固定, 不允许覆盖(防止错位)。
 *   3. 可选 `defaultDecisionPoint`;若 serve payload 未传则用默认值。
 *   4. fail-open —— 底层异常已在 telemetry.ts 自吞, 基类额外包一层保险。
 *   5. 不引入状态 —— 基类无成员变量, 线程安全同 telemetry(就是 JS 单线程事件循环)。
 */

import { recordSignalServed, recordSignalUtilization } from './telemetry.js'
import type {
  ContextSignalKind,
  SignalServedEvent,
  SignalUtilizationEvent,
} from './types.js'

/** 调用方给的 payload —— kind 由基类填,调用方关心 tokens/anchors/meta */
export type SignalServePayload = Omit<
  SignalServedEvent,
  'ts' | 'kind' | 'decisionPoint'
> & { decisionPoint?: string; ts?: number }

export type SignalUtilizePayload = Omit<
  SignalUtilizationEvent,
  'ts' | 'kind' | 'decisionPoint'
> & { decisionPoint?: string; ts?: number }

/**
 * 基类 —— 所有 ContextSignalSource 的统一口型。
 *
 * 使用:
 * ```ts
 * const src = new ToolResultSignalSource()        // kind='tool-result'
 * src.serve({ tokens: 300, itemCount: 1, anchors: [...] })
 * src.utilize({ used: true, evidence: 'file-path-overlap' })
 * ```
 */
export abstract class ContextSignalSource {
  /** 固定 kind —— 子类必须定义 */
  abstract readonly kind: ContextSignalKind

  /** 默认 decisionPoint(可选) —— 若 serve/utilize payload 未传则 fallback 到这里 */
  protected readonly defaultDecisionPoint?: string

  constructor(opts?: { defaultDecisionPoint?: string }) {
    this.defaultDecisionPoint = opts?.defaultDecisionPoint
  }

  /**
   * 记录一次 "送入上下文" 事件。kind 由子类固定。
   * 调用方不需要关心 kind 或底层 telemetry。
   */
  serve(payload: SignalServePayload): void {
    try {
      recordSignalServed({
        kind: this.kind,
        decisionPoint: payload.decisionPoint ?? this.defaultDecisionPoint,
        ts: payload.ts,
        tokens: payload.tokens,
        itemCount: payload.itemCount,
        level: payload.level,
        relevance: payload.relevance,
        anchors: payload.anchors,
        meta: payload.meta,
      })
    } catch {
      // 保险:即使底层 telemetry 意外抛出也不污染调用方
    }
  }

  /** 记录一次 "事后是否被用到" 事件。决策权在调用方(overlap sampler / explicit read)。 */
  utilize(payload: SignalUtilizePayload): void {
    try {
      recordSignalUtilization({
        kind: this.kind,
        decisionPoint: payload.decisionPoint ?? this.defaultDecisionPoint,
        ts: payload.ts,
        used: payload.used,
        evidence: payload.evidence,
      })
    } catch {
      /* fail-open */
    }
  }
}

// ── 预置子类 —— 覆盖 Ph54 types.ts 里已知的 ContextSignalKind ─────────────

export class ToolResultSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'tool-result'
  constructor() { super({ defaultDecisionPoint: 'toolExecution.success' }) }
}

export class AutoMemorySignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'auto-memory'
  constructor() { super({ defaultDecisionPoint: 'memdir.findRelevantMemories' }) }
}

export class HistoryCompactSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'history-compact'
  constructor() { super({ defaultDecisionPoint: 'compact.autoDistill' }) }
}

export class TierIndexSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'tier-index'
  constructor() { super({ defaultDecisionPoint: 'tierManager.query' }) }
}

export class FileAttachmentSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'file-attachment'
  constructor() { super({ defaultDecisionPoint: 'attachment.inject' }) }
}

export class UserInputSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'user-input'
  constructor() { super({ defaultDecisionPoint: 'repl.userTurn' }) }
}

export class PatternMinerSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'pattern-miner'
  constructor() { super({ defaultDecisionPoint: 'patternMiner.served' }) }
}

export class AgentHandoffSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'agent-handoff'
  constructor() { super({ defaultDecisionPoint: 'agent.handoff' }) }
}

export class DreamArtifactSignalSource extends ContextSignalSource {
  readonly kind: ContextSignalKind = 'dream-artifact'
  constructor() { super({ defaultDecisionPoint: 'dream.distill' }) }
}

// ── 工厂 ─────────────────────────────────────────────────────────

const BUILTIN_FACTORIES: ReadonlyArray<
  readonly [ContextSignalKind, () => ContextSignalSource]
> = [
  ['tool-result', () => new ToolResultSignalSource()],
  ['auto-memory', () => new AutoMemorySignalSource()],
  ['history-compact', () => new HistoryCompactSignalSource()],
  ['tier-index', () => new TierIndexSignalSource()],
  ['file-attachment', () => new FileAttachmentSignalSource()],
  ['user-input', () => new UserInputSignalSource()],
  ['pattern-miner', () => new PatternMinerSignalSource()],
  ['agent-handoff', () => new AgentHandoffSignalSource()],
  ['dream-artifact', () => new DreamArtifactSignalSource()],
]
const FACTORY_MAP = new Map(BUILTIN_FACTORIES)

/**
 * 工厂 —— 按 kind 返回预置子类实例。对于未在 BUILTIN_FACTORIES 登记的 kind(字符串家族扩展),
 * 构造一个 AnonymousSignalSource(仅固定 kind,无默认 decisionPoint)。
 */
export function signalSourceFor(kind: ContextSignalKind): ContextSignalSource {
  const builtin = FACTORY_MAP.get(kind)
  if (builtin) return builtin()
  class AnonymousSignalSource extends ContextSignalSource {
    readonly kind: ContextSignalKind = kind
  }
  return new AnonymousSignalSource()
}

// 单测/诊断用
export const __internal = {
  BUILTIN_KINDS: BUILTIN_FACTORIES.map(([k]) => k),
}
