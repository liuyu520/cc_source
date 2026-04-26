/**
 * KernelState — 跨子系统共享的"世界状态总线"的状态层。
 *
 * 设计原则(Phase 1 骨架):
 * - 零耦合:不 import 任何具体子系统的类型,只用字符串 union。各子系统通过自己的
 *   adapter 把内部状态映射成 KernelAction 后 dispatch,从而保持 kernel 对业务无感。
 * - 只放"聚合信号":原始数据(消息、文件、历史)留在各子系统自己的存储里,这里只
 *   维护决策需要读到的**派生指标**与**滑动窗口**。
 * - 唯一写入路径 = kernelDispatch;唯一读取路径 = kernelSelectors。
 * - Phase 1 只是骨架:字段就位、reducer 就位、零子系统真正 dispatch,故行为不变。
 */

// —— 字符串联合:刻意解耦,避免 import 具体子系统类型 ——
export type KernelIntentClass =
  | 'chitchat'
  | 'simple'
  | 'normal'
  | 'complex'
  | 'unknown'

export type KernelExecMode =
  | 'auto'
  | 'plan'
  | 'strict'
  | 'bypass'
  | 'unknown'

export type KernelProvider =
  | 'anthropic'
  | 'codex'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'other'

export type KernelExecOutcome = 'ok' | 'fail' | 'undo'
export type KernelRejectionKind = 'deny' | 'undo' | 'redo'

// —— 结构 ——

export type KernelCost = {
  // 会话/进程维度累计 token(输入+输出)。不做跨进程持久化(Phase 1 不扩展持久层)。
  monthTokens: number
  // 按 modelCost 折算的累计美元。只做软指标,非计费。
  monthUSD: number
  // 当日预算(0 = 未设置)。由用户 / settings 推入,Phase 1 不读 settings,仅放架构位。
  dayBudgetUSD: number
}

export type KernelHypothesis = {
  id: string
  // 子系统自定义的聚类标签(如 "bash-permission-denied"),用于同类匹配。
  tag: string
  severity: 1 | 2 | 3
  openedAt: number
}

export type KernelFailure = {
  tool: string
  ts: number
  errorClass: string
}

export type KernelExecTrace = {
  ts: number
  mode: KernelExecMode
  outcome: KernelExecOutcome
}

export type KernelRejection = {
  ts: number
  // 子系统约定的动作分类(如 "git-push"、"file-edit")。字符串故意弱类型以解耦。
  actionClass: string
  kind: KernelRejectionKind
}

export type KernelCompactBurst = {
  lastTs: number
  countLast10min: number
}

export type KernelScene = {
  provider: KernelProvider
  // 是否为 claude.ai 的 OAuth proxy 路径(现有 isFirstPartyAnthropicBaseUrl 可推入)。
  oauthProxy: boolean
}

export type KernelState = {
  cost: KernelCost
  openHypotheses: ReadonlyArray<KernelHypothesis>
  recentFailures: ReadonlyArray<KernelFailure>
  intentHistogram: Readonly<Record<KernelIntentClass, number>>
  execModeTrace: ReadonlyArray<KernelExecTrace>
  userRejections: ReadonlyArray<KernelRejection>
  compactBurst: KernelCompactBurst
  skillRecallHeat: Readonly<Record<string, number>>
  scene: KernelScene
}

// —— 滑动窗口上限(防止 kernel 无界增长) ——
export const KERNEL_MAX_FAILURES = 20
export const KERNEL_MAX_EXEC_TRACE = 50
export const KERNEL_MAX_REJECTIONS = 50
export const KERNEL_MAX_HYPOTHESES = 30
export const KERNEL_MAX_SKILL_HEAT = 64
export const KERNEL_COMPACT_WINDOW_MS = 10 * 60 * 1000

const INITIAL_INTENT_HISTOGRAM: Readonly<Record<KernelIntentClass, number>> =
  Object.freeze({
    chitchat: 0,
    simple: 0,
    normal: 0,
    complex: 0,
    unknown: 0,
  })

export function initialKernelState(): KernelState {
  return {
    cost: { monthTokens: 0, monthUSD: 0, dayBudgetUSD: 0 },
    openHypotheses: [],
    recentFailures: [],
    intentHistogram: INITIAL_INTENT_HISTOGRAM,
    execModeTrace: [],
    userRejections: [],
    compactBurst: { lastTs: 0, countLast10min: 0 },
    skillRecallHeat: {},
    scene: { provider: 'anthropic', oauthProxy: false },
  }
}
