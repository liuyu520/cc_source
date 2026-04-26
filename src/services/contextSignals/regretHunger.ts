/**
 * ContextSignals · regretHunger —— Phase 58 深化(2026-04-24)
 *
 * 纯派生函数:从 ContextSignalsSnapshot 计算每个 kind 的 Regret/Hunger 偏置。
 * 不写账本、不改 telemetry、不依赖时间窗——瞬时态只读。
 *
 * 蓝图定义(context-choreography-upgrade-2026-04-24.md §3.4):
 *   Regret:某 source 被送进来但模型**没引用** → relevance 下调(bias = -1)
 *   Hunger:模型总能用到但 servedCount 明显少于同轮其他 active source → 上调(+1)
 *
 * 判据(可通过 opts 与 env 覆盖,fail-open):
 *   - sampledCount = utilizedCount + notUtilizedCount;不足 minSample 视作"没足够证据"→ bias=0
 *   - Regret = sampled ≥ minSample && utilizationRate < regretBelow
 *   - Hunger = sampled ≥ minSample && utilizationRate ≥ hungerAbove
 *              && avgServedOfActive > 0
 *              && servedCount < avgServedOfActive × hungerServedLowRatio
 *
 * 复用既有设施:
 *   - 读 getContextSignalsSnapshot 的输出(Phase 54 telemetry,无新采集点)
 *   - env 解析沿用"空/无法识别即取默认"的 signal-to-decision 栈写法
 *
 * 消费者:
 *   - advisor.ts · Rule 7 把 hunger kinds 合成 'source.hunger.<kind>' advisory
 *   - kernel-status(后续视需要加列) / Pattern Miner(未来 context-selector 源偏置)
 */

import type {
  ContextSignalKind,
  ContextSignalsSnapshot,
} from './types.js'

// ── 对外类型 ─────────────────────────────────────────────
export type SourceBias = -1 | 0 | 1

export type SourceEconomics = {
  kind: ContextSignalKind
  servedCount: number
  sampledCount: number
  utilizationRate: number
  /** 过量输送:送了但模型不引用 */
  regret: boolean
  /** 不足输送:利用率高但送得少 */
  hunger: boolean
  /** -1 建议下调 / 0 无动作 / +1 建议上调 */
  bias: SourceBias
}

export type ComputeSourceEconomicsOptions = {
  /** utilizationRate 严格小于此值触发 Regret;默认 0.15 */
  regretBelow?: number
  /** utilizationRate ≥ 此值才作为 Hunger 候选;默认 0.75 */
  hungerAbove?: number
  /** 采样分母阈值;默认 5 */
  minSample?: number
  /** Hunger servedCount 相对基准 = active 平均 × 此系数;默认 0.5 */
  hungerServedLowRatio?: number
}

// ── 常量(也作为 fail-open 的默认) ────────────────────────
const DEFAULT_REGRET_BELOW = 0.15
const DEFAULT_HUNGER_ABOVE = 0.75
const DEFAULT_MIN_SAMPLE = 5
const DEFAULT_HUNGER_LOW_RATIO = 0.5

/**
 * 环境变量解析 —— 仅接受可解析为 finite number 的值,clamp 到 [min,max]。
 * 与其他 ContextSignals 模块相同:无效值 fail-open 到 default。
 */
function envNumber(
  name: string,
  dflt: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return dflt
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/**
 * 根据快照算出每 kind 的 Regret/Hunger bias。
 *
 * 设计决定:
 *   - 不去重/不排序,按 snapshot.byKind 的顺序 1:1 输出,调用方可直接 zip。
 *   - 计算纯加法 O(N),无异步,无 I/O。
 *   - 任何异常兜底返回空数组,避免打断上游 /kernel-status 渲染或 advisor 流水线。
 */
export function computeSourceEconomics(
  snapshot: ContextSignalsSnapshot,
  opts: ComputeSourceEconomicsOptions = {},
): ReadonlyArray<SourceEconomics> {
  try {
    const regretBelow = clampProbability(
      opts.regretBelow
        ?? envNumber('CLAUDE_EVOLVE_REGRET_BELOW', DEFAULT_REGRET_BELOW, 0, 1),
    )
    const hungerAbove = clampProbability(
      opts.hungerAbove
        ?? envNumber('CLAUDE_EVOLVE_HUNGER_ABOVE', DEFAULT_HUNGER_ABOVE, 0, 1),
    )
    const minSample = Math.max(
      1,
      Math.round(
        opts.minSample
          ?? envNumber(
            'CLAUDE_EVOLVE_REGRET_HUNGER_MIN_SAMPLE',
            DEFAULT_MIN_SAMPLE,
            1,
            1000,
          ),
      ),
    )
    const hungerLowRatio = clampProbability(
      opts.hungerServedLowRatio
        ?? envNumber(
          'CLAUDE_EVOLVE_HUNGER_LOW_RATIO',
          DEFAULT_HUNGER_LOW_RATIO,
          0.01,
          1,
        ),
    )

    // active = 有足够采样证据的 kind 集合,作为"同轮可比"的基准
    const active = snapshot.byKind.filter(
      k => k.utilizedCount + k.notUtilizedCount >= minSample,
    )
    const avgServed =
      active.length > 0
        ? active.reduce((s, k) => s + k.servedCount, 0) / active.length
        : 0

    const out: SourceEconomics[] = []
    for (const k of snapshot.byKind) {
      const sampled = k.utilizedCount + k.notUtilizedCount
      const hasEnough = sampled >= minSample
      let regret = false
      let hunger = false
      if (hasEnough) {
        if (k.utilizationRate < regretBelow) {
          regret = true
        } else if (
          k.utilizationRate >= hungerAbove
          && avgServed > 0
          && k.servedCount < avgServed * hungerLowRatio
        ) {
          hunger = true
        }
      }
      const bias: SourceBias = regret ? -1 : hunger ? 1 : 0
      out.push({
        kind: k.kind,
        servedCount: k.servedCount,
        sampledCount: sampled,
        utilizationRate: k.utilizationRate,
        regret,
        hunger,
        bias,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 便捷过滤器:只返回 bias !== 0 的 kind。
 * advisor / kernel-status 的"有建议"视图可直接消费。
 */
export function getBiasedSources(
  snapshot: ContextSignalsSnapshot,
  opts?: ComputeSourceEconomicsOptions,
): ReadonlyArray<SourceEconomics> {
  return computeSourceEconomics(snapshot, opts).filter(e => e.bias !== 0)
}

// ── 内部辅助 ─────────────────────────────────────────────
function clampProbability(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
