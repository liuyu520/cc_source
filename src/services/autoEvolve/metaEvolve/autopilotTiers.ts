/**
 * G2 Step 3 (2026-04-26) — Autopilot Tier Classifier
 *
 * 把 metaActionPlan 里的候选动作(paramDecisions + oracle weightSuggestion)按风险分
 * 三档,回答 /evolve-autopilot 要显示的「哪些将来可自动落、哪些要人看」。
 *
 * 分档(对齐 docs/ai-coding-agent-improvement-spaces-2026-04-25.md §G2):
 *   auto-apply  — 白名单级,safe 且可回滚:oracleWeights.applyHint、arenaShadowCount 步进
 *   auto-propose — 产 proposal 但仍要 /evolve-accept:mutationRate、selectionPressure、learningRate
 *   manual-only  — 破坏性/跨 FSM 档:toStatus=stable 等
 *
 * 本模块是纯函数 + 纯读 classifier。不执行、不落盘、不 apply。
 * 供 /evolve-autopilot preview 命令使用,也可被未来的 autopilot runner 复用。
 */

import type {
  MetaActionPlanSnapshot,
  MetaParamDecision,
  MetaParamName,
} from './metaActionPlan.js'

export type AutopilotTier = 'auto-apply' | 'auto-propose' | 'manual-only'

export interface AutopilotItem {
  // 稳定的逻辑 id,用于 --json 输出与未来的 audit 关联
  id: string
  // 人读标签,形如 "arenaShadowCount: hold → hold" 或 "oracleWeights"
  label: string
  // 三档之一
  tier: AutopilotTier
  // 简短 why,记录分档依据
  reason: string
  // 直接执行 applyHint(如果有)
  applyHint: string | null
  // 承载 kind:param | oracle-weights,给 renderer 做分组
  kind: 'param' | 'oracle-weights'
  // 仅 param 类型有,方便 --json 消费者回指 metaActionPlan
  paramName: MetaParamName | null
  // 对 param:direction;对 oracle-weights:固定 'weights'
  direction: 'up' | 'down' | 'hold' | 'weights'
}

/**
 * MetaParamName → tier 映射表(白名单)。直接按 param 名分档,不看 direction。
 * 理由:direction 是「oracle 建议朝哪边挪」,不是风险属性;风险属性由 param 本身决定
 * (mutationRate 改大会让 shadow 种群更发散,属于需要人看;arenaShadowCount 只是改
 * 并行度,可回滚)。
 */
const PARAM_TIER_MAP: Record<MetaParamName, AutopilotTier> = {
  // safe:只改 shadow arena 并行度,不影响 genome;applyHint 写 env 即可回滚
  arenaShadowCount: 'auto-apply',
  // propose:改 mutation 分布,影响下一批 shadow 产出质量,值得人看
  mutationRate: 'auto-propose',
  // propose:改选择压,影响 promotion 梯度,风险与 mutationRate 同级
  selectionPressure: 'auto-propose',
  // propose:改 advisor 学习速率,影响 source.hunger 等派生信号,仍待验证
  learningRate: 'auto-propose',
}

/**
 * 从 MetaActionPlanSnapshot 抽出所有 actionable 项,按档位返回。
 *
 * 纯函数:snapshot 由 caller 传入,不从盘上读。
 * fail-soft:未识别的 param 视为 manual-only(保守档),不抛异常。
 */
export function classifyAutopilotItems(
  plan: MetaActionPlanSnapshot,
): AutopilotItem[] {
  const items: AutopilotItem[] = []

  // param 档:只收 direction !== 'hold' 的(hold 表示 oracle 建议不动,无需排期)
  for (const decision of plan.paramDecisions) {
    if (decision.direction === 'hold') continue
    items.push(buildParamItem(decision))
  }

  // oracle-weights 档:有 applyHint 才入列
  // oracle.actionable=false 或 applyHint 为空则跳过,不要 padding
  if (plan.oracle.actionable) {
    const weightsItem = buildOracleWeightsItem(plan)
    if (weightsItem) items.push(weightsItem)
  }

  return items
}

function buildParamItem(decision: MetaParamDecision): AutopilotItem {
  const tier = PARAM_TIER_MAP[decision.name] ?? 'manual-only'
  const label = `${decision.name}: ${decision.direction}`
  const reason =
    tier === 'auto-apply'
      ? 'safe: shadow-only knob, env-revertible'
      : tier === 'auto-propose'
        ? 'needs review: affects genome/signal regime'
        : 'unclassified param, defaulted to manual'
  return {
    id: `param:${decision.name}`,
    label,
    tier,
    reason,
    applyHint: decision.applyHint,
    kind: 'param',
    paramName: decision.name,
    direction: decision.direction,
  }
}

function buildOracleWeightsItem(
  plan: MetaActionPlanSnapshot,
): AutopilotItem | null {
  const oracle = plan.oracle
  const suggestion = oracle.weightSuggestion
  // 没有权重 applyHint 就不要塞空项
  // (MetaOracleDecision.nextLabel / nextPayload 可能都 null)
  if (!suggestion || !oracle.nextLabel) return null
  return {
    id: 'oracle-weights',
    label: `oracleWeights → ${oracle.nextLabel}`,
    tier: 'auto-apply',
    reason:
      'safe: tuned oracle weights, env-revertible (CLAUDE_ORACLE_WEIGHTS_PATH)',
    applyHint: oracle.reason || null,
    kind: 'oracle-weights',
    paramName: null,
    direction: 'weights',
  }
}

/**
 * 把 items 按档位 group。返回三档的数组(即便为空也保留 key),供渲染器做对齐排版。
 */
export function groupByTier(items: AutopilotItem[]): Record<
  AutopilotTier,
  AutopilotItem[]
> {
  const out: Record<AutopilotTier, AutopilotItem[]> = {
    'auto-apply': [],
    'auto-propose': [],
    'manual-only': [],
  }
  for (const item of items) out[item.tier].push(item)
  return out
}

/**
 * CLAUDE_EVOLVE_AUTOPILOT_LEVEL 读取器:normalize + 默认 'off'。
 *
 * 本 Step 只读、只展示,不据此决定 apply。后续 autopilot runner 才消费这个枚举。
 */
export type AutopilotLevel = 'safe' | 'propose' | 'off'
export function readAutopilotLevel(): AutopilotLevel {
  const raw = (process.env.CLAUDE_EVOLVE_AUTOPILOT_LEVEL ?? '').trim().toLowerCase()
  if (raw === 'safe') return 'safe'
  if (raw === 'propose') return 'propose'
  return 'off'
}

/**
 * 给定一个 level,返回在该 level 下会被自动放行的档位集合。纯描述,不触发动作。
 */
export function tiersAllowedByLevel(level: AutopilotLevel): AutopilotTier[] {
  if (level === 'propose') return ['auto-apply', 'auto-propose']
  if (level === 'safe') return ['auto-apply']
  return []
}
