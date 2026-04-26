/**
 * PEV Harness (Plan-Execute-Verify) — 类型定义 (shadow skeleton)
 *
 * 目标：让 harness 对"自动运行代码"显式感知 blast radius / 可逆性 /
 * 失败分类。v1 仅在 BashTool 前置 dry-run，默认 OFF；真正切流由后续
 * 档位开关（CLAUDE_PEV_VERIFY / CLAUDE_PEV_PLAN / ...）推进。
 */

export type Reversibility = 'reversible' | 'partially' | 'irreversible'

export type FailureClass =
  | 'transient'
  | 'precondition'
  | 'syntax'
  | 'permission'
  | 'env_missing'
  | 'unknown'

export interface AffectedResource {
  kind: 'file' | 'dir' | 'process' | 'network' | 'package' | 'vcs'
  path?: string
  detail?: string
}

export interface BlastRadius {
  /** 人类可读的一句话摘要，用于 UI 预览 */
  summary: string
  /** 结构化受影响资源列表 */
  resources: AffectedResource[]
  /** 可逆性评级 */
  reversibility: Reversibility
  /** 是否建议强制用户确认（不可逆 + 高风险） */
  requiresExplicitConfirm: boolean
  /** 是否涉及网络外呼 */
  networkEgress: boolean
  /** 预测效应标签，供 Policy Engine 做 effect-level 权限决策 */
  effects: EffectTag[]
}

export type EffectTag =
  | 'read'
  | 'write'
  | 'exec'
  | 'network'
  | 'destructive-write'
  | 'vcs-mutate'
  | 'package-install'
  | 'external-visible'

export interface ActionContract<Input = unknown, Outcome = unknown> {
  /** 用于日志/埋点的稳定 id */
  readonly id: string
  dryRunPreview(input: Input): Promise<BlastRadius>
  classifyFailure(err: unknown, outcome?: Outcome): FailureClass
}
